#!/usr/bin/env node
/**
 * qoder-bridge.mjs — Qoder 的 OpenAI 兼容边车网关（端口 7865）。
 *
 * 为什么单独起进程而不是塞进 bridge.mjs：bridge 是稳定在跑的主力，Qoder 上游
 * 需要 COSY 自签名 + 双层信封拆解，风险集中在新代码里；做成独立网关后，bridge
 * 只需要在 upstreams.json 里把它当普通 openai 上游（base=http://127.0.0.1:7865）。
 *
 * 能力：
 *   - GET  /healthz           健康 + 账号数
 *   - GET  /v1/models         模型清单（qoder-models.json 可编辑，缺省给常用 id）
 *   - POST /v1/chat/completions  流式/非流式；自动换号、按 retry-policy 退避
 *   - 每日签到（内置调度器，默认 09:10）
 *
 * 账号来源：%USERPROFILE%\.qoder2api\auths\qoder-<uid>.json（由面板「Qoder 账号」插件写入）
 * 鉴权：可选，qoder-api-key.txt 存在时要求 Bearer 匹配。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { openQoderStream, buildQoderChatBody, iterateQoderChunks } from "./qoder-upstream.mjs";
import { planRetry, parseRetryAfter } from "./retry-policy.mjs";
import { Scheduler } from "./scheduler.mjs";

const PORT = Number(process.env.QODER_BRIDGE_PORT || 7865);
const HOME = os.homedir();
const AUTH_DIR = path.join(HOME, ".qoder2api", "auths");
const KEY_FILE = path.join(HOME, ".qoder2api", "api-key.txt");
const STATE_FILE = path.join(HOME, ".qoder2api", "scheduler-state.json");
const MODELS_FILE = path.join(HOME, ".qoder2api", "models.json");

const DEFAULT_MODELS = [
  "Qwen3.8-Max",
  "Qwen3.8-Plus",
  "Qwen3.8-Flash",
  "glm-5.3",
  "glm-5.2",
];

function log(...args) { console.log(new Date().toISOString(), ...args); }

function loadAccounts() {
  try {
    const out = [];
    for (const name of fs.readdirSync(AUTH_DIR)) {
      if (!name.startsWith("qoder-") || !name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, name), "utf8"));
        if (rec?.auth?.accessToken && rec?.account?.uid && !rec.account.disabled) {
          out.push({
            uid: rec.account.uid,
            nickname: rec.account.nickname || "",
            accessToken: rec.auth.accessToken,
            machineId: (rec.device && rec.device.machineId) || "",
          });
        }
      } catch { /* 跳过坏文件 */ }
    }
    return out;
  } catch { return []; }
}

/** 读 ~/.qoder2api/models.json（Qoder 官方模型目录快照），返回规范化条目 */
function loadCatalog() {
  try {
    const raw = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8"));
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.models) ? raw.models : []);
    const out = list
      .filter((m) => m && m.key && m.enable !== false)
      .map((m) => ({
        key: String(m.key),
        name: String(m.display_name || m.key),
        source: String(m.source || "system"),
        isReasoning: Boolean(m.is_reasoning),
        isVl: Boolean(m.is_vl),
        maxInput: Number(m.max_input_tokens) || 0,
        free: Boolean(m.is_free),
        priceFactor: Number(m.price_factor) || 0,
      }));
    if (out.length) return out;
  } catch { /* 回落到默认 */ }
  return DEFAULT_MODELS.map((name) => ({ key: name, name, source: "system", isReasoning: false, isVl: false, maxInput: 0, free: false, priceFactor: 0 }));
}

/** 请求里的 model 可能是显示名，也可能是内部 key */
function resolveModel(id) {
  const catalog = loadCatalog();
  const target = String(id || "").trim();
  return catalog.find((m) => m.name === target || m.key === target)
    || catalog.find((m) => m.name.toLowerCase() === target.toLowerCase())
    || { key: target, name: target, source: "system", isReasoning: false, isVl: false, maxInput: 0, free: false, priceFactor: 0 };
}

function authorized(req) {
  if (!fs.existsSync(KEY_FILE)) return true;
  const key = fs.readFileSync(KEY_FILE, "utf8").trim();
  if (!key) return true;
  const auth = String(req.headers.authorization || "");
  return auth === "Bearer " + key;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

/** 选一个号：按顺序轮询，跳过冷却中的（这里只做简单游标） */
let cursor = 0;
function pickAccounts() {
  const list = loadAccounts();
  if (!list.length) return [];
  const n = cursor++ % list.length;
  return list.slice(n).concat(list.slice(0, n));
}

/** 非流式：把 chunk 聚合成一个完整响应 */
function aggregate(chunks) {
  let content = "";
  let reasoning = "";
  let model = "";
  let finish = null;
  let usage = null;
  const toolCalls = [];
  for (const line of chunks) {
    const text = line.startsWith("data: ") ? line.slice(6) : line;
    if (text === "[DONE]") break;
    let obj;
    try { obj = JSON.parse(text); } catch { continue; }
    if (obj.model) model = obj.model;
    if (obj.usage) usage = obj.usage;
    const choice = obj.choices && obj.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const d = choice.delta || choice.message || {};
    if (typeof d.content === "string") content += d.content;
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
    if (Array.isArray(d.tool_calls)) toolCalls.push(...d.tool_calls);
  }
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: "chatcmpl-qoder-" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "qoder",
    choices: [{ index: 0, message, finish_reason: finish || "stop" }],
    usage: usage || undefined,
  };
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = String(body.model || "Qwen3.8-Max");
  const wantStream = Boolean(body.stream);
  const thinking = body.reasoning_effort
    ? { enable: body.reasoning_effort !== "none", effort: body.reasoning_effort }
    : (body.enable_thinking === false ? { enable: false } : null);

  const selected = resolveModel(model);
  const accounts = pickAccounts();
  if (!accounts.length) {
    return sendJson(res, 503, { error: { message: "没有可用的 Qoder 账号，请先在面板「Qoder 账号」登录", type: "no_account" } });
  }

  let lastError = null;
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const hasAlternative = i < accounts.length - 1;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let upstreamRes;
      try {
        const upstreamBody = buildQoderChatBody({
          upstreamKey: selected.key,
          messages,
          tools: body.tools,
          maxTokens: body.max_tokens,
          thinking,
          userId: account.uid,
          sessionSeed: body.user || body.session_id || null,
          modelConfig: { is_reasoning: selected.isReasoning, is_vl: selected.isVl, source: selected.source, format: "openai" },
        });
        upstreamRes = await openQoderStream({
          account,
          body: upstreamBody,
          modelKey: selected.key,
          modelSource: selected.source,
        });
      } catch (error) {
        const decision = planRetry({ status: 0, body: String(error.message || error), attempt, hasAlternative });
        lastError = error;
        if (decision.action === "retry_same") { await new Promise((r) => setTimeout(r, decision.delayMs)); continue; }
        if (decision.action === "switch") break;
        return sendJson(res, 502, { error: { message: String(error.message || error), type: "upstream_error" } });
      }

      if (!upstreamRes.ok) {
        // 读一小段错误体用于分类（最多 2KB），再决定重试
        const text = await upstreamRes.text().catch(() => "");
        const decision = planRetry({
          status: upstreamRes.status,
          body: text.slice(0, 2000),
          attempt,
          hasAlternative,
          retryAfterMs: parseRetryAfter(upstreamRes.headers.get("retry-after")),
        });
        lastError = new Error("Qoder HTTP " + upstreamRes.status + "：" + text.slice(0, 200));
        log("chat 失败", account.uid, selected.key, upstreamRes.status, decision.kind, decision.action);
        if (decision.action === "retry_same") { await new Promise((r) => setTimeout(r, decision.delayMs)); continue; }
        if (decision.action === "switch") break;
        return sendJson(res, upstreamRes.status, { error: { message: lastError.message, type: decision.kind } });
      }

      // 成功：开始转发
      if (wantStream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        try {
          let sent = [];
          for await (const line of iterateQoderChunks(upstreamRes)) {
            if (body.include_usage === false && /"usage"/.test(line)) continue;
            res.write(line + "\n\n");
            sent.push(line);
          }
          res.end();
          return;
        } catch (error) {
          log("流式中断", error.message);
          res.write('data: {"error":{"message":' + JSON.stringify(String(error.message || error)) + '}}\n\n');
          res.end();
          return;
        }
      }

      try {
        const chunks = [];
        for await (const line of iterateQoderChunks(upstreamRes)) chunks.push(line);
        return sendJson(res, 200, aggregate(chunks));
      } catch (error) {
        lastError = error;
        if (hasAlternative) break;
        return sendJson(res, 502, { error: { message: String(error.message || error), type: "upstream_error" } });
      }
    }
  }
  return sendJson(res, 502, { error: { message: "所有 Qoder 账号都失败：" + String(lastError?.message || lastError || "未知"), type: "upstream_error" } });
}

// ── 每日签到 ──
async function qoderCheckin() {
  const accounts = loadAccounts();
  const results = [];
  for (const acc of accounts) {
    try {
      const url = "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns";
      const r = await fetch(url, {
        headers: {
          Authorization: "Bearer " + acc.accessToken,
          "Cosy-ClientType": "10",
          "User-Agent": "Qoder",
          Accept: "application/json",
          ...(acc.machineId ? { "Cosy-MachineId": acc.machineId } : {}),
        },
        signal: AbortSignal.timeout(20000),
      });
      const payload = await r.json().catch(() => null);
      const list = (payload && (payload.data || payload.campaigns || payload)) || [];
      const campaigns = Array.isArray(list) ? list : [];
      let claimed = 0;
      for (const c of campaigns) {
        const benefit = c && c.benefit ? String(c.benefit.kind || "").toUpperCase() : "";
        const status = String((c && c.claimStatus) || "").toUpperCase();
        if (benefit !== "CREDITS" || status === "CLAIMED") continue;
        const id = c.campaignId || c.id;
        if (!id) continue;
        await fetch("https://openapi.qoder.com.cn/sash/api/v1/me/campaigns/" + encodeURIComponent(id) + "/claim", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + acc.accessToken,
            "Cosy-ClientType": "10",
            "User-Agent": "Qoder",
            "Content-Type": "application/json",
            ...(acc.machineId ? { "Cosy-MachineId": acc.machineId } : {}),
          },
          body: "{}",
          signal: AbortSignal.timeout(20000),
        }).catch(() => null);
        claimed += 1;
      }
      results.push({ uid: acc.uid, campaigns: campaigns.length, claimed });
    } catch (e) {
      results.push({ uid: acc.uid, error: String(e.message || e) });
    }
  }
  return JSON.stringify(results);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/healthz") {
    const accounts = loadAccounts();
    return sendJson(res, 200, { ok: true, accounts: accounts.length, models: loadCatalog().length });
  }
  if (url.pathname === "/v1/models") {
    const data = loadCatalog().map((m) => ({
      id: m.name,
      object: "model",
      created: 0,
      owned_by: "qoder",
      qoder_key: m.key,
      context_length: m.maxInput || undefined,
      is_free: m.free || undefined,
      price_factor: m.priceFactor || undefined,
      supports_images: m.isVl || undefined,
      supports_reasoning: m.isReasoning || undefined,
    }));
    return sendJson(res, 200, { object: "list", data });
  }
  if (url.pathname === "/v1/chat/completions") {
    if (!authorized(req)) return sendJson(res, 401, { error: { message: "invalid api key", type: "auth" } });
    return handleChat(req, res).catch((e) => {
      log("handleChat 异常", e);
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(e.message || e) } });
      else res.end();
    });
  }
  return sendJson(res, 404, { error: { message: "not found" } });
});

const scheduler = new Scheduler({ stateFile: STATE_FILE, logger: console });
scheduler.daily("qoder-checkin", process.env.QODER_CHECKIN_AT || "09:10", qoderCheckin).start();

server.listen(PORT, "127.0.0.1", () => {
  log("[qoder-bridge] listening on http://127.0.0.1:" + PORT + "/v1，账号 " + loadAccounts().length + " 个");
});

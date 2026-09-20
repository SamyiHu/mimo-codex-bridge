/**
 * mimo-bridge — 让 Codex 用上「MiMo Desktop 的套餐」。
 *
 * 原理：MiMo Desktop 进程内嵌了一个 MiMoCode 引擎，它在某个随机回环端口上提供
 * OpenAI 兼容的 /v1 接口（模型 = xiaomi/mimo-x-pro-preview 等），鉴权是「自己签发的本地 token」。
 * 这个脚本把自己伪装成 127.0.0.1:8788/v1，把请求原样转发给引擎，并补上：
 *   - Authorization: Bearer <本地 token>
 *   - ?directory=<固定目录>（token 是按目录绑定校验的）
 * 端口每次桌面端重启都会变，所以这里自动发现。
 *
 * 用法： node bridge.mjs [--port 8788] [--dir <token 所在目录>] [--token <token>]
 */
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { toChatRequest, toResponseObject, responseEvents, sseWrite } from "./responses.mjs";

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const LISTEN_PORT = Number(argOf("--port", process.env.MIMO_BRIDGE_PORT || 8788));
const INSTANCE_DIR = argOf("--dir", process.env.MIMO_BRIDGE_DIR || path.join(os.homedir(), ".mimo-bridge"));
const TOKEN_FILE = argOf("--token-file", path.join(import.meta.dirname, "token.txt"));
const PROCESS_NAME = argOf("--process", process.env.MIMO_BRIDGE_PROCESS || "Xiaomi Mi Mo.exe");
function loadToken() {
  const direct = argOf("--token", null);
  if (direct) return direct;
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  console.error("[bridge] 找不到 token 文件：" + TOKEN_FILE + "\n[bridge] 先运行： node mint-token.mjs");
  process.exit(2);
}
const TOKEN = loadToken();
const DEBUG = process.env.BRIDGE_DEBUG === "1";
const DEBUG_FILE = path.join(import.meta.dirname, "debug-requests.jsonl");

// 引擎会拒绝这些字段（400）而不是忽略，Codex 有时会带上，转发前摘掉
const STRIP_FIELDS = ["response_format", "logit_bias", "top_logprobs", "verbosity", "store", "n"];

let engineBase = null;

function candidatePorts() {
  const ports = new Set();
  try {
    const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/.test(line)) continue;
      const m = line.trim().split(/\s+/);
      const local = m[1];
      const pid = m[m.length - 1];
      if (!/^127\.0\.0\.1:\d+$/.test(local)) continue;
      pids.add(pid);
      ports.add(Number(local.split(":")[1]));
    }
    if (pids.size) {
      const task = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
      const mimoPids = new Set();
      const procRe = new RegExp(PROCESS_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      for (const line of task.split(/\r?\n/)) {
        const c = line.split('","');
        if (c.length < 2) continue;
        if (/Xiaomi MiMo\.exe/i.test(c[0])) mimoPids.add(c[1].replace(/"/g, ""));
      }
      if (mimoPids.size) {
        for (const line of out.split(/\r?\n/)) {
          if (!/LISTENING/.test(line)) continue;
          const m = line.trim().split(/\s+/);
          if (mimoPids.has(m[m.length - 1])) ports.add(Number(m[1].split(":")[1]));
        }
      }
    }
  } catch { /* netstat/tasklist 失败就退回全量探测 */ }
  for (let p = 1024; p <= 65535; p += 1) {
    if (ports.has(p)) continue;
  }
  return [...ports].filter((p) => p > 0);
}

async function probe(port) {
  const url = `http://127.0.0.1:${port}/v1/models?directory=${encodeURIComponent(INSTANCE_DIR)}`;
  try {
    const ctrl = AbortSignal.timeout(2500);
    const r = await fetch(url, { headers: { Authorization: "Bearer " + TOKEN }, signal: ctrl });
    if (r.status !== 200) return false;
    const j = await r.json().catch(() => null);
    return !!j && Array.isArray(j.data) && j.data.some((m) => String(m.id || "").startsWith("xiaomi/"));
  } catch { return false; }
}

async function discoverEngine(force = false) {
  if (engineBase && !force) return engineBase;
  for (const p of candidatePorts()) {
    if (p === LISTEN_PORT) continue; // 别把自己当成引擎
    if (await probe(p)) {
      engineBase = `http://127.0.0.1:${p}`;
      console.log(`[bridge] engine found at ${engineBase} (instance dir: ${INSTANCE_DIR})`);
      return engineBase;
    }
  }
  engineBase = null;
  return null;
}

function upstreamUrl(base, reqPath, keepQuery) {
  const url = new URL(base + reqPath);
  url.searchParams.set("directory", INSTANCE_DIR);
  if (keepQuery) {
    const incoming = new URL(reqPath, "http://x").searchParams;
    for (const [k, v] of incoming) if (k !== "directory") url.searchParams.set(k, v);
  }
  return url;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const reqPath = (req.url || "/").split("?")[0];
  if (req.method === "GET" && reqPath === "/health") {
    const base = await discoverEngine();
    return sendJson(res, 200, { ok: !!base, engine: base, instanceDir: INSTANCE_DIR });
  }
  if (!reqPath.startsWith("/v1/")) return sendJson(res, 404, { error: { message: `unsupported path ${reqPath}` } });

  let body = null;
  if (req.method === "POST") {
    const raw = await readBody(req);
    try {
      body = JSON.parse(raw.toString("utf8"));
      if (body && typeof body.model === "string" && !body.model.includes("/")) body.model = `xiaomi/${body.model}`;
      if (body && typeof body === "object") for (const f of STRIP_FIELDS) delete body[f];
      if (body && body.n && body.n > 1) body.n = 1;
    } catch { body = null; }
    if (DEBUG) {
      try {
        fs.appendFileSync(DEBUG_FILE, JSON.stringify({ at: new Date().toISOString(), path: reqPath, body }) + "\n");
      } catch {}
    }
  }

  const isResponses = reqPath === "/v1/responses";

  for (let attempt = 0; attempt < 2; attempt++) {
    const base = await discoverEngine(attempt > 0);
    if (!base) return sendJson(res, 503, { error: { message: "MiMo Desktop 引擎没找到：确认桌面端在运行，且 token 已写入。", type: "bridge_error" } });

    const upstreamPath = isResponses ? "/v1/chat/completions" : reqPath;
    const chatBody = isResponses ? toChatRequest(body ?? {}) : body ?? {};
    if (isResponses) chatBody.stream = false; // 先拿完整结果，再由本进程合成 Responses 事件

    const target = upstreamUrl(base, upstreamPath, true);
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers: {
          Authorization: "Bearer " + TOKEN,
          "Content-Type": req.headers["content-type"] || "application/json",
          Accept: req.headers["accept"] || "*/*",
        },
        body: req.method === "POST" ? Buffer.from(JSON.stringify(chatBody)) : undefined,
      });

      if (isResponses) {
        const payload = await upstream.json().catch(() => null);
        if (!upstream.ok || !payload) {
          const message = payload?.error?.message ?? `upstream HTTP ${upstream.status}`;
          return sendJson(res, upstream.status === 200 ? 502 : upstream.status, { error: { message, type: "bridge_error" } });
        }
        const response = toResponseObject(payload, body ?? {});
        if (body?.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
          for (const evt of responseEvents(response)) sseWrite(res, evt);
          res.end();
        } else {
          sendJson(res, 200, response);
        }
        return;
      }

      const ctype = upstream.headers.get("content-type") || "application/json";
      res.writeHead(upstream.status, { "Content-Type": ctype, "Cache-Control": "no-store" });
      if (upstream.body) {
        for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
      }
      res.end();
      return;
    } catch (e) {
      if (attempt === 0) continue; // 端口可能变了，重新发现一次
      return sendJson(res, 502, { error: { message: "upstream failed: " + String(e && e.message), type: "bridge_error" } });
    }
  }
});

server.listen(LISTEN_PORT, "127.0.0.1", async () => {
  console.log(`[bridge] listening on http://127.0.0.1:${LISTEN_PORT}/v1`);
  console.log(`[bridge] token: ${TOKEN.slice(0, 6)}…${TOKEN.slice(-4)}  instance dir: ${INSTANCE_DIR}`);
  const base = await discoverEngine();
  console.log(base ? "[bridge] ready" : "[bridge] 警告：暂时找不到 MiMo 引擎（桌面端可能没启动）");
});

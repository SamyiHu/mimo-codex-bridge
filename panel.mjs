#!/usr/bin/env node
/**
 * panel.mjs — 本地模型桥控制面板。
 * 一个页面看状态、切 mimo/workbuddy、启停 bridge。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { pathToFileURL } from "node:url";

const DIR = import.meta.dirname;
const PORT = Number(process.env.PANEL_PORT || 8791);
const BRIDGE_PORT = Number(process.env.MIMO_BRIDGE_PORT || 8788);

const secretFile = path.join(DIR, "bridge-secret.txt");
const workbuddyKeyFile = path.join(DIR, "workbuddy-api-key.txt");
const tokenFile = path.join(DIR, "token.txt");
const settingsFile = path.join(DIR, "panel-settings.json");
const PANEL_STARTED_AT = Date.now();
const UI_FILES = ["panel.mjs"];
const historyFile = path.join(DIR, "panel-history.json");
const registryFile = path.join(DIR, "upstreams.json");
const registryLocalFile = path.join(DIR, "upstreams.local.json");
const registryDisabledFile = path.join(DIR, "upstreams.disabled.json");
const quotaFile = path.join(DIR, "quota.json");
const HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_MAX = 4000;
const HISTORY_MIN_GAP_MS = 5 * 60 * 1000;

function loadSettings() {
  let saved = {};
  try {
    if (fs.existsSync(settingsFile)) {
      saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    }
  } catch {
    saved = {};
  }
  return {
    workbuddyUrl:
      process.env.WORKBUDDY_URL ||
      saved.workbuddyUrl ||
      "http://127.0.0.1:7863",
    gatewayDir:
      process.env.WORKBUDDY2API_DIR ||
      saved.gatewayDir ||
      path.join(os.homedir(), ".workbuddy2api"),
    traeUrl: process.env.TRAE_URL || saved.traeUrl || "http://127.0.0.1:7864",
    traeDir:
      process.env.TRAE2API_DIR ||
      saved.traeDir ||
      path.join(os.homedir(), ".trae2api"),
  };
}

function rememberUpstream(kind) {
  if (!kind) return;
  try {
    const current = loadSettings();
    const saved = JSON.parse(fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : "{}");
    if (saved.lastUpstream === kind) return;
    fs.writeFileSync(settingsFile, JSON.stringify({ ...saved, lastUpstream: kind, workbuddyUrl: current.workbuddyUrl, gatewayDir: current.gatewayDir, traeUrl: current.traeUrl, traeDir: current.traeDir }, null, 2), "utf8");
  } catch {}
}

function loadLastUpstream() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    return String(saved.lastUpstream || "");
  } catch {
    return "";
  }
}

function saveSettings(patch) {
  const current = loadSettings();
  const next = {
    workbuddyUrl: String(patch.workbuddyUrl ?? current.workbuddyUrl).replace(/\/+$/, ""),
    gatewayDir: String(patch.gatewayDir ?? current.gatewayDir),
    traeUrl: String(patch.traeUrl ?? current.traeUrl).replace(/\/+$/, ""),
    traeDir: String(patch.traeDir ?? current.traeDir),
  };
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), "utf8");
  WORKBUDDY_URL = next.workbuddyUrl;
  GATEWAY_DIR = next.gatewayDir;
  TRAE_URL = next.traeUrl;
  TRAE_DIR = next.traeDir;
  TRAE_EXE = path.join(TRAE_DIR, "trae2api.exe");
  GATEWAY_EXE = path.join(GATEWAY_DIR, "wb2api.exe");
  GATEWAY_CONFIG = path.join(GATEWAY_DIR, "config.json");
  GATEWAY_PID = path.join(GATEWAY_DIR, "wb2api.pid");
  return next;
}

let { workbuddyUrl: WORKBUDDY_URL, gatewayDir: GATEWAY_DIR, traeUrl: TRAE_URL, traeDir: TRAE_DIR } =
  loadSettings();
let GATEWAY_EXE = path.join(GATEWAY_DIR, "wb2api.exe");
let GATEWAY_CONFIG = path.join(GATEWAY_DIR, "config.json");
let GATEWAY_PID = path.join(GATEWAY_DIR, "wb2api.pid");
let TRAE_EXE = path.join(TRAE_DIR, "trae2api.exe");
const TRAE_KEY_FILE = path.join(DIR, "trae-api-key.txt");

let actionLock = Promise.resolve();
let lastAction = { label: "", state: "idle", detail: "", at: "" };
let actionBusy = false;

/**
 * 额度历史：每次刷新 /api/status 时看一眼，值变了或过了 5 分钟才落一个点。
 * 只记 {t, id, share} 三个字段，7 天 / 4000 点封顶，文件很小。
 */
let historyCache = null;
function loadHistory() {
  if (historyCache) return historyCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(historyFile, "utf8"));
    historyCache = Array.isArray(parsed?.samples) ? parsed.samples : [];
  } catch {
    historyCache = [];
  }
  return historyCache;
}

function saveHistory(samples) {
  historyCache = samples;
  try {
    fs.writeFileSync(historyFile, JSON.stringify({ version: 1, samples }), "utf8");
  } catch {}
}

function recordQuotaHistory(routing) {
  const quota = routing?.quota || {};
  const ids = Object.keys(quota);
  if (!ids.length) return;
  const now = Date.now();
  const samples = loadHistory();
  let changed = false;
  for (const id of ids) {
    const value = quota[id];
    if (!value || value.share == null) continue;
    let last = null;
    for (let i = samples.length - 1; i >= 0; i -= 1) {
      if (samples[i].id === id) {
        last = samples[i];
        break;
      }
    }
    const due = !last || now - last.t >= HISTORY_MIN_GAP_MS;
    const moved = !last || Math.abs(last.share - value.share) >= 0.01;
    if (due || moved) {
      samples.push({ t: now, id, share: Number(value.share) });
      changed = true;
    }
  }
  if (!changed) return;
  const cutoff = now - HISTORY_TTL_MS;
  const kept = samples.filter((sample) => sample && sample.t >= cutoff && Number.isFinite(sample.share)).slice(-HISTORY_MAX);
  saveHistory(kept);
}

/**
 * 面板进程是不是在跑旧代码：拿自己的源码 mtime 和进程启动时间比。
 * 改了 UI 却没重启面板时，界面会提示，而不是让人纳闷"为什么新按钮没反应"。
 */
function panelCodeMtime() {
  let newest = 0;
  for (const rel of UI_FILES) {
    const target = path.join(DIR, rel);
    try {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(target)) {
          try {
            newest = Math.max(newest, fs.statSync(path.join(target, entry)).mtimeMs);
          } catch {}
        }
      } else {
        newest = Math.max(newest, stat.mtimeMs);
      }
    } catch {}
  }
  return newest;
}

/** 原子写：先写 .tmp 再 rename，避免面板崩溃留下半截 JSON。 */
function writeJsonAtomic(file, value) {
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    fs.renameSync(temp, file);
  } catch {
    fs.copyFileSync(temp, file);
    fs.unlinkSync(temp);
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 面板这边只做"写文件 + 校验"：真正的启用/停用就是 upstreams.json 在不在。
 * bridge 每 250ms 看一次 mtime，写完最多 0.25 秒就生效，不用重启。
 */
/**
 * 上游实时余额：借两个插件已有的代理端点，避免在面板里重复实现网关鉴权。
 * 只读余额（积分 / 账号数），失败就当没有，绝不影响页面。
 */
async function liveQuota() {
  const out = {};
  const grab = async (pluginPath, pick) => {
    try {
      const res = await fetch("http://127.0.0.1:" + PORT + pluginPath, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      return pick(await res.json());
    } catch {
      return null;
    }
  };
  const wb = await grab("/api/plugins/workbuddy-credits/status", (payload) => {
    const accounts = (payload && payload.status && payload.status.accounts) || [];
    if (!accounts.length) return null;
    const credits = accounts.reduce((n, a) => n + (Number(a.credits) || 0), 0);
    return { credits, accounts: accounts.length, healthy: accounts.filter((a) => !a.cooling).length };
  });
  if (wb) out.wb = wb;
  const trae = await grab("/api/plugins/trae-accounts/accounts", (payload) => {
    const accounts = (payload && payload.accounts) || [];
    if (!accounts.length) return null;
    const credits = accounts.reduce((n, a) => n + (Number(a.credits) || 0), 0);
    return { credits, accounts: accounts.length, healthy: accounts.filter((a) => a.enabled && !a.disabled).length };
  });
  if (trae) out.trae = trae;
  return out;
}

async function routingState() {
  const { parseRegistry } = await import("./upstream-registry.mjs");
  const current = readJsonFile(registryFile);
  const local = readJsonFile(registryLocalFile);
  const parsed = current ? parseRegistry(current) : null;
  return {
    enabled: Boolean(current),
    registry: current,
    errors: parsed ? parsed.errors : [],
    summary: parsed
      ? { upstreams: [...parsed.upstreams.keys()], groups: [...parsed.groups.keys()] }
      : { upstreams: [], groups: [] },
    local,
    quota: readJsonFile(quotaFile) || {},
    files: {
      registry: registryFile,
      local: registryLocalFile,
      disabled: registryDisabledFile,
      quota: quotaFile,
    },
  };
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

async function fetchJson(url, options = {}, timeoutMs = 3000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { ok: response.ok, status: response.status, payload };
}

function extractTomlString(text, name) {
  const match = text.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m"));
  return match?.[1] ?? "";
}

function extractProviderString(text, providerId, name) {
  if (!providerId) return "";
  const lines = text.split(/\r?\n/);
  let inside = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]*)\]\s*$/.exec(line);
    if (header) {
      inside = header[1].trim() === `model_providers.${providerId}`;
      continue;
    }
    if (!inside) continue;
    const match = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`).exec(line);
    if (match) return match[1];
  }
  return "";
}

function runPowerShell(script, args = [], timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { cwd: DIR, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done({
        ok: false,
        code: -2,
        stdout,
        stderr: stderr + "\n[panel] PowerShell 超时被中止",
      });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (error) => {
      done({ ok: false, code: -1, stdout, stderr: String(error) });
    });
    // 用 exit 而不是 close：start-bridge 的 Start-Process 孙进程会占住 stdio，
    // close 会永远等不到 EOF，动作就吊死在“正在启动”。
    child.on("exit", (code) => {
      done({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function runCommand(exe, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      cwd: opts.cwd || DIR,
      windowsHide: true,
      ...opts.spawnOpts,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done({ ok: false, code: -2, stdout, stderr: stderr + "\n[panel] 命令超时" });
    }, opts.timeoutMs || 15000);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (error) => done({ ok: false, code: -1, stdout, stderr: String(error) }));
    child.on("exit", (code) => done({ ok: code === 0, code, stdout, stderr }));
  });
}

async function isGatewayHealthy() {
  try {
    const r = await fetchJson(`${WORKBUDDY_URL}/healthz`, {}, 1500);
    return Boolean(r.ok);
  } catch {
    return false;
  }
}

/** 把网关 config.json 的 api_key 同步到 bridge 用的 key 文件 */
function syncGatewayKey() {
  try {
    if (!fs.existsSync(GATEWAY_CONFIG)) return;
    const cfg = JSON.parse(fs.readFileSync(GATEWAY_CONFIG, "utf8"));
    const key = String(cfg.api_key || "").trim();
    if (!key) return;
    const current = readText(workbuddyKeyFile);
    if (current !== key) {
      fs.writeFileSync(workbuddyKeyFile, key, "utf8");
    }
  } catch {
    /* ignore */
  }
}

/** 确保 workbuddy2api 在跑；不在就拉起。返回 {ok, started, detail} */
async function ensureGateway() {
  syncGatewayKey();
  if (await isGatewayHealthy()) {
    return { ok: true, started: false, detail: "已在运行" };
  }
  if (!fs.existsSync(GATEWAY_EXE)) {
    return {
      ok: false,
      started: false,
      detail: `找不到 ${GATEWAY_EXE}，请先部署 workbuddy2api`,
    };
  }
  const logDir = path.join(GATEWAY_DIR, "data");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  // 直接拉起 wb2api.exe，避免 cmd 包装层 stdio 继承问题
  const out = path.join(logDir, "server.out.log");
  const err = path.join(logDir, "server.err.log");
  const start = await runCommand(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$p=Start-Process -FilePath '${GATEWAY_EXE.replace(/'/g, "''")}' ` +
        `-ArgumentList '-config','config.json' ` +
        `-WorkingDirectory '${GATEWAY_DIR.replace(/'/g, "''")}' ` +
        `-WindowStyle Hidden ` +
        `-RedirectStandardOutput '${out.replace(/'/g, "''")}' ` +
        `-RedirectStandardError '${err.replace(/'/g, "''")}' ` +
        `-PassThru; ` +
        `[IO.File]::WriteAllText('${GATEWAY_PID.replace(/'/g, "''")}', [string]$p.Id); ` +
        `Write-Output $p.Id`,
    ],
    { timeoutMs: 10000 },
  );

  // 等健康检查
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await isGatewayHealthy()) {
      return { ok: true, started: true, detail: `已启动 PID ${(start.stdout || "").trim()}` };
    }
  }
  return {
    ok: false,
    started: true,
    detail: "已拉起但 healthz 未就绪，见 data/server.err.log",
  };
}

/** 确保 trae2api 在跑；不在就拉起（API key 走 TW2A_API_KEY 环境变量） */
async function ensureTraeGateway() {
  try {
    const r = await fetchJson(`${TRAE_URL}/healthz`, {}, 1500);
    if (r.ok) return { ok: true, started: false, detail: "已在运行" };
  } catch {
    /* not running */
  }
  if (!fs.existsSync(TRAE_EXE)) {
    return { ok: false, started: false, detail: `找不到 ${TRAE_EXE}，请先部署 trae2api` };
  }
  const logDir = path.join(TRAE_DIR, "data");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const out = path.join(logDir, "server.out.log");
  const err = path.join(logDir, "server.err.log");
  const key = readText(TRAE_KEY_FILE);
  const q = (p) => p.replace(/'/g, "''");
  // 先把 key 写入注册表级环境（进程内 $env:）再 Start-Process，子进程继承
  // TW2A_WORK_MODE=disabled：关 Work 通道探测（credits 实查里那步要发真对话 ping，
  // 约 10 秒，是刷新慢的主因；面板从不使用 Work 积分）
  const start = await runCommand(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      (key ? `$env:TW2A_API_KEY = '${q(key)}'; ` : "") +
        `$env:TW2A_WORK_MODE = 'disabled'; ` +
        `$p = Start-Process -FilePath '${q(TRAE_EXE)}' ` +
        `-ArgumentList '-config','config.json' ` +
        `-WorkingDirectory '${q(TRAE_DIR)}' -WindowStyle Hidden ` +
        `-RedirectStandardOutput '${q(out)}' -RedirectStandardError '${q(err)}' -PassThru; ` +
        `[IO.File]::WriteAllText('${q(path.join(TRAE_DIR, "trae2api.pid"))}', [string]$p.Id); ` +
        `Write-Output $p.Id`,
    ],
    { timeoutMs: 10000 },
  );
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const r = await fetchJson(`${TRAE_URL}/healthz`, {}, 1500);
      if (r.ok) {
        return { ok: true, started: true, detail: `已启动 PID ${(start.stdout || "").trim()}` };
      }
    } catch {
      /* booting */
    }
  }
  return { ok: false, started: true, detail: "已拉起但 healthz 未就绪，见 data/server.err.log" };
}

function setAction(label, state, detail) {
  const isRunning = state === "running";
  const prev = lastAction;
  // 同一动作刷新 detail 时不要重置 since，否则看门狗永远不触发
  const sameRunning = isRunning && prev && prev.state === "running" && prev.label === label;
  lastAction = {
    label,
    state,
    detail: detail || "",
    at: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    since: isRunning
      ? sameRunning
        ? (prev.since ?? Date.now())
        : Date.now()
      : (prev?.since ?? 0),
  };
  actionBusy = isRunning;
}

// 看门狗：动作超过 35s 仍未结束则强制落失败，防止 UI 吊死
setInterval(() => {
  if (!actionBusy || !lastAction?.since) return;
  if (Date.now() - lastAction.since < 35000) return;
  const elapsed = Math.round((Date.now() - lastAction.since) / 1000);
  setAction(
    lastAction.label || "操作",
    "fail",
    `超时（${elapsed}s）被中止，请刷新页面确认状态`,
  );
}, 2000).unref?.();

async function collectStatus() {
  const bridgeSecret = readText(secretFile);
  const workbuddyKey = readText(workbuddyKeyFile) || process.env.WORKBUDDY_API_KEY || "";
  const result = {
    time: new Date().toISOString(),
    bridgePort: BRIDGE_PORT,
    workbuddyUrl: WORKBUDDY_URL,
    traeUrl: TRAE_URL,
    bridge: { online: false },
    workbuddy: { online: false },
    trae: { online: false },
    keys: {
      bridgeSecret: Boolean(bridgeSecret),
      workbuddyKey: Boolean(workbuddyKey),
      traeKey: Boolean(readText(TRAE_KEY_FILE)),
      mimoToken: Boolean(readText(tokenFile)),
    },
    codex: null,
    models: [],
    modelDetails: [],
    routing: null,
    metrics: null,
    liveQuota: {},
    panel: {
      startedAt: new Date(PANEL_STARTED_AT).toISOString(),
      codeMtime: new Date(panelCodeMtime()).toISOString(),
      stale: panelCodeMtime() > PANEL_STARTED_AT + 1000,
    },
    lastAction,
    actionBusy,
    notes: [],
  };

  try {
    const health = await fetchJson(`http://127.0.0.1:${BRIDGE_PORT}/health`);
    if (health.ok && health.payload) {
      rememberUpstream(health.payload.upstreamKind || "");
      result.bridge = {
        online: true,
        upstreamKind: health.payload.upstreamKind || "",
        chatMode: health.payload.chatMode || "",
        engine: health.payload.engine || "",
        streaming: health.payload.streaming,
        authMode: health.payload.authMode || "",
        protocols: health.payload.protocols || null,
      };
      result.routing = null;
      if (bridgeSecret) {
        try {
          const status = await fetchJson(
            `http://127.0.0.1:${BRIDGE_PORT}/status`,
            { headers: { Authorization: `Bearer ${bridgeSecret}` } },
          );
          if (status.ok && status.payload?.routing) {
            result.routing = status.payload.routing;
          }
          if (status.ok && status.payload) {
            // 旧版 bridge 的 /status 里没有 routing 字段：界面据此提示"重启 bridge"
            result.bridge.routingSupported = Boolean(status.payload.routing);
            result.bridge.version = status.payload.version || "";
            if (status.payload.pid) result.bridge.pid = status.payload.pid;
          }
          if (status.ok && status.payload?.metrics) {
            result.metrics = status.payload.metrics;
          }
          if (status.ok && status.payload?.routing?.enabled) {
            try {
              result.liveQuota = await liveQuota();
            } catch {
              result.liveQuota = {};
            }
            try {
              recordQuotaHistory(status.payload.routing);
            } catch (error) {
              result.notes.push("额度历史写入失败：" + String(error && error.message ? error.message : error));
            }
          }
        } catch {
          result.notes.push("读取 /status 失败");
        }
      }

      if (bridgeSecret) {
        try {
          const models = await fetchJson(
            `http://127.0.0.1:${BRIDGE_PORT}/v1/models`,
            { headers: { Authorization: `Bearer ${bridgeSecret}` } },
          );
          if (models.ok && Array.isArray(models.payload?.data)) {
            result.models = models.payload.data.map((m) => m.id).filter(Boolean);
            // 原始对象留着：模型页点开要能看到上游到底给了什么字段
            result.modelDetails = models.payload.data.slice(0, 400);
          }
        } catch {
          result.notes.push("读取 /v1/models 失败");
        }
      }
    }
  } catch {
    result.notes.push("bridge 未响应");
  }

  try {
    const healthz = await fetchJson(`${WORKBUDDY_URL}/healthz`, {}, 2000);
    result.workbuddy.online = Boolean(healthz.ok);
    result.workbuddy.detail =
      typeof healthz.payload === "string"
        ? healthz.payload.slice(0, 120)
        : (healthz.payload?.status ?? String(healthz.status ?? ""));
    result.workbuddy.gateDir = GATEWAY_DIR;
    result.workbuddy.gateExe = fs.existsSync(GATEWAY_EXE);
    if (workbuddyKey) {
      try {
        const models = await fetchJson(
          `${WORKBUDDY_URL}/v1/models`,
          { headers: { Authorization: `Bearer ${workbuddyKey}` } },
          3000,
        );
        if (models.ok && Array.isArray(models.payload?.data)) {
          result.workbuddy.modelCount = models.payload.data.length;
          result.workbuddy.sample = models.payload.data
            .slice(0, 6)
            .map((m) => m.id)
            .filter(Boolean);
        }
      } catch {
        /* optional */
      }
    }
  } catch {
    result.workbuddy.detail = "未运行或不可达（需先启动 workbuddy2api）";
    result.workbuddy.gateDir = GATEWAY_DIR;
    result.workbuddy.gateExe = fs.existsSync(GATEWAY_EXE);
  }

  // trae2api（trae 上游网关）
  const traeKey = readText(TRAE_KEY_FILE);
  try {
    const healthz = await fetchJson(`${TRAE_URL}/healthz`, {}, 2000);
    result.trae.online = Boolean(healthz.ok);
    result.trae.detail = String(healthz.status ?? "");
    result.trae.gateDir = TRAE_DIR;
    result.trae.gateExe = fs.existsSync(TRAE_EXE);
    if (traeKey) {
      try {
        const models = await fetchJson(
          `${TRAE_URL}/v1/models`,
          { headers: { Authorization: `Bearer ${traeKey}` } },
          3000,
        );
        if (models.ok && Array.isArray(models.payload?.data)) {
          result.trae.modelCount = models.payload.data.length;
          result.trae.sample = models.payload.data
            .slice(0, 6)
            .map((m) => m.id)
            .filter(Boolean);
        }
      } catch {
        /* optional */
      }
    }
  } catch {
    result.trae.detail = "未运行或不可达（需先启动 trae2api）";
    result.trae.gateDir = TRAE_DIR;
    result.trae.gateExe = fs.existsSync(TRAE_EXE);
  }

  try {
    const configPath = path.join(os.homedir(), ".codex", "config.toml");
    if (fs.existsSync(configPath)) {
      const text = fs.readFileSync(configPath, "utf8");
      const provider = extractTomlString(text, "model_provider");
      const baseUrl = extractProviderString(text, provider, "base_url");
      const wireApi = extractProviderString(text, provider, "wire_api");
      const expected = `http://127.0.0.1:${BRIDGE_PORT}/v1`;
      result.codex = {
        provider: provider || "(未设置)",
        baseUrl: baseUrl || "(未设置)",
        wireApi: wireApi || "(未设置)",
        pointsToBridge: baseUrl === expected,
      };
    } else {
      result.codex = { provider: "", baseUrl: "", wireApi: "", pointsToBridge: false, missing: true };
    }
  } catch (error) {
    result.codex = { error: String(error) };
  }

  return result;
}

function withLock(fn) {
  const run = actionLock.then(fn, fn);
  actionLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function switchUpstream(upstream, chatMode) {
  return withLock(async () => {
    setAction(`切换到 ${upstream}`, "running", "正在停止旧 bridge…");
    // 切网关型上游前先确保网关在跑，避免 bridge 起来后上游离线
    if (upstream === "workbuddy" || upstream === "trae") {
      setAction(`切换到 ${upstream}`, "running", `正在启动 ${upstream} 网关…`);
      const gw = upstream === "trae" ? await ensureTraeGateway() : await ensureGateway();
      if (!gw.ok) {
        setAction(`切换到 ${upstream}`, "fail", `网关未就绪：${gw.detail}`);
        return {
          ok: false,
          gateway: gw,
          status: await collectStatus(),
        };
      }
      setAction(`切换到 ${upstream}`, "running", "正在停止旧 bridge…");
    }
    const stopScript = path.join(DIR, "stop-bridge.ps1");
    const startScript = path.join(DIR, "start-bridge.ps1");
    const stop = await runPowerShell(stopScript, ["-Port", String(BRIDGE_PORT)]);
    setAction(`切换到 ${upstream}`, "running", "正在启动 bridge…");
    const args = ["-Port", String(BRIDGE_PORT), "-Upstream", upstream];
    if (upstream === "workbuddy") {
      args.push("-UpstreamUrl", WORKBUDDY_URL);
      if (chatMode) args.push("-ChatMode", chatMode);
    } else if (upstream === "trae") {
      args.push("-UpstreamUrl", TRAE_URL);
      args.push("-ChatMode", "raw");
    } else if (chatMode) {
      args.push("-ChatMode", chatMode);
    }
    const start = await runPowerShell(startScript, args);
    await new Promise((r) => setTimeout(r, 300));
    const status = await collectStatus();
    const live = status.bridge.online && status.bridge.upstreamKind === upstream;
    setAction(
      `切换到 ${upstream}`,
      live ? "ok" : "fail",
      live ? "已就绪" : (start.stderr || start.stdout || "bridge 未就绪").slice(-200),
    );
    return {
      ok: live,
      stop,
      start: { ok: start.ok, code: start.code, stdout: start.stdout, stderr: start.stderr },
      status: await collectStatus(),
    };
  });
}

async function bridgeAction(action) {
  return withLock(async () => {
    const label = action === "start" ? "启动 bridge" : action === "stop" ? "停止 bridge" : "重启 bridge";
    setAction(label, "running", "");
    let result = { ok: true };
    if (action === "stop" || action === "restart") {
      const stop = await runPowerShell(path.join(DIR, "stop-bridge.ps1"), [
        "-Port",
        String(BRIDGE_PORT),
      ]);
      result.stop = stop;
      if (action === "stop") {
        result.ok = true;
        result.status = await collectStatus();
        setAction(label, "ok", "已停止");
        return result;
      }
    }
    if (action === "start" || action === "restart") {
      const current = await collectStatus();
      // bridge 离线时 collectStatus 拿不到 upstreamKind：回退到上次成功记住的那家，
      // 再退到面板配置里唯一配置了地址的那家，最后才是 mimo。
      const upstream =
        current.bridge.upstreamKind ||
        loadLastUpstream() ||
        (fs.existsSync(TRAE_EXE) ? "trae" : "") ||
        "workbuddy";
      const args = ["-Port", String(BRIDGE_PORT), "-Upstream", upstream];
      if (upstream === "workbuddy") {
        args.push("-UpstreamUrl", WORKBUDDY_URL);
        args.push("-ChatMode", "raw");
      } else if (upstream === "trae") {
        args.push("-UpstreamUrl", TRAE_URL);
        args.push("-ChatMode", "raw");
      }
      const start = await runPowerShell(path.join(DIR, "start-bridge.ps1"), args);
      result.start = start;
      await new Promise((r) => setTimeout(r, 300));
      result.status = await collectStatus();
      result.ok = result.status.bridge.online;
      setAction(label, result.ok ? "ok" : "fail", result.ok ? "已就绪" : "启动失败，见 bridge-start.log");
    }
    return result;
  });
}

const UI_DIR = path.join(DIR, "panel-ui");
const uiCache = new Map();

/** 读面板静态资源，按 mtime 缓存：改完 CSS 刷新页面就生效，不用重启面板。 */
function readUi(name) {
  const file = path.join(UI_DIR, name);
  try {
    const stat = fs.statSync(file);
    const cached = uiCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;
    const text = fs.readFileSync(file, "utf8");
    uiCache.set(file, { mtimeMs: stat.mtimeMs, text });
    return text;
  } catch (error) {
    console.error("[panel] 读不到 " + file + "：" + String(error && error.message ? error.message : error));
    return "";
  }
}

function buildHtml(pluginCards) {
  const shell = readUi("shell.html");
  if (!shell) {
    return "<!doctype html><meta charset=\"utf-8\"><pre>panel-ui 缺失：找不到 panel-ui/shell.html</pre>";
  }
  return shell
    .replace("{{CSS}}", () => readUi("app.css"))
    .replace("{{JS}}", () => readUi("app.js"))
    .replace("{{PLUGIN_CARDS}}", () => pluginCards)
    .replace(/\{\{VERSION\}\}/g, () => "2.9")
    .replace(/\{\{BRIDGE_PORT\}\}/g, () => String(BRIDGE_PORT))
    .replace(/\{\{PANEL_PORT\}\}/g, () => String(PORT));
}

let HTML = "";

// ── 插件系统：panel-plugins/*.mjs 可注册页面卡片与 /api/plugins/<id>/* 路由 ──
const pluginRoutes = [];
const pluginCards = [];

function registerPluginRoute(pluginId, method, subPath, handler) {
  const routePath = `/api/plugins/${pluginId}${subPath}`;
  pluginRoutes.push({ method, path: routePath, handler });
}

async function loadPlugins() {
  const dir = path.join(DIR, "panel-plugins");
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
    try {
      const mod = await import(pathToFileURL(path.join(dir, file)).href);
      const plugin = mod.default ?? mod;
      if (!plugin?.id || typeof plugin.init !== "function") {
        console.error(`[panel] 插件 ${file} 缺少 id 或 init()，已跳过`);
        continue;
      }
      await plugin.init({
        registerRoute: (method, subPath, handler) =>
          registerPluginRoute(plugin.id, method, subPath, handler),
        registerCard: (html) => pluginCards.push(html),
        // 运行期可变的面板设置（保存配置后 gatewayDir 等会更新）
        settings: () => ({
          workbuddyUrl: WORKBUDDY_URL,
          gatewayDir: GATEWAY_DIR,
          gatewayExe: GATEWAY_EXE,
          gatewayConfig: GATEWAY_CONFIG,
          traeUrl: TRAE_URL,
          traeDir: TRAE_DIR,
          traeExe: TRAE_EXE,
          bridgePort: BRIDGE_PORT,
        }),
        readText,
        runCommand,
        fetchJson,
        DIR,
      });
      console.log(`[panel] 已加载插件 ${plugin.id}（${file}）`);
    } catch (error) {
      console.error(`[panel] 插件 ${file} 加载失败：${error?.stack || error}`);
    }
  }
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

function json(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    await htmlReady;
    // 每次请求重建页面：panel-ui 里的三个文件按 mtime 缓存读取，
    // 所以改完 CSS/JS 刷新一下浏览器就生效，不用重启面板。
    const page = buildHtml(pluginCards.join("\n")) || HTML;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(page);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/routing") {
    const state = await routingState();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(state));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/routing") {
    const raw = await readBody(req);
    try {
      const draft = typeof raw === "string" ? JSON.parse(raw) : raw;
      const { parseRegistry } = await import("./upstream-registry.mjs");
      const parsed = parseRegistry(draft);
      if (parsed.errors.length) {
        return json(res, 400, { ok: false, errors: parsed.errors });
      }
      writeJsonAtomic(registryFile, draft);
      return json(res, 200, { ok: true, errors: [], note: "已写入 upstreams.json，bridge 会在 250ms 内热加载" });
    } catch (error) {
      return json(res, 400, { ok: false, errors: [String(error && error.message ? error.message : error)] });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/routing/enable") {
    try {
      // 已经有 upstreams.json 就只是"再确认一次"，别用模板盖掉用户刚保存的配置
      if (fs.existsSync(registryFile)) {
        return json(res, 200, { ok: true, note: "已经是启用状态" });
      }
      let draft = readJsonFile(registryLocalFile);
      if (!draft) draft = readJsonFile(registryDisabledFile);
      if (!draft) {
        return json(res, 400, { ok: false, error: "没有 upstreams.local.json，先在路由页填一份" });
      }
      const { parseRegistry } = await import("./upstream-registry.mjs");
      const parsed = parseRegistry(draft);
      if (parsed.errors.length) return json(res, 400, { ok: false, errors: parsed.errors });
      writeJsonAtomic(registryFile, draft);
      return json(res, 200, { ok: true, note: "已启用，bridge 250ms 内热加载" });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/routing/disable") {
    try {
      if (fs.existsSync(registryFile)) {
        fs.renameSync(registryFile, registryDisabledFile);
      }
      return json(res, 200, { ok: true, note: "已停用，upstreams.json 已改名为 upstreams.disabled.json" });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/quota") {
    const raw = await readBody(req);
    try {
      const draft = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
        return json(res, 400, { ok: false, error: "quota.json 必须是对象" });
      }
      writeJsonAtomic(quotaFile, draft);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 400, { ok: false, error: String(error) });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/quota/live") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(await liveQuota()));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/history") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, samples: loadHistory() }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const status = await collectStatus();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(status));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    const settings = loadSettings();
    const key = readText(workbuddyKeyFile);
    let gatewayApiKey = "";
    try {
      if (fs.existsSync(GATEWAY_CONFIG)) {
        const cfg = JSON.parse(fs.readFileSync(GATEWAY_CONFIG, "utf8"));
        gatewayApiKey = String(cfg.api_key || "");
      }
    } catch {
      /* ignore */
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        workbuddyUrl: settings.workbuddyUrl,
        gatewayDir: settings.gatewayDir,
        traeUrl: settings.traeUrl,
        traeDir: settings.traeDir,
        gatewayExe: GATEWAY_EXE,
        gatewayConfig: GATEWAY_CONFIG,
        gatewayExeExists: fs.existsSync(GATEWAY_EXE),
        apiKey: key,
        apiKeySet: Boolean(key),
        gatewayApiKey,
        gatewayApiKeyMatch: Boolean(key) && key === gatewayApiKey,
        keyFile: workbuddyKeyFile,
        bridgeSecretSet: Boolean(readText(secretFile)),
        bridgePort: BRIDGE_PORT,
      }),
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let payload = {};
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      /* ignore */
    }
    try {
      const patch = {};
      if (payload.workbuddyUrl != null) patch.workbuddyUrl = String(payload.workbuddyUrl).trim();
      if (payload.gatewayDir != null) patch.gatewayDir = String(payload.gatewayDir).trim();
      if (payload.traeUrl != null) patch.traeUrl = String(payload.traeUrl).trim();
      if (payload.traeDir != null) patch.traeDir = String(payload.traeDir).trim();
      const saved = saveSettings(patch);
      if (payload.apiKey != null) {
        const key = String(payload.apiKey).trim();
        if (key) {
          fs.writeFileSync(workbuddyKeyFile, key, "utf8");
          // 同步写回网关 config.json，避免两边 key 不一致
          try {
            if (fs.existsSync(GATEWAY_CONFIG)) {
              const cfg = JSON.parse(fs.readFileSync(GATEWAY_CONFIG, "utf8"));
              if (cfg.api_key !== key) {
                cfg.api_key = key;
                fs.writeFileSync(GATEWAY_CONFIG, JSON.stringify(cfg, null, 2), "utf8");
              }
            }
          } catch {
            /* gateway config optional */
          }
        } else {
          return json(res, 400, { ok: false, error: "API key 不能为空" });
        }
      }
      setAction("保存 WorkBuddy 配置", "ok", "已写入");
      return json(res, 200, {
        ok: true,
        workbuddyUrl: saved.workbuddyUrl,
        gatewayDir: saved.gatewayDir,
        traeUrl: saved.traeUrl,
        traeDir: saved.traeDir,
      });
    } catch (error) {
      setAction("保存 WorkBuddy 配置", "fail", String(error));
      return json(res, 500, { ok: false, error: String(error) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/switch") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let payload = {};
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      /* ignore */
    }
    const upstream = String(payload.upstream || "").toLowerCase();
    if (upstream !== "mimo" && upstream !== "workbuddy" && upstream !== "trae") {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "upstream 必须是 mimo / workbuddy / trae" }));
      return;
    }
    const chatMode =
      payload.chatMode === "raw" || payload.chatMode === "compatible"
        ? payload.chatMode
        : upstream === "workbuddy" || upstream === "trae"
          ? "raw"
          : "compatible";
    // 异步执行：立刻返回，前端靠 /api/status 轮询完成态
    setAction(`切换到 ${upstream}`, "running", "已排队…");
    void switchUpstream(upstream, chatMode).catch((error) => {
      setAction(`切换到 ${upstream}`, "fail", String(error));
    });
    res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, accepted: true, upstream }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/gateway") {
    setAction("启动网关", "running", "正在拉起 workbuddy2api / trae2api…");
    // 两个网关都确保在跑（各自已在跑则跳过；未部署的只报提示）
    Promise.allSettled([ensureGateway(), ensureTraeGateway()])
      .then(([wb, trae]) => {
        const wbR = wb.status === "fulfilled" ? wb.value : { ok: false, detail: String(wb.reason) };
        const trR = trae.status === "fulfilled" ? trae.value : { ok: false, detail: String(trae.reason) };
        const ok = wbR.ok && trR.ok;
        setAction(
          "启动网关",
          ok ? "ok" : "fail",
          `workbuddy2api：${wbR.detail} · trae2api：${trR.detail}`,
        );
      })
      .catch((error) => {
        setAction("启动网关", "fail", String(error));
      });
    res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, accepted: true }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/bridge") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let payload = {};
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      /* ignore */
    }
    const action = String(payload.action || "");
    if (!["start", "stop", "restart"].includes(action)) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "action 必须是 start / stop / restart" }));
      return;
    }
    const label = action === "start" ? "启动 bridge" : action === "stop" ? "停止 bridge" : "重启 bridge";
    setAction(label, "running", "已排队…");
    void bridgeAction(action).catch((error) => {
      setAction(label, "fail", String(error));
    });
    res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, accepted: true, action }));
    return;
  }

  for (const route of pluginRoutes) {
    if (req.method === route.method && url.pathname === route.path) {
      try {
        return await route.handler(req, res, { url, json, readBody });
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error) });
      }
    }
  }

  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "not found" }));
});

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(`[panel] 端口 ${PORT} 已被占用。可用 PANEL_PORT=8792 node panel.mjs 换端口。`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[panel] 控制面板已启动：http://127.0.0.1:${PORT}`);
  console.log("[panel] 仅监听 127.0.0.1。Ctrl+C 退出。");
  // 一并拉起 workbuddy2api（已在跑则跳过）
  ensureGateway()
    .then((gw) => {
      console.log(
        gw.started
          ? `[panel] workbuddy2api 已拉起：${gw.detail}`
          : `[panel] workbuddy2api：${gw.detail}`,
      );
    })
    .catch((error) => {
      console.log(`[panel] workbuddy2api 启动检查失败：${error}`);
    });
  // 一并拉起 trae2api（已在跑则跳过；未部署时仅提示）
  ensureTraeGateway()
    .then((gw) => {
      console.log(
        gw.started
          ? `[panel] trae2api 已拉起：${gw.detail}`
          : `[panel] trae2api：${gw.detail}`,
      );
    })
    .catch((error) => {
      console.log(`[panel] trae2api 启动检查失败：${error}`);
    });
});

// 插件先加载完再渲染页面，保证插件卡片出现在首屏 HTML 里
const htmlReady = loadPlugins()
  .catch((error) => {
    console.error(`[panel] 插件加载异常：${error?.stack || error}`);
  })
  .finally(() => {
    HTML = buildHtml(pluginCards.join("\n"));
  });

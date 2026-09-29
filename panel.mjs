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

const DIR = import.meta.dirname;
const PORT = Number(process.env.PANEL_PORT || 8791);
const BRIDGE_PORT = Number(process.env.MIMO_BRIDGE_PORT || 8788);

const secretFile = path.join(DIR, "bridge-secret.txt");
const workbuddyKeyFile = path.join(DIR, "workbuddy-api-key.txt");
const tokenFile = path.join(DIR, "token.txt");
const settingsFile = path.join(DIR, "panel-settings.json");

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
  };
}

function saveSettings(patch) {
  const current = loadSettings();
  const next = {
    workbuddyUrl: String(patch.workbuddyUrl ?? current.workbuddyUrl).replace(/\/+$/, ""),
    gatewayDir: String(patch.gatewayDir ?? current.gatewayDir),
  };
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), "utf8");
  WORKBUDDY_URL = next.workbuddyUrl;
  GATEWAY_DIR = next.gatewayDir;
  GATEWAY_EXE = path.join(GATEWAY_DIR, "wb2api.exe");
  GATEWAY_CONFIG = path.join(GATEWAY_DIR, "config.json");
  GATEWAY_PID = path.join(GATEWAY_DIR, "wb2api.pid");
  return next;
}

let { workbuddyUrl: WORKBUDDY_URL, gatewayDir: GATEWAY_DIR } = loadSettings();
let GATEWAY_EXE = path.join(GATEWAY_DIR, "wb2api.exe");
let GATEWAY_CONFIG = path.join(GATEWAY_DIR, "config.json");
let GATEWAY_PID = path.join(GATEWAY_DIR, "wb2api.pid");

let actionLock = Promise.resolve();
let lastAction = { label: "", state: "idle", detail: "", at: "" };
let actionBusy = false;

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
    bridge: { online: false },
    workbuddy: { online: false },
    keys: {
      bridgeSecret: Boolean(bridgeSecret),
      workbuddyKey: Boolean(workbuddyKey),
      mimoToken: Boolean(readText(tokenFile)),
    },
    codex: null,
    models: [],
    lastAction,
    actionBusy,
    notes: [],
  };

  try {
    const health = await fetchJson(`http://127.0.0.1:${BRIDGE_PORT}/health`);
    if (health.ok && health.payload) {
      result.bridge = {
        online: true,
        upstreamKind: health.payload.upstreamKind || "",
        chatMode: health.payload.chatMode || "",
        engine: health.payload.engine || "",
        streaming: health.payload.streaming,
        authMode: health.payload.authMode || "",
      };
      if (bridgeSecret) {
        try {
          const models = await fetchJson(
            `http://127.0.0.1:${BRIDGE_PORT}/v1/models`,
            { headers: { Authorization: `Bearer ${bridgeSecret}` } },
          );
          if (models.ok && Array.isArray(models.payload?.data)) {
            result.models = models.payload.data.map((m) => m.id).filter(Boolean);
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
    // 切 workbuddy 前确保网关在跑，避免 bridge 起来后上游离线
    if (upstream === "workbuddy") {
      setAction(`切换到 ${upstream}`, "running", "正在启动 workbuddy2api 网关…");
      const gw = await ensureGateway();
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
      const upstream = current.bridge.upstreamKind || "mimo";
      const args = ["-Port", String(BRIDGE_PORT), "-Upstream", upstream];
      if (upstream === "workbuddy") {
        args.push("-UpstreamUrl", WORKBUDDY_URL);
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

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>模型桥控制面板</title>
<style>
  :root {
    --bg: #0b1220;
    --panel: #121a2b;
    --panel-2: #1a2438;
    --line: #2a3a55;
    --ink: #eef3fb;
    --muted: #93a4bf;
    --ok: #34d399;
    --warn: #fbbf24;
    --err: #f87171;
    --accent: #2dd4bf;
    --accent-2: #38bdf8;
    --accent-ink: #042f2e;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    min-height: 100vh;
    font: 15px/1.55 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: var(--bg);
    color: var(--ink);
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 820px; margin: 0 auto; padding: 22px 16px 40px; }

  header {
    display: flex; justify-content: space-between; align-items: center;
    gap: 12px; margin-bottom: 16px;
  }
  h1 { margin: 0; font-size: 22px; font-weight: 700; }
  .sub { color: var(--muted); font-size: 13px; margin-top: 4px; }

  /* 大按钮：整块可点，热区 ≥ 48px */
  .btn {
    appearance: none;
    border: 1px solid var(--line);
    background: var(--panel-2);
    color: var(--ink);
    border-radius: 12px;
    min-height: 48px;
    padding: 12px 18px;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    user-select: none;
    touch-action: manipulation;
    transition: background 0.12s ease, border-color 0.12s ease, transform 0.08s ease;
  }
  .btn:hover { border-color: var(--accent); background: #1f2c44; }
  .btn:active { transform: scale(0.98); }
  .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .btn:disabled {
    opacity: 0.55; cursor: not-allowed; transform: none;
  }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .btn.primary:hover { background: #5eead4; }
  .btn.danger:hover { border-color: var(--err); color: var(--err); background: rgba(248,113,113,0.08); }

  .grid { display: grid; gap: 14px; }
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 16px;
  }
  .card h2 {
    margin: 0 0 12px;
    font-size: 12px;
    font-weight: 700;
    color: var(--muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  /* 上游切换：两个大块，整块可点 */
  .switches {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  @media (max-width: 640px) {
    .switches { grid-template-columns: 1fr; }
  }
  .switch {
    display: block;
    width: 100%;
    text-align: left;
    border: 2px solid var(--line);
    border-radius: 14px;
    background: var(--panel-2);
    color: inherit;
    font: inherit;
    padding: 16px;
    cursor: pointer;
    user-select: none;
    touch-action: manipulation;
    transition: border-color 0.12s ease, background 0.12s ease, box-shadow 0.12s ease;
    min-height: 132px;
  }
  .switch:hover { border-color: var(--accent); background: #1f2c44; }
  .switch:active { transform: scale(0.99); }
  .switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .switch:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }
  .switch.active {
    border-color: var(--accent);
    background: rgba(45, 212, 191, 0.1);
    box-shadow: 0 0 0 3px rgba(45, 212, 191, 0.18);
  }
  .switch .title {
    font-size: 17px;
    font-weight: 700;
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .switch .desc {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.45;
    min-height: 40px;
  }
  .switch .cta {
    margin-top: 12px;
    font-size: 13px;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: 0.02em;
  }
  .switch.active .cta { color: var(--ok); }
  .cta.busy-text { color: var(--accent); animation: pulse 1.1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.55; } }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .badge.on {
    color: var(--ok);
    border-color: rgba(52, 211, 153, 0.4);
    background: rgba(52, 211, 153, 0.1);
  }

  .dot {
    display: inline-block;
    width: 9px; height: 9px;
    border-radius: 50%;
    background: var(--muted);
    flex: none;
  }
  .dot.ok { background: var(--ok); box-shadow: 0 0 0 3px rgba(52,211,153,0.18); }
  .dot.warn { background: var(--warn); box-shadow: 0 0 0 3px rgba(251,191,36,0.18); }
  .dot.err { background: var(--err); box-shadow: 0 0 0 3px rgba(248,113,113,0.18); }

  /* 操作行：按钮固定高度，避免刷新时抖动 */
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 14px;
  }
  .actions .btn { min-width: 120px; }

  /* 状态行：固定最小高度，刷新不跳版 */
  .rows { min-height: 220px; }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    min-height: 40px;
    padding: 6px 0;
    border-top: 1px solid rgba(42, 58, 85, 0.55);
  }
  .row:first-child { border-top: 0; }
  .k { color: var(--muted); flex: none; font-size: 13.5px; }
  .v {
    text-align: right;
    font-family: Consolas, "Cascadia Mono", monospace;
    font-size: 12.5px;
    word-break: break-all;
    line-height: 1.4;
  }

  .models {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    min-height: 48px;
  }
  .chip {
    font-family: Consolas, "Cascadia Mono", monospace;
    font-size: 12px;
    padding: 6px 10px;
    border-radius: 8px;
    background: rgba(56, 189, 248, 0.1);
    border: 1px solid rgba(56, 189, 248, 0.25);
    color: var(--accent-2);
    white-space: nowrap;
  }
  .empty { color: var(--muted); font-size: 13px; }

  .form { display: grid; gap: 12px; }
  .form label { display: grid; gap: 6px; }
  .form label > span {
    font-size: 12px;
    color: var(--muted);
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .form input {
    width: 100%;
    min-height: 44px;
    border-radius: 10px;
    border: 1px solid var(--line);
    background: var(--panel-2);
    color: var(--ink);
    padding: 10px 12px;
    font: 13px/1.4 Consolas, "Cascadia Mono", monospace;
  }
  .form input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(45, 212, 191, 0.15);
  }
  .form-actions { display: flex; flex-wrap: wrap; gap: 10px; }

  /* 任务条：当前在干什么，一眼看到 */
  .taskbar {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 10px 14px;
    border-radius: 12px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    font-size: 13.5px;
  }
  .taskbar .state {
    font-weight: 700;
    flex: none;
  }
  .taskbar .state.running { color: var(--accent); }
  .taskbar .state.ok { color: var(--ok); }
  .taskbar .state.fail { color: var(--err); }
  .taskbar .state.idle { color: var(--muted); }
  .taskbar .detail { color: var(--muted); word-break: break-all; }
  .spin {
    width: 14px; height: 14px;
    border: 2px solid rgba(45, 212, 191, 0.25);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex: none;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  footer {
    margin-top: 16px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>模型桥控制面板</h1>
        <div class="sub">点大卡片切换上游 · 按钮可整块点 · Codex 负责工具，推理走这里</div>
      </div>
      <button class="btn" id="refreshBtn" type="button">刷新状态</button>
    </header>

    <div class="grid">
      <div class="taskbar" id="taskbar">
        <div class="state idle" id="taskState">空闲</div>
        <div class="detail" id="taskDetail">等待操作…</div>
      </div>

      <section class="card">
        <h2>上游切换（点卡片即可）</h2>
        <div class="switches">
          <button class="switch" type="button" id="sw-mimo" data-upstream="mimo">
            <div class="title">MiMo Desktop</div>
            <div class="desc">用本机 MiMo 套餐驱动 Codex。需要 MiMo Desktop 已登录。</div>
            <div class="badge" id="badge-mimo"><span class="dot"></span>未选中</div>
            <div class="cta" id="cta-mimo">点击切换 →</div>
          </button>
          <button class="switch" type="button" id="sw-workbuddy" data-upstream="workbuddy">
            <div class="title">WorkBuddy</div>
            <div class="desc">走 workbuddy2api (:7863)。模型 ID 保留 cn: / global: 前缀。</div>
            <div class="badge" id="badge-workbuddy"><span class="dot"></span>未选中</div>
            <div class="cta" id="cta-workbuddy">点击切换 →</div>
          </button>
        </div>

        <div class="actions">
          <button class="btn" type="button" id="gatewayBtn"><span class="btn-label">启动网关</span></button>
          <button class="btn primary" type="button" id="startBtn"><span class="btn-label">启动 bridge</span></button>
          <button class="btn" type="button" id="restartBtn"><span class="btn-label">重启</span></button>
          <button class="btn danger" type="button" id="stopBtn"><span class="btn-label">停止</span></button>
        </div>
      </section>

      <section class="card">
        <h2>状态</h2>
        <div class="rows" id="statusBody"><div class="empty">加载中…</div></div>
      </section>

      <section class="card">
        <h2>WorkBuddy 配置</h2>
        <div class="form">
          <label>
            <span>网关地址</span>
            <input id="cfgUrl" type="text" spellcheck="false" placeholder="http://127.0.0.1:7863" />
          </label>
          <label>
            <span>网关目录</span>
            <input id="cfgDir" type="text" spellcheck="false" placeholder="C:\Users\你\.workbuddy2api" />
          </label>
          <label>
            <span>API Key</span>
            <input id="cfgKey" type="password" spellcheck="false" placeholder="workbuddy2api 的 api_key" />
          </label>
          <div class="form-actions">
            <button class="btn primary" type="button" id="saveCfgBtn"><span class="btn-label">保存配置</span></button>
            <button class="btn" type="button" id="reloadCfgBtn"><span class="btn-label">重新加载</span></button>
          </div>
          <div class="empty" id="cfgMeta">—</div>
        </div>
      </section>

      <section class="card">
        <h2>可用模型</h2>
        <div class="models" id="modelsBody"><div class="empty">—</div></div>
      </section>
    </div>

    <footer>
      只监听 127.0.0.1。切换上游会重启 bridge；模型仍由 cc-switch / Codex 配置选择。<br>
      WorkBuddy2API 离线 = workbuddy2api 网关未启动（WorkBuddy 客户端 ≠ API 网关）。
    </footer>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);
    let busy = false;
    let refreshTimer = null;
    let activeAction = null; // { kind, target }

    function setText(el, text) {
      if (el) el.textContent = text;
    }
    function setHTML(el, html) {
      if (el) el.innerHTML = html;
    }
    function setClassName(el, name) {
      if (el) el.className = name;
    }

    function setBusy(on, action) {
      busy = on;
      activeAction = on ? action : null;
      for (const id of ["refreshBtn", "startBtn", "restartBtn", "stopBtn", "sw-mimo", "sw-workbuddy", "gatewayBtn", "saveCfgBtn", "reloadCfgBtn"]) {
        const el = $(id);
        if (el) el.disabled = on;
      }
      // 只改卡片 CTA / 按钮 label，绝不动整块 DOM
      for (const id of ["mimo", "workbuddy"]) {
        const cta = $("cta-" + id);
        if (!cta) continue;
        if (on && action && action.kind === "switch" && action.target === id) {
          setText(cta, "处理中…");
          cta.classList.add("busy-text");
        }
      }
      const btnLabels = {
        start: "startBtn",
        stop: "stopBtn",
        restart: "restartBtn",
        gateway: "gatewayBtn",
        saveCfg: "saveCfgBtn",
      };
      const defaults = {
        start: "启动 bridge",
        stop: "停止",
        restart: "重启",
        gateway: "启动网关",
        saveCfg: "保存配置",
      };
      for (const [key, id] of Object.entries(btnLabels)) {
        const labelEl = $(id)?.querySelector(".btn-label");
        if (!labelEl) continue;
        if (on && action && action.target === key) {
          setText(labelEl, "处理中…");
        } else {
          setText(labelEl, defaults[key]);
        }
      }
    }

    function renderTask(last) {
      const stateEl = $("taskState");
      const detailEl = $("taskDetail");
      if (!stateEl || !detailEl) return;
      const state = last?.state || "idle";
      const label = last?.label || "空闲";
      const detail = last?.detail || "等待操作…";
      const at = last?.at ? last.at + " · " : "";
      setClassName(stateEl, "state " + state);
      setText(
        stateEl,
        state === "running" ? "进行中" : state === "ok" ? "完成" : state === "fail" ? "失败" : "空闲",
      );
      detailEl.innerHTML =
        (state === "running" ? '<span class="spin"></span> ' : "") +
        at + label + (detail ? " — " + detail : "");
    }

    function renderStatus(data) {
      const b = data.bridge || {};
      const w = data.workbuddy || {};
      const k = data.keys || {};
      const c = data.codex || {};

      const rows = [
        ["Bridge", b.online ? '<span class="dot ok"></span>运行中' : '<span class="dot err"></span>未运行'],
        ["当前上游", b.upstreamKind || "—"],
        ["Chat 模式", b.chatMode || "—"],
        ["WorkBuddy2API", w.online
          ? '<span class="dot ok"></span>在线' + (w.modelCount != null ? " · " + w.modelCount + " 个模型" : "")
          : '<span class="dot err"></span>离线 · ' + (w.detail || "未运行或不可达")],
        ["bridge-secret", k.bridgeSecret ? '<span class="dot ok"></span>已配置' : '<span class="dot err"></span>缺失'],
        ["WorkBuddy key", k.workbuddyKey ? '<span class="dot ok"></span>已配置' : '<span class="dot warn"></span>缺失'],
        ["Codex provider", (c.provider || "—") + (c.pointsToBridge ? ' <span class="badge on">已指向 bridge</span>' : "")],
        ["Codex base_url", c.baseUrl || (c.missing ? "未找到 config.toml" : "—")],
      ];
      setHTML(
        $("statusBody"),
        rows.map(([kk, v]) =>
          '<div class="row"><div class="k">' + kk + '</div><div class="v">' + v + "</div></div>"
        ).join(""),
      );

      const active = b.upstreamKind || "";
      for (const id of ["mimo", "workbuddy"]) {
        const btn = $("sw-" + id);
        const badge = $("badge-" + id);
        const cta = $("cta-" + id);
        if (!btn || !badge || !cta) continue;
        const on = active === id;
        btn.classList.toggle("active", on);
        setClassName(badge, "badge" + (on ? " on" : ""));
        setHTML(
          badge,
          on
            ? '<span class="dot ok"></span>当前上游'
            : '<span class="dot"></span>未选中',
        );
        // busy 时保留“处理中…”，空闲才显示切换/生效文案
        const serverRunning = Boolean(data.actionBusy) || data.lastAction?.state === "running";
        const serverSwitchTarget =
          /切换到 (mimo|workbuddy)/.exec(data.lastAction?.label || "")?.[1] || null;
        if (!busy && !serverRunning) {
          cta.classList.remove("busy-text");
          setText(cta, on ? "当前生效中 ✓" : "点击切换 →");
        } else {
          const hit =
            (busy && activeAction && activeAction.kind === "switch" && activeAction.target === id) ||
            (!busy && serverRunning && serverSwitchTarget === id);
          if (hit) {
            setText(cta, "处理中…");
            cta.classList.add("busy-text");
          } else {
            cta.classList.remove("busy-text");
            setText(cta, on ? "当前生效中 ✓" : "点击切换 →");
          }
        }
      }

      const models = data.models || [];
      setHTML(
        $("modelsBody"),
        models.length
          ? models.map((id) => '<span class="chip">' + id + "</span>").join("")
          : '<div class="empty">bridge 未返回模型。先启动 bridge，并确认上游在线。</div>',
      );

      // 本地 busy 时不被远端 lastAction 覆盖
      if (!busy) renderTask(data.lastAction);
    }

    async function refresh() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        const data = await res.json();
        lastServerBusy = Boolean(data.actionBusy);
        lastServerAction = data.lastAction || null;
        renderStatus(data);
      } catch (e) {
        setHTML($("statusBody"), '<div class="empty">无法读取状态：' + e + "</div>");
      }
    }

    async function post(url, body) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return res.json();
    }

    // 发令后轮询完成态；请求本身立刻返回，界面不吊死
    async function runAction(startLabel, fire) {
      if (busy) return;
      setBusy(true, fire.actionMeta);
      renderTask({
        state: "running",
        label: startLabel,
        detail: "已提交，等待 bridge 重启…",
        at: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      });
      clearInterval(refreshTimer);
      refreshTimer = setInterval(refresh, 1000);

      const startedAt = Date.now();
      const TIMEOUT_MS = 60000;
      try {
        await fire.send();
        // 轮询直到 actionBusy=false 且 lastAction 不再是 running
        while (Date.now() - startedAt < TIMEOUT_MS) {
          await new Promise((r) => setTimeout(r, 800));
          await refresh();
          const stillBusy = lastServerBusy || (lastServerAction && lastServerAction.state === "running");
          if (!stillBusy && lastServerAction && lastServerAction.state !== "running") {
            renderTask(lastServerAction);
            break;
          }
        }
        if (Date.now() - startedAt >= TIMEOUT_MS) {
          renderTask({ state: "fail", label: startLabel, detail: "等待超时（60s），请手动刷新页面确认状态" });
        }
      } catch (e) {
        renderTask({ state: "fail", label: startLabel, detail: String(e) });
      } finally {
        setBusy(false, null);
        clearInterval(refreshTimer);
        refreshTimer = setInterval(refresh, 8000);
        refresh();
      }
    }

    let lastServerBusy = false;
    let lastServerAction = null;

    function doSwitch(upstream) {
      return runAction("切换到 " + upstream, {
        actionMeta: { kind: "switch", target: upstream },
        send: () =>
          post("/api/switch", {
            upstream,
            chatMode: upstream === "workbuddy" ? "raw" : "compatible",
          }),
      });
    }

    function doBridge(action) {
      const label = action === "start" ? "启动 bridge" : action === "stop" ? "停止 bridge" : "重启 bridge";
      return runAction(label, {
        actionMeta: { kind: "bridge", target: action },
        send: () => post("/api/bridge", { action }),
      });
    }

    function doGateway() {
      return runAction("启动 workbuddy2api 网关", {
        actionMeta: { kind: "gateway", target: "gateway" },
        send: () => post("/api/gateway", {}),
      });
    }

    async function loadConfig() {
      try {
        const res = await fetch("/api/config", { cache: "no-store" });
        const data = await res.json();
        $("cfgUrl").value = data.workbuddyUrl || "";
        $("cfgDir").value = data.gatewayDir || "";
        $("cfgKey").value = data.apiKey || "";
        const bits = [];
        bits.push(data.gatewayExeExists ? "网关可执行文件：已找到" : "网关可执行文件：缺失");
        bits.push(data.apiKeySet ? "API Key：已配置" : "API Key：未配置");
        if (data.gatewayApiKey) {
          bits.push(data.gatewayApiKeyMatch ? "与网关 config.json 一致" : "与网关 config.json 不一致");
        }
        bits.push(data.bridgeSecretSet ? "bridge-secret：已配置" : "bridge-secret：缺失");
        $("cfgMeta").textContent = bits.join(" · ");
      } catch (e) {
        $("cfgMeta").textContent = "读取配置失败：" + e;
      }
    }

    async function saveConfig() {
      if (busy) return;
      setBusy(true, { kind: "config", target: "saveCfg" });
      try {
        const res = await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workbuddyUrl: $("cfgUrl").value.trim(),
            gatewayDir: $("cfgDir").value.trim(),
            apiKey: $("cfgKey").value.trim(),
          }),
        });
        const data = await res.json();
        if (data.ok) {
          renderTask({ state: "ok", label: "保存 WorkBuddy 配置", detail: "已写入" });
        } else {
          renderTask({ state: "fail", label: "保存 WorkBuddy 配置", detail: data.error || "失败" });
        }
      } catch (e) {
        renderTask({ state: "fail", label: "保存 WorkBuddy 配置", detail: String(e) });
      } finally {
        setBusy(false, null);
        await loadConfig();
        await refresh();
      }
    }

    $("sw-mimo").addEventListener("click", () => doSwitch("mimo"));
    $("sw-workbuddy").addEventListener("click", () => doSwitch("workbuddy"));
    $("startBtn").addEventListener("click", () => doBridge("start"));
    $("stopBtn").addEventListener("click", () => doBridge("stop"));
    $("restartBtn").addEventListener("click", () => doBridge("restart"));
    $("gatewayBtn").addEventListener("click", () => doGateway());
    $("saveCfgBtn").addEventListener("click", () => saveConfig());
    $("reloadCfgBtn").addEventListener("click", () => loadConfig());
    $("refreshBtn").addEventListener("click", refresh);

    refresh();
    loadConfig();
    refreshTimer = setInterval(refresh, 8000);
  </script>
</body>
</html>
`;

function json(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
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
    if (upstream !== "mimo" && upstream !== "workbuddy") {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "upstream 必须是 mimo 或 workbuddy" }));
      return;
    }
    const chatMode =
      payload.chatMode === "raw" || payload.chatMode === "compatible"
        ? payload.chatMode
        : upstream === "workbuddy"
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
    setAction("启动 workbuddy2api", "running", "正在拉起网关…");
    void ensureGateway()
      .then((gw) => {
        setAction("启动 workbuddy2api", gw.ok ? "ok" : "fail", gw.detail);
      })
      .catch((error) => {
        setAction("启动 workbuddy2api", "fail", String(error));
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
});

/**
 * model-bridge — MiMo / WorkBuddy 模型上游到 Codex-compatible agent 的协议桥接。
 *
 * 主要能力：
 * - Responses API ⇄ Chat Completions 协议转换
 * - 真实上游流式转发，并转换成 Responses SSE 事件
 * - 仅探测属于 MiMo 进程的本地端口
 * - /v1 桥接端点要求本地 bearer token
 * - 请求体积、上游超时、客户端取消和错误处理
 */
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { promisify } from "node:util";
import {
  CircuitBreaker,
  MetricsRegistry,
  isRetryableStatus,
  errorTypeFromStatus,
} from "./runtime.mjs";
import {
  toChatRequest,
  toResponseObject,
  responseEvents,
  createResponseStreamTranslator,
  createSseParser,
  createQueuedResponse,
  sseWrite,
} from "./responses.mjs";
import {
  toChatRequestFromAnthropic,
  toAnthropicMessage,
  createAnthropicStreamTranslator,
  anthropicErrorPayload,
  anthropicSseWrite,
} from "./anthropic-messages.mjs";
import { ResponseStore } from "./protocol-state.mjs";
import { createRouting } from "./bridge-routing.mjs";
import { createHooks } from "./hooks.mjs";
import {
  estimateChatRequestTokens,
  estimateChatResponseTokens,
  hasRealUsage,
} from "./token-estimate.mjs";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const intFrom = (value, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};

const LISTEN_PORT = intFrom(
  argOf("--port", process.env.MIMO_BRIDGE_PORT || 8788),
  8788,
);
const INSTANCE_DIR = argOf(
  "--dir",
  process.env.MIMO_BRIDGE_DIR || path.join(os.homedir(), ".mimo-bridge"),
);
const UPSTREAM_KIND = (
  argOf("--upstream-kind", process.env.MIMO_BRIDGE_UPSTREAM_KIND || "mimo") ||
  "mimo"
).toLowerCase();
// OpenAI 直通型上游（本地网关反代，模型 ID 原样透传）：
// workbuddy = workbuddy2api (:7863)，trae = trae2api (:7864)。
const OPENAI_UPSTREAM_DEFAULTS = {
  workbuddy: { tokenFile: "workbuddy-api-key.txt", engineUrl: "http://127.0.0.1:7863" },
  trae: { tokenFile: "trae-api-key.txt", engineUrl: "http://127.0.0.1:7864" },
};
const PASSTHROUGH_UPSTREAM = Boolean(OPENAI_UPSTREAM_DEFAULTS[UPSTREAM_KIND]);
const CHAT_MODE = (
  argOf(
    "--chat-mode",
    process.env.MIMO_BRIDGE_CHAT_MODE ||
      (PASSTHROUGH_UPSTREAM ? "raw" : "compatible"),
  ) || "compatible"
).toLowerCase();
const RAW_CHAT = CHAT_MODE === "raw";
const TOKEN_FILE = argOf(
  "--token-file",
  process.env.MIMO_BRIDGE_UPSTREAM_TOKEN_FILE ||
    process.env.WORKBUDDY_API_KEY_FILE ||
    path.join(
      import.meta.dirname,
      PASSTHROUGH_UPSTREAM
        ? OPENAI_UPSTREAM_DEFAULTS[UPSTREAM_KIND].tokenFile
        : "token.txt",
    ),
);
const BRIDGE_SECRET_FILE = argOf(
  "--bridge-secret-file",
  path.join(import.meta.dirname, "bridge-secret.txt"),
);
const PROCESS_NAME = argOf(
  "--process",
  process.env.MIMO_BRIDGE_PROCESS || "Xiaomi MiMo.exe",
);
// MiMo Desktop 升级后模型 ID 从 xiaomi/* 变成了 mimo-desktop/*，
// 所以前缀和兜底模型都做成可配置，别再写死。
const MODEL_PREFIX = argOf(
  "--model-prefix",
  process.env.MIMO_BRIDGE_MODEL_PREFIX ||
    (PASSTHROUGH_UPSTREAM ? "off" : "mimo-desktop"),
);
const MODEL_FALLBACK = argOf(
  "--model-fallback",
  process.env.MIMO_BRIDGE_MODEL_FALLBACK ||
    (PASSTHROUGH_UPSTREAM ? "off" : "mimo-desktop/mimo-v2.6-pro"),
);
// 上游不返回 usage 时是否用本地估算器补齐（MIMO_BRIDGE_TOKEN_ESTIMATE=off 关闭）。
const TOKEN_ESTIMATE_ENABLED = !/^(0|off|false)$/i.test(
  process.env.MIMO_BRIDGE_TOKEN_ESTIMATE || "1",
);
// ── Trae 上游元数据补齐（2026-10-19 实测）─────────────────────────────
// 上游两条通道都不给全模型元数据：
//   · get_detail_param / trae2api /v1/models 只有 context_length（上下文窗口），
//     没有最大输出数；max_tokens 塞 999999 也照单全收，问不出真实上限。
//   · usage 里的缓存命中的确有，但用的是 Anthropic 风格字段
//     （cache_read_input_tokens），OpenAI 客户端读的
//     prompt_tokens_details.cached_tokens 永远是空。
// 桥这一层补齐：/v1/models 加字段别名并过滤内部模型；usage 做字段风格转换。
// 最大输出数是保守默认值（不是上游声明），实测出真实上限后写进覆盖表。
const TRAE_DEFAULT_MAX_OUTPUT = Math.max(
  1024,
  intFrom(process.env.BRIDGE_TRAE_MAX_OUTPUT_TOKENS || 32768, 32768),
);
let TRAE_MAX_OUTPUT_OVERRIDES = {};
try {
  TRAE_MAX_OUTPUT_OVERRIDES = JSON.parse(
    process.env.BRIDGE_TRAE_MAX_OUTPUT_OVERRIDES || "{}",
  );
} catch (error) {
  console.warn(
    "[bridge] BRIDGE_TRAE_MAX_OUTPUT_OVERRIDES 不是合法 JSON，已忽略：" +
      String(error?.message ?? error),
  );
}
// trae 目录里的内部 subagent 与 custom_model_* 自定义槽位，不进客户端选择器。
const TRAE_INTERNAL_MODELS = new Set([
  "computer_use_subagent",
  "browser_use_subagent",
  "file_search_agent",
  "explore_sub_agent_v2",
  "summary",
]);
const ENGINE_URL = (

  argOf(
    "--engine-url",
    process.env.MIMO_BRIDGE_ENGINE_URL ||
      (PASSTHROUGH_UPSTREAM ? OPENAI_UPSTREAM_DEFAULTS[UPSTREAM_KIND].engineUrl : ""),
  ) || ""
)
  .trim()
  .replace(/\/+$/, "");
const UPSTREAM_TIMEOUT_MS = intFrom(
  process.env.MIMO_BRIDGE_UPSTREAM_TIMEOUT_MS || 600000,
  600000,
);
// 上游偶发「headers 正常但长时间不吐 delta」。总超时 10 分钟对交互太长，
// 这里拆成首包超时 + 流空闲超时，超时立刻中止并把错误抛给客户端。
const FIRST_TOKEN_TIMEOUT_MS = intFrom(
  process.env.MIMO_BRIDGE_FIRST_TOKEN_TIMEOUT_MS || 60000,
  60000,
);
const STREAM_IDLE_TIMEOUT_MS = intFrom(
  process.env.MIMO_BRIDGE_STREAM_IDLE_TIMEOUT_MS || 90000,
  90000,
);
// fetch() 要等到上游响应头才会 resolve。上游若接受请求后迟迟不回头，
// 不加限时会一直挂到总超时（默认 10 分钟）。
const UPSTREAM_HEADER_TIMEOUT_MS = intFrom(
  process.env.MIMO_BRIDGE_UPSTREAM_HEADER_TIMEOUT_MS || FIRST_TOKEN_TIMEOUT_MS,
  FIRST_TOKEN_TIMEOUT_MS,
);
const MAX_BODY_BYTES = intFrom(
  process.env.MIMO_BRIDGE_MAX_BODY_BYTES || 20 * 1024 * 1024,
  20 * 1024 * 1024,
);
const MAX_CONCURRENT_REQUESTS = intFrom(
  process.env.MIMO_BRIDGE_MAX_CONCURRENT || 8,
  8,
);
// 额度泄漏兜底：单个额度被持有超过该时长即强制回收。正常流式请求有
// 90s 空闲看门狗、非流式有 60s 首包 + 10min 总超时，均远低于此值。
const SLOT_REAP_AFTER_MS = intFrom(
  process.env.MIMO_BRIDGE_SLOT_REAP_MS || 30 * 60 * 1000,
  30 * 60 * 1000,
);
const BREAKER_FAILURES = intFrom(
  process.env.MIMO_BRIDGE_BREAKER_FAILURES || 3,
  3,
);
const BREAKER_COOLDOWN_MS = intFrom(
  process.env.MIMO_BRIDGE_BREAKER_COOLDOWN_MS || 5000,
  5000,
);
const RESPONSE_STATE_TTL_MS = intFrom(
  process.env.MIMO_BRIDGE_RESPONSE_TTL_MS || 30 * 60 * 1000,
  30 * 60 * 1000,
);
const RESPONSE_STATE_MAX = intFrom(
  process.env.MIMO_BRIDGE_RESPONSE_STATE_MAX || 5000,
  5000,
);
const DEBUG = process.env.BRIDGE_DEBUG === "1";

const BRIDGE_VERSION = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf8"),
    ).version;
  } catch {
    return "unknown";
  }
})();

// 只绑 127.0.0.1 并不能挡住 DNS rebinding：恶意页面可以让自己的域名解析到
// 127.0.0.1，再由浏览器带上 Host: evil.example 打到本服务。这里显式校验 Host。
const ALLOW_ANY_HOST = process.env.MIMO_BRIDGE_ALLOW_ANY_HOST === "1";
const ALLOWED_HOSTS = new Set(
  (process.env.MIMO_BRIDGE_ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
    .concat([
      `127.0.0.1:${LISTEN_PORT}`,
      `localhost:${LISTEN_PORT}`,
      `[::1]:${LISTEN_PORT}`,
      "127.0.0.1",
      "localhost",
      "[::1]",
    ]),
);
const DEBUG_INCLUDE_BODY = process.env.BRIDGE_DEBUG_INCLUDE_BODY === "1";
const DEBUG_FILE = path.join(import.meta.dirname, "debug-requests.jsonl");
const UPSTREAM_API_KEY =
  process.env.WORKBUDDY_API_KEY ||
  process.env.MIMO_BRIDGE_UPSTREAM_API_KEY ||
  "";

// 引擎明确拒绝、而 Codex 可能发送的 Responses 专属字段。
const STRIP_FIELDS = [
  "response_format",
  "logit_bias",
  "top_logprobs",
  "verbosity",
  "store",
  "n",
];

function loadToken() {
  const direct = argOf("--token", null);
  if (direct) return direct;
  if (UPSTREAM_API_KEY) return UPSTREAM_API_KEY;
  if (fs.existsSync(TOKEN_FILE)) {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  }
  const nextStep =
    PASSTHROUGH_UPSTREAM
      ? "write the " + UPSTREAM_KIND + " API key to " + TOKEN_FILE
      : "run node mint-token.mjs";
  console.error(
    "[bridge] missing upstream credential file: " +
      TOKEN_FILE +
      "\n[bridge] next step: " +
      nextStep,
  );
  process.exit(2);
}

const TOKEN = loadToken();

function loadBridgeSecret() {
  const direct = argOf("--bridge-secret", null);
  if (direct) {
    return { value: direct, mode: "bridge_secret" };
  }
  if (process.env.MIMO_BRIDGE_SECRET) {
    return {
      value: process.env.MIMO_BRIDGE_SECRET,
      mode: "bridge_secret",
    };
  }
  if (fs.existsSync(BRIDGE_SECRET_FILE)) {
    return {
      value: fs.readFileSync(BRIDGE_SECRET_FILE, "utf8").trim(),
      mode: "bridge_secret",
    };
  }
  return { value: TOKEN, mode: "legacy_shared_token" };
}

const bridgeAuth = loadBridgeSecret();
const BRIDGE_SECRET = bridgeAuth.value;
const BRIDGE_AUTH_MODE = bridgeAuth.mode;

const responseStore = new ResponseStore({
  ttlMs: RESPONSE_STATE_TTL_MS,
  maxEntries: RESPONSE_STATE_MAX,
  stateFile: path.join(INSTANCE_DIR, "responses-state.json"),
});

// ── 多上游路由 ────────────────────────────────────────────────────────
// 一次请求一个上下文：fetchUpstream 从这里取"这一跳问哪家、用哪个 token"。
// 用 AsyncLocalStorage 而不是全局变量，是因为并发请求会同时打到不同上游。
const routeStore = new AsyncLocalStorage();
const currentRoute = () => routeStore.getStore() || null;

// 上游 token 按文件 mtime 缓存：别每个请求读一次盘。
const upstreamTokenCache = new Map();
function readUpstreamToken(file) {
  if (!file) return "";
  try {
    const stat = fs.statSync(file);
    const cached = upstreamTokenCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;
    const value = fs.readFileSync(file, "utf8").trim();
    upstreamTokenCache.set(file, { mtimeMs: stat.mtimeMs, value });
    return value;
  } catch {
    return "";
  }
}

const routing = createRouting({
  dir: import.meta.dirname,
  // MIMO_BRIDGE_UPSTREAMS=off 可以彻底关掉注册表（测试和"临时回到单上游"都用这个）
  registryPath: (() => {
    const raw = String(process.env.MIMO_BRIDGE_UPSTREAMS || "").trim();
    if (/^(off|0|none|false)$/i.test(raw)) return path.join(import.meta.dirname, ".no-upstreams.json");
    return raw || path.join(import.meta.dirname, "upstreams.json");
  })(),
  readFile: (file) => fs.readFileSync(file, "utf8"),
  statSync: (file) => fs.statSync(file),
  resolveBase: async (upstream) =>
    upstream.kind === "mimo" ? await discoverEngine() : upstream.base,
  readToken: (upstream) =>
    readUpstreamToken(
      path.isAbsolute(upstream.tokenFile)
        ? upstream.tokenFile
        : path.resolve(import.meta.dirname, upstream.tokenFile),
    ),
  readQuotaJson: () => {
    try {
      const quotaFile =
        process.env.MIMO_BRIDGE_QUOTA ||
        path.join(import.meta.dirname, "quota.json");
      return JSON.parse(fs.readFileSync(quotaFile, "utf8"));
    } catch {
      return null;
    }
  },
  warn: (message) => console.log("[route] " + message),
});

const hooks = createHooks({
  dir: import.meta.dirname,
  statSync: fs.statSync,
  pathJoin: path.join,
  warn: (message) => console.log("[hooks] " + message),
});

// 会话粘性：同一段对话（prompt_cache_key / session_id）尽量回同一家上游。
const AFFINITY_TTL_MS = 30 * 60 * 1000;
const sessionAffinity = new Map();
function sessionKeyOf(body) {
  return String(
    body?.prompt_cache_key ||
      body?.metadata?.session_id ||
      body?.metadata?.session ||
      body?.user ||
      "",
  );
}
function rememberAffinity(key, upstreamId) {
  if (!key || !upstreamId) return;
  sessionAffinity.set(key, { upstreamId, at: Date.now() });
  if (sessionAffinity.size > 200) {
    const now = Date.now();
    for (const [k, v] of sessionAffinity) {
      if (now - v.at > AFFINITY_TTL_MS) sessionAffinity.delete(k);
    }
  }
}
function affinityFor(key) {
  if (!key) return "";
  const hit = sessionAffinity.get(key);
  if (!hit) return "";
  if (Date.now() - hit.at > AFFINITY_TTL_MS) {
    sessionAffinity.delete(key);
    return "";
  }
  return hit.upstreamId;
}

/** 把 usage 记到当前请求的路由上下文：请求结束时一起写进请求日志。 */
function noteUsage(usage, estimated = false) {
  const route = currentRoute();
  if (!route || !usage || typeof usage !== "object") return;
  route.usage = {
    prompt_tokens: Number(usage.prompt_tokens ?? usage.input_tokens) || 0,
    completion_tokens: Number(usage.completion_tokens ?? usage.output_tokens) || 0,
    total_tokens: Number(usage.total_tokens) || 0,
    __estimated: Boolean(estimated),
  };
}

// 当前这一跳是不是 MiMo：有路由就按路由选中的上游，没路由就退回启动参数。
function isMimoUpstream() {
  const route = currentRoute();
  return route ? route.kind === "mimo" : isMimoUpstream();
}

const metrics = new MetricsRegistry({
  maxConcurrent: MAX_CONCURRENT_REQUESTS,
  breakerFailures: BREAKER_FAILURES,
  breakerCooldownMs: BREAKER_COOLDOWN_MS,
});

setInterval(() => {
  for (const detail of metrics.reapStale(SLOT_REAP_AFTER_MS)) {
    metrics.observeError("concurrency_slot_reaped");
    console.error(
      `[bridge] reaped stuck concurrency slot: ${JSON.stringify(detail)}`,
    );
  }
}, 60 * 1000).unref();

if (BRIDGE_AUTH_MODE === "legacy_shared_token") {
  console.warn(
    "[bridge] warning: bridge-secret.txt not found; using legacy shared token. Run node mint-token.mjs to separate credentials.",
  );
}

if (!Number.isInteger(LISTEN_PORT) || LISTEN_PORT < 1 || LISTEN_PORT > 65535) {
  console.error("[bridge] 端口无效：" + LISTEN_PORT);
  process.exit(2);
}

let engineBase = ENGINE_URL || null;
let discoveryPromise = null;

function parseTasklist(text) {
  const pids = new Set();
  const processPattern = new RegExp(
    "^" +
      PROCESS_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "$",
    "i",
  );

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)","(\d+)"/);
    if (match && processPattern.test(match[1])) pids.add(match[2]);
  }
  return pids;
}

/**
 * 只返回明确属于 MiMo 桌面进程的端口。
 * 不再扫描或请求其他本地监听端口，避免向无关进程发送 bearer token。
 */
const execFileAsync = promisify(execFile);
const PROCESS_SCAN_OPTIONS = {
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
  windowsHide: true,
};
const PROCESS_PID_CACHE_MS = 5000;
let mimoPidCache = { at: 0, pids: new Set() };

/** MiMo 桌面进程的 PID 集合在进程存活期间不变，短 TTL 缓存足以省掉一次 tasklist。 */
async function mimoProcessPids() {
  if (Date.now() - mimoPidCache.at < PROCESS_PID_CACHE_MS) {
    return mimoPidCache.pids;
  }
  const tasklist = await execFileAsync(
    "tasklist",
    ["/FO", "CSV", "/NH"],
    PROCESS_SCAN_OPTIONS,
  );
  const pids = parseTasklist(tasklist.stdout);
  mimoPidCache = { at: Date.now(), pids };
  return pids;
}

async function candidatePorts() {
  if (ENGINE_URL) return [];

  try {
    // 两个子进程并行跑，且都不阻塞事件循环：重试路径会强制重新发现引擎，
    // 同步 execFileSync 会让这段时间内所有在飞的 SSE 流一起卡住。
    const [netstat, mimoPids] = await Promise.all([
      execFileAsync("netstat", ["-ano", "-p", "TCP"], PROCESS_SCAN_OPTIONS),
      mimoProcessPids(),
    ]);
    if (!mimoPids.size) return [];

    const ports = new Set();
    for (const line of netstat.stdout.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const columns = line.trim().split(/\s+/);
      if (columns.length < 5) continue;

      const local = columns[1];
      const pid = columns[columns.length - 1];
      if (!mimoPids.has(pid)) continue;

      const match = local.match(/:(\d+)$/);
      const port = match ? Number(match[1]) : 0;
      if (port > 0 && port !== LISTEN_PORT) ports.add(port);
    }
    return [...ports];
  } catch (error) {
    if (DEBUG) {
      console.warn(
        "[bridge] 无法读取 MiMo 进程端口：" + String(error?.message ?? error),
      );
    }
    return [];
  }
}

async function probe(port) {
  const url =
    `http://127.0.0.1:${port}/v1/models` +
    `?directory=${encodeURIComponent(INSTANCE_DIR)}`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + TOKEN },
      signal: AbortSignal.timeout(2000),
    });
    if (response.status !== 200) return false;
    const payload = await response.json().catch(() => null);
    return (
      !!payload &&
      Array.isArray(payload.data) &&
      payload.data.some((model) => {
        const id = String(model?.id || "");
        return id.startsWith("xiaomi/") || id.startsWith("mimo-desktop/");
      })
    );
  } catch {
    return false;
  }
}

async function discoverEngine(force = false) {
  if (ENGINE_URL) return ENGINE_URL;
  if (engineBase && !force) return engineBase;
  if (discoveryPromise && !force) return discoveryPromise;

  discoveryPromise = (async () => {
    const ports = await candidatePorts();
    const checked = await Promise.all(
      ports.map(async (port) => ({
        port,
        valid: await probe(port),
      })),
    );
    const valid = checked.filter((item) => item.valid);

    if (!valid.length) {
      engineBase = null;
      metrics.observeEngineDiscovery(false);
      return null;
    }

    if (valid.length > 1) {
      console.warn(
        `[bridge] 发现多个 MiMo 候选端口，使用 ${valid[0].port}：` +
          valid.map((item) => item.port).join(", "),
      );
    }

    const nextEngine = `http://127.0.0.1:${valid[0].port}`;
    const changed = Boolean(engineBase && engineBase !== nextEngine);
    engineBase = nextEngine;
    metrics.observeEngineDiscovery(changed);
    console.log(`[bridge] engine found at ${engineBase}`);
    return engineBase;
  })().finally(() => {
    discoveryPromise = null;
  });

  return discoveryPromise;
}

function upstreamUrl(base, requestPath, keepQuery = true) {
  const url = new URL(base + requestPath);
  if (isMimoUpstream()) {
    url.searchParams.set("directory", INSTANCE_DIR);
  }

  if (keepQuery) {
    const incoming = new URL(requestPath, "http://bridge.local").searchParams;
    for (const [key, value] of incoming) {
      if (key !== "directory") url.searchParams.set(key, value);
    }
  }
  return url;
}

/**
 * 认一下这条请求是谁发的：优先看 agent 自己带的标识头，再看 UA。
 * 不套模板——不认识就原样回 UA 前缀，总比写死"Codex"强。
 */
function detectClient(headers) {
  const pick = ["originator", "x-client-name", "x-app", "x-title", "user-agent"]
    .map((k) => String(headers[k] || ""))
    .join(" ")
    .toLowerCase();
  if (!pick.trim()) return "未知客户端";
  if (pick.includes("deepseek harness") || /\bdsh\b/.test(pick) || pick.includes("deepseek")) return "DSH";
  if (pick.includes("codex")) return "Codex";
  if (pick.includes("claude")) return "Claude Code";
  if (pick.includes("gemini")) return "Gemini CLI";
  if (pick.includes("cursor")) return "Cursor";
  if (pick.includes("opencode")) return "OpenCode";
  if (pick.includes("cherry")) return "Cherry Studio";
  if (pick.includes("openai-python") || pick.includes("openai/")) return "OpenAI SDK";
  if (pick.includes("python")) return "Python 客户端";
  if (pick.includes("node") || pick.includes("undici")) return "Node 客户端";
  if (pick.includes("curl")) return "curl";
  return String(headers["user-agent"] || "未知客户端").slice(0, 28);
}

function createAbortContext(externalSignals, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const signals = (
    Array.isArray(externalSignals) ? externalSignals : [externalSignals]
  ).filter(Boolean);

  const controller = new AbortController();
  const listeners = [];
  let cause = null;

  const abortWith = (reason) => {
    if (controller.signal.aborted) return;
    cause = reason;
    controller.abort(reason);
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abortWith(signal.reason ?? new Error("request aborted"));
      continue;
    }
    const listener = () =>
      abortWith(signal.reason ?? new Error("request aborted"));
    signal.addEventListener("abort", listener, { once: true });
    listeners.push([signal, listener]);
  }

  const timer = setTimeout(() => {
    abortWith(new Error(`upstream timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    get cause() {
      return cause;
    },
    abort(reason) {
      abortWith(reason);
    },
    dispose() {
      clearTimeout(timer);
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
      listeners.length = 0;
    },
  };
}

/**
 * 流式看门狗：首包超时 + 包间空闲超时。
 * 超时会 abort 上游请求，并回调 onTimeout(kind, error)。
 */
function createStreamWatchdog(abortContext, onTimeout) {
  let timer = null;
  let firstDone = false;
  let stopped = false;

  const arm = (ms, kind) => {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => {
      if (stopped) return;
      stopped = true;
      const error = new Error(
        kind === "first_token"
          ? `upstream produced no data within ${FIRST_TOKEN_TIMEOUT_MS}ms`
          : `upstream stream idle for ${STREAM_IDLE_TIMEOUT_MS}ms`,
      );
      error.code = kind;
      console.error(`[bridge] stream watchdog ${kind}: ${error.message}`);
      try {
        onTimeout?.(kind, error);
      } catch {}
      abortContext.abort(error);
    }, ms);
  };

  return {
    start() {
      firstDone = false;
      stopped = false;
      console.error(`[bridge] stream watchdog armed first=${FIRST_TOKEN_TIMEOUT_MS}ms idle=${STREAM_IDLE_TIMEOUT_MS}ms`);
      arm(FIRST_TOKEN_TIMEOUT_MS, "first_token");
    },
    touch() {
      if (stopped) return;
      firstDone = true;
      arm(STREAM_IDLE_TIMEOUT_MS, "idle");
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

async function readBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let length = 0;

  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) {
      const error = new Error(`request body exceeds ${maxBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, payload, requestId) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(requestId ? { "X-Request-ID": requestId } : {}),
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message, requestId, type = "bridge_error") {
  metrics.observeError(type);
  sendJson(res, status, { error: { message, type } }, requestId);
}

function sendAnthropicError(res, status, message, requestId, type = "invalid_request_error") {
  metrics.observeError(type);
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(requestId ? { "X-Request-ID": requestId } : {}),
  });
  res.end(JSON.stringify(anthropicErrorPayload(message, type)));
}

/**
 * 先哈希再比较：既避免 === 的提前返回带来计时侧信道，
 * 也避免因长度不同而泄露 secret 长度。
 */
function secretEquals(candidate, expected) {
  if (typeof candidate !== "string" || !candidate) return false;
  const left = crypto.createHash("sha256").update(candidate).digest();
  const right = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(left, right);
}

function isBridgeAuthorized(request) {
  const authorization = request.headers.authorization || "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  return (
    secretEquals(bearer, BRIDGE_SECRET) ||
    secretEquals(request.headers["x-api-key"], BRIDGE_SECRET)
  );
}

function normalizeModel(body) {
  if (
    body &&
    typeof body === "object" &&
    typeof body.model === "string" &&
    MODEL_PREFIX &&
    MODEL_PREFIX !== "off" &&
    !body.model.includes("/") &&
    !body.model.includes(":")
  ) {
    body.model = `${MODEL_PREFIX}/${body.model}`;
  }
}

function debugLog(entry) {
  if (!DEBUG) return;
  const safeEntry = { at: new Date().toISOString(), ...entry };
  if (!DEBUG_INCLUDE_BODY) delete safeEntry.body;
  try {
    fs.appendFileSync(DEBUG_FILE, JSON.stringify(safeEntry) + "\n");
  } catch {}
}

// 引擎上真正可用的是 mimo-desktop/* 订阅模型；列表里的 xiaomi/* 走云端、
// 需要小米 API Key，桌面 token 调用会报 Invalid API Key。
// 桌面端选择器里可能仍显示官方模型，或用户手填了别的名字：把这些
// "引擎上没有的模型"兜底映射到一个可用模型，而不是直接 404。
// 用 MIMO_BRIDGE_MODEL_FALLBACK=off 可关闭。
let knownModels = null;
let knownModelsFetchedAt = 0;
async function fetchKnownModels(base) {
  if (knownModels && Date.now() - knownModelsFetchedAt < 60000) return knownModels;
  try {
    const url = new URL(base + "/v1/models");
    if (isMimoUpstream()) {
      url.searchParams.set("directory", INSTANCE_DIR);
    }
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + (currentRoute()?.token || TOKEN) },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return knownModels;
    const payload = await response.json();
    const ids = (payload?.data ?? []).map((model) => String(model?.id ?? "")).filter(Boolean);
    if (ids.length) {
      knownModels = new Set(ids);
      knownModelsFetchedAt = Date.now();
    }
  } catch {}
  return knownModels;
}

// 兜底顺序：显式配置的 MODEL_FALLBACK，然后引擎上任意一个桌面端对话模型。
// 这样 MiMo Desktop 下次升级改名也不会再把请求打到不存在的模型上。
const FALLBACK_CANDIDATES = [
  MODEL_FALLBACK,
  "mimo-desktop/mimo-v2.6-pro",
  "mimo-desktop/mimo-v2.6-flash",
  "mimo-desktop/mimo-pro",
  "mimo-desktop/mimo-flash",
  "mimo-desktop/mimo-auto",
];

function pickFallbackModel(known) {
  for (const candidate of FALLBACK_CANDIDATES) {
    if (candidate && candidate !== "off" && known.has(candidate)) return candidate;
  }
  for (const id of known) {
    if (
      !/asr|tts/i.test(id) &&
      (id.startsWith("mimo-desktop/") ||
        // workbuddy 模型带 cn:/global: 域前缀，trae 模型是裸 ID（glm-5.2 等）
        (PASSTHROUGH_UPSTREAM &&
          (UPSTREAM_KIND !== "workbuddy" || id.includes(":"))))
    ) {
      return id;
    }
  }
  if (PASSTHROUGH_UPSTREAM) {
    for (const id of known) {
      if (!/asr|tts/i.test(id)) return id;
    }
  }
  return null;
}

async function applyModelFallback(base, chatBody) {
  if (RAW_CHAT || MODEL_FALLBACK === "off" || !chatBody?.model) return;
  const known = await fetchKnownModels(base);
  if (!known || known.size === 0) return;
  if (known.has(chatBody.model)) return;
  const requested = chatBody.model;
  const fallback = pickFallbackModel(known);
  if (!fallback) return;
  chatBody.model = fallback;
  debugLog({ event: "model_fallback", from: requested, to: fallback });
  console.error(
    `[bridge] model "${requested}" is not on the upstream; falling back to ${fallback}`,
  );
}

// 引擎 400「不支持 reasoning_effort」的适配若每个请求都重新试一遍，
// 每次都白付一个往返（26.922 后期引擎更新后 v2.6 系列不再接受该参数，
// 实测每个请求都触发）。按模型记住拒绝结论；TTL 兜底，引擎升级后
// 能力可能恢复。
const EFFORT_REJECTION_TTL_MS = 10 * 60 * 1000;
const effortRejectionByModel = new Map();

const MI_MO_REASONING_OFF = new Set([
  "none",
  "minimal",
  "off",
  "false",
  "disabled",
]);

// MiMo Desktop 的 reasoning 能力是 toggle：只有思考开 / 思考关，
// 不接受 Codex 的多档 effort。这里统一把任意非关闭档位压成 high，
// 关闭档位直接删除字段，避免把 unsupported effort 发给上游。
function normalizeMiMoReasoningToggle(chatBody) {
  if (!chatBody || !Object.hasOwn(chatBody, "reasoning_effort")) return;
  const raw = chatBody.reasoning_effort;
  const normalized =
    raw === true ? "high" : String(raw ?? "").trim().toLowerCase();
  const enabled = raw !== false && raw !== null && !MI_MO_REASONING_OFF.has(normalized);
  if (!enabled) {
    delete chatBody.reasoning_effort;
  } else {
    chatBody.reasoning_effort = "high";
  }
  debugLog({
    event: "mimo_reasoning_toggle",
    model: chatBody.model,
    enabled,
  });
}

function stripRejectedReasoningEffort(chatBody) {
  if (RAW_CHAT) return;
  if (!chatBody || !Object.hasOwn(chatBody, "reasoning_effort")) return;
  const memo = effortRejectionByModel.get(chatBody.model);
  if (memo && Date.now() - memo.at < EFFORT_REJECTION_TTL_MS) {
    delete chatBody.reasoning_effort;
    debugLog({
      event: "reasoning_effort_stripped_from_memo",
      model: chatBody.model,
    });
  }
}

/**
 * 上游没给 usage 时的本地估算（启发式，非精确值）。
 * 返回标准 usage 形状；无法估算或功能关闭时返回 null。
 */
function estimatedUsageFor(chatBody, chatPayload) {
  if (!TOKEN_ESTIMATE_ENABLED) return null;
  const inputTokens = estimateChatRequestTokens(chatBody);
  const outputTokens = estimateChatResponseTokens(chatPayload);
  if (inputTokens + outputTokens <= 0) return null;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}

/** 有真实 usage 就记真实值，否则补估算值；两者在指标里分开统计。 */
function applyEstimatedUsage(response, chatBody, chatPayload) {
  if (hasRealUsage(response.usage)) {
    metrics.observeUsage(response.usage);
    return;
  }
  const estimated = estimatedUsageFor(chatBody, chatPayload);
  if (!estimated) {
    metrics.observeUsage(response.usage);
    return;
  }
  response.usage = estimated;
  metrics.observeEstimatedUsage(estimated);
  debugLog({ event: "usage_estimated", ...estimated });
}

function parseJsonBody(raw) {
  if (!raw.length) {
    const error = new Error("request body is empty");
    error.statusCode = 400;
    throw error;
  }

  try {
    const body = JSON.parse(raw.toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TypeError("request body must be a JSON object");
    }
    return body;
  } catch (error) {
    error.statusCode = 400;
    error.message = "invalid JSON body: " + error.message;
    throw error;
  }
}

async function readUpstreamError(upstream) {
  const payload = await upstream.json().catch(() => null);
  return (
    payload?.error?.message ??
    `upstream HTTP ${upstream.status} ${upstream.statusText || ""}`.trim()
  );
}

/**
 * 带上跨上游 failover 的 fetch：
 * 传输失败（连不上）、408/429/5xx 都算"这家答不了"，按路由顺序换下一家，
 * 直到拿到一个非重试类的响应，或者候选全部试完（把最后一个错误抛出去）。
 *
 * 只在多上游模式下走这条路；单上游模式仍走原来的"重发现 + 重试一次"。
 */
async function fetchUpstreamWithFailover({ urlFor, init, abortContext, requestId, accept, first, model, session }) {
  const tried = [];
  let route = first;
  let lastError = null;
  for (let round = 0; round < 8; round += 1) {
    if (!route || !route.base) throw lastError || new Error("没有可用上游");
    const context = currentRoute();
    if (context) {
      context.upstreamId = route.upstreamId;
      context.kind = route.kind;
      context.token = route.token;
      context.base = route.base;
      context.capabilities = route.capabilities;
      context.model = route.model;
    }
    let response;
    try {
      // init 可以是函数：换到路由组的另一家时，模型 ID 也得跟着换
      const requestInit = typeof init === "function" ? init(route) : init;
      response = await fetchUpstream(urlFor(route.base), requestInit, abortContext, requestId, accept);
    } catch (error) {
      lastError = error;
      tried.push(route.upstreamId);
      routing.noteResult(route.upstreamId, { error });
      debugLog({
        requestId,
        event: "route_failover",
        from: route.upstreamId,
        reason: String(error?.message ?? error),
      });
      const next = await routing.pick({ model, session, exclude: tried });
      if (!next.ok) throw error;
      route = next;
      continue;
    }

    routing.noteResult(route.upstreamId, { status: response.status });
    if (isRetryableStatus(response.status)) {
      tried.push(route.upstreamId);
      debugLog({
        requestId,
        event: "route_failover",
        from: route.upstreamId,
        reason: "status " + response.status,
      });
      const next = await routing.pick({ model, session, exclude: tried });
      if (next.ok) {
        response.body?.cancel?.().catch(() => {});
        route = next;
        continue;
      }
    }
    return { response, route };
  }
  throw lastError || new Error("上游全部试过仍失败");
}

async function fetchUpstream(
  target,
  init,
  abortContext,
  requestId,
  accept,
) {
  // fetch() 只在响应头到达后才 resolve。上游吞掉请求不回头时，必须有
  // 比总超时短得多的响应头限时，否则客户端会空等十分钟。
  const headerTimer = setTimeout(() => {
    const error = new Error(
      `upstream headers timeout after ${UPSTREAM_HEADER_TIMEOUT_MS}ms`,
    );
    error.code = "upstream_header_timeout";
    console.error(`[bridge] ${error.message} for ${target}`);
    metrics.observeError("upstream_header_timeout");
    abortContext.abort(error);
  }, UPSTREAM_HEADER_TIMEOUT_MS);

  try {
    return await fetch(target, {
      ...init,
      signal: abortContext.signal,
      headers: {
        Authorization: "Bearer " + (currentRoute()?.token || TOKEN),
        "Content-Type": "application/json",
        Accept: accept || "*/*",
        "X-Request-ID": requestId || "",
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(headerTimer);
  }
}


function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : String(part?.text ?? part?.content ?? ""),
      )
      .join("\n");
  }
  return "";
}

function responseToText(response) {
  return (response?.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text" || part.type === "refusal")
    .map((part) => String(part.text ?? part.refusal ?? ""))
    .join("\n");
}

function responseHasToolCall(response) {
  return (response?.output ?? []).some(
    (item) =>
      item.type === "function_call" || item.type === "custom_tool_call",
  );
}

function actionRequestText(chatBody) {
  const messages = chatBody?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return contentToText(messages[index].content);
    }
  }
  return "";
}

function looksLikeActionRequest(text) {
  return (
    /\b(commit|push|run|execute|fix|build|test|install|create|update|delete|restart|start|stop|apply|merge|rebase|deploy|open|launch|configure|generate)\b/i.test(
      text,
    ) ||
    /[提交推送运行执行修复构建测试安装创建更新删除重启启动停止应用合并部署打开启动配置生成]/.test(
      text,
    )
  );
}

function looksLikeActionIntent(text) {
  return (
    /(?:我会|我将|接下来|下一步|马上|现在|先|然后).{0,80}(?:执行|运行|检查|提交|推送|修复|创建|更新|删除|重启|启动|停止|应用|合并|部署|补回|回归|验证|整理|清理|纳入)/i.test(
      text,
    ) ||
    /\b(?:i will|i'll|next(?:,|:)?|let me|going to)\b.{0,100}\b(?:run|execute|commit|push|fix|build|test|install|create|update|delete|restart|start|stop|apply|merge|deploy|verify|clean|organize|include|finish)\b/i.test(
      text,
    )
  );
}

function shouldGuardToolCall(requestBody, chatBody, response) {
  return (
    (requestBody?.tools?.length || chatBody?.tools?.length) > 0 &&
    looksLikeActionRequest(actionRequestText(chatBody)) &&
    !responseHasToolCall(response) &&
    looksLikeActionIntent(responseToText(response))
  );
}

function buildToolRetryChatBody(chatBody, response) {
  const messages = [...(chatBody?.messages ?? [])];
  const text = responseToText(response);
  if (text) messages.push({ role: "assistant", content: text });
  messages.push({
    role: "system",
    content:
      "The previous assistant response described an immediate action but did not call a tool. " +
      "Continue the task now by calling one of the provided tools. " +
      "Do not respond with a plan-only message.",
  });
  return {
    ...chatBody,
    messages,
    tool_choice: "required",
    stream: false,
    stream_options: undefined,
  };
}

async function fetchToolRetryPayload({
  target,
  chatBody,
  response,
  requestId,
  abortContext,
}) {
  const retryBody = buildToolRetryChatBody(chatBody, response);
  const upstream = await fetchUpstream(
    target,
    {
      method: "POST",
      body: JSON.stringify(retryBody),
    },
    abortContext,
    requestId,
    "application/json",
  );
  if (!upstream.ok) return null;
  return upstream.json().catch(() => null);
}

async function proxyResponsesStream({
  req,
  res,
  upstream,
  requestBody,
  chatBody,
  requestId,
  abortContext,
  cancellation,
  metricState,
  upstreamTarget,
}) {
  const contentType = upstream.headers.get("content-type") || "";

  if (!contentType.includes("text/event-stream")) {
    const payload = await upstream.json().catch(() => null);
    if (!payload) {
      return sendError(
        res,
        502,
        "upstream returned an invalid streaming response",
        requestId,
      );
    }
    const response = toResponseObject(payload, requestBody);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Request-ID": requestId,
    });
    for (const evt of responseEvents(response)) await sseWrite(res, evt);
    res.end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Request-ID": requestId,
  });

  const guardActionResponse =
    (requestBody?.tools?.length || chatBody?.tools?.length) > 0 &&
    looksLikeActionRequest(actionRequestText(chatBody));
  const deferredEvents = [];
  const emitEvent = async (evt) => {
    if (guardActionResponse) deferredEvents.push(evt);
    else await sseWrite(res, evt);
  };

  const watchdog = createStreamWatchdog(abortContext, (kind, error) => {
    debugLog({
      requestId,
      event: "stream_watchdog",
      kind,
      message: String(error?.message ?? error),
    });
    metrics.observeError(
      kind === "first_token"
        ? "upstream_first_token_timeout"
        : "upstream_idle_timeout",
    );
    metrics.breaker.recordFailure();
  });
  watchdog.start();

  const translator = createResponseStreamTranslator(requestBody, {
    estimatedInputTokens: TOKEN_ESTIMATE_ENABLED
      ? estimateChatRequestTokens(chatBody)
      : 0,
  });
  for (const evt of translator.start()) await emitEvent(evt);

  // 响应 ID 在 response.created 里已经交给客户端，此时就可以登记，
  // 让 POST /v1/responses/{id}/cancel 有事可做。
  rememberResponse(translator.currentResponse(), cancellation);

  const parsedChunks = [];
  const parser = createSseParser((parsed) => {
    if (
      parsed.event === "error" ||
      parsed.data?.type === "error" ||
      parsed.data?.error
    ) {
      throw new Error(
        parsed.data?.error?.message ??
          parsed.data?.message ??
          "upstream SSE error",
      );
    }

    if (
      parsed.data &&
      typeof parsed.data === "object" &&
      (parsed.data.object === "chat.completion.chunk" || parsed.data.choices)
    ) {
      parsedChunks.push(parsed.data);
    }
  });

  try {
    for await (const rawChunk of upstream.body) {
      watchdog.touch();
      if (res.destroyed || abortContext.signal.aborted) {
        throw new Error("client disconnected");
      }

      parser.push(rawChunk);
      while (parsedChunks.length) {
        const chunk = parsedChunks.shift();
        const translated = translator.push(chunk);
        if (
          translated.some((evt) =>
            /_text\.delta|arguments\.delta|summary_text\.delta/.test(
              evt.event,
            ),
          )
        ) {
          metrics.observeFirstToken(
            metricState,
            Date.now() - metricState.startedAt,
          );
        }
        for (const evt of translated) await emitEvent(evt);
      }
    }
    watchdog.stop();
    parser.end();
    const completedEvents = translator.end();
    const completed = completedEvents
      .map((evt) => {
        try {
          return JSON.parse(evt.data);
        } catch {
          return null;
        }
      })
      .find((item) => item?.type === "response.completed");
    const finalResponse = completed?.response ?? translator.currentResponse();
    if (
      guardActionResponse &&
      shouldGuardToolCall(requestBody, chatBody, finalResponse)
    ) {
      debugLog({
        requestId,
        event: "tool_call_guard_triggered",
        text: responseToText(finalResponse).slice(0, 500),
      });
      const retryPayload = await fetchToolRetryPayload({
        target: upstreamTarget,
        chatBody,
        response: finalResponse,
        requestId,
        abortContext,
      });
      if (retryPayload) {
        const retryResponse = toResponseObject(retryPayload, requestBody);
        retryResponse.id = finalResponse.id;
        normalizeStructuredResponse(retryResponse, requestBody);
        rememberResponse(retryResponse, cancellation);
        if (retryResponse.usage?.total_tokens) {
          metrics.observeUsage(retryResponse.usage);
          noteUsage(retryResponse.usage);
        }
        for (const evt of responseEvents(retryResponse)) {
          await sseWrite(res, evt);
        }
        res.end();
        return;
      }
      debugLog({
        requestId,
        event: "tool_call_guard_retry_failed",
      });
    }

    if (finalResponse) {
      normalizeStructuredResponse(finalResponse, requestBody);
      rememberResponse(finalResponse, cancellation);
      if (translator.usageEstimated()) {
        metrics.observeEstimatedUsage(finalResponse.usage);
        noteUsage(finalResponse.usage, true);
      } else {
        metrics.observeUsage(finalResponse.usage);
        noteUsage(finalResponse.usage);
      }
    }
    for (const evt of [...deferredEvents, ...completedEvents]) {
      await sseWrite(res, evt);
    }
    res.end();
  } catch (error) {
    watchdog.stop();
    debugLog({
      requestId,
      path: req.url,
      streamError: String(error?.message ?? error),
      abortCause: String(abortContext.cause?.message ?? abortContext.cause ?? ""),
    });

    // 主动取消不是故障：不发 response.failed，也不记熔断失败。
    if (cancellation.signal.aborted) {
      if (!res.writableEnded) {
        try {
          for (const evt of translator.cancel()) await sseWrite(res, evt);
        } catch {}
        res.end();
      }
      return;
    }

    if (!abortContext.signal.aborted && !res.destroyed) {
      metrics.observeError("stream_interrupted");
      metrics.breaker.recordFailure();
    }
    if (!res.writableEnded) {
      try {
        for (const evt of translator.fail(error)) await sseWrite(res, evt);
      } catch {}
      res.end();
    }
  }
}

async function proxyAnthropicStream({
  res,
  upstream,
  requestBody,
  chatBody,
  requestId,
  abortContext,
  cancellation,
  metricState,
}) {
  const contentType = upstream.headers.get("content-type") || "";

  if (!contentType.includes("text/event-stream")) {
    const payload = await upstream.json().catch(() => null);
    if (!payload) {
      return sendAnthropicError(
        res,
        502,
        "upstream returned an invalid streaming response",
        requestId,
        "api_error",
      );
    }
    const message = toAnthropicMessage(payload, requestBody, {
      estimateMissingUsage: TOKEN_ESTIMATE_ENABLED,
      estimatedInputTokens: TOKEN_ESTIMATE_ENABLED
        ? estimateChatRequestTokens(chatBody)
        : 0,
    });
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Request-ID": requestId,
    });
    const translator = createAnthropicStreamTranslator(requestBody, {
      estimatedInputTokens: message.usage?.input_tokens ?? 0,
    });
    for (const evt of translator.start()) await anthropicSseWrite(res, evt);
    for (const block of message.content ?? []) {
      if (block.type === "text") {
        const pushed = translator.push({
          choices: [{ delta: { content: block.text } }],
        });
        for (const evt of pushed) await anthropicSseWrite(res, evt);
      } else if (block.type === "tool_use") {
        const pushed = translator.push({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: block.id,
                    function: {
                      name: block.name,
                      arguments: JSON.stringify(block.input ?? {}),
                    },
                  },
                ],
              },
            },
          ],
        });
        for (const evt of pushed) await anthropicSseWrite(res, evt);
      }
    }
    for (const evt of translator.end()) await anthropicSseWrite(res, evt);
    res.end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Request-ID": requestId,
  });

  // 看门狗必须在任何 await 写之前武装：否则首帧写入若因背压/客户端
  // 异常挂住，超时逻辑永远不会启动，请求会一直悬到总超时。
  const watchdog = createStreamWatchdog(abortContext, (kind, error) => {
    debugLog({
      requestId,
      event: "stream_watchdog",
      kind,
      message: String(error?.message ?? error),
    });
    metrics.observeError(
      kind === "first_token"
        ? "upstream_first_token_timeout"
        : "upstream_idle_timeout",
    );
    metrics.breaker.recordFailure();
  });
  watchdog.start();

  const translator = createAnthropicStreamTranslator(requestBody, {
    estimatedInputTokens: TOKEN_ESTIMATE_ENABLED
      ? estimateChatRequestTokens(chatBody)
      : 0,
    estimateMissingUsage: TOKEN_ESTIMATE_ENABLED,
  });
  for (const evt of translator.start()) await anthropicSseWrite(res, evt);

  const parsedChunks = [];
  const parser = createSseParser((parsed) => {
    if (
      parsed.event === "error" ||
      parsed.data?.type === "error" ||
      parsed.data?.error
    ) {
      throw new Error(
        parsed.data?.error?.message ??
          parsed.data?.message ??
          "upstream SSE error",
      );
    }
    if (
      parsed.data &&
      typeof parsed.data === "object" &&
      (parsed.data.object === "chat.completion.chunk" || parsed.data.choices)
    ) {
      parsedChunks.push(parsed.data);
    }
  });

  try {
    for await (const rawChunk of upstream.body) {
      watchdog.touch();
      if (res.destroyed || abortContext.signal.aborted) {
        throw abortContext.cause ?? new Error("client disconnected");
      }
      parser.push(rawChunk);
      while (parsedChunks.length) {
        const chunk = parsedChunks.shift();
        const translated = translator.push(chunk);
        if (translated.some((evt) => evt.event === "content_block_delta")) {
          metrics.observeFirstToken(
            metricState,
            metricState ? Date.now() - metricState.startedAt : 0,
          );
        }
        for (const evt of translated) await anthropicSseWrite(res, evt);
      }
    }
    watchdog.stop();
    parser.end();
    for (const evt of translator.end()) await anthropicSseWrite(res, evt);
    res.end();
  } catch (error) {
    watchdog.stop();
    debugLog({
      requestId,
      path: "/v1/messages",
      streamError: String(error?.message ?? error),
      abortCause: String(abortContext.cause?.message ?? abortContext.cause ?? ""),
    });

    if (cancellation.signal.aborted) {
      if (!res.writableEnded) {
        try {
          for (const evt of translator.cancel()) {
            await anthropicSseWrite(res, evt);
          }
        } catch {}
        res.end();
      }
      return;
    }

    if (!abortContext.signal.aborted && !res.destroyed) {
      metrics.observeError("stream_interrupted");
      metrics.breaker.recordFailure();
    }
    if (!res.writableEnded) {
      try {
        for (const evt of translator.fail(error?.message ?? error)) {
          await anthropicSseWrite(res, evt);
        }
      } catch {}
      res.end();
    }
  }
}

// trae 上游 usage 的缓存字段是 Anthropic 风格（cache_read_input_tokens /
// reasoning_tokens 顶层平铺），OpenAI 客户端读的是 prompt_tokens_details.cached_tokens
// 和 completion_tokens_details.reasoning_tokens，不转就永远显示不出缓存命中。
// trae2api p2 之后上游已自带 OpenAI 风格字段，这里只在缺失时补，绝不覆盖。
function decorateUpstreamUsage(usage, { fillZero = false } = {}) {
  if (!usage || typeof usage !== "object") return usage;
  const next = { ...usage };
  const cacheRead = Number(usage.cache_read_input_tokens);
  const reasoning = Number(usage.reasoning_tokens);
  if (usage.cache_read_input_tokens !== undefined || fillZero) {
    const details = { ...(next.prompt_tokens_details ?? {}) };
    if (details.cached_tokens === undefined) {
      details.cached_tokens =
        Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead : 0;
    }
    next.prompt_tokens_details = details;
  }
  if (
    Number.isFinite(reasoning) &&
    reasoning > 0 &&
    next.completion_tokens_details?.reasoning_tokens === undefined
  ) {
    next.completion_tokens_details = {
      ...(next.completion_tokens_details ?? {}),
      reasoning_tokens: reasoning,
    };
  }
  return next;
}

// /v1/models 的 trae 补齐：过滤内部 subagent（custom_model_* 是用户自定义槽位，
// 保留），并在 trae2api 未补齐字段时兜底加上下文窗口别名与最大输出数。
// trae2api p2 之后这些字段上游已自带，这里全部只在缺失时补。
function enrichTraeModelsList(payload) {
  if (!Array.isArray(payload?.data)) return payload;
  payload.data = payload.data.filter((model) => {
    const id = String(model?.id ?? "");
    return !!id && !TRAE_INTERNAL_MODELS.has(id);
  });
  for (const model of payload.data) {
    const contextLength = Number(model.context_length) || 0;
    if (contextLength > 0) {
      // 字段别名矩阵：trae2api p3 起上游已自带全套；这里只在缺失时兜底
      // （客户端直连桥、或上游旧版时会走到）。
      if (model.context_window === undefined) model.context_window = contextLength;
      if (model.contextWindow === undefined) model.contextWindow = contextLength;
      if (model.max_input_tokens === undefined) model.max_input_tokens = contextLength;
    }
    const maxOutput =
      TRAE_MAX_OUTPUT_OVERRIDES[String(model.id).toLowerCase()] ??
      TRAE_DEFAULT_MAX_OUTPUT;
    if (model.max_tokens === undefined) model.max_tokens = maxOutput;
    if (model.max_completion_tokens === undefined) {
      model.max_completion_tokens = maxOutput;
    }
    if (model.max_output_tokens === undefined) {
      model.max_output_tokens = maxOutput;
    }
    if (model.maxOutputTokens === undefined) model.maxOutputTokens = maxOutput;
    if (model.top_provider === undefined) {
      model.top_provider = {
        context_length: contextLength,
        max_completion_tokens: maxOutput,
      };
    }
  }
  return payload;
}

// GET /v1/models：拉上游列表，trae 上游补齐元数据后下发。原先是原样透传，
// 客户端只能拿到 context_length，最大输出数一概没有。
/**
 * 多上游模式下的模型列表：把每家的 /v1/models 合成一份，模型 ID 加上游前缀，
 * 路由组以 group/<id> 出现在列表里。某一家挂了不影响其它家（只在 bridge_upstreams 里说明）。
 */
async function handleModelsListAll(req, res, requestId) {
  routing.reload();
  const registry = routing.registry;
  if (!registry) {
    return sendError(res, 503, "upstreams.json 未就绪", requestId, "route_unavailable");
  }

  const hidden = new Set();
  for (const group of registry.groups.values()) {
    if (group.listed) continue;
    for (const model of group.models) hidden.add(model);
  }

  const data = [];
  const upstreamErrors = [];
  for (const upstream of registry.upstreams.values()) {
    let base = "";
    try {
      base = upstream.kind === "mimo" ? await discoverEngine() : upstream.base;
    } catch {
      base = "";
    }
    if (!base) {
      upstreamErrors.push({ upstream: upstream.id, error: "未就绪" });
      continue;
    }
    const token = readUpstreamToken(path.resolve(import.meta.dirname, upstream.tokenFile));
    const url = new URL(base + "/v1/models");
    if (upstream.kind === "mimo") url.searchParams.set("directory", INSTANCE_DIR);
    try {
      const response = await fetch(url, {
        headers: { Authorization: "Bearer " + (token || TOKEN) },
        signal: AbortSignal.timeout(5000),
      });
      const payload = await response.json().catch(() => null);
      if (!payload || !Array.isArray(payload.data)) {
        upstreamErrors.push({ upstream: upstream.id, error: "invalid upstream JSON" });
        continue;
      }
      if (upstream.kind === "trae") enrichTraeModelsList(payload);
      for (const item of payload.data) {
        const id = String(item?.id ?? "");
        if (!id) continue;
        const full = upstream.id + "/" + id;
        if (hidden.has(full)) continue;
        data.push({ ...item, id: full, owned_by: item.owned_by || upstream.id });
      }
    } catch (error) {
      upstreamErrors.push({ upstream: upstream.id, error: String(error?.message ?? error) });
    }
  }

  for (const group of registry.groups.values()) {
    data.push({
      id: "group/" + group.id,
      object: "model",
      created: 0,
      owned_by: "bridge",
      bridge_group_models: group.models,
      bridge_routing: group.routing,
    });
  }

  return sendJson(res, 200, { object: "list", data, bridge_upstreams: upstreamErrors }, requestId);
}

async function handleModelsList(req, res, requestId) {
  if (routing.enabled) return handleModelsListAll(req, res, requestId);
  const base = await discoverEngine();
  if (!base) {
    return sendError(
      res,
      503,
      PASSTHROUGH_UPSTREAM
        ? `${UPSTREAM_KIND} gateway not found; start it on the configured upstream URL`
        : "MiMo Desktop engine not found",
      requestId,
    );
  }
  const url = new URL(base + "/v1/models");
  if (isMimoUpstream()) {
    url.searchParams.set("directory", INSTANCE_DIR);
  }
  const abortContext = createAbortContext();
  let upstream;
  try {
    upstream = await fetchUpstream(
      url,
      { method: "GET" },
      abortContext,
      requestId,
      req.headers.accept || "*/*",
    );
  } catch (error) {
    abortContext.dispose();
    return sendError(
      res,
      502,
      "upstream failed: " + String(error?.message ?? error),
      requestId,
      "upstream_transport",
    );
  }
  abortContext.dispose();
  if (!upstream.ok) {
    const message = await readUpstreamError(upstream);
    return sendError(res, upstream.status, message, requestId);
  }
  const payload = await upstream.json().catch(() => null);
  if (!payload || !Array.isArray(payload.data)) {
    metrics.observeError("invalid_upstream_response");
    return sendError(
      res,
      502,
      "upstream returned invalid JSON",
      requestId,
      "invalid_upstream_response",
    );
  }
  if (UPSTREAM_KIND === "trae") enrichTraeModelsList(payload);
  return sendJson(res, 200, payload, requestId);
}

// SSE 的 data: 行里若带 usage（通常是最后一个 chunk），转成 OpenAI 风格缓存字段。
function decorateSseDataLine(line) {
  if (!line.startsWith("data:")) return line;
  const data = line.slice(5).trimStart();
  if (!data || data === "[DONE]") return line;
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object" && parsed.usage) {
      parsed.usage = decorateUpstreamUsage(parsed.usage, { fillZero: true });
      return "data: " + JSON.stringify(parsed);
    }
  } catch {}
  return line;
}

// 普通 /v1/chat/completions 的透传：流式/非流式两个形态都把 usage 里的
// Anthropic 风格缓存字段换成 OpenAI 风格，客户端才能显示缓存命中。
async function proxyChatUpstream({ req, res, upstream, requestId }) {
  if (UPSTREAM_KIND !== "trae") {
    return proxyPassThrough({ req, res, upstream, requestId });
  }
  const contentType =
    upstream.headers.get("content-type") || "application/json; charset=utf-8";

  if (/text\/event-stream/i.test(contentType)) {
    res.writeHead(upstream.status, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Request-ID": requestId,
    });
    const upstreamRequestId = upstream.headers.get("x-request-id");
    if (upstreamRequestId) res.setHeader("X-Upstream-Request-ID", upstreamRequestId);
    let pending = "";
    try {
      for await (const chunk of upstream.body) {
        if (res.destroyed) break;
        pending += Buffer.from(chunk).toString("utf8");
        let newlineAt;
        while ((newlineAt = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newlineAt);
          pending = pending.slice(newlineAt + 1);
          res.write(decorateSseDataLine(line) + "\n");
        }
      }
      if (pending) res.write(decorateSseDataLine(pending));
    } finally {
      res.end();
    }
    return;
  }

  const payload = await upstream.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    metrics.observeError("invalid_upstream_response");
    return sendError(
      res,
      502,
      "upstream returned invalid JSON",
      requestId,
      "invalid_upstream_response",
    );
  }
  if (payload.usage) {
    payload.usage = decorateUpstreamUsage(payload.usage, { fillZero: true });
    noteUsage(payload.usage);
  } else if (TOKEN_ESTIMATE_ENABLED) {
    const estimated = estimatedUsageFor(chatBodyForUsage || {}, payload);
    if (estimated) {
      payload.usage = {
        prompt_tokens: estimated.prompt_tokens,
        completion_tokens: estimated.completion_tokens,
        total_tokens: estimated.total_tokens,
      };
      metrics.observeEstimatedUsage(estimated);
      noteUsage(payload.usage, true);
    }
  }
  return sendJson(res, upstream.status, payload, requestId);
}

async function proxyPassThrough({
  req,
  res,
  upstream,
  requestId,
}) {
  const headers = {
    "Content-Type":
      upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Request-ID": requestId,
  };
  const upstreamRequestId = upstream.headers.get("x-request-id");
  if (upstreamRequestId) headers["X-Upstream-Request-ID"] = upstreamRequestId;

  if (!upstream.body) {
    res.writeHead(upstream.status, headers);
    res.end();
    return;
  }

  // 非流式的 JSON 可以顺手读出来统计 usage；流式的必须逐 chunk 透传，不动它
  const contentType = String(headers["Content-Type"] || "");
  if (!/text\/event-stream/i.test(contentType)) {
    const chunks = [];
    for await (const chunk of upstream.body) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const text = raw.toString("utf8");
    try {
      const payload = JSON.parse(text);
      if (payload && payload.usage) {
        noteUsage(payload.usage);
        metrics.observeUsage(payload.usage);
      } else if (payload && TOKEN_ESTIMATE_ENABLED) {
        const estimated = estimatedUsageFor(chatBodyForUsage || {}, payload);
        if (estimated) {
          metrics.observeEstimatedUsage(estimated);
          noteUsage({ prompt_tokens: estimated.prompt_tokens, completion_tokens: estimated.completion_tokens, total_tokens: estimated.total_tokens }, true);
        }
      }
    } catch { /* 不是 JSON 就原样转发 */ }
    res.writeHead(upstream.status, { ...headers, "Content-Length": String(raw.length) });
    res.end(raw);
    return;
  }

  res.writeHead(upstream.status, headers);
  try {
    for await (const chunk of upstream.body) {
      if (res.destroyed) break;
      res.write(Buffer.from(chunk));
    }
  } finally {
    res.end();
  }
}

async function handleApiRequest(req, res, metricState = null) {
  const requestId =
    String(req.headers["x-request-id"] || "") ||
    "bridge_" + Math.random().toString(36).slice(2) + Date.now().toString(36);

  const requestUrl = new URL(req.url || "/", "http://bridge.local");
  const requestPath = requestUrl.pathname;

  if (req.method === "GET" && requestPath === "/health") {
    const base = await discoverEngine();
    return sendJson(
      res,
      200,
      {
        ok: !!base,
        upstreamKind: UPSTREAM_KIND,
        chatMode: CHAT_MODE,
        engine: base,
        instanceDir: INSTANCE_DIR,
        streaming: true,
        authenticatedApi: true,
        authMode: BRIDGE_AUTH_MODE,
        protocols: {
          responses: true,
          chat_completions: true,
          anthropic_messages: true,
          anthropic_count_tokens: true,
        },
      },
      requestId,
    );
  }

  if (
    req.method === "GET" &&
    (requestPath === "/status" || requestPath === "/metrics")
  ) {
    if (!isBridgeAuthorized(req)) {
      return sendError(
        res,
        401,
        "missing or invalid bridge secret",
        requestId,
        "invalid_api_key",
      );
    }

    const snapshot = metrics.snapshot();
    if (requestPath === "/metrics") {
      return sendJson(
        res,
        200,
        {
          engine: engineBase,
          breaker: snapshot.upstream.breaker,
          response_state: responseStore.snapshot(),
          ...snapshot,
        },
        requestId,
      );
    }

    const base = await discoverEngine();
    return sendJson(
      res,
      200,
      {
        ok: !!base,
        upstreamKind: UPSTREAM_KIND,
        chatMode: CHAT_MODE,
        pid: process.pid,
        version: BRIDGE_VERSION,
        node: process.version,
        platform: process.platform,
        engine: base,
        engineConfigured: Boolean(ENGINE_URL),
        instanceDir: INSTANCE_DIR,
        streaming: true,
        authMode: BRIDGE_AUTH_MODE,
        bridgeSecretConfigured: BRIDGE_AUTH_MODE === "bridge_secret",
        limits: {
          upstream_timeout_ms: UPSTREAM_TIMEOUT_MS,
          first_token_timeout_ms: FIRST_TOKEN_TIMEOUT_MS,
          stream_idle_timeout_ms: STREAM_IDLE_TIMEOUT_MS,
          max_body_bytes: MAX_BODY_BYTES,
          max_concurrent_requests: MAX_CONCURRENT_REQUESTS,
          response_state_ttl_ms: RESPONSE_STATE_TTL_MS,
          response_state_max: RESPONSE_STATE_MAX,
          response_state_file: responseStore.stateFile,
        },
        protocol: {
          responses_state: true,
          previous_response_id: true,
          response_retrieval: true,
          background_responses: true,
          response_cancellation: true,
          response_deletion: true,
          custom_tools: true,
          anthropic_messages: true,
          anthropic_count_tokens: true,
        },
        routing: routing.describe(),
        responseState: responseStore.snapshot(),
        metrics: snapshot,
      },
      requestId,
    );
  }

  if (!requestPath.startsWith("/v1/")) {
    return sendError(res, 404, `unsupported path ${requestPath}`, requestId);
  }

  const anthropicApi =
    requestPath === "/v1/messages" ||
    requestPath === "/v1/messages/count_tokens";
  const fail = (status, message, type = "invalid_request_error") =>
    anthropicApi
      ? sendAnthropicError(res, status, message, requestId, type)
      : sendError(res, status, message, requestId, type);

  if (!isBridgeAuthorized(req)) {
    return fail(
      401,
      "missing or invalid bridge bearer token",
      anthropicApi ? "authentication_error" : "invalid_api_key",
    );
  }

  const responseRoute = requestPath.match(
    /^\/v1\/responses\/([^/]+)(\/cancel)?$/,
  );
  if (responseRoute) {
    const responseId = decodeURIComponent(responseRoute[1]);
    const stored = responseStore.get(responseId);
    if (!stored) {
      return sendError(
        res,
        404,
        `response not found: ${responseId}`,
        requestId,
        "response_not_found",
      );
    }

    if (req.method === "GET" && !responseRoute[2]) {
      return sendJson(res, 200, stored, requestId);
    }

    if (req.method === "POST" && responseRoute[2]) {
      const record = responseStore.record(responseId);
      if (!["in_progress", "queued"].includes(record?.response?.status)) {
        return sendError(
          res,
          409,
          `response is not cancellable: ${record?.response?.status}`,
          requestId,
          "response_not_cancellable",
        );
      }
      responseStore.patch(responseId, {
        status: "cancelled",
        error: null,
      });
      record.controller?.abort(new Error("response cancelled"));
      return sendJson(
        res,
        200,
        responseStore.get(responseId),
        requestId,
      );
    }

    if (req.method === "DELETE" && !responseRoute[2]) {
      responseStore.delete(responseId);
      return sendJson(
        res,
        200,
        {
          id: responseId,
          object: "response.deleted",
          deleted: true,
        },
        requestId,
      );
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return sendError(
      res,
      405,
      `method ${req.method} is not supported for ${requestPath}`,
      requestId,
      "method_not_allowed",
    );
  }

  const isResponses = requestPath === "/v1/responses";
  const isAnthropicMessages = requestPath === "/v1/messages";
  const isAnthropicCount = requestPath === "/v1/messages/count_tokens";
  const supported =
    (isResponses ||
      isAnthropicMessages ||
      isAnthropicCount ||
      requestPath === "/v1/chat/completions") &&
      req.method === "POST" ||
    requestPath === "/v1/models" && req.method === "GET";

  if (!supported) {
    res.setHeader("Allow", "GET, POST");
    return fail(
      405,
      `method ${req.method} is not supported for ${requestPath}`,
      "method_not_allowed",
    );
  }

  if (metrics.breaker.open) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(metrics.breaker.retryAfterMs / 1000),
    );
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return fail(
      503,
      `MiMo upstream circuit is open; retry in ${retryAfterSeconds}s`,
      anthropicApi ? "overloaded_error" : "circuit_open",
    );
  }

  // 模型列表要按上游种类补元数据（trae 缺最大输出数/字段别名），单独走。
  if (req.method === "GET" && requestPath === "/v1/models") {
    return handleModelsList(req, res, requestId);
  }

  let body = {};
  if (req.method === "POST") {
    const raw = await readBody(req);
    try {
      body = parseJsonBody(raw);
    } catch (error) {
      if (isAnthropicMessages || isAnthropicCount) {
        return sendAnthropicError(
          res,
          error?.statusCode || 400,
          String(error?.message ?? error),
          requestId,
          error?.type || "invalid_request_error",
        );
      }
      throw error;
    }
    // 有路由表时模型 ID 由注册表决定（provider/model 或 group/id），
    // 不能再按启动参数里的 MODEL_PREFIX 去补前缀。
    if (!RAW_CHAT && !isAnthropicMessages && !isAnthropicCount && !routing.enabled) {
      normalizeModel(body);
    }

    if (!isResponses && !isAnthropicMessages && !isAnthropicCount && !RAW_CHAT) {
      for (const field of STRIP_FIELDS) delete body[field];
    }

    debugLog({
      requestId,
      path: requestPath,
      method: req.method,
      bytes: raw.length,
      model: body.model,
      stream: body.stream === true,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      body,
    });
  }

  // Anthropic count_tokens 用本地估算即可，不必打到上游。
  if (isAnthropicCount) {
    try {
      const probe = toChatRequestFromAnthropic(
        { ...body, stream: false, max_tokens: body.max_tokens ?? 1 },
        { mapThinkingToReasoning: false },
      );
      const inputTokens = TOKEN_ESTIMATE_ENABLED
        ? estimateChatRequestTokens(probe)
        : 0;
      return sendJson(res, 200, { input_tokens: inputTokens }, requestId);
    } catch (error) {
      return sendAnthropicError(
        res,
        error?.statusCode || 400,
        String(error?.message ?? error),
        requestId,
        error?.type || "invalid_request_error",
      );
    }
  }

  // ── 多上游：先决定这一跳问谁，再谈协议转换 ─────────────────────────────
  // 选完才做 toChatRequest：Anthropic/Responses 的转换要按上游能力走
  // （mapThinkingToReasoning、reasoning 开关归一化都看 isMimoUpstream()）。
  let selected = null;
  // routeKey 是"客户端要的那一个模型"（group/x 或 provider/model）。
  // 选中之后 body.model 会被改写成上游真实模型名，failover 再选的时候必须用 routeKey。
  let routeKey = "";
  if (routing.enabled && body && typeof body === "object" && body.model) {
    routing.reload();
    const previousMeta = body.previous_response_id
      ? responseStore.meta(body.previous_response_id)
      : null;
    const affinityKey = sessionKeyOf(body);
    routeKey = String(body.model);
    selected = await routing.pick({
      model: routeKey,
      pinned: previousMeta?.upstreamId
        ? { upstreamId: previousMeta.upstreamId, model: previousMeta.model }
        : undefined,
      session: { lastAnsweredId: previousMeta?.upstreamId || affinityFor(affinityKey) },
    });

    if (!selected.ok) {
      debugLog({ requestId, event: "route_failed", error: selected.error });
      return sendError(
        res,
        503,
        "route: " + String(selected.error || "没有可用上游"),
        requestId,
        "route_unavailable",
      );
    }

    const route = currentRoute();
    if (route) {
      route.upstreamId = selected.upstreamId;
      route.kind = selected.kind;
      route.token = selected.token;
      route.base = selected.base;
      route.capabilities = selected.capabilities;
      route.model = selected.model;
    }
    if (selected.model && body.model !== selected.model) body.model = selected.model;
    rememberAffinity(affinityKey, selected.upstreamId);
    metrics.setUpstream(metricState, selected.upstreamId);
    routing.noteDecision({
      model: routeKey,
      chosen: selected.upstreamId,
      order: selected.order,
      notes: selected.notes,
      pinned: Boolean(selected.pinned),
      reason: selected.reason,
    });
    debugLog({
      requestId,
      event: "route",
      upstream: selected.upstreamId,
      model: selected.model,
      reason: selected.reason,
      pinned: Boolean(selected.pinned),
      order: Array.isArray(selected.order) ? selected.order.map((item) => item.id) : [],
      notes: selected.notes,
    });
  }

  // 请求钩子（hooks/before-request.mjs）：只允许改白名单字段，出错/超时一律跳过。
  if (body && typeof body === "object") {
    const patch = await hooks.beforeRequest({
      requestId,
      path: requestPath,
      model: body.model,
      upstreamId: currentRoute()?.upstreamId || null,
      body,
    });
    if (patch && typeof patch === "object") {
      Object.assign(body, patch);
      debugLog({ requestId, event: "hook_patch", keys: Object.keys(patch) });
    }
  }

  metrics.setModel(metricState, body.model);
  metrics.setStream(metricState, body && body.stream === true);
  let chatBody = body;

  if (isAnthropicMessages) {
    try {
      chatBody = toChatRequestFromAnthropic(body, {
        mapThinkingToReasoning: isMimoUpstream(),
      });
    } catch (error) {
      return sendAnthropicError(
        res,
        error?.statusCode || 400,
        String(error?.message ?? error),
        requestId,
        error?.type || "invalid_request_error",
      );
    }
    if (!RAW_CHAT) normalizeModel(chatBody);
    if (isMimoUpstream() && isAnthropicMessages && body.thinking?.type === "enabled") {
      chatBody.reasoning_effort = "high";
    }
    if (isMimoUpstream()) normalizeMiMoReasoningToggle(chatBody);
    chatBody.stream = body.stream === true;
    if (chatBody.stream) {
      chatBody.stream_options = {
        ...(chatBody.stream_options || {}),
        include_usage: true,
      };
    }
  }

  if (isResponses) {
    const previousResponse = body.previous_response_id
      ? responseStore.get(body.previous_response_id)
      : null;
    try {
      chatBody = toChatRequest(body, {
        previousResponse,
        structuredOutput: "prompt",
        emulateCustomTools: true,
        nativeLogprobs: false,
        onDroppedTool: (type) =>
          debugLog({ event: "dropped_hosted_tool", tool_type: type }),
      });
    } catch (error) {
      return sendError(
        res,
        error?.statusCode || 400,
        String(error?.message ?? error),
        requestId,
        error?.code || "invalid_request",
      );
    }

    if (isMimoUpstream()) normalizeMiMoReasoningToggle(chatBody);

    if (body.background === true) {
      // 控制器必须先建并登记，否则 cancel 端点拿不到可中断的东西，
      // 上游请求会一直跑到自然结束。
      const backgroundCancellation = new AbortController();
      const queued = rememberResponse(
        createQueuedResponse(body),
        backgroundCancellation,
      );
      body.__queuedId = queued.id;
      chatBody.stream = false;
      // 后台响应跑在另一个异步上下文里，得把这一跳的路由快照带过去
      body.__route = currentRoute() ? { ...currentRoute() } : null;
      setImmediate(() => {
        const snapshot = body.__route;
        if (snapshot) {
          routeStore.run({ ...snapshot }, () => {
            void runBackgroundResponse(body, chatBody, requestId);
          });
        } else {
          void runBackgroundResponse(body, chatBody, requestId);
        }
      });
      return sendJson(res, 200, queued, requestId);
    }

    chatBody.stream = body.stream === true;
    if (chatBody.stream) {
      // MiMo 只有收到 include_usage 时才在最后一个 SSE chunk 返回真实
      // prompt/completion token。Codex 的上下文与自动压缩依赖这个值。
      chatBody.stream_options = {
        ...(chatBody.stream_options || {}),
        include_usage: true,
      };
    }
  }

  const clientAbort = new AbortController();
  const onAborted = () => clientAbort.abort(new Error("client disconnected"));
  req.once("aborted", onAborted);
  res.once("close", () => {
    if (!res.writableEnded) clientAbort.abort(new Error("client disconnected"));
  });

  // 响应级取消与客户端断开是两件事：前者要发 cancelled 终态，
  // 后者只是连接没了。两者都应立刻中断上游请求。
  const cancellation = new AbortController();
  let abortContext = createAbortContext([
    clientAbort.signal,
    cancellation.signal,
  ]);
  let upstreamPath = requestPath;
  if (isResponses || isAnthropicMessages) {
    upstreamPath = "/v1/chat/completions";
  }

  // 个别模型（如 xiaomi/mimo-x-pro-preview）不接受 reasoning_effort，
  // 上游会明确 400；这种情况下去掉该字段重试一次，而不是把错误抛给客户端。
  let droppedReasoningEffort = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const base = selected?.base || (await discoverEngine(attempt > 0));
    if (!base) {
      abortContext.dispose();
      return sendError(
        res,
        503,
        selected
          ? `上游 ${selected.upstreamId} 不可达：${selected.kind === "mimo" ? "MiMo Desktop 没在跑" : "网关没起来"}`
          : PASSTHROUGH_UPSTREAM
            ? `${UPSTREAM_KIND} gateway not found; start it on the configured upstream URL`
            : "MiMo Desktop engine not found; start the desktop app and rerun mint-token.mjs",
        requestId,
      );
    }

    // 有路由表时，模型兜底由该上游的 capabilities.fallbackModel 承担
    if (!selected) await applyModelFallback(base, chatBody);
    stripRejectedReasoningEffort(chatBody);
    const target = upstreamUrl(base, upstreamPath);
    const upstreamRequestStartedAt = Date.now();
    try {
      const accept =
        isResponses || isAnthropicMessages
          ? body.stream
            ? "text/event-stream"
            : "application/json"
          : req.headers.accept || "*/*";

      const upstreamRequest = {
        method: req.method,
        body:
          req.method === "POST"
            ? JSON.stringify(chatBody)
            : undefined,
      };
      let upstream;
      if (selected) {
        const picked = await fetchUpstreamWithFailover({
          urlFor: (attemptBase) => upstreamUrl(attemptBase, upstreamPath),
          init: (route) => {
            if (route?.model && chatBody && chatBody.model !== route.model) {
              chatBody.model = route.model;
            }
            return {
              method: req.method,
              body:
                req.method === "POST"
                  ? JSON.stringify(chatBody)
                  : undefined,
            };
          },
          abortContext,
          requestId,
          accept,
          first: selected,
          model: routeKey || chatBody?.model || body?.model,
          session: { lastAnsweredId: selected.upstreamId },
        });
        upstream = picked.response;
        selected = { ...selected, ...picked.route };
      } else {
        upstream = await fetchUpstream(
          target,
          upstreamRequest,
          abortContext,
          requestId,
          accept,
        );
      }
      metrics.observeUpstreamHeader(
        Date.now() - upstreamRequestStartedAt,
      );
      metrics.breaker.recordSuccess();

      if (isResponses) {
        if (!upstream.ok) {
          if (
            !droppedReasoningEffort &&
            upstream.status === 400 &&
            chatBody &&
            Object.hasOwn(chatBody, "reasoning_effort")
          ) {
            const probe = await upstream.clone().json().catch(() => null);
            const probeMessage = String(probe?.error?.message ?? "");
            let adapted = false;
            if (/does not support reasoning_effort/i.test(probeMessage)) {
              // 这个模型完全不接受该参数（例如 v2.6 系列）
              delete chatBody.reasoning_effort;
              effortRejectionByModel.set(chatBody.model, { at: Date.now() });
              adapted = true;
            } else {
              // 只接受部分档位：降级到上游列出的最高档
              const supported =
                /supported:\s*([a-z,\s]+)/i.exec(probeMessage)?.[1] ?? "";
              const order = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
              const levels = order.filter((level) =>
                new RegExp(`\\b${level}\\b`, "i").test(supported),
              );
              if (levels.length) {
                chatBody.reasoning_effort = levels[levels.length - 1];
                adapted = true;
              }
            }
            if (adapted) {
              droppedReasoningEffort = true;
              metrics.observeRetry();
              debugLog({
                event: "reasoning_effort_adapted",
                model: chatBody.model,
                reasoning_effort: chatBody.reasoning_effort ?? null,
                upstream_message: probeMessage,
              });
              abortContext.dispose();
              abortContext = createAbortContext([
                clientAbort.signal,
                cancellation.signal,
              ]);
              attempt -= 1; // 参数适配，不占用引擎重试次数
              continue;
            }
          }
          const message = await readUpstreamError(upstream);
          metrics.observeError(errorTypeFromStatus(upstream.status));
          if (isRetryableStatus(upstream.status)) {
            metrics.breaker.recordFailure();
            if (attempt === 0) {
              metrics.observeRetry();
              abortContext.dispose();
              abortContext = createAbortContext([
                clientAbort.signal,
                cancellation.signal,
              ]);
              continue;
            }
          }
          abortContext.dispose();
          return sendError(res, upstream.status, message, requestId);
        }

        if (body.stream) {
          await proxyResponsesStream({
            req,
            res,
            upstream,
            requestBody: body,
            chatBody,
            requestId,
            abortContext,
            cancellation,
            metricState,
            upstreamTarget: target,
          });
        } else {
          let payload = await upstream.json().catch(() => null);
          if (!payload) {
            metrics.breaker.recordFailure();
            metrics.observeError("invalid_upstream_response");
            abortContext.dispose();
            return sendError(
              res,
              502,
              "upstream returned invalid JSON",
              requestId,
              "invalid_upstream_response",
            );
          }
          let response = toResponseObject(payload, body);
          if (shouldGuardToolCall(body, chatBody, response)) {
            debugLog({
              requestId,
              event: "tool_call_guard_triggered",
              text: responseToText(response).slice(0, 500),
            });
            const retryPayload = await fetchToolRetryPayload({
              target,
              chatBody,
              response,
              requestId,
              abortContext,
            });
            if (retryPayload) {
              payload = retryPayload;
              response = toResponseObject(payload, body);
            } else {
              debugLog({
                requestId,
                event: "tool_call_guard_retry_failed",
              });
            }
          }
          response = rememberResponse(
            normalizeStructuredResponse(response, body),
          );
          applyEstimatedUsage(response, chatBody, payload);
          // 估算器会改写 response.usage；同步到路由日志，否则用量页全是 0
          if (response.usage && response.usage.total_tokens) {
            noteUsage(response.usage, !hasRealUsage(response.usage));
          }
          metrics.observeFirstToken(
            metricState,
            Date.now() - metricState.startedAt,
          );
          sendJson(res, 200, response, requestId);
        }
      } else if (isAnthropicMessages) {
        if (!upstream.ok) {
          const message = await readUpstreamError(upstream);
          metrics.observeError(errorTypeFromStatus(upstream.status));
          if (isRetryableStatus(upstream.status)) {
            metrics.breaker.recordFailure();
            if (attempt === 0) {
              metrics.observeRetry();
              abortContext.dispose();
              abortContext = createAbortContext([
                clientAbort.signal,
                cancellation.signal,
              ]);
              continue;
            }
          }
          abortContext.dispose();
          return sendAnthropicError(
            res,
            upstream.status,
            message,
            requestId,
            errorTypeFromStatus(upstream.status),
          );
        }

        if (body.stream) {
          await proxyAnthropicStream({
            res,
            upstream,
            requestBody: body,
            chatBody,
            requestId,
            abortContext,
            cancellation,
            metricState,
          });
        } else {
          const payload = await upstream.json().catch(() => null);
          if (!payload) {
            metrics.breaker.recordFailure();
            metrics.observeError("invalid_upstream_response");
            abortContext.dispose();
            return sendAnthropicError(
              res,
              502,
              "upstream returned invalid JSON",
              requestId,
              "api_error",
            );
          }
          const message = toAnthropicMessage(payload, body, {
            estimateMissingUsage: TOKEN_ESTIMATE_ENABLED,
            estimatedInputTokens: TOKEN_ESTIMATE_ENABLED
              ? estimateChatRequestTokens(chatBody)
              : 0,
          });
          metrics.observeFirstToken(
            metricState,
            metricState ? Date.now() - metricState.startedAt : 0,
          );
          if (message.usage?.total_tokens || message.usage?.output_tokens) {
            metrics.observeUsage({
              input_tokens: message.usage.input_tokens || 0,
              output_tokens: message.usage.output_tokens || 0,
              total_tokens:
                (message.usage.input_tokens || 0) +
                (message.usage.output_tokens || 0),
            });
            noteUsage(message.usage);
          } else if (TOKEN_ESTIMATE_ENABLED) {
            const estimated = estimatedUsageFor(chatBody, message);
            if (estimated) {
              message.usage = {
                input_tokens: estimated.prompt_tokens,
                output_tokens: estimated.completion_tokens,
                total_tokens: estimated.total_tokens,
              };
              metrics.observeEstimatedUsage(estimated);
              noteUsage(message.usage, true);
            }
          }
          sendJson(res, 200, message, requestId);
        }
      } else {
        if (!upstream.ok) {
          if (
            !droppedReasoningEffort &&
            upstream.status === 400 &&
            chatBody &&
            Object.hasOwn(chatBody, "reasoning_effort")
          ) {
            const probe = await upstream.clone().json().catch(() => null);
            const probeMessage = String(probe?.error?.message ?? "");
            let adapted = false;
            if (/does not support reasoning_effort/i.test(probeMessage)) {
              // 这个模型完全不接受该参数（例如 v2.6 系列）
              delete chatBody.reasoning_effort;
              effortRejectionByModel.set(chatBody.model, { at: Date.now() });
              adapted = true;
            } else {
              // 只接受部分档位：降级到上游列出的最高档
              const supported =
                /supported:\s*([a-z,\s]+)/i.exec(probeMessage)?.[1] ?? "";
              const order = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
              const levels = order.filter((level) =>
                new RegExp(`\\b${level}\\b`, "i").test(supported),
              );
              if (levels.length) {
                chatBody.reasoning_effort = levels[levels.length - 1];
                adapted = true;
              }
            }
            if (adapted) {
              droppedReasoningEffort = true;
              metrics.observeRetry();
              debugLog({
                event: "reasoning_effort_adapted",
                model: chatBody.model,
                reasoning_effort: chatBody.reasoning_effort ?? null,
                upstream_message: probeMessage,
              });
              abortContext.dispose();
              abortContext = createAbortContext([
                clientAbort.signal,
                cancellation.signal,
              ]);
              attempt -= 1; // 参数适配，不占用引擎重试次数
              continue;
            }
          }
          const message = await readUpstreamError(upstream);
          metrics.observeError(errorTypeFromStatus(upstream.status));
          if (isRetryableStatus(upstream.status)) {
            metrics.breaker.recordFailure();
            if (attempt === 0) {
              metrics.observeRetry();
              abortContext.dispose();
              abortContext = createAbortContext([
                clientAbort.signal,
                cancellation.signal,
              ]);
              continue;
            }
          }
          abortContext.dispose();
          return sendError(res, upstream.status, message, requestId);
        }
        await proxyChatUpstream({ req, res, upstream, requestId });
      }

      abortContext.dispose();
      req.removeListener("aborted", onAborted);
      return;
    } catch (error) {
      const clientDisconnected =
        clientAbort.signal.aborted || res.destroyed || res.writableEnded;

      if (clientDisconnected) {
        abortContext.dispose();
        return;
      }

      metrics.observeError("upstream_transport");
      if (attempt === 0) {
        metrics.observeRetry();
        abortContext.dispose();
        abortContext = createAbortContext(clientAbort.signal);
        continue;
      }

      metrics.breaker.recordFailure();
      abortContext.dispose();
      return sendError(
        res,
        502,
        "upstream failed: " + String(error?.message ?? error),
        requestId,
        "upstream_transport",
      );
    }
  }
}

function extractJsonFromResponse(response) {
  const text = (response?.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeStructuredResponse(response, requestBody) {
  const format = requestBody?.text?.format;
  if (!format || format.type === "text") return response;

  const parsed = extractJsonFromResponse(response);
  if (parsed === null) {
    throw Object.assign(
      new Error("MiMo output did not satisfy the requested JSON format"),
      {
        statusCode: 502,
        code: "invalid_structured_output",
      },
    );
  }

  if (format.type === "json_schema" && format.schema?.type === "object") {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw Object.assign(
        new Error("Structured output did not match the requested object schema"),
        {
          statusCode: 502,
          code: "invalid_structured_output",
        },
      );
    }
  }

  const normalized = JSON.stringify(parsed);
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    const textPart = (item.content ?? []).find(
      (part) => part.type === "output_text",
    );
    if (textPart) textPart.text = normalized;
  }
  return response;
}

function rememberResponse(response, controller = null) {
  if (response?.id) {
    responseStore.put(response.id, response, controller, {
      upstreamId: currentRoute()?.upstreamId || null,
      model: currentRoute()?.model || response.model || null,
    });
  }
  return response;
}

async function runBackgroundResponse(body, chatBody, requestId) {
  const queuedId = body.__queuedId;
  const record = responseStore.record(queuedId);
  if (!record || record.response.status === "cancelled") return;

  responseStore.patch(queuedId, { status: "in_progress", error: null });
  const abortContext = createAbortContext(record.controller?.signal);

  // HTTP 响应早已返回，metrics 里对应的额度已经释放；这里必须重新申请，
  // 否则 max_concurrent_requests 对 background 请求完全不起作用。
  const slot = metrics.tryBegin({
    countTotal: false,
    requestId,
    path: "/v1/responses:background",
  });
  if (!slot) {
    responseStore.patch(queuedId, {
      status: "failed",
      error: {
        code: "concurrency_limit",
        message: `bridge concurrency limit reached (${MAX_CONCURRENT_REQUESTS})`,
      },
    });
    metrics.observeError("background_concurrency_limit");
    return;
  }
  metrics.setModel(slot, chatBody.model);

  let outcomeStatus = 200;
  try {
    const base = currentRoute()?.base || (await discoverEngine());
    if (!base) {
      throw Object.assign(
        new Error(
          currentRoute()?.upstreamId
            ? `上游 ${currentRoute().upstreamId} 不可达`
            : PASSTHROUGH_UPSTREAM
              ? `${UPSTREAM_KIND} gateway not found`
              : "MiMo Desktop engine not found",
        ),
        { statusCode: 503 },
      );
    }

    // 与前台路径对齐：后台请求同样要做模型兜底，否则 MiMo 改模型 ID 后
    // 后台响应会直接打到不存在的模型上。
    if (!currentRoute()?.upstreamId) await applyModelFallback(base, chatBody);
    stripRejectedReasoningEffort(chatBody);

    const upstream = await fetchUpstream(
      upstreamUrl(base, "/v1/chat/completions"),
      {
        method: "POST",
        body: JSON.stringify({ ...chatBody, stream: false }),
      },
      abortContext,
      requestId,
      "application/json",
    );

    if (!upstream.ok) {
      const message = await readUpstreamError(upstream);
      throw Object.assign(new Error(message), {
        statusCode: upstream.status,
      });
    }

    const payload = await upstream.json().catch(() => null);
    if (!payload) throw new Error("upstream returned invalid JSON");

    const currentAfterFetch = responseStore.get(queuedId);
    if (currentAfterFetch?.status === "cancelled") {
      outcomeStatus = 499;
      return;
    }

    const response = normalizeStructuredResponse(
      toResponseObject(payload, body),
      body,
    );
    response.id = queuedId;
    response.background = true;
    applyEstimatedUsage(response, chatBody, payload);
    if (response.usage && response.usage.total_tokens) {
      noteUsage(response.usage, !hasRealUsage(response.usage));
    }
    rememberResponse(response);
  } catch (error) {
    const current = responseStore.get(queuedId);
    if (current?.status === "cancelled") {
      outcomeStatus = 499;
      return;
    }
    const statusCode = Number(error?.statusCode);
    outcomeStatus = Number.isInteger(statusCode) && statusCode >= 400
      ? statusCode
      : 500;
    responseStore.patch(queuedId, {
      status: "failed",
      error: {
        code: error?.code ?? "background_response_failed",
        message: String(error?.message ?? error),
      },
    });
    metrics.observeError("background_response_failed");
  } finally {
    abortContext.dispose();
    metrics.finish(slot, outcomeStatus);
  }
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || "/", "http://bridge.local");
  const requestPath = requestUrl.pathname;
  const operational = requestPath.startsWith("/v1/");
  const requestId =
    String(req.headers["x-request-id"] || "") ||
    "bridge_" + Math.random().toString(36).slice(2) + Date.now().toString(36);

  if (
    !ALLOW_ANY_HOST &&
    !ALLOWED_HOSTS.has(String(req.headers.host || "").toLowerCase())
  ) {
    sendError(
      res,
      403,
      "forbidden host header; this bridge only accepts loopback requests",
      undefined,
      "forbidden_host",
    );
    return;
  }

  let metricState = null;

  if (operational) metrics.countRequest();

  // 并发额度只配额给真正会占用上游的端点。取消、查询、删除都只动本地状态：
  // 一旦数据面被打满，这些控制面接口必须仍然可用，否则连取消都发不出去。
  const consumesUpstream =
    (requestPath === "/v1/responses" ||
      requestPath === "/v1/messages" ||
      requestPath === "/v1/chat/completions") &&
    req.method === "POST";

  if (consumesUpstream) {
    metricState = metrics.tryBegin({
      countTotal: false,
      requestId,
      path: `${req.method} ${requestPath}`,
    });
    if (!metricState) {
      res.setHeader("Retry-After", "1");
      sendError(
        res,
        429,
        `bridge concurrency limit reached (${MAX_CONCURRENT_REQUESTS})`,
        undefined,
        "concurrency_limit",
      );
      return;
    }
    metrics.setClient(metricState, detectClient(req.headers));
    res.once("finish", () => {
      const route = currentRoute();
      if (route && route.usage) {
        metrics.noteUsage(metricState, {
          prompt_tokens: route.usage.prompt_tokens,
          completion_tokens: route.usage.completion_tokens,
          total_tokens: route.usage.total_tokens,
          __estimated: route.usage.__estimated,
        });
      }
      metrics.finish(metricState, res.statusCode);
    });
    res.once("close", () => {
      if (!res.writableEnded) {
        const route = currentRoute();
        if (route && route.usage) {
          metrics.noteUsage(metricState, {
            prompt_tokens: route.usage.prompt_tokens,
            completion_tokens: route.usage.completion_tokens,
            total_tokens: route.usage.total_tokens,
            __estimated: route.usage.__estimated,
          });
        }
        metrics.finish(metricState, 499);
      }
    });
  }

  // 每个请求一个路由上下文：并发请求各自记自己这一跳用哪家上游的 base/token。
  routeStore.run(
    {
      token: TOKEN,
      kind: UPSTREAM_KIND,
      base: null,
      upstreamId: null,
      capabilities: null,
      model: null,
    },
    () =>
      handleApiRequest(req, res, metricState).catch((error) => {
        if (!res.writableEnded) {
          sendError(
            res,
            error?.statusCode || 500,
            String(error?.message ?? error),
            undefined,
            error?.code || error?.type || "internal_error",
          );
        }
      }),
  );
});

server.on("clientError", (_error, socket) => {
  if (socket.writable) {
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
  }
});

server.listen(LISTEN_PORT, "127.0.0.1", async () => {
  console.log(
    `[bridge] listening on http://127.0.0.1:${LISTEN_PORT}/v1`,
  );
  console.log(
    `[bridge] upstream=${UPSTREAM_KIND}  auth=${BRIDGE_AUTH_MODE}  upstream token: ${TOKEN.slice(0, 6)}…${TOKEN.slice(-4)}  instance dir: ${INSTANCE_DIR}`,
  );
  const base = await discoverEngine();
  console.log(
    base
      ? "[bridge] ready (streaming + authenticated)"
      : PASSTHROUGH_UPSTREAM
        ? `[bridge] warning: ${UPSTREAM_KIND} gateway not found; /health will retry`
        : "[bridge] warning: MiMo engine not found; /health will retry",
  );
});

server.on("error", (error) => {
  console.error("[bridge] server error:", error.message);
  process.exitCode = 1;
});

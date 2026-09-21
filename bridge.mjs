/**
 * mimo-bridge — MiMo Desktop 本地引擎到 Codex 的协议桥接。
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
import { ResponseStore } from "./protocol-state.mjs";

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
const TOKEN_FILE = argOf(
  "--token-file",
  path.join(import.meta.dirname, "token.txt"),
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
  process.env.MIMO_BRIDGE_MODEL_PREFIX || "mimo-desktop",
);
const MODEL_FALLBACK = argOf(
  "--model-fallback",
  process.env.MIMO_BRIDGE_MODEL_FALLBACK || "mimo-desktop/mimo-x-pro-preview",
);
const ENGINE_URL = (

  argOf("--engine-url", process.env.MIMO_BRIDGE_ENGINE_URL || "") || ""
)
  .trim()
  .replace(/\/+$/, "");
const UPSTREAM_TIMEOUT_MS = intFrom(
  process.env.MIMO_BRIDGE_UPSTREAM_TIMEOUT_MS || 600000,
  600000,
);
const MAX_BODY_BYTES = intFrom(
  process.env.MIMO_BRIDGE_MAX_BODY_BYTES || 20 * 1024 * 1024,
  20 * 1024 * 1024,
);
const MAX_CONCURRENT_REQUESTS = intFrom(
  process.env.MIMO_BRIDGE_MAX_CONCURRENT || 8,
  8,
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
  process.env.MIMO_BRIDGE_RESPONSE_STATE_MAX || 200,
  200,
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
  if (fs.existsSync(TOKEN_FILE)) {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  }
  console.error(
    "[bridge] 找不到 token 文件：" +
      TOKEN_FILE +
      "\n[bridge] 先运行： node mint-token.mjs",
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
});

const metrics = new MetricsRegistry({
  maxConcurrent: MAX_CONCURRENT_REQUESTS,
  breakerFailures: BREAKER_FAILURES,
  breakerCooldownMs: BREAKER_COOLDOWN_MS,
});

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
  url.searchParams.set("directory", INSTANCE_DIR);

  if (keepQuery) {
    const incoming = new URL(requestPath, "http://bridge.local").searchParams;
    for (const [key, value] of incoming) {
      if (key !== "directory") url.searchParams.set(key, value);
    }
  }
  return url;
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
    dispose() {
      clearTimeout(timer);
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
      listeners.length = 0;
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
    !body.model.includes("/")
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

// 引擎只认自己的模型 id（xiaomi/...）。桌面端选择器里可能仍显示官方模型，
// 或用户手填了别的名字：把这些"引擎上没有的模型"兜底映射到一个可用模型，
// 而不是直接 404。用 MIMO_BRIDGE_MODEL_FALLBACK=off 可关闭。
let knownModels = null;
let knownModelsFetchedAt = 0;
async function fetchKnownModels(base) {
  if (knownModels && Date.now() - knownModelsFetchedAt < 60000) return knownModels;
  try {
    const url = new URL(base + "/v1/models");
    url.searchParams.set("directory", INSTANCE_DIR);
    const response = await fetch(url, {
      headers: { Authorization: "Bearer " + TOKEN },
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
  "mimo-desktop/mimo-x-pro-preview",
  "mimo-desktop/mimo-pro",
  "mimo-desktop/mimo-flash",
  "mimo-desktop/mimo-auto",
];

function pickFallbackModel(known) {
  for (const candidate of FALLBACK_CANDIDATES) {
    if (candidate && candidate !== "off" && known.has(candidate)) return candidate;
  }
  for (const id of known) {
    if (id.startsWith("mimo-desktop/") && !/asr|tts/i.test(id)) return id;
  }
  return null;
}

async function applyModelFallback(base, chatBody) {
  if (MODEL_FALLBACK === "off" || !chatBody?.model) return;
  const known = await fetchKnownModels(base);
  if (!known || known.size === 0) return;
  if (known.has(chatBody.model)) return;
  const requested = chatBody.model;
  const fallback = pickFallbackModel(known);
  if (!fallback) return;
  chatBody.model = fallback;
  debugLog({ event: "model_fallback", from: requested, to: fallback });
  console.error(
    `[bridge] model "${requested}" is not on the MiMo engine; falling back to ${fallback}`,
  );
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

async function fetchUpstream(
  target,
  init,
  abortContext,
  requestId,
  accept,
) {
  return fetch(target, {
    ...init,
    signal: abortContext.signal,
    headers: {
      Authorization: "Bearer " + TOKEN,
      "Content-Type": "application/json",
      Accept: accept || "*/*",
      "X-Request-ID": requestId || "",
      ...(init.headers || {}),
    },
  });
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

  const translator = createResponseStreamTranslator(requestBody);
  for (const evt of translator.start()) await sseWrite(res, evt);

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
        for (const evt of translated) await sseWrite(res, evt);
      }
    }
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
    if (completed?.response) {
      normalizeStructuredResponse(completed.response, requestBody);
      rememberResponse(completed.response);
    }
    metrics.observeUsage(completed?.response?.usage);
    for (const evt of completedEvents) await sseWrite(res, evt);
    res.end();
  } catch (error) {
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

  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }

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
        engine: base,
        instanceDir: INSTANCE_DIR,
        streaming: true,
        authenticatedApi: true,
        authMode: BRIDGE_AUTH_MODE,
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
          max_body_bytes: MAX_BODY_BYTES,
          max_concurrent_requests: MAX_CONCURRENT_REQUESTS,
          response_state_ttl_ms: RESPONSE_STATE_TTL_MS,
          response_state_max: RESPONSE_STATE_MAX,
        },
        protocol: {
          responses_state: true,
          previous_response_id: true,
          response_retrieval: true,
          background_responses: true,
          response_cancellation: true,
          response_deletion: true,
          custom_tools: true,
        },
        responseState: responseStore.snapshot(),
        metrics: snapshot,
      },
      requestId,
    );
  }

  if (!requestPath.startsWith("/v1/")) {
    return sendError(res, 404, `unsupported path ${requestPath}`, requestId);
  }

  if (!isBridgeAuthorized(req)) {
    return sendError(
      res,
      401,
      "missing or invalid bridge bearer token",
      requestId,
      "invalid_api_key",
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
  const supported =
    (isResponses || requestPath === "/v1/chat/completions") &&
      req.method === "POST" ||
    requestPath === "/v1/models" && req.method === "GET";

  if (!supported) {
    res.setHeader("Allow", "GET, POST");
    return sendError(
      res,
      405,
      `method ${req.method} is not supported for ${requestPath}`,
      requestId,
    );
  }

  if (metrics.breaker.open) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(metrics.breaker.retryAfterMs / 1000),
    );
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return sendError(
      res,
      503,
      `MiMo upstream circuit is open; retry in ${retryAfterSeconds}s`,
      requestId,
      "circuit_open",
    );
  }

  let body = {};
  if (req.method === "POST") {
    const raw = await readBody(req);
    body = parseJsonBody(raw);
    normalizeModel(body);

    if (!isResponses) {
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

  metrics.setModel(metricState, body.model);
  let chatBody = body;

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
      setImmediate(() => {
        void runBackgroundResponse(body, chatBody, requestId);
      });
      return sendJson(res, 200, queued, requestId);
    }

    chatBody.stream = body.stream === true;
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
  if (isResponses) upstreamPath = "/v1/chat/completions";

  // 个别模型（如 xiaomi/mimo-x-pro-preview）不接受 reasoning_effort，
  // 上游会明确 400；这种情况下去掉该字段重试一次，而不是把错误抛给客户端。
  let droppedReasoningEffort = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const base = await discoverEngine(attempt > 0);
    if (!base) {
      abortContext.dispose();
      return sendError(
        res,
        503,
        "MiMo Desktop engine not found; start the desktop app and rerun mint-token.mjs",
        requestId,
      );
    }

    await applyModelFallback(base, chatBody);
    const target = upstreamUrl(base, upstreamPath);
    const upstreamRequestStartedAt = Date.now();
    try {
      const accept = isResponses
        ? body.stream
          ? "text/event-stream"
          : "application/json"
        : req.headers.accept || "*/*";

      const upstream = await fetchUpstream(
        target,
        {
          method: req.method,
          body:
            req.method === "POST"
              ? JSON.stringify(chatBody)
              : undefined,
        },
        abortContext,
        requestId,
        accept,
      );

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
              // 这个模型完全不接受该参数（例如 xiaomi/mimo-x-pro-preview）
              delete chatBody.reasoning_effort;
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
          });
        } else {
          const payload = await upstream.json().catch(() => null);
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
          const response = rememberResponse(
            normalizeStructuredResponse(
              toResponseObject(payload, body),
              body,
            ),
          );
          metrics.observeUsage(response.usage);
          metrics.observeFirstToken(
            metricState,
            Date.now() - metricState.startedAt,
          );
          sendJson(res, 200, response, requestId);
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
              // 这个模型完全不接受该参数（例如 xiaomi/mimo-x-pro-preview）
              delete chatBody.reasoning_effort;
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
        await proxyPassThrough({ req, res, upstream, requestId });
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
  if (response?.id) responseStore.put(response.id, response, controller);
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
  const slot = metrics.tryBegin({ countTotal: false });
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
    const base = await discoverEngine();
    if (!base) {
      throw Object.assign(new Error("MiMo Desktop engine not found"), {
        statusCode: 503,
      });
    }

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
    rememberResponse(response);
    metrics.observeUsage(response.usage);
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
    (requestPath === "/v1/responses" || requestPath === "/v1/chat/completions") &&
    req.method === "POST";

  if (consumesUpstream) {
    metricState = metrics.tryBegin({ countTotal: false });
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
    res.once("finish", () => metrics.finish(metricState, res.statusCode));
    res.once("close", () => {
      if (!res.writableEnded) metrics.finish(metricState, 499);
    });
  }

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
  });
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
    `[bridge] auth=${BRIDGE_AUTH_MODE}  upstream token: ${TOKEN.slice(0, 6)}…${TOKEN.slice(-4)}  instance dir: ${INSTANCE_DIR}`,
  );
  const base = await discoverEngine();
  console.log(
    base
      ? "[bridge] ready (streaming + authenticated)"
      : "[bridge] warning: MiMo engine not found; /health will retry",
  );
});

server.on("error", (error) => {
  console.error("[bridge] server error:", error.message);
  process.exitCode = 1;
});
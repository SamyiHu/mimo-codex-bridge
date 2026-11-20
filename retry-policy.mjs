/**
 * retry-policy.mjs — 上游错误分类与分级重试决策（移植自 TraeWorkAssistant api_server/retry.rs 的语义）。
 *
 * 三态处置：
 *   - retry_same：同号重试（502/503/超时/排队等待窗口）
 *   - switch    ：换号/换上游（401/403/429 重试耗尽）
 *   - fatal     ：直接回给客户端（400 context_too_long、参数错误）
 *
 * 纯函数，无 IO：把"判什么错"和"睡多久"从 bridge 主循环里拆出来，便于单测。
 */

/** 上游错误类别 */
export const ERROR_KINDS = [
  "queue",      // 上游排队（业务码 10605 / queue）
  "quota",      // 额度/积分耗尽
  "auth",       // 401/403 凭证失效
  "rate_limit", // 429 限频
  "context",    // 上下文超长
  "signature",  // 签名/思考块校验抖动（thinking.signature）
  "channel",    // 渠道风控（11-128 非授权渠道）
  "timeout",    // 超时
  "network",    // 连接错误
  "server",     // 5xx
  "client",     // 其它 4xx
  "unknown",
];

/** 每种错误类别的默认处置 */
const KIND_ACTION = {
  queue: "retry_same",
  quota: "switch",
  auth: "switch",
  rate_limit: "switch",
  context: "fatal",
  signature: "retry_same",
  channel: "retry_same", // 需先清洗指纹，由调用方升级；这里先同号重试一次
  timeout: "retry_same",
  network: "retry_same",
  server: "retry_same",
  client: "fatal",
  unknown: "retry_same",
};

function text(body) {
  if (!body) return "";
  if (typeof body === "string") return body;
  try { return JSON.stringify(body); } catch { return ""; }
}

/**
 * 分类上游错误。
 * @param {number} status HTTP 状态码（0/负数表示网络层错误）
 * @param {string|object} body 响应体（文本或已解析对象）
 * @returns {{kind:string,status:number,action:string,retryable:boolean,reason:string}}
 */
export function classifyUpstreamError(status, body) {
  const code = Number(status) || 0;
  const raw = text(body);
  const lower = raw.toLowerCase();

  let kind = "unknown";
  let reason = "";

  if (raw.includes("10605") || lower.includes("queue") || raw.includes("排队")) {
    kind = "queue";
    reason = "上游排队（业务码 10605/queue）";
  } else if (lower.includes("thinking.signature") || lower.includes("signature invalid")) {
    kind = "signature";
    reason = "thinking/签名校验抖动";
  } else if (raw.includes("11-128") || lower.includes("illegal channel") || lower.includes("非授权渠道")) {
    kind = "channel";
    reason = "渠道风控（11-128）";
  } else if (code === 401 || code === 403) {
    kind = "auth";
    reason = "凭证无效或过期（" + code + "）";
  } else if (code === 429) {
    kind = "rate_limit";
    reason = "上游限频（429）";
  } else if (/insufficient|no quota|quota exceeded|额度不足|积分不足/i.test(raw)) {
    kind = "quota";
    reason = "额度/积分不足";
  } else if (code === 400 && /context|too long|maximum.*token|length limit/i.test(raw)) {
    kind = "context";
    reason = "上下文超长";
  } else if (code === 408 || code === 504) {
    kind = "timeout";
    reason = "上游超时（" + code + "）";
  } else if (code >= 500) {
    kind = "server";
    reason = "上游 5xx（" + code + "）";
  } else if (code >= 400) {
    kind = "client";
    reason = "客户端错误（" + code + "）";
  } else if (code <= 0) {
    kind = "network";
    reason = "网络不可达";
  }

  const action = KIND_ACTION[kind] || "retry_same";
  return { kind, status: code, action, retryable: action !== "fatal", reason };
}

/** 指数退避 + 抖动：base * 2^(attempt-1)，上限 capMs，抖动 ±20% */
export function backoffDelay(attempt, { baseMs = 300, capMs = 8000, jitter = true } = {}) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const raw = Math.min(capMs, baseMs * Math.pow(2, n - 1));
  if (!jitter) return Math.round(raw);
  const factor = 0.8 + Math.random() * 0.4;
  return Math.round(raw * factor);
}

/**
 * 决策这一次失败该怎么处置。
 *
 * @param {object} ctx
 * @param {number} ctx.status       HTTP 状态
 * @param {string|object} ctx.body  响应体
 * @param {number} ctx.attempt      已尝试次数（从 1 开始）
 * @param {number} [ctx.maxAttempts=3] 同号最大尝试次数
 * @param {boolean} [ctx.hasAlternative=true] 是否还有其它账号/上游可换
 * @param {number} [ctx.retryAfterMs=0] 上游给的等待提示
 * @returns {{action:'retry_same'|'switch'|'fatal', delayMs:number, kind:string, reason:string}}
 */
export function planRetry(ctx = {}) {
  const { status = 0, body = "", attempt = 1, maxAttempts = 3, hasAlternative = true, retryAfterMs = 0 } = ctx;
  const classified = classifyUpstreamError(status, body);
  const { kind, action, reason } = classified;

  if (action === "fatal") return { action: "fatal", delayMs: 0, kind, reason };

  const exhausted = Number(attempt) >= Number(maxAttempts);

  if (kind === "queue") {
    // 排队优先同号退避：换号只会让排队更糟；上游给了等待时长就照办（封顶 30s）
    const wait = retryAfterMs > 0 ? Math.min(retryAfterMs, 30000) : backoffDelay(attempt, { baseMs: 2000, capMs: 30000 });
    if (exhausted && hasAlternative) return { action: "switch", delayMs: wait, kind, reason: reason + "（同号重试已耗尽，换号）" };
    return { action: "retry_same", delayMs: wait, kind, reason };
  }

  if (kind === "auth" || kind === "rate_limit" || kind === "quota") {
    if (hasAlternative) return { action: "switch", delayMs: retryAfterMs > 0 ? Math.min(retryAfterMs, 30000) : 0, kind, reason };
    if (!exhausted) return { action: "retry_same", delayMs: retryAfterMs > 0 ? Math.min(retryAfterMs, 30000) : backoffDelay(attempt), kind, reason: reason + "（无备用号，同号重试）" };
    return { action: "fatal", delayMs: 0, kind, reason: reason + "（无备用号且重试耗尽）" };
  }

  // server / timeout / network / signature / channel / unknown
  if (!exhausted) return { action: "retry_same", delayMs: retryAfterMs > 0 ? Math.min(retryAfterMs, 30000) : backoffDelay(attempt), kind, reason };
  if (hasAlternative) return { action: "switch", delayMs: 0, kind, reason: reason + "（同号重试已耗尽，换号）" };
  return { action: "fatal", delayMs: 0, kind, reason: reason + "（重试耗尽）" };
}

/** 从响应头解析 Retry-After（秒或 HTTP 日期），返回毫秒 */
export function parseRetryAfter(headerValue, nowMs = Date.now()) {
  if (!headerValue) return 0;
  const raw = String(headerValue).trim();
  if (!raw) return 0;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const ts = Date.parse(raw);
  if (Number.isFinite(ts)) return Math.max(0, ts - nowMs);
  return 0;
}

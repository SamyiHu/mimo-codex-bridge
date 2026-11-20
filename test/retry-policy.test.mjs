import test from "node:test";
import assert from "node:assert/strict";
import { classifyUpstreamError, planRetry, backoffDelay, parseRetryAfter } from "../retry-policy.mjs";

test("分类：排队业务码 10605", () => {
  const c = classifyUpstreamError(200, '{"code":10605,"msg":"排队中"}');
  assert.equal(c.kind, "queue");
  assert.equal(c.action, "retry_same");
});

test("分类：额度与鉴权", () => {
  assert.equal(classifyUpstreamError(200, "no quota left").kind, "quota");
  assert.equal(classifyUpstreamError(401, "").kind, "auth");
  assert.equal(classifyUpstreamError(403, "").kind, "auth");
});

test("分类：上下文超长是 fatal", () => {
  const c = classifyUpstreamError(400, '{"error":"maximum context length exceeded"}');
  assert.equal(c.kind, "context");
  assert.equal(c.action, "fatal");
  assert.equal(c.retryable, false);
});

test("分类：5xx / 超时 / 网络", () => {
  assert.equal(classifyUpstreamError(503, "").kind, "server");
  assert.equal(classifyUpstreamError(504, "").kind, "timeout");
  assert.equal(classifyUpstreamError(0, "").kind, "network");
});

test("分类：签名抖动与渠道风控", () => {
  assert.equal(classifyUpstreamError(500, "thinking.signature invalid").kind, "signature");
  assert.equal(classifyUpstreamError(403, "11-128 非授权渠道").kind, "channel");
});

test("排队：优先同号退避，耗尽才换号", () => {
  const a = planRetry({ status: 200, body: '{"code":10605}', attempt: 1, maxAttempts: 3, hasAlternative: true });
  assert.equal(a.action, "retry_same");
  assert.ok(a.delayMs > 0);
  const b = planRetry({ status: 200, body: '{"code":10605}', attempt: 3, maxAttempts: 3, hasAlternative: true });
  assert.equal(b.action, "switch");
});

test("鉴权失败：有备用号直接换", () => {
  const a = planRetry({ status: 401, attempt: 1, hasAlternative: true });
  assert.equal(a.action, "switch");
  const b = planRetry({ status: 401, attempt: 1, hasAlternative: false });
  assert.equal(b.action, "retry_same");
  const c = planRetry({ status: 401, attempt: 3, maxAttempts: 3, hasAlternative: false });
  assert.equal(c.action, "fatal");
});

test("5xx：先同号重试，耗尽换号", () => {
  assert.equal(planRetry({ status: 502, attempt: 1 }).action, "retry_same");
  assert.equal(planRetry({ status: 502, attempt: 3, maxAttempts: 3, hasAlternative: true }).action, "switch");
  assert.equal(planRetry({ status: 502, attempt: 3, maxAttempts: 3, hasAlternative: false }).action, "fatal");
});

test("退避：指数增长且封顶", () => {
  assert.ok(backoffDelay(1, { jitter: false }) <= 300);
  assert.ok(backoffDelay(4, { jitter: false }) >= 2000);
  assert.equal(backoffDelay(20, { jitter: false, capMs: 8000 }), 8000);
});

test("Retry-After 解析：秒与 HTTP 日期", () => {
  assert.equal(parseRetryAfter("5"), 5000);
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now), 10000);
  assert.equal(parseRetryAfter(""), 0);
});

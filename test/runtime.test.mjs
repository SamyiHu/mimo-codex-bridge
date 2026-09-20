import assert from "node:assert/strict";
import test from "node:test";
import {
  CircuitBreaker,
  MetricsRegistry,
  isRetryableStatus,
  errorTypeFromStatus,
} from "../runtime.mjs";

test("metrics registry tracks concurrency, latency, usage and models", () => {
  const metrics = new MetricsRegistry({ maxConcurrent: 1 });
  const first = metrics.tryBegin();
  assert.ok(first);
  assert.equal(metrics.tryBegin(), null);

  metrics.setModel(first, "xiaomi/mimo-pro");
  metrics.observeFirstToken(first, 12);
  metrics.observeFirstToken(first, 20);
  metrics.observeUpstreamHeader(8);
  metrics.observeUsage({
    input_tokens: 3,
    output_tokens: 4,
    total_tokens: 7,
  });
  metrics.finish(first, 200);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.requests.total, 1);
  assert.equal(snapshot.requests.active, 0);
  assert.equal(snapshot.requests.by_status["200"], 1);
  assert.equal(snapshot.requests.by_model["xiaomi/mimo-pro"], 1);
  assert.equal(snapshot.latency.first_output_event.samples, 1);
  assert.deepEqual(snapshot.usage, {
    requests_with_usage: 1,
    input_tokens: 3,
    output_tokens: 4,
    total_tokens: 7,
  });
});

test("circuit breaker opens after consecutive failures and closes on success", () => {
  const breaker = new CircuitBreaker({
    failures: 2,
    cooldownMs: 50,
  });

  breaker.recordFailure();
  assert.equal(breaker.open, false);
  breaker.recordFailure();
  assert.equal(breaker.open, true);
  assert.ok(breaker.snapshot().retry_after_ms > 0);

  breaker.recordSuccess();
  assert.equal(breaker.open, false);
  assert.equal(breaker.snapshot().state, "closed");
});

test("classifies upstream errors and retryable statuses", () => {
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(errorTypeFromStatus(401), "auth");
  assert.equal(errorTypeFromStatus(500), "upstream_server");
});
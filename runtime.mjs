const percentile = (values, ratio) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return Math.round(sorted[index]);
};

const round = (value) => Math.round(value * 100) / 100;

export class CircuitBreaker {
  constructor({ failures = 3, cooldownMs = 5000 } = {}) {
    this.failures = 0;
    this.openUntil = 0;
    this.threshold = failures;
    this.cooldownMs = cooldownMs;
  }

  get open() {
    return this.openUntil > Date.now();
  }

  get retryAfterMs() {
    return Math.max(0, this.openUntil - Date.now());
  }

  recordFailure() {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openUntil = Date.now() + this.cooldownMs;
    }
  }

  recordSuccess() {
    this.failures = 0;
    this.openUntil = 0;
  }

  snapshot() {
    return {
      state: this.open ? "open" : this.failures ? "degraded" : "closed",
      failures: this.failures,
      threshold: this.threshold,
      retry_after_ms: this.retryAfterMs,
      cooldown_ms: this.cooldownMs,
    };
  }
}

export class MetricsRegistry {
  constructor({
    maxConcurrent = 8,
    breakerFailures = 3,
    breakerCooldownMs = 5000,
  } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.startedAt = Date.now();
    this.active = 0;
    this.total = 0;
    this.statusCounts = new Map();
    this.modelCounts = new Map();
    this.errorCounts = new Map();
    this.latencies = [];
    this.firstTokenLatencies = [];
    this.upstreamHeaderLatencies = [];
    this.retries = 0;
    this.engineDiscoveries = 0;
    this.enginePortChanges = 0;
    this.usage = {
      requests_with_usage: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };
    this.breaker = new CircuitBreaker({
      failures: breakerFailures,
      cooldownMs: breakerCooldownMs,
    });
  }

  /**
   * 申请一个并发额度。
   * countTotal=false 用于后台任务：它复用同一次 API 调用的额度，
   * 只应计入 active（真实在飞的上游请求），不应再算一次 requests.total。
   */
  /** 只计入请求总数，不占用并发额度。 */
  countRequest() {
    this.total += 1;
  }

  tryBegin({ countTotal = true } = {}) {
    if (this.active >= this.maxConcurrent) return null;
    this.active += 1;
    if (countTotal) this.total += 1;
    return { startedAt: Date.now(), model: null };
  }

  setModel(state, model) {
    if (!state || !model) return;
    state.model = model;
  }

  observeFirstToken(state, elapsedMs) {
    if (!state || state.firstTokenObserved) return;
    state.firstTokenObserved = true;
    this.firstTokenLatencies.push(Math.max(0, elapsedMs));
    if (this.firstTokenLatencies.length > 1000) this.firstTokenLatencies.shift();
  }

  finish(state, statusCode = 0) {
    if (!state) return;
    this.active = Math.max(0, this.active - 1);
    const status = String(statusCode || 0);
    this.statusCounts.set(status, (this.statusCounts.get(status) || 0) + 1);

    if (state.model) {
      this.modelCounts.set(
        state.model,
        (this.modelCounts.get(state.model) || 0) + 1,
      );
    }

    const latency = Math.max(0, Date.now() - state.startedAt);
    this.latencies.push(latency);
    if (this.latencies.length > 1000) this.latencies.shift();
  }

  observeError(type) {
    const key = String(type || "unknown");
    this.errorCounts.set(key, (this.errorCounts.get(key) || 0) + 1);
  }

  observeUpstreamHeader(elapsedMs) {
    this.upstreamHeaderLatencies.push(Math.max(0, elapsedMs));
    if (this.upstreamHeaderLatencies.length > 1000) {
      this.upstreamHeaderLatencies.shift();
    }
  }

  observeRetry() {
    this.retries += 1;
  }

  observeEngineDiscovery(changed = false) {
    this.engineDiscoveries += 1;
    if (changed) this.enginePortChanges += 1;
  }

  observeUsage(usage) {
    const total = Number(usage?.total_tokens || 0);
    if (!Number.isFinite(total) || total <= 0) return;
    this.usage.requests_with_usage += 1;
    this.usage.input_tokens += Number(usage.input_tokens || 0);
    this.usage.output_tokens += Number(usage.output_tokens || 0);
    this.usage.total_tokens += total;
  }

  objectMap(map) {
    return Object.fromEntries([...map.entries()].sort());
  }

  latencySummary(values) {
    return {
      samples: values.length,
      avg_ms: values.length
        ? round(values.reduce((sum, value) => sum + value, 0) / values.length)
        : 0,
      p50_ms: percentile(values, 0.5),
      p95_ms: percentile(values, 0.95),
      max_ms: values.length ? Math.max(...values) : 0,
    };
  }

  snapshot() {
    return {
      started_at: new Date(this.startedAt).toISOString(),
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      requests: {
        total: this.total,
        active: this.active,
        max_concurrent: this.maxConcurrent,
        by_status: this.objectMap(this.statusCounts),
        by_model: this.objectMap(this.modelCounts),
        by_error: this.objectMap(this.errorCounts),
      },
      latency: {
        request: this.latencySummary(this.latencies),
        first_output_event: this.latencySummary(this.firstTokenLatencies),
        upstream_headers: this.latencySummary(this.upstreamHeaderLatencies),
      },
      upstream: {
        retries: this.retries,
        breaker: this.breaker.snapshot(),
      },
      engine: {
        discoveries: this.engineDiscoveries,
        port_changes: this.enginePortChanges,
      },
      usage: { ...this.usage },
    };
  }
}

export function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

export function errorTypeFromStatus(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_server";
  return "http_error";
}
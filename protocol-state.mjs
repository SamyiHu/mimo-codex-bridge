export class ResponseStore {
  constructor({ ttlMs = 30 * 60 * 1000, maxEntries = 200 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.lastSweepAt = 0;
  }

  isExpired(record, now = Date.now()) {
    return Boolean(record) && record.expiresAt <= now;
  }

  drop(id, reason) {
    const record = this.entries.get(id);
    if (!record) return;
    record.controller?.abort(new Error(reason));
    this.entries.delete(id);
  }

  /** 全量清扫过期条目 + 强制条目上限。maxEntries 必须每次都生效。 */
  sweep({ sweepExpired = true } = {}) {
    const now = Date.now();
    if (sweepExpired) {
      for (const [id, record] of this.entries) {
        if (this.isExpired(record, now)) this.drop(id, "response state expired");
      }
    }

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.drop(oldest, "response state evicted");
    }
  }

  /**
   * 单条查询只做 O(1) 的过期判断，不触发全量扫描。
   * get/put/patch 每次请求都会走到，全量遍历没有必要。
   */
  cleanup() {
    const now = Date.now();
    if (now - this.lastSweepAt < 1000) return;
    this.lastSweepAt = now;
    this.sweep();
  }

  put(id, response, controller = null) {
    if (!id) throw new TypeError("response id is required");
    this.cleanup();
    // 流式响应会先以进行中的状态登记，完成后再 put 一次最终对象。
    // 这里必须保留原有的取消控制器，否则取消能力会在收尾时被静默丢掉。
    const previous = this.entries.get(id);
    this.entries.delete(id);
    this.entries.set(id, {
      response,
      controller: controller ?? previous?.controller ?? null,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    });
    this.sweep({ sweepExpired: false });
    return response;
  }

  /** 取出记录；过期即删，语义与全量清扫保持一致。 */
  take(id) {
    const record = this.entries.get(id);
    if (!record) return null;
    if (this.isExpired(record)) {
      this.drop(id, "response state expired");
      return null;
    }
    return record;
  }

  get(id) {
    return this.take(id)?.response ?? null;
  }

  record(id) {
    return this.take(id);
  }

  patch(id, patch) {
    const record = this.take(id);
    if (!record) return null;
    Object.assign(record.response, patch);
    record.expiresAt = Date.now() + this.ttlMs;
    return record.response;
  }

  delete(id) {
    this.drop(id, "response state deleted");
    return this.entries.delete(id);
  }

  clear() {
    for (const id of [...this.entries.keys()]) {
      this.drop(id, "response state cleared");
    }
    this.entries.clear();
  }

  snapshot() {
    this.cleanup();
    return {
      entries: this.entries.size,
      ttl_ms: this.ttlMs,
      max_entries: this.maxEntries,
    };
  }
}

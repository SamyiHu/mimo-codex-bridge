export class ResponseStore {
  constructor({ ttlMs = 30 * 60 * 1000, maxEntries = 200 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  cleanup() {
    const now = Date.now();
    for (const [id, record] of this.entries) {
      if (record.expiresAt <= now) {
        record.controller?.abort(new Error("response state expired"));
        this.entries.delete(id);
      }
    }

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      const record = this.entries.get(oldest);
      record?.controller?.abort(new Error("response state evicted"));
      this.entries.delete(oldest);
    }
  }

  put(id, response, controller = null) {
    if (!id) throw new TypeError("response id is required");
    this.cleanup();
    this.entries.delete(id);
    this.entries.set(id, {
      response,
      controller,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    });
    return response;
  }

  get(id) {
    this.cleanup();
    return this.entries.get(id)?.response ?? null;
  }

  record(id) {
    this.cleanup();
    return this.entries.get(id) ?? null;
  }

  patch(id, patch) {
    const record = this.record(id);
    if (!record) return null;
    Object.assign(record.response, patch);
    record.expiresAt = Date.now() + this.ttlMs;
    return record.response;
  }

  delete(id) {
    const record = this.entries.get(id);
    record?.controller?.abort(new Error("response state deleted"));
    return this.entries.delete(id);
  }

  clear() {
    for (const record of this.entries.values()) {
      record.controller?.abort(new Error("response state cleared"));
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
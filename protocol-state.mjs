import fs from "node:fs";
import path from "node:path";

const ACTIVE_STATUSES = new Set(["in_progress", "queued"]);

export class ResponseStore {
  constructor({ ttlMs = 30 * 60 * 1000, maxEntries = 200, stateFile = null } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.stateFile = stateFile ? path.resolve(stateFile) : null;
    this.entries = new Map();
    this.lastSweepAt = 0;
    this.persistenceErrors = 0;
    this.load();
  }

  isActive(record) {
    return ACTIVE_STATUSES.has(record?.response?.status);
  }

  isPersistent(record) {
    return record?.response?.store === true;
  }

  isExpired(record, now = Date.now()) {
    if (!record || this.isActive(record) || this.isPersistent(record)) return false;
    return record.expiresAt <= now;
  }

  drop(id, reason, { abort = false } = {}) {
    const record = this.entries.get(id);
    if (!record) return;
    if (abort) record.controller?.abort(new Error(reason));
    this.entries.delete(id);
    this.persist();
  }

  /** 全量清扫过期条目 + 强制条目上限。活动和 store=true 的状态不会被淘汰。 */
  sweep({ sweepExpired = true } = {}) {
    const now = Date.now();
    if (sweepExpired) {
      for (const [id, record] of this.entries) {
        if (this.isExpired(record, now)) this.drop(id, "response state expired");
      }
    }

    while (this.entries.size > this.maxEntries) {
      const candidates = [...this.entries.entries()]
        .filter(([, record]) => !this.isActive(record))
        .sort((left, right) => {
          const persistentDelta =
            Number(this.isPersistent(left[1])) - Number(this.isPersistent(right[1]));
          return persistentDelta || left[1].createdAt - right[1].createdAt;
        });
      if (!candidates.length) break;
      this.drop(candidates[0][0], "response state evicted");
    }
  }

  cleanup() {
    const now = Date.now();
    if (now - this.lastSweepAt < 1000) return;
    this.lastSweepAt = now;
    this.sweep();
  }

  put(id, response, controller = null) {
    if (!id) throw new TypeError("response id is required");
    this.cleanup();
    const previous = this.entries.get(id);
    this.entries.delete(id);
    this.entries.set(id, {
      response,
      controller: controller ?? previous?.controller ?? null,
      createdAt: previous?.createdAt ?? Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    });
    this.sweep({ sweepExpired: false });
    this.persist();
    return response;
  }

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
    this.persist();
    return record.response;
  }

  delete(id) {
    this.drop(id, "response state deleted", { abort: true });
    return !this.entries.has(id);
  }

  clear() {
    for (const id of [...this.entries.keys()]) {
      this.drop(id, "response state cleared", { abort: true });
    }
    this.entries.clear();
    this.persist();
  }

  load() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    try {
      const payload = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      for (const item of payload?.entries ?? []) {
        if (!item?.id || !item?.response || this.isActive(item)) continue;
        this.entries.set(item.id, {
          response: item.response,
          controller: null,
          createdAt: Number(item.createdAt) || Date.now(),
          expiresAt: Number(item.expiresAt) || Date.now() + this.ttlMs,
        });
      }
    } catch {
      this.persistenceErrors += 1;
    }
  }

  persist() {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const entries = [...this.entries.entries()]
        .filter(([, record]) => this.isPersistent(record))
        .map(([id, record]) => ({
          id,
          response: record.response,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
        }));
      const temporary = `${this.stateFile}.tmp-${process.pid}`;
      fs.writeFileSync(
        temporary,
        JSON.stringify({ version: 1, entries }),
        { encoding: "utf8", mode: 0o600 },
      );
      try {
        fs.renameSync(temporary, this.stateFile);
      } catch {
        fs.copyFileSync(temporary, this.stateFile);
        fs.unlinkSync(temporary);
      }
    } catch {
      this.persistenceErrors += 1;
    }
  }

  snapshot() {
    this.cleanup();
    return {
      entries: this.entries.size,
      active_entries: [...this.entries.values()].filter((record) =>
        this.isActive(record),
      ).length,
      persistent_entries: [...this.entries.values()].filter((record) =>
        this.isPersistent(record),
      ).length,
      ttl_ms: this.ttlMs,
      max_entries: this.maxEntries,
      state_file: this.stateFile,
      persistence_errors: this.persistenceErrors,
    };
  }
}

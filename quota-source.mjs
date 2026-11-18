/**
 * quota-source.mjs — 额度账本（唯一有 I/O 的一小块，依赖全部可注入）
 *
 * 设计参考 magpie：一个账号多个窗口，取"最满的那个窗口"的 share + resetsAt。
 * 区别是它自己去打各家 API；这里只做两件老实事：
 *   1. 读面板写下的 quota.json（人工/插件算好的快照）——默认来源
 *   2. 可选：按上游配置的 quotaUrl 拉一次，字段名可配
 *
 * 三条硬规则：
 *   - TTL 内不重复拉（默认 60s）
 *   - 拉失败保留旧值并标 stale，绝不让额度接口把请求拖死
 *   - 不知道就返回 null，不返回 0（"不知道"和"没用过"在排序里位置不同）
 */

const DEFAULTS = { ttlMs: 60_000, timeoutMs: 1500 };

export function createQuotaSource(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULTS.ttlMs;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULTS.timeoutMs;
  const now = options.now || (() => Date.now());
  const fetchJson = options.fetchJson || null;
  const readJson = options.readJson || (() => null);
  const warn = options.warn || (() => {});

  /** @type {Map<string, {share:number|null, resetsAt:number|null, readAt:number, stale:boolean, source:string}>} */
  const cache = new Map();
  let lastManualRead = 0;
  let manual = {};

  function readManual() {
    const t = now();
    if (t - lastManualRead < ttlMs) return manual;
    lastManualRead = t;
    try {
      const parsed = readJson();
      manual = parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      warn("读 quota.json 失败：" + String(error && error.message ? error.message : error));
      manual = manual || {};
    }
    return manual;
  }

  function normalize(raw, sourceLabel) {
    if (!raw || typeof raw !== "object") return null;
    let share = null;
    if (Number.isFinite(raw.share)) share = raw.share;
    else if (Number.isFinite(raw.used) && Number.isFinite(raw.limit) && raw.limit > 0) share = raw.used / raw.limit;
    else if (Number.isFinite(raw.usedPct)) share = raw.usedPct > 1 ? raw.usedPct / 100 : raw.usedPct;
    if (share !== null) share = Math.min(1, Math.max(0, share));
    const resetsAt = Number.isFinite(raw.resetsAt)
      ? raw.resetsAt
      : Number.isFinite(raw.resetAt)
        ? raw.resetAt
        : null;
    if (share === null && resetsAt === null) return null;
    return { share, resetsAt, readAt: now(), stale: Boolean(raw.stale), source: raw.source || sourceLabel };
  }

  async function fetchOne(upstream) {
    const spec = upstream?.capabilities?.quota;
    if (!spec || !spec.url || !fetchJson) return null;
    try {
      const payload = await fetchJson(spec.url, {
        headers: spec.token ? { Authorization: "Bearer " + spec.token } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      const node = spec.field ? spec.field.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), payload) : payload;
      return normalize(node, "url");
    } catch (error) {
      warn("拉额度失败 " + upstream.id + "：" + String(error && error.message ? error.message : error));
      return null;
    }
  }

  /**
   * @param {Iterable<Object>} upstreams  registry.upstreams.values()
   * @returns {Promise<Record<string, {share:number|null, resetsAt:number|null, stale:boolean}>>}
   */
  async function read(upstreams) {
    const out = {};
    const manualNow = readManual();
    const jobs = [];
    for (const up of upstreams || []) {
      const cached = cache.get(up.id);
      if (cached && now() - cached.readAt < ttlMs) {
        out[up.id] = cached;
        continue;
      }
      const seeded = normalize(manualNow[up.id], "quota.json");
      if (seeded && !up.capabilities?.quota?.url) {
        cache.set(up.id, seeded);
        out[up.id] = seeded;
        continue;
      }
      jobs.push(
        fetchOne(up).then((fetched) => {
          const value = fetched || seeded || cached || null;
          if (value) {
            const next = fetched ? value : { ...value, stale: true };
            cache.set(up.id, next);
            out[up.id] = next;
          } else {
            out[up.id] = null;
          }
        }),
      );
    }
    await Promise.all(jobs);
    return out;
  }

  function snapshot() {
    const out = {};
    for (const [id, value] of cache) out[id] = { ...value };
    return out;
  }

  function reset() {
    cache.clear();
    lastManualRead = 0;
    manual = {};
  }

  return { read, snapshot, reset };
}

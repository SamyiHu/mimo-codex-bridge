/**
 * api-keys.mjs — 本地子 Key 体系（移植自 TraeWorkAssistant api_server/api_keys.rs 的语义）。
 *
 * 能力：
 *   - 多个 ck_ 子 Key，各自独立额度/白名单，替代"全局一个 bridge-secret"
 *   - daily_limit（0 = 不限），used_today 按本地日期滚动清零
 *   - allowed_models 前缀过滤 + allowed_upstreams 限定上游
 *   - 记账只在内存累加，落盘节流（2s 内多次请求只写一次）
 *
 * 纯逻辑 + 一次文件读写，不做网络。
 */
import fs from "node:fs";
import crypto from "node:crypto";

const FLUSH_MS = 2000;

export function todayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

export function newKeyId() {
  return "ck_" + crypto.randomBytes(16).toString("hex");
}

export class ApiKeyStore {
  constructor(file, { now = () => new Date() } = {}) {
    this.file = file;
    this.now = now;
    this.keys = new Map();
    this.dirty = false;
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const list = Array.isArray(raw?.keys) ? raw.keys : [];
      for (const item of list) {
        if (!item || !item.id) continue;
        this.keys.set(item.id, {
          id: item.id,
          label: String(item.label || ""),
          enabled: item.enabled !== false,
          dailyLimit: Number(item.dailyLimit) || 0,
          usedToday: Number(item.usedToday) || 0,
          usedDate: String(item.usedDate || ""),
          allowedModels: Array.isArray(item.allowedModels) ? item.allowedModels.slice() : [],
          allowedUpstreams: Array.isArray(item.allowedUpstreams) ? item.allowedUpstreams.slice() : [],
          createdAt: item.createdAt || new Date().toISOString(),
        });
      }
    } catch { /* 首次运行没有文件 */ }
  }

  save() {
    const payload = { version: 1, keys: [...this.keys.values()] };
    fs.writeFileSync(this.file, JSON.stringify(payload, null, 2), "utf8");
    this.dirty = false;
  }

  scheduleSave() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) this.save();
    }, FLUSH_MS);
    if (this.timer.unref) this.timer.unref();
  }

  list() {
    return [...this.keys.values()].map((k) => ({ ...k, usedToday: this.usedFor(k) }));
  }

  create({ label = "", dailyLimit = 0, allowedModels = [], allowedUpstreams = [] } = {}) {
    const key = {
      id: newKeyId(),
      label: String(label || ""),
      enabled: true,
      dailyLimit: Math.max(0, Number(dailyLimit) || 0),
      usedToday: 0,
      usedDate: todayKey(this.now()),
      allowedModels: allowedModels.slice(),
      allowedUpstreams: allowedUpstreams.slice(),
      createdAt: this.now().toISOString(),
    };
    this.keys.set(key.id, key);
    this.save();
    return key;
  }

  remove(id) {
    const ok = this.keys.delete(id);
    if (ok) this.save();
    return ok;
  }

  update(id, patch = {}) {
    const key = this.keys.get(id);
    if (!key) return null;
    if (patch.label !== undefined) key.label = String(patch.label);
    if (patch.enabled !== undefined) key.enabled = Boolean(patch.enabled);
    if (patch.dailyLimit !== undefined) key.dailyLimit = Math.max(0, Number(patch.dailyLimit) || 0);
    if (patch.allowedModels !== undefined) key.allowedModels = patch.allowedModels.slice();
    if (patch.allowedUpstreams !== undefined) key.allowedUpstreams = patch.allowedUpstreams.slice();
    this.save();
    return key;
  }

  /** 当天已用次数（跨天自动归零） */
  usedFor(key) {
    const today = todayKey(this.now());
    if (key.usedDate !== today) { key.usedDate = today; key.usedToday = 0; this.scheduleSave(); }
    return key.usedToday;
  }

  /**
   * 鉴权：返回 { ok, key?, reason?, anonymous? }
   * 未配置任何启用 Key 时按"鉴权关闭"放行（与参考实现一致）。
   */
  authenticate(token) {
    const all = [...this.keys.values()];
    // 一把 Key 都没有 = 未启用子 Key 体系，回落到 bridge-secret（anonymous）
    if (all.length === 0) return { ok: true, anonymous: true };
    const enabled = all.filter((k) => k.enabled);
    // 有 Key 但全被禁用：拒绝（不能因为"全禁用"把门敞开）
    if (enabled.length === 0) return { ok: false, reason: "all_keys_disabled" };
    const hit = enabled.find((k) => k.id === token);
    if (!hit) return { ok: false, reason: "invalid_api_key" };
    const used = this.usedFor(hit);
    if (hit.dailyLimit > 0 && used >= hit.dailyLimit) return { ok: false, reason: "quota_exceeded", key: hit, used, limit: hit.dailyLimit };
    return { ok: true, key: hit, used, limit: hit.dailyLimit };
  }

  /** 允许该 Key 访问某个模型/上游吗 */
  allows(key, { model = "", upstream = "" } = {}) {
    if (!key) return true;
    const models = key.allowedModels || [];
    if (models.length && model && !models.some((p) => model === p || model.startsWith(p))) return false;
    const ups = key.allowedUpstreams || [];
    if (ups.length && upstream && !ups.includes(upstream)) return false;
    return true;
  }

  /** 记账（请求成功后调用） */
  record(key) {
    if (!key) return;
    this.usedFor(key);
    key.usedToday += 1;
    this.scheduleSave();
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.dirty) this.save();
  }
}

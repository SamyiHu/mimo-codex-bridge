/**
 * bridge-routing.mjs — 把 registry / 额度账本 / 排序器 / 健康状态接成一个东西
 *
 * 设计参考 magpie 的 gateway routing：请求进来才决定问谁，失败过的那家会休息。
 * 这里不做 I/O 假设：读文件、解析 base、读 token、拉额度全部由调用方注入，
 * 所以它能在测试里被完整跑一遍。
 *
 * 关键行为（照 magpie 的六步）：
 *   - 有 previous_response_id 的请求钉在当初那家上游上（协议要求，不是优化）
 *   - 失败的上游进 resting，下次排最后，但永不剔除
 *   - 429 记一笔，短期内排到没被限流的后面
 *   - 额度快照过期/拉不到，只标 stale，不影响可用性
 */

import { candidatesFor, parseRegistry } from "./upstream-registry.mjs";
import { chooseRoute } from "./router.mjs";
import { createQuotaSource } from "./quota-source.mjs";

const DEFAULT_REST_MS = 30_000;
const DEFAULT_REGISTRY_FILE = "upstreams.json";

function splitCandidateId(id) {
  const s = String(id || "");
  const i = s.indexOf("::");
  if (i <= 0) return { upstreamId: "", model: "" };
  return { upstreamId: s.slice(0, i), model: s.slice(i + 2).replace(/::fallback$/, "") };
}

export function createRouting(options = {}) {
  const dir = options.dir || "";
  const registryPath = options.registryPath || (dir ? dir + "/" + DEFAULT_REGISTRY_FILE : DEFAULT_REGISTRY_FILE);
  const now = options.now || (() => Date.now());
  const readFile = options.readFile || null;
  const statSync = options.statSync || null;
  const resolveBase = options.resolveBase || (async () => null);
  const readToken = options.readToken || (() => "");
  const warn = options.warn || (() => {});
  const restMs = Number.isFinite(options.restMs) ? options.restMs : DEFAULT_REST_MS;
  const defaultRouting = options.defaultRouting || "smart";
  const defaultStays = options.defaultStays || "auto";

  const quota = createQuotaSource({
    now,
    fetchJson: options.fetchJson || null,
    readJson: options.readQuotaJson || null,
    warn,
    ttlMs: options.quotaTtlMs,
  });

  /** @type {Map<string, {restingUntil:number, rateLimitedAt:number, lastFirstTokenMs:number|null, failures:number}>} */
  const health = new Map();
  const healthOf = (id) => {
    let h = health.get(id);
    if (!h) {
      h = { restingUntil: 0, rateLimitedAt: 0, lastFirstTokenMs: null, failures: 0 };
      health.set(id, h);
    }
    return h;
  };

  let registry = null;
  /** 最近 20 条路由决策（新的在后）。面板的"最近一次怎么路由"读它。 */
  const decisions = [];
  let enabled = false;
  let error = null;
  let mtime = -1;
  let checkedAt = 0;
  let catalog = null;

  function reload(force = false) {
    if (!readFile || !statSync) {
      enabled = false;
      error = "没有注入 readFile/statSync";
      return enabled;
    }
    const t = now();
    if (!force && t - checkedAt < 250) return enabled;
    checkedAt = t;
    let st = null;
    try {
      st = statSync(registryPath);
    } catch {
      if (enabled) warn("upstreams.json 不见了，退回单上游模式");
      registry = null;
      enabled = false;
      error = "没有 " + registryPath;
      mtime = -1;
      return enabled;
    }
    const m = st && st.mtimeMs ? st.mtimeMs : 0;
    if (!force && m === mtime) return enabled;
    mtime = m;
    try {
      const parsed = parseRegistry(JSON.parse(readFile(registryPath)));
      if (parsed.errors.length) {
        error = "upstreams.json 有错：" + parsed.errors.join("；");
        if (!enabled) {
          registry = null;
          warn(error);
        } else {
          warn(error + "（继续用上一份）");
        }
        return enabled;
      }
      registry = parsed;
      enabled = registry.upstreams.size > 0;
      error = null;
      if (enabled) warn("已加载 " + registry.upstreams.size + " 家上游 / " + registry.groups.size + " 个路由组");
    } catch (err) {
      error = "读 upstreams.json 失败：" + String(err && err.message ? err.message : err);
      if (!enabled) registry = null;
      warn(error);
    }
    return enabled;
  }

  function setCatalog(map) {
    catalog = map && typeof map === "object" ? map : null;
  }

  function describe() {
    reload();
    // 额度是懒加载的：面板一打开就要看到数字，这里顺手预热一次（不阻塞本次返回）
    if (enabled && registry && !Object.keys(quota.snapshot()).length) {
      void quota.read(registry.upstreams.values()).catch(() => {});
    }
    const ups = registry ? [...registry.upstreams.values()] : [];
    const groups = registry ? [...registry.groups.values()] : [];
    return {
      enabled,
      registryPath,
      error,
      upstreams: ups.map((u) => ({
        id: u.id,
        kind: u.kind,
        base: u.base,
        capabilities: u.capabilities,
        health: { ...healthOf(u.id) },
      })),
      groups: groups.map((g) => ({ id: g.id, models: g.models, routing: g.routing, stays: g.stays, listed: g.listed })),
      aliases: registry && registry.aliases ? [...registry.aliases.keys()] : [],
      recentDecisions: decisions.slice(-10),
      quota: quota.snapshot(),
    };
  }

  /**
   * 选这次请求要问谁。
   *
   * @param {Object} input
   * @param {string} input.model            客户端给的 model（含可不含 provider 前缀）
   * @param {{upstreamId:string, model:string}} [input.pinned]  previous_response_id 绑定的上游
   * @param {string} [input.routing]        覆盖路由组设置
   * @param {string} [input.stays]
   * @param {{lastAnsweredId?:string}} [input.session]
   */
  async function pick(input = {}) {
    reload();
    if (!enabled || !registry) {
      return { ok: false, disabled: true, error: error || "路由未启用" };
    }

    const model = String(input.model || "");
    if (!model) return { ok: false, error: "请求没有 model" };

    // previous_response_id：协议要求回到当初那家，不参与排序
    if (input.pinned && input.pinned.upstreamId) {
      const up = registry.upstreams.get(input.pinned.upstreamId);
      if (up) {
        const target = {
          ok: true,
          pinned: true,
          upstreamId: up.id,
          model: input.pinned.model || model,
          kind: up.kind,
          capabilities: up.capabilities,
          group: null,
          order: [{ id: up.id + "::" + (input.pinned.model || model), reason: "previous_response_id 钉在这家上游" }],
          notes: ["续写必须回原上游，否则上下文和会话缓存都对不上"],
        };
        return attachTarget(target, up);
      }
      warn("previous_response_id 指向的上游 " + input.pinned.upstreamId + " 已不在配置里，重新路由");
    }

    const quotas = await quota.read(registry.upstreams.values());
    const healthMap = {};
    for (const id of registry.upstreams.keys()) healthMap[id] = { ...healthOf(id) };

    const laid = candidatesFor(registry, model, quotas, healthMap, { catalog: catalog || {} });
    if (!laid.ok) return { ok: false, error: laid.error };

    // 已经试过的上游这次不再试（跨上游 failover 用）
    const exclude = Array.isArray(input.exclude) ? input.exclude.filter(Boolean) : [];
    if (exclude.length) {
      laid.candidates = laid.candidates.filter(
        (candidate) => !exclude.includes(splitCandidateId(candidate.id).upstreamId),
      );
      if (!laid.candidates.length) {
        return { ok: false, error: "候选都试过了：" + exclude.join("、"), excluded: exclude };
      }
    }

    const group = laid.group;
    const decided = chooseRoute({
      now: now(),
      routing: input.routing || group?.routing || defaultRouting,
      stays: input.stays || group?.stays || defaultStays,
      sink: true,
      weights: input.weights,
      turn: input.turn,
      session: input.session || {},
      candidates: laid.candidates,
    });

    if (!decided.ok) return { ok: false, error: decided.notes[0] || "没有可用上游", dropped: decided.dropped, notes: decided.notes };

    const first = decided.order[0];
    const { upstreamId, model: chosenModel } = splitCandidateId(first.id);
    const up = registry.upstreams.get(upstreamId);
    if (!up) return { ok: false, error: "候选指向未定义的上游 " + upstreamId };

    return attachTarget({
      ok: true,
      upstreamId,
      model: chosenModel,
      kind: up.kind,
      capabilities: up.capabilities,
      group: group ? { id: group.id, routing: group.routing, stays: group.stays } : null,
      routing: decided.order.length ? (input.routing || group?.routing || defaultRouting) : defaultRouting,
      order: decided.order,
      dropped: decided.dropped,
      notes: decided.notes,
      keepOn: decided.keepOn,
      reason: first.reason,
      weights: decided.nextWeights,
      quota: quotas[upstreamId] || null,
    }, up);
  }

  async function attachTarget(result, up) {
    try {
      const base = await resolveBase(up);
      const token = readToken(up);
      return { ...result, base: base || "", token: token || "", ready: Boolean(base) };
    } catch (err) {
      return {
        ...result,
        base: "",
        token: "",
        ready: false,
        error: "解析上游地址失败：" + String(err && err.message ? err.message : err),
      };
    }
  }

  /** 记一条路由决策：谁赢了、候选顺序、为什么。 */
  function noteDecision(info = {}) {
    if (!info || !info.chosen) return;
    decisions.push({
      at: new Date().toISOString(),
      model: String(info.model || ""),
      chosen: String(info.chosen),
      order: Array.isArray(info.order) ? info.order.slice(0, 8) : [],
      notes: Array.isArray(info.notes) ? info.notes.slice(0, 4) : [],
      pinned: Boolean(info.pinned),
      reason: String(info.reason || ""),
    });
    if (decisions.length > 20) decisions.shift();
  }

  /** 请求回来了：更新这家上游的健康状态（排序下一轮会用到）。 */
  function noteResult(upstreamId, info = {}) {
    if (!upstreamId) return;
    const h = healthOf(upstreamId);
    const status = Number(info.status || 0);
    const t = now();
    if (info.firstTokenMs !== undefined && Number.isFinite(info.firstTokenMs)) h.lastFirstTokenMs = info.firstTokenMs;
    if (status === 429) {
      h.rateLimitedAt = t;
      return;
    }
    if (status >= 500 || info.error) {
      h.failures += 1;
      h.restingUntil = t + restMs;
      return;
    }
    if (status >= 200 && status < 400) {
      h.failures = 0;
      h.restingUntil = 0;
    }
  }

  function snapshot() {
    reload();
    return {
      enabled,
      registryPath,
      error,
      upstreams: registry ? [...registry.upstreams.keys()] : [],
      groups: registry ? [...registry.groups.keys()] : [],
      health: Object.fromEntries([...health.entries()].map(([k, v]) => [k, { ...v }])),
      quota: quota.snapshot(),
    };
  }

  return {
    reload,
    pick,
    noteResult,
    noteDecision,
    describe,
    snapshot,
    setCatalog,
    // 第一次问"启用了吗"时要先试着读一次配置：bridge 在请求路径上就是这么问的。
    get enabled() {
      reload();
      return enabled;
    },
    get registry() {
      reload();
      return registry;
    },
    quota,
  };
}

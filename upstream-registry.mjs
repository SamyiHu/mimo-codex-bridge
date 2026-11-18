/**
 * upstream-registry.mjs — 上游注册表（纯函数，无 I/O）
 *
 * 把 bridge.mjs 里那个启动时钉死的 UPSTREAM_KIND 换成一份数据：
 * 哪几家上游、各自的凭据文件、能力表、以及"几个模型当一个用"的路由组。
 *
 * 职责边界：
 *   - 这里只做解析、校验、把模型 ID 解析成候选 —— 不读文件、不发请求。
 *   - 真正的 base/token 解析（mimo 的端口扫描、openai 型的固定 base）
 *     留给 bridge 的 resolveUpstream()，因为它要碰进程和网络。
 *   - 排序交给 router.mjs。
 */

import { ROUTING_MODES } from "./router.mjs";

const STAYS = ["auto", "session", "turn", "off", "strict"];
const KINDS = ["mimo", "openai"];

const str = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * @param {Object} raw  upstreams.json 解析后的对象
 * @returns {{upstreams: Map<string,Object>, groups: Map<string,Object>, errors: string[]}}
 */
export function parseRegistry(raw) {
  const errors = [];
  const upstreams = new Map();
  const groups = new Map();
  const doc = raw && typeof raw === "object" ? raw : {};

  const list = Array.isArray(doc.upstreams) ? doc.upstreams : [];
  if (!list.length) errors.push("upstreams 为空：至少配一条");

  list.forEach((item, i) => {
    const id = str(item && item.id);
    if (!id) return errors.push("upstreams[" + i + "] 缺 id");
    if (upstreams.has(id)) return errors.push("上游 id 重复：" + id);
    const kind = str(item && item.kind) || "openai";
    if (!KINDS.includes(kind)) errors.push("上游 " + id + " 的 kind 不认识：" + kind);
    const caps = item && item.capabilities && typeof item.capabilities === "object" ? item.capabilities : {};
    const entry = {
      id,
      kind,
      base: str(item.base),
      tokenFile: str(item.tokenFile),
      capabilities: {
        needsDiscovery: Boolean(caps.needsDiscovery) || kind === "mimo",
        chatMode: caps.chatMode === "raw" ? "raw" : "compatible",
        nativeResponses: Boolean(caps.nativeResponses),
        modelPrefix: str(caps.modelPrefix) || "off",
        modelPassthrough: caps.modelPassthrough !== false,
        enrichModels: str(caps.enrichModels) || null,
        reasoningEffort: ["normalize", "strip", "pass"].includes(caps.reasoningEffort)
          ? caps.reasoningEffort
          : "pass",
        thinkingBudget: caps.thinkingBudget === "map" ? "map" : "pass",
        toolCallGuard: Boolean(caps.toolCallGuard),
        fallbackModel: str(caps.fallbackModel) || null,
      },
    };
    if (entry.kind === "openai" && !entry.base) {
      errors.push("上游 " + id + " 是 openai 型，但没有 base");
    }
    if (!entry.tokenFile) errors.push("上游 " + id + " 缺 tokenFile");
    upstreams.set(id, entry);
  });

  const glist = Array.isArray(doc.groups) ? doc.groups : [];
  glist.forEach((item, i) => {
    const id = str(item && item.id);
    if (!id) return errors.push("groups[" + i + "] 缺 id");
    if (groups.has(id)) return errors.push("路由组 id 重复：" + id);
    const models = (Array.isArray(item && item.models) ? item.models : []).map(str).filter(Boolean);
    if (!models.length) errors.push("路由组 " + id + " 没有成员模型");
    const routing = str(item && item.routing) || "smart";
    if (!ROUTING_MODES.includes(routing)) errors.push("路由组 " + id + " 的 routing 不认识：" + routing);
    const stays = str(item && item.stays) || "auto";
    if (!STAYS.includes(stays)) errors.push("路由组 " + id + " 的 stays 不认识：" + stays);
    for (const m of models) {
      const ref = splitUpstream(m);
      if (!ref) {
        errors.push("路由组 " + id + " 的成员 " + m + " 必须写成 provider/model");
      } else if (!upstreams.has(ref.upstream)) {
        errors.push("路由组 " + id + " 的成员 " + m + " 指向未定义的上游 " + ref.upstream);
      }
    }
    groups.set(id, { id, models, routing, stays, listed: !(item && item.listed === false) });
  });

  // 别名：把旧模型名映射到 provider/model 或 group/x。
  // 开多上游时最有用的就是这一条——Codex 里写的 cn:xxx 不用改也能继续用。
  const aliases = new Map();
  const rawAliases = doc.aliases && typeof doc.aliases === "object" ? doc.aliases : {};
  for (const [from, to] of Object.entries(rawAliases)) {
    const target = str(to);
    if (!target) {
      errors.push("别名 " + from + " 指向为空");
      continue;
    }
    if (target.startsWith("group/")) {
      if (!groups.has(target.slice("group/".length))) {
        errors.push("别名 " + from + " 指向不存在的路由组 " + target);
        continue;
      }
    } else {
      const ref = splitUpstream(target);
      if (!ref) {
        errors.push("别名 " + from + " 必须写成 provider/model 或 group/id");
        continue;
      }
      if (!upstreams.has(ref.upstream)) {
        errors.push("别名 " + from + " 指向未定义的上游 " + ref.upstream);
        continue;
      }
    }
    aliases.set(str(from), target);
  }

  return { upstreams, groups, aliases, errors };
}

/** provider/model → { upstream, model }；只看第一段是不是已知上游前缀。 */
export function splitUpstream(id) {
  const s = str(id);
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  return { upstream: s.slice(0, i), model: s.slice(i + 1) };
}

/**
 * 把请求里的 model ID 解析成"该问谁"。
 *
 *   group/daily       → 路由组
 *   wb/cn:glm-4.6     → 指定上游
 *   mimo-desktop/xxx  → 唯一声明服务它的上游；多家都能服务就是 ambiguous
 *
 * @returns {{kind:"group"|"upstream"|"ambiguous"|"unknown", group?:Object,
 *            upstream?:Object, model?:string, matches?:string[], error?:string}}
 */
export function resolveModel(registry, modelId, options = {}) {
  const id = str(modelId);
  const catalog = options.catalog && typeof options.catalog === "object" ? options.catalog : {};
  if (!id) return { kind: "unknown", error: "model 为空" };

  const alias = registry.aliases && registry.aliases.get ? registry.aliases.get(id) : null;
  if (alias) {
    const resolved = resolveModel(registry, alias, options);
    return { ...resolved, aliasOf: id, aliasTarget: alias };
  }

  if (id.startsWith("group/")) {
    const group = registry.groups.get(id.slice("group/".length));
    if (!group) return { kind: "unknown", error: "没有这个路由组：" + id };
    return { kind: "group", group };
  }

  if (registry.upstreams.has(id)) {
    return { kind: "unknown", error: id + " 是上游名，不是模型名" };
  }

  const ref = splitUpstream(id);
  if (ref && registry.upstreams.has(ref.upstream)) {
    return { kind: "upstream", upstream: registry.upstreams.get(ref.upstream), model: ref.model };
  }

  const holds = (up) => {
    const models = catalog[up.id];
    if (!models) return false;
    if (typeof models.has === "function") return models.has(id);
    return Array.isArray(models) && models.includes(id);
  };

  // 1) 谁的模型目录里有它（最可靠：目录本来就从 /v1/models 拉）
  const inCatalog = [...registry.upstreams.values()].filter(holds).map((u) => u.id);
  if (inCatalog.length === 1) {
    return { kind: "upstream", upstream: registry.upstreams.get(inCatalog[0]), model: id };
  }
  if (inCatalog.length > 1) {
    return {
      kind: "ambiguous",
      matches: inCatalog,
      error: inCatalog.length + " 家上游的模型目录里都有 " + id + "：" + inCatalog.join("、") + "，请写成 provider/model",
    };
  }

  // 2) 模型 ID 自带上游前缀（mimo-desktop/…）
  const prefixed = [...registry.upstreams.values()]
    .filter((up) => up.capabilities.modelPrefix !== "off" && id.startsWith(up.capabilities.modelPrefix + "/"))
    .map((u) => u.id);
  if (prefixed.length === 1) {
    return { kind: "upstream", upstream: registry.upstreams.get(prefixed[0]), model: id };
  }

  // 3) 只有一家上游时不用问：就是它
  if (registry.upstreams.size === 1) {
    const only = [...registry.upstreams.values()][0];
    return { kind: "upstream", upstream: only, model: id };
  }

  if (prefixed.length > 1) {
    return {
      kind: "ambiguous",
      matches: prefixed,
      error: prefixed.length + " 家上游都声明了这个前缀：" + prefixed.join("、"),
    };
  }
  return {
    kind: "unknown",
    error: "没有上游声明能服务 " + id + "（模型目录里没有，也没有前缀），请写成 provider/model 或加进路由组",
  };
}

/**
 * 把解析结果摊成 router.mjs 的 candidates。
 *
 * @param {Object} registry
 * @param {string} modelId
 * @param {Object} [quotas]  { [upstreamId]: { share, resetsAt } }  由 quota-source 提供
 * @param {Object} [health]  { [upstreamId]: { restingUntil, rateLimitedAt, lastFirstTokenMs } }
 */
export function candidatesFor(registry, modelId, quotas = {}, health = {}, options = {}) {
  const target = resolveModel(registry, modelId, options);
  if (target.kind === "unknown" || target.kind === "ambiguous") {
    return { ok: false, error: target.error, candidates: [], group: null };
  }

  const make = (upstream, model, index, kind) => {
    const q = quotas[upstream.id] || null;
    const h = health[upstream.id] || {};
    return {
      id: upstream.id + "::" + model + (kind === "fallback" ? "::fallback" : ""),
      upstream: upstream.id,
      model,
      kind: kind || "account",
      index,
      quota: q && (q.share !== undefined || q.resetsAt !== undefined)
        ? { share: q.share === undefined ? null : q.share, resetsAt: q.resetsAt === undefined ? null : q.resetsAt }
        : null,
      restingUntil: h.restingUntil || 0,
      rateLimitedAt: h.rateLimitedAt || 0,
      lastFirstTokenMs: h.lastFirstTokenMs === undefined ? null : h.lastFirstTokenMs,
    };
  };

  if (target.kind === "group") {
    const candidates = target.group.models.map((m, i) => {
      const ref = splitUpstream(m);
      return make(registry.upstreams.get(ref.upstream), ref.model, i);
    });
    return { ok: true, candidates, group: target.group };
  }

  const up = target.upstream;
  const candidates = [make(up, target.model, 0)];
  if (up.capabilities.fallbackModel) {
    candidates.push(make(up, up.capabilities.fallbackModel, 1, "fallback"));
  }
  return { ok: true, candidates, group: null };
}

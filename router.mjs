/**
 * router.mjs — 上游路由与排序（纯函数，无 I/O）
 *
 * 设计参考：yetone/magpie 的 "How magpie picks an account"
 * （docs/reference.md）。它每个请求按六步决定谁先答：
 *
 *   1. 能答的        —— 暂停的、不服务这个模型的、卡在额度上限上的，直接不试
 *   2. 按 routing 排 —— smart / order / rotate / usage / pace / weight / fast
 *   3. 429 沉底      —— 有额度却被限流的，排到没被限流过的后面（Sink 开关）
 *   4. 兜底模型在后  —— 提供商自己的 fallback 模型排在它自己的账号之后
 *   5. resting 沉底  —— 失败后休息中的排最后，但永不剔除；只剩它时照样试
 *   6. 会话粘性      —— 答过这轮对话的账号提到最前，但叫不醒 resting、也压不过 98%
 *
 * 这里只实现"算顺序"这一件事：给 candidates 和当前状态，返回一个有序列表
 * 和每个位置的理由。真正的请求、重试、账本更新留给 bridge 做。
 *
 * 与 magpie 的一处简化：它按"最满的那个窗口"算 share（周优先，周相同才看 5 小时）；
 * 这里由调用方把最满窗口算好传进来（share / resetsAt），router 不猜窗口语义。
 */

export const ROUTING_MODES = ["smart", "order", "rotate", "usage", "pace", "weight", "fast"];

/** 90% 起给别的账号让路，98% 起等于用尽（magpie 的两道门槛）。 */
export const LOW_SHARE = 0.9;
export const FULL_SHARE = 0.98;
/** 一个窗口用到这个程度算"卡在上限"，直接不试。 */
export const HELD_SHARE = 0.999;

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

function normMode(mode) {
  const m = String(mode || "smart").toLowerCase();
  return ROUTING_MODES.includes(m) ? m : "smart";
}

/**
 * 把调用方给的一条候选（上游 / 账号 / 路由组成员）补齐成固定形状。
 *
 * @typedef {Object} Candidate
 * @property {string}  id            唯一标识，回传给调用方用
 * @property {string}  [upstream]    上游 kind（mimo / workbuddy / trae / …）
 * @property {string}  [model]       模型 ID
 * @property {boolean} [paused]      人工暂停
 * @property {boolean} [servesModel] false = 这个账号不服务这个模型
 * @property {Object}  [quota]       { share, resetsAt }  最满窗口的已用比例与重置时刻(ms)
 *                                   share 为空 = 还不知道它有多少
 * @property {number}  [restingUntil] 失败休息到什么时候(ms)
 * @property {number}  [rateLimitedAt] 上次被 429 的时刻(ms)
 * @property {number}  [lastFirstTokenMs] 最近一次首 token 耗时（fast 模式用）
 * @property {number}  [weight]      权重（weight 模式用，1..1000）
 * @property {number}  [index]       在组里的原始次序（order 模式用）
 * @property {"account"|"fallback"} [kind] 账号还是兜底模型
 */
export function normalizeCandidate(raw, index = 0) {
  const quota = raw.quota && typeof raw.quota === "object" ? raw.quota : null;
  return {
    id: String(raw.id),
    upstream: raw.upstream ? String(raw.upstream) : "",
    model: raw.model ? String(raw.model) : "",
    paused: Boolean(raw.paused),
    servesModel: raw.servesModel !== false,
    quota: quota
      ? {
          share: quota.share === null || quota.share === undefined ? null : clamp01(quota.share),
          resetsAt: Number.isFinite(quota.resetsAt) ? quota.resetsAt : null,
        }
      : null,
    restingUntil: Number.isFinite(raw.restingUntil) ? raw.restingUntil : 0,
    rateLimitedAt: Number.isFinite(raw.rateLimitedAt) ? raw.rateLimitedAt : 0,
    lastFirstTokenMs: Number.isFinite(raw.lastFirstTokenMs) ? raw.lastFirstTokenMs : null,
    weight: Number.isFinite(raw.weight) && raw.weight > 0 ? Math.min(1000, raw.weight) : 1,
    kind: raw.kind === "fallback" ? "fallback" : "account",
    index: Number.isFinite(raw.index) ? raw.index : index,
  };
}

export const shareOf = (c) => (c.quota && c.quota.share !== null ? c.quota.share : null);
export const isResting = (c, now) => c.restingUntil > now;
export const isHeld = (c) => {
  const s = shareOf(c);
  return s !== null && s >= HELD_SHARE;
};

/** 每周剩余比例 / 距重置的小时数；没有重置时间就算不出节奏。 */
export function paceOf(c, now) {
  const s = shareOf(c);
  if (s === null || !c.quota || !c.quota.resetsAt) return null;
  const hours = Math.max(1, (c.quota.resetsAt - now) / 3600_000);
  return (1 - s) / hours;
}

/**
 * 排序的桶：smart 用。返回 0..4，小的先。
 * 0 健康（<90%）· 1 未知 · 2 紧张（90–98%）· 3 将满（≥98%）· 4 已满
 */
function bucketSmart(c) {
  const s = shareOf(c);
  if (s === null) return 1;
  if (s < LOW_SHARE) return 0;
  if (s < FULL_SHARE) return 2;
  return 3;
}

/** smart：重置最早的最先，因为它剩下的额度到点就作废。 */
function compareSmart(a, b, now) {
  const d = bucketSmart(a) - bucketSmart(b);
  if (d !== 0) return d;
  const ba = bucketSmart(a);
  if (ba === 1) return a.index - b.index; // 未知的按原序，先试一次去学它
  if (ba === 0) {
    const ra = a.quota?.resetsAt ?? Number.POSITIVE_INFINITY;
    const rb = b.quota?.resetsAt ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return (shareOf(a) ?? 0) - (shareOf(b) ?? 0);
  }
  return (shareOf(a) ?? 1) - (shareOf(b) ?? 1);
}

/**
 * 平滑加权轮询（magpie 的 weight=）：每次给每个成员的当前权重加上它的权重，
 * 取最大的一个，再减去总权重。调用方要把返回的 nextWeights 存起来给下一次用，
 * 否则每轮都会从同一个成员开始。
 */
function pickWeighted(list, weights) {
  const next = { ...weights };
  let total = 0;
  let best = null;
  let bestScore = -Infinity;
  for (const c of list) {
    const w = c.weight;
    total += w;
    const score = (next[c.id] ?? 0) + w;
    next[c.id] = score;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best) next[best.id] = (next[best.id] ?? 0) - total;
  return { best, nextWeights: next };
}

/**
 * 主入口：算出这次请求该按什么顺序试。
 *
 * @param {Object} input
 * @param {Candidate[]} input.candidates
 * @param {string}  [input.routing]  smart|order|rotate|usage|pace|weight|fast
 * @param {string}  [input.stays]    auto|session|turn|off|strict
 * @param {number}  [input.now]
 * @param {{lastAnsweredId?: string}} [input.session] 这轮对话上次是谁答的
 * @param {number}  [input.turn]     rotate 用：第几轮
 * @param {boolean} [input.sink]     429 沉底开关（默认开）
 * @param {Object}  [input.weights]  weight 模式的游标，原样传回
 * @returns {{ok:boolean, order:{id:string,reason:string}[], dropped:{id:string,why:string}[],
 *            notes:string[], nextWeights:Object, keepOn:string|null}}
 */
export function chooseRoute(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const routing = normMode(input.routing);
  const stays = String(input.stays || "auto").toLowerCase();
  const sink = input.sink !== false;
  const session = input.session || {};
  const turn = Number.isFinite(input.turn) ? input.turn : 0;
  const notes = [];

  const all = (input.candidates || []).map((c, i) => normalizeCandidate(c, i));
  const dropped = [];
  const usable = [];
  for (const c of all) {
    if (c.paused) dropped.push({ id: c.id, why: "已暂停" });
    else if (!c.servesModel) dropped.push({ id: c.id, why: "不服务这个模型" });
    else if (isHeld(c)) dropped.push({ id: c.id, why: "已到额度上限" });
    else usable.push(c);
  }

  // Strict：这条对话钉在它的上游上 —— 休息、满额都不换，错误直接回给 agent。
  // （magpie 的唯一例外：Strict 会把 resting / 已满额的那个也要回来。）
  const strictId =
    stays === "strict" && session.lastAnsweredId ? String(session.lastAnsweredId) : "";
  if (strictId) {
    const pinned = all.find((c) => c.id === strictId && !c.paused && c.servesModel);
    if (pinned) {
      return {
        ok: true,
        order: [{ id: pinned.id, reason: "Strict：这条对话钉在它上面，出错也不换" }],
        dropped: all
          .filter((c) => c.id !== pinned.id)
          .map((c) => ({ id: c.id, why: "这条对话钉在别的上游上，不问别人" })),
        notes: ["Strict：不换上游，错误直接回给 agent"],
        nextWeights: { ...(input.weights || {}) },
        keepOn: pinned.id,
      };
    }
  }

  if (!usable.length) {
    return {
      ok: false,
      order: [],
      dropped,
      notes: ["没有可用上游：全部被暂停、不服务该模型，或已用尽"],
      nextWeights: { ...(input.weights || {}) },
      keepOn: null,
    };
  }

  // ── 2. 按 routing 排出主序 ────────────────────────────────────────────
  let ordered;
  let nextWeights = { ...(input.weights || {}) };
  switch (routing) {
    case "order":
      ordered = [...usable].sort((a, b) => a.index - b.index);
      notes.push("按配置顺序，前一个不失败就不换");
      break;
    case "usage":
      ordered = [...usable].sort((a, b) => (shareOf(a) ?? 0) - (shareOf(b) ?? 0) || a.index - b.index);
      notes.push("用得最少的先上");
      break;
    case "pace":
      ordered = [...usable].sort((a, b) => {
        const pa = paceOf(a, now);
        const pb = paceOf(b, now);
        if (pa === null && pb === null) return a.index - b.index;
        if (pa === null) return 1;
        if (pb === null) return -1;
        return pb - pa;
      });
      notes.push("每周剩下的额度按小时摊，摊得最宽的先上");
      break;
    case "fast":
      ordered = [...usable].sort((a, b) => {
        const fa = a.lastFirstTokenMs;
        const fb = b.lastFirstTokenMs;
        if (fa === null && fb === null) return a.index - b.index;
        if (fa === null) return 1;
        if (fb === null) return -1;
        return fa - fb;
      });
      notes.push("最近首 token 最快的先上");
      break;
    case "rotate": {
      const seq = [...usable].sort((a, b) => a.index - b.index);
      const k = ((turn % seq.length) + seq.length) % seq.length;
      ordered = [...seq.slice(k), ...seq.slice(0, k)];
      notes.push("每轮换一个成员");
      break;
    }
    case "weight": {
      const picked = pickWeighted(usable, nextWeights);
      nextWeights = picked.nextWeights;
      const rest = [...usable].filter((c) => c.id !== picked.best.id).sort((a, b) => a.index - b.index);
      ordered = [picked.best, ...rest];
      notes.push("按权重平滑轮转");
      break;
    }
    case "smart":
    default:
      ordered = [...usable].sort((a, b) => compareSmart(a, b, now));
      notes.push("健康账号里，额度重置最早的先上（剩下的到点就作废）");
      break;
  }

  // ── 3. 429 沉底 ──────────────────────────────────────────────────────
  if (sink) {
    const cool = 60_000;
    const fresh = ordered.filter((c) => !(c.rateLimitedAt && now - c.rateLimitedAt < cool));
    const limited = ordered.filter((c) => c.rateLimitedAt && now - c.rateLimitedAt < cool);
    if (limited.length && fresh.length) {
      ordered = [...fresh, ...limited];
      notes.push("刚被 429 的排到没被限流的后面");
    }
  }

  // ── 4. 兜底模型排在各账号之后 ────────────────────────────────────────
  const accounts = ordered.filter((c) => c.kind !== "fallback");
  const fallbacks = ordered.filter((c) => c.kind === "fallback");
  if (accounts.length && fallbacks.length) {
    ordered = [...accounts, ...fallbacks];
    notes.push("兜底模型排在自己的账号之后");
  }

  // ── 5. resting 沉底（但不剔除）───────────────────────────────────────
  const awake = ordered.filter((c) => !isResting(c, now));
  const resting = ordered.filter((c) => isResting(c, now));
  if (resting.length) {
    ordered = [...awake, ...resting];
    if (awake.length) notes.push("休息中的排最后；只剩它时照样试");
  }

  // ── 6. 会话粘性 ──────────────────────────────────────────────────────
  let keepOn = null;
  const lastId = session.lastAnsweredId ? String(session.lastAnsweredId) : "";
  if (lastId && stays !== "off") {
    const target = ordered.find((c) => c.id === lastId);
    if (!target) {
      notes.push("上次答这条对话的上游已不在候选里，重新挑");
    } else if (isResting(target, now)) {
      notes.push("上次那个在休息，先不回去");
    } else if ((shareOf(target) ?? 0) >= FULL_SHARE) {
      notes.push("上次那个已经用掉 98%，让位");
    } else {
      ordered = [target, ...ordered.filter((c) => c.id !== lastId)];
      keepOn = target.id;
      notes.push("这条对话上次走它，先回它（缓存还能用）");
    }
  }

  const reasons = buildReasons(ordered, { now, routing, keepOn });
  return {
    ok: true,
    order: ordered.map((c) => ({ id: c.id, reason: reasons.get(c.id) || "" })),
    dropped,
    notes,
    nextWeights,
    keepOn,
  };
}

/** 给面板/日志用的一句话理由。 */
function buildReasons(ordered, ctx) {
  const out = new Map();
  ordered.forEach((c, i) => {
    const bits = [];
    if (i === 0) bits.push("首选");
    const s = shareOf(c);
    if (s !== null) {
      const pct = Math.round(s * 100);
      const reset = c.quota?.resetsAt
        ? ` · ${fmtDelta(c.quota.resetsAt - ctx.now)}后重置`
        : "";
      bits.push(`已用 ${pct}%${reset}`);
    } else {
      bits.push("额度未知");
    }
    if (isResting(c, ctx.now)) bits.push("休息中");
    if (c.id === ctx.keepOn) bits.push("会话粘在这");
    out.set(c.id, bits.join(" · "));
  });
  return out;
}

function fmtDelta(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} 分钟`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小时`;
  return `${Math.round(h / 24)} 天`;
}

/** 只要一个：取 order 里的第一个；没有可用的时候返回 null。 */
export function pickRoute(input) {
  const r = chooseRoute(input);
  return r.ok && r.order.length ? { ...r, chosen: r.order[0].id } : { ...r, chosen: null };
}

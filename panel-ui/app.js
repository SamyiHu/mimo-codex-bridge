/* 模型桥面板 v2 —— 前端逻辑
 * 原生 JS + hash 路由。页面：概览 / 请求 / 上游 / 路由 / 模型 / 配置 / 插件
 */
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    status: null,
    config: null,
    history: [],
    historyAt: 0,
    page: "overview",
    busy: false,
    action: null,
    filter: "",
    reqFilter: "all",
    reqQuery: "",
    plugins: [],
    modelScroll: 0,
    renderKey: "",
    chartWindow: 24 * 3600 * 1000,
    chartPoints: {},
    expandedReq: null,
    chordAt: 0,
  };

  /* ── 工具 ───────────────────────────────────────────────── */
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const icon = (name, cls = "") => `<svg class="i ${cls}"><use href="#i-${name}"/></svg>`;
  const row = (k, v, cls = "") => `<div class="row"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  const dot = (kind) => `<span class="dot ${kind}"></span>`;
  const kpi = (n, label) => `<div class="kpi"><div class="n tnum">${n}</div><div class="l">${label}</div></div>`;
  const card = (title, meta, body, foot, opts = {}) => `
    <section class="card">
      ${title ? `<div class="card-head"><h2>${esc(title)}</h2>${meta ? `<div class="meta">${meta}</div>` : ""}</div>` : ""}
      <div class="card-body${opts.pad ? " pad" : ""}">${body}</div>
      ${foot ? `<div class="card-foot">${foot}</div>` : ""}
    </section>`;

  const fmtPct = (share) => (share == null ? "—" : Math.round(share * 100) + "%");
  const pctClass = (share) => (share == null ? "" : share >= 0.98 ? "err" : share >= 0.9 ? "warn" : "");
  const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
  const fmtMs = (ms) => (ms == null ? "—" : ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms");

  function fmtReset(ts) {
    if (!ts) return "";
    const minutes = Math.round((Number(ts) - Date.now()) / 60000);
    if (!Number.isFinite(minutes)) return "";
    if (minutes <= 0) return "已重置";
    if (minutes < 60) return minutes + " 分钟";
    const hours = Math.round(minutes / 60);
    return hours < 48 ? hours + " 小时" : Math.round(hours / 24) + " 天";
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("zh-CN", { hour12: false });
  }
  function fmtAgo(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "—";
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return s + " 秒前";
    if (s < 3600) return Math.round(s / 60) + " 分钟前";
    return Math.round(s / 3600) + " 小时前";
  }
  function toast(message, kind) {
    const host = $(".toasts");
    if (!host) return;
    const el = document.createElement("div");
    el.className = "toast " + (kind || "");
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), kind === "err" ? 4200 : 2400);
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制 " + (text.length > 28 ? text.slice(0, 26) + "…" : text), "ok");
    } catch {
      toast("复制失败：" + text, "err");
    }
  }

  /* ── 主题 ───────────────────────────────────────────────── */
  const themeMode = () => document.documentElement.dataset.themeMode || "system";
  const paintThemeSeg = () => $$(".seg [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === themeMode()));

  /* ── API ────────────────────────────────────────────────── */
  async function api(path, init) {
    const res = await fetch(path, { cache: "no-store", ...(init || {}) });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: res.ok ? "返回的不是 JSON" : "HTTP " + res.status };
    }
  }
  const post = (path, body) =>
    api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

  async function refresh(silent) {
    if (state.busy && !silent) return;
    try {
      state.status = await api("/api/status");
    } catch (error) {
      state.status = { offline: true, notes: [String(error)] };
    }
    const routing = state.status && state.status.routing;
    if (routing && routing.enabled && Date.now() - state.historyAt > 20000) {
      state.historyAt = Date.now();
      try {
        const history = await api("/api/history");
        state.history = Array.isArray(history.samples) ? history.samples : [];
      } catch {
        state.history = state.history || [];
      }
    }
    render();
  }

  async function loadConfig() {
    try {
      state.config = await api("/api/config");
    } catch (error) {
      state.config = { error: String(error) };
    }
    if (state.page === "config") render(true);
  }

  async function act(label, fn) {
    if (state.busy) return;
    state.busy = true;
    state.action = label;
    render(true);
    try {
      const result = await fn();
      if (result && result.ok === false) toast(result.error || label + " 失败", "err");
      else toast(label + " 完成", "ok");
    } catch (error) {
      toast(label + " 失败：" + String(error?.message ?? error), "err");
    } finally {
      state.busy = false;
      state.action = null;
      await refresh(true);
    }
  }

  /* ── 图 ─────────────────────────────────────────────────── */
  function sparkbars(values) {
    if (!values.length) return "";
    const max = Math.max(1, ...values);
    return (
      '<div class="sparkbars">' +
      values.map((v) => `<i style="height:${Math.max(6, Math.round((v / max) * 100))}%"></i>`).join("") +
      "</div>"
    );
  }

  function trafficBuckets(recent, minutes = 24) {
    const now = Date.now();
    const buckets = new Array(minutes).fill(0);
    for (const item of recent || []) {
      const t = Date.parse(item.at || "");
      if (!Number.isFinite(t)) continue;
      const idx = Math.floor((now - t) / 60000);
      if (idx >= 0 && idx < minutes) buckets[minutes - 1 - idx] += 1;
    }
    return buckets;
  }

  function quotaChart(samples, id, windowMs) {
    const span = windowMs || 24 * 3600 * 1000;
    const now = Date.now();
    const from = now - span;
    const points = (samples || []).filter((s) => s && s.id === id && s.t >= from);
    state.chartPoints[id] = points;
    if (points.length < 2) {
      return '<div class="chart-empty">历史点不够（每 5 分钟记一次，跑一会儿就有线了）</div>';
    }
    const W = 320, H = 96, P = 6;
    const x = (t) => P + ((t - from) / (now - from || 1)) * (W - P * 2);
    const y = (v) => H - P - Math.min(1, Math.max(0, v)) * (H - P * 2);
    const line = points.map((p, i) => (i ? "L" : "M") + x(p.t).toFixed(1) + " " + y(p.share).toFixed(1)).join(" ");
    const area = line + " L " + x(points[points.length - 1].t).toFixed(1) + " " + (H - P) + " L " + x(points[0].t).toFixed(1) + " " + (H - P) + " Z";
    const last = points[points.length - 1];
    const label = (ts) => new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    return (
      '<div class="chart" data-chart-id="' + esc(id) + '">' +
      '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none">' +
      '<line class="grid-line" x1="' + P + '" y1="' + y(0.9) + '" x2="' + (W - P) + '" y2="' + y(0.9) + '" stroke-dasharray="3 3"/>' +
      '<path class="area" d="' + area + '"/>' +
      '<path class="line" d="' + line + '"/>' +
      '<circle class="dotmark" cx="' + x(last.t) + '" cy="' + y(last.share) + '" r="2.6"/>' +
      '<line class="hover-line" style="display:none" y1="' + P + '" y2="' + (H - P) + '"/>' +
      '<circle class="hover-dot" r="3" style="display:none"/>' +
      "</svg>" +
      '<div class="chart-axis"><span>' + label(from) + "</span><span>现在</span></div>" +
      "</div>"
    );
  }
  function banner(kind, text, actLabel, actName) {
    return (
      '<div class="banner ' + kind + '">' +
      icon("bolt", "sm") +
      "<span>" + text + "</span>" +
      (actLabel ? '<button class="btn sm" data-act="' + actName + '" type="button">' + actLabel + "</button>" : "") +
      "</div>"
    );
  }

  function staleBanners(s) {
    const out = [];
    const bridge = s.bridge || {};
    if (bridge.online && bridge.routingSupported === false) {
      out.push(
        banner(
          "warn",
          "当前 bridge 进程还在跑旧代码（不支持多上游 / 请求流水）。重启一次 bridge 就好。",
          "重启 bridge",
          "bridgeRestart",
        ),
      );
    }
    if (s.panel && s.panel.stale) {
      out.push(
        banner(
          "info",
          "面板代码已更新（" + esc((s.panel.codeMtime || "").slice(11, 19)) + "），重启面板进程后新功能才生效。",
          null,
          null,
        ),
      );
    }
    return out.join("");
  }

  const refreshBtn = () => `<button class="btn icon" data-act="refresh" type="button" title="刷新">${icon("refresh", state.busy ? "spin" : "")}</button>`;

  /* ── 概览 ───────────────────────────────────────────────── */
  function upsCount(s) {
    const n = [s.workbuddy, s.trae, s.qoder].filter((x) => x && x.online).length + (s.bridge && s.bridge.upstreamKind === "mimo" && s.bridge.online ? 1 : 0);
    return Math.max(1, n);
  }

  function pageOverview() {
    const s = state.status || {};
    const b = s.bridge || {};
    const r = s.routing || {};
    const models = s.models || [];
    const metrics = s.metrics || {};
    const recent = (metrics.requests && metrics.requests.recent) || [];
    const latency = (metrics.latency && metrics.latency.request) || {};

    const NAMES = { mimo: "MiMo Desktop", wb: "WorkBuddy", trae: "Trae（SOLO）", qoder: "Qoder" };
    const ICONS = { mimo: "cube", wb: "plug", trae: "bolt", qoder: "code" };
    const ups = r.enabled
      ? (r.upstreams || []).map((u) => ({
          id: u.id,
          name: NAMES[u.id] || u.id,
          ic: ICONS[u.id] || "plug",
          on: !(u.health && u.health.restingUntil > Date.now()),
          detail: u.base || "端口自动发现",
        }))
      : [
          { id: "mimo", name: "MiMo Desktop", ic: "cube", on: !!(b.online && b.upstreamKind === "mimo"), detail: "本机桌面套餐 · 端口自动发现" },
          { id: "workbuddy", name: "WorkBuddy", ic: "plug", on: !!(s.workbuddy && s.workbuddy.online), detail: s.workbuddy && s.workbuddy.online ? "workbuddy2api :7863" : (s.workbuddy && s.workbuddy.detail) || "未响应" },
          { id: "trae", name: "Trae（SOLO）", ic: "bolt", on: !!(s.trae && s.trae.online), detail: s.trae && s.trae.online ? "trae2api :7864" : (s.trae && s.trae.detail) || "未响应" },
        ];
    const online = ups.filter((u) => u.on).length;
    let tightest = null;
    for (const id of Object.keys(r.quota || {})) {
      const q = r.quota[id];
      if (q && q.share != null && (tightest === null || q.share > tightest)) tightest = q.share;
    }

    const hero = `
      <div class="hero">
        <div>
          <div class="state">${dot(b.online ? "ok" : "err")} <b>${b.online ? "运行中" : "离线"}</b> · ${esc(b.upstreamKind || "无上游")}${b.chatMode ? " · " + esc(b.chatMode) : ""}</div>
          <div class="big">${models.length}<small>个模型可用</small></div>
          <div class="spark">${sparkbars(trafficBuckets(recent, 24))}</div>
        </div>
        <div class="kpis">
          ${kpi(online + "/" + ups.length, "上游在线")}
          ${kpi(Object.values(s.liveQuota || {}).reduce((n, q) => n + (Number(q.credits) || 0), 0) ? fmtNum(Object.values(s.liveQuota || {}).reduce((n, q) => n + (Number(q.credits) || 0), 0)) : "—", "可用积分")}
          ${kpi(latency.p95_ms ? fmtMs(latency.p95_ms) : "—", "P95 延迟")}
          ${kpi(fmtNum(metrics.requests ? metrics.requests.total : 0), "累计请求")}
        </div>
      </div>`;

    // 概览只留"现在在跑的那一家" + 其余几家的紧凑一行，细节都在路由页
    const lastUsed = (recent[0] && recent[0].upstream) || "";
    let current = ups.find((u) => u.id === lastUsed) || null;
    if (!current && r.enabled) {
      const alive = (r.upstreams || []).filter((u) => !(u.health && u.health.restingUntil > Date.now()));
      const pick = alive[0] || (r.upstreams || [])[0];
      if (pick) {
        current = ups.find((u) => u.id === pick.id) || { id: pick.id, name: pick.id, ic: "plug", on: true, detail: pick.base || "自动发现" };
      }
    }
    if (!current) current = ups.find((u) => u.id === b.upstreamKind) || ups.find((u) => u.on) || ups[0];
    const others = ups.filter((u) => u.id !== current.id);

    const qOf = (id) => (r.quota || {})[id] || {};
    const currentQuota = qOf(current.id);
    const currentPct = currentQuota.share == null ? null : currentQuota.share;
    const currentWidth = Math.min(100, Math.max(0, Math.round((currentPct || 0) * 100)));
    const upBody =
      `<div class="upnow">
        <div class="upnow-main">
          <span class="ic">${icon(current.ic)}</span>
          <div class="who">
            <div class="nm">${esc(current.name)}${b.upstreamKind === current.id ? ' <span class="badge">当前</span>' : ""}${current.id === lastUsed ? ' <span class="pill ok">最近在用</span>' : ""}</div>
            <div class="ds">${esc(current.detail)}</div>
          </div>
          <div class="st ${current.on ? "ok" : "err"}">${dot(current.on ? "ok" : "err")}${current.on ? "在线" : "离线"}</div>
        </div>
        ${currentPct == null ? "" : `
          <div class="upnow-quota">
            <div class="quota">
              <div class="top"><span class="pct ${pctClass(currentPct)}">${fmtPct(currentPct)}</span>${currentQuota.resetsAt ? `<span>${fmtReset(currentQuota.resetsAt)}后重置</span>` : ""}</div>
              <div class="bar ${pctClass(currentPct)}"><i style="width:${currentWidth}%"></i></div>
            </div>
          </div>`}
        <div class="upnow-others">
          <span class="k">其余 ${others.length} 家</span>
          ${others.map((u) => {
            const q = qOf(u.id);
            const pct = q.share == null ? null : q.share;
            return `<span class="chip ${u.on ? "" : "err"}">${dot(u.on ? "ok" : "err")}${esc(u.id)}${pct == null ? "" : " " + Math.round(pct * 100) + "%"}</span>`;
          }).join("")}
          <button class="btn sm quiet" data-act="goto" data-page="routing" type="button" style="margin-left:auto">路由详情 →</button>
        </div>
      </div>`;

    const quotaBody = (() => {
      const live = s.liveQuota || {};
      const ids = Object.keys(live);
      if (!ids.length) return `<div class="empty">额度数据暂不可用</div>`;
      return ids.map((id) => {
        const q = live[id] || {};
        const staticQ = (r.quota || {})[id] || {};
        const pct = staticQ.share;
        return `<div class="row"><div class="k" style="min-width:58px">${esc(id)}</div><div class="v">
          <div class="quota"><div class="top">
            <span class="pct">${fmtNum(q.credits)} 积分</span>
            <span>${q.healthy}/${q.accounts} 账号可用</span>
            ${pct != null ? `· 已用 ${Math.round(pct * 100)}%` : ""}
          </div>${pct != null ? `<div class="bar ${pctClass(pct)}"><i style="width:${Math.round(pct*100)}%"></i></div>` : ""}</div>
        </div></div>`;
      }).join("");
    })();

    const recentRows = recent.slice(0, 6).map((x) => {
      const ok = x.status >= 200 && x.status < 400;
      return `
        <div class="row">
          <div class="k" style="min-width:58px">${fmtTime(x.at)}</div>
          <div class="k mono" style="color:var(--fg-2);overflow:hidden;text-overflow:ellipsis">${esc(x.model || "—")}</div>
          <div class="v st ${ok ? "ok" : "err"}">${x.status || "—"} · ${fmtMs(x.ms)}</div>
        </div>`;
    }).join("");

    const last = s.lastAction || {};
    const codex = s.codex || {};
    const notes = Array.isArray(s.notes) ? s.notes.filter(Boolean) : [];

    const right = [
      card("额度", "实时余额", quotaBody),
      card("Codex", "", codex.missing
        ? `<div class="empty"><span class="ic">${icon("sliders")}</span>没找到 config.toml</div>`
        : row("provider", esc(codex.provider || "—") + (codex.pointsToBridge ? ' <span class="pill ok">指向 bridge</span>' : "")) + row("base_url", esc(codex.baseUrl || "—"), "mono")),
      last.label
        ? card("最近动作", fmtAgo(last.at),
            row(esc(last.label), last.state === "ok" ? '<span class="pill ok">完成</span>' : last.state === "fail" ? '<span class="pill err">失败</span>' : '<span class="pill">进行中</span>') +
            (last.detail ? row("详情", esc(last.detail), "mono") : ""))
        : "",
      notes.length ? card("提示", "", notes.map((n) => row(esc(n), "")).join("")) : "",
    ].join("");

    return staleBanners(s) + topologyCard(s) + hero +
      '<div class="cols"><div>' +
      card("当前上游", r.enabled ? (r.upstreams || []).length + " 家已接入" : "单上游模式", upBody) +
      (recent.length ? card("最近请求", recent.length + " 条", recentRows, `<button class="btn sm" data-act="goto" data-page="requests" type="button">查看全部</button>`) : "") +
      '</div><div class="stack">' + right + "</div></div>";
  }


  /* ── 拓扑图：接入方 → 模型桥 → 上游 ───────────────────────── */
  function topologyCard(s) {
    const b = s.bridge || {};
    const r = s.routing || {};
    const models = s.models || [];
    const proto = b.protocols || {};
    const recent = ((s.metrics || {}).requests || {}).recent || [];
    // 最近一条成功的请求决定"当前这条链路"，其余节点保持灰
    const last = recent.find((x) => x.status >= 200 && x.status < 400) || recent[0] || null;
    const activeClient = last ? String(last.client || "") : "";
    const activeUp = last ? String(last.upstream || "") : "";

    const seen = new Map();
    for (const item of recent) {
      const name = String(item.client || "").trim();
      if (!name) continue;
      const hit = seen.get(name) || { name, n: 0, last: 0 };
      hit.n += 1;
      hit.last = Math.max(hit.last, Date.parse(item.at || "") || 0);
      seen.set(name, hit);
    }
    const detected = [...seen.values()].sort((a, b) => b.n - a.n).slice(0, 4);
    const agents = detected.length
      ? detected.map((a) => ({ name: a.name, on: Date.now() - a.last < 10 * 60 * 1000, note: a.n + " 次请求" }))
      : [{ name: "还没有请求进来", on: false, note: "发一次请求就会出现在这里" }];

    const ups = r.enabled
      ? (r.upstreams || []).map((u) => ({
          id: u.id,
          label: u.id,
          on: !(u.health && u.health.restingUntil > Date.now()),
          note: u.base || "自动发现",
          count: models.filter((m) => String(m).startsWith(u.id + "/")).length,
        }))
      : [
          { id: "mimo", label: "mimo", on: b.upstreamKind === "mimo" && b.online, note: "MiMo Desktop", count: models.length },
          { id: "workbuddy", label: "workbuddy", on: !!(s.workbuddy && s.workbuddy.online), note: "workbuddy2api :7863", count: models.length },
          { id: "trae", label: "trae", on: !!(s.trae && s.trae.online), note: "trae2api :7864", count: models.length },
        ].slice(0, Math.max(1, upsCount(s)));

    const W = 1000, H = 320;
    const LX = 12, LW = 210, CX = 300, CW = 400, RX = 770, RW = 218;
    const nodeH = 60, gap = 16, top = 56;
    const yFor = (i) => top + i * (nodeH + gap);

    const node = (x, y, w, title, sub, on, active, extra) => {
      const stroke = active ? "var(--accent)" : "var(--line)";
      const sw = active ? 1.8 : 1;
      return `
        <g transform="translate(${x},${y})">
          <rect x="0" y="0" width="${w}" height="${nodeH}" rx="11" fill="var(--card)" stroke="${stroke}" stroke-width="${sw}" />
          <circle cx="17" cy="${nodeH / 2}" r="4" fill="${on ? "var(--ok)" : "var(--err)"}" />
          <text x="30" y="${nodeH / 2 - 7}" font-size="12.5" fill="var(--fg)" dominant-baseline="middle">${esc(title)}</text>
          <text x="30" y="${nodeH / 2 + 11}" font-size="10" fill="var(--muted)" dominant-baseline="middle">${esc(sub)}</text>
          ${active ? '<text x="' + (w - 12) + '" y="' + (nodeH / 2) + '" font-size="9.5" fill="var(--accent)" text-anchor="end" dominant-baseline="middle">当前</text>' : ""}
          ${extra || ""}
        </g>`;
    };

    const link = (x1, y1, x2, y2, active) =>
      '<path d="M' + x1 + ' ' + y1 + ' C ' + (x1 + x2) / 2 + ' ' + y1 + ', ' + (x1 + x2) / 2 + ' ' + y2 + ', ' + x2 + ' ' + y2 +
      '" fill="none" stroke="' + (active ? "var(--accent)" : "var(--line-2)") + '" stroke-width="' + (active ? 2.4 : 1.2) + '"' +
      (active ? ' stroke-dasharray="none"' : ' stroke-dasharray="3 4"') + '/>';

    const agentsHtml = agents
      .map((a, i) => {
        const active = a.name === activeClient;
        return node(LX, yFor(i), LW, a.name, a.note, a.on, active) +
          link(LX + LW, yFor(i) + nodeH / 2, CX, H / 2, active);
      })
      .join("");

    const upNodes = (ups.length ? ups : [{ id: "—", label: "—", on: false, note: "没有上游", count: 0 }]).slice(0, 3);
    const upsHtml = upNodes
      .map((u, i) => {
        const y = upNodes.length >= 3 ? yFor(i) : H / 2 - nodeH / 2 + (i - (upNodes.length - 1) / 2) * (nodeH + gap);
        const active = u.id === activeUp;
        return (
          link(CX + CW, H / 2, RX, y + nodeH / 2, active) +
          node(RX, y, RW, u.label, u.note, u.on, active,
            '<text x="' + (RW - 12) + '" y="' + (nodeH / 2) + '" font-size="10" fill="var(--muted)" text-anchor="end" dominant-baseline="middle">' + u.count + " 模型</text>")
        );
      })
      .join("");

    const lastLine = last
      ? esc(last.client || "?") + " → " + esc(last.model || "?") + " → " + esc(last.upstream || "?") +
        " · " + (last.status || "—") + " · " + fmtMs(last.ms) + " · " + fmtAgo(last.at)
      : "还没有请求；发一条就能看到当前链路";

    const center = `
      <g transform="translate(${CX},26)">
        <rect x="0" y="0" width="${CW}" height="${H - 52}" rx="15" fill="var(--card-2)" stroke="var(--line)" />
        <text x="18" y="26" font-size="13" font-weight="600" fill="var(--fg)">模型桥</text>
        <text x="18" y="44" font-size="10" fill="var(--muted)">127.0.0.1:${esc(s.bridgePort || "8788")} · ${b.online ? "运行中" : "已停止"}</text>
        <line x1="18" y1="58" x2="${CW - 18}" y2="58" stroke="var(--line)" />
        <text x="18" y="78" font-size="10" letter-spacing="0.8" fill="var(--faint)">最近一条请求</text>
        <text x="18" y="98" font-size="11.5" fill="var(--fg)">${lastLine}</text>
        <line x1="18" y1="116" x2="${CW - 18}" y2="116" stroke="var(--line)" />
        <text x="18" y="136" font-size="10.5" fill="var(--muted)">Gateway：${esc(["Chat", "Responses", proto.anthropic_messages ? "Anthropic" : "", "count_tokens"].filter(Boolean).join(" · "))}</text>
        <text x="18" y="154" font-size="10.5" fill="var(--muted)">路由组：${esc(r.enabled ? (r.groups || []).map((g) => "group/" + g.id).join(" · ") || "无" : "未启用")}</text>
        <text x="18" y="172" font-size="10.5" fill="var(--muted)">别名 ${(r.aliases || []).length} · 插件 ${state.plugins.length} · 模型 ${models.length}</text>
        <text x="18" y="${H - 68}" font-size="10" fill="var(--faint)">高亮 = 最近一次成功请求实际走的那条链路</text>
      </g>`;

    const label = (x, t) => '<text x="' + x + '" y="24" font-size="10" letter-spacing="1.4" fill="var(--faint)">' + t + "</text>";

    return `
      <section class="card">
        <div class="card-head"><h2>实时链路</h2><div class="meta">高亮的是最近一次请求真正走过的路径</div></div>
        <div class="topo">
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
            ${label(LX, "接入方")}${label(CX, "模型桥")}${label(RX, "上游")}
            ${agentsHtml}${center}${upsHtml}
          </svg>
        </div>
      </section>`;
  }

  /* ── 请求 ───────────────────────────────────────────────── */
  function pageRequests() {
    const s = state.status || {};
    const metrics = s.metrics || {};
    const recent = (metrics.requests && metrics.requests.recent) || [];
    const summary = metrics.requests || {};
    const latency = (metrics.latency && metrics.latency.request) || {};

    const byStatus = summary.by_status || {};
    let errorCount = 0;
    for (const [code, count] of Object.entries(byStatus)) {
      if (Number(code) >= 400) errorCount += Number(count) || 0;
    }
    const errorRate = summary.total ? ((errorCount / summary.total) * 100).toFixed(1) : "0.0";

    const filters = [["all", "全部"], ["err", "错误"], ["slow", "慢请求"], ["stream", "流式"]];
    const seg = filters.map(([id, label]) => `<button type="button" class="${state.reqFilter === id ? "on" : ""}" data-act="reqFilter" data-id="${id}">${label}</button>`).join("");

    const query = state.reqQuery.toLowerCase();
    const rows = recent.filter((x) => {
      if (state.reqFilter === "err" && !(x.status >= 400 || x.error)) return false;
      if (state.reqFilter === "slow" && !(x.ms >= 3000)) return false;
      if (state.reqFilter === "stream" && !x.stream) return false;
      if (query && !(String(x.model || "") + " " + String(x.upstream || "") + " " + String(x.path || "")).toLowerCase().includes(query)) return false;
      return true;
    });

    const detailFor = (x) => {
      const tokens = x.total_tokens || (x.input_tokens || 0) + (x.output_tokens || 0);
      const kv = (k, v, cls) => '<div class="kv"><div class="k2">' + k + '</div><div class="v2 ' + (cls || "") + '">' + v + "</div></div>";
      return (
        '<tr class="detail-row"><td colspan="7"><div class="detail">' +
        kv("请求 ID", esc(x.id != null ? "#" + x.id : "—"), "mono") +
        kv("路径", esc(x.path || "—"), "mono") +
        kv("上游", x.upstream ? esc(x.upstream) : "—") +
        kv("模型", esc(x.model || "—"), "mono") +
        kv("流式", x.stream ? "是" : "否") +
        kv("首字", x.first_token_ms == null ? "—" : fmtMs(x.first_token_ms)) +
        kv("总耗时", fmtMs(x.ms)) +
        kv("tokens", fmtNum(x.input_tokens || 0) + " in / " + fmtNum(x.output_tokens || 0) + " out / " + fmtNum(tokens) + " 总" + (x.estimated ? "（估算）" : "")) +
        (x.error ? '<div class="wide"><div class="err-box">' + esc(x.error) + "</div></div>" : "") +
        "</div></td></tr>"
      );
    };

    const table = rows.length
      ? '<div class="table-scroll"><table class="list">' +
        "<thead><tr><th>时间</th><th>模型</th><th>上游</th><th>状态</th><th class=\"num\">首字</th><th class=\"num\">耗时</th><th class=\"num\">tokens</th></tr></thead>" +
        "<tbody>" +
        rows.map((x) => {
          const ok = x.status >= 200 && x.status < 400;
          const ms = Number(x.ms) || 0;
          const width = Math.min(100, Math.round((ms / 8000) * 100));
          const tokens = x.total_tokens || (x.input_tokens || 0) + (x.output_tokens || 0);
          const open = state.expandedReq === x.id;
          const row =
            '<tr class="req-row ' + (open ? "open" : "") + '" data-act="reqRow" data-id="' + x.id + '">' +
            '<td class="mono">' + fmtTime(x.at) + "</td>" +
            '<td><span class="mono">' + esc(x.model || "—") + "</span>" + (x.stream ? ' <span class="chip">stream</span>' : "") + "</td>" +
            "<td>" + (x.upstream ? '<span class="pill">' + esc(x.upstream) + "</span>" : '<span class="k">—</span>') + "</td>" +
            '<td><span class="st ' + (ok ? "ok" : "err") + '">' + dot(ok ? "ok" : "err") + (x.status || "—") + "</span>" + (x.error ? ' <span class="chip err">err</span>' : "") + "</td>" +
            '<td class="num">' + (x.first_token_ms == null ? "—" : fmtMs(x.first_token_ms)) + "</td>" +
            '<td class="num"><span class="mini"><i style="width:' + width + '%"></i></span> ' + fmtMs(ms) + "</td>" +
            '<td class="num">' + fmtNum(tokens) + "</td>" +
            "</tr>";
          return open ? row + detailFor(x) : row;
        }).join("") +
        "</tbody></table></div>"
      : '<div class="empty"><span class="ic">' + icon("pulse") + "</span><div>没有符合条件的请求</div><div>调用一次 bridge 就会出现在这里（只记元信息，不留 prompt）。</div></div>";


    const toolbar = `
      <div class="toolbar">
        <div class="seg" role="group">${seg}</div>
        <div class="search" style="max-width:280px">${icon("search")}<input id="reqSearch" type="search" placeholder="搜模型 / 上游 / 路径…" value="${esc(state.reqQuery)}" /></div>
        <span class="k" style="margin-left:auto">${rows.length} / ${recent.length} 条 · 累计 ${fmtNum(summary.total || 0)}</span>
      </div>`;

    const stats = `
      <div class="stats">
        <div class="stat"><div class="top">${icon("pulse")}累计请求</div><div class="num tnum">${fmtNum(summary.total || 0)}</div><div class="hint">保留最近 ${summary.kept || 0} 条</div></div>
        <div class="stat"><div class="top">${icon("bolt")}在飞</div><div class="num tnum">${fmtNum(summary.active || 0)}<small>/ ${summary.max_concurrent || "—"}</small></div><div class="hint">并发上限</div></div>
        <div class="stat"><div class="top">${icon("clock")}P50 延迟</div><div class="num tnum">${latency.p50_ms ? fmtMs(latency.p50_ms) : "—"}</div><div class="hint">P95 ${latency.p95_ms ? fmtMs(latency.p95_ms) : "—"}</div></div>
        <div class="stat"><div class="top">${icon("x")}错误率</div><div class="num tnum">${errorRate}<small>%</small></div><div class="hint">累计 ${fmtNum(errorCount)} 次</div></div>
      </div>`;

    return stats + card("请求流水", "最近 " + recent.length + " 条", toolbar + table, `<span class="k">来自 bridge /metrics · 每 8 秒刷新</span>`);
  }


  /* ── 用量页：按模型 / 按上游 / 今日 token ─────────────────── */
  function hbars(items, unit) {
    if (!items.length) return `<div class="empty">还没有数据</div>`;
    const max = Math.max(1, ...items.map((x) => x.value));
    return (
      '<div class="hbars">' +
      items
        .map(
          (x) => `
          <div class="hbar">
            <div class="hb-label mono">${esc(x.label)}</div>
            <div class="hb-track"><i style="width:${Math.max(2, Math.round((x.value / max) * 100))}%"></i></div>
            <div class="hb-value">${fmtNum(x.value)}${unit ? " " + unit : ""}${x.sub ? ` <span class="k">${x.sub}</span>` : ""}</div>
          </div>`,
        )
        .join("") +
      "</div>"
    );
  }

  function tokenCurve(recent) {
    const now = new Date();
    const buckets = new Array(24).fill(0).map(() => ({ in: 0, out: 0 }));
    for (const x of recent) {
      const t = new Date(x.at);
      if (Number.isNaN(t.getTime())) continue;
      if (t.toDateString() !== now.toDateString()) continue;
      const h = t.getHours();
      buckets[h].in += Number(x.input_tokens) || 0;
      buckets[h].out += Number(x.output_tokens) || 0;
    }
    const max = Math.max(1, ...buckets.map((b) => b.in + b.out));
    const W = 720, H = 140, P = 16;
    const bw = (W - P * 2) / 24;
    const bars = buckets
      .map((b, i) => {
        const total = b.in + b.out;
        const hIn = ((b.in / max) * (H - P * 2)).toFixed(1);
        const hOut = ((b.out / max) * (H - P * 2)).toFixed(1);
        const x = P + i * bw + 2;
        const yIn = H - P - Number(hIn);
        const yOut = yIn - Number(hOut);
        return `
          <g>
            <rect x="${x}" y="${yIn}" width="${bw - 4}" height="${hIn}" fill="var(--accent)" opacity="0.85" rx="2" />
            <rect x="${x}" y="${yOut}" width="${bw - 4}" height="${hOut}" fill="var(--c2)" opacity="0.75" rx="2" />
            ${total ? `<title>${String(i).padStart(2, "0")}:00 · in ${fmtNum(b.in)} / out ${fmtNum(b.out)}</title>` : ""}
          </g>`;
      })
      .join("");
    const axis = [0, 6, 12, 18, 23]
      .map((h) => `<text x="${P + h * bw + bw / 2}" y="${H - 3}" font-size="9" fill="var(--faint)" text-anchor="middle">${String(h).padStart(2, "0")}:00</text>`)
      .join("");
    return `
      <div class="chart">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="var(--line-2)" />
          ${bars}
          ${axis}
        </svg>
      </div>`;
  }

  function pageUsage() {
    const s = state.status || {};
    const metrics = s.metrics || {};
    const recent = ((metrics.requests || {}).recent) || [];
    const totals = metrics.usage || {};

    const byModel = new Map();
    const byUpstream = new Map();
    let todayReqs = 0;
    let todayTokens = 0;
    let errors = 0;
    const today = new Date().toDateString();
    for (const x of recent) {
      const tokens = (Number(x.input_tokens) || 0) + (Number(x.output_tokens) || 0);
      const model = String(x.model || "—");
      const up = String(x.upstream || "—");
      const m = byModel.get(model) || { req: 0, tok: 0 };
      m.req += 1;
      m.tok += tokens;
      byModel.set(model, m);
      const u = byUpstream.get(up) || { req: 0, tok: 0 };
      u.req += 1;
      u.tok += tokens;
      byUpstream.set(up, u);
      if (new Date(x.at).toDateString() === today) {
        todayReqs += 1;
        todayTokens += tokens;
      }
      if (x.status >= 400 || x.error) errors += 1;
    }

    const topModels = [...byModel.entries()]
      .sort((a, b) => b[1].req - a[1].req)
      .slice(0, 8)
      .map(([label, v]) => ({ label, value: v.req, sub: "· " + fmtNum(v.tok) + " tok" }));
    const upList = [...byUpstream.entries()]
      .sort((a, b) => b[1].req - a[1].req)
      .map(([label, v]) => ({ label, value: v.req, sub: "· " + fmtNum(v.tok) + " tok" }));

    const successRate = recent.length ? Math.round(((recent.length - errors) / recent.length) * 100) : null;
    const stats = `
      <div class="stats">
        <div class="stat"><div class="top">${icon("pulse")}今日请求</div><div class="num tnum">${fmtNum(todayReqs)}</div><div class="hint">全部 ${fmtNum(metrics.requests ? metrics.requests.total : 0)}</div></div>
        <div class="stat"><div class="top">${icon("cube")}今日 token</div><div class="num tnum">${fmtNum(todayTokens)}</div><div class="hint">累计 ${fmtNum(totals.total_tokens || 0)}</div></div>
        <div class="stat"><div class="top">${icon("check")}成功率</div><div class="num tnum">${successRate == null ? "—" : successRate + "%"}</div><div class="hint">最近 ${recent.length} 条</div></div>
        <div class="stat"><div class="top">${icon("clock")}P95 延迟</div><div class="num tnum">${((metrics.latency || {}).request || {}).p95_ms ? fmtMs(metrics.latency.request.p95_ms) : "—"}</div><div class="hint">P50 ${((metrics.latency || {}).request || {}).p50_ms ? fmtMs(metrics.latency.request.p50_ms) : "—"}</div></div>
      </div>`;

    return stats +
      '<div class="cols"><div>' +
      card("按模型", "请求数 · 最近 " + recent.length + " 条", hbars(topModels, "次")) +
      '</div><div>' + card("按上游", "", hbars(upList, "次")) + "</div></div>" +
      card("今日 token", "按小时 · 蓝=输入 青=输出", tokenCurve(recent));
  }

  /* ── 上游 ───────────────────────────────────────────────── */
  /* ── 运行条：bridge 生命周期放在路由页顶部，不再单独占一页 ──────── */
  function runBar(s) {
    const b = s.bridge || {};
    const r = s.routing || {};
    const models = (s.models || []).length;
    const upTotal = r.enabled ? (r.upstreams || []).length : 3;
    const upOk = r.enabled
      ? (r.upstreams || []).filter((u) => !(u.health && u.health.restingUntil > Date.now())).length
      : [s.workbuddy, s.trae].filter((x) => x && x.online).length + (b.upstreamKind === "mimo" && b.online ? 1 : 0);
    return `
      <div class="runbar">
        <span class="st ${b.online ? "ok" : "err"}">${dot(b.online ? "ok" : "err")}${b.online ? "运行中" : "已停止"}</span>
        <span class="k">${b.online ? "pid " + esc(b.pid || "—") : "—"}</span>
        <span class="k">${esc(b.upstreamKind || "无上游")}${b.chatMode ? " · " + esc(b.chatMode) : ""}</span>
        <span class="k">模型 ${models}</span>
        <span class="k">上游 ${upOk}/${upTotal}</span>
        <span class="grow"></span>
        <button class="btn sm" data-act="gateway" type="button">${icon("plug", "sm")}启动网关</button>
        <button class="btn sm ${b.online ? "" : "primary"}" data-act="bridge" data-do="start" type="button">启动 bridge</button>
        <button class="btn sm" data-act="bridge" data-do="restart" type="button">重启</button>
        <button class="btn sm danger" data-act="bridge" data-do="stop" type="button">停止</button>
        ${state.action ? `<span class="pill">${esc(state.action)}…</span>` : ""}
      </div>`;
  }

  /* ── 单上游模式：三张切换卡（只在没开多上游时才有意义） ────────── */
  function legacySwitch(s) {
    const b = s.bridge || {};
    const active = b.upstreamKind || "";
    const cards = [
      { id: "mimo", name: "MiMo Desktop", ic: "cube", desc: "本机 MiMo 套餐，端口自动发现。" },
      { id: "workbuddy", name: "WorkBuddy", ic: "plug", desc: "workbuddy2api :7863，模型保留 cn: / global: 前缀。" },
      { id: "trae", name: "Trae（SOLO）", ic: "bolt", desc: "trae2api :7864，GLM / Doubao / DeepSeek 透传。" },
    ]
      .map((u) => `
        <button class="upstream ${active === u.id ? "on" : ""}" type="button" data-act="switch" data-id="${u.id}" ${state.busy ? "disabled" : ""}>
          <div class="t">${icon(u.ic)}${esc(u.name)}</div>
          <div class="d">${esc(u.desc)}</div>
          <div class="f">${active === u.id ? "当前上游" : "切到它（会重启 bridge）"}</div>
        </button>`)
      .join("");
    return `
      <section class="card">
        <div class="card-head">
          <h2>单上游模式</h2>
          <div class="meta">切换会重启 bridge · 开了多上游后这里就淘汰了</div>
        </div>
        <div class="upstreams">${cards}</div>
      </section>`;
  }

  /* ── 路由配置：启用 / 编辑 / 保存 ─────────────────────────── */
  const ROUTING_MODES = ["smart", "order", "rotate", "usage", "pace", "weight", "fast"];
  const STAYS = ["auto", "session", "turn", "off", "strict"];

  function defaultDraft() {
    return {
      upstreams: [
        { id: "mimo", kind: "mimo", base: "", tokenFile: "token.txt", capabilities: { needsDiscovery: true, modelPrefix: "mimo-desktop", reasoningEffort: "normalize", thinkingBudget: "map", fallbackModel: "mimo-desktop/mimo-v2.6-pro" } },
        { id: "wb", kind: "openai", base: "http://127.0.0.1:7863", tokenFile: "workbuddy-api-key.txt", capabilities: { chatMode: "raw", modelPassthrough: true } },
        { id: "trae", kind: "openai", base: "http://127.0.0.1:7864", tokenFile: "trae-api-key.txt", capabilities: { chatMode: "raw", modelPassthrough: true, enrichModels: "trae" } },
        { id: "qoder", kind: "openai", base: "http://127.0.0.1:7865", tokenFile: "qoder-api-key.txt", capabilities: { chatMode: "raw", modelPassthrough: true } },
      ],
      groups: [{ id: "daily", models: [], routing: "smart", stays: "auto", listed: true }],
      aliases: {},
    };
  }

  async function loadRouting(force) {
    if (state.routing && !force) return state.routing;
    try {
      state.routing = await api("/api/routing");
    } catch (error) {
      state.routing = { enabled: false, errors: [String(error)], summary: { upstreams: [], groups: [] } };
    }
    // 没有未保存的改动时，草稿跟着磁盘走；改过就别覆盖用户正在编辑的东西
    if (!state.routingDraft || !state.routingDraftDirty) {
      state.routingDraft = JSON.parse(JSON.stringify(state.routing.registry || state.routing.local || defaultDraft()));
      state.routingDraftDirty = false;
    }
    return state.routing;
  }

  // 草稿优先用已经读到的磁盘配置：从「路由组」页直接进来时 state.routing 是有的，
  // 但之前没人调 loadRouting，草稿会退回 defaultDraft()（假数据），一保存就把真配置盖掉。
  const draft = () => {
    if (state.routingDraft) return state.routingDraft;
    const fromDisk = state.routing && state.routing.registry;
    state.routingDraft = fromDisk ? JSON.parse(JSON.stringify(fromDisk)) : defaultDraft();
    return state.routingDraft;
  };

  /* ── 编辑器：上游 / 路由组 分开放，各自一页 ─────────────────── */
  function enabledHead(r) {
    return r.enabled
      ? `<span class="pill ok">已启用</span> <span class="k">${(r.summary && r.summary.upstreams || []).length} 家上游</span>`
      : `<span class="pill">未启用</span> <span class="k">保存后点「启用」，bridge 250ms 内热加载</span>`;
  }

  function upstreamRowsHtml() {
    const d = draft();
    return (d.upstreams || [])
      .map((u, i) => `
        <div class="row">
          <div class="k" style="min-width:88px"><span class="mono">${esc(u.id)}</span> <span class="badge">${esc(u.kind)}</span></div>
          <div class="v" style="display:flex;gap:6px;flex:1;justify-content:flex-end">
            <input class="minput" data-role="base" data-i="${i}" value="${esc(u.base || "")}" placeholder="base（mimo 留空=自动发现）" style="flex:1;max-width:280px" />
            <input class="minput" data-role="token" data-i="${i}" value="${esc(u.tokenFile || "")}" placeholder="token 文件" style="width:180px" />
            <button class="btn sm quiet" data-act="routingDelUpstream" data-i="${i}" type="button" title="删除">${icon("x", "sm")}</button>
          </div>
        </div>`)
      .join("") || `<div class="empty">还没有上游</div>`;
  }

  function groupCardsHtml() {
    const d = draft();
    return (d.groups || [])
      .map((g, gi) => {
        const modes = ROUTING_MODES.map(
          (m) => `<button type="button" class="${g.routing === m ? "on" : ""}" data-act="routingMode" data-g="${gi}" data-id="${m}">${m}</button>`,
        ).join("");
        const stays = STAYS.map(
          (s) => `<button type="button" class="${g.stays === s ? "on" : ""}" data-act="routingStays" data-g="${gi}" data-id="${s}">${s}</button>`,
        ).join("");
        const members = (g.models || [])
          .map((m, mi) => `<span class="chip">${esc(m)}<button class="chip-x" data-act="routingDelMember" data-g="${gi}" data-m="${mi}" type="button" title="移除">×</button></span>`)
          .join(" ");
        return `
          <div class="group-card">
            <div class="group-row">
              <input class="minput" data-role="group-id" data-g="${gi}" value="${esc(g.id)}" style="width:150px" />
              <span class="mono" style="color:var(--muted);font-size:11.5px">group/${esc(g.id)}</span>
              <button class="btn sm quiet" data-act="routingDelGroup" data-g="${gi}" type="button" style="margin-left:auto">${icon("x", "sm")}删除组</button>
            </div>
            <div class="group-row">
              <span class="eyebrow" style="width:52px">routing</span>
              <div class="seg" role="group">${modes}</div>
              <span class="eyebrow" style="width:44px;margin-left:14px">stays</span>
              <div class="seg" role="group">${stays}</div>
            </div>
            <div class="group-row" style="align-items:flex-start">
              <span class="eyebrow" style="width:52px;padding-top:6px">成员</span>
              <div style="flex:1;display:flex;flex-wrap:wrap;gap:6px;align-items:center">
                ${members || `<span class="k">还没有成员，至少加一个 provider/model</span>`}
                <span class="member-add">
                  <input class="minput" data-role="new-member" data-g="${gi}" placeholder="wb/cn:auto" style="width:200px" />
                  <button class="btn sm" data-act="routingAddMember" data-g="${gi}" type="button">添加</button>
                </span>
              </div>
            </div>
          </div>`;
      })
      .join("") || `<div class="empty"><span class="ic">${icon("route")}</span>还没有路由组</div>`;
  }

  function quotaRowsHtml() {
    const d = draft();
    const quota = (state.routing || {}).quota || {};
    return (d.upstreams || [])
      .map((u) => {
        const q = quota[u.id] || {};
        const pct = q.share == null ? "" : Math.round(q.share * 100);
        const hours = q.resetsAt ? Math.max(0, Math.round((q.resetsAt - Date.now()) / 3600000)) : "";
        return `
          <div class="row">
            <div class="k" style="min-width:70px"><span class="mono">${esc(u.id)}</span></div>
            <div class="v" style="display:flex;gap:6px;align-items:center;justify-content:flex-end">
              <input class="minput" data-role="quota-share" data-id="${esc(u.id)}" value="${esc(pct)}" placeholder="已用 %" style="width:86px" /> %
              <input class="minput" data-role="quota-hours" data-id="${esc(u.id)}" value="${esc(hours)}" placeholder="几小时后重置" style="width:120px" /> 小时
            </div>
          </div>`;
      })
      .join("");
  }

  function aliasRowsHtml() {
    const d = draft();
    const entries = Object.entries(d.aliases || {});
    if (!entries.length) {
      return `<div class="empty">没有别名。开多上游后 Codex 里的 <code>cn:xxx</code> 会失效，这里可以映射回 <code>wb/cn:xxx</code>。</div>`;
    }
    return `
      <div class="alias-grid">
        ${entries.map(([from, to], ai) => `
          <span class="alias-item">
            <span class="from">${esc(from)}</span>
            <span class="to">→</span>
            <span class="from">${esc(to)}</span>
            <button class="btn sm quiet" data-act="routingDelAlias" data-i="${ai}" type="button" title="删除">${icon("x", "sm")}</button>
          </span>`).join("")}
      </div>`;
  }

  function upstreamEditor() {
    const r = state.routing || {};
    const enabled = Boolean(r.enabled);
    return `
      <section class="card" id="routingEditor">
        <div class="card-head"><h2>上游配置</h2><div class="meta">${enabledHead(r)}</div></div>
        <div class="card-body">
          <div class="pblock">
            <div class="pblock-head">上游<button class="btn sm quiet" data-act="routingAddUpstream" type="button" style="margin-left:auto">${icon("plug", "sm")}加一家</button></div>
            <div class="rows">${upstreamRowsHtml()}</div>
          </div>
          <div class="pblock">
            <div class="pblock-head">额度（写 quota.json，可选）</div>
            <div class="rows">${quotaRowsHtml()}</div>
          </div>
        </div>
        <div class="card-foot">
          <button class="btn primary" data-act="routingSave" type="button">保存</button>
          ${enabled ? `<button class="btn danger" data-act="routingDisable" type="button">停用</button>` : `<button class="btn" data-act="routingEnable" type="button">启用多上游</button>`}
          <button class="btn quiet" data-act="routingReload" type="button">从磁盘重读</button>
          <span class="k" style="align-self:center">${esc((r.files && r.files.registry) || "upstreams.json")}</span>
        </div>
      </section>`;
  }

  function groupEditor() {
    return `
      <section class="card" id="groupEditor">
        <div class="card-head"><h2>编辑路由组</h2><div class="meta">保存即生效（bridge 250ms 热加载）</div></div>
        <div class="card-body">
          <div style="padding:10px 14px 14px;display:flex;flex-direction:column;gap:10px">${groupCardsHtml()}</div>
        </div>
        <div class="card-foot">
          <button class="btn primary" data-act="routingSave" type="button">保存</button>
          <button class="btn" data-act="routingAddGroup" type="button">${icon("route", "sm")}加一组</button>
          <button class="btn quiet" data-act="routingReload" type="button">从磁盘重读</button>
        </div>
      </section>`;
  }

  /* ── 路由草稿编辑 ───────────────────────────────────────── */
  function draftUpdate(event) {
    const el = event.target;
    const role = el.getAttribute("data-role");
    if (!role) return;
    state.routingDraftDirty = true;
    const d = draft();
    const i = Number(el.getAttribute("data-i"));
    const gi = Number(el.getAttribute("data-g"));
    if (role === "base") d.upstreams[i].base = el.value.trim();
    if (role === "token") d.upstreams[i].tokenFile = el.value.trim();
    if (role === "group-id") d.groups[gi].id = el.value.trim();
    if (role === "new-member") d.groups[gi].__newMember = el.value.trim();
  }

  async function collectAndSaveRouting() {
    // 草稿没读进来就保存 = 拿 defaultDraft() 覆盖 upstreams.json，先补一次读盘
    if (!state.routing) await loadRouting(true);
    if (!state.routing) {
      toast("路由配置还没读进来，先点「从磁盘重读」", "err");
      return { ok: false, error: "routing not loaded" };
    }
    const d = draft();
    for (const u of d.upstreams || []) delete u.__newMember;
    for (const g of d.groups || []) delete g.__newMember;
    const result = await post("/api/routing", d);
    if (result.ok) {
      state.routingDraftDirty = false;
      await loadRouting(true);
      toast("upstreams.json 已保存", "ok");
    } else {
      toast("保存失败：" + (result.errors || []).join("；"), "err");
    }
    return result;
  }

  async function saveQuotaFromEditor() {
    // 只有「上游」页才有额度输入。没有就别 POST {}（会把 quota.json 清空），也别在
    // 这里抛异常——以前 $() 返回单个元素/null，.forEach 直接把整个保存流程打断。
    const shares = $$("[data-role='quota-share']");
    if (!shares.length) return { ok: true, skipped: true };
    const hours = $$("[data-role='quota-hours']");
    const quota = {};
    shares.forEach((input) => {
      const id = input.getAttribute("data-id");
      const share = Number(input.value);
      const hEl = hours.find((el) => el.getAttribute("data-id") === id);
      const h = Number(hEl ? hEl.value : NaN);
      const hasHours = Number.isFinite(h) && h > 0;
      if (!input.value && !hasHours) return;
      quota[id] = {
        share: Number.isFinite(share) ? Math.min(1, Math.max(0, share / 100)) : null,
        resetsAt: hasHours ? Date.now() + h * 3600000 : null,
      };
    });
    const result = await post("/api/quota", quota);
    if (result.ok) toast("quota.json 已写入", "ok");
    else toast("quota 写入失败：" + (result.error || ""), "err");
    return result;
  }

  /* ── 路由 ───────────────────────────────────────────────── */
  function pageRouting() {
    const s = state.status || {};
    const r = s.routing || {};
    const banners = staleBanners(s);
    const bar = runBar(s);
    if (!r.enabled) {
      return banners + bar + legacySwitch(s) + upstreamEditor();
    }

    const recentReqs = ((state.status || {}).metrics || {}).requests && ((state.status || {}).metrics.requests.recent) || [];
    const upstreamCards = (r.upstreams || []).map((u) => {
      const q = (r.quota || {})[u.id] || {};
      const pct = q.share == null ? null : q.share;
      const resting = u.health && u.health.restingUntil > Date.now();
      const modelCount = ((state.status || {}).models || []).filter((m) => String(m).startsWith(u.id + "/")).length;
      const mine = recentReqs.filter((x) => x.upstream === u.id);
      const liveBal = ((state.status || {}).liveQuota || {})[u.id] || null;
      const avg = mine.length ? Math.round(mine.reduce((a, x) => a + (Number(x.ms) || 0), 0) / mine.length) : null;
      const errs = mine.filter((x) => x.status >= 400 || x.error).length;
      const caps = [];
      if (u.capabilities && u.capabilities.chatMode === "raw") caps.push("raw");
      if (u.capabilities && u.capabilities.nativeResponses) caps.push("native responses");
      if (u.capabilities && u.capabilities.modelPassthrough) caps.push("模型透传");
      if (u.capabilities && u.capabilities.needsDiscovery) caps.push("自动发现");
      if (u.capabilities && u.capabilities.enrichModels) caps.push("倍率装饰");
      return `
        <div class="card">
          <div class="card-head">
            <h2><span class="mono">${esc(u.id)}</span></h2>
            <span class="badge">${esc(u.kind)}</span>
            <div class="meta">${resting ? `<span class="pill warn">休息中</span>` : `<span class="pill ok">可用</span>`}</div>
          </div>
          <div class="card-body pad">
            <div class="quota">
              <div class="top">
                ${pct == null
                  ? `<span class="pct">${liveBal ? fmtNum(liveBal.credits) + " 积分" : "额度未知"}</span><span>${liveBal ? (q.budget ? "预算 " + fmtNum(q.budget) : "未设预算") : "写 quota.json 或设预算"}</span>`
                  : `<span class="pct ${pctClass(pct)}">${fmtPct(pct)}</span>${q.resetsAt ? `<span>${fmtReset(q.resetsAt)}后重置</span>` : ""}`}
              </div>
              <div class="bar ${pctClass(pct)}"><i style="width:${Math.min(100, Math.max(0, Math.round((pct || 0) * 100)))}%"></i></div>
              ${liveBal && liveBal.accounts ? `<div class="k" style="font-size:10.5px">${liveBal.healthy}/${liveBal.accounts} 个账号可用</div>` : ""}
            </div>
            <div class="up-stats">
              <div><b>${modelCount}</b><span>模型</span></div>
              <div><b>${mine.length}</b><span>近期请求</span></div>
              <div><b>${avg == null ? "—" : fmtMs(avg)}</b><span>平均延迟</span></div>
              <div><b class="${errs ? "err" : ""}">${errs}</b><span>错误</span></div>
            </div>
            <div class="up-caps">${caps.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>
            <div class="k mono" style="margin-top:8px">${esc(u.base || "自动发现")}</div>
          </div>
          ${quotaChart(state.history, u.id, state.chartWindow)}
        </div>`;
    }).join("");

    const windows = [
      [3600000, "1 小时"],
      [86400000, "24 小时"],
      [604800000, "7 天"],
    ];
    const windowBar =
      '<div class="toolbar" style="border:1px solid var(--line);border-radius:12px;background:var(--card);margin-bottom:14px">' +
      '<span class="eyebrow">额度曲线时间窗</span>' +
      '<div class="seg" role="group">' +
      windows.map(([ms, label]) => `<button type="button" class="${state.chartWindow === ms ? "on" : ""}" data-act="chartWindow" data-id="${ms}">${label}</button>`).join("") +
      "</div>" +
      '<span class="k" style="margin-left:auto">每 5 分钟一个点 · 保留 7 天</span></div>';

    const groupRows = (r.groups || [])
      .map((g) => row(`<span class="mono">group/${esc(g.id)}</span>`, `<span class="pill">${esc(g.routing)}</span> ${(g.models || []).length} 个成员`))
      .join("");
    return banners + bar + windowBar + `<div class="cards-grid">${upstreamCards}</div>` +
      card("路由组", (r.groups || []).length + " 个", groupRows || `<div class="empty"><span class="ic">${icon("route")}</span>还没有路由组</div>`, `<button class="btn sm" data-act="goto" data-page="groups" type="button">管理路由组 →</button>`) +
      upstreamEditor();
  }


  /* ── 路由组页：一条请求怎么被分下去 ─────────────────────── */
  function groupFlow(r, group, decisions, recent) {
    const quota = r.quota || {};
    const upstreams = r.upstreams || [];
    const gid = "group/" + group.id;
    const mine = recent.filter((x) => String(x.model || "") === gid);
    const groupDecisions = decisions.filter((d) => d.model === gid);
    const last = [...decisions].reverse().find((d) => d.model === gid) || null;
    const lastGroup = [...decisions].reverse().find((d) => d.model === gid);

    const memberRow = (m) => {
      const upId = String(m).includes("/") ? String(m).split("/")[0] : "";
      const up = upstreams.find((u) => u.id === upId);
      const q = quota[upId] || {};
      const resting = up && up.health && up.health.restingUntil > Date.now();
      const answered = lastGroup && lastGroup.chosen === upId;
      const status = answered
        ? 'answered'
        : resting
          ? "休息中 · " + Math.max(0, Math.round((up.health.restingUntil - Date.now()) / 1000)) + "s"
          : q.share == null
            ? "可用"
            : "已用 " + Math.round(q.share * 100) + "%";
      return `
        <div class="rv-member ${answered ? "on" : ""}">
          <span class="dot ${resting ? "warn" : "ok"}"></span>
          <span class="mono rv-id">${esc(m)}</span>
          <span class="rv-status ${answered ? "ok" : resting ? "warn" : ""}">${esc(status)}</span>
        </div>`;
    };

    const agents = [
      { name: "Codex", on: Boolean((state.status || {}).codex && (state.status || {}).codex.pointsToBridge) },
      { name: "Claude Code", on: Boolean((state.status || {}).bridge && (state.status || {}).bridge.protocols && (state.status || {}).bridge.protocols.anthropic_messages) },
      { name: "其他兼容客户端", on: mine.length > 0 },
    ];

    const members = (group.models || []).map(memberRow).join("") || `<div class="k">没有成员</div>`;

    const errors = mine.filter((x) => x.status >= 400 || x.error).length;
    const requestCount = mine.length || groupDecisions.length;
    const rerouted = decisions.filter((d) => d.model === gid && d.order && d.order[0] && d.order[0].id.split("::")[0] !== d.chosen).length;

    const explain = lastGroup
      ? `
        <div class="rv-explain">
          <div class="rv-explain-title">最近一次路由 <span class="k">${fmtAgo(lastGroup.at)}</span></div>
          <ul>
            <li>模型 <span class="mono">${esc(lastGroup.model)}</span>${lastGroup.pinned ? "（已钉住）" : ""}</li>
            <li>顺序：${(lastGroup.order || []).map((o) => esc(o.id)).join(" → ") || "—"}</li>
            <li>选中 <span class="mono">${esc(lastGroup.chosen)}</span>${lastGroup.reason ? " · " + esc(lastGroup.reason) : ""}</li>
            ${(lastGroup.notes || []).map((n) => `<li class="dim">${esc(n)}</li>`).join("")}
          </ul>
        </div>`
      : `<div class="rv-explain"><div class="rv-explain-title">还没有这条组的路由记录</div><div class="k">用 <code>${esc(gid)}</code> 发一次请求就能看到决策过程。</div></div>`;

    return `
      <div class="routing-viz">
        <div class="rv-col">
          <div class="rv-cap">接入方</div>
          ${agents.map((a) => `
            <div class="rv-agent">
              <span class="dot ${a.on ? "ok" : "err"}"></span>
              <div><div class="rv-name">${esc(a.name)}</div><div class="rv-sub mono">${esc(gid)}</div></div>
            </div>`).join("")}
        </div>
        <div class="rv-core">
          <div class="rv-logo">${icon("logo", "lg")}</div>
          <div class="rv-core-name">模型桥</div>
          <div class="rv-core-sub">127.0.0.1:${esc((state.status || {}).bridgePort || "8788")}</div>
          <div class="rv-mode">${esc(group.routing)}</div>
          <div class="rv-core-sub">stays=${esc(group.stays || "auto")}</div>
        </div>
        <div class="rv-col rv-members-col">
          <div class="rv-cap">成员 · ${(group.models || []).length}</div>
          ${members}
        </div>
      </div>
      <div class="rv-foot">
        <span class="rv-lead">${esc(((group.models || [])[0]) || "—")} 先上</span>
        <span class="grow"></span>
        <span class="rv-stat"><b>${requestCount}</b>请求</span>
        <span class="rv-stat"><b>${rerouted}</b>换过家</span>
        <span class="rv-stat"><b>${errors}</b>错误</span>
      </div>
      ${explain}`;
  }

  function groupViewCards(r) {
    const quota = r.quota || {};
    const upstreams = r.upstreams || [];
    return (r.groups || [])
      .map((g) => {
        const members = (g.models || [])
          .map((m) => {
            const upId = String(m).includes("/") ? String(m).split("/")[0] : "";
            const up = upstreams.find((u) => u.id === upId);
            const q = quota[upId] || {};
            const resting = up && up.health && up.health.restingUntil > Date.now();
            const pct = q.share == null ? "" : " " + Math.round(q.share * 100) + "%";
            return `<span class="chip ${resting ? "err" : ""}">${dot(resting ? "err" : "ok")}${esc(m)}${pct}</span>`;
          })
          .join(" ");
        return `
          <div class="group-view">
            <div class="group-view-head">
              <span class="mono gid">group/${esc(g.id)}</span>
              <span class="pill">${esc(g.routing)}</span>
              ${g.stays ? `<span class="pill">stays=${esc(g.stays)}</span>` : ""}
              <button class="btn sm quiet" data-act="copy" data-text="group/${esc(g.id)}" type="button" style="margin-left:auto">${icon("copy", "sm")}复制 ID</button>
            </div>
            <div class="group-view-body">${members || `<span class="k">没有成员</span>`}</div>
          </div>`;
      })
      .join("");
  }


  function pageGroups() {
    const s = state.status || {};
    const r = s.routing || {};
    const banners = staleBanners(s);

    if (!r.enabled) {
      return banners + card("路由组", "未启用多上游",
        `<div class="empty">
          <span class="ic">${icon("route")}</span>
          <div>路由组要开了多上游才有意义：它把几个模型合成一个 <code>group/&lt;id&gt;</code>，让 bridge 自己挑。</div>
          <div>先去「上游」页点「启用多上游」，再回来建组。</div>
        </div>`,
        `<button class="btn primary" data-act="goto" data-page="upstreams" type="button">去上游页启用</button>`);
    }

    const groups = r.groups || [];
    const decisions = r.recentDecisions || [];
    const recent = ((s.metrics || {}).requests || {}).recent || [];
    const selected = groups.find((g) => g.id === state.groupSel) || groups[0] || null;

    const tabs = groups
      .map((g) => `<button type="button" class="rv-tab ${selected && g.id === selected.id ? "on" : ""}" data-act="pickGroup" data-id="${esc(g.id)}">group/${esc(g.id)}<span class="k">${esc(g.routing)}</span></button>`)
      .join("");

    const memberCount = groups.reduce((n, g) => n + (g.models || []).length, 0);
    const modes = groups.map((g) => g.routing).filter((v, i, a) => a.indexOf(v) === i).join(" · ") || "—";
    const staysList = groups.map((g) => g.stays).filter((v, i, a) => a.indexOf(v) === i).join(" · ") || "—";
    const stats = `
      <div class="stats">
        <div class="stat"><div class="top">${icon("route")}路由组</div><div class="num tnum">${groups.length}</div><div class="hint">Codex 里写 group/&lt;id&gt;</div></div>
        <div class="stat"><div class="top">${icon("cube")}成员</div><div class="num tnum">${memberCount}</div><div class="hint">可选 ${(r.upstreams || []).length} 家上游</div></div>
        <div class="stat"><div class="top">${icon("bolt")}调度模式</div><div class="num tnum" style="font-size:14px">${esc(modes)}</div><div class="hint">每组的 routing</div></div>
        <div class="stat"><div class="top">${icon("swap")}会话保持</div><div class="num tnum" style="font-size:14px">${esc(staysList)}</div><div class="hint">每组的 stays</div></div>
      </div>`;

    const flowCard = `<section class="card">
        <div class="card-head">
          <h2>路由过程</h2>
          <div class="meta">${groups.length} 个路由组 · 最近 ${decisions.length} 次决策</div>
        </div>
        <div class="rv-tabs">${tabs}</div>
        ${selected ? groupFlow(r, selected, decisions, recent) : `<div class="empty">还没有路由组</div>`}
      </section>`;
    const groupCards = card("已配置的路由组", groups.length + " 个", `<div class="group-views">${groupViewCards(r) || `<div class="empty">还没有路由组</div>`}</div>`);
    return banners + stats +
      '<div class="cols cols-wide"><div>' + flowCard + groupCards + '</div><div class="stack">' + groupEditor() + "</div></div>";
  }

  /* ── 模型（虚拟列表） ───────────────────────────────────── */
  function modelDetail(s, id) {
    if (!id) return "";
    const details = s.modelDetails || [];
    const raw = details.find((m) => m && m.id === id) || null;
    const upId = String(id).includes("/") ? String(id).split("/")[0] : "";
    const up = ((s.routing || {}).upstreams || []).find((u) => u.id === upId);
    const group = ((s.routing || {}).groups || []).find((g) => "group/" + g.id === id);
    const aliasTarget = ((s.routing || {}).registry || {}).aliases ? null : null;
    const kv = (k, v, mono) => '<div class="kv"><div class="k2">' + k + '</div><div class="v2 ' + (mono ? "mono" : "") + '">' + v + "</div></div>";
    const fields = raw
      ? Object.entries(raw)
          .filter(([k]) => k !== "id")
          .map(([k, v]) => kv(k, esc(typeof v === "object" ? JSON.stringify(v) : String(v)), k !== "owned_by"))
          .join("")
      : '<div class="k">上游没回这个模型的原始字段</div>';
    return card(
      "模型详情",
      "",
      '<div class="detail">' +
        kv("模型 ID", esc(id), true) +
        kv("上游", up ? esc(up.id + " · " + (up.base || "自动发现")) : group ? "路由组" : "—") +
        (group ? kv("组成员", esc(group.models.join(", ")), true) : "") +
        (group ? kv("调度", esc(group.routing + " · stays=" + group.stays)) : "") +
        kv("字段数", String(raw ? Object.keys(raw).length : 0)) +
        '</div><div class="detail" style="border-top:1px solid var(--line-2);padding-top:10px">' + fields + "</div>",
      '<button class="btn sm quiet" data-act="copy" data-text="' + esc(id) + '" type="button">复制 ID</button>',
    );
  }

  function pageModels() {
    const s = state.status || {};
    const models = s.models || [];
    const filter = state.filter.toLowerCase();
    const shown = models.filter((m) => !filter || String(m).toLowerCase().includes(filter));
    const body = `
      <div class="toolbar">
        <div class="search">${icon("search")}<input id="modelFilter" type="search" placeholder="过滤模型…（${models.length} 个）" value="${esc(state.filter)}" /></div>
        <span class="k">${shown.length} / ${models.length}</span>
      </div>
      <div class="vlist" id="vlist"><div class="pad" id="vpad"></div></div>`;
    const sel = state.modelSel && shown.includes(state.modelSel) ? state.modelSel : shown[0];
    const detail = modelDetail(s, sel);
    const aliasCard = card(
      "别名映射",
      (state.routing && state.routing.aliases ? state.routing.aliases.length : Object.keys((draft().aliases || {})).length) + " 条 · 旧模型名 → provider/model",
      '<div class="alias-scroll">' + aliasRowsHtml() + "</div>",
      `<button class="btn sm" data-act="routingAutoAliases" type="button">${icon("bolt", "sm")}按当前模型自动生成</button>` +
        '<button class="btn sm primary" data-act="routingSave" type="button">保存</button>' +
        '<span class="k" style="align-self:center">开多上游后裸模型名靠这里活着</span>',
    );
    return '<div class="cols cols-wide"><div>' +
      card("可用模型", "点一行看上游参数", body, `<span class="k">来自 bridge /v1/models · 共 ${models.length} 个</span>`) +
      aliasCard +
      '</div><div class="stack" id="modelDetailPane">' + detail + "</div></div>";
  }

  /** 只重绘右栏详情：避免整页 render() 让左侧列表闪烁、滚动条跳回顶部 */
  function refreshModelDetail() {
    const pane = $("#modelDetailPane");
    if (!pane) { render(true); return; }
    const s = state.status || {};
    const models = s.models || [];
    const filter = state.filter.toLowerCase();
    const shown = models.filter((m) => !filter || String(m).toLowerCase().includes(filter));
    const sel = state.modelSel && shown.includes(state.modelSel) ? state.modelSel : shown[0];
    pane.innerHTML = modelDetail(s, sel);
  }

  const ROW_H = 30;
  function mountModelList() {
    const box = $("#vlist");
    const pad = $("#vpad");
    if (!box || !pad) return;
    const models = (state.status || {}).models || [];
    const filter = state.filter.toLowerCase();
    const items = models.filter((m) => !filter || String(m).toLowerCase().includes(filter));
    pad.style.height = items.length * ROW_H + "px";
    const rendered = new Map();

    const paint = () => {
      const top = box.scrollTop;
      const height = box.clientHeight || 420;
      const from = Math.max(0, Math.floor(top / ROW_H) - 6);
      const to = Math.min(items.length, Math.ceil((top + height) / ROW_H) + 6);
      for (const [i, el] of rendered) {
        if (i < from || i >= to) {
          el.remove();
          rendered.delete(i);
        }
      }
      for (let i = from; i < to; i += 1) {
        if (rendered.has(i)) continue;
        const el = document.createElement("div");
        el.className = "vrow";
        el.style.top = i * ROW_H + "px";
        el.innerHTML = '<div class="idx">' + (i + 1) + "</div><code>" + esc(items[i]) + "</code>" + icon("copy", "sm copy");
        el.title = "点击复制 " + items[i];
        el.addEventListener("click", () => {
        state.modelSel = items[i];
        paintSelection();
        refreshModelDetail();
      });
      el.addEventListener("dblclick", () => copyText(items[i]));
        pad.appendChild(el);
        rendered.set(i, el);
      }
      state.modelScroll = top;
      paintSelection();
    };

    function paintSelection() {
      for (const [i, el] of rendered) el.classList.toggle("on", items[i] === state.modelSel);
    }

    box.addEventListener("scroll", paint, { passive: true });
    box.scrollTop = state.modelScroll || 0;
    paint();
  }

  function mountCharts() {
    let tip = document.getElementById("chartTip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "chartTip";
      tip.className = "chart-tip";
      document.body.appendChild(tip);
    }

    $$(".chart[data-chart-id]").forEach((box) => {
      const id = box.getAttribute("data-chart-id");
      const points = state.chartPoints[id] || [];
      const svg = box.querySelector("svg");
      if (!svg || points.length < 2) return;
      const line = svg.querySelector(".hover-line");
      const dot = svg.querySelector(".hover-dot");
      const span = state.chartWindow;
      const now = Date.now();
      const from = now - span;

      const move = (event) => {
        const rect = svg.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        const target = from + ratio * span;
        let best = points[0];
        for (const p of points) if (Math.abs(p.t - target) < Math.abs(best.t - target)) best = p;
        const W = 320, H = 96, P = 6;
        const x = P + ((best.t - from) / (now - from || 1)) * (W - P * 2);
        const y = H - P - Math.min(1, Math.max(0, best.share)) * (H - P * 2);
        line.setAttribute("x1", x);
        line.setAttribute("x2", x);
        line.style.display = "";
        dot.setAttribute("cx", x);
        dot.setAttribute("cy", y);
        dot.style.display = "";
        tip.textContent = Math.round(best.share * 100) + "% · " + new Date(best.t).toLocaleTimeString("zh-CN", { hour12: false });
        tip.style.left = event.clientX + "px";
        tip.style.top = rect.top + (y / H) * rect.height + "px";
        tip.classList.add("on");
      };
      const leave = () => {
        line.style.display = "none";
        dot.style.display = "none";
        tip.classList.remove("on");
      };
      box.addEventListener("mousemove", move);
      box.addEventListener("mouseleave", leave);
    });
  }
  /* ── 配置 ───────────────────────────────────────────────── */
  function pageConfig() {
    const c = state.config || {};
    const fields = [
      { id: "cfgUrl", label: "WorkBuddy 网关地址", value: c.workbuddyUrl, ph: "http://127.0.0.1:7863" },
      { id: "cfgTraeUrl", label: "Trae 网关地址", value: c.traeUrl, ph: "http://127.0.0.1:7864" },
      { id: "cfgDir", label: "工作目录", value: c.gatewayDir, ph: "C:\\Users\\你\\.workbuddy2api" },
      { id: "cfgTraeDir", label: "Trae 网关目录", value: c.traeDir, ph: "C:\\Users\\你\\.trae2api" },
      { id: "cfgKey", label: "API Key", value: c.apiKey, ph: "workbuddy2api 的 api_key", type: "password", wide: true },
    ];
    const form = fields.map((f) => `
      <label class="${f.wide ? "wide" : ""}">
        <span>${esc(f.label)}</span>
        <input id="${f.id}" type="${f.type || "text"}" spellcheck="false" placeholder="${esc(f.ph)}" value="${esc(f.value || "")}" />
      </label>`).join("");

    const bits = [];
    if (c.gatewayExeExists != null) bits.push(c.gatewayExeExists ? "网关可执行文件已找到" : "网关可执行文件缺失");
    if (c.apiKeySet != null) bits.push(c.apiKeySet ? "API Key 已配置" : "API Key 未配置");
    if (c.gatewayApiKey) bits.push(c.gatewayApiKeyMatch ? "与网关 config.json 一致" : "与网关 config.json 不一致");
    if (c.bridgeSecretSet != null) bits.push(c.bridgeSecretSet ? "bridge-secret 已配置" : "bridge-secret 缺失");

    return card("WorkBuddy / Trae 网关", "面板与 bridge 共用这份配置",
      `<div class="form">${form}</div>`,
      `<button class="btn primary" data-act="saveConfig" type="button">保存配置</button>
      <button class="btn" data-act="reloadConfig" type="button">重新加载</button>
      <span class="k" style="align-self:center">${esc(bits.join(" · "))}</span>`, { pad: true });
  }

  /* ── 路由表 ─────────────────────────────────────────────── */
  const PAGES = {
    overview: { title: "概览", sub: "bridge、上游、额度的一屏摘要", render: pageOverview },
    requests: { title: "请求", sub: "最近经过 bridge 的请求流水（只记元信息）", render: pageRequests },
    usage: { title: "用量", sub: "按模型 / 按上游 / 今日 token", render: pageUsage },
    upstreams: { title: "上游", sub: "每家上游的额度曲线、配置与别名", render: pageRouting },
    groups: { title: "路由组", sub: "把几个模型合成一个 group/<id>，让 bridge 自己挑", render: pageGroups },
    models: { title: "模型", sub: "bridge 对外暴露的模型清单", render: pageModels },
    config: { title: "配置", sub: "WorkBuddy / Trae 网关地址与密钥", render: pageConfig },
  };

  const currentPage = () => {
    const hash = (location.hash || "").replace(/^#\/?/, "");
    if (!hash) return "overview";
    if (hash.startsWith("plugin/")) return hash;
    if (hash === "routing") return "upstreams";
    return PAGES[hash] ? hash : "overview";
  };

  function navHtml() {
    const s = state.status || {};
    const r = s.routing || {};
    const reqs = (s.metrics || {}).requests || {};
    const items = [
      ["overview", "dash", "概览", ""],
      ["requests", "pulse", "请求", reqs.total ? (reqs.total > 999 ? Math.round(reqs.total / 1000) + "k" : String(reqs.total)) : ""],
      ["usage", "pulse", "用量", ""],
      ["upstreams", "plug", "上游", r.enabled ? String((r.upstreams || []).length) : ""],
      ["groups", "route", "路由组", r.enabled ? String((r.groups || []).length) : ""],
      ["models", "cube", "模型", String((s.models || []).length)],
      ["config", "sliders", "配置", ""],
    ];
    let html = items.map(([id, ic, label, tag]) => `
      <a href="#/${id}" class="${state.page === id ? "on" : ""}">${icon(ic)}${esc(label)}${tag ? `<span class="tag">${esc(tag)}</span>` : ""}</a>`).join("");
    if (state.plugins.length) {
      html += '<div class="label">插件</div>';
      html += state.plugins.map((p) => `<a href="#/plugin/${p.index}" class="${state.page === "plugin/" + p.index ? "on" : ""}">${icon("plug")}${esc(p.title)}</a>`).join("");
    }
    return html;
  }

  /* ── 渲染 ───────────────────────────────────────────────── */
  function parkPluginCard() {
    if (!state.activeCard) return;
    const source = $("#plugin-source");
    if (source && state.activeCard.parentElement !== source) source.appendChild(state.activeCard);
    state.activeCard = null;
  }

  function render(force) {
    state.page = currentPage();
    const nav = $("#nav");
    if (nav) nav.innerHTML = navHtml();
    paintThemeSeg();

    const head = $("#pageHead");
    const body = $("#pageBody");
    if (!head || !body) return;

    if (state.page.startsWith("plugin/")) {
      const index = Number(state.page.split("/")[1]);
      const plugin = state.plugins[index];
      if (state.activeCard && state.activeCard !== (plugin && plugin.card)) parkPluginCard();
      const mounted =
        body.dataset.plugin === String(index) &&
        $("#pluginHost") &&
        state.activeCard === (plugin && plugin.card);
      if (mounted) return;
      const title = plugin ? plugin.title : "插件";
      head.innerHTML =
        '<div class="titles"><h1>' + esc(title) + '</h1><div class="sub">面板插件 · panel-plugins/</div></div>' +
        '<div class="tools">' + refreshBtn() + "</div>";
      body.dataset.plugin = String(index);
      body.innerHTML = pluginInfoCard(plugin) + '<div id="pluginHost"></div>';
      if (plugin) {
        $("#pluginHost").appendChild(plugin.card);
        state.activeCard = plugin.card;
      }
      return;
    }

    parkPluginCard();
    delete body.dataset.plugin;

    const page = PAGES[state.page] || PAGES.overview;
    head.innerHTML = `<div class="titles"><h1>${esc(page.title)}</h1><div class="sub">${esc(page.sub)}</div></div><div class="tools">${refreshBtn()}</div>`;

    const key = state.page + "|" + JSON.stringify([state.filter, state.reqFilter, state.reqQuery, state.history.length]) + "|" + JSON.stringify(state.status, (k, v) => (k === "time" ? undefined : v));
    if (!force && key === state.renderKey) return;
    state.renderKey = key;

    body.innerHTML = page.render();
    if (state.page === "upstreams" || state.page === "models" || state.page === "groups") {
      if (!state.routing) void loadRouting().then(() => render(true));
    }
    if (state.page === "upstreams") mountCharts();

    if (state.page === "models") {
      mountModelList();
      const filter = $("#modelFilter");
      if (filter) {
        filter.addEventListener("input", (event) => {
          state.filter = event.target.value || "";
          state.modelScroll = 0;
          const caret = event.target.selectionStart;
          render(true);
          const next = $("#modelFilter");
          if (next) {
            next.focus();
            next.setSelectionRange(caret, caret);
          }
        });
      }
    }
    if (state.page === "requests") {
      const search = $("#reqSearch");
      if (search) {
        search.addEventListener("input", (event) => {
          state.reqQuery = event.target.value || "";
          const caret = event.target.selectionStart;
          render(true);
          const next = $("#reqSearch");
          if (next) {
            next.focus();
            next.setSelectionRange(caret, caret);
          }
        });
      }
    }
  }

  /* ── 事件 ───────────────────────────────────────────────── */
  document.addEventListener("click", (event) => {
    const segBtn = event.target.closest?.(".seg [data-mode]");
    if (segBtn) {
      window.__setTheme?.(segBtn.dataset.mode);
      paintThemeSeg();
      return;
    }
    const el = event.target.closest?.("[data-act]");
    if (!el) return;
    const name = el.getAttribute("data-act");

    if (name === "refresh") return void refresh();
    if (name === "copy") return void copyText(el.getAttribute("data-text") || "");
    if (name === "goto") {
      location.hash = "#/" + el.getAttribute("data-page");
      return;
    }
    if (name === "reqRow") {
      const id = Number(el.getAttribute("data-id"));
      state.expandedReq = state.expandedReq === id ? null : id;
      return void render(true);
    }
    if (name === "chartWindow") {
      state.chartWindow = Number(el.getAttribute("data-id")) || 86400000;
      return void render(true);
    }
    if (name === "help") {
      showHelp();
      return;
    }
    if (name === "reqFilter") {
      state.reqFilter = el.getAttribute("data-id");
      return void render(true);
    }
    if (name === "switch") {
      const id = el.getAttribute("data-id");
      return void act("切换到 " + id, () => post("/api/switch", { upstream: id }));
    }
    if (name === "bridge") {
      const what = el.getAttribute("data-do");
      return void act("bridge " + what, () => post("/api/bridge", { action: what }));
    }
    if (name === "gateway") return void act("启动网关", () => post("/api/gateway", {}));
    if (name === "bridgeRestart") return void act("重启 bridge", () => post("/api/bridge", { action: "restart" }));
    if (name === "saveConfig") {
      const body = {};
      const map = [["cfgUrl", "workbuddyUrl"], ["cfgDir", "gatewayDir"], ["cfgKey", "apiKey"], ["cfgTraeUrl", "traeUrl"], ["cfgTraeDir", "traeDir"]];
      for (const [id, key] of map) body[key] = $("#" + id)?.value.trim() || "";
      return void act("保存配置", () => post("/api/config", body));
    }
    if (name === "reloadConfig") {
      void loadConfig();
      toast("配置已重新读取", "ok");
    }
  });

  function showHelp() {
    if (document.getElementById("helpMask")) return;
    const rowsData = [
      ["g 然后 o", "去概览"],
      ["g 然后 q", "去请求"],
      ["g 然后 u", "去上游"],
      ["g 然后 r", "去路由"],
      ["g 然后 m", "去模型"],
      ["g 然后 c", "去配置"],
      ["r", "刷新状态"],
      ["/", "聚焦搜索框"],
      ["Esc", "关闭面板 / 清空搜索"],
      ["?", "打开这个面板"],
    ];
    const mask = document.createElement("div");
    mask.className = "sheet-mask";
    mask.id = "helpMask";
    mask.innerHTML =
      '<div class="sheet"><h3>键盘快捷键</h3><div class="rows">' +
      rowsData.map(([k, v]) => '<div class="row"><div class="k"><kbd>' + k + '</kbd></div><div class="v">' + v + "</div></div>").join("") +
      "</div></div>";
    mask.addEventListener("click", (event) => {
      if (event.target === mask || event.target.closest(".sheet") === null) mask.remove();
    });
    document.body.appendChild(mask);
  }

  function onKeydown(event) {
    const target = event.target;
    const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (event.key === "Escape") {
      const mask = document.getElementById("helpMask");
      if (mask) mask.remove();
      if (typing) {
        target.value = "";
        if (state.page === "models") state.filter = "";
        if (state.page === "requests") state.reqQuery = "";
        target.blur();
        render(true);
      }
      return;
    }
    if (typing) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "?") {
      event.preventDefault();
      showHelp();
      return;
    }
    if (event.key === "/") {
      const input = state.page === "requests" ? $("#reqSearch") : state.page === "models" ? $("#modelFilter") : null;
      if (input) {
        event.preventDefault();
        input.focus();
      }
      return;
    }
    if (state.chordAt && Date.now() - state.chordAt < 1200) {
      state.chordAt = 0;
      const map = { o: "overview", q: "requests", u: "upstreams", r: "routing", m: "models", c: "config" };
      const page = map[event.key];
      if (page) {
        event.preventDefault();
        location.hash = "#/" + page;
      }
      return;
    }
    if (event.key === "g") {
      state.chordAt = Date.now();
      return;
    }
    if (event.key === "r") {
      event.preventDefault();
      void refresh();
    }
  }

  /* ── 路由编辑器的交互 ───────────────────────────────────── */
  async function reloadRoutingDraft() {
    state.routingDraft = null;
    state.routingDraftDirty = false;
    await loadRouting(true);
    render(true);
  }

  document.addEventListener("input", (event) => {
    // 「路由组」页的编辑器 id 是 #groupEditor，之前只认 #routingEditor，改组 id 改了也不进草稿
    if (event.target.closest && event.target.closest("#routingEditor, #groupEditor")) draftUpdate(event);
  });

  document.addEventListener("click", async (event) => {
    const el = event.target.closest ? event.target.closest("[data-act]") : null;
    if (!el) return;
    const name = el.getAttribute("data-act");
    // pickGroup 是「路由组」页顶部的组标签，不带 routing 前缀，之前被这条前缀过滤整个丢掉
    if (!name || (name !== "pickGroup" && name.indexOf("routing") !== 0)) return;
    // 除「重读 / 保存」外的路由编辑动作都算未保存改动，否则下一次轮询读盘会把刚点的改动盖回去
    if (name.indexOf("routing") === 0 && name !== "routingReload" && name !== "routingSave") {
      state.routingDraftDirty = true;
    }
    const d = draft();
    const gi = Number(el.getAttribute("data-g"));
    const i = Number(el.getAttribute("data-i"));
    event.preventDefault();

    if (name === "routingSave") {
      await saveQuotaFromEditor();
      await act("保存路由配置", collectAndSaveRouting);
      return;
    }
    if (name === "routingEnable") {
      await act("启用多上游", async () => {
        const saved = await post("/api/routing", d);
        if (saved.ok === false) return saved;
        return post("/api/routing/enable", {});
      });
      await reloadRoutingDraft();
      return;
    }
    if (name === "routingDisable") {
      await act("停用多上游", () => post("/api/routing/disable", {}));
      await reloadRoutingDraft();
      return;
    }
    if (name === "routingReload") {
      await reloadRoutingDraft();
      toast("已从磁盘重读", "ok");
      return;
    }
    if (name === "routingAddUpstream") {
      d.upstreams.push({ id: "new" + (d.upstreams.length + 1), kind: "openai", base: "", tokenFile: "", capabilities: { chatMode: "raw", modelPassthrough: true } });
      return void render(true);
    }
    if (name === "routingDelUpstream") {
      d.upstreams.splice(i, 1);
      return void render(true);
    }
    if (name === "routingAutoAliases") {
      const d0 = draft();
      const s = state.status || {};
      const bridge = s.bridge || {};
      const upstreamId = bridge.upstreamKind || (d0.upstreams[0] && d0.upstreams[0].id) || "";
      const target = d0.upstreams.find((u) => u.id === upstreamId) || d0.upstreams[0];
      d0.aliases = d0.aliases || {};
      for (const model of s.models || []) {
        if (String(model).includes("/")) continue;
        if (target) d0.aliases[model] = target.id + "/" + model;
      }
      state.routingDraftDirty = true;
      return void render(true);
    }
    if (name === "pickGroup") {
      state.groupSel = el.getAttribute("data-id");
      return void render(true);
    }
    if (name === "routingToggleAliases") {
      state.aliasesExpanded = !state.aliasesExpanded;
      return void render(true);
    }
    if (name === "routingDelAlias") {
      const keys = Object.keys(draft().aliases || {});
      const key = keys[Number(el.getAttribute("data-i"))];
      if (key) delete draft().aliases[key];
      state.routingDraftDirty = true;
      return void render(true);
    }
    if (name === "routingAddGroup") {
      d.groups.push({ id: "group" + (d.groups.length + 1), models: [], routing: "smart", stays: "auto", listed: true });
      return void render(true);
    }
    if (name === "routingDelGroup") {
      d.groups.splice(gi, 1);
      return void render(true);
    }
    if (name === "routingMode") {
      d.groups[gi].routing = el.getAttribute("data-id");
      return void render(true);
    }
    if (name === "routingStays") {
      d.groups[gi].stays = el.getAttribute("data-id");
      return void render(true);
    }
    if (name === "routingAddMember") {
      const input = $("[data-role='new-member'][data-g='" + gi + "']");
      const value = (input && input.value.trim()) || "";
      if (!value) return toast("先写一个 provider/model", "err");
      d.groups[gi].models = d.groups[gi].models || [];
      if (!d.groups[gi].models.includes(value)) d.groups[gi].models.push(value);
      return void render(true);
    }
    if (name === "routingDelMember") {
      const mi = Number(el.getAttribute("data-m"));
      d.groups[gi].models.splice(mi, 1);
      return void render(true);
    }
  });


  const PLUGIN_INFO = {
    "Trae 账号池": {
      what: "管理 trae2api 的账号池：登录、导入凭证、启停、签到与倍率",
      backend: "trae2api :7864",
      routes: "/accounts · /login · /patch · /credits · /import · /models",
      data: "账号与积分存 trae2api；面板只转发",
    },
    "WorkBuddy 积分": {
      what: "账号池、用量统计、模型倍率、积分日报（走 workbuddy2api 的 credit 工具）",
      backend: "workbuddy2api :7863",
      routes: "/accounts · /login · /report · /checkin · /rates",
      data: "积分与台账在 workbuddy2api；面板只转发",
    },
    "WorkBuddy 自动任务": {
      what: "签到 / 成长任务的定时开关，改完要重启网关才生效",
      backend: "workbuddy2api :7863",
      routes: "/tasks · /toggle · /run · /restart",
      data: "任务配置写在网关的 config.json",
    },
  };

  function pluginInfoCard(plugin) {
    const info = PLUGIN_INFO[plugin && plugin.title];
    if (!info) return "";
    const kv = (k, v, mono) => `<div class="pi"><div class="k2">${k}</div><div class="v2 ${mono ? "mono" : ""}">${v}</div></div>`;
    return `
      <section class="card">
        <div class="card-head"><h2>这个插件做什么</h2><div class="meta">panel-plugins/</div></div>
        <div class="plugin-info">
          ${kv("作用", esc(info.what))}
          ${kv("后端", info.backend, true)}
          ${kv("接口", info.routes, true)}
          ${kv("数据", esc(info.data))}
        </div>
      </section>`;
  }


  /* ── 通用弹层：替代 alert()/prompt()，插件里直接调用 ─────────── */
  function sheet(title, bodyHtml, actions) {
    const mask = document.createElement("div");
    mask.className = "sheet-mask";
    mask.innerHTML =
      '<div class="sheet"><h3>' + esc(title) + "</h3>" +
      '<div class="sheet-body">' + bodyHtml + "</div>" +
      '<div class="sheet-foot">' + actions.map((a, i) => '<button class="btn ' + (a.kind || "") + '" data-sheet="' + i + '" type="button">' + esc(a.label) + "</button>").join("") + "</div></div>";
    document.body.appendChild(mask);
    return new Promise((resolve) => {
      mask.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-sheet]");
        if (!btn) {
          if (event.target === mask) {
            mask.remove();
            resolve(null);
          }
          return;
        }
        const action = actions[Number(btn.getAttribute("data-sheet"))];
        mask.remove();
        resolve(action && action.value !== undefined ? action.value : null);
      });
    });
  }


  /** 表格里点模型时调用：拿 bridge 记的原始字段 + 我们的解析结果。 */
  window.__uiModelInfo = function (id) {
    const s = state.status || {};
    const details = s.modelDetails || [];
    const target = String(id || "");
    const raw =
      details.find((m) => m && m.id === target) ||
      details.find((m) => m && String(m.id).endsWith("/" + target.replace(/^[^/]*\//, ""))) ||
      null;
    const modelId = raw ? raw.id : target;
    const kv = (k, v) => '<div class="kv"><div class="k2">' + k + '</div><div class="v2">' + esc(v == null ? "—" : String(v)) + "</div></div>";
    const SKIP = new Set(["id", "object", "created", "created_at", "owned_by", "ownedBy"]);
    const HUMAN = [
      ["上下文", (m) => { const n = Number(m.context_length || m.max_allowed_size || 0); return n > 0 ? (n >= 1000 ? Math.round(n / 1000) + "K" : String(n)) : ""; }],
      ["最大输出", (m) => (Number(m.max_output_tokens || 0) > 0 ? String(m.max_output_tokens) : "")],
      ["推理强度", (m) => m.reasoning_effort || ""],
      ["图片", (m) => (m.supports_images ? "支持" : "")],
      ["工具调用", (m) => (m.supports_tool_call ? "支持" : "")],
      ["vendor", (m) => m.vendor || m.owned_by || ""],
    ];
    let body = '<div class="detail">' + kv("模型 ID", modelId);
    if (raw) {
      body += HUMAN.map(([label, pick]) => { const v = pick(raw); return v ? kv(label, v) : ""; }).join("");
      body += Object.entries(raw)
        .filter(([k, v]) => !SKIP.has(k) && HUMAN.every(([label]) => label !== k) && v != null && v !== "" && v !== 0)
        .filter(([k]) => !["context_length", "max_allowed_size", "max_output_tokens", "reasoning_effort", "supports_images", "supports_tool_call", "vendor", "description"].includes(k))
        .map(([k, v]) => kv(k, typeof v === "object" ? JSON.stringify(v) : v))
        .join("");
      if (raw.description) body += '<div class="kv"><div class="k2">说明</div><div class="v2">' + esc(raw.description) + "</div></div>";
    } else {
      body += '<div class="k">上游没回这个模型的字段</div>';
    }
    body += "</div>";
    void sheet("模型参数", body, [{ label: "关闭", kind: "primary", value: true }]);
  };

  window.__uiAlert = function (title, text) {
    void sheet(title || "提示", '<pre class="sheet-text">' + esc(text == null ? "" : String(text)) + "</pre>", [{ label: "知道了", kind: "primary", value: true }]);
  };

  window.__uiPrompt = function (title, label, defaultValue) {
    const id = "sheetPromptInput";
    const promise = sheet(
      title || "输入",
      '<label class="sheet-field"><span>' + esc(label || "") + "</span>" +
        '<input id="' + id + '" type="text" value="' + esc(defaultValue || "") + '" /></label>',
      [
        { label: "取消", value: null },
        { label: "确定", kind: "primary", value: "__ok__" },
      ],
    );
    setTimeout(() => {
      const input = document.getElementById(id);
      if (input) {
        input.focus();
        input.select();
      }
    }, 30);
    return promise.then((result) => {
      if (result !== "__ok__") return null;
      const input = document.getElementById(id);
      return input ? input.value : null;
    });
  };


  function pluginSideCard(plugin) {
    const s = state.status || {};
    const title = String((plugin && plugin.title) || "");
    // 插件标题里带哪家就认哪家；认不出来按 WorkBuddy 处理（历史行为）
    const upId = title.indexOf("Trae") >= 0 ? "trae" : title.indexOf("Qoder") >= 0 ? "qoder" : "wb";
    const up = ((s.routing || {}).upstreams || []).find((u) => u.id === upId);
    const live = ((s.liveQuota || {})[upId]) || null;
    const models = (s.models || []).filter((m) => String(m).startsWith(upId + "/")).length;
    const recent = ((s.metrics || {}).requests || {}).recent || [];
    const mine = recent.filter((x) => x.upstream === upId);
    const gateway = upId === "trae" ? s.trae : upId === "qoder" ? s.qoder : s.workbuddy;
    const kv = (k, v, cls) => '<div class="row"><div class="k">' + k + '</div><div class="v ' + (cls || "") + '">' + v + "</div></div>";
    // Qoder 边车不结算积分，余额/账号走它自己的 healthz
    const accountLine = upId === "qoder"
      ? (gateway && gateway.online ? (gateway.accounts || 0) + " 个已登录" : "—")
      : live ? live.healthy + " / " + live.accounts + " 可用" : "—";
    return card(
      "后端状态",
      up ? esc(up.base || "自动发现") : "",
      kv("网关", (gateway && gateway.online ? '<span class="pill ok">在线</span>' : '<span class="pill err">离线</span>')) +
        kv("模型", models + " 个") +
        kv("近期请求", fmtNum(mine.length) + " 次") +
        (upId === "qoder" ? "" : kv("余额", live ? fmtNum(live.credits) + " 积分" : "—")) +
        kv("账号", accountLine),
    );
  }

  /* ── 插件卡片 ───────────────────────────────────────────── */
  function adoptPlugins() {
    const source = $("#plugin-source");
    if (!source) return;
    const cards = Array.from(source.children).filter((el) => el.matches("section.card"));
    state.plugins = cards.map((cardEl, index) => {
      const title = cardEl.querySelector("h2")?.textContent || "插件 " + (index + 1);
      cardEl.classList.add("plugin-card");
      return { index, title: title.replace(/（插件）$/, "").trim(), card: cardEl };
    });
  }

  /* ── 自检 ───────────────────────────────────────────────── */
  async function selftest() {
    const results = [];
    const pages = Object.keys(PAGES).concat(state.plugins.map((p) => "plugin/" + p.index));

    const measure = (page) => {
      const main = $(".main");
      const wrap = $(".wrap");
      let overflow = 0;
      const bad = [];
      $$("#pageBody .card, #pageBody .stat, #pageBody .upstream, #pageBody table.list, #pageBody .hero").forEach((el) => {
        if (el.scrollWidth > el.clientWidth + 2) {
          overflow += 1;
          bad.push((String(el.className || "").split(" ")[0] || el.tagName) + "+" + (el.scrollWidth - el.clientWidth));
        }
      });
      const navOn = $(".nav a.on");
      return {
        page,
        title: $("#pageHead h1")?.textContent || "",
        cards: $$("#pageBody .card").length,
        rows: $$("#pageBody .row").length,
        tableRows: $$("#pageBody tbody tr").length,
        overflowX: overflow,
        bad,
        sideW: Math.round($(".side").getBoundingClientRect().width),
        mainW: main ? main.clientWidth : 0,
        wrapW: wrap ? Math.round(wrap.getBoundingClientRect().width) : 0,
        bodyFont: getComputedStyle(document.body).fontSize,
        navOnBg: navOn ? getComputedStyle(navOn).backgroundColor : "",
        vrows: $$("#vlist .vrow").length,
        charts: $$("#pageBody .chart svg").length,
        rateOverflow: (() => {
          const el = $("#wbc-rates") || $("#wtr-rates");
          return el ? el.scrollWidth > el.clientWidth + 2 : null;
        })(),
        rateChips: $$("#wbc-rates .wrc-chip, #wtr-rates .wrc-chip").length,
        models: (state.status?.models || []).length,
        probe: (() => {
          const hero = $("#pageBody .hero");
          const cardEl = $("#pageBody .card");
          const head = $(".head-wrap");
          const cs = hero ? getComputedStyle(hero) : null;
          return {
            heroCols: cs ? cs.gridTemplateColumns : "",
            heroRadius: cardEl ? getComputedStyle(cardEl).borderRadius : "",
            headSticky: head ? getComputedStyle(head).position : "",
            cardShadow: cardEl ? getComputedStyle(cardEl).boxShadow.slice(0, 40) : "",
          };
        })(),
      };
    };

    for (const page of pages) {
      location.hash = "#/" + page;
      await new Promise((r) => setTimeout(r, 70));
      render(true);
      await new Promise((r) => setTimeout(r, 100));
      results.push(measure(page));
    }

    location.hash = "#/models";
    await new Promise((r) => setTimeout(r, 70));
    render(true);
    await new Promise((r) => setTimeout(r, 140));
    const box = $("#vlist");
    if (box) {
      box.scrollTop = box.scrollHeight;
      box.dispatchEvent(new Event("scroll"));
      await new Promise((r) => setTimeout(r, 200));
      const rows = $$("#vlist .vrow");
      results.push({
        page: "models@bottom",
        vrows: rows.length,
        firstIdx: rows[0] ? rows[0].querySelector(".idx").textContent : "",
        scrollTop: Math.round(box.scrollTop),
        models: (state.status?.models || []).length,
      });
    }

    // 交互自检：图表悬停 / 快捷键 / 帮助面板
    location.hash = "#/routing";
    await new Promise((r) => setTimeout(r, 120));
    render(true);
    await new Promise((r) => setTimeout(r, 140));
    const chart = $("#pageBody .chart");
    let tipOn = false;
    if (chart) {
      const rect = chart.getBoundingClientRect();
      chart.dispatchEvent(new MouseEvent("mousemove", { clientX: rect.left + rect.width * 0.6, clientY: rect.top + rect.height / 2, bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      const tip = document.getElementById("chartTip");
      tipOn = Boolean(tip && tip.classList.contains("on"));
    }
    const chartPoints = Object.keys(state.chartPoints).length;

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "g", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const afterChord = location.hash;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    const helpOpen = Boolean(document.getElementById("helpMask"));
    if (helpOpen) document.getElementById("helpMask").remove();
    results.push({ page: "interactions", tipOn, chartPoints, afterChord, helpOpen });

    location.hash = "#/overview";
    await new Promise((r) => setTimeout(r, 70));
    render(true);
    const pre = document.createElement("pre");
    pre.id = "selftest";
    pre.textContent = JSON.stringify(results, null, 2);
    pre.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(pre);
    document.title = "selftest done";
  }

  window.addEventListener("unhandledrejection", (event) => {
    const pre = document.getElementById("selftest") || document.createElement("pre");
    pre.id = "selftest";
    pre.textContent = "REJECTION: " + String((event.reason && event.reason.stack) || event.reason || "unknown");
    pre.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(pre);
  });

  window.addEventListener("error", (event) => {
    const pre = document.getElementById("selftest") || document.createElement("pre");
    pre.id = "selftest";
    pre.textContent = "ERROR: " + (event.message || "") + " @ " + (event.filename || "") + ":" + (event.lineno || "");
    pre.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(pre);
  });

  /* ── 启动 ───────────────────────────────────────────────── */
  async function boot() {
    adoptPlugins();
    document.addEventListener("keydown", onKeydown);
    await refresh(true);
    await loadConfig();
    window.addEventListener("hashchange", () => render(true));
    setInterval(() => {
      if (document.hidden || state.busy) return;
      if (state.page.startsWith("plugin/")) return;
      void refresh(true);
    }, 8000);
    if (/[?&]selftest=1/.test(location.search)) void selftest();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else void boot();
})();

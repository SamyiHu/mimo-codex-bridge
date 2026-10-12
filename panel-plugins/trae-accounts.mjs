#!/usr/bin/env node
/**
 * trae-accounts.mjs — 控制面板插件：Trae 账号池统一管理（对齐 trae2api 自带 /admin 控制台）。
 *
 * 能力：
 *   - 账号列表（脱敏）自动轮询：积分、启停/冷却/硬禁用/临过期、错误计数
 *   - 面板内 OAuth 登录闭环：发起登录 → 展示授权链接（回调由网关 :18080 接收并自动落盘）
 *     → 轮询 pending 结果 → 成功即入池；可取消
 *   - 凭证 JSON 脱敏预览（/admin/api/accounts/{uid}/json）
 *   - 软启停 / 改昵称 / 删除 / 手动刷新 token
 *   - 积分/签到实查（上游实时额度 + 签到状态 + Work 积分）
 *   - 模型倍率（直连 SOLO 模型目录解析 consumption_rate，服务端缓存 10 分钟）
 *   - 手动签到（面板直连 TRAE ug 域：status → claim → 查积分；凭证读 traeDir/auths）
 *     网关本身没有手动签到端点，每日 9 点调度签之外的补签由本插件完成。
 *   - 凭证导入：粘贴登录回调链接或 JSON
 * 写操作经面板服务端代理注入 TW2A_API_KEY，key 不进浏览器。
 */
import fs from "node:fs";
import path from "node:path";

const TRAE_KEY_FILE = "trae-api-key.txt"; // 相对 bridge 目录

// TRAE ug 域（api.trae.cn）签到/积分接口常量，与 trae2api upstream/constants.go 同源。
// 网关不提供手动签到端点，签到由面板直连上游完成（凭证读 trae2api 的 auths/）。
const UG_HOST = "https://api.trae.cn";
const EP_CHECKIN_STATUS = "/trae/api/v2/ug/checkin_credits/status";
const EP_CHECKIN_CLAIM = "/trae/api/v2/ug/checkin_credits/claim";
const EP_ENT_USAGE = "/trae/api/v2/pay/ide_user_ent_usage";
const TRAE_UA = "Trae/0.1.52";

// SOLO agent 域（模型目录）。trae2api 的 /v1/models 只透出模型名，
// 消耗倍率（display_contact_config.consumption_rate）由面板直连上游解析。
const AGENT_HOST = "https://trae-api-cn.mchost.guru";
const EP_MODELS = "/api/ide/v1/get_detail_param";
const TRAE_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
const TRAE_IDE_VERSION = "0.1.52";
const TRAE_IDE_VERSION_CODE = "20260811";

export default {
  id: "trae-accounts",
  title: "Trae 账号池",
  init({ registerRoute, registerCard, settings, readText, DIR }) {
    const keyFile = path.join(DIR, TRAE_KEY_FILE);

    /** 服务端代理到 trae2api；写操作自动带 Bearer TW2A_API_KEY */
    async function proxy(method, sub, body, timeoutMs = 15000) {
      const s = settings();
      const key = readText(keyFile);
      const headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (key) headers["Authorization"] = `Bearer ${key}`;
      const r = await fetch(`${s.traeUrl}${sub}`, {
        method,
        headers,
        body: body === undefined ? undefined : String(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await r.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
      return { ok: r.ok, status: r.status, payload };
    }

    registerRoute("GET", "/accounts", async (req, res, { json }) => {
      const s = settings();
      try {
        const r = await proxy("GET", "/admin/api/accounts", undefined, 8000);
        if (!r.ok) return json(res, 200, { ok: false, error: `trae2api HTTP ${r.status}` });
        return json(res, 200, { ok: true, accounts: r.payload?.accounts ?? [], adminUrl: `${s.traeUrl}/admin` });
      } catch (error) {
        return json(res, 200, { ok: false, error: `trae2api 不可达（${s.traeUrl}）` });
      }
    });

    registerRoute("GET", "/credits", async (req, res, { json }) => {
      const s = settings();
      try {
        // 上游逐号实查额度 + 签到状态，多账号时会慢
        const r = await proxy("GET", "/admin/api/credits", undefined, 90000);
        if (!r.ok) return json(res, 200, { ok: false, error: `trae2api HTTP ${r.status}` });
        const list = Array.isArray(r.payload) ? r.payload : (r.payload?.accounts ?? []);
        return json(res, 200, { ok: true, credits: list, at: new Date().toISOString() });
      } catch (error) {
        return json(res, 200, { ok: false, error: `查询失败：${String(error).slice(0, 160)}` });
      }
    });

    registerRoute("POST", "/patch", async (req, res, { json, readBody }) => {
      const body = await readBody(req);
      const uid = String(body.uid || "");
      if (!uid) return json(res, 400, { ok: false, error: "missing uid" });
      const patch = {};
      if (body.enabled != null) patch.enabled = Boolean(body.enabled);
      if (body.nickname != null) patch.nickname = String(body.nickname);
      if (!Object.keys(patch).length) return json(res, 400, { ok: false, error: "nothing to patch" });
      try {
        const r = await proxy("PATCH", `/admin/api/accounts/${encodeURIComponent(uid)}`, JSON.stringify(patch));
        return json(res, 200, { ok: r.ok, status: r.status, payload: r.payload });
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error).slice(0, 160) });
      }
    });

    registerRoute("POST", "/delete", async (req, res, { json, readBody }) => {
      const body = await readBody(req);
      const uid = String(body.uid || "");
      if (!uid) return json(res, 400, { ok: false, error: "missing uid" });
      try {
        const r = await proxy("DELETE", `/admin/api/accounts/${encodeURIComponent(uid)}`);
        return json(res, 200, { ok: r.ok, status: r.status, payload: r.payload });
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error).slice(0, 160) });
      }
    });

    registerRoute("POST", "/refresh", async (req, res, { json, readBody }) => {
      const body = await readBody(req);
      const uid = String(body.uid || "");
      if (!uid) return json(res, 400, { ok: false, error: "missing uid" });
      try {
        const r = await proxy(
          "POST",
          `/admin/api/accounts/${encodeURIComponent(uid)}/refresh`,
          "{}",
          30000,
        );
        return json(res, 200, { ok: r.ok, status: r.status, payload: r.payload });
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error).slice(0, 160) });
      }
    });

    // ── 手动签到：直连 TRAE 上游（网关只读凭证，签到我们自己补） ──
    // 语义对齐 trae2api scheduler.RunCheckinNow：status → 未签且可签则 claim → 查积分。
    // uid 缺省遍历 auths/ 全部账号；凭证实时读盘（网关 refresh 后落盘，天然同步）。

    /** 读 auths/ 下全部账号凭证（兼容嵌套形 {auth,account} 与扁平形） */
    function loadAuths() {
      const dir = path.join(settings().traeDir || path.join(process.env.USERPROFILE || "", ".trae2api"), "auths");
      if (!fs.existsSync(dir)) return [];
      const out = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith("trae-") || !f.endsWith(".json")) continue;
        let obj;
        try {
          obj = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        } catch {
          continue;
        }
        const rec = obj?.auth
          ? {
              accessToken: obj.auth.accessToken,
              deviceId: obj.auth.deviceId,
              machineId: obj.auth.machineId,
              uid: obj.account?.uid,
              nickname: obj.account?.nickname,
            }
          : {
              accessToken: obj?.accessToken,
              deviceId: obj?.deviceId,
              machineId: obj?.machineId,
              uid: obj?.uid,
              nickname: obj?.nickname,
            };
        if (!rec.accessToken || !rec.uid) continue;
        out.push(rec);
      }
      return out;
    }

    async function ugPost(ep, auth, body = "{}", timeoutMs = 15000) {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": TRAE_UA,
        Authorization: `Cloud-IDE-JWT ${auth.accessToken}`,
        "X-User-Region": "CN",
      };
      if (auth.deviceId) headers["X-Device-Id"] = auth.deviceId;
      const r = await fetch(`${UG_HOST}${ep}`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 120)}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`非 JSON 响应：${text.slice(0, 120)}`);
      }
    }

    /** SOLO agent 域请求（对齐 trae2api SOLOHeaders，非流式形态） */
    async function soloPost(ep, auth, body, timeoutMs = 15000) {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": TRAE_UA,
        Authorization: `Cloud-IDE-JWT ${auth.accessToken}`,
        "X-App-Id": TRAE_APP_ID,
        "X-App-Version": "default",
        "X-Ide-Version": TRAE_IDE_VERSION,
        "X-Ide-Version-Code": TRAE_IDE_VERSION_CODE,
        "X-App-Version-Code": TRAE_IDE_VERSION_CODE,
        "X-Ide-Version-Type": "stable",
        "X-Device-Type": "macos",
        "X-OS-Version": "macOS 15.7.4",
        "X-Device-Brand": "Apple",
        "Request-Traffic-Type": "prod",
      };
      if (auth.uid) headers["X-Uid"] = auth.uid;
      if (auth.machineId) headers["X-Machine-Id"] = auth.machineId;
      if (auth.deviceId) headers["X-Device-Id"] = auth.deviceId;
      const r = await fetch(`${AGENT_HOST}${ep}`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 120)}`);
      return JSON.parse(text);
    }

    // 模型倍率：直连 SOLO get_detail_param，解析 display_contact_config.consumption_rate。
    // 目录稳定，内存缓存 10 分钟，避免每次轮询都打上游。
    let modelsCache = { at: 0, rows: null };
    registerRoute("GET", "/models", async (req, res, { json }) => {
      try {
        if (modelsCache.rows && Date.now() - modelsCache.at < 10 * 60 * 1000) {
          return json(res, 200, { ok: true, models: modelsCache.rows, cached: true });
        }
        const auth = loadAuths()[0];
        if (!auth) return json(res, 200, { ok: false, error: "auths/ 里没有凭证" });
        const data = await soloPost(
          EP_MODELS,
          auth,
          JSON.stringify({
            function: "solo_work_lite",
            config_names: null,
            need_prompt: false,
            current_config_info: null,
            poly_prompt: true,
            mode_type: null,
            agent_type: null,
          }),
        );
        const rows = [];
        for (const e of data.config_info_list || []) {
          let rate = null;
          try {
            const cc = JSON.parse(e.display_contact_config || "{}");
            if (cc?.consumption_rate?.enable) rate = cc.consumption_rate.data?.rate ?? null;
          } catch {
            /* 单条解析失败跳过 */
          }
          if (!e.config_name || rate == null) continue; // custom_model_* 占位与无倍率条目
          rows.push({ id: e.config_name, name: e.display_config?.display_name || "", rate });
        }
        rows.sort((x, y) => y.rate - x.rate || x.id.localeCompare(y.id));
        modelsCache = { at: Date.now(), rows };
        return json(res, 200, { ok: true, models: rows });
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error).slice(0, 160) });
      }
    });

    registerRoute("POST", "/checkin", async (req, res, { json, readBody }) => {
      const body = await readBody(req);
      const wantUid = String(body.uid || "").trim();
      try {
        let auths = loadAuths();
        if (wantUid) auths = auths.filter((a) => a.uid === wantUid);
        const results = [];
        for (const a of auths) {
          const item = { uid: a.uid, nickname: a.nickname, already_checked_in: false, claimed: false, remain: 0 };
          try {
            const st = await ugPost(EP_CHECKIN_STATUS, a);
            item.already_checked_in = Boolean(st.checked_in);
            if (!st.checked_in && st.enable) {
              const cl = await ugPost(EP_CHECKIN_CLAIM, a, JSON.stringify({ req_source: 2 }));
              if (cl.code !== 0 && cl.code !== undefined) {
                item.error = `claim ${cl.code} ${cl.message || ""}`.trim();
              } else {
                item.claimed = true;
              }
            }
            const usage = await ugPost(EP_ENT_USAGE, a);
            const packs = Array.isArray(usage.user_entitlement_pack_list) ? usage.user_entitlement_pack_list : [];
            let remain = 0;
            for (const p of packs) {
              const limit = p?.entitlement_base_info?.quota?.credits_limit || 0;
              if (limit > 0) remain += limit - (p?.usage?.credits_amount || 0);
            }
            item.remain = Math.round(remain);
          } catch (error) {
            item.error = String(error).slice(0, 160);
          }
          results.push(item);
        }
        if (wantUid && !results.length) {
          return json(res, 200, { ok: false, error: `auths/ 里没有 uid=${wantUid} 的凭证` });
        }
        return json(res, 200, {
          ok: true,
          payload: { checked_at: new Date().toISOString(), results },
        });
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error).slice(0, 160) });
      }
    });

    registerRoute("POST", "/import", async (req, res, { json, readBody }) => {
      const body = await readBody(req);
      const payload = String(body.payload || "").trim();
      if (!payload) return json(res, 400, { ok: false, error: "凭证内容为空" });
      const isUrl = /^https?:\/\//i.test(payload);
      const forward = isUrl ? payload : JSON.stringify({ json: payload });
      try {
        const r = await proxy("POST", "/admin/api/accounts/import", forward, 30000);
        return json(res, 200, { ok: r.ok, status: r.status, payload: r.payload });
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error).slice(0, 160) });
      }
    });

    // ── OAuth 登录闭环：发起 → 用户开授权链接 → 网关回调自动导入 → 轮询结果 ──
    registerRoute("POST", "/login/start", async (req, res, { json }) => {
      try {
        const r = await proxy("POST", "/admin/api/login", "{}", 10000);
        return json(res, 200, { ok: r.ok, status: r.status, payload: r.payload });
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error).slice(0, 160) });
      }
    });

    registerRoute("GET", "/login/result", async (req, res, { json, url }) => {
      const pendingId = url.searchParams.get("pending_id") || "";
      if (!pendingId) return json(res, 400, { ok: false, error: "missing pending_id" });
      try {
        const r = await proxy("GET", `/admin/api/login/result?pending_id=${encodeURIComponent(pendingId)}`, undefined, 8000);
        return json(res, 200, { ok: r.ok, status: r.status, payload: r.payload });
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error).slice(0, 160) });
      }
    });

    registerRoute("POST", "/login/cancel", async (req, res, { json, readBody }) => {
      const body = await readBody(req);
      const pendingId = String(body.pending_id || "");
      if (!pendingId) return json(res, 400, { ok: false, error: "missing pending_id" });
      try {
        const r = await proxy("POST", `/admin/api/login/cancel?pending_id=${encodeURIComponent(pendingId)}`, "{}", 8000);
        return json(res, 200, { ok: r.ok, payload: r.payload });
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error).slice(0, 160) });
      }
    });

    // 凭证 JSON 脱敏预览
    registerRoute("GET", "/account-json", async (req, res, { json, url }) => {
      const uid = url.searchParams.get("uid") || "";
      if (!uid) return json(res, 400, { ok: false, error: "missing uid" });
      try {
        const r = await proxy("GET", `/admin/api/accounts/${encodeURIComponent(uid)}/json`, undefined, 8000);
        return json(res, 200, { ok: r.ok, status: r.status, payload: r.payload });
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error).slice(0, 160) });
      }
    });

    registerCard(`
      <section class="card">
        <h2>Trae 账号池（插件）</h2>
        <div class="rows" id="wtr-accounts"><div class="empty">加载中…</div></div>
        <div class="rows" id="wtr-rates"><div class="empty">模型倍率加载中…</div></div>
        <div class="actions">
          <button class="btn primary" type="button" id="wtr-login"><span class="btn-label">登录新账号</span></button>
          <button class="btn" type="button" id="wtr-credits"><span class="btn-label">积分/签到实查</span></button>
          <button class="btn" type="button" id="wtr-import-toggle"><span class="btn-label">导入凭证</span></button>
        </div>
        <style>
          #wtr-rates { max-height: 340px; overflow: auto;
            scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
          #wtr-rates::-webkit-scrollbar { width: 6px; }
          #wtr-rates::-webkit-scrollbar-track { background: transparent; }
          #wtr-rates::-webkit-scrollbar-button { display: none; }
          #wtr-rates::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }
          #wtr-rates::-webkit-scrollbar-thumb:hover { background: var(--muted); }
          #wtr-rates .wtr-hint { color: var(--muted); font-size: 11px; margin: 2px 0 8px; }
          #wtr-rates table.wtr-table {
            width: 100%; border-collapse: collapse;
            font: 12px/1.6 ui-monospace, Consolas, monospace;
          }
          #wtr-rates .wtr-table th {
            position: sticky; top: 0; background: var(--panel);
            color: var(--muted); font-weight: normal; font-size: 11px;
            text-align: right; padding: 3px 10px 4px 8px; border-bottom: 1px solid var(--line);
          }
          #wtr-rates .wtr-table td {
            text-align: right; padding: 3px 10px 3px 8px;
            border-bottom: 1px solid var(--line); color: var(--ink);
          }
          #wtr-rates .wtr-table th:first-child, #wtr-rates .wtr-table td:first-child { text-align: left; }
          #wtr-rates .wtr-table td:nth-child(2) { text-align: left; color: var(--muted); }
          #wtr-login-box { display: none; margin: 8px 0 0; padding: 10px 12px;
            background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; }
          #wtr-login-box.show { display: block; }
          #wtr-login-box a { color: var(--accent-2); word-break: break-all; }
          #wtr-login-state { margin-top: 6px; color: var(--muted); font-size: 12px; }
          #wtr-import-area { display: none; margin: 8px 0 0; }
          #wtr-import-area.show { display: block; }
          #wtr-import-area textarea {
            width: 100%; box-sizing: border-box; min-height: 72px;
            background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
            color: var(--ink); font: 12px/1.5 ui-monospace, Consolas, monospace; padding: 8px 10px;
          }
          #wtr-import-area .hint { color: var(--muted); font-size: 12px; margin: 4px 0 8px; }
          #wtr-out {
            display: none; margin: 8px 0 0; padding: 10px 12px;
            background: var(--panel-2); border: 1px solid var(--line);
            border-left: 2px solid var(--accent); border-radius: 8px;
            color: var(--ink); font: 12px/1.6 ui-monospace, Consolas, monospace;
            white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow: auto;
          }
          #wtr-out.show { display: block; }
          .wtr-act { cursor: pointer; margin-left: 6px; }
        </style>
        <div id="wtr-login-box">
          <div>1. 打开授权链接，用 TRAE 账号登录：</div>
          <div><a id="wtr-login-url" href="#" target="_blank" rel="noopener">(生成中…)</a></div>
          <div id="wtr-login-state">等待发起…</div>
          <div class="actions" style="margin-top: 8px;">
            <button class="btn" type="button" id="wtr-login-cancel"><span class="btn-label">取消登录</span></button>
          </div>
        </div>
        <div id="wtr-import-area">
          <textarea id="wtr-import-text" spellcheck="false" placeholder="粘贴 TRAE 登录回调链接（http://127.0.0.1:18080/authorize?...）或凭证 JSON"></textarea>
          <div class="hint">回调链接来自登录流程；JSON 支持嵌套形与扁平形（accessToken 必填）。</div>
          <div class="actions"><button class="btn primary" type="button" id="wtr-import-go"><span class="btn-label">导入</span></button></div>
        </div>
        <pre id="wtr-out"></pre>
      </section>
      <script>
      (function () {
        var BASE = "/api/plugins/trae-accounts";
        function byId(id) { return document.getElementById(id); }
        function esc(s) {
          return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
          });
        }
        function row(k, v) {
          return '<div class="row"><div class="k">' + esc(k) + '</div><div class="v">' + v + "</div></div>";
        }
        function act(label, fn) {
          return '<span class="wtr-act" data-act="' + esc(fn) + '">' + esc(label) + "</span>";
        }
        function showOut(text) {
          var out = byId("wtr-out");
          out.className = "show";
          out.textContent = text;
        }
        var accountsCache = [];
        var loginPollTimer = null;
        var loginPendingId = "";
        // 实查缓存：uid -> {remain, checked_in, time}；账号行优先显示实查值
        // （网关 /accounts 的 credits 字段无人回写、恒为 0，不能直接用）
        var creditsCache = {};

        function fmtCredits(uid) {
          var c = creditsCache[uid];
          if (!c) return "";
          return "积分 " + c.remain + "（" + c.time + " 实查）";
        }

        function fmtExpire(ts) {
          if (!ts) return "";
          var d = new Date(ts * 1000);
          var days = Math.round((d - Date.now()) / 86400000);
          return "token " + (days > 0 ? days + " 天后到期" : "已过期");
        }

        function render(d) {
          var el = byId("wtr-accounts");
          if (!d || !d.ok) {
            el.innerHTML = row("账号池", '<span class="dot err"></span>' + esc((d && d.error) || "加载失败"));
            return;
          }
          var accs = d.accounts || [];
          accountsCache = accs;
          if (!accs.length) {
            el.innerHTML = row("账号池", '<span class="dot warn"></span>暂无账号 · 点「登录新账号」发起 OAuth 登录');
            return;
          }
          var html = row("账号池", accs.length + " 个账号（" + accs.filter(function (a) { return a.enabled && !a.disabled; }).length + " 个可用）");
          accs.forEach(function (a) {
            var chips =
              (a.disabled ? ' <span class="chip err">硬禁用</span>' : "") +
              (!a.enabled ? ' <span class="chip err">已停用</span>' : "") +
              (a.cooling ? ' <span class="chip warn">冷却</span>' : "") +
              (a.expired_soon ? ' <span class="chip warn">临过期</span>' : "") +
              (a.err_count ? ' <span class="chip err">错误 ' + a.err_count + "</span>" : "");
            var acts =
              act(a.enabled ? "停用" : "启用", "toggle:" + a.uid) +
              act("改名", "rename:" + a.uid) +
              act("签到", "checkin:" + a.uid) +
              act("刷新token", "refresh:" + a.uid) +
              act("凭证", "cred:" + a.uid) +
              act("删除", "delete:" + a.uid);
            html += row(
              (a.nickname || String(a.uid).slice(0, 8)) + " · " + String(a.uid).slice(0, 8),
              [fmtCredits(a.uid), esc(fmtExpire(a.expires_at))].filter(Boolean).join(" · ") + chips + " " + acts,
            );
          });
          el.innerHTML = html;
          var nodes = el.querySelectorAll(".wtr-act");
          for (var i = 0; i < nodes.length; i++) nodes[i].addEventListener("click", onAct);
        }

        async function load() {
          try {
            var r = await fetch(BASE + "/accounts", { cache: "no-store" });
            render(await r.json());
          } catch (e) {
            byId("wtr-accounts").innerHTML = row("账号池", '<span class="dot err"></span>' + esc(String(e)));
          }
        }

        async function onAct(ev) {
          var spec = ev.target.getAttribute("data-act") || "";
          var kind = spec.split(":")[0];
          var uid = spec.slice(kind.length + 1);
          var acc = accountsCache.filter(function (a) { return a.uid === uid; })[0] || {};
          try {
            if (kind === "toggle") {
              var r = await fetch(BASE + "/patch", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ uid: uid, enabled: !acc.enabled }),
              });
              var d = await r.json();
              if (!d.ok) alert("操作失败：" + JSON.stringify(d.payload || d.error));
            } else if (kind === "rename") {
              var name = prompt("新昵称：", acc.nickname || "");
              if (name == null) return;
              var r2 = await fetch(BASE + "/patch", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ uid: uid, nickname: name }),
              });
              var d2 = await r2.json();
              if (!d2.ok) alert("改名失败：" + JSON.stringify(d2.payload || d2.error));
            } else if (kind === "refresh") {
              ev.target.textContent = "刷新中…";
              var r3 = await fetch(BASE + "/refresh", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ uid: uid }),
              });
              var d3 = await r3.json();
              if (!d3.ok) alert("刷新失败：" + JSON.stringify(d3.payload || d3.error));
            } else if (kind === "checkin") {
              ev.target.textContent = "签到中…";
              var r6 = await fetch(BASE + "/checkin", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ uid: uid }),
              });
              var d6 = await r6.json();
              var p6 = (d6.payload && d6.payload.results && d6.payload.results[0]) || {};
              if (!d6.ok || p6.error) {
                alert("签到失败：" + (p6.error || JSON.stringify(d6.payload || d6.error)));
              } else {
                var now6 = new Date().toLocaleTimeString("zh-CN", { hour12: false });
                showOut("[" + now6 + "]\\n" + (p6.nickname || uid) + "：" +
                  (p6.already_checked_in ? "今日已签过，无需重复签到" : "签到成功 ✅") +
                  " · 当前积分 " + p6.remain);
                doCredits(true); // 静默刷新实查缓存，账号行同步为新积分
              }
            } else if (kind === "cred") {
              var r5 = await fetch(BASE + "/account-json?uid=" + encodeURIComponent(uid), { cache: "no-store" });
              var d5 = await r5.json();
              showOut(d5.ok ? JSON.stringify(d5.payload, null, 2) : "读取失败：" + JSON.stringify(d5.payload || d5.error));
            } else if (kind === "delete") {
              if (!confirm("删除账号 " + (acc.nickname || uid) + " ？会同时删除 auths 凭证文件，不可恢复。")) return;
              var r4 = await fetch(BASE + "/delete", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ uid: uid }),
              });
              var d4 = await r4.json();
              if (!d4.ok) alert("删除失败：" + JSON.stringify(d4.payload || d4.error));
            }
          } catch (e) {
            alert("操作失败：" + String(e));
          } finally {
            load();
          }
        }

        // ── OAuth 登录闭环 ──
        function stopPoll() {
          if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; }
        }

        async function pollLogin(pendingId, startedAt) {
          var stateEl = byId("wtr-login-state");
          try {
            var r = await fetch(BASE + "/login/result?pending_id=" + encodeURIComponent(pendingId), { cache: "no-store" });
            var d = await r.json();
            var p = d.payload || {};
            if (p.state === "success") {
              stopPoll();
              stateEl.innerHTML = '<span class="dot ok"></span>登录成功：' + esc(p.nickname || p.uid) + " 已入池";
              setTimeout(function () { byId("wtr-login-box").className = ""; }, 2500);
              load();
              return;
            }
            if (p.state === "failed" || p.state === "canceled") {
              stopPoll();
              stateEl.innerHTML = '<span class="dot err"></span>登录失败：' + esc(p.error || p.state);
              return;
            }
            var waitSec = Math.round((Date.now() - startedAt) / 1000);
            stateEl.textContent = "等待授权回调…（已等 " + waitSec + " 秒，5 分钟超时）";
            if (waitSec > 300) {
              stopPoll();
              stateEl.innerHTML = '<span class="dot err"></span>超时未完成，可重新发起';
            }
          } catch (e) {
            stateEl.textContent = "轮询异常：" + String(e);
          }
        }

        async function startLogin() {
          var box = byId("wtr-login-box");
          var stateEl = byId("wtr-login-state");
          box.className = "show";
          stateEl.textContent = "正在生成授权链接…";
          try {
            var r = await fetch(BASE + "/login/start", { method: "POST" });
            var d = await r.json();
            var p = d.payload || {};
            if (!d.ok || !p.login_url) {
              stateEl.innerHTML = '<span class="dot err"></span>发起失败：' + esc(JSON.stringify(p).slice(0, 200));
              return;
            }
            var link = byId("wtr-login-url");
            link.href = p.login_url;
            link.textContent = p.login_url;
            loginPendingId = p.pending_id || "";
            var startedAt = Date.now();
            stateEl.innerHTML = "2. 登录完成后回调由网关自动接收并导入，无需粘贴。";
            stopPoll();
            loginPollTimer = setInterval(function () { pollLogin(p.pending_id, startedAt); }, 2500);
            pollLogin(p.pending_id, startedAt);
          } catch (e) {
            stateEl.innerHTML = '<span class="dot err"></span>发起失败：' + esc(String(e));
          }
        }

        async function cancelLogin() {
          stopPoll();
          byId("wtr-login-box").className = "";
          if (!loginPendingId) return;
          await fetch(BASE + "/login/cancel", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pending_id: loginPendingId }),
          }).catch(function () {});
          loginPendingId = "";
        }

        async function doCredits(silent) {
          var btn = byId("wtr-credits");
          var span = btn ? btn.querySelector(".btn-label") : null;
          if (btn) btn.disabled = true;
          if (span) span.textContent = "实查中（逐号查上游）…";
          try {
            var r = await fetch(BASE + "/credits", { cache: "no-store" });
            var d = await r.json();
            if (!d.ok) {
              if (!silent) alert("查询失败：" + (d.error || ""));
              return;
            }
            (d.credits || []).forEach(function (c) {
              creditsCache[c.uid] = {
                remain: c.remain,
                used: c.used,
                limit: c.limit,
                packs: c.packs,
                work: c.work_credits,
                checkedIn: c.checked_in,
                checkinCredits: c.checkin_credits,
                error: c.error || "",
                time: new Date(d.at).toLocaleTimeString("zh-CN", { hour12: false }),
              };
            });
            load();
            if (silent) return;
            var lines = [];
            (d.credits || []).forEach(function (c) {
              var state = c.error
                ? "查询失败：" + c.error
                : "剩 " + c.remain + " / 用 " + c.used + " / 额度 " + c.limit + " · 礼包 " + c.packs +
                  " · Work 积分 " + (c.work_credits != null ? c.work_credits : "—") +
                  " · 签到" + (c.checked_in ? "已签(+" + c.checkin_credits + ")" : "未签" + (c.checkin_enable ? "（可签）" : ""));
              lines.push((c.nickname || String(c.uid).slice(0, 8)) + "：" + state);
            });
            if (!lines.length) lines.push("（无账号）");
            lines.unshift("[" + new Date(d.at).toLocaleTimeString("zh-CN", { hour12: false }) + "]");
            showOut(lines.join("\\n"));
          } finally {
            if (btn) btn.disabled = false;
            if (span) span.textContent = "积分/签到实查";
          }
        }

        async function doImport() {
          var text = byId("wtr-import-text").value.trim();
          if (!text) { alert("请先粘贴凭证内容"); return; }
          var btn = byId("wtr-import-go");
          btn.disabled = true;
          try {
            var r = await fetch(BASE + "/import", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ payload: text }),
            });
            var d = await r.json();
            if (d.ok) {
              byId("wtr-import-text").value = "";
              byId("wtr-import-area").className = "";
              showOut("导入成功：" + JSON.stringify(d.payload, null, 2));
            } else {
              alert("导入失败：" + JSON.stringify(d.payload || d.error));
            }
          } finally {
            btn.disabled = false;
            load();
          }
        }

        // 模型倍率：直连上游解析的 consumption_rate，按倍率降序（贵的在上）
        async function loadRates() {
          var el = byId("wtr-rates");
          try {
            var r = await fetch(BASE + "/models", { cache: "no-store" });
            var d = await r.json();
            if (!d.ok || !(d.models || []).length) {
              el.innerHTML = row("模型倍率", "（" + esc(d.error || "暂无数据") + "）");
              return;
            }
            var html = '<div class="wtr-hint">消耗倍率来自 TRAE 模型目录（consumption_rate）· ' +
              d.models.length + " 个模型 · 贵的在前</div>";
            html += '<table class="wtr-table"><thead><tr><th>模型</th><th>名称</th><th>倍率</th></tr></thead><tbody>';
            d.models.forEach(function (m) {
              html += "<tr><td>" + esc(m.id) + "</td><td>" + esc(m.name || "—") +
                '</td><td class="num">' + Number(m.rate).toFixed(2) + "x</td></tr>";
            });
            html += "</tbody></table>";
            el.innerHTML = html;
          } catch (e) {
            el.innerHTML = row("模型倍率", esc(String(e)));
          }
        }

        byId("wtr-login").addEventListener("click", startLogin);
        byId("wtr-login-cancel").addEventListener("click", cancelLogin);
        byId("wtr-credits").addEventListener("click", function () { doCredits(false); });
        byId("wtr-import-toggle").addEventListener("click", function () {
          var area = byId("wtr-import-area");
          area.className = area.className === "show" ? "" : "show";
        });
        byId("wtr-import-go").addEventListener("click", doImport);
        load();
        loadRates(); // 目录稳定，启动拉一次即可（服务端缓存 10 分钟）
        // 首次加载自动实查一次积分，账号行直接显示真实值（不打扰，失败静默）
        setTimeout(function () { doCredits(true); }, 800);
        setInterval(load, 15000);
      })();
      </script>
    `);
  },
};

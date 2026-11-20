#!/usr/bin/env node
/**
 * qoder-accounts.mjs — 控制面板插件：Qoder 账号接入（设备授权 OAuth + 账号池 + 签到）。
 *
 * 实现参考 smart-open/TraeWorkAssistant 的 Qoder 设备流（tasks/qoder_oauth.rs）：
 *   1) 生成 nonce / verifier(64 hex) / machine_id，challenge = BASE64URL(SHA256(verifier))
 *   2) 授权 URL = https://qoder.cn/sso/login/aliyun?oauth_callback=<编码后的设备授权页>
 *      设备授权页：https://qoder.cn/device/selectAccounts?challenge=..&challenge_method=S256
 *                  &nonce=..&machine_id=..&directLogin=true&client_id=<官方常量>
 *      —— directLogin 只能出现一次；client_id 必须用官方注册常量
 *   3) 轮询 GET {openapi}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256
 *      pending = HTTP 404 {"errorCode":"NotFound"}；成功 = 200 {token, user_id, expires_in, refresh_token}
 *   4) 凭证落盘 %USERPROFILE%\.qoder2api\auths\qoder-<uid>.json（0600 语义：仅本机）
 *
 * 账号能力：列表 / 启停 / 删除 / 活动签到（GET /sash/api/v1/me/campaigns → POST claim，幂等）。
 * 注：推理转发（gateway.qoder.com.cn 的 COSY 自签名）是下一步，本插件只负责账号侧。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const OPEN_API = "https://openapi.qoder.com.cn";
const SSO_LOGIN_BASE = "https://qoder.cn/sso/login/aliyun";
const DEVICE_AUTH_BASE = "https://qoder.cn/device/selectAccounts";
const DEVICE_AUTH_CLIENT_ID = "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa";
const COSY_CLIENT_TYPE = "10";
const CLIENT_UA = "Qoder";
const POLL_TIMEOUT_MS = 180000;

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function authDir() {
  const dir = path.join(os.homedir(), ".qoder2api", "auths");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function accountFile(uid) {
  return path.join(authDir(), "qoder-" + uid + ".json");
}

function loadAccounts() {
  const dir = authDir();
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("qoder-") || !name.endsWith(".json")) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))); } catch {}
  }
  return out;
}

function mask(token) {
  const t = String(token || "");
  return t.length > 14 ? t.slice(0, 6) + "…" + t.slice(-4) : (t ? "***" : "");
}

export default {
  id: "qoder-accounts",
  title: "Qoder 账号",
  init({ registerRoute, registerCard, json }) {
    const flows = new Map(); // nonce -> { verifier, machineId, at }

    function buildFlow() {
      const verifier = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      const nonce = crypto.randomUUID();
      const machineId = crypto.randomUUID();
      const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
      const deviceUrl =
        DEVICE_AUTH_BASE +
        "?challenge=" + challenge +
        "&challenge_method=S256" +
        "&nonce=" + nonce +
        "&machine_id=" + machineId +
        "&directLogin=true" +
        "&client_id=" + DEVICE_AUTH_CLIENT_ID;
      const authUrl = SSO_LOGIN_BASE + "?oauth_callback=" + encodeURIComponent(deviceUrl);
      flows.set(nonce, { verifier, machineId, at: Date.now() });
      return { nonce, verifier, machineId, authUrl };
    }

    async function pollOnce(nonce) {
      const flow = flows.get(nonce);
      if (!flow) return { ok: false, error: "登录会话不存在或已过期，请重新发起" };
      if (Date.now() - flow.at > POLL_TIMEOUT_MS) {
        flows.delete(nonce);
        return { ok: false, expired: true, error: "登录超时（3 分钟），请重新发起" };
      }
      const url =
        OPEN_API + "/api/v1/deviceToken/poll?nonce=" + encodeURIComponent(nonce) +
        "&verifier=" + encodeURIComponent(flow.verifier) + "&challenge_method=S256";
      let res;
      try {
        res = await fetch(url, { headers: { "User-Agent": CLIENT_UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      } catch (e) {
        return { ok: false, retry: true, detail: "轮询网络异常：" + e.message };
      }
      const body = await res.json().catch(() => null);
      if (res.status === 404) return { ok: false, retry: true, detail: "等待浏览器完成登录…" };
      if (res.status !== 200) {
        return { ok: false, retry: true, detail: (body && (body.errorMessage || body.errorCode)) || ("HTTP " + res.status) };
      }
      if (!body || body.nonce !== nonce) return { ok: false, retry: true, detail: "nonce 校验未通过，继续等待" };
      const accessToken = body.token || body.accessToken || body.access_token;
      const uid = body.user_id || body.userId || body.uid;
      if (!accessToken || !uid) return { ok: false, retry: true, detail: "返回里缺少 token/uid" };
      const now = Date.now();
      const norm = (v) => { const n = Number(v) || 0; return n < 100000 ? n * 1000 : n; };
      const record = {
        account: { uid, nickname: body.nickname || body.name || "", addedAt: new Date().toISOString() },
        auth: {
          accessToken,
          refreshToken: body.refresh_token || body.refreshToken || "",
          expiresAt: body.expires_in ? now + norm(body.expires_in) : null,
          refreshExpiresAt: body.refresh_token_expires_in ? now + norm(body.refresh_token_expires_in) : null,
          kind: "client",
        },
        device: { machineId: flow.machineId },
      };
      const file = accountFile(uid);
      const existed = fs.existsSync(file);
      fs.writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
      flows.delete(nonce);
      return { ok: true, uid, nickname: record.account.nickname, action: existed ? "覆盖更新" : "新增" };
    }

    async function qoderFetch(rec, urlPath, init) {
      const headers = Object.assign(
        {
          Authorization: "Bearer " + rec.auth.accessToken,
          "Cosy-ClientType": COSY_CLIENT_TYPE,
          "User-Agent": CLIENT_UA,
          Accept: "application/json",
        },
        (init && init.headers) || {},
      );
      if (rec.device && rec.device.machineId) headers["Cosy-MachineId"] = rec.device.machineId;
      return fetch(OPEN_API + urlPath, Object.assign({}, init, { headers, signal: AbortSignal.timeout(20000) }));
    }

    registerRoute("POST", "/login/start", async (req, res, { json }) => {
      const flow = buildFlow();
      return json(res, 200, { ok: true, authUrl: flow.authUrl, nonce: flow.nonce });
    });

    registerRoute("POST", "/login/poll", async (req, res, { json, readBody }) => {
      const body = await readBody(req);
      const nonce = String(body.nonce || "").trim();
      if (!nonce) return json(res, 200, { ok: false, error: "缺少 nonce" });
      const result = await pollOnce(nonce);
      return json(res, 200, result);
    });

    registerRoute("GET", "/accounts", async (req, res, { json }) => {
      const accounts = loadAccounts().map((rec) => ({
        uid: rec.account.uid,
        nickname: rec.account.nickname || "",
        addedAt: rec.account.addedAt || "",
        disabled: Boolean(rec.account.disabled),
        expiresAt: rec.auth.expiresAt || null,
        token: mask(rec.auth.accessToken),
      }));
      return json(res, 200, { ok: true, accounts, dir: authDir() });
    });

    registerRoute("POST", "/accounts/toggle", async (req, res, { json, readBody }) => {
      const body = await readBody(req);
      const uid = String(body.uid || "").trim();
      const file = accountFile(uid);
      if (!fs.existsSync(file)) return json(res, 200, { ok: false, error: "账号不存在" });
      const rec = JSON.parse(fs.readFileSync(file, "utf8"));
      rec.account.disabled = Boolean(body.disabled);
      fs.writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
      return json(res, 200, { ok: true, uid, disabled: rec.account.disabled });
    });

    registerRoute("POST", "/accounts/delete", async (req, res, { json, readBody }) => {
      const body = await readBody(req);
      const uid = String(body.uid || "").trim();
      const file = accountFile(uid);
      if (!fs.existsSync(file)) return json(res, 200, { ok: false, error: "账号不存在" });
      fs.unlinkSync(file);
      return json(res, 200, { ok: true, uid });
    });

    // 每日活动签到：GET campaigns → 找 CREDITS 类型未领取的活动 → POST claim（幂等）
    registerRoute("POST", "/checkin", async (req, res, { json }) => {
      const accounts = loadAccounts().filter((a) => !a.account.disabled);
      const results = [];
      for (const rec of accounts) {
        const uid = rec.account.uid;
        try {
          const r = await qoderFetch(rec, "/sash/api/v1/me/campaigns");
          const payload = await r.json().catch(() => null);
          const list = (payload && (payload.data || payload.campaigns || payload)) || [];
          const campaigns = Array.isArray(list) ? list : [];
          const targets = campaigns.filter((c) => {
            const benefit = c && c.benefit ? String(c.benefit.kind || "").toUpperCase() : "";
            const status = String((c && c.claimStatus) || "").toUpperCase();
            return benefit === "CREDITS" && status !== "CLAIMED";
          });
          for (const c of targets.slice(0, 3)) {
            const id = c.campaignId || c.id;
            if (!id) continue;
            await qoderFetch(rec, "/sash/api/v1/me/campaigns/" + encodeURIComponent(id) + "/claim", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
          }
          results.push({ uid, ok: true, campaigns: campaigns.length, claimed: targets.length });
        } catch (e) {
          results.push({ uid, ok: false, error: String(e.message || e) });
        }
      }
      return json(res, 200, { ok: true, results });
    });

    registerCard(`
      <section class="card">
        <div class="phead">
          <h2>Qoder 账号</h2>
          <div class="phead-sub">设备授权登录 · 账号池 · 每日签到（参考 TraeWorkAssistant 设备流）</div>
        </div>
        <div class="pblock">
          <div class="pblock-head">账号
            <span class="grow"></span>
            <button class="btn sm primary" type="button" id="qdc-login"><span class="btn-label">登录新账号</span></button>
            <button class="btn sm" type="button" id="qdc-checkin"><span class="btn-label">签到</span></button>
            <button class="btn sm quiet" type="button" id="qdc-refresh"><span class="btn-label">刷新</span></button>
          </div>
          <div id="qdc-login-box" style="display:none;padding:10px 0">
            <div>用浏览器打开授权链接，登录 Qoder 账号：</div>
            <div><a id="qdc-login-url" href="#" target="_blank" rel="noopener">(生成中…)</a></div>
            <div id="qdc-login-state">等待发起…</div>
            <button class="btn" type="button" id="qdc-login-cancel"><span class="btn-label">取消</span></button>
          </div>
          <div class="list-scroll" id="qdc-pool"><div class="empty">加载中…</div></div>
          <div class="hint" id="qdc-out"></div>
        </div>
        <style>
          #qdc-pool table.p-table { width: 100%; }
          #qdc-pool table.p-table th { text-align: left; font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--line-2); }
          #qdc-pool table.p-table td { padding: 7px 8px; border-bottom: 1px solid var(--line-3); font-size: 12.5px; }
          #qdc-pool table.p-table td.acts { width: auto; white-space: nowrap; text-align: right; }
          .qdc-act { display: inline-flex; align-items: center; height: 20px; padding: 0 10px; margin-left: 4px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); color: var(--fg-2); font-size: 11px; line-height: 1; white-space: nowrap; cursor: pointer; }
          .qdc-act:hover { background: var(--pill-hover); border-color: var(--accent-line); color: var(--fg); }
          .qdc-act.danger { color: var(--err); border-color: color-mix(in srgb, var(--err) 32%, transparent); background: var(--err-soft); }
          .qdc-act.danger:hover { border-color: var(--err); }
          .qdc-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; border-radius: 999px; font-size: 11.5px; line-height: 18px; }
          .qdc-chip::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .75; }
          .qdc-chip.ok { color: var(--ok); background: var(--ok-soft); }
          .qdc-chip.err { color: var(--err); background: var(--err-soft); }
        </style>
      </section>
      <script>
      (function () {
        var BASE = "/api/plugins/qoder-accounts";
        var timer = null, nonce = "";
        function byId(id) { return document.getElementById(id); }
        function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
        async function api(path, body) {
          var r = await fetch(BASE + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
          return r.json();
        }
        async function load() {
          var d = await api("/accounts");
          var box = byId("qdc-pool");
          if (!d.ok) { box.innerHTML = '<div class="empty">' + esc(d.error || "读取失败") + "</div>"; return; }
          if (!d.accounts.length) { box.innerHTML = '<div class="empty">暂无账号 · 点「登录新账号」</div>'; return; }
                    var html = '<table class="p-table"><thead><tr><th>账号</th><th>到期</th><th>状态</th><th></th></tr></thead><tbody>';
          d.accounts.forEach(function (a) {
            var exp = a.expiresAt ? new Date(a.expiresAt).toLocaleDateString("zh-CN") : "—";
            var chip = a.disabled
              ? '<span class="qdc-chip err">已停用</span>'
              : '<span class="qdc-chip ok">正常</span>';
            var nameCell = a.nickname
              ? esc(a.nickname) + ' <span class="k">' + esc(a.uid.slice(0, 8)) + '</span>'
              : esc(a.uid.slice(0, 8));
            html += '<tr class="acc-row"><td>' +
              nameCell +
              ' <span class="k">' + esc(a.token) + '</span></td>' +
              '<td class="k">' + esc(exp) + '</td>' +
              '<td>' + chip + '</td>' +
              '<td class="acts">' +
                '<button type="button" class="qdc-act" data-toggle="' + esc(a.uid) + '" data-dis="' + (a.disabled ? "1" : "0") + '">' + (a.disabled ? "启用" : "停用") + '</button>' +
                '<button type="button" class="qdc-act danger" data-del="' + esc(a.uid) + '">删除</button>' +
              '</td></tr>';
          });
          html += "</tbody></table>";
          box.innerHTML = html;
          box.querySelectorAll("[data-toggle]").forEach(function (b) {
            b.onclick = async function () { await api("/accounts/toggle", { uid: b.dataset.toggle, disabled: b.dataset.dis === "1" ? true : false }); load(); };
          });
          box.querySelectorAll("[data-del]").forEach(function (b) {
            b.onclick = async function () { if (!confirm("删除该账号？")) return; await api("/accounts/delete", { uid: b.dataset.del }); load(); };
          });
        }
        async function poll() {
          var d = await api("/login/poll", { nonce: nonce });
          var st = byId("qdc-login-state");
          if (d.ok) {
            st.textContent = "登录成功：" + (d.nickname || d.uid) + "（" + d.action + "）";
            clearInterval(timer); timer = null; load();
            setTimeout(function () { byId("qdc-login-box").style.display = "none"; }, 3000);
            return;
          }
          if (d.error) { st.textContent = d.error; if (d.expired) { clearInterval(timer); timer = null; } return; }
          st.textContent = "等待登录完成… " + (d.detail || "");
        }
        byId("qdc-login").onclick = async function () {
          var box = byId("qdc-login-box"); box.style.display = "block";
          byId("qdc-login-state").textContent = "正在生成授权链接…";
          var d = await api("/login/start", {});
          if (!d.ok) { byId("qdc-login-state").textContent = "发起失败：" + (d.error || ""); return; }
          nonce = d.nonce;
          var a = byId("qdc-login-url"); a.href = d.authUrl; a.textContent = d.authUrl;
          byId("qdc-login-state").textContent = "打开链接完成登录，凭证会自动入池…";
          if (timer) clearInterval(timer);
          timer = setInterval(poll, 2000); poll();
        };
        byId("qdc-login-cancel").onclick = function () { if (timer) clearInterval(timer); timer = null; byId("qdc-login-box").style.display = "none"; };
        byId("qdc-checkin").onclick = async function () {
          byId("qdc-out").textContent = "签到中…";
          var d = await api("/checkin", {});
          byId("qdc-out").textContent = d.ok ? ("签到：" + JSON.stringify(d.results)) : ("失败：" + (d.error || ""));
        };
        byId("qdc-refresh").onclick = load;
        load();
      })();
      </script>
    `);
  },
};

#!/usr/bin/env node
/**
 * workbuddy-credits.mjs — 控制面板插件：WorkBuddy 积分 / 账号管理（对齐 WorkBuddy Manager 的常用面）。
 *
 * 数据与动作全部来自 workbuddy2api（网关目录）：
 *   - 池状态：GET <网关>/status（本地网关，随页面轮询）— 账号、冷却、启停、限流、成本台账
 *   - 模型倍率：/v1/models 官方倍率全目录（对齐官方 UI）+ /v1/stats 实测单价（累计积分÷token）
 *   - 用量统计：GET <网关>/v1/stats — 请求/成功率/token/缓存命中（随页面轮询）
 *   - 积分日报：credit.exe -json（实查上游余额，手动触发）
 *   - 手动签到：signin_bin.exe auths（幂等；网关 09/21 点定时签到之外的对账/补签）
 *   - 账号管理：POST /admin/accounts/{uid}/disable|enable|revive（config admin.enabled，
 *     面板「开启管理端点」一键写入并重启网关生效）
 */
import fs from "node:fs";
import path from "node:path";

function readApiKey(gatewayConfig) {
  try {
    if (fs.existsSync(gatewayConfig)) {
      const cfg = JSON.parse(fs.readFileSync(gatewayConfig, "utf8"));
      return String(cfg.api_key || "").trim();
    }
  } catch {
    /* fallthrough */
  }
  return "";
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fallthrough */
      }
    }
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "workbuddy-credits",
  title: "WorkBuddy 积分",
  init({ registerRoute, registerCard, settings, runCommand, fetchJson, readText }) {
    registerRoute("GET", "/status", async (req, res, { json }) => {
      const s = settings();
      const key = readApiKey(s.gatewayConfig);
      if (!key) {
        return json(res, 200, { ok: false, error: `网关配置缺 api_key：${s.gatewayConfig}` });
      }
      try {
        const r = await fetchJson(
          `${s.workbuddyUrl}/status`,
          { headers: { Authorization: `Bearer ${key}` } },
          3000,
        );
        if (!r.ok) {
          return json(res, 200, { ok: false, error: `网关 /status HTTP ${r.status}` });
        }
        return json(res, 200, { ok: true, status: r.payload });
      } catch (error) {
        return json(res, 200, { ok: false, error: `网关不可达（${s.workbuddyUrl}）` });
      }
    });

    // 用量统计（/v1/stats）
    registerRoute("GET", "/stats", async (req, res, { json }) => {
      const s = settings();
      const key = readApiKey(s.gatewayConfig);
      if (!key) return json(res, 200, { ok: false, error: "网关配置缺 api_key" });
      try {
        const r = await fetchJson(
          `${s.workbuddyUrl}/v1/stats`,
          { headers: { Authorization: `Bearer ${key}` } },
          3000,
        );
        if (!r.ok) return json(res, 200, { ok: false, error: `/v1/stats HTTP ${r.status}` });
        return json(res, 200, { ok: true, stats: r.payload });
      } catch (error) {
        return json(res, 200, { ok: false, error: "统计不可达" });
      }
    });

    // 模型目录（/v1/models，含官方积分倍率 credits 原文，如 "x0.21"）
    registerRoute("GET", "/models", async (req, res, { json }) => {
      const s = settings();
      const key = readApiKey(s.gatewayConfig);
      if (!key) return json(res, 200, { ok: false, error: "网关配置缺 api_key" });
      try {
        const r = await fetchJson(
          `${s.workbuddyUrl}/v1/models`,
          { headers: { Authorization: `Bearer ${key}` } },
          5000,
        );
        if (!r.ok) return json(res, 200, { ok: false, error: `/v1/models HTTP ${r.status}` });
        return json(res, 200, { ok: true, models: Array.isArray(r.payload?.data) ? r.payload.data : [] });
      } catch (error) {
        return json(res, 200, { ok: false, error: "模型目录不可达" });
      }
    });

    // 账号管理：disable / enable / revive
    registerRoute("POST", "/admin/account", async (req, res, { json, readBody }) => {
      const s = settings();
      const body = await readBody(req);
      const uid = String(body.uid || "");
      const action = String(body.action || "");
      if (!uid || !["disable", "enable", "revive"].includes(action)) {
        return json(res, 400, { ok: false, error: "需要 uid 和 action(disable/enable/revive)" });
      }
      const key = readApiKey(s.gatewayConfig);
      try {
        const r = await fetchJson(
          `${s.workbuddyUrl}/admin/accounts/${encodeURIComponent(uid)}/${action}`,
          { method: "POST", headers: { Authorization: `Bearer ${key}` } },
          8000,
        );
        if (r.status === 404) {
          return json(res, 200, {
            ok: false,
            error: "网关未开管理端点（admin.enabled=false）：点「开启管理端点并重启网关」",
          });
        }
        return json(res, 200, { ok: r.ok, status: r.status, payload: r.payload });
      } catch (error) {
        return json(res, 200, { ok: false, error: `请求失败：${String(error).slice(0, 120)}` });
      }
    });

    // 一键开启 admin 端点并重启网关生效
    registerRoute("POST", "/admin/ensure", async (req, res, { json }) => {
      const s = settings();
      let changed = false;
      try {
        if (!fs.existsSync(s.gatewayConfig)) {
          return json(res, 200, { ok: false, error: `读不到网关配置：${s.gatewayConfig}` });
        }
        const cfg = JSON.parse(fs.readFileSync(s.gatewayConfig, "utf8"));
        if (!cfg.admin?.enabled) {
          cfg.admin = { ...(cfg.admin || {}), enabled: true };
          fs.writeFileSync(s.gatewayConfig, JSON.stringify(cfg, null, 2), "utf8");
          changed = true;
        }
      } catch (error) {
        return json(res, 200, { ok: false, error: `写配置失败：${String(error).slice(0, 120)}` });
      }

      let restart = { ok: true, detail: "无需重启（已开启）" };
      if (changed) {
        // 与 workbuddy-tasks 插件同款：pid 校验杀掉 + 重拉 + 等 healthz
        const pidFile = path.join(s.gatewayDir, "wb2api.pid");
        const pid = Number(readText(pidFile) || 0);
        if (pid > 0) {
          await runCommand(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ` +
                `if ($p -and $p.CommandLine -like '*wb2api*') { Stop-Process -Id ${pid} -Force; 'killed' } else { 'stale' }`,
            ],
            { timeoutMs: 15000 },
          );
        }
        const logDir = path.join(s.gatewayDir, "data");
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const q = (p) => p.replace(/'/g, "''");
        await runCommand(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `$p = Start-Process -FilePath '${q(s.gatewayExe)}' ` +
              `-ArgumentList '-config','config.json' ` +
              `-WorkingDirectory '${q(s.gatewayDir)}' -WindowStyle Hidden ` +
              `-RedirectStandardOutput '${q(path.join(logDir, "server.out.log"))}' ` +
              `-RedirectStandardError '${q(path.join(logDir, "server.err.log"))}' -PassThru; ` +
              `[IO.File]::WriteAllText('${q(pidFile)}', [string]$p.Id); $p.Id`,
          ],
          { timeoutMs: 15000 },
        );
        let online = false;
        for (let i = 0; i < 40; i++) {
          await sleep(500);
          try {
            const r = await fetchJson(`${s.workbuddyUrl}/healthz`, {}, 1500);
            if (r.ok) {
              online = true;
              break;
            }
          } catch {
            /* booting */
          }
        }
        restart = online
          ? { ok: true, detail: "网关已重启" }
          : { ok: false, detail: "重启后 healthz 未就绪，见 data/server.err.log" };
      }
      return json(res, 200, { ok: restart.ok, changed, restart });
    });

    // ── WorkBuddy OAuth 登录闭环 ──
    // 主路（默认）：面板直连腾讯 OAuth。2026-10 实测服务端要求「platform=workbuddy +
    // WorkBuddy 桌面 UA」同时满足才发新登录页；网关自带 login.exe 走老 CLI 通道
    // （platform=CLI），拿到的是旧链接，扫码后常常拿不到 token —— 这是「登录新账号」
    // 一直停在等待中的根因。
    //   ① POST <authBase>/v2/plugin/auth/state?platform=… → state + authUrl
    //   ② 浏览器打开 authUrl 完成扫码/登录
    //   ③ GET  <authBase>/v2/plugin/auth/token?state=…（code=11217 表示登录未完成）
    //   ④ GET  <authBase>/v2/plugin/login/account?state=…（带 Bearer）取 uid/nickname
    //   ⑤ 落盘 auths/workbuddy-<uid>.json（网关 StartAuthDirWatch 自动入池，无需重启）
    // 备路：主路请求失败时自动回退网关目录的 login.exe（--realm=xx url|poll）。
    const WB_REALMS = {
      cn: {
        authBase: "https://copilot.tencent.com",
        loginBase: "https://www.workbuddy.cn",
        platform: "workbuddy",
        webOrigin: "https://www.codebuddy.cn",
        accountPath: "/v2/plugin/login/account",
        ua: "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0",
        clientVersion: "5.8.3",
        domain: "www.codebuddy.cn",
        intl: false,
      },
      global: {
        authBase: "https://www.workbuddy.ai",
        loginBase: "https://www.workbuddy.ai",
        platform: "workbuddy-ai",
        webOrigin: "https://www.workbuddy.ai",
        accountPath: "/v2/plugin/auth/account",
        ua: "WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/2.137.1",
        clientVersion: "5.7.6",
        domain: "www.workbuddy.ai",
        intl: true,
      },
    };
    const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
    const pendingLogins = new Map();

    function wbRealmCfg(realm) {
      return WB_REALMS[realm === "global" ? "global" : "cn"];
    }

    function wbHeaders(cfg, extra) {
      const headers = Object.assign(
        {
          "User-Agent": cfg.ua,
          Accept: "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
          Origin: cfg.webOrigin,
          Referer: cfg.webOrigin + "/",
        },
        extra || {},
      );
      if (cfg.intl) {
        headers["X-No-Authorization"] = "true";
        headers["X-No-User-Id"] = "true";
        headers["X-No-Enterprise-Id"] = "true";
        headers["X-No-Department-Info"] = "true";
      }
      return headers;
    }

    function digAny(node, keys, depth) {
      const level = depth || 0;
      if (!node || typeof node !== "object" || level > 4) return undefined;
      for (const key of keys) {
        const v = node[key];
        if (v !== undefined && v !== null && v !== "") return v;
      }
      for (const v of Object.values(node)) {
        const found = digAny(v, keys, level + 1);
        if (found !== undefined) return found;
      }
      return undefined;
    }

    function jwtClaims(token) {
      try {
        const part = String(token || "").split(".")[1];
        if (!part) return null;
        const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
        return JSON.parse(json);
      } catch {
        return null;
      }
    }

    async function wbAuthState(cfg) {
      const res = await fetch(
        cfg.authBase + "/v2/plugin/auth/state?platform=" + encodeURIComponent(cfg.platform),
        {
          method: "POST",
          headers: wbHeaders(cfg, { "Content-Type": "application/json" }),
          body: "{}",
          signal: AbortSignal.timeout(15000),
        },
      );
      const body = await res.json().catch(() => null);
      const data = body && body.data && typeof body.data === "object" ? body.data : body;
      const state = String((data && (data.state || data.authState || data.auth_state)) || "").trim();
      if (!state) {
        throw new Error("auth/state 未返回 state（HTTP " + res.status + "）：" + JSON.stringify(body).slice(0, 160));
      }
      let authUrl = String((data && (data.authUrl || data.auth_url)) || "").trim();
      if (!/^https?:\/\//.test(authUrl)) {
        authUrl =
          cfg.loginBase +
          "/login?platform=" +
          encodeURIComponent(cfg.platform) +
          "&state=" +
          state +
          "&version=" +
          cfg.clientVersion;
      }
      return { state: state, authUrl: authUrl };
    }

    async function wbTokenPoll(cfg, state) {
      const res = await fetch(cfg.authBase + "/v2/plugin/auth/token?state=" + encodeURIComponent(state), {
        headers: wbHeaders(cfg),
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => null);
      const accessToken = String(digAny(body, ["accessToken", "access_token"]) || "");
      if (!accessToken) {
        const msg = (body && (body.msg || body.message)) || "HTTP " + res.status;
        return { ok: false, detail: String(msg).slice(0, 160) };
      }
      const claims = jwtClaims(accessToken) || {};
      let expiresIn = Number(digAny(body, ["expiresIn", "expires_in"]) || 0) || 0;
      if (!expiresIn && claims.exp) expiresIn = Math.max(0, Number(claims.exp) - Math.floor(Date.now() / 1000));
      return {
        ok: true,
        accessToken: accessToken,
        refreshToken: String(digAny(body, ["refreshToken", "refresh_token"]) || ""),
        expiresIn: expiresIn,
      };
    }

    async function wbAccount(cfg, state, token) {
      const res = await fetch(cfg.authBase + cfg.accountPath + "?state=" + encodeURIComponent(state), {
        headers: wbHeaders(cfg, { Authorization: "Bearer " + token }),
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => null);
      const claims = jwtClaims(token) || {};
      return {
        uid: String(digAny(body, ["uid", "userId", "user_id"]) || claims.sub || ""),
        nickname: String(digAny(body, ["nickname", "nickName", "name"]) || ""),
        enterpriseId: String(digAny(body, ["enterpriseId", "enterprise_id"]) || ""),
      };
    }

    async function commitWorkbuddyCredential(cred, realm) {
      const s = settings();
      const authDir = path.join(s.gatewayDir, "auths");
      fs.mkdirSync(authDir, { recursive: true });
      const authFile = path.join(authDir, "workbuddy-" + cred.uid + ".json");
      const existed = fs.existsSync(authFile);
      const expiresAt = Math.floor(Date.now() / 1000) + Number(cred.expires_in || 0);
      fs.writeFileSync(
        authFile,
        JSON.stringify(
          {
            account: {
              enterpriseId: cred.enterprise_id || "",
              nickname: cred.nickname || "",
              uid: cred.uid,
            },
            auth: {
              accessToken: cred.access_token,
              domain: cred.domain || "",
              expiresAt: expiresAt,
              realm: realm,
              refreshToken: cred.refresh_token || "",
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      // CN 域首签（幂等，失败不阻塞入池）
      let checkin = realm === "cn" ? "" : "global 跳过";
      if (realm === "cn") {
        try {
          const headers = {
            Authorization: "Bearer " + cred.access_token,
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-User-Id": cred.uid,
          };
          if (cred.enterprise_id) {
            headers["X-Enterprise-Id"] = cred.enterprise_id;
            headers["X-Tenant-Id"] = cred.enterprise_id;
          }
          if (cred.domain) headers["X-Domain"] = cred.domain;
          const cr = await fetchJson("https://www.codebuddy.cn/v2/billing/meter/daily-checkin", {
            method: "POST",
            headers: headers,
            body: "{}",
          }, 15000).catch(() => null);
          const payload = cr && cr.payload;
          checkin = (payload && (payload.msg || (payload.data && payload.data.message))) || (cr && cr.ok ? "成功" : "已签到/无返回");
        } catch {
          checkin = "签到请求失败（不影响入池）";
        }
      }
      return { existed: existed, checkin: checkin };
    }

    registerRoute("POST", "/login/start", async (req, res, { json, readBody }) => {
      const s = settings();
      const body = await readBody(req);
      const realm = body.realm === "global" ? "global" : "cn";
      const cfg = wbRealmCfg(realm);

      // 主路：面板直连腾讯 OAuth（新登录页要求 platform=workbuddy + 桌面 UA）
      try {
        const started = await wbAuthState(cfg);
        pendingLogins.set(realm, { state: started.state, authUrl: started.authUrl, at: Date.now(), mode: "native" });
        return json(res, 200, { ok: true, realm: realm, authUrl: started.authUrl, mode: "native" });
      } catch (err) {
        const nativeError = String(err && err.message ? err.message : err);
        // 备路：网关目录的 login.exe
        const exe = path.join(s.gatewayDir, "login.exe");
        if (!fs.existsSync(exe)) {
          return json(res, 200, { ok: false, mode: "native", error: "直连 OAuth 失败：" + nativeError + "；且找不到 " + exe });
        }
        const r = await runCommand(exe, ["--realm=" + realm, "url"], { cwd: s.gatewayDir, timeoutMs: 30000 });
        if (!r.ok) {
          return json(res, 200, {
            ok: false,
            mode: "cli",
            error: "直连 OAuth 失败：" + nativeError + "；login.exe 也失败：" + (r.stderr || r.stdout || "").slice(-200),
          });
        }
        const authUrl = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
        if (!/^https?:\/\//.test(authUrl)) {
          return json(res, 200, { ok: false, mode: "cli", error: "login.exe 输出异常：" + r.stdout.slice(0, 200) });
        }
        pendingLogins.set(realm, { state: "", authUrl: authUrl, at: Date.now(), mode: "cli" });
        return json(res, 200, { ok: true, realm: realm, authUrl: authUrl, mode: "cli", note: "主路失败已回退 login.exe：" + nativeError });
      }
    });

    registerRoute("POST", "/login/poll", async (req, res, { json, readBody }) => {
      const s = settings();
      const body = await readBody(req);
      const realm = body.realm === "global" ? "global" : "cn";
      const cfg = wbRealmCfg(realm);
      const pending = pendingLogins.get(realm) || null;

      if (pending && Date.now() - pending.at > LOGIN_TIMEOUT_MS) {
        pendingLogins.delete(realm);
        return json(res, 200, { ok: false, expired: true, error: "登录已超时（5 分钟），请重新发起" });
      }

      let cred = null;
      let mode = pending ? pending.mode : "cli";

      if (pending && pending.mode === "native") {
        let tok;
        try {
          tok = await wbTokenPoll(cfg, pending.state);
        } catch (err) {
          return json(res, 200, { ok: false, retry: true, detail: "轮询异常：" + String(err && err.message ? err.message : err) });
        }
        if (!tok.ok) return json(res, 200, { ok: false, retry: true, detail: tok.detail });
        const acct = await wbAccount(cfg, pending.state, tok.accessToken).catch(() => null);
        if (!acct || !acct.uid) {
          return json(res, 200, { ok: false, retry: true, detail: "已拿到 token，但取账号资料失败（" + cfg.accountPath + "）" });
        }
        cred = {
          access_token: tok.accessToken,
          refresh_token: tok.refreshToken,
          expires_in: tok.expiresIn,
          uid: acct.uid,
          nickname: acct.nickname,
          enterprise_id: acct.enterpriseId,
          domain: cfg.domain,
        };
        pendingLogins.delete(realm);
      } else {
        const exe = path.join(s.gatewayDir, "login.exe");
        if (!fs.existsSync(exe)) {
          return json(res, 200, { ok: false, error: "找不到 " + exe + "，请点「登录新账号」重新发起" });
        }
        const r = await runCommand(exe, ["--realm=" + realm, "poll"], { cwd: s.gatewayDir, timeoutMs: 30000 });
        if (!r.ok) {
          return json(res, 200, { ok: false, retry: true, detail: (r.stderr || r.stdout || "").slice(-160) });
        }
        const parsed = parseJsonLoose(r.stdout);
        if (!parsed || !parsed.access_token || !parsed.uid) {
          return json(res, 200, { ok: false, retry: true, detail: "凭证字段缺失，等待登录完成" });
        }
        cred = {
          access_token: parsed.access_token,
          refresh_token: parsed.refresh_token || "",
          expires_in: parsed.expires_in || 0,
          uid: parsed.uid,
          nickname: parsed.nickname || "",
          enterprise_id: parsed.enterprise_id || "",
          domain: parsed.domain || "",
        };
        if (pending) pendingLogins.delete(realm);
      }

      const result = await commitWorkbuddyCredential(cred, realm);
      return json(res, 200, {
        ok: true,
        uid: cred.uid,
        nickname: cred.nickname || "",
        action: result.existed ? "覆盖更新" : "新增",
        checkin: result.checkin,
        mode: mode,
        at: new Date().toISOString(),
      });
    });

    registerRoute("POST", "/report", async (req, res, { json }) => {
      const s = settings();
      const exe = path.join(s.gatewayDir, "credit.exe");
      if (!fs.existsSync(exe)) {
        return json(res, 200, { ok: false, error: `找不到 credit.exe（${exe}），请检查网关目录` });
      }
      const r = await runCommand(exe, ["-json"], { cwd: s.gatewayDir, timeoutMs: 120000 });
      if (!r.ok) {
        return json(res, 200, { ok: false, error: (r.stderr || r.stdout || "credit.exe 失败").slice(-400) });
      }
      const payload = parseJsonLoose(r.stdout);
      if (!payload) {
        return json(res, 200, { ok: false, error: `credit.exe 输出无法解析：${r.stdout.slice(0, 200)}` });
      }
      return json(res, 200, { ok: true, report: payload, at: new Date().toISOString() });
    });

    // signin_bin 输出是「uid | nick | status | remain | detail」表格；这里解析成结构化结果，
    // 并把"必须重新登录"的账号单独拎出来（AUTH_INVALID / session_dead / 12153）。
    function parseSigninReport(text) {
      const lines = String(text || "").split(/\r?\n/);
      const accounts = [];
      let summary = null;
      for (const raw of lines) {
        const line = raw.trim();
        if (/^total=\d+/.test(line)) {
          const m = line.match(/total=(\d+)\s+ok=(\d+)\s+already=(\d+)\s+fail=(\d+)/);
          if (m) summary = { total: +m[1], ok: +m[2], already: +m[3], fail: +m[4] };
          continue;
        }
        const parts = line.split("|").map((x) => x.trim());
        if (parts.length < 4) continue;
        const uid = parts[0];
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid)) continue;
        const rawDetail = parts.slice(4).join("|").trim();
        let detail = rawDetail;
        if (/\b10001\b/.test(rawDetail) || rawDetail.includes("今天已")) detail = "今天已签到";
        else if (/12153|session_dead|AUTH_INVALID/i.test(rawDetail)) detail = "凭证已失效（12153 session_dead），需要重新登录";
        else if (!rawDetail) detail = "";
        accounts.push({ uid, nick: parts[1] || "", status: parts[2] || "", remain: parts[3] || "", detail: detail.slice(0, 120) });
      }
      const needRelogin = accounts.filter((a) => /AUTH_INVALID|session_dead|12153/i.test(a.status + " " + a.detail));
      return { accounts, summary, needRelogin };
    }

    registerRoute("POST", "/checkin", async (req, res, { json }) => {
      const s = settings();
      const exe = path.join(s.gatewayDir, "signin_bin.exe");
      if (!fs.existsSync(exe)) {
        return json(res, 200, {
          ok: false,
          error: `找不到 signin_bin.exe（${exe}），请检查网关目录`,
        });
      }
      const r = await runCommand(exe, ["auths"], { cwd: s.gatewayDir, timeoutMs: 180000 });
      if (!r.ok) {
        return json(res, 200, { ok: false, error: (r.stderr || r.stdout || "signin_bin 失败").slice(-400) });
      }
      const parsed = parseSigninReport(r.stdout);
      return json(res, 200, {
        ok: true,
        output: r.stdout.trim(),
        accounts: parsed.accounts,
        summary: parsed.summary,
        needRelogin: parsed.needRelogin,
        at: new Date().toISOString(),
      });
    });

    registerCard(`
                        <section class="card">
        <div class="phead">
          <h2>WorkBuddy 积分</h2>
          <div class="phead-sub">账号 · 用量 · 模型倍率 · 点行展开明细</div>
        </div>
        <div class="pblock">
          <div class="pblock-head">账号
            <span class="grow"></span>
            <button class="btn sm primary" type="button" id="wbc-login"><span class="btn-label">登录新账号</span></button>
            <button class="btn sm" type="button" id="wbc-report"><span class="btn-label">刷新积分日报</span></button>
            <button class="btn sm" type="button" id="wbc-checkin"><span class="btn-label">立即签到</span></button>
            <button class="btn sm quiet" type="button" id="wbc-admin-ensure"><span class="btn-label">管理端点</span></button>
          </div>
          </div>
        <div class="split-2">
          <div class="pblock pane">
            <div class="pblock-head">账号 <span class="k">点行看台账</span></div>
            <div class="list-scroll" id="wbc-pool"><div class="empty">加载中…</div></div>
            <div class="pblock-head">用量</div>
            <div class="rows" id="wbc-stats"><div class="empty">统计加载中…</div></div>
          </div>
          <div class="pblock pane">
            <div class="pblock-head">模型倍率 <span class="k">点行看参数</span></div>
            <div class="pblock-head">积分日报 <span class="k">余额 / 已用 / 礼包</span></div>
            <div class="list-scroll" id="wbc-report-body" hidden><div class="empty">点顶部「刷新积分日报」实查</div></div>

            <div class="list-scroll" id="wbc-rates"><div class="empty">模型倍率加载中…</div></div>
          </div>
        </div>
        <div id="wbc-login-box">
          <div>域：
            <label><input type="radio" name="wbc-realm" value="cn" checked /> 国内版 cn</label>
            <label><input type="radio" name="wbc-realm" value="global" /> 国际版 global</label>
          </div>
          <div>打开授权链接，用 WorkBuddy 账号登录：</div>
          <div><a id="wbc-login-url" href="#" target="_blank" rel="noopener">(生成中…)</a></div>
          <div id="wbc-login-state">等待发起…</div>
          <div class="actions" style="margin-top: 8px;">
            <button class="btn" type="button" id="wbc-login-cancel"><span class="btn-label">取消登录</span></button>
          </div>
        </div>
        <pre id="wbc-checkin-out"></pre>
        <style>
          #wbc-login-box, #wbc-checkin-out { display: none; }
        .st-pill {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 2px 10px; border-radius: 999px; line-height: 18px;
          font-size: 11.5px; font-family: var(--font, inherit);
          background: var(--pill, #eeeef0); color: var(--fg-2, #404046);
          border: 1px solid transparent; white-space: nowrap;
        }
        .st-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .75; }
        .st-pill.err { color: var(--err, #dc2626); background: var(--err-soft, #fdecec); border-color: color-mix(in srgb, var(--err, #dc2626) 22%, transparent); }
        .st-pill.warn { color: var(--warn, #d97706); background: var(--warn-soft, #fdf3e3); border-color: color-mix(in srgb, var(--warn, #d97706) 22%, transparent); }
        .st-pill.ok { color: var(--ok, #16a34a); background: var(--ok-soft, #e9f7ee); border-color: color-mix(in srgb, var(--ok, #16a34a) 22%, transparent); }
        #wbc-report-body[hidden] { display: none; }
        #wbc-checkin-out.show { display: block; }
        .ck-sum { display: flex; gap: 14px; align-items: baseline; padding: 4px 2px 10px; font-size: 12.5px; color: var(--muted, #6b7280); }
        .ck-sum .ok { color: #15803d; }
        .ck-sum .bad { color: #b91c1c; }
        .ck-list { display: flex; flex-direction: column; gap: 4px; }
        .ck-row { display: grid; grid-template-columns: 10px 96px 68px 84px 1fr; align-items: center; gap: 10px;
                  padding: 8px 10px; border-radius: 8px; background: rgba(127,127,127,.05); font-size: 12.5px; }
        .ck-dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; }
        .ck-dot.ok, .ck-dot.today { background: #16a34a; }
        .ck-dot.bad { background: #dc2626; }
        .ck-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ck-uid { font-family: ui-monospace, Consolas, monospace; opacity: .55; }
        .ck-state { font-size: 12px; }
        .ck-state.ok, .ck-state.today { color: #15803d; }
        .ck-state.bad { color: #b91c1c; }
        .ck-credit { font-variant-numeric: tabular-nums; }
        .ck-detail { color: var(--muted, #6b7280); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ck-warn { margin-top: 10px; padding: 9px 12px; border-radius: 8px; background: rgba(220,38,38,.08); color: #b91c1c; font-size: 12.5px; }
        .ck-actions { margin-top: 8px; }
        #wbc-report-body { max-height: 240px; overflow: auto; }
        .rp-sum { display: flex; align-items: baseline; gap: 8px; padding: 6px 2px 8px; font-size: 12.5px; color: var(--muted, #6b7280); }
        .rp-sum b { color: var(--fg, #171717); font-variant-numeric: tabular-nums; font-weight: 600; }
        .rp-k { font-size: 11.5px; }
        .rp-time { margin-left: auto; font-size: 11.5px; opacity: .7; }
        .rp-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .rp-table th { text-align: left; font-weight: 600; font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--muted, #6b7280); padding: 6px 8px; border-bottom: 1px solid var(--line-2, #ececef); }
        .rp-table th.num, .rp-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
        .rp-table td { padding: 6px 8px; border-bottom: 1px solid var(--line-3, #f2f2f5); }
        .rp-table tr:last-child td { border-bottom: 0; }
        .rp-fail { color: var(--err, #dc2626); font-size: 11px; }
          #wbc-login-box.show, #wbc-checkin-out.show { display: block; }
        </style>
      </section>
      <script>
      (function () {
        var BASE = "/api/plugins/workbuddy-credits";
        function byId(id) { return document.getElementById(id); }
// 面板里的弹层；没有就退回原生 alert（下面板单独跑时也能用）
function uiAlert(text) {
  if (window.__uiAlert) return window.__uiAlert("提示", text);
  return uiAlert(text);
}
async function uiPrompt(label, def) {
  if (window.__uiPrompt) return await window.__uiPrompt("输入", label, def);
  return prompt(label, def);
}
        function esc(s) {
          return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
          });
        }
        function row(k, v) {
          return '<div class="row"><div class="k">' + esc(k) + '</div><div class="v">' + v + "</div></div>";
        }
        function act(label, fn) {
          return '<button type="button" class="act-link wbc-act" data-act="' + esc(fn) + '">' + esc(label) + "</button>";
        }
        function poolText(t) {
          if (!t) return "—";
          return t.total + " 账号 · 健康 " + t.healthy + " · 冷却 " + t.cooling + " · 停用 " + t.disabled;
        }
        var accountsCache = [];
        var adminHint = false;
        // 实查缓存：uid -> {remain, time}。账号行优先显示实查值；
        // 网关 /status 的 credits 只在定时签到（09/21 点）被官方余额覆盖，
        // 白天领的礼包/任务积分不回写，直接显示会与实时值差一大截
        var creditsCache = {};

        function fmtBalance(a) {
          var c = creditsCache[a.uid];
          if (c) return "积分 " + c.remain + "（" + c.time + " 实查）";
          return "余额 " + (a.credits != null ? a.credits : "—") + "（签到快照）";
        }

        // 台账直接摊在账号行下面：一级信息，不弹窗
        function ledgerInline(a) {
          var mc = a && a.model_costs ? a.model_costs : [];
          if (!mc.length) return '<span class="k">台账：暂无样本（还没跑过请求）</span>';
          return '<span class="k">台账 · 每千 token 实测：</span> ' + mc.map(function (m) {
            return '<span class="mono">' + esc(m.model) + "</span> " + Number(m.cost_per_1k || 0).toFixed(4) +
              '<span class="k">（样本 ' + (m.samples || 0) + "）</span>";
          }).join(' <span class="k">·</span> ');
        }
        function ledgerText(a) {
          var mc = a.model_costs || [];
          if (!mc.length) return "（暂无台账：该账号还没跑过请求）";
          var lines = mc.map(function (m) {
            return m.model + "：每千 token " + Number(m.cost_per_1k).toFixed(4) +
              " · 样本 " + m.samples + " · 末次 " + (m.last_seen || "").slice(5, 16);
          });
          return lines.join("\\n");
        }

        function renderPool(d) {
          var el = byId("wbc-pool");
          if (!el) return;
          if (!d || !d.ok) {
            el.innerHTML = row("账号池", '<span class="dot err"></span>' + esc(d && d.error ? d.error : "不可达"));
            return;
          }
          var st = d.status;
          var accs = Array.isArray(st.accounts) ? st.accounts : [];
          accountsCache = accs;
          var html = '<div class="pool-strip">' +
            "<span><b>" + accs.length + "</b>账号</span>" +
            "<span><b>" + accs.filter(function (a) { return !a.cooling && !a.disabled && !a.manual_disabled; }).length + "</b>健康</span>" +
            "<span><b>" + accs.filter(function (a) { return a.cooling; }).length + "</b>冷却</span>" +
            "<span><b>" + accs.filter(function (a) { return a.disabled || a.manual_disabled; }).length + "</b>停用</span>" +
            "</div>";
          html += '<table class="p-table"><thead><tr><th>账号</th><th class="num">积分</th><th class="num">成功</th><th class="num">台账</th><th>状态</th><th></th></tr></thead><tbody>';
          accs.forEach(function (a, i) {
            var flags =
              (a.cooling ? '<span class="st-pill warn">冷却中</span>' : "") +
              (a.disabled ? '<span class="st-pill err" title="网关按失败率自动摘除">自动禁用</span>' : "") +
              (a.manual_disabled ? '<span class="st-pill err" title="被手动停用">手动停用</span>' : "") +
              ((a.rate_limited_models || []).length
                ? '<span class="st-pill warn">限流 ' + esc((a.rate_limited_models || []).map(function (x) { return x.model; }).join(" · ")) + "</span>"
                : "");
            var acts =
              (a.manual_disabled ? act("启用", "enable:" + a.uid) : act("停用", "disable:" + a.uid)) +
              act("复活", "revive:" + a.uid);
            var balance = String(fmtBalance(a)).replace(/^积分\s*/, "").replace(/（[^）]*）/g, "").trim();
            html +=
              '<tr class="acc-row" data-i="' + i + '"><td>' + esc(a.nickname || String(a.uid || "").slice(0, 8)) +
              (a.realm ? ' <span class="k">' + esc(a.realm) + "</span>" : "") + "</td>" +
              '<td class="num">' + esc(balance) + "</td>" +
              '<td class="num">' + (a.success_count || 0) + "</td>" +
              '<td class="num">' + ((a.model_costs || []).length ? (a.model_costs || []).length + " 模型" : "—") + "</td>" +
              "<td>" + (flags || '<span class="st-pill ok">正常</span>') + "</td>" +
              '<td class="acts">' + acts + "</td></tr>" +
              '<tr class="ledger-row" data-for="' + i + '" hidden><td colspan="6">' + ledgerInline(a) + "</td></tr>";
          });
          html += "</tbody></table>";
          el.innerHTML = html;
          Array.prototype.forEach.call(el.querySelectorAll(".acc-row"), function (tr) {
            tr.style.cursor = "pointer";
            tr.addEventListener("click", function (event) {
              if (event.target.closest("[data-act]")) return;
              var d2 = el.querySelector('.ledger-row[data-for="' + tr.getAttribute("data-i") + '"]');
              if (d2) d2.hidden = !d2.hidden;
              tr.classList.toggle("open");
            });
          });
          Array.prototype.forEach.call(el.querySelectorAll(".wbc-act"), function (n) { n.addEventListener("click", onAct); });
        }

        // 模型倍率：官方倍率（/v1/models 目录，对齐官方 UI）+ 实测单价（/v1/stats 累计积分÷token）
        // 在用模型走六列表格，未使用的收进底部标签云
        function renderRates(statsData, modelsData) {
          var el = byId("wbc-rates");
          if (!el) return;
          var statsRows = (statsData && statsData.ok && statsData.stats && statsData.stats.models) || [];
          var used = {};
          statsRows.forEach(function (m) {
            if (Number(m.total_tokens) > 0) {
              used[String(m.model || "").replace(/^(cn|global):/, "")] = {
                credit: Number(m.credit || 0),
                tokens: Number(m.total_tokens || 0),
                requests: Number(m.requests || 0),
              };
            }
          });
          var catalog = (modelsData && modelsData.ok && Array.isArray(modelsData.models)) ? modelsData.models : [];
          var bare = function (id) { return String(id || "").replace(/^(cn|global):/, ""); };
          var mult = function (x) { return String(x || "").replace(/^x/i, "").replace(/\s*credits.*$/i, ""); };

          var rows = catalog.map(function (mi) {
            return { id: mi.id, meta: mi, u: used[bare(mi.id)] || null };
          });
          Object.keys(used).forEach(function (b) {
            if (!rows.some(function (r) { return bare(r.id) === b; })) rows.push({ id: b, meta: null, u: used[b] });
          });
          if (!rows.length) {
            el.innerHTML = '<div class="wrc-hint">模型目录不可达 · 稍后重试</div>';
            return;
          }
          rows.sort(function (a, b) {
            if (!!a.u !== !!b.u) return a.u ? -1 : 1;
            if (a.u && b.u) return b.u.credit - a.u.credit;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          });

          function param(k, v) {
            if (v == null || v === "") return "";
            return '<div class="param"><span class="pk">' + esc(k) + '</span><span class="pv">' + esc(String(v)) + "</span></div>";
          }

          var html = '<table class="wrc-table compact model-list"><thead><tr>' +
            '<th>模型</th><th class="num">官方</th><th class="num">实测/千tok</th><th class="num">请求</th>' +
            "</tr></thead><tbody>";
          rows.forEach(function (r, i) {
            var cred = r.meta ? mult(r.meta.credits) : "";
            var real = r.u && r.u.tokens ? ((r.u.credit / r.u.tokens) * 1000).toFixed(4) : "—";
            html +=
              '<tr class="model-row" data-i="' + i + '"><td>' + esc(r.id) +
              (r.u ? "" : ' <span class="k">未使用</span>') + "</td>" +
              '<td class="num">' + (cred ? esc(cred) + "x" : "—") + "</td>" +
              '<td class="num">' + real + "</td>" +
              '<td class="num">' + (r.u ? r.u.requests : "—") + "</td></tr>";
            var m = r.meta || {};
            html += '<tr class="model-detail" data-for="' + i + '" hidden><td colspan="4"><div class="param-grid">' +
              param("上下文", m.context_length) +
              param("最大输出", m.max_output_tokens) +
              param("推理强度", m.reasoning_effort) +
              param("图片", m.supports_images ? "支持" : "不支持") +
              param("工具调用", m.supports_tool_call ? "支持" : "—") +
              param("vendor", m.vendor || m.owned_by) +
              (m.description ? '<div class="param wide"><span class="pv">' + esc(m.description) + "</span></div>" : "") +
              "</div></td></tr>";
          });
          html += "</tbody></table>";
          el.innerHTML = html;
          Array.prototype.forEach.call(el.querySelectorAll(".model-row"), function (tr) {
            tr.style.cursor = "pointer";
            tr.addEventListener("click", function () {
              var d2 = el.querySelector('.model-detail[data-for="' + tr.getAttribute("data-i") + '"]');
              if (d2) d2.hidden = !d2.hidden;
              tr.classList.toggle("open");
            });
          });
        }

        function renderStats(d) {
          var el = byId("wbc-stats");
          if (!el) return;
          if (!d || !d.ok) {
            el.innerHTML = '<div class="k">用量统计不可达</div>';
            return;
          }
          var t = (d.stats && d.stats.total) || {};
          var successRate = t.requests ? Math.round((t.success / t.requests) * 100) : null;
          var cacheRate = t.prompt_tokens ? Math.round((t.cache_hit_tokens / t.prompt_tokens) * 100) : null;
          var html = '<div class="stat-strip">' +
            '<div><b>' + (t.requests != null ? t.requests : "—") + '</b><span>请求</span></div>' +
            '<div><b>' + (successRate != null ? successRate + "%" : "—") + '</b><span>成功率</span></div>' +
            '<div><b>' + (t.total_tokens != null ? (t.total_tokens / 10000).toFixed(1) + "万" : "—") + '</b><span>token</span></div>' +
            '<div><b>' + (cacheRate != null ? cacheRate + "%" : "—") + '</b><span>缓存命中</span></div>' +
            '<div><b>' + Math.round(t.tokens_per_sec || 0) + '</b><span>tok/s</span></div>' +
            "</div>";
          // 按模型的用量，铺在统计条下面，让左栏和右栏高度接近
          var models = (d.stats && d.stats.models) || [];
          if (models.length) {
            var top = models.slice().sort(function (a, b) { return Number(b.total_tokens || 0) - Number(a.total_tokens || 0); }).slice(0, 8);
            var max = Math.max.apply(null, top.map(function (m) { return Number(m.total_tokens || 0); }).concat([1]));
            html += '<div class="model-bars"><div class="pblock-head" style="padding-left:0">按模型 token</div>' +
              top.map(function (m) {
                var w = Math.max(2, Math.round((Number(m.total_tokens || 0) / max) * 100));
                return '<div class="mbar"><span class="mono">' + esc(m.model || "—") + '</span>' +
                  '<i style="width:' + w + '%"></i><b>' + (Number(m.total_tokens || 0) / 10000).toFixed(1) + "万</b></div>";
              }).join("") + "</div>";
          }
          el.innerHTML = html;
        }

        async function loadAll() {
          var statsData = null, modelsData = null;
          try {
            var r = await fetch(BASE + "/status", { cache: "no-store" });
            renderPool(await r.json());
          } catch (e) {
            byId("wbc-pool").innerHTML = row("账号池", '<span class="dot err"></span>' + esc(String(e)));
          }
          try {
            var r2 = await fetch(BASE + "/stats", { cache: "no-store" });
            statsData = await r2.json();
            renderStats(statsData);
          } catch (e) { /* stats 可选 */ }
          try {
            var r3 = await fetch(BASE + "/models", { cache: "no-store" });
            modelsData = await r3.json();
          } catch (e) { /* models 可选 */ }
          renderRates(statsData, modelsData);
        }

        async function onAct(ev) {
          var spec = ev.target.getAttribute("data-act") || "";
          var kind = spec.split(":")[0];
          var uid = spec.slice(kind.length + 1);
          if (kind === "ledger") {
            var acc = accountsCache.filter(function (a) { return a.uid === uid; })[0] || {};
            window.__uiAlert ? window.__uiAlert("提示", "成本台账（每千 token 实测单价，6 小时未更新失效）：\\n" + ledgerText(acc)) : uiAlert("成本台账（每千 token 实测单价，6 小时未更新失效）：\\n" + ledgerText(acc));
            return;
          }
          var label = kind === "disable" ? "停用" : kind === "enable" ? "启用" : "复活";
          if (kind === "disable" && !confirm("停用该账号？（只摘出选号，签到/保活照常）")) return;
          try {
            var r = await fetch(BASE + "/admin/account", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ uid: uid, action: kind }),
            });
            var d = await r.json();
            if (!d.ok) {
              if (d.error && d.error.indexOf("admin.enabled") >= 0) adminHint = true;
              window.__uiAlert ? window.__uiAlert("提示", label + "失败：" + (d.error || JSON.stringify(d.payload))) : uiAlert(label + "失败：" + (d.error || JSON.stringify(d.payload)));
            }
          } catch (e) {
            window.__uiAlert ? window.__uiAlert("提示", label + "失败：" + String(e)) : uiAlert(label + "失败：" + String(e));
          } finally {
            loadAll();
          }
        }

        async function ensureAdmin() {
          if (!confirm("开启网关管理端点（config admin.enabled=true）并重启网关？期间上游中断几秒。")) return;
          var btn = byId("wbc-admin-ensure");
          btn.disabled = true;
          btn.querySelector(".btn-label").textContent = "处理中…";
          try {
            var r = await fetch(BASE + "/admin/ensure", { method: "POST" });
            var d = await r.json();
            if (d.ok) {
              adminHint = false;
              window.__uiAlert ? window.__uiAlert("提示", d.changed ? "已开启并重启网关。" : "管理端点原本就已开启，无需改动。") : uiAlert(d.changed ? "已开启并重启网关。" : "管理端点原本就已开启，无需改动。");
            } else {
              window.__uiAlert ? window.__uiAlert("提示", "失败：" + JSON.stringify(d.restart || d.error)) : uiAlert("失败：" + JSON.stringify(d.restart || d.error));
            }
          } finally {
            btn.disabled = false;
            btn.querySelector(".btn-label").textContent = "开启管理端点并重启网关";
            loadAll();
          }
        }

        function busy(btn, on, label) {
          if (!btn) return;
          var span = btn.querySelector(".btn-label");
          btn.disabled = on;
          if (span) span.textContent = on ? "执行中…" : label;
        }

        var reportRunning = false;
        async function doReport(silent) {
          if (reportRunning) return;
          reportRunning = true;
          var btn = byId("wbc-report");
          var body = byId("wbc-report-body");
          var setBody = function (html) {
            if (!body) return;
            body.hidden = false;
            body.innerHTML = html;
          };
          if (!silent) {
            busy(btn, true, "刷新积分日报");
            setBody('<div class="empty">正在实查上游余额，多账号时可能要等一会…</div>');
          }
          try {
            var r = await fetch(BASE + "/report", { method: "POST" });
            var d = await r.json();
            if (!d.ok) {
              if (!silent) setBody('<div class="empty"><span class="dot err"></span>' + esc(d.error) + "</div>");
              return;
            }
            var rep = d.report || {};
            var total = rep.total || {};
            var accs = Array.isArray(rep.accounts) ? rep.accounts : [];
            var fetchedAt = new Date(d.at).toLocaleTimeString("zh-CN", { hour12: false });
            accs.forEach(function (a) {
              if (a.uid) creditsCache[a.uid] = { remain: a.remain, time: fetchedAt };
            });
            loadAll();
            if (silent) return;
            var html = '<div class="rp-sum">' +
              '<span class="rp-k">剩余</span><b>' + (total.remain != null ? total.remain : "—") + "</b>" +
              '<span class="rp-k">已用</span><b>' + (total.used != null ? total.used : "—") + "</b>" +
              '<span class="rp-k">总量</span><b>' + (total.size != null ? total.size : "—") + "</b>" +
              '<span class="rp-time">' + fetchedAt + "</span></div>";
            html += '<table class="rp-table"><thead><tr><th>账号</th><th class="num">剩余</th><th class="num">已用</th><th class="num">总量</th><th class="num">礼包</th></tr></thead><tbody>';
            accs.forEach(function (a) {
              var name = (a.nickname || String(a.uid || "").slice(0, 8));
              html += "<tr>" +
                "<td>" + esc(name) + (a.ok ? "" : ' <span class="rp-fail">失败</span>') + "</td>" +
                '<td class="num">' + (a.remain != null ? a.remain : "—") + "</td>" +
                '<td class="num">' + (a.used != null ? a.used : "—") + "</td>" +
                '<td class="num">' + (a.size != null ? a.size : "—") + "</td>" +
                '<td class="num">' + (a.packages != null ? a.packages : "—") + "</td>" +
                "</tr>";
            });
            html += "</tbody></table>";
            setBody(html);
          } catch (e) {
            if (!silent) setBody('<div class="empty"><span class="dot err"></span>' + esc(String(e)) + "</div>");
          } finally {
            reportRunning = false;
            if (!silent) busy(btn, false, "刷新积分日报");
            loadAll();
          }
        }

        async function doCheckin() {
          var btn = byId("wbc-checkin");
          var out = byId("wbc-checkin-out");
          busy(btn, true, "立即签到");
          out.className = "show";
          out.textContent = "正在签到（幂等，已签过不再重复计）…";
          try {
            var r = await fetch(BASE + "/checkin", { method: "POST" });
            var d = await r.json();
            if (!d.ok) {
              out.textContent = "签到失败：" + (d.error || "");
              return;
            }
            var need = d.needRelogin || [];
            var sum = d.summary || { total: (d.accounts || []).length, ok: 0, already: 0, fail: 0 };
            var when = new Date(d.at).toLocaleTimeString("zh-CN", { hour12: false });
            var STATUS = { ALREADY: "today", OK: "ok", AUTH_INVALID: "bad" };
            var TEXT = { ALREADY: "今天已签", OK: "签到成功", AUTH_INVALID: "凭证失效" };
            var html = ['<div class="ck-sum"><b>' + esc(when) + '</b>',
              '<span>共 ' + sum.total + ' 个</span>',
              '<span class="ok">成功 ' + sum.ok + '</span>',
              '<span>今天已签 ' + sum.already + '</span>',
              (sum.fail ? '<span class="bad">失败 ' + sum.fail + '</span>' : ''),
              '</div><div class="ck-list">'];
            (d.accounts || []).forEach(function (a) {
              var cls = STATUS[a.status] || "unknown";
              html.push('<div class="ck-row">' +
                '<span class="ck-dot ' + cls + '"></span>' +
                '<span class="ck-name">' + esc(a.nick || a.uid.slice(0, 8)) + '</span>' +
                '<span class="ck-uid">' + esc(a.uid.slice(0, 8)) + '</span>' +
                '<span class="ck-state ' + cls + '">' + esc(TEXT[a.status] || a.status || "未知") + '</span>' +
                (a.remain && a.remain !== "-" ? '<span class="ck-credit">' + esc(a.remain) + ' 积分</span>' : '') +
                (a.detail ? '<span class="ck-detail">' + esc(a.detail) + '</span>' : '') +
                '</div>');
            });
            html.push('</div>');
            if (need.length) {
              html.push('<div class="ck-warn">⚠ ' + need.length + ' 个账号的 refresh_token 已失效，需要重新扫码登录；停用后不再参与选号</div>');
            }
            out.innerHTML = html.join("");
            if (need.length) {
              var bar = document.createElement("div");
              bar.className = "ck-actions";
              var relinkBtn = document.createElement("button");
              relinkBtn.type = "button";
              relinkBtn.className = "btn sm";
              relinkBtn.textContent = "停用这 " + need.length + " 个失效账号";
              relinkBtn.onclick = async function () {
                relinkBtn.disabled = true;
                relinkBtn.textContent = "处理中…";
                for (var k = 0; k < need.length; k++) {
                  await fetch(BASE + "/admin/account", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ uid: need[k].uid, action: "disable" }),
                  }).catch(function () {});
                }
                relinkBtn.textContent = "已停用";
                loadAll();
              };
              bar.appendChild(relinkBtn);
              out.appendChild(bar);
            }
          } catch (e) {
            out.textContent = "签到失败：" + String(e);
          } finally {
            busy(btn, false, "立即签到");
            loadAll();
          }
        }

        byId("wbc-report").addEventListener("click", function () { doReport(false); });
        byId("wbc-checkin").addEventListener("click", doCheckin);
        byId("wbc-admin-ensure").addEventListener("click", ensureAdmin);

        // ── WorkBuddy OAuth 登录闭环 ──
        var wbLoginTimer = null;
        var wbLoginRealm = "cn";
        function wbStopPoll() {
          if (wbLoginTimer) { clearInterval(wbLoginTimer); wbLoginTimer = null; }
        }
        function wbRealm() {
          var checked = document.querySelector('input[name="wbc-realm"]:checked');
          return checked ? checked.value : "cn";
        }
        async function wbPollOnce(startedAt) {
          var stateEl = byId("wbc-login-state");
          try {
            var r = await fetch(BASE + "/login/poll", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ realm: wbLoginRealm }),
            });
            var d = await r.json();
            if (d.ok) {
              wbStopPoll();
              stateEl.innerHTML = '<span class="dot ok"></span>登录成功：' + esc(d.nickname || d.uid) +
                "（" + d.action + "，已入池）· 首签：" + esc(d.checkin || "—");
              setTimeout(function () { byId("wbc-login-box").className = ""; }, 4000);
              loadAll();
              return;
            }
            var waitSec = Math.round((Date.now() - startedAt) / 1000);
            stateEl.textContent = "等待登录完成…（已等 " + waitSec + " 秒，5 分钟超时）";
            if (waitSec > 300) {
              wbStopPoll();
              stateEl.innerHTML = '<span class="dot err"></span>超时未完成，可重新发起';
            }
          } catch (e) {
            stateEl.textContent = "轮询异常：" + String(e);
          }
        }
        async function wbStartLogin() {
          var box = byId("wbc-login-box");
          var stateEl = byId("wbc-login-state");
          wbLoginRealm = wbRealm();
          box.className = "show";
          stateEl.textContent = "正在生成授权链接…";
          try {
            var r = await fetch(BASE + "/login/start", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ realm: wbLoginRealm }),
            });
            var d = await r.json();
            if (!d.ok || !d.authUrl) {
              stateEl.innerHTML = '<span class="dot err"></span>发起失败：' + esc(d.error || "");
              return;
            }
            var link = byId("wbc-login-url");
            link.href = d.authUrl;
            link.textContent = d.authUrl;
            stateEl.innerHTML = "2. 登录完成后凭证自动落盘入池（网关监听 auths 目录，无需重启）。";
            var startedAt = Date.now();
            wbStopPoll();
            wbLoginTimer = setInterval(function () { wbPollOnce(startedAt); }, 4000);
            wbPollOnce(startedAt);
          } catch (e) {
            stateEl.innerHTML = '<span class="dot err"></span>发起失败：' + esc(String(e));
          }
        }
        byId("wbc-login").addEventListener("click", wbStartLogin);
        byId("wbc-login-cancel").addEventListener("click", function () {
          wbStopPoll();
          byId("wbc-login-box").className = "";
        });

        loadAll();
        // 首次加载自动静默实查一次积分，账号行直接显示实时值（与 Trae 卡同款；失败静默）
        setTimeout(function () { doReport(true); }, 800);
        setInterval(loadAll, 15000);
      })();
      </script>
    `);
  },
};

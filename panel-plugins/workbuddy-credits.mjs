#!/usr/bin/env node
/**
 * workbuddy-credits.mjs — 控制面板插件：WorkBuddy 积分 / 账号管理（对齐 WorkBuddy Manager 的常用面）。
 *
 * 数据与动作全部来自 workbuddy2api（网关目录）：
 *   - 池状态：GET <网关>/status（本地网关，随页面轮询）— 账号、冷却、启停、限流、成本台账
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

    // ── WorkBuddy OAuth 登录闭环（驱动网关目录预构建的 login.exe）──
    // url 子命令：POST /v2/plugin/auth/state 拿授权链接（state 落 %TEMP%，无 PKCE）
    registerRoute("POST", "/login/start", async (req, res, { json, readBody }) => {
      const s = settings();
      const body = await readBody(req);
      const realm = body.realm === "global" ? "global" : "cn";
      const exe = path.join(s.gatewayDir, "login.exe");
      if (!fs.existsSync(exe)) {
        return json(res, 200, { ok: false, error: `找不到 ${exe}` });
      }
      const r = await runCommand(exe, [`--realm=${realm}`, "url"], {
        cwd: s.gatewayDir,
        timeoutMs: 30000,
      });
      if (!r.ok) {
        return json(res, 200, {
          ok: false,
          error: "获取授权链接失败：" + (r.stderr || r.stdout || "").slice(-200),
        });
      }
      const authUrl = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      if (!/^https?:\/\//.test(authUrl)) {
        return json(res, 200, { ok: false, error: `输出异常：${r.stdout.slice(0, 200)}` });
      }
      return json(res, 200, { ok: true, realm, authUrl });
    });

    // poll 子命令：GET token + account；成功后落盘 auths/workbuddy-<uid>.json（网关
    // StartAuthDirWatch 自动入池，无需重启），CN 域顺带补一次幂等签到
    registerRoute("POST", "/login/poll", async (req, res, { json, readBody }) => {
      const s = settings();
      const body = await readBody(req);
      const realm = body.realm === "global" ? "global" : "cn";
      const exe = path.join(s.gatewayDir, "login.exe");
      if (!fs.existsSync(exe)) {
        return json(res, 200, { ok: false, error: `找不到 ${exe}` });
      }
      const r = await runCommand(exe, [`--realm=${realm}`, "poll"], {
        cwd: s.gatewayDir,
        timeoutMs: 30000,
      });
      if (!r.ok) {
        // 未完成登录时 token 端点会报错——返回 retry 让前端继续轮询
        return json(res, 200, { ok: false, retry: true, detail: (r.stderr || r.stdout || "").slice(-160) });
      }
      const cred = parseJsonLoose(r.stdout);
      if (!cred?.access_token || !cred?.uid) {
        return json(res, 200, { ok: false, retry: true, detail: "凭证字段缺失，等待登录完成" });
      }
      const expiresAt = Math.floor(Date.now() / 1000) + Number(cred.expires_in || 0);
      const authFile = path.join(s.gatewayDir, "auths", `workbuddy-${cred.uid}.json`);
      const existed = fs.existsSync(authFile);
      fs.writeFileSync(
        authFile,
        JSON.stringify(
          {
            account: {
              uid: cred.uid,
              enterpriseId: cred.enterprise_id || "",
              nickname: cred.nickname || "",
            },
            auth: {
              accessToken: cred.access_token,
              refreshToken: cred.refresh_token || "",
              expiresAt,
              domain: cred.domain || "",
              realm,
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      // CN 域首签（幂等，失败不阻塞入池）
      let checkin = "global 跳过";
      if (realm === "cn") {
        try {
          const headers = {
            Authorization: `Bearer ${cred.access_token}`,
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
            headers,
            body: "{}",
          }, 15000).catch(() => null);
          const payload = cr?.payload;
          checkin = payload?.msg || payload?.data?.message || (cr?.ok ? "成功" : "已签到/无返回");
        } catch {
          checkin = "签到请求失败（不影响入池）";
        }
      }

      return json(res, 200, {
        ok: true,
        uid: cred.uid,
        nickname: cred.nickname || "",
        action: existed ? "覆盖更新" : "新增",
        checkin,
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
      return json(res, 200, { ok: true, output: r.stdout.trim(), at: new Date().toISOString() });
    });

    registerCard(`
      <section class="card">
        <h2>WorkBuddy 积分（插件）</h2>
        <div class="rows" id="wbc-pool"><div class="empty">加载中…</div></div>
        <div class="rows" id="wbc-stats"><div class="empty">统计加载中…</div></div>
        <div class="actions">
          <button class="btn primary" type="button" id="wbc-login"><span class="btn-label">登录新账号</span></button>
          <button class="btn" type="button" id="wbc-report"><span class="btn-label">刷新积分日报</span></button>
          <button class="btn" type="button" id="wbc-checkin"><span class="btn-label">立即签到</span></button>
          <button class="btn" type="button" id="wbc-admin-ensure"><span class="btn-label">开启管理端点并重启网关</span></button>
        </div>
        <div id="wbc-login-box">
          <div>域：
            <label><input type="radio" name="wbc-realm" value="cn" checked /> 国内版 cn</label>
            <label><input type="radio" name="wbc-realm" value="global" /> 国际版 global</label>
          </div>
          <div>1. 打开授权链接，用 WorkBuddy 账号登录：</div>
          <div><a id="wbc-login-url" href="#" target="_blank" rel="noopener">(生成中…)</a></div>
          <div id="wbc-login-state">等待发起…</div>
          <div class="actions" style="margin-top: 8px;">
            <button class="btn" type="button" id="wbc-login-cancel"><span class="btn-label">取消登录</span></button>
          </div>
        </div>
        <div class="rows" id="wbc-report-body">
          <div class="empty">积分日报未拉取。点「刷新积分日报」会实查上游余额（走 workbuddy2api 的 credit 工具）。</div>
        </div>
        <style>
          #wbc-checkin-out {
            display: none; margin: 8px 0 0; padding: 10px 12px;
            background: var(--panel-2); border: 1px solid var(--line);
            border-left: 2px solid var(--accent); border-radius: 8px;
            color: var(--ink); font: 12px/1.6 ui-monospace, Consolas, monospace;
            white-space: pre-wrap; word-break: break-all; max-height: 240px; overflow: auto;
          }
          #wbc-checkin-out.show { display: block; }
          #wbc-login-box { display: none; margin: 8px 0 0; padding: 10px 12px;
            background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; }
          #wbc-login-box.show { display: block; }
          #wbc-login-box a { color: var(--accent-2); word-break: break-all; }
          #wbc-login-box label { margin-right: 10px; }
          #wbc-login-state { margin-top: 6px; color: var(--muted); font-size: 12px; }
          .wbc-act { cursor: pointer; margin-left: 6px; }
        </style>
        <pre id="wbc-checkin-out"></pre>
      </section>
      <script>
      (function () {
        var BASE = "/api/plugins/workbuddy-credits";
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
          return '<span class="wbc-act" data-act="' + esc(fn) + '">' + esc(label) + "</span>";
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
          if (!d || !d.ok) {
            el.innerHTML = row("账号池", '<span class="dot err"></span>' + esc(d && d.error ? d.error : "不可达"));
            return;
          }
          var st = d.status;
          var rt = st.realm_totals || {};
          var html =
            row("账号池", '<span class="dot ok"></span>' + esc(poolText(st))) +
            row("cn 域", esc(poolText(rt.cn))) +
            row("global 域", esc(poolText(rt.global)));
          var accs = Array.isArray(st.accounts) ? st.accounts : [];
          accountsCache = accs;
          accs.forEach(function (a) {
            var flags =
              (a.cooling ? ' <span class="chip warn">冷却</span>' : "") +
              (a.disabled ? ' <span class="chip err">自动禁用</span>' : "") +
              (a.manual_disabled ? ' <span class="chip err">手动停用</span>' : "") +
              ((a.rate_limited_models || []).length ? ' <span class="chip warn">限流 ' + a.rate_limited_models.length + "</span>" : "");
            var acts =
              (a.manual_disabled ? act("启用", "enable:" + a.uid) : act("停用", "disable:" + a.uid)) +
              act("复活", "revive:" + a.uid) +
              act("台账", "ledger:" + a.uid);
            html += row(
              (a.nickname || String(a.uid || "").slice(0, 8)) + (a.realm ? " · " + a.realm : ""),
              fmtBalance(a) + " · 成功 " + (a.success_count || 0) + " 次" +
                ((a.model_costs || []).length ? " · 台账 " + a.model_costs.length + " 模型" : "") + flags + " " + acts,
            );
          });
          if (adminHint) {
            html += row("管理端点", '<span class="dot warn"></span>未开启 · 点「开启管理端点并重启网关」');
          }
          el.innerHTML = html;
          var nodes = el.querySelectorAll(".wbc-act");
          for (var i = 0; i < nodes.length; i++) nodes[i].addEventListener("click", onAct);
        }

        function renderStats(d) {
          if (!d || !d.ok) return;
          var t = (d.stats && d.stats.total) || {};
          var successRate = t.requests ? Math.round((t.success / t.requests) * 100) : null;
          var cacheRate = t.prompt_tokens ? Math.round((t.cache_hit_tokens / t.prompt_tokens) * 100) : null;
          byId("wbc-stats").innerHTML = row(
            "用量统计",
            (t.requests != null
              ? t.requests + " 请求 · 成功率 " + (successRate != null ? successRate + "%" : "—") +
                " · " + (t.total_tokens / 10000).toFixed(1) + " 万 token" +
                (cacheRate != null ? " · 缓存命中 " + cacheRate + "%" : "") +
                " · 均速 " + Math.round(t.tokens_per_sec || 0) + " tok/s"
              : "—"),
          );
        }

        async function loadAll() {
          try {
            var r = await fetch(BASE + "/status", { cache: "no-store" });
            renderPool(await r.json());
          } catch (e) {
            byId("wbc-pool").innerHTML = row("账号池", '<span class="dot err"></span>' + esc(String(e)));
          }
          try {
            var r2 = await fetch(BASE + "/stats", { cache: "no-store" });
            renderStats(await r2.json());
          } catch (e) { /* stats 可选 */ }
        }

        async function onAct(ev) {
          var spec = ev.target.getAttribute("data-act") || "";
          var kind = spec.split(":")[0];
          var uid = spec.slice(kind.length + 1);
          if (kind === "ledger") {
            var acc = accountsCache.filter(function (a) { return a.uid === uid; })[0] || {};
            alert("成本台账（每千 token 实测单价，6 小时未更新失效）：\\n" + ledgerText(acc));
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
              alert(label + "失败：" + (d.error || JSON.stringify(d.payload)));
            }
          } catch (e) {
            alert(label + "失败：" + String(e));
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
              alert(d.changed ? "已开启并重启网关。" : "管理端点原本就已开启，无需改动。");
            } else {
              alert("失败：" + JSON.stringify(d.restart || d.error));
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
          if (!silent) {
            busy(btn, true, "刷新积分日报");
            body.innerHTML = '<div class="empty">正在实查上游余额，多账号时可能要等一会…</div>';
          }
          try {
            var r = await fetch(BASE + "/report", { method: "POST" });
            var d = await r.json();
            if (!d.ok) {
              if (!silent) body.innerHTML = '<div class="empty"><span class="dot err"></span>' + esc(d.error) + "</div>";
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
            var html =
              row("积分日报", '<span class="dot ok"></span>剩余 ' + (total.remain != null ? total.remain : "—") +
                " · 已用 " + (total.used != null ? total.used : "—") +
                " · 总量 " + (total.size != null ? total.size : "—") +
                " · " + fetchedAt);
            accs.forEach(function (a) {
              html += row(
                (a.nickname || String(a.uid || "").slice(0, 8)) + (a.ok ? "" : " · 失败"),
                "剩 " + (a.remain != null ? a.remain : "—") + " / 用 " + (a.used != null ? a.used : "—") +
                  " / 量 " + (a.size != null ? a.size : "—") + " · 礼包 " + (a.packages != null ? a.packages : "—"),
              );
            });
            body.innerHTML = html;
          } catch (e) {
            if (!silent) body.innerHTML = '<div class="empty"><span class="dot err"></span>' + esc(String(e)) + "</div>";
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
            out.textContent = "[" + new Date(d.at).toLocaleTimeString("zh-CN", { hour12: false }) + "]\\n" + d.output;
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

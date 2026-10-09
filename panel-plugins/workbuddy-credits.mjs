#!/usr/bin/env node
/**
 * workbuddy-credits.mjs — 控制面板插件：WorkBuddy 积分 / 签到。
 *
 * 数据与动作全部来自 workbuddy2api（网关目录）：
 *   - 池状态：GET <网关>/status（本地网关，随页面轮询）
 *   - 积分日报：credit.exe -json（实查上游余额，手动触发）
 *   - 手动签到：signin_bin.exe auths（幂等；网关本身 09/21 点也有定时签到）
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

export default {
  id: "workbuddy-credits",
  title: "WorkBuddy 积分",
  init({ registerRoute, registerCard, settings, runCommand, fetchJson }) {
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
        <div class="actions">
          <button class="btn" type="button" id="wbc-report"><span class="btn-label">刷新积分日报</span></button>
          <button class="btn" type="button" id="wbc-checkin"><span class="btn-label">立即签到</span></button>
        </div>
        <div class="rows" id="wbc-report-body">
          <div class="empty">积分日报未拉取。点「刷新积分日报」会实查上游余额（走 workbuddy2api 的 credit 工具）。</div>
        </div>
        <style>
          #wbc-checkin-out {
            display: none; margin: 8px 0 0; padding: 10px 12px;
            background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
            color: var(--ink); font: 12px/1.6 ui-monospace, Consolas, monospace;
            white-space: pre-wrap; word-break: break-all; max-height: 240px; overflow: auto;
          }
          #wbc-checkin-out.show { display: block; }
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
        function poolText(t) {
          if (!t) return "—";
          return t.total + " 账号 · 健康 " + t.healthy + " · 冷却 " + t.cooling + " · 停用 " + t.disabled;
        }

        async function loadPool() {
          var el = byId("wbc-pool");
          if (!el) return;
          try {
            var r = await fetch(BASE + "/status", { cache: "no-store" });
            var d = await r.json();
            if (!d.ok || !d.status) {
              el.innerHTML = row("账号池", '<span class="dot warn"></span>' + esc(d.error || "不可达"));
              return;
            }
            var st = d.status;
            var rt = st.realm_totals || {};
            var html =
              row("账号池", '<span class="dot ok"></span>' + esc(poolText(st))) +
              row("cn 域", esc(poolText(rt.cn))) +
              row("global 域", esc(poolText(rt.global)));
            var accs = Array.isArray(st.accounts) ? st.accounts : [];
            accs.forEach(function (a) {
              var flags =
                (a.cooling ? ' <span class="chip">冷却</span>' : "") +
                (a.disabled || a.manual_disabled ? ' <span class="chip">停用</span>' : "");
              html += row(
                (a.nickname || String(a.uid || "").slice(0, 8)) + (a.realm ? " · " + a.realm : ""),
                "余额 " + (a.credits != null ? a.credits : "—") + " · 成功 " + (a.success_count || 0) + " 次" + flags,
              );
            });
            el.innerHTML = html;
          } catch (e) {
            el.innerHTML = row("账号池", '<span class="dot err"></span>' + esc(String(e)));
          }
        }

        function busy(btn, on, label) {
          if (!btn) return;
          var span = btn.querySelector(".btn-label");
          btn.disabled = on;
          if (span) span.textContent = on ? "执行中…" : label;
        }

        async function doReport() {
          var btn = byId("wbc-report");
          var body = byId("wbc-report-body");
          busy(btn, true, "刷新积分日报");
          body.innerHTML = '<div class="empty">正在实查上游余额，多账号时可能要等一会…</div>';
          try {
            var r = await fetch(BASE + "/report", { method: "POST" });
            var d = await r.json();
            if (!d.ok) {
              body.innerHTML = '<div class="empty"><span class="dot err"></span>' + esc(d.error) + "</div>";
              return;
            }
            var rep = d.report || {};
            var total = rep.total || {};
            var accs = Array.isArray(rep.accounts) ? rep.accounts : [];
            var html =
              row("积分日报", '<span class="dot ok"></span>剩余 ' + (total.remain != null ? total.remain : "—") +
                " · 已用 " + (total.used != null ? total.used : "—") +
                " · 总量 " + (total.size != null ? total.size : "—") +
                " · " + new Date(d.at).toLocaleTimeString("zh-CN", { hour12: false }));
            accs.forEach(function (a) {
              html += row(
                (a.nickname || String(a.uid || "").slice(0, 8)) + (a.ok ? "" : " · 失败"),
                "剩 " + (a.remain != null ? a.remain : "—") + " / 用 " + (a.used != null ? a.used : "—") +
                  " / 量 " + (a.size != null ? a.size : "—") + " · 礼包 " + (a.packages != null ? a.packages : "—"),
              );
            });
            body.innerHTML = html;
          } catch (e) {
            body.innerHTML = '<div class="empty"><span class="dot err"></span>' + esc(String(e)) + "</div>";
          } finally {
            busy(btn, false, "刷新积分日报");
            loadPool();
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
            loadPool();
          }
        }

        byId("wbc-report").addEventListener("click", doReport);
        byId("wbc-checkin").addEventListener("click", doCheckin);
        loadPool();
        setInterval(loadPool, 15000);
      })();
      </script>
    `);
  },
};

#!/usr/bin/env node
/**
 * workbuddy-tasks.mjs — 控制面板插件：WorkBuddy 自动任务。
 *
 * 覆盖 workbuddy2api 的「自动赚积分」体系：
 *   - 六类定时任务（签到/猫猫旅行/活跃地图/保活/开学季/夜猫子）：
 *     总览（开关 + 执行时刻 + 下次运行估算）、config.json 开关切换、重启网关生效
 *   - 成长任务一体机 scripts/task_runner.py：dry-run 查询 / --yes 全量完成+领奖
 *   - 手动签到入口同积分插件（signin_bin），此处不重复
 */
import fs from "node:fs";
import path from "node:path";

const TASKS = [
  { key: "checkin", name: "签到", defHours: [9, 21] },
  { key: "travel", name: "猫猫旅行", defHours: [9, 21] },
  { key: "activity", name: "活跃地图", defHours: [10] },
  { key: "keepalive", name: "token 保活", defHours: [22] },
  { key: "school", name: "开学季任务", defHours: [12] },
  { key: "cat", name: "夜猫子任务", defHours: [1] },
];

function readGatewayConfig(gatewayConfig) {
  try {
    if (fs.existsSync(gatewayConfig)) {
      return JSON.parse(fs.readFileSync(gatewayConfig, "utf8"));
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

function nextRunFrom(hours) {
  const now = new Date();
  for (let day = 0; day < 2; day++) {
    for (const hour of hours) {
      const t = new Date(now);
      t.setDate(now.getDate() + day);
      t.setHours(hour, 0, 0, 0);
      if (t > now) return t;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "workbuddy-tasks",
  title: "WorkBuddy 自动任务",
  init({ registerRoute, registerCard, settings, runCommand, fetchJson, readText }) {
    function taskOverview() {
      const s = settings();
      const cfg = readGatewayConfig(s.gatewayConfig);
      const schedule = cfg?.schedule || {};
      return TASKS.map((task) => {
        const hours = Array.isArray(schedule[`${task.key}_hours`])
          ? schedule[`${task.key}_hours`]
          : task.defHours;
        const enabled = schedule[`${task.key}_enabled`] !== false;
        const next = nextRunFrom(hours);
        return {
          key: task.key,
          name: task.name,
          hours,
          enabled,
          nextRun: next ? next.toLocaleString("zh-CN", { hour12: false }) : "—",
          nextInMin: next ? Math.round((next - Date.now()) / 60000) : null,
        };
      });
    }

    async function gatewayOnline() {
      const s = settings();
      try {
        const r = await fetchJson(`${s.workbuddyUrl}/healthz`, {}, 1500);
        return Boolean(r.ok);
      } catch {
        return false;
      }
    }

    registerRoute("GET", "/status", async (req, res, { json }) => {
      const s = settings();
      return json(res, 200, {
        ok: true,
        gatewayOnline: await gatewayOnline(),
        tasks: taskOverview(),
        taskRunnerExists: fs.existsSync(path.join(s.gatewayDir, "scripts", "task_runner.py")),
      });
    });

    registerRoute("POST", "/toggle", async (req, res, { json, readBody }) => {
      const s = settings();
      const body = await readBody(req);
      const task = TASKS.find((t) => t.key === String(body.key || ""));
      if (!task) {
        return json(res, 400, { ok: false, error: `未知任务 key：${body.key}` });
      }
      const cfg = readGatewayConfig(s.gatewayConfig);
      if (!cfg) {
        return json(res, 200, { ok: false, error: `读不到网关配置：${s.gatewayConfig}` });
      }
      cfg.schedule = cfg.schedule || {};
      cfg.schedule[`${task.key}_enabled`] = Boolean(body.enabled);
      fs.writeFileSync(s.gatewayConfig, JSON.stringify(cfg, null, 2), "utf8");
      return json(res, 200, {
        ok: true,
        key: task.key,
        enabled: Boolean(body.enabled),
        gatewayOnline: await gatewayOnline(),
        tasks: taskOverview(),
        restartNeeded: true,
      });
    });

    async function restartGateway() {
      const s = settings();
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
      const out = path.join(logDir, "server.out.log");
      const err = path.join(logDir, "server.err.log");
      const q = (p) => p.replace(/'/g, "''");
      await runCommand(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `$p = Start-Process -FilePath '${q(s.gatewayExe)}' ` +
            `-ArgumentList '-config','config.json' ` +
            `-WorkingDirectory '${q(s.gatewayDir)}' -WindowStyle Hidden ` +
            `-RedirectStandardOutput '${q(out)}' -RedirectStandardError '${q(err)}' -PassThru; ` +
            `[IO.File]::WriteAllText('${q(pidFile)}', [string]$p.Id); $p.Id`,
        ],
        { timeoutMs: 15000 },
      );
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        try {
          const r = await fetchJson(`${s.workbuddyUrl}/healthz`, {}, 1500);
          if (r.ok) return { ok: true };
        } catch {
          /* still booting */
        }
      }
      return { ok: false, detail: "已拉起但 healthz 20s 未就绪，见 data/server.err.log" };
    }

    registerRoute("POST", "/restart-gateway", async (req, res, { json }) => {
      const result = await restartGateway();
      return json(res, 200, {
        ...result,
        gatewayOnline: await gatewayOnline(),
        tasks: taskOverview(),
      });
    });

    registerRoute("POST", "/taskrunner", async (req, res, { json, readBody }) => {
      const s = settings();
      const script = path.join(s.gatewayDir, "scripts", "task_runner.py");
      if (!fs.existsSync(script)) {
        return json(res, 200, { ok: false, error: `找不到 ${script}` });
      }
      const body = await readBody(req);
      const mode = body.mode === "run" ? "run" : "dry";
      const account = String(body.account || "ALL").trim() || "ALL";
      const args = [script, account];
      if (mode === "run") args.push("--yes");
      const r = await runCommand("python", args, {
        cwd: s.gatewayDir,
        timeoutMs: mode === "run" ? 600000 : 240000,
      });
      if (!r.ok) {
        return json(res, 200, {
          ok: false,
          error: (r.stderr || r.stdout || "task_runner 失败").slice(-600),
        });
      }
      return json(res, 200, {
        ok: true,
        mode,
        output: r.stdout.trim(),
        at: new Date().toISOString(),
      });
    });

    registerCard(`
      <section class="card">
        <h2>WorkBuddy 自动任务（插件）</h2>
        <div class="rows" id="wbt-tasks"><div class="empty">加载中…</div></div>
        <div class="actions">
          <button class="btn" type="button" id="wbt-restart"><span class="btn-label">重启网关（应用开关）</span></button>
        </div>
        <style>
          #wbt-out {
            display: none; margin: 8px 0 0; padding: 10px 12px;
            background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
            color: var(--ink); font: 12px/1.6 ui-monospace, Consolas, monospace;
            white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow: auto;
          }
          #wbt-out.show { display: block; }
          #wbt-tasks .toggle {
            cursor: pointer; user-select: none; margin-left: 6px;
          }
        </style>
        <div class="actions" style="margin-top: 8px;">
          <button class="btn" type="button" id="wbt-dry"><span class="btn-label">查询成长任务 (dry-run)</span></button>
          <button class="btn danger" type="button" id="wbt-run"><span class="btn-label">完成+领奖 (--yes)</span></button>
        </div>
        <pre id="wbt-out"></pre>
      </section>
      <script>
      (function () {
        var BASE = "/api/plugins/workbuddy-tasks";
        function byId(id) { return document.getElementById(id); }
        function esc(s) {
          return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
          });
        }
        function row(k, v) {
          return '<div class="row"><div class="k">' + esc(k) + '</div><div class="v">' + v + "</div></div>";
        }
        function fmtIn(min) {
          if (min == null) return "";
          if (min < 60) return "（" + min + " 分钟后）";
          var h = Math.floor(min / 60);
          return "（" + (h >= 24 ? Math.floor(h / 24) + " 天后" : h + " 小时后") + "）";
        }
        var restartNeeded = false;

        function renderTasks(d) {
          var el = byId("wbt-tasks");
          if (!d || !d.ok) {
            el.innerHTML = row("定时任务", '<span class="dot err"></span>' + esc((d && d.error) || "加载失败"));
            return;
          }
          var html = row(
            "网关",
            d.gatewayOnline
              ? '<span class="dot ok"></span>在线' + (restartNeeded ? ' · <span class="badge on">有未生效开关</span>' : "")
              : '<span class="dot err"></span>离线（定时任务不运行）',
          );
          (d.tasks || []).forEach(function (t) {
            var state = t.enabled
              ? '<span class="dot ok"></span>开'
              : '<span class="dot err"></span>关';
            html += row(
              t.name,
              state + ' <span class="toggle" data-key="' + esc(t.key) + '" data-enabled="' + (t.enabled ? "0" : "1") + '">[切换]</span>' +
                " · " + t.hours.join("/") + " 点 · 下次 " + esc(t.nextRun) + " " + fmtIn(t.nextInMin),
            );
          });
          if (d.taskRunnerExists === false) {
            html += row("成长任务", '<span class="dot warn"></span>缺 scripts/task_runner.py');
          }
          el.innerHTML = html;
          var toggles = el.querySelectorAll(".toggle");
          for (var i = 0; i < toggles.length; i++) {
            toggles[i].addEventListener("click", onToggle);
          }
        }

        async function loadStatus() {
          try {
            var r = await fetch(BASE + "/status", { cache: "no-store" });
            renderTasks(await r.json());
          } catch (e) {
            byId("wbt-tasks").innerHTML = row("定时任务", '<span class="dot err"></span>' + esc(String(e)));
          }
        }

        async function onToggle(ev) {
          var target = ev.target;
          var key = target.getAttribute("data-key");
          var enabled = target.getAttribute("data-enabled") === "1";
          try {
            var r = await fetch(BASE + "/toggle", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ key: key, enabled: enabled }),
            });
            var d = await r.json();
            if (d.ok) {
              restartNeeded = true;
              renderTasks(d);
            } else {
              alert(d.error || "切换失败");
            }
          } catch (e) {
            alert("切换失败：" + String(e));
          }
        }

        function busy(btn, on, label) {
          if (!btn) return;
          var span = btn.querySelector(".btn-label");
          btn.disabled = on;
          if (span) span.textContent = on ? "执行中…" : label;
        }

        async function onRestart() {
          if (!confirm("重启 workbuddy2api 网关以应用定时任务开关？期间 WorkBuddy 上游会中断几秒。")) return;
          var btn = byId("wbt-restart");
          busy(btn, true, "重启网关（应用开关）");
          try {
            var r = await fetch(BASE + "/restart-gateway", { method: "POST" });
            var d = await r.json();
            restartNeeded = false;
            renderTasks(d);
            if (!d.ok) alert("网关重启异常：" + (d.detail || "healthz 未就绪"));
          } catch (e) {
            alert("重启失败：" + String(e));
          } finally {
            busy(btn, false, "重启网关（应用开关）");
          }
        }

        async function runTaskRunner(mode) {
          if (mode === "run" &&
              !confirm("对全部账号执行成长任务完成+领奖（--yes）？会真实调用上游接口，可能需要几分钟。")) {
            return;
          }
          var out = byId("wbt-out");
          out.className = "show";
          out.textContent = mode === "run" ? "正在完成+领奖（accept→点亮→claim，动作间隔 ≥1s）…" : "正在查询任务现状（dry-run，只读）…";
          var btn = byId(mode === "run" ? "wbt-run" : "wbt-dry");
          busy(btn, true, mode === "run" ? "完成+领奖 (--yes)" : "查询成长任务 (dry-run)");
          try {
            var r = await fetch(BASE + "/taskrunner", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ mode: mode, account: "ALL" }),
            });
            var d = await r.json();
            if (!d.ok) {
              out.textContent = "失败：" + (d.error || "");
              return;
            }
            out.textContent = "[" + new Date(d.at).toLocaleTimeString("zh-CN", { hour12: false }) + "] mode=" + d.mode + "\\n" + d.output;
          } catch (e) {
            out.textContent = "失败：" + String(e);
          } finally {
            busy(btn, false, mode === "run" ? "完成+领奖 (--yes)" : "查询成长任务 (dry-run)");
          }
        }

        byId("wbt-restart").addEventListener("click", onRestart);
        byId("wbt-dry").addEventListener("click", function () { runTaskRunner("dry"); });
        byId("wbt-run").addEventListener("click", function () { runTaskRunner("run"); });
        loadStatus();
        setInterval(loadStatus, 15000);
      })();
      </script>
    `);
  },
};

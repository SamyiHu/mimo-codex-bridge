/**
 * scheduler.mjs — 进程内定时任务（移植 TraeWorkAssistant tasks/scheduler.rs 的语义）。
 *
 * 语义：
 *   - 60s tick；每个任务有当天触发时刻 HH:MM
 *   - 触发条件：今天已过该时刻 && 状态里 lastRunDate != 今天（应用晚启动也补跑一次）
 *   - 成功才记 lastRunDate；失败记 failStreak，下次最早重试按 30→60→120 分钟指数退避
 *
 * 不依赖系统计划任务，进程活着就能跑；进程没开就等下次启动补跑。
 */
import fs from "node:fs";

function pad(n) { return String(n).padStart(2, "0"); }
export function dateKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function minutesOf(d) { return d.getHours() * 60 + d.getMinutes(); }
export function parseHHMM(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || "").trim());
  if (!m) throw new Error("时间格式应为 HH:MM：" + text);
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error("时间越界：" + text);
  return h * 60 + min;
}

export class Scheduler {
  constructor({ stateFile, now = () => new Date(), tickMs = 60000, logger = console } = {}) {
    this.stateFile = stateFile;
    this.now = now;
    this.tickMs = tickMs;
    this.logger = logger;
    this.tasks = [];
    this.state = { tasks: {} };
    this.timer = null;
    this.running = false;
    this.loadState();
  }

  loadState() {
    if (!this.stateFile) return;
    try { this.state = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) || { tasks: {} }; } catch { this.state = { tasks: {} }; }
    if (!this.state.tasks) this.state.tasks = {};
  }

  saveState() {
    if (!this.stateFile) return;
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), "utf8");
  }

  /** 注册每日任务 */
  daily(name, hhmm, run) {
    const at = parseHHMM(hhmm);
    this.tasks.push({ name, at, run, kind: "daily" });
    return this;
  }

  /** 注册固定间隔任务（分钟） */
  every(name, minutes, run) {
    this.tasks.push({ name, everyMinutes: Math.max(1, Number(minutes) || 60), run, kind: "interval" });
    return this;
  }

  taskState(name) {
    if (!this.state.tasks[name]) this.state.tasks[name] = { lastRunDate: "", lastRunTs: 0, failStreak: 0, lastFailTs: 0, nextEligibleTs: 0 };
    return this.state.tasks[name];
  }

  /** 现在有哪些任务该跑（纯函数，便于测试） */
  dueTasks(at = this.now()) {
    const nowMs = at.getTime();
    const today = dateKey(at);
    const due = [];
    for (const task of this.tasks) {
      const st = this.taskState(task.name);
      if (st.nextEligibleTs && nowMs < st.nextEligibleTs) continue;
      if (task.kind === "daily") {
        if (minutesOf(at) < task.at) continue;
        if (st.lastRunDate === today) continue;
        due.push(task);
      } else {
        const last = st.lastRunTs || 0;
        if (!last || nowMs - last >= task.everyMinutes * 60000) due.push(task);
      }
    }
    return due;
  }

  async runDue(at = this.now()) {
    const due = this.dueTasks(at);
    const results = [];
    for (const task of due) {
      const st = this.taskState(task.name);
      try {
        const detail = await task.run();
        st.lastRunDate = dateKey(at);
        st.lastRunTs = at.getTime();
        st.failStreak = 0;
        st.lastFailTs = 0;
        st.nextEligibleTs = 0;
        this.saveState();
        this.logger.log && this.logger.log("[scheduler] " + task.name + " 完成" + (detail ? "：" + detail : ""));
        results.push({ name: task.name, ok: true, detail: detail || "" });
      } catch (e) {
        st.failStreak = (st.failStreak || 0) + 1;
        st.lastFailTs = at.getTime();
        const backoffMin = Math.min(120, 30 * Math.pow(2, st.failStreak - 1));
        st.nextEligibleTs = at.getTime() + backoffMin * 60000;
        this.saveState();
        this.logger.error && this.logger.error("[scheduler] " + task.name + " 失败（第 " + st.failStreak + " 次，退避 " + backoffMin + " 分钟）：" + (e && e.message ? e.message : e));
        results.push({ name: task.name, ok: false, error: String(e && e.message ? e.message : e) });
      }
    }
    return results;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.runDue().catch((e) => this.logger.error && this.logger.error("[scheduler] tick 异常：" + e)).finally(() => { this.running = false; });
    }, this.tickMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

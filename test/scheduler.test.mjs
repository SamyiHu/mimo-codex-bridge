import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Scheduler, parseHHMM, dateKey } from "../scheduler.mjs";

function mk(nowRef) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
  return new Scheduler({ stateFile: path.join(dir, "state.json"), now: () => nowRef.d, logger: { log() {}, error() {} } });
}

test("parseHHMM / dateKey", () => {
  assert.equal(parseHHMM("09:30"), 570);
  assert.throws(() => parseHHMM("25:00"));
  assert.equal(dateKey(new Date("2026-05-06T01:02:03")), "2026-05-06");
});

test("每日任务：到点才跑，一天只跑一次", async () => {
  const ref = { d: new Date("2026-05-06T08:00:00") };
  const s = mk(ref);
  let runs = 0;
  s.daily("checkin", "09:00", async () => { runs++; });
  assert.equal((await s.runDue()).length, 0, "未到点不跑");
  ref.d = new Date("2026-05-06T09:01:00");
  assert.equal((await s.runDue()).length, 1);
  assert.equal(runs, 1);
  ref.d = new Date("2026-05-06T15:00:00");
  assert.equal((await s.runDue()).length, 0, "同一天不重复");
  ref.d = new Date("2026-05-07T09:01:00");
  assert.equal((await s.runDue()).length, 1, "次日再跑");
});

test("晚启动补跑", async () => {
  const ref = { d: new Date("2026-05-06T23:00:00") };
  const s = mk(ref);
  let ran = false;
  s.daily("night", "02:00", async () => { ran = true; });
  await s.runDue();
  assert.equal(ran, true);
});

test("失败退避：30/60/120 分钟封顶", async () => {
  const ref = { d: new Date("2026-05-06T09:00:00") };
  const s = mk(ref);
  s.daily("bad", "09:00", async () => { throw new Error("boom"); });
  await s.runDue();
  const st = s.taskState("bad");
  assert.equal(st.failStreak, 1);
  assert.ok(st.nextEligibleTs > ref.d.getTime());
  ref.d = new Date("2026-05-06T09:10:00");
  assert.equal((await s.runDue()).length, 0, "退避期内不重试");
  ref.d = new Date("2026-05-06T09:31:00");
  assert.equal((await s.runDue()).length, 1, "30 分钟后重试");
  const st2 = s.taskState("bad");
  assert.equal(st2.failStreak, 2);
});

test("间隔任务按分钟触发", async () => {
  const ref = { d: new Date("2026-05-06T10:00:00") };
  const s = mk(ref);
  let n = 0;
  s.every("poll", 5, async () => { n++; });
  await s.runDue();
  assert.equal(n, 1);
  ref.d = new Date("2026-05-06T10:03:00");
  assert.equal((await s.runDue()).length, 0);
  ref.d = new Date("2026-05-06T10:06:00");
  assert.equal((await s.runDue()).length, 1);
});

test("状态跨实例持久化", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
  const ref = { d: new Date("2026-05-06T09:00:00") };
  const file = path.join(dir, "state.json");
  const a = new Scheduler({ stateFile: file, now: () => ref.d, logger: { log() {}, error() {} } });
  a.daily("t", "09:00", async () => "");
  await a.runDue();
  const b = new Scheduler({ stateFile: file, now: () => ref.d, logger: { log() {}, error() {} } });
  b.daily("t", "09:00", async () => "");
  ref.d = new Date("2026-05-06T12:00:00");
  assert.equal((await b.runDue()).length, 0, "重启后同一天不重复跑");
});

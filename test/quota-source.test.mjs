import assert from "node:assert/strict";
import test from "node:test";

import { createQuotaSource } from "../quota-source.mjs";

const T0 = 1_800_000_000_000;

function source({ manual = null, fetchJson = null, now = () => T0 } = {}) {
  let reads = 0;
  const s = createQuotaSource({
    now,
    readJson: () => {
      reads += 1;
      return manual;
    },
    fetchJson,
    warn: () => {},
  });
  return { s, reads: () => reads };
}

const ups = (...ids) => ids.map((id) => ({ id, capabilities: {} }));

test("从 quota.json 读 share / resetsAt", async () => {
  const { s } = source({ manual: { wb: { share: 0.42, resetsAt: T0 + 3600_000 } } });
  const out = await s.read(ups("wb"));
  assert.equal(out.wb.share, 0.42);
  assert.equal(out.wb.resetsAt, T0 + 3600_000);
  assert.equal(out.wb.source, "quota.json");
});

test("used/limit 与 usedPct 都能换算成 share", async () => {
  const { s } = source({
    manual: { a: { used: 30, limit: 100 }, b: { usedPct: 25 }, c: { usedPct: 0.5 } },
  });
  const out = await s.read(ups("a", "b", "c"));
  assert.equal(out.a.share, 0.3);
  assert.equal(out.b.share, 0.25);
  assert.equal(out.c.share, 0.5);
});

test("不知道就是 null，不返回 0", async () => {
  const { s } = source({ manual: {} });
  const out = await s.read(ups("x"));
  assert.equal(out.x, null);
});

test("TTL 内不重复读文件", async () => {
  let t = T0;
  const { s, reads } = source({ manual: { wb: { share: 0.1 } }, now: () => t });
  await s.read(ups("wb"));
  t += 1000;
  await s.read(ups("wb"));
  assert.equal(reads(), 1);
  t += 120_000; // 超过 TTL
  await s.read(ups("wb"));
  assert.equal(reads(), 2);
});

test("拉额度失败保留旧值并标 stale", async () => {
  let t = T0;
  let fail = false;
  const upstream = {
    id: "wb",
    capabilities: { quota: { url: "http://127.0.0.1:9/quota", field: "data" } },
  };
  const s = createQuotaSource({
    now: () => t,
    readJson: () => null,
    warn: () => {},
    fetchJson: async () => {
      if (fail) throw new Error("boom");
      return { data: { share: 0.3, resetsAt: T0 + 1000 } };
    },
  });
  const first = await s.read([upstream]);
  assert.equal(first.wb.share, 0.3);
  assert.equal(first.wb.stale, false);

  t += 120_000;
  fail = true;
  const second = await s.read([upstream]);
  assert.equal(second.wb.share, 0.3);
  assert.equal(second.wb.stale, true);
});

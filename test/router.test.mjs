import assert from "node:assert/strict";
import test from "node:test";

import {
  FULL_SHARE,
  LOW_SHARE,
  chooseRoute,
  isHeld,
  normalizeCandidate,
  paceOf,
  pickRoute,
} from "../router.mjs";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const H = 3600_000;
const ids = (r) => r.order.map((o) => o.id);

test("smart：健康账号里重置最早的先上，90% 以后让位", () => {
  const r = chooseRoute({
    now: NOW,
    routing: "smart",
    candidates: [
      { id: "a", quota: { share: 0.2, resetsAt: NOW + 48 * H } },
      { id: "b", quota: { share: 0.25, resetsAt: NOW + 2 * H } },
      { id: "c", quota: { share: 0.95, resetsAt: NOW + 1 * H } },
      { id: "d", quota: null },
    ],
  });
  assert.deepEqual(ids(r), ["b", "a", "d", "c"]);
  assert.equal(r.ok, true);
});

test("分享 100% 的账号直接不试，暂停和不服务该模型的也不试", () => {
  const r = chooseRoute({
    now: NOW,
    candidates: [
      { id: "full", quota: { share: 1 } },
      { id: "paused", paused: true },
      { id: "other-model", servesModel: false },
      { id: "ok", quota: { share: 0.1 } },
    ],
  });
  assert.deepEqual(ids(r), ["ok"]);
  assert.deepEqual(r.dropped.map((d) => d.id).sort(), ["full", "other-model", "paused"]);
  assert.equal(isHeld(normalizeCandidate({ id: "x", quota: { share: 1 } })), true);
});

test("全部不可用时 ok=false，并说清为什么", () => {
  const r = chooseRoute({ now: NOW, candidates: [{ id: "a", paused: true }, { id: "b", quota: { share: 1 } }] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.order, []);
  assert.equal(r.notes.length > 0, true);
});

test("usage：用得最少的先上", () => {
  const r = chooseRoute({
    now: NOW,
    routing: "usage",
    candidates: [
      { id: "a", quota: { share: 0.7 } },
      { id: "b", quota: { share: 0.2 } },
      { id: "c", quota: { share: 0.5 } },
    ],
  });
  assert.deepEqual(ids(r), ["b", "c", "a"]);
});

test("pace：每周剩下的按小时摊得最宽的先上", () => {
  const x = { id: "x", quota: { share: 0.6, resetsAt: NOW + 20 * H } }; // 0.02/h
  const y = { id: "y", quota: { share: 0.6, resetsAt: NOW + 5 * H } }; // 0.08/h
  assert.ok(paceOf(normalizeCandidate(y), NOW) > paceOf(normalizeCandidate(x), NOW));
  assert.deepEqual(ids(chooseRoute({ now: NOW, routing: "pace", candidates: [x, y] })), ["y", "x"]);
});

test("order：按配置顺序；rotate：每轮换一个", () => {
  const c = [
    { id: "a", index: 0, quota: { share: 0.1 } },
    { id: "b", index: 1, quota: { share: 0.1 } },
    { id: "c", index: 2, quota: { share: 0.1 } },
  ];
  assert.deepEqual(ids(chooseRoute({ now: NOW, routing: "order", candidates: c })), ["a", "b", "c"]);
  assert.deepEqual(ids(chooseRoute({ now: NOW, routing: "rotate", turn: 1, candidates: c })), ["b", "c", "a"]);
  assert.deepEqual(ids(chooseRoute({ now: NOW, routing: "rotate", turn: 3, candidates: c })), ["a", "b", "c"]);
});

test("weight：3:1 在 8 次里正好 6:2，且平滑交错", () => {
  let weights = {};
  const picks = [];
  for (let i = 0; i < 8; i += 1) {
    const r = chooseRoute({
      now: NOW,
      routing: "weight",
      weights,
      candidates: [
        { id: "big", weight: 3 },
        { id: "small", weight: 1 },
      ],
    });
    picks.push(r.order[0].id);
    weights = r.nextWeights;
  }
  assert.equal(picks.filter((p) => p === "big").length, 6);
  assert.equal(picks.filter((p) => p === "small").length, 2);
  // 平滑轮转：不是 3 次连着打完再换，而是交错开
  assert.deepEqual(picks, ["big", "big", "small", "big", "big", "big", "small", "big"]);
});

test("刚被 429 的沉底，但不会被剔除", () => {
  const r = chooseRoute({
    now: NOW,
    routing: "usage",
    candidates: [
      { id: "limited", quota: { share: 0.1 }, rateLimitedAt: NOW - 5000 },
      { id: "fresh", quota: { share: 0.3 } },
    ],
  });
  assert.deepEqual(ids(r), ["fresh", "limited"]);
});

test("兜底模型排在自己的账号之后", () => {
  const r = chooseRoute({
    now: NOW,
    routing: "order",
    candidates: [{ id: "fb", kind: "fallback" }, { id: "acct", quota: { share: 0.1 } }],
  });
  assert.deepEqual(ids(r), ["acct", "fb"]);
});

test("resting 沉底但不剔除；只剩它时照样返回", () => {
  const both = chooseRoute({
    now: NOW,
    routing: "order",
    candidates: [
      { id: "resting", restingUntil: NOW + 10_000 },
      { id: "awake" },
    ],
  });
  assert.deepEqual(ids(both), ["awake", "resting"]);

  const only = chooseRoute({ now: NOW, candidates: [{ id: "resting", restingUntil: NOW + 10_000 }] });
  assert.deepEqual(ids(only), ["resting"]);
  assert.equal(only.ok, true);
});

test("会话粘性：上一次答它的先上，但叫不醒 resting", () => {
  const sticky = chooseRoute({
    now: NOW,
    session: { lastAnsweredId: "last" },
    candidates: [
      { id: "fresh", quota: { share: 0.1, resetsAt: NOW + H } },
      { id: "last", quota: { share: 0.4, resetsAt: NOW + 9 * H } },
    ],
  });
  assert.deepEqual(ids(sticky), ["last", "fresh"]);
  assert.equal(sticky.keepOn, "last");

  const resting = chooseRoute({
    now: NOW,
    session: { lastAnsweredId: "last" },
    candidates: [
      { id: "last", quota: { share: 0.4 }, restingUntil: NOW + 10_000 },
      { id: "fresh", quota: { share: 0.1 } },
    ],
  });
  assert.deepEqual(ids(resting), ["fresh", "last"]);
  assert.equal(resting.keepOn, null);
});

test("Strict：钉在原上游上，满额也在所不惜", () => {
  const r = chooseRoute({
    now: NOW,
    stays: "strict",
    session: { lastAnsweredId: "pinned" },
    candidates: [
      { id: "pinned", quota: { share: 1 }, restingUntil: NOW + 10_000 },
      { id: "other", quota: { share: 0.05 } },
    ],
  });
  assert.deepEqual(ids(r), ["pinned"]);
  assert.equal(r.keepOn, "pinned");
});

test("pickRoute 只给一个；没有可用时给 null", () => {
  const r = pickRoute({ now: NOW, candidates: [{ id: "a" }, { id: "b" }] });
  assert.equal(r.chosen, "a");
  assert.equal(pickRoute({ now: NOW, candidates: [] }).chosen, null);
});

test("阈值常量就是 magpie 的两道门槛", () => {
  assert.equal(LOW_SHARE, 0.9);
  assert.equal(FULL_SHARE, 0.98);
});

import assert from "node:assert/strict";
import test from "node:test";

import { createRouting } from "../bridge-routing.mjs";

const T0 = 1_800_000_000_000;

const REGISTRY = {
  upstreams: [
    { id: "mimo", kind: "mimo", tokenFile: "token.txt", capabilities: { modelPrefix: "mimo-desktop", fallbackModel: "mimo-desktop/fb" } },
    { id: "wb", kind: "openai", base: "http://127.0.0.1:7863", tokenFile: "wb.txt" },
    { id: "trae", kind: "openai", base: "http://127.0.0.1:7864", tokenFile: "trae.txt" },
  ],
  groups: [
    { id: "daily", models: ["wb/cn:glm-4.6", "trae/glm-4.6"], routing: "smart", stays: "auto" },
    { id: "strict-order", models: ["trae/glm-4.6", "wb/cn:glm-4.6"], routing: "order" },
  ],
};

const QUOTA = {
  wb: { share: 0.25, resetsAt: T0 + 7 * 3600_000 },
  trae: { share: 0.95, resetsAt: T0 + 3 * 3600_000 },
};

function make({ registry = REGISTRY, quota = QUOTA, now = () => T0 } = {}) {
  const warnings = [];
  const files = { "/p/upstreams.json": JSON.stringify(registry) };
  const routing = createRouting({
    dir: "/p",
    now,
    readFile: (p) => {
      if (!(p in files)) throw new Error("ENOENT " + p);
      return files[p];
    },
    statSync: () => ({ mtimeMs: 7 }),
    readQuotaJson: () => quota,
    resolveBase: async (up) => (up.kind === "mimo" ? "http://127.0.0.1:9999" : up.base),
    readToken: (up) => "tok-" + up.id,
    warn: (m) => warnings.push(m),
  });
  return { routing, warnings, files };
}

test("没有 upstreams.json → 路由不启用，pick 明确拒绝", async () => {
  const routing = createRouting({
    dir: "/p",
    readFile: () => {
      throw new Error("ENOENT");
    },
    statSync: () => {
      throw new Error("ENOENT");
    },
    warn: () => {},
  });
  const picked = await routing.pick({ model: "group/daily" });
  assert.equal(picked.ok, false);
  assert.equal(picked.disabled, true);
  assert.equal(routing.describe().enabled, false);
});

test("按额度选：健康里重置最早的那家先上", async () => {
  const { routing } = make();
  const picked = await routing.pick({ model: "group/daily" });
  assert.equal(picked.ok, true);
  assert.equal(picked.upstreamId, "wb");
  assert.equal(picked.model, "cn:glm-4.6");
  assert.equal(picked.base, "http://127.0.0.1:7863");
  assert.equal(picked.token, "tok-wb");
  assert.match(picked.reason, /已用 25%/);
});

test("上游 500 后进 resting，下一次换另一家，但它不会被剔除", async () => {
  const { routing } = make();
  routing.noteResult("wb", { status: 500 });
  const picked = await routing.pick({ model: "group/daily" });
  assert.equal(picked.upstreamId, "trae");
  assert.equal(picked.order.length, 2);
  assert.equal(picked.order[1].id, "wb::cn:glm-4.6");
});

test("previous_response_id 钉在原上游上，即使它在 resting", async () => {
  const { routing } = make();
  routing.noteResult("wb", { status: 500 });
  const picked = await routing.pick({
    model: "cn:glm-4.6",
    pinned: { upstreamId: "wb", model: "cn:glm-4.6" },
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.upstreamId, "wb");
  assert.equal(picked.pinned, true);
  assert.match(picked.notes[0], /续写/);
});

test("钉住的上游已经不在配置里：重新路由并说明", async () => {
  const { routing, warnings } = make();
  const picked = await routing.pick({
    model: "group/daily",
    pinned: { upstreamId: "gone", model: "x" },
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.upstreamId, "wb");
  assert.equal(warnings.some((w) => w.includes("已不在配置里")), true);
});

test("路由组可以按 order 覆盖默认 routing", async () => {
  const { routing } = make();
  const picked = await routing.pick({ model: "group/strict-order" });
  assert.equal(picked.upstreamId, "trae");
  assert.equal(picked.group.id, "strict-order");
});

test("模型解析不出来时给出可操作的错误，而不是随便挑一家", async () => {
  const { routing } = make();
  const picked = await routing.pick({ model: "nope-1" });
  assert.equal(picked.ok, false);
  assert.match(picked.error, /provider\/model|路由组/);
});

test("mimo 的 base 由 resolveBase 决定，token 来自 token 文件抽象", async () => {
  const { routing } = make();
  const picked = await routing.pick({ model: "mimo-desktop/mimo-v2.6-pro" });
  assert.equal(picked.upstreamId, "mimo");
  assert.equal(picked.base, "http://127.0.0.1:9999");
  assert.equal(picked.ready, true);
});

test("describe 给面板用：上游、路由组、健康、额度", async () => {
  const { routing } = make();
  await routing.pick({ model: "group/daily" });
  const d = routing.describe();
  assert.equal(d.enabled, true);
  assert.deepEqual(d.upstreams.map((u) => u.id), ["mimo", "wb", "trae"]);
  assert.deepEqual(d.groups.map((g) => g.id), ["daily", "strict-order"]);
  assert.equal(d.quota.wb.share, 0.25);
});

test("配置写坏了：报错但不崩，继续用上一份", async () => {
  const { routing, files } = make();
  await routing.pick({ model: "group/daily" });
  files["/p/upstreams.json"] = "{ not json";
  routing.reload(true);
  const picked = await routing.pick({ model: "group/daily" });
  assert.equal(picked.ok, true);
  assert.equal(picked.upstreamId, "wb");
  assert.match(routing.describe().error || "", /读 upstreams.json 失败/);
});

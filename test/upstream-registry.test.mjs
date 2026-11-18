import assert from "node:assert/strict";
import test from "node:test";

import { candidatesFor, parseRegistry, resolveModel, splitUpstream } from "../upstream-registry.mjs";

const RAW = {
  upstreams: [
    {
      id: "mimo",
      kind: "mimo",
      tokenFile: "token.txt",
      capabilities: { modelPrefix: "mimo-desktop", fallbackModel: "mimo-desktop/mimo-v2.6-pro" },
    },
    { id: "wb", kind: "openai", base: "http://127.0.0.1:7863", tokenFile: "workbuddy-api-key.txt" },
    { id: "trae", kind: "openai", base: "http://127.0.0.1:7864", tokenFile: "trae-api-key.txt" },
  ],
  groups: [
    { id: "daily", models: ["wb/cn:glm-4.6", "trae/glm-4.6"], routing: "smart", stays: "auto" },
  ],
};

test("解析：能力表有默认值，mimo 自动打开端口发现", () => {
  const reg = parseRegistry(RAW);
  assert.deepEqual(reg.errors, []);
  const mimo = reg.upstreams.get("mimo");
  assert.equal(mimo.capabilities.needsDiscovery, true);
  assert.equal(mimo.capabilities.chatMode, "compatible");
  assert.equal(mimo.capabilities.modelPrefix, "mimo-desktop");
  const wb = reg.upstreams.get("wb");
  assert.equal(wb.capabilities.needsDiscovery, false);
  assert.equal(wb.capabilities.modelPassthrough, true);
});

test("解析：脏配置一次报清，不静默吞掉", () => {
  const reg = parseRegistry({
    upstreams: [
      { id: "x", kind: "openai" },
      { id: "x", kind: "openai", base: "http://a", tokenFile: "t" },
      { id: "y", kind: "weird", base: "http://b", tokenFile: "t" },
    ],
    groups: [
      { id: "g", models: ["nope/m"], routing: "smart" },
      { id: "g2", models: ["x/m"], routing: "nonsense" },
    ],
  });
  const joined = reg.errors.join("\n");
  assert.match(joined, /没有 base/);
  assert.match(joined, /id 重复/);
  assert.match(joined, /kind 不认识/);
  assert.match(joined, /指向未定义的上游 nope/);
  assert.match(joined, /routing 不认识/);
});

test("splitUpstream：只切第一段", () => {
  assert.deepEqual(splitUpstream("wb/cn:glm-4.6"), { upstream: "wb", model: "cn:glm-4.6" });
  assert.deepEqual(splitUpstream("mimo-desktop/x/y"), { upstream: "mimo-desktop", model: "x/y" });
  assert.equal(splitUpstream("glm-4.6"), null);
  assert.equal(splitUpstream("wb/"), null);
});

test("解析模型：路由组 / 上游前缀 / 模型 ID 自带前缀", () => {
  const reg = parseRegistry(RAW);
  assert.equal(resolveModel(reg, "group/daily").kind, "group");
  assert.equal(resolveModel(reg, "group/nope").kind, "unknown");
  assert.equal(resolveModel(reg, "wb/cn:glm-4.6").upstream.id, "wb");
  assert.equal(resolveModel(reg, "mimo-desktop/mimo-v2.6-pro").upstream.id, "mimo");
  assert.equal(resolveModel(reg, "wb").kind, "unknown"); // 上游名不是模型名
});

test("解析模型：裸 ID 先看目录，多家有就是 ambiguous", () => {
  const reg = parseRegistry(RAW);
  const one = resolveModel(reg, "glm-4.6", { catalog: { wb: ["cn:glm-4.6"], trae: ["glm-4.6"] } });
  assert.equal(one.upstream.id, "trae");
  const many = resolveModel(reg, "glm-4.6", {
    catalog: { wb: ["glm-4.6"], trae: ["glm-4.6"] },
  });
  assert.equal(many.kind, "ambiguous");
  assert.deepEqual(many.matches, ["wb", "trae"]);
  const none = resolveModel(reg, "nope-1");
  assert.equal(none.kind, "unknown");
});

test("解析模型：只有一家上游时不用问", () => {
  const reg = parseRegistry({ upstreams: [{ id: "only", kind: "openai", base: "http://a", tokenFile: "t" }] });
  const r = resolveModel(reg, "whatever");
  assert.equal(r.kind, "upstream");
  assert.equal(r.upstream.id, "only");
});

test("候选：路由组按配置顺序摊开，并带上各自的额度", () => {
  const reg = parseRegistry(RAW);
  const { ok, candidates, group } = candidatesFor(reg, "group/daily", {
    wb: { share: 0.25, resetsAt: 1000 },
    trae: { share: 0.95, resetsAt: 2000 },
  });
  assert.equal(ok, true);
  assert.equal(group.id, "daily");
  assert.deepEqual(candidates.map((c) => c.id), ["wb::cn:glm-4.6", "trae::glm-4.6"]);
  assert.equal(candidates[0].quota.share, 0.25);
  assert.equal(candidates[1].quota.share, 0.95);
  assert.deepEqual(candidates.map((c) => c.index), [0, 1]);
});

test("候选：单个上游带兜底模型，兜底排后面且 id 不撞", () => {
  const reg = parseRegistry(RAW);
  const { candidates } = candidatesFor(reg, "mimo-desktop/mimo-v2.6-pro", {});
  assert.deepEqual(candidates.map((c) => c.kind), ["account", "fallback"]);
  assert.notEqual(candidates[0].id, candidates[1].id);
  assert.equal(candidates[1].model, "mimo-desktop/mimo-v2.6-pro");
});

test("候选：解析不了就直接给出原因", () => {
  const reg = parseRegistry(RAW);
  const r = candidatesFor(reg, "nope-1");
  assert.equal(r.ok, false);
  assert.equal(r.candidates.length, 0);
  assert.match(r.error, /没有上游声明能服务/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiKeyStore, todayKey, newKeyId } from "../api-keys.mjs";

function tmpStore(now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apikeys-"));
  return { store: new ApiKeyStore(path.join(dir, "api-keys.json"), { now }), dir };
}

test("未配置 Key 时鉴权关闭（anonymous 放行）", () => {
  const { store } = tmpStore();
  const r = store.authenticate("whatever");
  assert.equal(r.ok, true);
  assert.equal(r.anonymous, true);
});

test("创建后必须带正确 Key；错误 Key 拒绝", () => {
  const { store } = tmpStore();
  const k = store.create({ label: "codex" });
  assert.match(k.id, /^ck_[0-9a-f]{32}$/);
  assert.equal(store.authenticate(k.id).ok, true);
  assert.deepEqual(store.authenticate("bad"), { ok: false, reason: "invalid_api_key" });
});

test("日配额：达到上限后拒绝，跨天重置", () => {
  let fake = new Date("2026-03-01T10:00:00");
  const { store } = tmpStore(() => fake);
  const k = store.create({ label: "x", dailyLimit: 2 });
  assert.equal(store.authenticate(k.id).ok, true);
  store.record(k); store.record(k);
  const denied = store.authenticate(k.id);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "quota_exceeded");
  fake = new Date("2026-03-02T00:01:00");
  assert.equal(store.authenticate(k.id).ok, true, "跨天应重置");
});

test("禁用 Key 立即失效", () => {
  const { store } = tmpStore();
  const k = store.create({});
  store.update(k.id, { enabled: false });
  assert.equal(store.authenticate(k.id).ok, false);
});

test("模型/上游白名单", () => {
  const { store } = tmpStore();
  const k = store.create({ allowedModels: ["cn:glm"], allowedUpstreams: ["wb"] });
  assert.equal(store.allows(k, { model: "cn:glm-4.6", upstream: "wb" }), true);
  assert.equal(store.allows(k, { model: "cn:deepseek", upstream: "wb" }), false);
  assert.equal(store.allows(k, { model: "cn:glm-4.6", upstream: "trae" }), false);
  assert.equal(store.allows(null, { model: "anything" }), true);
});

test("落盘后能读回（含用量）", () => {
  const { store, dir } = tmpStore();
  const k = store.create({ label: "persist", dailyLimit: 10 });
  store.record(k);
  store.flush();
  const again = new ApiKeyStore(path.join(dir, "api-keys.json"));
  const list = again.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].label, "persist");
  assert.equal(list[0].usedToday, 1);
});

test("todayKey/newKeyId 形态", () => {
  assert.match(todayKey(new Date("2026-01-02T03:04:05")), /^2026-01-02$/);
  assert.match(newKeyId(), /^ck_[0-9a-f]{32}$/);
});

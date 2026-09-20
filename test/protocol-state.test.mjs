import assert from "node:assert/strict";
import test from "node:test";
import { ResponseStore } from "../protocol-state.mjs";

test("response store retrieves, patches and expires response state", () => {
  const store = new ResponseStore({ ttlMs: 30, maxEntries: 2 });
  store.put("resp_one", { id: "resp_one", status: "in_progress" });
  assert.equal(store.get("resp_one").status, "in_progress");
  assert.equal(store.patch("resp_one", { status: "completed" }).status, "completed");

  store.put("resp_two", { id: "resp_two", status: "in_progress" });
  store.put("resp_three", { id: "resp_three", status: "in_progress" });
  assert.equal(store.get("resp_one"), null);
  assert.equal(store.snapshot().entries, 2);
});

test("response store keeps the cancellation controller across re-puts", () => {
  // 流式响应先以进行中状态登记，完成后再 put 一次最终对象。
  // 若此时丢掉控制器，取消能力会在收尾时被静默清空。
  const store = new ResponseStore({ ttlMs: 60_000, maxEntries: 10 });
  const controller = new AbortController();
  store.put("resp_stream", { id: "resp_stream", status: "in_progress" }, controller);

  assert.equal(store.record("resp_stream").controller, controller);

  store.put("resp_stream", { id: "resp_stream", status: "completed" });
  assert.equal(
    store.record("resp_stream").controller,
    controller,
    "重复 put 必须保留取消控制器",
  );

  store.delete("resp_stream");
  assert.equal(controller.signal.aborted, true, "删除应中断仍在进行的响应");
});

test("response store expires a single entry without a full sweep", () => {
  const store = new ResponseStore({ ttlMs: 10, maxEntries: 10 });
  store.put("resp_ttl", { id: "resp_ttl", status: "in_progress" });
  assert.equal(store.get("resp_ttl").status, "in_progress");

  return new Promise((resolve) => {
    setTimeout(() => {
      // 即使全量清扫被节流跳过，单条查询也必须按 TTL 失效。
      assert.equal(store.get("resp_ttl"), null);
      assert.equal(store.snapshot().entries, 0);
      resolve();
    }, 30);
  });
});

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
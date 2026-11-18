import assert from "node:assert/strict";
import test from "node:test";

import { createHooks } from "../hooks.mjs";

function make({ module = null, mtime = 1, timeoutMs } = {}) {
  const warnings = [];
  const hooks = createHooks({
    dir: "/proj",
    statSync: () => {
      if (!module) throw new Error("ENOENT");
      return { mtimeMs: mtime };
    },
    pathJoin: (a, b) => a + "/" + b,
    importModule: async () => module,
    warn: (m) => warnings.push(m),
    timeoutMs,
  });
  return { hooks, warnings };
}

test("没有钩子文件时静默返回 null", async () => {
  const { hooks } = make();
  assert.equal(await hooks.beforeRequest({ model: "x" }), null);
});

test("钩子返回白名单字段才生效", async () => {
  const { hooks } = make({
    module: { default: () => ({ model: "wb/cn:glm-4.6", prompt_cache_key: "k", hack: 1, messages: [1] }) },
  });
  const patch = await hooks.beforeRequest({ model: "x" });
  assert.deepEqual(Object.keys(patch).sort(), ["messages", "model", "prompt_cache_key"]);
  assert.equal(patch.model, "wb/cn:glm-4.6");
});

test("钩子抛异常只记日志，不影响请求", async () => {
  const { hooks, warnings } = make({
    module: {
      default: () => {
        throw new Error("bad hook");
      },
    },
  });
  assert.equal(await hooks.beforeRequest({ model: "x" }), null);
  assert.equal(warnings.some((w) => w.includes("抛错")), true);
});

test("钩子超时按跳过处理", async () => {
  const { hooks, warnings } = make({
    module: { default: () => new Promise((resolve) => setTimeout(() => resolve({ model: "late" }), 200)) },
    timeoutMs: 20,
  });
  assert.equal(await hooks.beforeRequest({ model: "x" }), null);
  assert.equal(warnings.some((w) => w.includes("超时")), true);
});

test("导出不是函数就不生效", async () => {
  const { hooks, warnings } = make({ module: { default: 42 } });
  assert.equal(await hooks.beforeRequest({ model: "x" }), null);
  assert.equal(warnings.some((w) => w.includes("没有导出函数")), true);
});

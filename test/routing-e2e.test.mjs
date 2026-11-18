import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test, { after, before } from "node:test";

// 端到端：真的起一个 bridge 进程，真的发 HTTP 请求，上游是本地假网关。
// 这条测试要证明的不是"函数算得对"，而是"路由接进了请求链路"。

const projectDir = path.resolve(import.meta.dirname, "..");
let bridge = null;
let tmpDir = "";
let bridgePort = 0;
let secret = "";

function startMock(label) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url || "/", "http://mock");
      if (url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: label + "-alpha" }, { id: label + "-beta" }],
          }),
        );
        return;
      }
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      seen.push({
        path: url.pathname,
        auth: req.headers.authorization || "",
        model: body.model,
        stream: body.stream === true,
      });
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          "data: " +
            JSON.stringify({
              id: "chatcmpl-" + label,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: label + " ok" }, finish_reason: null }],
            }) +
            "\n\n",
        );
        res.write(
          "data: " +
            JSON.stringify({
              id: "chatcmpl-" + label,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            }) +
            "\n\n",
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-" + label,
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: label + " says ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ label, server, seen, port: server.address().port });
    });
  });
}

function listenPort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timeout" + (last ? ": " + last.message : ""));
}

async function call(pathname, body, headers = {}) {
  const response = await fetch("http://127.0.0.1:" + bridgePort + pathname, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + secret,
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

let mock1 = null;
let mock2 = null;

before(async () => {
  mock1 = await startMock("mock1");
  mock2 = await startMock("mock2");
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-routing-"));
  bridgePort = await listenPort();
  secret = "test-secret-" + Math.random().toString(36).slice(2);

  fs.writeFileSync(path.join(tmpDir, "secret.txt"), secret);
  fs.writeFileSync(path.join(tmpDir, "tok1.txt"), "tok-one");
  fs.writeFileSync(path.join(tmpDir, "tok2.txt"), "tok-two");
  fs.writeFileSync(path.join(tmpDir, "tok3.txt"), "tok-three");

  fs.writeFileSync(
    path.join(tmpDir, "upstreams.json"),
    JSON.stringify({
      upstreams: [
        { id: "mock1", kind: "openai", base: "http://127.0.0.1:" + mock1.port, tokenFile: path.join(tmpDir, "tok1.txt") },
        { id: "mock2", kind: "openai", base: "http://127.0.0.1:" + mock2.port, tokenFile: path.join(tmpDir, "tok2.txt") },
        { id: "dead", kind: "openai", base: "http://127.0.0.1:1", tokenFile: path.join(tmpDir, "tok3.txt") },
      ],
      groups: [
        { id: "mixed", models: ["mock1/mock1-alpha", "mock2/mock2-alpha"], routing: "smart", stays: "auto" },
        { id: "flaky", models: ["dead/x", "mock1/mock1-alpha"], routing: "order" },
      ],
    }),
    "utf8",
  );

  // mock1 已经用了 95%：按 smart，新对话应该先走 mock2
  fs.writeFileSync(
    path.join(tmpDir, "quota.json"),
    JSON.stringify({ mock1: { share: 0.95 }, mock2: { share: 0.2 } }),
    "utf8",
  );

  bridge = spawn(
    process.execPath,
    [
      "bridge.mjs",
      "--port",
      String(bridgePort),
      "--dir",
      tmpDir,
      "--upstream-kind",
      "workbuddy",
      "--bridge-secret-file",
      path.join(tmpDir, "secret.txt"),
    ],
    {
      cwd: projectDir,
      env: {
        ...process.env,
        MIMO_BRIDGE_UPSTREAMS: path.join(tmpDir, "upstreams.json"),
        MIMO_BRIDGE_QUOTA: path.join(tmpDir, "quota.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  bridge.stdout.setEncoding("utf8");
  bridge.stderr.setEncoding("utf8");
  globalThis.__bridgeLog = "";
  bridge.stdout.on("data", (chunk) => {
    globalThis.__bridgeLog += chunk;
  });
  bridge.stderr.on("data", (chunk) => {
    globalThis.__bridgeLog += chunk;
  });

  await waitFor(async () => {
    const { status } = await call("/health");
    return status === 200;
  });
});

after(async () => {
  bridge?.kill();
  mock1?.server.close();
  mock2?.server.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("多上游模型列表：加上游前缀，并列出路由组", async () => {
  const { status, payload } = await call("/v1/models");
  assert.equal(status, 200);
  const ids = payload.data.map((item) => item.id);
  assert.ok(ids.includes("mock1/mock1-alpha"), ids.join(","));
  assert.ok(ids.includes("mock2/mock2-beta"));
  assert.ok(ids.includes("group/mixed"));
  assert.ok(ids.includes("group/flaky"));
});

test("指定上游：模型前缀被剥掉，token 用这家自己的", async () => {
  mock1.seen.length = 0;
  const { status, payload } = await call("/v1/responses", {
    model: "mock1/mock1-alpha",
    input: "hi",
    stream: false,
  });
  assert.equal(status, 200, JSON.stringify(payload).slice(0, 300));
  assert.equal(mock1.seen.length, 1);
  assert.equal(mock1.seen[0].model, "mock1-alpha");
  assert.equal(mock1.seen[0].auth, "Bearer tok-one");
  assert.equal(mock1.seen[0].path, "/v1/chat/completions");
});

test("一家挂了自动换下一家，并把它标成 resting", async () => {
  const { status, payload } = await call("/v1/responses", {
    model: "group/flaky",
    input: "hi",
    stream: false,
  });
  assert.equal(status, 200, JSON.stringify(payload).slice(0, 300));
  const routing = (await call("/status")).payload.routing;
  assert.equal(routing.enabled, true);
  const dead = routing.upstreams.find((item) => item.id === "dead");
  assert.ok(dead, "dead 上游应该出现在 routing.upstreams 里");
  assert.ok(dead.health.restingUntil > Date.now(), JSON.stringify(dead.health));
});

test("按额度挑：mock1 用到 95%，新对话走 mock2", async () => {
  mock1.seen.length = 0;
  mock2.seen.length = 0;
  const { status } = await call("/v1/responses", {
    model: "group/mixed",
    input: "hi",
    stream: false,
  });
  assert.equal(status, 200);
  assert.equal(mock1.seen.length, 0);
  assert.equal(mock2.seen.length, 1);
});

test("previous_response_id 钉回原上游，哪怕额度上它更差", async () => {
  mock1.seen.length = 0;
  mock2.seen.length = 0;
  const first = await call("/v1/responses", {
    model: "mock1/mock1-alpha",
    input: "记住 42",
    stream: false,
  });
  assert.equal(first.status, 200);
  const responseId = first.payload.id;
  assert.ok(responseId);
  assert.equal(mock1.seen.length, 1);

  const second = await call("/v1/responses", {
    model: "group/mixed",
    previous_response_id: responseId,
    input: "我刚才说了什么？",
    stream: false,
  });
  assert.equal(second.status, 200, JSON.stringify(second.payload).slice(0, 300));
  assert.equal(mock1.seen.length, 2, "续写应该回到 mock1");
  assert.equal(mock2.seen.length, 0);
});

test("流式请求也能穿过路由", async () => {
  mock2.seen.length = 0;
  const response = await fetch("http://127.0.0.1:" + bridgePort + "/v1/responses", {
    method: "POST",
    headers: { Authorization: "Bearer " + secret, "content-type": "application/json" },
    body: JSON.stringify({ model: "mock2/mock2-alpha", input: "hi", stream: true }),
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /response\.completed|output_text/);
  assert.equal(mock2.seen.length, 1);
  assert.equal(mock2.seen[0].stream, true);
});

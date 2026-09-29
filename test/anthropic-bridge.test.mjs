import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function unusedPort() {
  const server = http.createServer();
  await listen(server);
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port, child, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`bridge exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("bridge health check timed out");
}

async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

function createMockEngine(onChat) {
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mimo-desktop/mimo-pro" }] }));
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      onChat(body, res);
      return;
    }
    res.writeHead(404).end();
  });
}

async function startBridge(enginePort) {
  const bridgeToken = "anthropic-token";
  const bridgeSecret = "anthropic-secret";
  const bridgePort = await unusedPort();
  const child = spawn(
    process.execPath,
    [
      path.join(projectDir, "bridge.mjs"),
      "--port",
      String(bridgePort),
      "--token",
      bridgeToken,
      "--bridge-secret",
      bridgeSecret,
      "--engine-url",
      `http://127.0.0.1:${enginePort}`,
    ],
    { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  await waitForHealth(bridgePort, child);
  return { child, bridgePort, bridgeSecret, bridgeToken };
}

test("POST /v1/messages 非流式：文本 + tool_use", async () => {
  let received = null;
  const engine = createMockEngine((body, res) => {
    received = body;
    assert.equal(body.stream, false);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "running",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "exec_command",
                    arguments: '{"cmd":"ls"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
      }),
    );
  });
  await listen(engine);
  const { child, bridgePort, bridgeSecret } = await startBridge(
    engine.address().port,
  );

  try {
    const response = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": bridgeSecret,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "mimo-desktop/mimo-pro",
          max_tokens: 128,
          system: "Be brief",
          messages: [{ role: "user", content: "list files" }],
          tools: [
            {
              name: "exec_command",
              description: "run",
              input_schema: {
                type: "object",
                properties: { cmd: { type: "string" } },
              },
            },
          ],
        }),
      },
    );

    assert.equal(response.status, 200);
    const message = await response.json();
    assert.equal(message.type, "message");
    assert.equal(message.role, "assistant");
    assert.equal(message.stop_reason, "tool_use");
    assert.equal(message.content[0].type, "text");
    assert.equal(message.content[1].type, "tool_use");
    assert.equal(message.content[1].name, "exec_command");
    assert.deepEqual(message.content[1].input, { cmd: "ls" });
    assert.equal(message.usage.input_tokens, 4);
    assert.equal(message.usage.output_tokens, 6);

    assert.ok(received);
    assert.equal(received.messages[0].role, "system");
    assert.equal(received.messages[0].content, "Be brief");
  } finally {
    child.kill();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await new Promise((resolve) => engine.close(resolve));
  }
});

test("POST /v1/messages 流式：Anthropic SSE 事件序列", async () => {
  const engine = createMockEngine((body, res) => {
    assert.equal(body.stream, true);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
    });
    res.write(
      'data: {"object":"chat.completion.chunk","model":"mimo-pro","choices":[{"delta":{"role":"assistant","content":"Hi "}}]}\n\n',
    );
    res.write(
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"there"}}]}\n\n',
    );
    res.write(
      'data: {"object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    );
    res.write(
      'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n',
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await listen(engine);
  const { child, bridgePort, bridgeSecret } = await startBridge(
    engine.address().port,
  );

  try {
    const response = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": bridgeSecret,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: "mimo-desktop/mimo-pro",
          max_tokens: 64,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") || "",
      /text\/event-stream/,
    );
    const text = await readSse(response);
    assert.match(text, /event: message_start/);
    assert.match(text, /event: content_block_start/);
    assert.match(text, /event: content_block_delta/);
    assert.match(text, /text_delta/);
    assert.match(text, /Hi /);
    assert.match(text, /there/);
    assert.match(text, /event: content_block_stop/);
    assert.match(text, /event: message_delta/);
    assert.match(text, /event: message_stop/);
    assert.doesNotMatch(text, /event: error/);
  } finally {
    child.kill();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await new Promise((resolve) => engine.close(resolve));
  }
});

test("POST /v1/messages/count_tokens 返回本地估算", async () => {
  const engine = createMockEngine(() => {
    throw new Error("count_tokens must not hit upstream");
  });
  await listen(engine);
  const { child, bridgePort, bridgeSecret } = await startBridge(
    engine.address().port,
  );

  try {
    const response = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/messages/count_tokens`,
      {
        method: "POST",
        headers: {
          "x-api-key": bridgeSecret,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "mimo-desktop/mimo-pro",
          messages: [{ role: "user", content: "hello world" }],
        }),
      },
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(typeof payload.input_tokens, "number");
    assert.ok(payload.input_tokens > 0);
  } finally {
    child.kill();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await new Promise((resolve) => engine.close(resolve));
  }
});

test("POST /v1/messages 非法请求返回 Anthropic 错误格式", async () => {
  const engine = createMockEngine(() => {});
  await listen(engine);
  const { child, bridgePort, bridgeSecret } = await startBridge(
    engine.address().port,
  );

  try {
    const response = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": bridgeSecret,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "mimo-desktop/mimo-pro",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    );
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.type, "error");
    assert.equal(payload.error.type, "invalid_request_error");
    assert.match(payload.error.message, /max_tokens/);
  } finally {
    child.kill();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await new Promise((resolve) => engine.close(resolve));
  }
});


test("上游首包超时：应快速报错而不是干等总超时", async () => {
  const engine = http.createServer((req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mimo-desktop/mimo-pro" }] }));
      return;
    }
    // 挂起 SSE：写了 header 但永远不吐 chunk
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
    });
    res.flushHeaders?.();
    // 故意不 res.write / 不 res.end
    sockets.add(res.socket);
    res.on("close", () => sockets.delete(res.socket));
  });
  const sockets = new Set();
  await listen(engine);

  const bridgeToken = "watchdog-token";
  const bridgeSecret = "watchdog-secret";
  const bridgePort = await unusedPort();
  const child = spawn(
    process.execPath,
    [
      path.join(projectDir, "bridge.mjs"),
      "--port",
      String(bridgePort),
      "--token",
      bridgeToken,
      "--bridge-secret",
      bridgeSecret,
      "--engine-url",
      `http://127.0.0.1:${engine.address().port}`,
    ],
    {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MIMO_BRIDGE_FIRST_TOKEN_TIMEOUT_MS: "800",
        MIMO_BRIDGE_STREAM_IDLE_TIMEOUT_MS: "800",
      },
    },
  );

  try {
    await waitForHealth(bridgePort, child);
    const started = Date.now();
    const response = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/messages`,
      {
        method: "POST",
        headers: {
          "x-api-key": bridgeSecret,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: "mimo-desktop/mimo-pro",
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    );
    const text = await response.text();
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 5000,
      `should fail fast, took ${elapsed}ms`,
    );
    assert.match(text, /event: error/);
    assert.match(text, /no data within|stream idle|headers timeout/i);
  } finally {
    child.kill();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => engine.close(resolve));
  }
});


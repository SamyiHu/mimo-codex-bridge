import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function unusedPort() {
  const server = http.createServer();
  await listen(server);
  const { port } = server.address();
  await closeServer(server);
  return port;
}

async function waitForHealth(port, child, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`bridge exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error("bridge health check timed out");
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

test("workbuddy upstream keeps realm model IDs and forwards tool usage", async () => {
  const upstreamToken = "workbuddy-upstream-token";
  const bridgeSecret = "workbuddy-bridge-secret";
  let receivedBody;
  let receivedModelUrl;

  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    assert.equal(req.headers.authorization, `Bearer ${upstreamToken}`);
    if (req.method === "GET" && url.pathname === "/v1/models") {
      receivedModelUrl = url;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [{ id: "cn:test-model", object: "model", owned_by: "workbuddy" }],
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(receivedBody.model, "cn:test-model");
      assert.equal(receivedBody.stream_options?.include_usage, true);
      assert.equal(receivedBody.tools?.[0]?.function?.name, "read_file");

      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.write('data: {"object":"chat.completion.chunk","model":"cn:test-model","choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write('data: {"object":"chat.completion.chunk","model":"cn:test-model","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await listen(upstream);

  const bridgePort = await unusedPort();
  const child = spawn(
    process.execPath,
    [
      path.join(projectDir, "bridge.mjs"),
      "--upstream-kind",
      "workbuddy",
      "--engine-url",
      `http://127.0.0.1:${upstream.address().port}`,
      "--token",
      upstreamToken,
      "--bridge-secret",
      bridgeSecret,
      "--port",
      String(bridgePort),
    ],
    { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  try {
    const health = await waitForHealth(bridgePort, child);
    assert.equal(health.ok, true);
    assert.equal(health.upstreamKind, "workbuddy");

    const models = await fetch(`http://127.0.0.1:${bridgePort}/v1/models`, {
      headers: { Authorization: `Bearer ${bridgeSecret}` },
    });
    assert.equal(models.status, 200);
    assert.equal((await models.json()).data[0].id, "cn:test-model");
    assert.equal(receivedModelUrl.searchParams.has("directory"), false);

    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bridgeSecret}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: "cn:test-model",
        input: "read a file",
        stream: true,
        tools: [{
          type: "function",
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object" },
        }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const completed = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)))
      .find((event) => event.type === "response.completed")
      ?.response;
    assert.equal(receivedBody.model, "cn:test-model");
    assert.equal(receivedBody.tools[0].function.name, "read_file");
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.usage, {
      input_tokens: 11,
      output_tokens: 3,
      total_tokens: 14,
    });
  } catch (error) {
    error.message += `\nbridge output:\n${output}`;
    throw error;
  } finally {
    await terminateChild(child);
    upstream.closeAllConnections?.();
    await closeServer(upstream);
  }
});


test("raw chat mode preserves native Chat request fields", async () => {
  const upstreamToken = "raw-upstream-token";
  const bridgeSecret = "raw-bridge-secret";
  let receivedBody;

  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    assert.equal(req.headers.authorization, `Bearer ${upstreamToken}`);
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-raw",
        object: "chat.completion",
        created: 1,
        model: receivedBody.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await listen(upstream);

  const bridgePort = await unusedPort();
  const child = spawn(
    process.execPath,
    [
      path.join(projectDir, "bridge.mjs"),
      "--upstream-kind",
      "workbuddy",
      "--chat-mode",
      "raw",
      "--engine-url",
      `http://127.0.0.1:${upstream.address().port}`,
      "--token",
      upstreamToken,
      "--bridge-secret",
      bridgeSecret,
      "--port",
      String(bridgePort),
    ],
    { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  try {
    const health = await waitForHealth(bridgePort, child);
    assert.equal(health.ok, true);
    assert.equal(health.chatMode, "raw");

    const requestBody = {
      model: "bare-model",
      messages: [{ role: "user", content: "hello" }],
      metadata: { trace_id: "trace-1" },
      max_completion_tokens: 128,
      tool_choice: { type: "function", function: { name: "lookup" } },
      parallel_tool_calls: false,
      stream_options: { include_usage: false },
      stream: false,
    };
    const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bridgeSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.model, "bare-model");
    assert.equal(receivedBody.model, "bare-model");
    assert.deepEqual(receivedBody.metadata, requestBody.metadata);
    assert.equal(receivedBody.max_completion_tokens, 128);
    assert.deepEqual(receivedBody.tool_choice, requestBody.tool_choice);
    assert.equal(receivedBody.parallel_tool_calls, false);
    assert.deepEqual(receivedBody.stream_options, requestBody.stream_options);
  } catch (error) {
    error.message += `
bridge output:
${output}`;
    throw error;
  } finally {
    await terminateChild(child);
    upstream.closeAllConnections?.();
    await closeServer(upstream);
  }
});


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
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`bridge exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("bridge health check timed out");
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
}

async function startBridge(upstreamKind, upstreamPort, bridgePort, token, secret) {
  const child = spawn(
    process.execPath,
    [
      path.join(projectDir, "bridge.mjs"),
      "--upstream-kind",
      upstreamKind,
      "--engine-url",
      `http://127.0.0.1:${upstreamPort}`,
      "--token",
      token,
      "--bridge-secret",
      secret,
      "--port",
      String(bridgePort),
    ],
    { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  return { child, getOutput: () => output };
}

function chatPayload() {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "mimo-desktop/mimo-test",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

test("MiMo reasoning effort is collapsed to thinking on/off", async () => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mimo-desktop/mimo-test" }] }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(chatPayload()));
      return;
    }
    res.writeHead(404).end();
  });
  await listen(upstream);

  const upstreamPort = upstream.address().port;
  const bridgePort = await unusedPort();
  const { child, getOutput } = await startBridge(
    "mimo",
    upstreamPort,
    bridgePort,
    "mimo-upstream-token",
    "mimo-bridge-secret",
  );

  try {
    await waitForHealth(bridgePort, child);
    const auth = { Authorization: "Bearer mimo-bridge-secret", "Content-Type": "application/json" };
    const responses = [];
    for (const reasoning of [{ effort: "high" }, { effort: "minimal" }, undefined]) {
      responses.push(await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: "mimo-test",
          input: "hello",
          stream: false,
          ...(reasoning ? { reasoning } : {}),
        }),
      }));
    }
    for (const response of responses) assert.equal(response.status, 200);
    assert.equal(received[0].reasoning_effort, "high");
    assert.equal(Object.hasOwn(received[1], "reasoning_effort"), false);
    assert.equal(Object.hasOwn(received[2], "reasoning_effort"), false);

    for (const thinking of [
      { type: "enabled", budget_tokens: 0 },
      { type: "disabled" },
    ]) {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: "mimo-test",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
          thinking,
        }),
      });
      assert.equal(response.status, 200);
    }
    assert.equal(received[3].reasoning_effort, "high");
    assert.equal(Object.hasOwn(received[4], "reasoning_effort"), false);
  } catch (error) {
    error.message += `
bridge output:
${getOutput()}`;
    throw error;
  } finally {
    await terminateChild(child);
    upstream.closeAllConnections?.();
    await closeServer(upstream);
  }
});

test("WorkBuddy reasoning effort levels remain unchanged", async () => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "cn:test-model" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...chatPayload(), model: "cn:test-model" }));
      return;
    }
    res.writeHead(404).end();
  });
  await listen(upstream);

  const upstreamPort = upstream.address().port;
  const bridgePort = await unusedPort();
  const { child, getOutput } = await startBridge(
    "workbuddy",
    upstreamPort,
    bridgePort,
    "workbuddy-upstream-token",
    "workbuddy-bridge-secret",
  );

  try {
    await waitForHealth(bridgePort, child);
    for (const effort of ["high", "minimal"]) {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: "Bearer workbuddy-bridge-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "cn:test-model",
          input: "hello",
          stream: false,
          reasoning: { effort },
        }),
      });
      assert.equal(response.status, 200);
    }
    assert.equal(received[0].reasoning_effort, "high");
    assert.equal(received[1].reasoning_effort, "minimal");
  } catch (error) {
    error.message += `
bridge output:
${getOutput()}`;
    throw error;
  } finally {
    await terminateChild(child);
    upstream.closeAllConnections?.();
    await closeServer(upstream);
  }
});

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
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
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

/** 起一个可观测的假 MiMo 引擎，返回各上游连接的中断情况。 */
function createFakeEngine({ upstreamDelayMs = 500 } = {}) {
  const state = {
    backgroundInFlight: 0,
    backgroundPeak: 0,
    backgroundCompleted: 0,
    backgroundAborted: 0,
    streamAborted: 0,
    releaseStream: null,
  };
  const streamGate = new Promise((resolve) => {
    state.releaseStream = resolve;
  });

  const engine = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "xiaomi/mimo-pro" }] }));
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

      let closedEarly = false;
      res.on("close", () => {
        if (res.writableEnded) return;
        closedEarly = true;
        if (body.stream) state.streamAborted += 1;
        else state.backgroundAborted += 1;
      });

      if (body.stream === true) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
        });
        res.write(
          'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"流式片段"}}]}\n\n',
        );
        await streamGate;
        res.end();
        return;
      }

      state.backgroundInFlight += 1;
      state.backgroundPeak = Math.max(
        state.backgroundPeak,
        state.backgroundInFlight,
      );
      await new Promise((resolve) => setTimeout(resolve, upstreamDelayMs));
      state.backgroundInFlight -= 1;
      // 连接已被取消断开时，这次上游调用没有产出任何结果。
      if (closedEarly) return;
      state.backgroundCompleted += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [
            { finish_reason: "stop", message: { role: "assistant", content: "ok" } },
          ],
        }),
      );
      return;
    }

    res.writeHead(404).end();
  });

  return { engine, state, releaseStream: () => state.releaseStream() };
}

async function startBridge(enginePort, extraEnv = {}) {
  const bridgePort = await unusedPort();
  const child = spawn(
    process.execPath,
    [
      path.join(projectDir, "bridge.mjs"),
      "--port",
      String(bridgePort),
      "--token",
      "integration-token",
      "--bridge-secret",
      "integration-secret",
      "--engine-url",
      `http://127.0.0.1:${enginePort}`,
    ],
    {
      cwd: projectDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  await waitForHealth(bridgePort, child);
  return {
    child,
    port: bridgePort,
    output,
    headers: {
      Authorization: "Bearer integration-secret",
      "Content-Type": "application/json",
    },
  };
}

function rawRequest(port, host) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET /health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      );
    });
    let data = "";
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("raw request timed out"));
    });
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
  });
}

test("cancelling a background response aborts the upstream request", async () => {
  const { engine, state, releaseStream } = createFakeEngine();
  await listen(engine);
  const bridge = await startBridge(engine.address().port);

  try {
    const queued = await (
      await fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({ model: "mimo-pro", input: "hi", background: true }),
      })
    ).json();

    await new Promise((resolve) => setTimeout(resolve, 80));

    const cancelled = await fetch(
      `http://127.0.0.1:${bridge.port}/v1/responses/${queued.id}/cancel`,
      { method: "POST", headers: bridge.headers },
    );
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).status, "cancelled");

    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(
      state.backgroundAborted,
      1,
      "取消必须真正断开上游连接，否则请求会白跑到结束",
    );
    assert.equal(
      state.backgroundCompleted,
      0,
      "被取消的后台请求不应被记为已完成",
    );
  } finally {
    releaseStream();
    await terminateChild(bridge.child);
    engine.closeAllConnections?.();
    await closeServer(engine);
  }
});

test("cancelling a streaming response aborts upstream and ends with cancelled", async () => {
  const { engine, state, releaseStream } = createFakeEngine();
  await listen(engine);
  const bridge = await startBridge(engine.address().port);

  try {
    const response = await fetch(
      `http://127.0.0.1:${bridge.port}/v1/responses`,
      {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({
          model: "mimo-pro",
          input: "stream",
          stream: true,
        }),
      },
    );
    assert.equal(response.status, 200);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let responseId = null;
    const deadline = Date.now() + 5000;
    // response.created 里就带 id，但中文 delta 可能晚于它到达：继续读到文本出现为止
    while ((!responseId || !text.includes("流式片段")) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const match = text.match(/"id":"(resp_[^"]+)"/);
      if (match) responseId = match[1];
    }
    assert.ok(responseId, "流式响应应先给出 id，客户端才能取消它");
    assert.ok(
      text.includes("流式片段"),
      "跨 chunk 的中文不应出现 U+FFFD",
    );

    const cancelled = await fetch(
      `http://127.0.0.1:${bridge.port}/v1/responses/${responseId}/cancel`,
      { method: "POST", headers: bridge.headers },
    );
    assert.equal(cancelled.status, 200);

    let tail = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      tail += decoder.decode(value, { stream: true });
    }

    assert.equal(state.streamAborted, 1, "取消必须中断上游流");
    assert.match(tail, /event: response\.cancelled/);
    assert.doesNotMatch(tail, /event: response\.failed/);
  } finally {
    releaseStream();
    await terminateChild(bridge.child);
    engine.closeAllConnections?.();
    await closeServer(engine);
  }
});

test("background responses obey the concurrency limit", async () => {
  const { engine, state, releaseStream } = createFakeEngine();
  await listen(engine);
  const bridge = await startBridge(engine.address().port, {
    MIMO_BRIDGE_MAX_CONCURRENT: "1",
  });

  try {
    const requests = [1, 2, 3].map(() =>
      fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({
          model: "mimo-pro",
          input: "hi",
          background: true,
        }),
      }),
    );
    await Promise.all(requests);

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const status = await (
      await fetch(`http://127.0.0.1:${bridge.port}/status`, {
        headers: bridge.headers,
      })
    ).json();

    assert.equal(
      state.backgroundPeak,
      1,
      `background 请求绕过了并发上限：峰值 ${state.backgroundPeak}`,
    );
    assert.equal(status.limits.max_concurrent_requests, 1);
    // 全部结束后额度必须已释放。
    assert.equal(status.metrics.requests.active, 0);
  } finally {
    releaseStream();
    await terminateChild(bridge.child);
    engine.closeAllConnections?.();
    await closeServer(engine);
  }
});

test("control-plane endpoints stay reachable when the data plane is saturated", async () => {
  const { engine, state, releaseStream } = createFakeEngine();
  await listen(engine);
  const bridge = await startBridge(engine.address().port, {
    MIMO_BRIDGE_MAX_CONCURRENT: "1",
  });

  try {
    const queued = await (
      await fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({
          model: "mimo-pro",
          input: "hi",
          background: true,
        }),
      })
    ).json();
    await new Promise((resolve) => setTimeout(resolve, 80));

    // 额度已被占满：第二个数据面请求应被限流。
    const saturated = await fetch(
      `http://127.0.0.1:${bridge.port}/v1/responses`,
      {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({ model: "mimo-pro", input: "hi" }),
      },
    );
    assert.equal(saturated.status, 429);

    // 但取消/查询/删除只动本地状态，必须仍然可用。
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${bridge.port}/status`, {
          headers: bridge.headers,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${bridge.port}/v1/responses/${queued.id}/cancel`,
          { method: "POST", headers: bridge.headers },
        )
      ).status,
      200,
      "并发打满时取消接口必须仍能工作",
    );
    assert.equal(
      (
        await fetch(
          `http://127.0.0.1:${bridge.port}/v1/responses/${queued.id}`,
          { method: "DELETE", headers: bridge.headers },
        )
      ).status,
      200,
    );
  } finally {
    releaseStream();
    await terminateChild(bridge.child);
    engine.closeAllConnections?.();
    await closeServer(engine);
  }
});

test("rejects requests carrying a non-loopback Host header", async () => {
  const { engine, releaseStream } = createFakeEngine();
  await listen(engine);
  const bridge = await startBridge(engine.address().port);

  try {
    const forged = await rawRequest(bridge.port, "evil.example");
    assert.match(forged, /HTTP\/1\.1 403 Forbidden/);
    assert.match(forged, /forbidden_host/);

    const legit = await rawRequest(bridge.port, `127.0.0.1:${bridge.port}`);
    assert.match(legit, /HTTP\/1\.1 200 OK/);
  } finally {
    releaseStream();
    await terminateChild(bridge.child);
    engine.closeAllConnections?.();
    await closeServer(engine);
  }
});

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

async function waitForBridgeStatus(port, secret, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    last = await response.json();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`bridge status condition not met, last: ${JSON.stringify(last?.limits)}`);
}

function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill();
  return Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]).then(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
}

function spawnBridge(args, env = {}) {
  const portPromise = unusedPort();
  return portPromise.then((port) => {
    const child = spawn(
      process.execPath,
      [path.join(projectDir, "bridge.mjs"), ...args, "--port", String(port)],
      {
        cwd: projectDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.__output = () => output;
    child.__port = port;
    return child;
  });
}

test("workbuddy account pool scales concurrency to 8 × healthy accounts", async () => {
  const upstreamToken = "pool-upstream-token";
  const bridgeSecret = "pool-bridge-secret";

  // 网关侧 /status 回报 2 个健康账号（共 3 个）。
  let statusCalls = 0;
  // /v1/chat/completions 挂住不放，模拟长流式请求占满并发额度。
  let heldChatResponses = 0;
  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });

  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/status") {
      statusCalls += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ total: 3, healthy: 2, cooling: 1, disabled: 0, accounts: [] }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [{ id: "cn:test-model", object: "model", owned_by: "workbuddy" }],
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      req.resume();
      heldChatResponses += 1;
      gate.then(() => {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        res.write('data: {"object":"chat.completion.chunk","model":"cn:test-model","choices":[{"delta":{"content":"ok"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  await listen(upstream);

  const child = await spawnBridge([
    "--upstream-kind", "workbuddy",
    "--engine-url", `http://127.0.0.1:${upstream.address().port}`,
    "--token", upstreamToken,
    "--bridge-secret", bridgeSecret,
  ]);

  try {
    await waitForHealth(child.__port, child);
    // 启动探测拿到 healthy=2 → 上限 8×2=16
    const status = await waitForBridgeStatus(
      child.__port,
      bridgeSecret,
      (payload) => payload.limits.max_concurrent_requests === 16,
    );
    assert.equal(status.limits.account_pool.multiplier, 2);
    assert.equal(status.limits.account_pool.healthy, 2);
    assert.equal(status.limits.account_pool.total, 3);
    assert.equal(status.limits.account_pool.per_account, 8);
    assert.ok(statusCalls >= 1);

    // 17 路并发：16 路占用，第 17 路 429，报错里带上 8 × 2 的算式。
    // 假网关在闸门打开前不回响应头，被接受的 16 路 fetch 要等放行才 settle，
    // 所以先盯 429 那一路，再放行收尾。
    const responses = new Array(17).fill(null);
    const settled = Array.from({ length: 17 }, (_, index) =>
      fetch(`http://127.0.0.1:${child.__port}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridgeSecret}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: "cn:test-model",
          input: "hold",
          stream: true,
        }),
      }).then(
        (value) => {
          responses[index] = value;
          return value.status;
        },
        (error) => {
          responses[index] = error;
          return "rejected";
        },
      ),
    );

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (responses.filter((r) => r && r.status === 429).length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const tooMany = responses.filter((r) => r && r.status === 429);
    assert.equal(tooMany.length, 1, `expected exactly one 429, got ${tooMany.length}`);
    const errorBody = await tooMany[0].json();
    assert.equal(errorBody.error.type, "concurrency_limit");
    assert.match(
      errorBody.error.message,
      /bridge concurrency limit reached \(16 = 8 × 2 accounts\)/,
    );

    // 16 路已全部打到网关并被挂住
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(heldChatResponses >= 16, `gateway held ${heldChatResponses} chat requests`);
    openGate();
    const statuses = await Promise.all(settled);
    assert.equal(statuses.filter((status) => status === 200).length, 16);
  } catch (error) {
    console.error(child.__output());
    throw error;
  } finally {
    await terminateChild(child);
    await closeServer(upstream);
  }
});

test("trae account pool counts healthy accounts from the status list", async () => {
  const upstreamToken = "trae-pool-token";
  const bridgeSecret = "trae-pool-secret";

  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        accounts: [
          { uid: "a", enabled: true, disabled: false, cooling: false },
          { uid: "b", enabled: true, disabled: false, cooling: false },
          { uid: "c", enabled: true, disabled: false, cooling: true },
          { uid: "d", enabled: false, disabled: false, cooling: false },
          { uid: "e", enabled: true, disabled: true, cooling: false },
        ],
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await listen(upstream);

  const child = await spawnBridge([
    "--upstream-kind", "trae",
    "--engine-url", `http://127.0.0.1:${upstream.address().port}`,
    "--token", upstreamToken,
    "--bridge-secret", bridgeSecret,
  ]);

  try {
    await waitForHealth(child.__port, child);
    // trae /status 无 healthy 计数字段，走 accounts 列表：a、b 健康 → ×2
    const status = await waitForBridgeStatus(
      child.__port,
      bridgeSecret,
      (payload) => payload.limits.max_concurrent_requests === 16,
    );
    assert.equal(status.limits.account_pool.multiplier, 2);
    assert.equal(status.limits.account_pool.healthy, 2);
    assert.equal(status.limits.account_pool.total, 5);
  } catch (error) {
    console.error(child.__output());
    throw error;
  } finally {
    await terminateChild(child);
    await closeServer(upstream);
  }
});

test("MIMO_BRIDGE_ACCOUNTS pins the multiplier without gateway probing", async () => {
  const upstreamToken = "manual-pool-token";
  const bridgeSecret = "manual-pool-secret";

  // 网关不提供 /status：手动钉死 3 个账号也要生效
  const upstream = http.createServer((req, res) => {
    res.writeHead(404).end();
  });
  await listen(upstream);

  const child = await spawnBridge(
    [
      "--upstream-kind", "workbuddy",
      "--engine-url", `http://127.0.0.1:${upstream.address().port}`,
      "--token", upstreamToken,
      "--bridge-secret", bridgeSecret,
    ],
    { MIMO_BRIDGE_ACCOUNTS: "3" },
  );

  try {
    await waitForHealth(child.__port, child);
    const status = await waitForBridgeStatus(
      child.__port,
      bridgeSecret,
      (payload) => payload.limits.max_concurrent_requests === 24,
    );
    assert.equal(status.limits.account_pool.mode, "manual");
    assert.equal(status.limits.account_pool.multiplier, 3);
  } catch (error) {
    console.error(child.__output());
    throw error;
  } finally {
    await terminateChild(child);
    await closeServer(upstream);
  }
});

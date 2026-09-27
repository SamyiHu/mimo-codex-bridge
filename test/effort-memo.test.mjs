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

test("reasoning_effort 被拒绝后按模型记忆，第二个请求不再白付 400", async () => {
  const bridgeToken = "effort-token";
  const bridgeSecret = "effort-bridge-secret";
  const chatRequests = [];

  const engine = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ data: [{ id: "mimo-desktop/mimo-v2.6-pro" }] }),
      );
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      chatRequests.push(body);

      if (body.reasoning_effort !== undefined) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message:
                "Model `mimo-desktop/mimo-v2.6-pro` does not support reasoning_effort",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "ok" },
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404).end();
  });
  await listen(engine);

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
    { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForHealth(bridgePort, child);
    const auth = {
      Authorization: `Bearer ${bridgeSecret}`,
      "Content-Type": "application/json",
    };

    const ask = () =>
      fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: "mimo-desktop/mimo-v2.6-pro",
          input: "hi",
          reasoning: { effort: "high" },
          stream: false,
        }),
      });

    // 第一个请求：带 effort → 上游 400 → 桥剥掉重发 → 200
    const first = await ask();
    assert.equal(first.status, 200);
    assert.equal(chatRequests.length, 2);
    assert.equal(chatRequests[0].reasoning_effort, "high");
    assert.equal(chatRequests[1].reasoning_effort, undefined);

    // 第二个请求：记忆生效，直接不带 effort 发出，只有一次上游调用
    const second = await ask();
    assert.equal(second.status, 200);
    assert.equal(chatRequests.length, 3);
    assert.equal(chatRequests[2].reasoning_effort, undefined);
  } finally {
    child.kill();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    engine.close();
    await new Promise((resolve) => engine.close(resolve));
  }
});

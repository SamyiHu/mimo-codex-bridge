
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

test("bridge retries plan-only action responses and returns a real tool call", async () => {
  const bridgeToken = "guard-token";
  const bridgeSecret = "guard-bridge-secret";
  const requests = [];

  const engine = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mimo-pro" }] }));
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);

      if (body.stream === true) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
        });
        res.write(
          'data: {"object":"chat.completion.chunk","model":"mimo-pro","choices":[{"delta":{"role":"assistant","content":"I will commit and push."}}]}\n\n',
        );
        res.write(
          'data: {"object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        );
        res.write(
          'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      assert.equal(body.tool_choice, "required");
      assert.equal(body.stream, false);
      assert.ok(
        body.messages.some(
          (message) =>
            message.role === "system" &&
            String(message.content).includes("did not call a tool"),
        ),
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "mimo-pro",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "retry-call",
                    type: "function",
                    function: {
                      name: "exec_command",
                      arguments: '{"cmd":"git status"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
          },
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
    const response = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridgeSecret}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: "mimo-pro",
          input: "commit+push",
          tools: [
            {
              type: "function",
              name: "exec_command",
              parameters: {
                type: "object",
                properties: { cmd: { type: "string" } },
                required: ["cmd"],
              },
            },
          ],
          stream: true,
          store: false,
        }),
      },
    );
    assert.equal(response.status, 200);
    const streamText = await readSse(response);
    assert.equal(streamText.includes("I will commit and push."), false);
    assert.match(streamText, /response\.function_call_arguments\.done/);
    assert.match(streamText, /git status/);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].tool_choice, "required");
    assert.equal(requests[1].stream, false);
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

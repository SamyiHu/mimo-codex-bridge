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
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function readUntil(reader, predicate, timeoutMs = 1000) {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const timeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`stream wait exceeded ${timeoutMs}ms`)),
        Math.max(1, deadline - Date.now()),
      ),
    );
    const read = reader.read();
    const result = await Promise.race([read, timeout]);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
    if (predicate(text)) return text;
  }
  throw new Error("expected stream data was not received");
}

test("bridge authenticates requests and forwards real upstream streaming", async () => {
  const bridgeToken = "integration-token";
  const bridgeSecret = "integration-bridge-secret";
  let releaseSecondChunk;
  let receivedChatBody;
  const secondChunkGate = new Promise((resolve) => {
    releaseSecondChunk = resolve;
  });

  const engine = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [{ id: "xiaomi/mimo-pro" }],
        }),
      );
      return;
    }

    if (
      req.method === "POST" &&
      req.url.startsWith("/v1/chat/completions")
    ) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      receivedChatBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));

      assert.equal(req.headers.authorization, `Bearer ${bridgeToken}`);

      if (receivedChatBody.stream !== true) {
        const userMessages = receivedChatBody.messages.filter(
          (message) => message.role === "user",
        );
        const assistantMessages = receivedChatBody.messages.filter(
          (message) => message.role === "assistant",
        );
        const lastUser = userMessages.at(-1)?.content ?? "";
        const previousAssistant = assistantMessages.at(-1)?.content ?? "";
        const structuredRequired = receivedChatBody.messages.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes("Structured output requirement:"),
        );
        const content = structuredRequired
          ? JSON.stringify({ ok: true, protocol: "full" })
          : lastUser === "background"
            ? "background answer"
            : previousAssistant
              ? JSON.stringify({ previous: previousAssistant, input: lastUser })
              : "first answer";

        const sendNonStream = () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              model: receivedChatBody.model,
              choices: [
                {
                  finish_reason: "stop",
                  message: { role: "assistant", content },
                },
              ],
              usage: {
                prompt_tokens: 2,
                completion_tokens: 3,
                total_tokens: 5,
                prompt_tokens_details: { cached_tokens: 1 },
                completion_tokens_details: { reasoning_tokens: 1 },
              },
            }),
          );
        };

        if (lastUser === "cancel-me") {
          setTimeout(sendNonStream, 300);
          return;
        }

        sendNonStream();
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.write(
        'data: {"object":"chat.completion.chunk","model":"xiaomi/mimo-pro","choices":[{"delta":{"content":"first "}}]}\n\n',
      );

      await secondChunkGate;
      res.write(
        'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"second"}}]}\n\n',
      );
      res.write(
        'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(404).end();
  });

  await listen(engine);
  const enginePort = engine.address().port;
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

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  try {
    const health = await waitForHealth(bridgePort, child);
    assert.equal(health.ok, true);
    assert.equal(health.streaming, true);
    assert.equal(health.engine, `http://127.0.0.1:${enginePort}`);

    const unauthorized = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/responses`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "mimo-pro", input: "hello" }),
      },
    );
    assert.equal(unauthorized.status, 401);

    const upstreamTokenRejected = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridgeToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "mimo-pro", input: "hello" }),
      },
    );
    assert.equal(upstreamTokenRejected.status, 401);

    const invalid = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridgeSecret}`,
          "Content-Type": "application/json",
        },
        body: "{invalid",
      },
    );
    assert.equal(invalid.status, 400);

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
          input: "stream this",
          stream: true,
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type"),
      /text\/event-stream/,
    );

    const reader = response.body.getReader();
    let firstText;
    try {
      const first = await readUntil(
        reader,
        (text) => text.includes("response.output_text.delta"),
      );
      assert.match(first, /first /);
      firstText = first;
    } catch (error) {
      releaseSecondChunk();
      throw error;
    }

    releaseSecondChunk();
    const decoder = new TextDecoder();
    let streamText = firstText;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
      if (streamText.includes("event: response.completed")) break;
    }

    assert.match(streamText, /second/);
    assert.match(streamText, /event: response\.completed/);
    assert.equal(receivedChatBody.stream, true);
    assert.equal(receivedChatBody.model, "mimo-desktop/mimo-pro");

    const statusUnauthorized = await fetch(
      `http://127.0.0.1:${bridgePort}/status`,
    );
    assert.equal(statusUnauthorized.status, 401);

    const statusResponse = await fetch(
      `http://127.0.0.1:${bridgePort}/status`,
      {
        headers: { Authorization: `Bearer ${bridgeSecret}` },
      },
    );
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.authMode, "bridge_secret");
    assert.equal(status.bridgeSecretConfigured, true);
    assert.equal(status.engine, `http://127.0.0.1:${enginePort}`);
    assert.ok(status.metrics.requests.total >= 3);
    assert.ok(status.metrics.requests.by_model["mimo-desktop/mimo-pro"] >= 1);
    assert.equal(status.metrics.usage.total_tokens, 3, JSON.stringify(status.metrics.usage));
    assert.equal(status.metrics.upstream.breaker.state, "closed");
    assert.equal(status.protocol.previous_response_id, true);
    assert.equal(status.protocol.background_responses, true);

    const firstStateful = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridgeSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "mimo-pro",
          instructions: "Stateful system",
          input: "first",
          store: true,
          metadata: { case: "stateful" },
          service_tier: "default",
          text: { format: { type: "json_object" } },
        }),
      },
    );
    assert.equal(firstStateful.status, 200);
    const firstStatefulBody = await firstStateful.json();
    assert.equal(firstStatefulBody.status, "completed");
    assert.equal(firstStatefulBody.store, true);
    assert.deepEqual(firstStatefulBody.metadata, { case: "stateful" });
    assert.equal(firstStatefulBody.service_tier, "default");
    assert.deepEqual(firstStatefulBody.usage.input_tokens_details, {
      cached_tokens: 1,
    });
    const firstStatefulJson = JSON.parse(
      firstStatefulBody.output.find((item) => item.type === "message")
        .content[0].text,
    );
    assert.deepEqual(firstStatefulJson, { ok: true, protocol: "full" });
    assert.equal(receivedChatBody.response_format, undefined);
    assert.ok(
      receivedChatBody.messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("Structured output requirement:"),
      ),
    );

    const retrieved = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/responses/${firstStatefulBody.id}`,
      { headers: { Authorization: `Bearer ${bridgeSecret}` } },
    );
    assert.equal(retrieved.status, 200);
    assert.deepEqual(await retrieved.json(), firstStatefulBody);

    const secondStateful = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridgeSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "mimo-pro",
          previous_response_id: firstStatefulBody.id,
          input: "next",
        }),
      },
    );
    assert.equal(secondStateful.status, 200);
    const secondStatefulBody = await secondStateful.json();
    const statefulMessage = secondStatefulBody.output.find(
      (item) => item.type === "message",
    ).content[0].text;
    assert.deepEqual(JSON.parse(statefulMessage), {
      previous: JSON.stringify({ ok: true, protocol: "full" }),
      input: "next",
    });
    assert.equal(receivedChatBody.messages[0].content, "Stateful system");
    assert.deepEqual(receivedChatBody.messages[1], {
      role: "assistant",
      content: JSON.stringify({ ok: true, protocol: "full" }),
    });
    assert.deepEqual(receivedChatBody.messages[2], {
      role: "user",
      content: "next",
    });

    const backgroundQueued = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridgeSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "mimo-pro",
          input: "background",
          background: true,
        }),
      },
    );
    assert.equal(backgroundQueued.status, 200);
    const queuedBody = await backgroundQueued.json();
    assert.equal(queuedBody.background, true);
    assert.ok(["in_progress", "completed"].includes(queuedBody.status));

    let backgroundBody = queuedBody;
    const backgroundDeadline = Date.now() + 2000;
    while (
      backgroundBody.status === "in_progress" &&
      Date.now() < backgroundDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const backgroundStatus = await fetch(
        `http://127.0.0.1:${bridgePort}/v1/responses/${queuedBody.id}`,
        { headers: { Authorization: `Bearer ${bridgeSecret}` } },
      );
      assert.equal(backgroundStatus.status, 200);
      backgroundBody = await backgroundStatus.json();
    }

    assert.equal(backgroundBody.status, "completed");
    assert.equal(
      backgroundBody.output.find((item) => item.type === "message")
        .content[0].text,
      "background answer",
    );

    const cancellable = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridgeSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "mimo-pro",
          input: "cancel-me",
          background: true,
        }),
      },
    );
    const cancellableBody = await cancellable.json();
    const cancelResponse = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/responses/${cancellableBody.id}/cancel`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${bridgeSecret}` },
      },
    );
    assert.equal(cancelResponse.status, 200);
    assert.equal((await cancelResponse.json()).status, "cancelled");

    await new Promise((resolve) => setTimeout(resolve, 400));
    const cancelledAfterWait = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/responses/${cancellableBody.id}`,
      { headers: { Authorization: `Bearer ${bridgeSecret}` } },
    );
    assert.equal((await cancelledAfterWait.json()).status, "cancelled");

    const deleted = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/responses/${cancellableBody.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bridgeSecret}` },
      },
    );
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), {
      id: cancellableBody.id,
      object: "response.deleted",
      deleted: true,
    });

    const missingAfterDelete = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/responses/${cancellableBody.id}`,
      { headers: { Authorization: `Bearer ${bridgeSecret}` } },
    );
    assert.equal(missingAfterDelete.status, 404);
  } catch (error) {
    error.message += `\nbridge output:\n${output}`;
    throw error;
  } finally {
    releaseSecondChunk();
    await terminateChild(child);
    if (typeof engine.closeAllConnections === "function") {
      engine.closeAllConnections();
    }
    await closeServer(engine);
  }
});
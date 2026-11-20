import test from "node:test";
import assert from "node:assert/strict";
import { buildQoderChatBody, slimModelConfig, translateEnvelopeLine, envelopeError, sessionIdFor } from "../qoder-upstream.mjs";

test("信封：必要字段与 messages/tools 透传", () => {
  const body = buildQoderChatBody({
    upstreamKey: "Qwen3.8-Max",
    messages: [{ role: "user", content: "你好" }],
    tools: [{ type: "function", function: { name: "f" } }],
    maxTokens: 1000,
    thinking: { enable: true, effort: "high" },
    userId: "u1",
  });
  assert.equal(body.stream, true);
  assert.equal(body.agent_id, "agent_common");
  assert.equal(body.chat_task, "agent_chat_generation");
  assert.equal(body.parameters.max_tokens, 1000);
  assert.equal(body.parameters.enable_thinking, true);
  assert.equal(body.parameters.reasoning_effort, "high");
  assert.equal(body.messages.length, 1);
  assert.equal(body.tools.length, 1);
  assert.equal(body.chat_context.extra.originalContent, "你好");
  assert.equal(body.chat_context.text, "你好");
  assert.ok(body.session_id.includes("-"));
});

test("信封：max_tokens 上限截断；thinking 缺省不落 false", () => {
  const body = buildQoderChatBody({ upstreamKey: "m", messages: [], maxTokens: 999999, thinking: null, userId: "u" });
  assert.equal(body.parameters.max_tokens, 32000);
  assert.equal(body.parameters.enable_thinking, undefined);
});

test("slimModelConfig 剥掉 thinking_config", () => {
  const slim = slimModelConfig({ key: "m", is_reasoning: true, thinking_config: { x: 1 }, source: "s" }, "m");
  assert.equal(slim.thinking_config, undefined);
  assert.equal(slim.is_reasoning, true);
  assert.equal(slim.source, "s");
});

test("sessionIdFor：同账号同模型同种子稳定，空种子随机", () => {
  const a = sessionIdFor("u1", "m1", "seed");
  const b = sessionIdFor("u1", "m1", "seed");
  const c = sessionIdFor("u1", "m1", null);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.split("-")[0], c.split("-")[0]);
});

test("信封拆解：正常 chunk 直通", () => {
  const line = 'data: {"statusCodeValue":200,"body":"{\\"choices\\":[{\\"delta\\":{\\"content\\":\\"你\\"}}]}"}';
  const out = translateEnvelopeLine(line);
  assert.equal(out.lines.length, 1);
  assert.match(out.lines[0], /^data: /);
  assert.equal(JSON.parse(out.lines[0].slice(6)).choices[0].delta.content, "你");
});

test("信封拆解：业务错误上抛", () => {
  const line = 'data: {"statusCodeValue":110,"body":"{\\"code\\":\\"110\\",\\"message\\":\\"no quota\\"}"}';
  const out = translateEnvelopeLine(line);
  assert.equal(out.lines.length, 0);
  assert.equal(out.error.status, 110);
  assert.match(out.error.text, /no quota/);
});

test("信封拆解：[DONE] 与空行", () => {
  assert.deepEqual(translateEnvelopeLine("data: [DONE]").lines, ["data: [DONE]"]);
  assert.deepEqual(translateEnvelopeLine("").lines, []);
  assert.deepEqual(translateEnvelopeLine(": keep-alive").lines, []);
});

test("envelopeError：200/缺字段不算错误", () => {
  assert.equal(envelopeError({ statusCodeValue: 200, body: "{}" }), null);
  assert.equal(envelopeError({ body: "{}" }), null);
  assert.ok(envelopeError({ statusCodeValue: 500, body: "boom" }));
});

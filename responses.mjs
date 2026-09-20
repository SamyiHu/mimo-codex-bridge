/**
 * Responses API ⇄ Chat Completions 翻译层。
 * Codex 现在只支持 wire_api = "responses"，而 MiMo 引擎只提供 /v1/chat/completions，
 * 这里做双向转换（含流式事件）。
 */

const uid = (p) => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (typeof c === "string" ? c : c?.text ?? c?.input_text ?? c?.output_text ?? ""))
    .join("");
}

/** Responses 请求 → chat completions 请求 */
export function toChatRequest(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") {
        if (typeof item === "string") messages.push({ role: "user", content: item });
        continue;
      }
      switch (item.type) {
        case "message":
        case undefined:
          if (item.role) messages.push({ role: item.role === "developer" ? "system" : item.role, content: textOf(item.content) });
          break;
        case "function_call":
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [{ id: item.call_id || item.id || uid("call_"), type: "function", function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) } }],
          });
          break;
        case "function_call_output":
          messages.push({ role: "tool", tool_call_id: item.call_id || item.id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") });
          break;
        case "reasoning":
        case "item_reference":
          break;
        default:
          if (item.role) messages.push({ role: item.role === "developer" ? "system" : item.role, content: textOf(item.content) });
      }
    }
  }

  const chat = {
    model: body.model,
    messages,
  };
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) chat.max_tokens = body.max_output_tokens;
  if (body.parallel_tool_calls !== undefined) chat.parallel_tool_calls = body.parallel_tool_calls;
  if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice;
  if (Array.isArray(body.tools) && body.tools.length) {
    chat.tools = body.tools
      .filter((t) => t && (t.type === "function" || t.name))
      .map((t) => {
        const fn = t.function ?? t;
        const tool = { type: "function", function: { name: fn.name, description: fn.description ?? "" } };
        if (fn.parameters) tool.function.parameters = fn.parameters;
        return tool;
      });
  }
  return chat;
}

/** chat completion → Responses 对象 */
export function toResponseObject(chatResp, requestBody) {
  const choice = chatResp?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const output = [];

  if (msg.reasoning_content) {
    output.push({ type: "reasoning", id: uid("rs_"), summary: [{ type: "summary_text", text: String(msg.reasoning_content) }] });
  }
  if (msg.content) {
    output.push({
      type: "message",
      id: uid("msg_"),
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: String(msg.content), annotations: [] }],
    });
  }
  for (const tc of msg.tool_calls ?? []) {
    output.push({
      type: "function_call",
      id: uid("fc_"),
      call_id: tc.id,
      name: tc.function?.name,
      arguments: tc.function?.arguments ?? "{}",
      status: "completed",
    });
  }

  const usage = chatResp?.usage ?? {};
  return {
    id: uid("resp_"),
    object: "response",
    created_at: chatResp?.created ?? Math.floor(Date.now() / 1000),
    status: "completed",
    model: chatResp?.model ?? requestBody?.model ?? "",
    output,
    parallel_tool_calls: requestBody?.parallel_tool_calls ?? true,
    tool_choice: requestBody?.tool_choice ?? "auto",
    tools: requestBody?.tools ?? [],
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
    incomplete_details: null,
    instructions: requestBody?.instructions ?? null,
  };
}

/** 把 Responses 对象拆成标准 SSE 事件序列 */
export function responseEvents(response, { onlyCompleted = false } = {}) {
  const events = [];
  const push = (type, payload) => events.push({ event: type, data: JSON.stringify({ type, ...payload }) });

  if (!onlyCompleted) {
    const { output, ...rest } = response;
    push("response.created", { response: { ...rest, output: [], status: "in_progress" } });
    push("response.in_progress", { response: { ...rest, output: [], status: "in_progress" } });

    response.output.forEach((item, index) => {
      push("response.output_item.added", { output_index: index, item: item.type === "message" || item.type === "reasoning" ? { ...item, status: "in_progress", content: [] } : { ...item, arguments: "" } });
      if (item.type === "message") {
        push("response.content_part.added", { item_id: item.id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        push("response.output_text.delta", { item_id: item.id, output_index: index, content_index: 0, delta: item.content[0].text });
        push("response.output_text.done", { item_id: item.id, output_index: index, content_index: 0, text: item.content[0].text });
        push("response.content_part.done", { item_id: item.id, output_index: index, content_index: 0, part: item.content[0] });
      } else if (item.type === "function_call") {
        push("response.function_call_arguments.delta", { item_id: item.id, output_index: index, delta: item.arguments });
        push("response.function_call_arguments.done", { item_id: item.id, output_index: index, arguments: item.arguments });
      } else if (item.type === "reasoning") {
        const text = item.summary?.[0]?.text ?? "";
        push("response.reasoning_summary_part.added", { item_id: item.id, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" } });
        if (text) push("response.reasoning_summary_text.delta", { item_id: item.id, output_index: index, summary_index: 0, delta: text });
        if (text) push("response.reasoning_summary_text.done", { item_id: item.id, output_index: index, summary_index: 0, text });
        push("response.reasoning_summary_part.done", { item_id: item.id, output_index: index, summary_index: 0, part: { type: "summary_text", text } });
      }
      push("response.output_item.done", { output_index: index, item });
    });
  }
  push("response.completed", { response });
  return events;
}

export function sseWrite(res, evt) {
  res.write(`event: ${evt.event}\ndata: ${evt.data}\n\n`);
}

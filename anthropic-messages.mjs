/**
 * Anthropic Messages API ⇄ Chat Completions 转换层。
 *
 * 让 Claude Code / 其它 Anthropic 客户端经 /v1/messages 使用本桥。
 * 覆盖：文本、图片、tool_use / tool_result、流式 SSE、usage 估算兜底。
 */
import { StringDecoder } from "node:string_decoder";
import { estimateResponsesOutputTokens, hasRealUsage } from "./token-estimate.mjs";

const uid = (prefix) =>
  prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);

function protocolError(message, statusCode = 400, type = "invalid_request_error") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.type = type;
  return error;
}

function systemTextOf(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((block) => {
        if (typeof block === "string") return block;
        if (block?.type === "text") return String(block.text ?? "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function toolResultText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (part.type === "text") return String(part.text ?? "");
        if (part.type === "image") {
          return "[image tool result omitted]";
        }
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

function anthropicImageToChat(block) {
  const source = block?.source ?? {};
  if (source.type === "base64") {
    const media = source.media_type || "image/png";
    return {
      type: "image_url",
      image_url: {
        url: `data:${media};base64,${source.data ?? ""}`,
      },
    };
  }
  if (source.type === "url") {
    return {
      type: "image_url",
      image_url: { url: String(source.url ?? "") },
    };
  }
  throw protocolError(`unsupported image source type: ${source.type ?? "unknown"}`);
}

function chatImageToAnthropic(part) {
  const url =
    typeof part?.image_url === "string"
      ? part.image_url
      : String(part?.image_url?.url ?? part?.url ?? "");
  if (url.startsWith("data:")) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (match) {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: match[1],
          data: match[2],
        },
      };
    }
  }
  return {
    type: "image",
    source: { type: "url", url },
  };
}

function parseToolInput(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  const text = String(raw);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { _raw: text };
  }
}

function textBlocksToChatParts(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (typeof block === "string") {
      parts.push({ type: "text", text: block });
      continue;
    }
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: String(block.text ?? "") });
        break;
      case "image":
        parts.push(anthropicImageToChat(block));
        break;
      default:
        throw protocolError(`unsupported user content block: ${block.type}`);
    }
  }
  return parts;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        return String(part?.text ?? part?.content ?? "");
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Anthropic Messages 请求 → Chat Completions 请求。
 */
export function toChatRequestFromAnthropic(body, options = {}) {
  if (!body || typeof body !== "object") {
    throw protocolError("request body must be a JSON object");
  }
  if (!body.model || typeof body.model !== "string") {
    throw protocolError("model is required");
  }
  if (body.max_tokens === undefined || body.max_tokens === null) {
    throw protocolError("max_tokens is required");
  }
  const maxTokens = Number(body.max_tokens);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw protocolError("max_tokens must be a positive number");
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw protocolError("messages is required and must be a non-empty array");
  }

  const messages = [];
  const systemText = systemTextOf(body.system);
  if (systemText) messages.push({ role: "system", content: systemText });

  let pendingToolCalls = [];

  const flushToolCalls = () => {
    if (!pendingToolCalls.length) return;
    const text = pendingToolCalls
      .map((call) => `Tool call ${call.function.name}(${call.function.arguments})`)
      .join("\n");
    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: pendingToolCalls,
    });
    pendingToolCalls = [];
  };

  for (const message of body.messages) {
    if (!message || typeof message !== "object") {
      throw protocolError("each message must be an object");
    }
    const role = message.role;
    if (role !== "user" && role !== "assistant") {
      throw protocolError(`unsupported message role: ${role}`);
    }

    const rawContent = message.content;
    const blocks = Array.isArray(rawContent)
      ? rawContent
      : typeof rawContent === "string"
        ? [{ type: "text", text: rawContent }]
        : [];

    if (role === "assistant") {
      flushToolCalls();
      const textParts = [];
      for (const block of blocks) {
        if (typeof block === "string") {
          textParts.push({ type: "text", text: block });
          continue;
        }
        if (!block || typeof block !== "object") continue;
        switch (block.type) {
          case "text":
            if (block.text) textParts.push({ type: "text", text: String(block.text) });
            break;
          case "tool_use":
            pendingToolCalls.push({
              id: String(block.id || uid("call_")),
              type: "function",
              function: {
                name: String(block.name ?? ""),
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
            break;
          case "thinking":
          case "redacted_thinking":
            // Chat 侧没有可回放的 thinking 状态。
            break;
          default:
            throw protocolError(
              `unsupported assistant content block: ${block.type}`,
            );
        }
      }
      if (textParts.length) {
        // 工具调用与文本同属一条 assistant 消息时，Chat 要求 content 与
        // tool_calls 并存；这里先把文本落成 assistant content，再在
        // flushToolCalls 时追加 tool_calls。若已有 pending tool calls，
        // 合并到同一条消息。
        if (pendingToolCalls.length) {
          messages.push({
            role: "assistant",
            content: textParts.map((p) => p.text).join(""),
            tool_calls: pendingToolCalls,
          });
          pendingToolCalls = [];
        } else {
          messages.push({
            role: "assistant",
            content: textParts.map((p) => p.text).join(""),
          });
        }
      }
      continue;
    }

    // user：可能是纯文本/图片，也可能夹着 tool_result。
    const userParts = [];
    for (const block of blocks) {
      if (typeof block === "string") {
        userParts.push({ type: "text", text: block });
        continue;
      }
      if (!block || typeof block !== "object") continue;
      switch (block.type) {
        case "text":
          userParts.push({ type: "text", text: String(block.text ?? "") });
          break;
        case "image":
          userParts.push(anthropicImageToChat(block));
          break;
        case "tool_result": {
          flushToolCalls();
          const toolContent = toolResultText(block.content);
          messages.push({
            role: "tool",
            tool_call_id: String(block.tool_use_id ?? block.id ?? ""),
            content: block.is_error
              ? `Error: ${toolContent}`
              : toolContent,
          });
          break;
        }
        default:
          throw protocolError(`unsupported user content block: ${block.type}`);
      }
    }

    if (userParts.length) {
      flushToolCalls();
      const hasMedia = userParts.some((p) => p.type !== "text");
      if (hasMedia) {
        messages.push({ role: "user", content: userParts });
      } else {
        messages.push({
          role: "user",
          content: userParts.map((p) => p.text).join("\n"),
        });
      }
    }
  }
  flushToolCalls();

  if (!messages.length) {
    throw protocolError("messages produced no chat content");
  }

  const chat = {
    model: body.model,
    messages,
    max_tokens: maxTokens,
    stream: body.stream === true,
  };

  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    chat.stop =
      body.stop_sequences.length === 1
        ? body.stop_sequences[0]
        : body.stop_sequences;
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    chat.tools = body.tools
      .filter((tool) => tool && typeof tool === "object" && tool.name)
      .map((tool) => ({
        type: "function",
        function: {
          name: String(tool.name),
          description: String(tool.description ?? ""),
          parameters: tool.input_schema ?? {
            type: "object",
            properties: {},
          },
        },
      }));
    if (!chat.tools.length) delete chat.tools;
  }

  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (typeof choice === "string") {
      chat.tool_choice = choice === "any" ? "required" : choice;
    } else if (choice && typeof choice === "object") {
      if (choice.type === "auto") chat.tool_choice = "auto";
      else if (choice.type === "any") chat.tool_choice = "required";
      else if (choice.type === "none") chat.tool_choice = "none";
      else if (choice.type === "tool") {
        if (!choice.name) throw protocolError("tool_choice.name is required for type=tool");
        chat.tool_choice = {
          type: "function",
          function: { name: String(choice.name) },
        };
      } else {
        throw protocolError(`unsupported tool_choice.type: ${choice.type}`);
      }
    }
  }

  // Anthropic thinking：有 budget 时映射到 reasoning_effort，供上游参考。
  if (body.thinking?.type === "enabled" && options.mapThinkingToReasoning !== false) {
    const budget = Number(body.thinking.budget_tokens ?? 0);
    if (budget >= 10000) chat.reasoning_effort = "high";
    else if (budget >= 2000) chat.reasoning_effort = "medium";
    else if (budget > 0) chat.reasoning_effort = "low";
  }

  return chat;
}

function stopReasonFromChat(finishReason, hasToolCalls) {
  if (hasToolCalls) return "tool_use";
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "content_filter":
      return "refusal";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "end_turn";
  }
}

/**
 * Chat Completions 非流式响应 → Anthropic Message。
 */
export function toAnthropicMessage(chatResponse, request = {}, options = {}) {
  const choice = chatResponse?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];

  const text =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? contentToText(message.content)
        : "";

  if (text) {
    content.push({ type: "text", text });
  }

  const toolCalls = message.tool_calls ?? [];
  for (const call of toolCalls) {
    const fn = call?.function ?? call;
    content.push({
      type: "tool_use",
      id: String(call?.id || uid("toolu_")),
      name: String(fn?.name ?? ""),
      input: parseToolInput(fn?.arguments ?? call?.arguments),
    });
  }

  const usage = chatResponse?.usage ?? {};
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);

  let finalOutputTokens = outputTokens;
  if (options.estimateMissingUsage !== false && !hasRealUsage({
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: Number(usage.total_tokens ?? 0),
  })) {
    finalOutputTokens = estimateResponsesOutputTokens(content);
  }

  return {
    id: chatResponse?.id || uid("msg_"),
    type: "message",
    role: "assistant",
    model: chatResponse?.model || request.model || "",
    content,
    stop_reason: stopReasonFromChat(choice.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens || Number(options.estimatedInputTokens || 0),
      output_tokens: finalOutputTokens,
    },
  };
}

function anthropicEvent(name, data) {
  return { event: name, data: JSON.stringify(data) };
}

/**
 * 创建 Chat Completions SSE → Anthropic Messages SSE 转换器。
 *
 * start() 开始时输出 message_start；
 * push() 接收 chat.completion.chunk；
 * end() 输出 message_delta + message_stop；
 * fail() 输出 error 事件。
 */
export function createAnthropicStreamTranslator(request = {}, options = {}) {
  const model = request.model || "";
  const estimatedInputTokens = Number(options.estimatedInputTokens) > 0
    ? Number(options.estimatedInputTokens)
    : 0;

  const state = {
    messageId: uid("msg_"),
    started: false,
    contentIndex: -1,
    openBlock: null, // { kind: "text" | "tool", index, toolId?, name? }
    textOpened: false,
    toolBlocks: new Map(), // key → { index, id, name, args }
    nextIndex: 0,
    usage: {
      input_tokens: estimatedInputTokens,
      output_tokens: 0,
    },
    sawUsage: false,
    stopReason: null,
  };

  const events = [];

  const openTextBlock = () => {
    if (state.textOpened) return events;
    const index = state.nextIndex++;
    state.textOpened = true;
    state.openBlock = { kind: "text", index };
    events.push(
      anthropicEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      }),
    );
    return events;
  };

  const closeOpenBlock = () => {
    if (!state.openBlock) return events;
    events.push(
      anthropicEvent("content_block_stop", {
        type: "content_block_stop",
        index: state.openBlock.index,
      }),
    );
    state.openBlock = null;
    return events;
  };

  const startToolBlock = (call) => {
    closeOpenBlock();
    const key = String(call?.id || call?.index || state.nextIndex);
    if (state.toolBlocks.has(key)) return events;
    const index = state.nextIndex++;
    const id = String(call?.id || uid("toolu_"));
    const name = String(call?.function?.name ?? call?.name ?? "");
    state.toolBlocks.set(key, { index, id, name, args: "" });
    state.openBlock = { kind: "tool", index, key };
    events.push(
      anthropicEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id,
          name,
          input: {},
        },
      }),
    );
    return events;
  };

  return {
    start() {
      if (state.started) return [];
      state.started = true;
      return [
        anthropicEvent("message_start", {
          type: "message_start",
          message: {
            id: state.messageId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: state.usage.input_tokens,
              output_tokens: 0,
            },
          },
        }),
      ];
    },

    push(chunk) {
      events.length = 0;
      if (!chunk || typeof chunk !== "object") return events;

      if (chunk.usage && (chunk.usage.prompt_tokens || chunk.usage.completion_tokens || chunk.usage.total_tokens)) {
        state.sawUsage = true;
        if (Number.isFinite(Number(chunk.usage.prompt_tokens))) {
          state.usage.input_tokens = Number(chunk.usage.prompt_tokens);
        }
        if (Number.isFinite(Number(chunk.usage.completion_tokens))) {
          state.usage.output_tokens = Number(chunk.usage.completion_tokens);
        }
      }

      const choice = chunk.choices?.[0];
      if (!choice) return events;
      const delta = choice.delta ?? {};
      const finish = choice.finish_reason;

      if (typeof delta.content === "string" && delta.content) {
        openTextBlock();
        events.push(
          anthropicEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.openBlock.index,
            delta: { type: "text_delta", text: delta.content },
          }),
        );
      }

      const toolCalls = delta.tool_calls ?? [];
      for (const call of toolCalls) {
        const key = String(call?.id || call?.index || "0");
        if (!state.toolBlocks.has(key) && (call?.function?.name || call?.id || call?.index !== undefined)) {
          startToolBlock({ ...call, id: call?.id || key });
        }
        const entry = state.toolBlocks.get(key) ?? state.toolBlocks.values().next().value;
        if (!entry) continue;
        const args = call?.function?.arguments;
        if (typeof args === "string" && args) {
          entry.args += args;
          if (state.openBlock?.kind !== "tool" || state.openBlock.key !== key) {
            closeOpenBlock();
            state.openBlock = { kind: "tool", index: entry.index, key };
          }
          events.push(
            anthropicEvent("content_block_delta", {
              type: "content_block_delta",
              index: entry.index,
              delta: { type: "input_json_delta", partial_json: args },
            }),
          );
        }
      }

      if (finish) {
        if (finish === "tool_calls" || finish === "function_call") {
          state.stopReason = "tool_use";
        } else if (finish === "length") {
          state.stopReason = "max_tokens";
        } else if (finish === "content_filter") {
          state.stopReason = "refusal";
        } else if (finish === "stop_sequence") {
          state.stopReason = "stop_sequence";
        } else {
          state.stopReason = state.stopReason || "end_turn";
        }
      }

      return events;
    },

    end() {
      events.length = 0;
      closeOpenBlock();

      if (!state.sawUsage && options.estimateMissingUsage !== false) {
        const outputText = [...state.toolBlocks.values()]
          .map((entry) => entry.args)
          .join("");
        state.usage.output_tokens = estimateResponsesOutputTokens([
          { type: "output_text", text: outputText },
        ]) || state.usage.output_tokens;
      }

      if (!state.stopReason) {
        state.stopReason = state.toolBlocks.size ? "tool_use" : "end_turn";
      }

      events.push(
        anthropicEvent("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: state.stopReason,
            stop_sequence: null,
          },
          usage: {
            output_tokens: state.usage.output_tokens,
          },
        }),
      );
      events.push(anthropicEvent("message_stop", { type: "message_stop" }));
      return events;
    },

    fail(message, type = "api_error") {
      events.length = 0;
      return [
        anthropicEvent("error", {
          type: "error",
          error: { type, message: String(message ?? "stream failed") },
        }),
      ];
    },

    cancel() {
      events.length = 0;
      closeOpenBlock();
      events.push(
        anthropicEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: state.usage.output_tokens },
        }),
      );
      events.push(anthropicEvent("message_stop", { type: "message_stop" }));
      return events;
    },

    usageEstimated() {
      return !state.sawUsage;
    },

    currentMessage() {
      const content = [];
      if (state.textOpened) {
        // 流式过程未保留完整文本，仅在需要时由调用方从事件拼出。
        content.push({ type: "text", text: "" });
      }
      for (const entry of state.toolBlocks.values()) {
        content.push({
          type: "tool_use",
          id: entry.id,
          name: entry.name,
          input: parseToolInput(entry.args),
        });
      }
      return {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: state.stopReason || (state.toolBlocks.size ? "tool_use" : "end_turn"),
        stop_sequence: null,
        usage: { ...state.usage },
      };
    },
  };
}

/**
 * 把 Anthropic SSE 事件写成 `event: xxx\ndata: {...}\n\n`。
 */
export async function anthropicSseWrite(response, evt) {
  if (response.writableEnded) return;
  const payload =
    typeof evt === "string"
      ? evt
      : `event: ${evt.event}\ndata: ${evt.data}\n\n`;
  await new Promise((resolve, reject) => {
    response.write(payload, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * 极简 SSE 解析：与 responses.mjs 的 createSseParser 行为对齐，
 * 供 anthropic 流式测试与桥接复用。onEvent({event, data}).
 */
export function createAnthropicSseParser(onEvent) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const emit = (block) => {
    let eventName = "message";
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    if (data === "[DONE]") return;
    onEvent({ event: eventName, data });
  };

  return {
    push(chunk) {
      buffer += decoder.write(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      );
      let index;
      while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, index);
        const match = buffer.slice(index).match(/^\r?\n\r?\n/);
        buffer = buffer.slice(index + (match?.[0].length ?? 2));
        if (raw.trim()) emit(raw);
      }
    },
    end() {
      buffer += decoder.end();
      if (buffer.trim()) emit(buffer);
      buffer = "";
    },
  };
}

/**
 * 将 Chat SSE 文本片段喂给 Anthropic 转换器，返回完整事件数组（测试辅助）。
 */
export function collectAnthropicEventsFromChatChunks(translator, chunks) {
  const out = [...translator.start()];
  for (const chunk of chunks) out.push(...translator.push(chunk));
  out.push(...translator.end());
  return out;
}

export function anthropicErrorPayload(message, type = "invalid_request_error") {
  return { type: "error", error: { type, message: String(message ?? "error") } };
}

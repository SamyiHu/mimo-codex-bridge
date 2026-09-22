// token-estimate.mjs — 上游不返回 usage 时的本地 token 估算器。
//
// 本仓库不依赖第三方 npm 包，没有真 tokenizer 可用，这里用启发式：
// CJK 字符 ≈ 1 token/字，其余文本 ≈ 4 字符/token，再叠加消息模板的固定开销。
// 精度目标是数量级正确——让 Codex 显示非零 token 用量，而不是精确计费。
//
// 估算值在 /status 的 usage.estimated 里单独统计，不与上游真实 usage 混计；
// 用 MIMO_BRIDGE_TOKEN_ESTIMATE=off 可整体关闭。
const CJK_REGEX = /[\u1100-\u11FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g;

// 每条消息的对话模板开销（role 标记、分隔符等）的粗略常量。
const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTextTokens(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value !== "string") {
    if (typeof value === "number" || typeof value === "boolean") {
      value = String(value);
    } else {
      return 0;
    }
  }
  if (!value) return 0;
  const cjk = value.match(CJK_REGEX)?.length ?? 0;
  return cjk + Math.ceil((value.length - cjk) / 4);
}

// 覆盖 string 与多模态 parts 两种 content 形态；图片/音频无法估算，跳过。
function contentTokens(content) {
  if (content === null || content === undefined) return 0;
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") {
      tokens += estimateTextTokens(part);
      continue;
    }
    tokens += estimateTextTokens(part.text);
    tokens += estimateTextTokens(part.refusal);
  }
  return tokens;
}

function toolCallTokens(call) {
  if (!call || typeof call !== "object") return 0;
  return (
    estimateTextTokens(call.id) +
    estimateTextTokens(call.function?.name) +
    estimateTextTokens(call.function?.arguments) +
    estimateTextTokens(call.custom?.input)
  );
}

/** 按 Chat Completions 请求体估算输入 token（messages + tools + 模板开销）。 */
export function estimateChatRequestTokens(chatBody) {
  if (!chatBody || typeof chatBody !== "object") return 0;
  let tokens = 0;

  for (const message of chatBody.messages ?? []) {
    if (!message || typeof message !== "object") continue;
    tokens += MESSAGE_OVERHEAD_TOKENS;
    tokens += estimateTextTokens(message.role);
    tokens += estimateTextTokens(message.name);
    tokens += estimateTextTokens(message.tool_call_id);
    tokens += contentTokens(message.content);
    for (const call of message.tool_calls ?? []) {
      tokens += MESSAGE_OVERHEAD_TOKENS + toolCallTokens(call);
    }
  }

  for (const tool of chatBody.tools ?? []) {
    if (!tool || typeof tool !== "object") continue;
    const definition = tool.function ?? tool;
    tokens += MESSAGE_OVERHEAD_TOKENS;
    tokens += estimateTextTokens(definition?.name);
    tokens += estimateTextTokens(definition?.description);
    if (definition?.parameters && typeof definition.parameters === "object") {
      tokens += estimateTextTokens(JSON.stringify(definition.parameters));
    }
  }

  return tokens;
}

/** 按 Chat Completions 响应体（message 或流式 delta）估算输出 token。 */
export function estimateChatResponseTokens(chatPayload) {
  let tokens = 0;
  for (const choice of chatPayload?.choices ?? []) {
    const message = choice?.message ?? choice?.delta ?? {};
    tokens += contentTokens(message.content);
    tokens += estimateTextTokens(message.reasoning_content);
    tokens += estimateTextTokens(message.reasoning);
    tokens += estimateTextTokens(message.refusal);
    for (const call of message.tool_calls ?? []) {
      tokens += toolCallTokens(call);
    }
  }
  return tokens;
}

/** 按 Responses 输出项（message / reasoning / 工具调用）估算输出 token。 */
export function estimateResponsesOutputTokens(response) {
  let tokens = 0;
  for (const item of response?.output ?? []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        tokens += estimateTextTokens(part?.text);
        tokens += estimateTextTokens(part?.refusal);
      }
    } else if (item.type === "reasoning") {
      for (const part of item.summary ?? []) {
        tokens += estimateTextTokens(part?.text);
      }
    } else if (item.type === "function_call") {
      tokens += estimateTextTokens(item.name) + estimateTextTokens(item.arguments);
    } else if (item.type === "custom_tool_call") {
      tokens += estimateTextTokens(item.name) + estimateTextTokens(item.input);
    }
  }
  return tokens;
}

/** 上游真实返回过 usage 吗？全零或缺失都视为没有。 */
export function hasRealUsage(usage) {
  if (!usage || typeof usage !== "object") return false;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const total = Number(usage.total_tokens ?? 0);
  return input > 0 || output > 0 || total > 0;
}

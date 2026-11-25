#!/usr/bin/env node
/**
 * model-bridge doctor — 检查 Node、bridge、模型上游、Codex 配置和可选实时请求。
 * 不输出任何凭据内容。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const argOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const projectDir = import.meta.dirname;
const port = Number(argOf("--port", process.env.MIMO_BRIDGE_PORT || 8788));
const configPath = argOf(
  "--config",
  path.join(os.homedir(), ".codex", "config.toml"),
);
const upstreamKind = (
  argOf(
    "--upstream-kind",
    process.env.MIMO_BRIDGE_UPSTREAM_KIND || "mimo",
  ) || "mimo"
).toLowerCase();
const upstreamTokenFile = argOf(
  "--upstream-token-file",
  process.env.MIMO_BRIDGE_UPSTREAM_TOKEN_FILE ||
    process.env.WORKBUDDY_API_KEY_FILE ||
    path.join(
      projectDir,
      upstreamKind === "workbuddy"
        ? "workbuddy-api-key.txt"
        : upstreamKind === "trae"
          ? "trae-api-key.txt"
          : "token.txt",
    ),
);
const liveRequest = !hasFlag("--no-live-request");
const bridgeBase = `http://127.0.0.1:${port}`;
const bridgeSecretFile = path.join(projectDir, "bridge-secret.txt");
/**
 * 读凭据文件。读不到（不存在或权限不足）时返回 null 而不是抛栈：
 * doctor 的职责是报告问题，而不是自己先崩掉。
 */
function readCredential(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    console.error(
      "[doctor] 读不到 " + file + " (" + (error && error.code ? error.code : error) + ")：" +
        "如果你不是用创建它的那个 Windows 账户运行，就会被 ACL 拦住。",
    );
    return null;
  }
}

const upstreamToken = readCredential(
  upstreamTokenFile,
  process.env.WORKBUDDY_API_KEY ||
    process.env.MIMO_BRIDGE_UPSTREAM_API_KEY ||
    "",
);
const bridgeSecret = readCredential(bridgeSecretFile, upstreamToken);
const checks = [];

function check(name, ok, detail, required = true) {
  checks.push({ name, ok: Boolean(ok), detail, required });
}

async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function extractTomlString(text, name) {
  const match = text.match(
    new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m"),
  );
  return match?.[1] ?? "";
}

/**
 * 只在 [model_providers.<providerId>] 段内取值。
 * 配置文件里可能还有别的 provider（例如前面的 DeepSeek），
 * 用全局第一个匹配会取到它们的 base_url / token。
 */
function extractProviderString(text, providerId, name) {
  if (!providerId) return "";
  const lines = text.split(/\r?\n/);
  let inside = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]*)\]\s*$/.exec(line);
    if (header) {
      inside = header[1].trim() === `model_providers.${providerId}`;
      continue;
    }
    if (!inside) continue;
    const match = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`).exec(line);
    if (match) return match[1];
  }
  return "";
}

const major = Number(process.versions.node.split(".")[0]);
check(
  "node_version",
  major >= 18,
  `Node.js ${process.version}; required >= 18`,
);

let health = null;
try {
  const result = await fetchJson(`${bridgeBase}/health`);
  health = result.payload;
  check(
    "bridge_health",
    result.response.ok && health?.ok === true,
    health
      ? `engine=${health.engine || "not found"} authMode=${health.authMode || "unknown"}`
      : `HTTP ${result.response.status}`,
  );
} catch (error) {
  check("bridge_health", false, error.message);
}

let status = null;
if (bridgeSecret) {
  try {
    const result = await fetchJson(`${bridgeBase}/status`, {
      headers: { Authorization: `Bearer ${bridgeSecret}` },
    });
    status = result.payload;
    check(
      "bridge_status_auth",
      result.response.ok && status?.authMode === "bridge_secret",
      status
        ? `pid=${status.pid} version=${status.version} authMode=${status.authMode}`
        : `HTTP ${result.response.status}`,
    );
  } catch (error) {
    check("bridge_status_auth", false, error.message);
  }
} else {
  check("bridge_status_auth", false, "bridge-secret.txt not found");
}

// ── 多上游注册表（可选）：没有 upstreams.json 就是单上游模式，不算失败 ──
const registryPath =
  process.env.MIMO_BRIDGE_UPSTREAMS || path.join(projectDir, "upstreams.json");
if (!fs.existsSync(registryPath)) {
  check(
    "upstream_registry",
    true,
    "未启用（可选）：没有 upstreams.json，按单上游模式运行",
    false,
  );
} else {
  try {
    const { parseRegistry } = await import("./upstream-registry.mjs");
    const parsed = parseRegistry(JSON.parse(fs.readFileSync(registryPath, "utf8")));
    const missingTokens = [...parsed.upstreams.values()]
      .filter((upstream) => !fs.existsSync(path.join(projectDir, upstream.tokenFile)))
      .map((upstream) => upstream.id);
    const problems = [...parsed.errors];
    if (missingTokens.length) problems.push("缺 token 文件：" + missingTokens.join("、"));
    check(
      "upstream_registry",
      problems.length === 0,
      problems.length
        ? problems.join("；")
        : parsed.upstreams.size + " 家上游 / " + parsed.groups.size + " 个路由组",
      false,
    );
  } catch (error) {
    check("upstream_registry", false, "读 upstreams.json 失败：" + error.message, false);
  }
}

// ── Qoder 边车（可选）：注册表里配了 qoder 才检查 ──
async function checkQoderSidecar() {
  let base = "";
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    const entry = (raw.upstreams || []).find((u) => u && u.id === "qoder");
    if (entry && entry.base) base = String(entry.base);
  } catch { /* 注册表读不到就不查 */ }
  if (!base) {
    check("qoder_sidecar", true, "未配置 qoder 上游（可选）", false);
    return;
  }
  try {
    const health = await fetch(base.replace(/\/+$/, "") + "/healthz", {
      signal: AbortSignal.timeout(5000),
    });
    if (!health.ok) {
      check("qoder_sidecar", false, base + " 有响应但 /healthz 是 HTTP " + health.status, false);
      return;
    }
    const info = await health.json();
    const accounts = Number(info.accounts) || 0;
    const models = Number(info.models) || 0;
    const problems = [];
    if (!accounts) problems.push("没有已登录账号（面板「Qoder 账号」里授权）");
    if (!models) problems.push("模型目录是空的（GET /v1/catalog/refresh 刷一次）");
    check(
      "qoder_sidecar",
      problems.length === 0,
      problems.length ? problems.join("；") : base + " 账号 " + accounts + " 个 / 模型 " + models + " 个（目录来源 " + (info.catalog || "?") + "）",
      false,
    );
  } catch (error) {
    check(
      "qoder_sidecar",
      false,
      "连不上 " + base + "（" + error.message + "）；用 mimo qoder 启动边车",
      false,
    );
  }
}
await checkQoderSidecar();

const quotaPath = path.join(projectDir, "quota.json");
check(
  "quota_ledger",
  fs.existsSync(quotaPath),
  fs.existsSync(quotaPath)
    ? "有 quota.json：额度账本会读它（60 秒 TTL）"
    : "没有 quota.json：额度一律视为未知，不影响可用性",
  false,
);

let availableModels = [];
if (status?.engine && upstreamToken) {
  try {
    const modelsUrl =
      `${status.engine}/v1/models` +
      `?directory=${encodeURIComponent(status.instanceDir)}`;
    const result = await fetchJson(modelsUrl, {
      headers: { Authorization: `Bearer ${upstreamToken}` },
    });
    const models = Array.isArray(result.payload?.data)
      ? result.payload.data.map((model) => String(model?.id || ""))
      : [];
    availableModels = models;
    const expectedModel =
      upstreamKind === "workbuddy"
        ? models.some((model) => model.includes(":"))
        : upstreamKind === "trae"
          ? models.length > 0
          : models.some((model) => model.startsWith("mimo-desktop/"));
    check(
      "mimo_engine_models",
      result.response.ok && expectedModel,
      result.response.ok
        ? `${models.length} model(s); upstream=${upstreamKind}; expected model namespace detected=${expectedModel}`
        : `HTTP ${result.response.status}`,
    );
  } catch (error) {
    check("mimo_engine_models", false, error.message);
  }
} else {
  check(
    "mimo_engine_models",
    false,
    "engine URL or MiMo token unavailable",
  );
}

let configModel = "mimo-desktop/mimo-v2.6-pro";
if (fs.existsSync(configPath)) {
  const config = fs.readFileSync(configPath, "utf8");
  const provider = extractTomlString(config, "model_provider");
  const baseUrl = extractProviderString(config, provider, "base_url");
  const wireApi = extractProviderString(config, provider, "wire_api");
  const configuredSecret = extractProviderString(
    config,
    provider,
    "experimental_bearer_token",
  );
  configModel =
    extractTomlString(config, "model") || configModel;
  const secretMatches =
    bridgeSecret && configuredSecret === bridgeSecret;
  check(
    "codex_config",
    (provider === "mimo" || provider === "workbuddy" || provider === "trae") &&
      baseUrl === `${bridgeBase}/v1` &&
      wireApi === "responses" &&
      secretMatches,
    `provider=${provider || "missing"} base_url=${baseUrl || "missing"} wire_api=${wireApi || "missing"} bridge_secret_matches=${secretMatches}`,
  );
} else {
  check("codex_config", false, `config not found: ${configPath}`);
}

if (status?.pid) {
  try {
    process.kill(status.pid, 0);
    check("bridge_process", true, `PID ${status.pid} is running`);
  } catch {
    check("bridge_process", false, `PID ${status.pid} is not accessible`);
  }
}

if (liveRequest && status?.ok && bridgeSecret) {
  try {
    const result = await fetchJson(
      `${bridgeBase}/v1/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridgeSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model:
            upstreamKind === "workbuddy"
              ? availableModels.find((model) => model.includes(":")) ||
                availableModels[0] ||
                configModel
              : upstreamKind === "trae"
                ? availableModels[0] || configModel
                : configModel,
          input: "Reply with OK only.",
          stream: false,
        }),
      },
      60000,
    );
    const outputText = (result.payload?.output ?? [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .map((part) => part.text ?? "")
      .join("");
    check(
      "live_model_request",
      result.response.ok && outputText.trim().length > 0,
      result.response.ok
        ? `model=${result.payload?.model || "unknown"} output_length=${outputText.trim().length}`
        : result.payload?.error?.message || `HTTP ${result.response.status}`,
    );
  } catch (error) {
    check("live_model_request", false, error.message);
  }
} else if (liveRequest) {
  check("live_model_request", false, "bridge status unavailable");
}

const failedRequired = checks.filter(
  (item) => item.required && !item.ok,
);
const result = {
  ok: failedRequired.length === 0,
  checked_at: new Date().toISOString(),
  bridge: bridgeBase,
  config: configPath,
  live_request: liveRequest,
  checks,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

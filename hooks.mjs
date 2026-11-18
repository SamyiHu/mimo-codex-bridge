/**
 * hooks.mjs — 请求钩子（最小版，参考 magpie 的 gateway middleware，但不做 Bun 运行时）
 *
 * 只保留一个点：beforeRequest(ctx)。约定：
 *   - 文件放在 hooks/before-request.mjs，默认导出一个函数（可 async）
 *   - ctx = { requestId, path, model, body, upstreamId }
 *   - 返回 undefined 表示不改；返回对象则浅合并进 body（只允许改这些字段）
 *   - 抛异常、超时（默认 200ms）、文件坏了 —— 一律只记日志，绝不影响请求
 */

const DEFAULT_TIMEOUT_MS = 200;

export function createHooks(options = {}) {
  const dir = options.dir || "";
  const warn = options.warn || (() => {});
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const statSync = options.statSync || null;
  const pathJoin = options.pathJoin || ((a, b) => a + "/" + b);
  const importModule = options.importModule || ((url) => import(url));

  const file = dir ? pathJoin(dir, "hooks/before-request.mjs") : null;
  let loadedMtime = -1;
  let handler = null;
  let broken = false;

  function mtime() {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }

  async function load() {
    if (!file) return null;
    const m = mtime();
    if (m === 0) {
      handler = null;
      loadedMtime = 0;
      return null;
    }
    if (m === loadedMtime && !broken) return handler;
    try {
      const mod = await importModule("file://" + file.replace(/\\/g, "/") + "?v=" + Math.round(m));
      const fn = typeof mod.default === "function" ? mod.default : typeof mod.beforeRequest === "function" ? mod.beforeRequest : null;
      if (!fn) {
        broken = true;
        warn("hooks/before-request.mjs 没有导出函数，已忽略");
        return null;
      }
      handler = fn;
      broken = false;
      loadedMtime = m;
      warn("已加载 hooks/before-request.mjs");
      return handler;
    } catch (error) {
      broken = true;
      warn("加载 hooks/before-request.mjs 失败：" + String(error && error.message ? error.message : error));
      return null;
    }
  }

  const ALLOWED = new Set(["model", "temperature", "top_p", "max_tokens", "max_completion_tokens", "messages", "prompt_cache_key", "reasoning_effort", "stream"]);

  /**
   * @returns {Promise<Object|null>} 允许合并进 chatBody 的补丁（没钩子/超时/出错都返回 null）
   */
  async function beforeRequest(ctx) {
    const fn = await load();
    if (!fn) return null;
    let timer = null;
    try {
      const result = await Promise.race([
        Promise.resolve(fn(ctx)),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(Symbol.for("hook_timeout")), timeoutMs);
        }),
      ]);
      if (result === Symbol.for("hook_timeout")) {
        warn("hooks/before-request.mjs 超时（" + timeoutMs + "ms），已跳过");
        return null;
      }
      if (!result || typeof result !== "object") return null;
      const patch = {};
      for (const [k, v] of Object.entries(result)) if (ALLOWED.has(k)) patch[k] = v;
      return patch;
    } catch (error) {
      warn("hooks/before-request.mjs 抛错，已跳过：" + String(error && error.message ? error.message : error));
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { beforeRequest, get file() { return file; } };
}

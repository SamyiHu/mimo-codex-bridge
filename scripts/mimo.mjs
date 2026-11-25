#!/usr/bin/env node
/**
 * scripts/mimo.mjs — MiMo 桥唯一入口（根目录 mimo.cmd 调用）。
 *
 * 为什么用 Node 而不是 PowerShell：卡巴斯基的 PDM 行为启发式会把"PowerShell 脚本
 * 拉起隐藏子进程 / 结束进程"判成 PDM:Trojan.Win32.Generic 并直接隔离脚本文件。
 * 这里改成 Node 实现，只做 HTTP 检查 + spawn，行为面小得多；桥本身仍是 Node。
 *
 * 用法：
 *   mimo                 # 交互菜单
 *   mimo start           # 启动 bridge + 面板并开浏览器
 *   mimo trae|workbuddy  # 指定上游启动
 *   mimo stop / restart / status / logs / doctor / panel
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);

const opt = { port: 8788, panelPort: 8791, qoderPort: 7865, upstream: "workbuddy", chatMode: "raw", lines: 40, noBrowser: false };
let command = "";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === "--port") opt.port = Number(next());
  else if (a === "--panel-port") opt.panelPort = Number(next());
  else if (a === "--qoder-port") opt.qoderPort = Number(next());
  else if (a === "--upstream") opt.upstream = next();
  else if (a === "--chat-mode") opt.chatMode = next();
  else if (a === "--lines") opt.lines = Number(next());
  else if (a === "-NoBrowser" || a === "--no-browser") opt.noBrowser = true;
  else if (!command) command = a.toLowerCase();
}

const UPSTREAM_URLS = { workbuddy: "http://127.0.0.1:7863", trae: "http://127.0.0.1:7864" };
if (command === "trae" || command === "workbuddy") { opt.upstream = command; command = "start"; }
if (!command) command = "menu";
const upstreamUrl = UPSTREAM_URLS[opt.upstream] || "";

const paths = {
  startScript: path.join(ROOT, "start-bridge.ps1"),
  stopScript: path.join(ROOT, "stop-bridge.ps1"),
  doctor: path.join(ROOT, "doctor.mjs"),
  panelLog: path.join(ROOT, "panel-console.log"),
  panelErr: path.join(ROOT, "panel-console.err.log"),
  panelPid: path.join(ROOT, "panel.pid"),
  runtimeLog: path.join(ROOT, "bridge-runtime.log"),
  secret: path.join(ROOT, "bridge-secret.txt"),
  qoderEntry: path.join(ROOT, "qoder-bridge.mjs"),
  qoderToken: path.join(ROOT, "qoder-api-key.txt"),
  qoderLog: path.join(ROOT, "qoder-bridge.log"),
  qoderPid: path.join(ROOT, "qoder.pid"),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive(url, timeoutMs = 2500) {
  try {
    const ctrl = AbortSignal.timeout(timeoutMs);
    const res = await fetch(url, { signal: ctrl });
    return res.status >= 200 && res.status < 500;
  } catch { return false; }
}

const bridgeUp = () => alive("http://127.0.0.1:" + opt.port + "/health");
const panelUp = () => alive("http://127.0.0.1:" + opt.panelPort + "/");
const gatewayUp = () => alive("http://127.0.0.1:7863/healthz");
const qoderUp = () => alive("http://127.0.0.1:" + opt.qoderPort + "/healthz");

/** 边车的 /healthz 详情（账号数 / 模型数）；连不上返回 null */
async function qoderInfo() {
  try {
    const res = await fetch("http://127.0.0.1:" + opt.qoderPort + "/healthz", { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function runPowerShell(script, args) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
    cwd: ROOT, stdio: "inherit", windowsHide: true,
  });
  return r.status ?? 1;
}

function readPid() {
  try {
    const n = Number.parseInt(fs.readFileSync(paths.panelPid, "utf8").trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function startBridge() {
  const args = ["-Port", String(opt.port), "-Upstream", opt.upstream];
  if (upstreamUrl) args.push("-UpstreamUrl", upstreamUrl);
  if (opt.chatMode) args.push("-ChatMode", opt.chatMode);
  const code = runPowerShell(paths.startScript, args);
  if (code !== 0) console.log("[warn] start-bridge.ps1 退出码 " + code);
}

async function startPanel() {
  if (await panelUp()) { console.log("面板已在运行：http://127.0.0.1:" + opt.panelPort); return; }
  const out = fs.openSync(paths.panelLog, "a");
  const err = fs.openSync(paths.panelErr, "a");
  const child = spawn(process.execPath, ["panel.mjs"], {
    cwd: ROOT, detached: true, windowsHide: true, stdio: ["ignore", out, err],
  });
  child.unref();
  fs.writeFileSync(paths.panelPid, String(child.pid), "ascii");
  for (let i = 0; i < 40; i++) { await sleep(300); if (await panelUp()) break; }
  if (await panelUp()) console.log("面板已启动：http://127.0.0.1:" + opt.panelPort + "（PID " + child.pid + "）");
  else console.log("[warn] 面板没起来，看 " + paths.panelErr);
}

async function stopPanel() {
  const pid = readPid();
  if (!pid) { console.log("面板未在运行（没有 panel.pid）。"); return; }
  if (!pidAlive(pid)) { try { fs.unlinkSync(paths.panelPid); } catch {} console.log("面板进程已不在。"); return; }
  try { process.kill(pid); console.log("已停止面板 PID：" + pid); } catch (e) { console.log("[warn] 停止面板失败：" + e.message); }
  try { fs.unlinkSync(paths.panelPid); } catch {}
}

function stopBridge() {
  runPowerShell(paths.stopScript, ["-Port", String(opt.port)]);
}

// ── Qoder 边车（qoder-bridge.mjs，默认 :7865）──────────────────────────────
// 没有它，upstreams.json 里的 qoder 上游就是个连不上的地址，面板里一条 qoder 模型都没有。
async function startQoder() {
  if (await qoderUp()) {
    console.log("Qoder 边车已在运行：http://127.0.0.1:" + opt.qoderPort);
    return;
  }
  if (!fs.existsSync(paths.qoderEntry)) {
    console.log("[warn] 找不到 qoder-bridge.mjs，跳过 Qoder 边车。");
    return;
  }
  // upstreams.json 的注册表要求 tokenFile 字段非空，但边车本身不验鉴权。
  // 这里补个空的占位文件，免得 doctor 报"缺 token 文件：qoder"。
  if (!fs.existsSync(paths.qoderToken)) {
    try { fs.writeFileSync(paths.qoderToken, "", "utf8"); } catch {}
  }
  const out = fs.openSync(paths.qoderLog, "a");
  const child = spawn(process.execPath, [paths.qoderEntry], {
    cwd: ROOT, detached: true, windowsHide: true, stdio: ["ignore", out, out],
    env: { ...process.env, QODER_BRIDGE_PORT: String(opt.qoderPort) },
  });
  child.unref();
  fs.writeFileSync(paths.qoderPid, String(child.pid), "ascii");
  for (let i = 0; i < 30; i++) { await sleep(200); if (await qoderUp()) break; }
  const info = await qoderInfo();
  if (info) {
    console.log("Qoder 边车已启动：http://127.0.0.1:" + opt.qoderPort + "（PID " + child.pid + "，账号 " + info.accounts + " 个，模型 " + info.models + " 个）");
  } else {
    console.log("[warn] Qoder 边车没起来，看 " + paths.qoderLog);
  }
}

async function stopQoder() {
  // pid 文件可能过期，但端口还活着（比如手动 node 起的），所以两个线索都用。
  let pid = 0;
  try { pid = Number.parseInt(fs.readFileSync(paths.qoderPid, "utf8").trim(), 10) || 0; } catch {}
  if (!pid || !pidAlive(pid)) {
    try { fs.unlinkSync(paths.qoderPid); } catch {}
    if (!(await qoderUp())) { console.log("Qoder 边车未在运行。"); return; }
    console.log("[warn] Qoder 边车在 :" + opt.qoderPort + " 上有响应，但不是本入口起的（没有 qoder.pid），不替你杀，请手动关闭。");
    return;
  }
  try { process.kill(pid); console.log("已停止 Qoder 边车 PID：" + pid); } catch (e) { console.log("[warn] 停止 Qoder 边车失败：" + e.message); }
  try { fs.unlinkSync(paths.qoderPid); } catch {}
}

function openPanel() {
  if (opt.noBrowser) return;
  spawn("cmd.exe", ["/c", "start", "", "http://127.0.0.1:" + opt.panelPort], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

async function showStatus() {
  const [b, p, g, q] = await Promise.all([bridgeUp(), panelUp(), gatewayUp(), qoderUp()]);
  console.log("");
  console.log("MiMo 桥状态");
  console.log("  bridge : " + (b ? "运行中  http://127.0.0.1:" + opt.port + "/v1" : "未运行"));
  console.log("  面板   : " + (p ? "运行中  http://127.0.0.1:" + opt.panelPort : "未运行"));
  console.log("  网关   : " + (g ? "运行中  http://127.0.0.1:7863" : "未运行（workbuddy2api）"));
  if (q) {
    const info = await qoderInfo();
    console.log("  Qoder  : 运行中  http://127.0.0.1:" + opt.qoderPort +
      (info ? "（账号 " + info.accounts + " 个，模型 " + info.models + " 个）" : ""));
  } else {
    console.log("  Qoder  : 未运行（qoder-bridge.mjs）");
  }
  if (b) {
    try {
      let secret = "";
      try { secret = fs.readFileSync(paths.secret, "utf8").trim(); } catch {}
      const res = await fetch("http://127.0.0.1:" + opt.port + "/status", { headers: { authorization: "Bearer " + secret } });
      const st = await res.json();
      const pool = st.limits.account_pool;
      console.log("  并发   : " + st.limits.max_concurrent_requests + "（" + pool.per_account + " × " + pool.multiplier + " 账号；healthy=" + pool.healthy + "/" + pool.total + "）");
      console.log("  上游   : " + st.upstreamKind + " / " + st.chatMode);
    } catch { console.log("  并发   : （读 /status 失败，检查 bridge-secret.txt）"); }
  }
  console.log("");
}

function showLogs() {
  for (const [label, file] of [["bridge-runtime.log", paths.runtimeLog], ["panel-console.log", paths.panelLog]]) {
    try {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
      console.log("--- " + label + "（尾部）---");
      console.log(lines.slice(-opt.lines).join("\n"));
    } catch {}
  }
}

async function startAll() {
  await startBridge();
  await startQoder();
  await startPanel();
  await showStatus();
  openPanel();
}

// 菜单输入：stdin 关闭（双击窗口被关掉、管道断开、EOF）时必须当成"退出"，
// 不能让 question() 的 Promise 永远挂起——顶层 await 挂起会让 Node 以 exit 13 结束，
// 再叠上 Windows 控制台句柄已关，就是"双击闪退"。
async function menu() {
  if (!process.stdin.isTTY && process.stdin.readableEnded) {
    console.log("没有可用的控制台输入，直接退出。用 mimo start / status / stop 这样的命令式参数。");
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let stdinClosed = false;
  rl.on("close", () => { stdinClosed = true; });
  const ask = (q) => new Promise((res) => {
    if (stdinClosed) { res(""); return; }
    let done = false;
    const finish = (v) => { if (done) return; done = true; rl.off("close", onClose); res(v); };
    const onClose = () => finish("");
    rl.once("close", onClose);
    try {
      rl.question(q, (answer) => finish(answer));
    } catch {
      finish("");
    }
  });
  try {
    for (;;) {
      console.log("\n==== MiMo 桥 ====");
      await showStatus();
      console.log("1) 启动    2) 重启    3) 停止");
      console.log("4) 状态    5) 日志    6) 自检 doctor");
      console.log("0) 退出");
      const k = (await ask("选择 ")).trim();
      if (k === "0" || k === "") return;
      if (k === "1") await startAll();
      else if (k === "2") { await stopPanel(); stopBridge(); await stopQoder(); await sleep(500); await startAll(); }
      else if (k === "3") { await stopPanel(); stopBridge(); await stopQoder(); await showStatus(); }
      else if (k === "4") await showStatus();
      else if (k === "5") showLogs();
      else if (k === "6") runPowerShell(paths.doctor, ["--port", String(opt.port), "--upstream-kind", opt.upstream]);
      else console.log("无效输入");
    }
  } finally { rl.close(); }
}

switch (command) {
  case "menu": await menu(); break;
  case "start": await startAll(); break;
  case "panel": await startPanel(); openPanel(); break;
  case "stop": await stopPanel(); stopBridge(); await stopQoder(); await showStatus(); break;
  case "restart": await stopPanel(); stopBridge(); await stopQoder(); await sleep(500); await startAll(); break;
  case "qoder": await startQoder(); await showStatus(); break;
  case "qoder-stop": await stopQoder(); await showStatus(); break;
  case "status": await showStatus(); break;
  case "logs": showLogs(); break;
  case "doctor": runPowerShell(paths.doctor, ["--port", String(opt.port), "--upstream-kind", opt.upstream]); break;
  default:
    console.log("未知命令：" + command);
    console.log("可用：start | stop | restart | status | panel | logs | doctor");
    process.exitCode = 1;
}

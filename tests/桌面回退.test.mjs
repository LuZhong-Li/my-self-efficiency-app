/* 桌面外壳（pywebview / pythonw）的回归测试。
 *
 * 这一份盯三件事：
 *   ① 桌面模式「要不要开」的判断：--desktop / XIAOLI_DESKTOP 认不认、
 *      带 --no-browser 时一律不开（那是「一个界面都别开」的开关）、
 *      pywebview 用不了的时候必须**回退**（desktop_mode() 为假），不能拦死入口；
 *   ② pythonw（无控制台）跑服务时，print 没丢：落到 数据\日志\console.log 里，
 *      而且服务照常能连（这正是「双击不弹黑窗口」那条链路的底座）；
 *   ③ 服务在 --no-browser 下一路照旧：无头 Edge 打得开、页面出得来、11 个模块
 *      都在侧栏里、全程没有 JS 报错（桌面化不许碰坏既有行为）。
 *
 * 为什么 pywebview 那个**原生窗口**不在这里测：
 *   它不在浏览器里，CDP 摸不到（没有可连的调试端口、也不是个页面）。
 *   所以那部分靠两条兜底：桌面模式失效时自动回退（这条测试盯着），
 *   以及交付前的人工验收（双击看到窗口、关窗进程退出、端口释放）。
 *
 * 跑法：node tests\桌面回退.test.mjs
 *   要 Node 22+（内置 fetch / WebSocket 直接说 CDP，不装 puppeteer）；
 *   要本机有 Edge（找不到会退回 Chrome，也可以用 EDGE_PATH 指一个）。
 *   全程在一个临时数据目录里跑，不碰 数据\数据.json，跑完自己清干净。
 * 说明：和别的 .test.mjs 一样不进「自检.cmd」——自检保持纯 Python。
 *      这台机器上没有浏览器 / Python 时打印「跳过」并以 0 退出，
 *      免得换台电脑一跑就红（跳过不等于通过，别把它当成绿灯）。
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "app", "服务.py");

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  if (actual === expected) {
    pass += 1;
    console.log("  ok   " + label);
  } else {
    fail += 1;
    console.log(
      "  FAIL " + label + "：期望 " + JSON.stringify(expected) +
        "，实际 " + JSON.stringify(actual)
    );
  }
}

function ok(cond, label) {
  eq(Boolean(cond), true, label);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stopTree(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill();
    }
  } catch {
    /* 关不掉就算了，删目录那步还有重试 */
  }
}

function firstExisting(list) {
  for (const p of list) if (p && fs.existsSync(p)) return p;
  return "";
}

function findBrowser() {
  if (process.env.EDGE_PATH) return firstExisting([process.env.EDGE_PATH]);
  const local = process.env.LOCALAPPDATA || "";
  return firstExisting([
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    path.join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
  ]);
}

function findPython() {
  const cands = [];
  if (process.env.XIAOLI_PYTHON) cands.push(process.env.XIAOLI_PYTHON);
  const bases = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python"),
    "C:\\Program Files",
  ];
  for (const base of bases) {
    try {
      for (const name of fs.readdirSync(base)) {
        if (/^Python\d/i.test(name)) cands.push(path.join(base, name, "python.exe"));
      }
    } catch {
      /* 这个目录不存在就算了 */
    }
  }
  const found = spawnSync("where.exe", ["python.exe"], { encoding: "utf8" });
  if (found.status === 0) {
    for (const line of String(found.stdout || "").split(/\r?\n/)) {
      if (line.trim()) cands.push(line.trim());
    }
  }
  cands.push("D:\\msys64\\ucrt64\\bin\\python.exe");
  for (const p of cands) {
    if (!p || !fs.existsSync(p)) continue;
    const r = spawnSync(p, ["-c", "import http.server, json, mimetypes, urllib.request"], {
      stdio: "ignore",
    });
    if (r.status === 0) return p;
  }
  return "";
}

/** pythonw.exe 就跟 python.exe 一个目录（这就是 启动.cmd 找它的办法） */
function pythonwOf(python) {
  const cand = path.join(path.dirname(python), "pythonw.exe");
  return fs.existsSync(cand) ? cand : "";
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 谁占着这个端口 —— 用来收拾 cmd start 甩出去、我们拿不到句柄的那个进程 */
function pidOnPort(port) {
  const r = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    if (line.includes(":" + port) && /LISTENING/i.test(line)) {
      const n = Number(line.trim().split(/\s+/).pop());
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return 0;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.pageErrors = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
        return;
      }
      if (m.method === "Runtime.exceptionThrown") {
        const d = (m.params && m.params.exceptionDetails) || {};
        this.pageErrors.push(
          "未捕获异常：" + ((d.exception && d.exception.description) || d.text || "?")
        );
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        this.pageErrors.push("console.error：" + JSON.stringify(m.params.args));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

let cdp = null;

async function ev(expr) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(
      "页面里的表达式报错了：" + ((d.exception && d.exception.description) || d.text || "?")
    );
  }
  return r.result.value;
}

async function waitFor(expr, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = Boolean(await ev(expr));
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

/** 等临时服务起来；起来了返回 true */
async function waitUp(base, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(base + "api/health");
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

/* ------------------------------------------------------------------ */
/* ① 桌面模式「要不要开」的判断（纯逻辑，一个 Python 子进程问一遍）      */
/* ------------------------------------------------------------------ */

const PROBE = `
import importlib.util, json, os, sys

server = sys.argv[1]
mode = sys.argv[2]

if mode == "env":
    os.environ["XIAOLI_DESKTOP"] = "1"
elif mode == "blocked":
    # 假装这台机器上没装 pywebview：import 它就直接 ImportError。
    class Block:
        def find_spec(self, name, path=None, target=None):
            if name == "webview":
                raise ImportError("测试里故意挡住 pywebview")
            return None
    sys.meta_path.insert(0, Block())

spec = importlib.util.spec_from_file_location("xiaoli_server", server)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def asked(*argv):
    sys.argv = ["服务.py"] + list(argv)
    return m.desktop_requested()

out = {
    "available": m.desktop_available(),
    "none": asked(),
    "desktop": asked("--desktop"),
    "desktopNoBrowser": asked("--desktop", "--no-browser"),
    "noBrowser": asked("--no-browser"),
    "env": None,
}

sys.argv = ["服务.py", "--desktop"]
out["requested"] = m.desktop_requested()
out["mode"] = m.desktop_mode()
print(json.dumps(out))
`;

function probe(python, scriptPath, mode, dataDir) {
  const r = spawnSync(python, [scriptPath, SERVER, mode], {
    encoding: "utf8",
    env: { ...process.env, XIAOLI_DATA_DIR: dataDir, PYTHONIOENCODING: "utf-8" },
  });
  const line = String(r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
  try {
    return JSON.parse(line);
  } catch {
    return { parseFailed: true, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
  }
}

function checkDesktopLogic(python, tmp, dataDir) {
  const scriptPath = path.join(tmp, "桌面探针.py");
  fs.writeFileSync(scriptPath, PROBE, "utf8");

  console.log("\n桌面模式「要不要开」的判断");
  const plain = probe(python, scriptPath, "plain", dataDir);
  ok(!plain.parseFailed, "探针跑得起来");
  if (plain.parseFailed) {
    console.log("      它这么说：" + (plain.stderr || plain.stdout || "").trim().slice(0, 400));
    return;
  }

  eq(typeof plain.available, "boolean", "desktop_available() 给的是个真假值");
  eq(plain.none, false, "什么都不带 → 不开桌面窗口（老样子）");
  eq(plain.desktop, true, "--desktop → 要开桌面窗口");
  eq(plain.noBrowser, false, "--no-browser → 不开（测试 / 无头调试一界面都不开）");
  eq(plain.desktopNoBrowser, false, "--desktop 和 --no-browser 一起给 → --no-browser 说了算");
  eq(plain.requested, true, "要开的时候 desktop_requested() 是真好");
  eq(plain.mode, plain.requested && plain.available,
    "desktop_mode() = 要开 且 有 pywebview（这台机器上 pywebview " +
      (plain.available ? "可用" : "没装") + "）");

  console.log("\n环境变量 XIAOLI_DESKTOP=1 也认（给不想改快捷方式的人留的口子）");
  const envMode = probe(python, scriptPath, "env", dataDir);
  eq(envMode.none, true, "设了 XIAOLI_DESKTOP=1，什么都不带也开桌面窗口");

  console.log("\npywebview 用不了的时候：必须回退，不能拦死入口（需求 D-3）");
  const blocked = probe(python, scriptPath, "blocked", dataDir);
  ok(!blocked.parseFailed, "挡住 pywebview 之后探针照样跑完（没崩）");
  if (blocked.parseFailed) return;
  eq(blocked.available, false, "import webview 失败 → desktop_available() 为假");
  eq(blocked.requested, true, "用户那边该开的还是「要开」（是依赖没了，不是他改主意了）");
  eq(blocked.mode, false, "desktop_mode() 为假 —— 服务照跑，界面退回浏览器");
}

/* ------------------------------------------------------------------ */
/* ② pythonw（无控制台）跑服务：日志重定向 + 服务照常可用              */
/* ------------------------------------------------------------------ */

async function checkPythonw(pythonw, tmp, dataDir) {
  console.log("\npythonw（没有控制台）跑服务：print 收进日志、服务照常能连");
  const port = await freePort();
  // 起法要跟双击那条路一模一样：走 cmd 的 start，父进程甩手就走。
  // 这样 pythonw 才是真·没有控制台（sys.stdout 是 None），日志重定向那句
  // 判断才会走到。要是我们自己 spawn 它，它会从我们这儿继承一根能用的
  // 输出管，Python 就认为「有 stdout」，测的就不是真身了。
  const launcher = spawn(
    "cmd.exe",
    ["/c", "start", "", pythonw, SERVER, "--port", String(port), "--no-browser"],
    {
      env: { ...process.env, XIAOLI_DATA_DIR: dataDir, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
      stdio: "ignore",
    }
  );
  try {
    const base = "http://127.0.0.1:" + port + "/";
    ok(await waitUp(base), "无控制台起来的服务连得上（--no-browser 照旧）");
    const log = path.join(dataDir, "日志", "console.log");
    let text = "";
    for (let i = 0; i < 40 && !text; i += 1) {
      if (fs.existsSync(log)) text = fs.readFileSync(log, "utf8");
      if (!text) await sleep(250);
    }
    ok(text.length > 0, "print 的输出落在 数据\\日志\\console.log 里（没石沉大海）");
    ok(text.includes("小李"), "日志里有启动横幅（认得出来是谁）");
    ok(text.includes("界面地址：http://127.0.0.1:" + port + "/"),
      "日志里写着这一趟真实用的端口（事后能对上号）");
    if (!text) console.log("      （" + path.join(dataDir, "日志") + " 里没有 console.log）");
  } finally {
    const running = pidOnPort(port);      // cmd start 甩出去的，句柄不在我们手上
    if (running) {
      spawnSync("taskkill", ["/pid", String(running), "/T", "/F"], { stdio: "ignore" });
    }
    stopTree(launcher);
    await sleep(400);
  }
}

/* ------------------------------------------------------------------ */
/* ③ --no-browser：服务照旧，无头 Edge 打得开（桌面化不许碰坏既有行为） */
/* ------------------------------------------------------------------ */

async function checkNoBrowser(browser, python, tmp, dataDir) {
  console.log("\n--no-browser 那个端口：无头浏览器打得开、11 个模块都在");
  const port = await freePort();
  const server = spawn(python, [SERVER, "--port", String(port), "--no-browser", "--desktop"], {
    env: { ...process.env, XIAOLI_DATA_DIR: dataDir, PYTHONIOENCODING: "utf-8" },
    windowsHide: true,
  });
  let edge = null;
  try {
    const base = "http://127.0.0.1:" + port + "/";
    if (!(await waitUp(base))) {
      ok(false, "临时服务起得来");
      return;
    }
    // 带上 --desktop 也照旧：--no-browser 说了「一个界面都不开」，
    // 所以这条不会真去开窗口（上面那组纯逻辑断言盯的就是这个判断）

    const debugPort = await freePort();
    const profile = path.join(tmp, "浏览器-" + port);
    fs.mkdirSync(profile, { recursive: true });
    edge = spawn(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--window-size=1280,900",
        "--user-data-dir=" + profile,
        "--remote-debugging-port=" + debugPort,
        "about:blank",
      ],
      { windowsHide: true, stdio: "ignore" }
    );

    let target = null;
    for (let i = 0; i < 80 && !target; i += 1) {
      try {
        const list = await (await fetch("http://127.0.0.1:" + debugPort + "/json/list")).json();
        target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || null;
      } catch {
        target = null;
      }
      if (!target) await sleep(250);
    }
    if (!target) {
      ok(false, "无头浏览器起得来（调试端口没响应）");
      return;
    }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    cdp = new CDP(ws);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    await cdp.send("Page.navigate", { url: base });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor("!!document.querySelector('.side-item')", 15000), "页面起来了，侧栏画出来了");
    eq(await ev("document.title"), "小李", "页面标题还是「小李」");
    eq(await ev("document.querySelectorAll('.side-item').length"), 11, "侧栏 11 个模块一个不少");
    eq(await ev("!!document.querySelector('.topbar') && !!document.querySelector('.statusbar')"),
      true, "顶栏 / 底部状态栏都在");
    ok(await ev("(document.getElementById('foot-file')||{}).textContent !== '—'"),
      "状态栏能读出数据文件路径（接口通了）");

    const errors = cdp.pageErrors.filter((t) => !/favicon/i.test(t));
    eq(errors.length, 0, "整个过程页面里没冒出 JS 报错");
    if (errors.length) console.log("      " + errors.slice(0, 3).join("\n      "));
  } finally {
    stopTree(edge);
    stopTree(server);
    await sleep(400);
  }
}

async function main() {
  if (typeof WebSocket !== "function") {
    console.log("\n⚠ 跳过：Node 太老（要 22+，用它内置的 fetch / WebSocket 说 CDP）。");
    return "skip";
  }
  const browser = findBrowser();
  if (!browser) {
    console.log("\n⚠ 跳过：这台机器上没找到 Edge / Chrome。");
    return "skip";
  }
  const python = findPython();
  if (!python) {
    console.log("\n⚠ 跳过：没找到能用的 Python 3（要能 import http.server）。");
    return "skip";
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-桌面回退-"));
  const dataDir = path.join(tmp, "数据");
  fs.mkdirSync(dataDir, { recursive: true });
  console.log("临时数据目录：" + dataDir);

  try {
    checkDesktopLogic(python, tmp, dataDir);

    const pythonw = pythonwOf(python);
    if (pythonw) {
      await checkPythonw(pythonw, tmp, dataDir);
    } else {
      console.log("\n⚠ 这台机器上没有 pythonw.exe，跳过「无控制台」那一段。");
    }

    await checkNoBrowser(browser, python, tmp, dataDir);
  } finally {
    await sleep(600);
    const full = path.resolve(tmp);
    const rel = path.relative(path.resolve(os.tmpdir()), full);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) &&
        path.basename(full).startsWith("小李-桌面回退-")) {
      try {
        fs.rmSync(full, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        console.log("（临时目录这次没删掉：" + full + "，手动删掉就行，不影响上面的结论）");
      }
    } else {
      console.log("（临时目录没敢删，路径看着不对：" + full + "）");
    }
  }
  return "ran";
}

let how = "ran";
try {
  how = await main();
} catch (err) {
  fail += 1;
  console.log("\n  FAIL 测试脚本自己挂了：" + (err && err.message ? err.message : err));
}

if (how === "skip") {
  console.log("\n（这台机器上没有浏览器 / Python，这次跳过，不算通过。）");
} else {
  console.log("\n通过 " + pass + " 项，失败 " + fail + " 项");
  if (fail > 0) process.exitCode = 1;
}

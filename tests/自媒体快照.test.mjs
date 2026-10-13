/* 自媒体「记粉丝」弹窗里「用上一条的数字」的真浏览器回归测试：
 * 打开弹窗能看到「上一条：日期 · 多少粉」+ 一个「用它」→ 点一下把那个数字垫进
 * 输入框（并全选）→ 你只改数字 → 记下。没记过的账号不显示那一行。
 *
 * 为什么单独有一份：纯逻辑那份（tests\自媒体计算.test.mjs 的 lastSnapshotOf）
 * 盯的是「取哪一条」，盯不住「那一行真画出来没、点一下真垫进去没、垫的是不是
 * 上一条而不是估算出来那个数」。
 *
 * 跑法：node tests\自媒体快照.test.mjs
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

/** 快照弹窗此刻的样子 */
const snapDialogNow = () =>
  ev(`(()=>{
    const input=document.getElementById('snap-count');
    if(!input) return null;
    const copy=document.getElementById('snap-copy');
    const hint=[...document.querySelectorAll('.dlg .fin-help')]
      .map(p=>p.textContent.replace(/\\s+/g,' ').trim())
      .find(t=>t.includes('上一条'));
    return {
      count: input.value,
      hasCopy: !!copy,
      hint: hint || "",
      focused: document.activeElement === input,
      selStart: input.selectionStart,
      selEnd: input.selectionEnd,
      date: (document.getElementById('snap-date')||{}).value || "",
    };
  })()`);

/** 打开某个账号的「记粉丝」 */
async function openSnap(accountName) {
  const done = await ev(`(()=>{
    const card=[...document.querySelectorAll('.acc-card')]
      .find(c=>c.textContent.includes(${JSON.stringify(accountName)}));
    if(!card) return false;
    const b=card.querySelector('[data-act="acc-snap"]');
    if(!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(250);
  return done;
}

async function clickSave() {
  await ev("document.querySelector('.dlg-backdrop [data-dlg-act=\"save\"]')?.click()");
  await sleep(400);
}

const readData = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-自媒体快照-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (x) => x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate());
  const today = ymd(d);
  const yest = ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
  const before = ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 2));

  // 一个记过两次快照的账号（前天 1200、昨天 1260）+ 今天发的一条作品（涨 40）；
  // 再一个一条都没记过的账号 —— 后者弹窗里不该出现「上一条」那一行。
  const dataFile = path.join(dataDir, "数据.json");
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1,
      rev: 0,
      memo: "",
      mediaAccounts: [
        { id: "acc-a", name: "B站小李", platform: "B站", intro: "", baseFollowers: 1000,
          targetFollowers: 5000, note: "", createdAt: "" },
        { id: "acc-b", name: "新号", platform: "小红书", intro: "", baseFollowers: 0,
          targetFollowers: 1000, note: "", createdAt: "" },
      ],
      contents: [
        { id: "c1", accountId: "acc-a", title: "今天这条", platform: "B站", status: "已发布",
          publishDate: today, fansGain: 40, views: 0, likes: 0, comments: 0, saves: 0,
          note: "", link: "" },
      ],
      mediaFollowers: [
        { id: "s1", accountId: "acc-a", date: before, count: 1200 },
        { id: "s2", accountId: "acc-a", date: yest, count: 1260 },
      ],
      settings: {},
      trash: [],
    }),
    "utf8"
  );

  let server = null;
  let edge = null;
  try {
    const port = await freePort();
    server = spawn(
      python,
      [path.join(ROOT, "app", "服务.py"), "--port", String(port), "--no-browser"],
      {
        env: { ...process.env, XIAOLI_DATA_DIR: dataDir, PYTHONIOENCODING: "utf-8" },
        windowsHide: true,
      }
    );
    server.serverLog = "";
    for (const stream of [server.stdout, server.stderr]) {
      stream.on("data", (chunk) => {
        server.serverLog += chunk.toString("utf8");
      });
    }

    const base = "http://127.0.0.1:" + port + "/";
    let up = false;
    for (let i = 0; i < 80 && !up; i += 1) {
      try {
        const res = await fetch(base + "api/health");
        up = res.ok;
      } catch {
        up = false;
      }
      if (!up) await sleep(250);
    }
    if (!up) {
      console.log("\n服务没起来，它自己这么说：");
      console.log(server.serverLog.trim() || "（一个字都没输出）");
      ok(false, "临时服务起得来");
      return;
    }
    console.log("临时数据目录：" + dataDir);

    const debugPort = await freePort();
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
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    await cdp.send("Page.navigate", { url: base + "#media" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor("!!document.querySelector('.acc-card')", 15000), "自媒体页起来了");

    /* ---- 记过的账号：看得到上一条 ---- */
    console.log("\n记过的账号：弹窗里写着上一条，默认那个数还是「估算到今天」的");
    ok(await openSnap("B站小李"), "点得动「记粉丝」");
    ok(await waitFor("!!document.getElementById('snap-count')", 5000), "弹窗开了");
    let view = await snapDialogNow();
    eq(view.date, today, "日期默认今天");
    ok(view.hasCopy, "有「用它」那颗按钮");
    // fmtCount 一律截断：1260 → 1.2k（不是 1.3k）
    ok(view.hint.includes(yest) && view.hint.includes("1.2k"),
      "写着上一条是哪天、多少粉（" + view.hint + "）");
    eq(view.count, "1300",
      "输入框默认还是估算数（上一条 1260 + 今天那条作品涨 40）——和「上一条」分得开");

    /* ---- 点「用它」 ---- */
    console.log("\n点「用它」：垫进上一条那个数字，并且全选好让你直接打");
    await ev("document.getElementById('snap-copy').click()");
    await sleep(200);
    view = await snapDialogNow();
    eq(view.count, "1260", "输入框变成上一条的 1260");
    eq(view.focused, true, "焦点在输入框上");
    // 真敲一个数字：全选生效的话它是「替换」而不是「追加」。
    // （type=number 的输入框不支持 selectionStart/End，读不到选区，只能这么验）
    await cdp.send("Input.insertText", { text: "9" });
    await sleep(150);
    eq((await snapDialogNow()).count, "9", "直接打一个数字就把原来那个替掉了（说明是选中的）");

    console.log("\n改成 1350 记下：数据里多出今天那一条");
    await ev("(()=>{document.getElementById('snap-count').value='1350';return true;})()");
    await clickSave();
    const snaps = readData(dataFile).mediaFollowers.filter((s) => s.accountId === "acc-a");
    eq(snaps.length, 3, "三条了（前天 / 昨天 / 今天）");
    eq(snaps.find((s) => s.date === today).count, 1350, "今天那条是 1350");

    /* ---- 再打开：上一条就是刚记的那条 ---- */
    console.log("\n再打开：上一条换成了刚记的那条");
    ok(await openSnap("B站小李"), "再打开一次");
    await waitFor("!!document.getElementById('snap-count')", 5000);
    view = await snapDialogNow();
    ok(view.hint.includes(today) && view.hint.includes("1.3k"),
      "上一条变成今天的 1350（" + view.hint + "）");
    await ev("document.querySelector('.dlg-backdrop [data-dlg-act=\"cancel\"]')?.click()");
    await sleep(200);

    /* ---- 没记过的账号：不显示那一行 ---- */
    console.log("\n一条都没记过的账号：不显示「上一条」那一行");
    ok(await openSnap("新号"), "打开新号的「记粉丝」");
    await waitFor("!!document.getElementById('snap-count')", 5000);
    view = await snapDialogNow();
    eq(view.hasCopy, false, "没有「用它」按钮");
    eq(view.hint, "", "也没有「上一条」那句话");
    await ev("document.querySelector('.dlg-backdrop [data-dlg-act=\"cancel\"]')?.click()");
    await sleep(250);
    ok(await ev("!document.getElementById('snap-count')"), "顺手关掉它");

    /* ---- 全程不该冒 JS 报错 ---- */
    const errors = cdp.pageErrors.filter((t) => !/favicon/i.test(t));
    eq(errors.length, 0, "整个过程页面里没冒出 JS 报错");
    if (errors.length) console.log("      " + errors.slice(0, 3).join("\n      "));
  } finally {
    stopTree(edge);
    stopTree(server);
    await sleep(600);
    const full = path.resolve(tmp);
    const rel = path.relative(path.resolve(os.tmpdir()), full);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) &&
        path.basename(full).startsWith("小李-自媒体快照-")) {
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

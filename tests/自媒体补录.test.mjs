/* 粉丝快照「补几天」的真浏览器回归测试：预填最近 7 天里还没记过的那几天 →
 * 只填数字 → 实时预览会记几天 / 跳过几行 → 记下；再打开时预填里就没有刚记过的那两天；
 * 有问题的行（乱写 / 未来日期）当场报错并拦住保存；同一天已记的会覆盖那一条。
 *
 * 为什么单独有一份：纯逻辑那份（tests\自媒体计算.test.mjs 的 parseSnapshotLines /
 * applySnapshots）盯的是「怎么解析、怎么合并」，盯不住「预填里是不是真排除了记过的日子、
 * 预览真不真、有错到底拦没拦住」。
 *
 * 跑法：node tests\自媒体补录.test.mjs
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

/** 补几天弹窗此刻的样子 */
const bulkNow = () =>
  ev(`(()=>{
    const box=document.getElementById('bulk-text');
    if(!box) return null;
    const err=document.getElementById('bulk-err');
    const prev=document.getElementById('bulk-preview');
    return {
      lines: box.value.split('\\n'),
      preview: prev ? prev.textContent.trim() : "",
      err: err && !err.hidden ? err.textContent : "",
    };
  })()`);

async function openBulk() {
  const done = await ev(`(()=>{
    const b=document.querySelector('[data-act="acc-snap-bulk"]');
    if(!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(250);
  return done;
}

async function setBulkText(lines) {
  await ev(`(()=>{
    const box=document.getElementById('bulk-text');
    box.value=${JSON.stringify(lines.join("\n"))};
    box.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
  await sleep(200);
}

async function clickDialog(act) {
  const done = await ev(
    "(()=>{const b=document.querySelector('[data-dlg-act=\"" + act + "\"]');" +
      "if(!b)return false;b.click();return true;})()"
  );
  await sleep(350);
  return done;
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-自媒体补录-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (x) => x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate());
  const today = ymd(d);
  const day = (back) => ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));

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
      ],
      contents: [],
      mediaFollowers: [],
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
    ok(await waitFor("!!document.querySelector('[data-act=\"acc-snap-bulk\"]')", 15000),
      "账号卡片上有「补几天」");

    /* ---- 预填 ---- */
    console.log("\n打开「补几天」：最近 7 天已经替你填好了日期");
    ok(await openBulk(), "点得动「补几天」");
    await waitFor("!!document.getElementById('bulk-text')", 5000);
    let view = await bulkNow();
    eq(view.lines.length, 7, "预填了 7 行");
    eq(view.lines[0].trim(), day(6), "第一行是 6 天前");
    eq(view.lines[6].trim(), today, "最后一行是今天");
    eq(view.lines.every((l) => l.trim().endsWith(day(0)) || /^\d{4}-\d{2}-\d{2} ?$/.test(l)), true,
      "每天一行、只有日期（数字等你填）");
    ok(view.preview.includes("还没填数字"), "底下提示还没填数字（" + view.preview + "）");

    /* ---- 填两天 ---- */
    console.log("\n填两天：预览说清会记几天、跳过几行");
    await setBulkText([`${day(2)} 1200`, `${day(1)} `, `${today} 1260`, ...view.lines.slice(3)]);
    view = await bulkNow();
    ok(view.preview.includes("会记 2 天"), "会记 2 天（" + view.preview + "）");
    ok(view.preview.includes(day(2)) && view.preview.includes(today), "把区间也写出来了");
    ok(view.preview.includes("跳过"), "跳过了几行没填的也说一声");
    eq(view.err, "", "没有错");

    console.log("\n记下：数据里多出那两天");
    await clickDialog("save");
    let snaps = readData(dataFile).mediaFollowers;
    eq(snaps.length, 2, "两条快照");
    eq(snaps.find((s) => s.date === day(2)).count, 1200, "前天那条的数字对");
    eq(snaps.find((s) => s.date === today).count, 1260, "今天那条也在");
    eq(snaps.every((s) => s.accountId === "acc-a"), true, "都挂在这个账号上");

    /* ---- 再打开：预填里没有刚记过的那两天 ---- */
    console.log("\n再打开：预填里不再列刚记过的那两天");
    await openBulk();
    await waitFor("!!document.getElementById('bulk-text')", 5000);
    view = await bulkNow();
    eq(view.lines.length, 5, "只剩 5 行（7 天里记过 2 天）");
    eq(view.lines.some((l) => l.includes(day(2))), false, "前天那行不在预填里了");
    eq(view.lines.some((l) => l.includes(today)), false, "今天那行也不在");

    /* ---- 有问题的行：当场报错 + 拦住保存 ---- */
    console.log("\n乱写 / 未来日期：当场报错，记不下去");
    await setBulkText([`${day(3)} 1100`, "这不是日期", `${day(-3)} 2000`]);
    view = await bulkNow();
    ok(view.err.includes("第 2 行"), "报出是第 2 行的问题（" + view.err + "）");
    ok(view.err.includes("第 3 行"), "也报第 3 行");
    ok(view.err.includes("以后"), "未来日期那行说清是以后的日期");
    await clickDialog("save");
    eq(await ev("!!document.getElementById('bulk-text')"), true, "弹窗没关（拦住了）");
    eq(readData(dataFile).mediaFollowers.length, 2, "数据没变（半截也没存进去）");

    /* ---- 覆盖已经记过的那天 ---- */
    console.log("\n填一个已经记过的日期：覆盖那一天，不是再加一条");
    await setBulkText([`${today} 1300`, ` ${day(5)} 1050`]);
    view = await bulkNow();
    ok(view.preview.includes("会记 2 天"), "两天都算上（" + view.preview + "）");
    await clickDialog("save");
    snaps = readData(dataFile).mediaFollowers;
    eq(snaps.length, 3, "三条（覆盖一条 + 新加一条）");
    eq(snaps.filter((s) => s.date === today).length, 1, "今天那一天只有一条（没堆成两条）");
    eq(snaps.find((s) => s.date === today).count, 1300, "数字被覆盖成 1300");
    eq(snaps.find((s) => s.date === day(5)).count, 1050, "5 天前那条新加上了");

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
        path.basename(full).startsWith("小李-自媒体补录-")) {
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

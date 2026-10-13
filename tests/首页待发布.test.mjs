/* 首页「待发布」提醒的真浏览器回归测试：自媒体卡片上多一行提醒（简洁模式也看得见），
 * 排期过了是红边、排在今天是琥珀色；点卡片跳到自媒体页；没有要发的就不占地方。
 *
 * 为什么单独有一份：纯逻辑那份（tests\首页视图.test.mjs 的 pendingNoticeOf）盯的是
 * 「挑哪一档、文案写什么」，盯不住「简洁模式那张卡片上真画出来没」——
 * 简洁模式默认只显示卡片正面一行，提醒要是塞进 sub 就白写了。
 *
 * 跑法：node tests\首页待发布.test.mjs
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

/** 首页自媒体那张卡片此刻的样子 */
const mediaCardNow = () =>
  ev(`(()=>{
    const card=[...document.querySelectorAll('.mod-card')]
      .find(c=>(c.getAttribute('href')||'')==='#media');
    if(!card) return null;
    const alert=card.querySelector('.mod-alert');
    return {
      main: (card.querySelector('.mod-main')||{}).textContent || "",
      hasAlert: !!alert,
      text: alert ? alert.textContent.trim() : "",
      cls: alert ? alert.className : "",
      title: alert ? alert.getAttribute('title') : "",
      href: card.getAttribute('href'),
    };
  })()`);

async function reload() {
  await cdp.send("Page.reload");
  await waitFor('document.readyState === "complete"', 15000);
  await waitFor("!!document.querySelector('.mod-card')", 15000);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-首页待发布-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (x) => x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate());
  const today = ymd(d);
  const yest = ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
  const in3 = ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3));
  const far = ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 30));

  const dataFile = path.join(dataDir, "数据.json");
  const writeData = (contents) => {
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
        contents,
        mediaFollowers: [],
        settings: {},
        trash: [],
      }),
      "utf8"
    );
  };
  const work = (id, title, planDate, status = "待发布") => ({
    id, accountId: "acc-a", platform: "B站", title, status, planDate,
    publishDate: "", link: "", views: 0, likes: 0, comments: 0, collects: 0,
    fansGain: 0, note: "", createdAt: "",
  });

  // 一条排期过了没发、一条排在今天、一条排在一个月后
  writeData([
    work("w1", "过期的那条", yest),
    work("w2", "今天该发的那条", today),
    work("w3", "还早的那条", far),
  ]);

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

    await cdp.send("Page.navigate", { url: base });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor("!!document.querySelector('.mod-card')", 15000), "首页起来了");

    /* ---- 有排期过了的：红边那条先说 ---- */
    console.log("\n首页那张自媒体卡片上：先说排期过了的那条");
    let card = await mediaCardNow();
    ok(Boolean(card), "找得到自媒体卡片");
    eq(card.hasAlert, true, "卡片上多了一行提醒（简洁模式也画）");
    eq(card.text, "有 1 条排期过了还没发", "文案说的是最要紧的那一档");
    ok(card.cls.includes("overdue"), "排期过了是红边那一档（" + card.cls + "）");
    ok(card.title.includes("过期的那条") && card.title.includes(yest),
      "鼠标移上去写着是哪条、原定哪天（" + card.title + "）");

    console.log("\n点那张卡片：跳到自媒体页");
    await ev(`(()=>{const c=[...document.querySelectorAll('.mod-card')]
      .find(x=>x.getAttribute('href')==='#media'); c.click(); return true;})()`);
    ok(await waitFor("location.hash === '#media'", 5000), "地址切到了 #media");

    /* ---- 只有今天该发的 ---- */
    console.log("\n把过期那条标成已发布：提醒换成「今天该发」那一档");
    writeData([
      { ...work("w1", "过期的那条", yest), status: "已发布", publishDate: yest },
      work("w2", "今天该发的那条", today),
      work("w3", "还早的那条", far),
    ]);
    await ev("location.hash='#home'");
    await reload();
    card = await mediaCardNow();
    eq(card.text, "今天该发 1 条", "换成今天这一档");
    eq(card.cls.includes("overdue"), false, "不再红边");

    /* ---- 只有本周要发的 ---- */
    console.log("\n把今天那条也挪到三天后：提醒换成「本周还有」");
    writeData([
      { ...work("w1", "过期的那条", yest), status: "已发布", publishDate: yest },
      work("w2", "今天该发的那条", in3),
      work("w3", "还早的那条", far),
    ]);
    await reload();
    card = await mediaCardNow();
    eq(card.text, "本周还有 1 条要发", "再往下一档");

    /* ---- 没什么要发的：那一行不占地方 ---- */
    console.log("\n都改到一个多月以后：那一行收起来");
    writeData([
      work("w1", "过期的那条", far),
      work("w2", "今天该发的那条", far),
    ]);
    await reload();
    card = await mediaCardNow();
    eq(card.hasAlert, false, "卡片上没有那一行了");
    ok(card.main.includes("总粉"), "卡片正面还是原来那句（没被顶掉）");

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
        path.basename(full).startsWith("小李-首页待发布-")) {
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

/* 记账「近 6 个月」趋势图的真浏览器回归测试：六根柱子画出来了、高度和金额对得上、
 * 空月份是一根零高柱、切「收入」换色换数、悬停提示里有完整金额、当月那句说明在、
 * 只有一个月有数也画得出、一笔都没有时给空状态。
 *
 * 为什么单独有一份：纯逻辑那份（tests\记账计算.test.mjs）盯的是「每个月算多少、
 * 柱高比例怎么归一」，盯不住「柱子真画出来没、页签真换没换、SVG 的坐标有没有算歪」。
 *
 * 跑法：node tests\记账趋势.test.mjs
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

/** 趋势图此刻的样子：六根柱子各自的高度 / 月份 / 金额 / 悬停文字，加上头上那句和图下那句 */
const trendNow = () =>
  ev(`(()=>{
    const card=document.querySelector('#fin-trend');
    if(!card) return null;
    const svg=card.querySelector('.fin-trend');
    const hints=[...card.querySelectorAll('.hint')].map(h=>h.textContent.trim());
    return {
      hasSvg: !!svg,
      income: svg ? svg.classList.contains('is-income') : null,
      empty: !!card.querySelector('.empty-state'),
      bars: svg ? [...svg.querySelectorAll('.trend-bar')].map(g=>{
        const rect=g.querySelector('rect');
        return {
          mon:(g.querySelector('.trend-mon')||{}).textContent || "",
          num:(g.querySelector('.trend-num')||{}).textContent || "",
          h: rect ? Number(rect.getAttribute('height')) : null,
          y: rect ? Number(rect.getAttribute('y')) : null,
          now: g.classList.contains('now'),
          tip: (g.querySelector('title')||{}).textContent || "",
        };
      }) : [],
      hints,
      text: card.textContent.replace(/\\s+/g,' ').trim(),
    };
  })()`);

async function clickTrendTab(kind) {
  const done = await ev(`(()=>{
    const b=document.querySelector('#fin-trend [data-act="trend-type"][data-type=${JSON.stringify(kind)}]');
    if(!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(250);
  return done;
}

async function reload() {
  await cdp.send("Page.reload");
  await waitFor('document.readyState === "complete"', 15000);
  await waitFor("!!document.querySelector('#fin-trend')", 15000);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-记账趋势-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (x) => x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate());
  const today = ymd(d);
  // 最近 6 个月（升序），最后一个是当月
  const months = [];
  for (let i = 5; i >= 0; i -= 1) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    months.push(x.getFullYear() + "-" + pad(x.getMonth() + 1));
  }
  const day = (key) => key + "-05";
  const dataFile = path.join(dataDir, "数据.json");

  // 当月 300（最高）、三个月前 150、五个月前 50，另外三个月是空的；
  // 再给当月一笔收入 800，用来看「收入」那一头。
  const writeData = (txs) => {
    fs.writeFileSync(
      dataFile,
      JSON.stringify({
        version: 1,
        rev: 0,
        memo: "",
        finance: {
          accounts: [{ id: "acc-wx", name: "微信", initialBalanceCents: 0 }],
          transactions: txs,
          transfers: [],
          templates: [],
          budget: { monthlyTotalCents: 0, categoryCents: {} },
        },
        trash: [],
      }),
      "utf8"
    );
  };
  const expense = (id, cents, date, category) => ({
    id, type: "expense", amountCents: cents, date, category,
    accountId: "acc-wx", note: "", imagePaths: [], createdAt: date + " 10:00",
  });
  writeData([
    expense("e-now", 30000, day(months[5]), "餐饮"),
    expense("e-m3", 15000, day(months[3]), "购物"),
    expense("e-m5", 5000, day(months[0]), "交通"),
    {
      id: "i-now", type: "income", amountCents: 80000, date: day(months[5]),
      category: "工资", accountId: "acc-wx", note: "", imagePaths: [],
      createdAt: day(months[5]) + " 09:00",
    },
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

    await cdp.send("Page.navigate", { url: base + "#finance" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor("!!document.querySelector('#fin-trend')", 15000),
      "记账页左栏出现了「近 6 个月」这张卡");

    /* ---- 六根柱子 ---- */
    console.log("\n六根柱子：高度和金额对得上，空月份是一根零高柱");
    let view = await trendNow();
    ok(view.hasSvg, "画出来的是 SVG（手写的那张图）");
    eq(view.bars.length, 6, "正好六根");
    eq(view.bars.map((b) => b.mon).join("/"),
      months.map((m) => Number(m.slice(5)) + "月").join("/"), "柱子下面按顺序写着月份");
    const tallest = view.bars.reduce((best, b) => (b.h > best.h ? b : best), view.bars[0]);
    eq(tallest.mon, Number(months[5].slice(5)) + "月", "最高的那根是当月（300 那笔）");
    ok(view.bars[5].now, "当月那根打了个 now 的标记（画得实一点）");
    eq(view.bars[3].h, Math.round(tallest.h * 0.5), "三个月前那根（150）正好是最高的一半");
    eq(view.bars[0].h, Math.round(tallest.h * (5000 / 30000)), "五个月前那根（50）按比例");
    eq([view.bars[1], view.bars[2], view.bars[4]].every((b) => b.h === 0), true,
      "另外三个月一笔都没有：三根零高柱");
    ok(view.bars[5].num.includes("300"), "柱子上面标着金额（" + view.bars[5].num + "）");
    ok(view.bars[5].tip.includes(months[5]) && view.bars[5].tip.includes("支出") &&
       view.bars[5].tip.includes("¥300.00"), "悬停里有月份、方向、完整金额（" + view.bars[5].tip + "）");
    ok(view.hints.some((h) => h.includes("支出共") && h.includes("月均")),
      "头上那句写着合计与月均（" + view.hints.join(" / ") + "）");
    ok(view.hints.some((h) => h.includes("还没过完")), "当月那句「还没过完」在");

    /* ---- 切收入 ---- */
    console.log("\n切「收入」：换色换数，头上那句也跟着换");
    ok(await clickTrendTab("income"), "点得动「收入」页签");
    view = await trendNow();
    eq(view.income, true, "图换到了收入那一头");
    eq(view.bars.length, 6, "还是六根柱子");
    eq(view.bars[5].h, Math.round(tallest.h), "当月那根成了最高的（收入 800）");
    eq([view.bars[0], view.bars[1], view.bars[2], view.bars[3], view.bars[4]].every((b) => b.h === 0),
      true, "别的月份没有收入：五根零高柱");
    ok(view.bars[5].tip.includes("收入") && view.bars[5].tip.includes("¥800.00"),
      "悬停文字换成了收入与金额（" + view.bars[5].tip + "）");
    ok(view.hints.some((h) => h.includes("收入共")), "头上那句换成了收入");
    await clickTrendTab("expense");

    /* ---- 只有一个月有数 ---- */
    console.log("\n只有一个月有数：照样画得出");
    writeData([expense("e-only", 12345, day(months[5]), "餐饮")]);
    await reload();
    view = await trendNow();
    eq(view.bars.length, 6, "还是六根");
    eq(view.bars.filter((b) => b.h > 0).length, 1, "只有一根有高度");
    eq(view.bars[5].h > 0, true, "有高度的是当月那根");

    /* ---- 一笔都没有 ---- */
    console.log("\n一笔账都没有：给空状态，不画一张空图");
    writeData([]);
    await reload();
    view = await trendNow();
    eq(view.hasSvg, false, "没有画空图");
    eq(view.empty, true, "给了空状态");
    ok(view.text.includes("近 6 个月还没有账目"), "空状态那句话在（" + view.text + "）");

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
        path.basename(full).startsWith("小李-记账趋势-")) {
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

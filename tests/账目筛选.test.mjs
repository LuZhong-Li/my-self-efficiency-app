/* 记账「明细」卡片筛选的真浏览器回归测试：默认看当天，能切「本月 / 自定义时间段」，
 * 再叠一个「只看某个账户」；顺带把一直缺的「整月账目列表」也验了。
 *
 * 为什么单独有一份：筛选是「条件进、列表出」的东西，纯逻辑那份盯的是怎么筛
 * （tests\记账计算.test.mjs 的 ledgerOf），盯不住「切了下拉到底重画没重画、
 * 合计跟列表对不对得上、转账有没有跟着范围走」。
 *
 * 跑法：node tests\账目筛选.test.mjs
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

/** 明细卡片此刻的样子：标题、头上那句说明、列表里都有谁、转账那一块、合计 */
const ledgerNow = () =>
  ev(`(()=>{
    const card=document.querySelector('#fin-day');
    const sum=card.querySelector('.fin-day-sum');
    return {
      title: (card.querySelector('h2')||{}).textContent || "",
      hint: (card.querySelector('.card-head .hint')||{}).textContent || "",
      scope: document.querySelector('#day-scope') ? document.querySelector('#day-scope').value : null,
      rows: [...card.querySelectorAll('ul.items > li')].map(li=>({
        text: li.textContent.replace(/\\s+/g,' ').trim(),
        transfer: li.classList.contains('is-transfer'),
      })),
      sum: sum ? sum.textContent.replace(/\\s+/g,' ').trim() : null,
      empty: (card.querySelector('.empty-state')||{}).textContent ? true : false,
    };
  })()`);

/** 改筛选：设置某个控件再派发 change（页面自己的 onChange 管这个） */
async function setFilter(id, value) {
  const done = await ev(`(()=>{
    const el=document.getElementById(${JSON.stringify(id)});
    if(!el) return false;
    el.value=${JSON.stringify(String(value))};
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  await sleep(250);
  return done;
}

const texts = (rows) => rows.map((r) => r.text);

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-账目筛选-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (x) => x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate());
  const today = ymd(d);
  const month = today.slice(0, 7);
  // 同月里另找一天（今天是 1 号就挑 2 号，别撞上今天）
  const other = month + "-01" === today ? month + "-02" : month + "-01";
  const lastMonth = ymd(new Date(d.getFullYear(), d.getMonth() - 1, 15));

  // 三笔账（今天 / 本月另一天 / 上个月）+ 一条今天的转账（微信 → 银行卡）
  fs.writeFileSync(
    path.join(dataDir, "数据.json"),
    JSON.stringify({
      version: 1,
      rev: 0,
      memo: "",
      finance: {
        accounts: [
          { id: "acc-wx", name: "微信", initialBalanceCents: 0 },
          { id: "acc-bank", name: "银行卡", initialBalanceCents: 0 },
        ],
        transactions: [
          { id: "tx-today", type: "expense", amountCents: 10000, date: today,
            category: "餐饮", accountId: "acc-wx", note: "今天午饭", imagePaths: [], createdAt: today + " 12:00" },
          { id: "tx-other", type: "expense", amountCents: 20000, date: other,
            category: "购物", accountId: "acc-bank", note: "本月买书", imagePaths: [], createdAt: other + " 09:00" },
          { id: "tx-last", type: "income", amountCents: 50000, date: lastMonth,
            category: "工资", accountId: "acc-wx", note: "上个月的工资", imagePaths: [], createdAt: lastMonth + " 09:00" },
        ],
        transfers: [
          { id: "tf-1", amountCents: 2500, date: today, fromAccountId: "acc-wx",
            toAccountId: "acc-bank", note: "还信用卡", imagePaths: [], createdAt: today + " 10:00" },
        ],
        budget: { monthlyTotalCents: 0, categoryCents: {} },
      },
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

    await cdp.send("Page.navigate", { url: base + "#finance" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor("!!document.getElementById('day-scope')", 15000),
      "记账页起来了，明细卡片上有筛选栏");

    /* ---- 默认：当天 ---- */
    console.log("\n默认看当天：只有今天那一笔 + 今天的转账");
    let view = await ledgerNow();
    eq(view.scope, "day", "范围默认是「当天」（老手感不变）");
    eq(view.title, "当日明细", "标题还是「当日明细」");
    eq(texts(view.rows).filter((t) => t.includes("还信用卡")).length, 1, "今天的转账在");
    eq(view.rows.filter((r) => !r.transfer).length, 1, "收支只有一笔（今天午饭）");
    ok(texts(view.rows).some((t) => t.includes("今天午饭")), "今天那笔在列表里");
    ok(!texts(view.rows).some((t) => t.includes("本月买书")), "本月另一天那笔不在");
    eq(view.sum && view.sum.includes("-¥100.00"), true, "合计对得上这一笔（" + view.sum + "）");
    eq(/月.*日/.test(view.hint), true, "头上写着看的是哪一天（" + view.hint + "）");

    /* ---- 切「本月」：整月账目列表 ---- */
    console.log("\n切「本月」：整月的账都出来了，上个月的不进来");
    await setFilter("day-scope", "month");
    view = await ledgerNow();
    eq(view.title, "本月账目", "标题跟着变成「本月账目」");
    eq(view.rows.filter((r) => !r.transfer).length, 2, "账目两笔（今天 + 本月另一天）");
    ok(texts(view.rows).some((t) => t.includes("本月买书")), "本月另一天那笔进来了");
    ok(!texts(view.rows).some((t) => t.includes("上个月的工资")), "上个月那笔不进来");
    eq(view.rows.filter((r) => r.transfer).length, 1, "转账也在");
    eq(view.sum && view.sum.includes("-¥300.00"), true, "合计 = 100 + 200（" + view.sum + "）");
    ok(texts(view.rows).some((t) => /\d{2}-\d{2}/.test(t)), "看一段时间的列表里每笔带着日期");
    ok(view.hint.includes("2 笔"), "头上写着条数（" + view.hint + "）");

    /* ---- 叠一个账户 ---- */
    console.log("\n只看「微信」：只剩微信那笔，转账也照旧（微信是转出方）");
    await setFilter("day-account", "acc-wx");
    view = await ledgerNow();
    eq(view.rows.filter((r) => !r.transfer).length, 1, "账目只剩一笔");
    ok(texts(view.rows).some((t) => t.includes("今天午饭")), "剩的是微信那笔");
    ok(!texts(view.rows).some((t) => t.includes("本月买书")), "银行卡那笔被筛掉了");
    eq(view.rows.filter((r) => r.transfer).length, 1, "转账还在（钱从微信出）");
    ok(view.hint.includes("微信"), "头上写着筛了哪个账户（" + view.hint + "）");
    eq(view.sum && view.sum.includes("-¥100.00"), true, "合计只剩微信这笔（" + view.sum + "）");

    console.log("\n只看「银行卡」：换成另一边");
    await setFilter("day-account", "acc-bank");
    view = await ledgerNow();
    eq(view.rows.filter((r) => !r.transfer).length, 1, "账目只剩一笔");
    ok(texts(view.rows).some((t) => t.includes("本月买书")), "剩的是银行卡那笔");
    eq(view.rows.filter((r) => r.transfer).length, 1, "转账还在（钱转到银行卡）");

    await setFilter("day-account", "");   // 回到全部账户

    /* ---- 自定义时间段 ---- */
    console.log("\n切「自定义」：默认垫上现在看的那天，改起止就跟着变");
    await setFilter("day-scope", "range");
    view = await ledgerNow();
    eq(view.title, "这段时间", "标题变成「这段时间」");
    ok(await ev("!!document.getElementById('day-from')"), "多出两个日期框");
    eq(await ev("document.getElementById('day-from').value"), today, "起止先垫成现在看的那天");

    await setFilter("day-from", other);
    view = await ledgerNow();
    eq(view.rows.filter((r) => !r.transfer).length, 2, "从本月另一天起：两笔都在");
    await setFilter("day-to", other);
    view = await ledgerNow();
    eq(view.rows.filter((r) => !r.transfer).length, 1, "只到本月另一天：只剩那一笔");
    ok(texts(view.rows).some((t) => t.includes("本月买书")), "剩的是本月那笔");
    eq(view.rows.filter((r) => r.transfer).length, 0, "转账在今天，被上界挡在外面了");

    console.log("\n起止填反了：自动换过来（不是筛出一片空）");
    await setFilter("day-from", today);
    await setFilter("day-to", other);
    view = await ledgerNow();
    eq(view.rows.filter((r) => !r.transfer).length, 2, "反着填照样两笔都在");
    eq(view.rows.filter((r) => r.transfer).length, 1, "转账也在（范围被换正了）");

    /* ---- 空的一段：说清楚是空的 ---- */
    console.log("\n挑一段没有账目的时间：明确说「没有账目」");
    // 上个月那笔工资在 15 号，挑上个月 01～02 号，正好是空的
    const lastMonthKey = lastMonth.slice(0, 7);
    await setFilter("day-from", lastMonthKey + "-01");
    await setFilter("day-to", lastMonthKey + "-02");
    view = await ledgerNow();
    eq(view.empty, true, "给了空状态，不是一个空列表");

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
        path.basename(full).startsWith("小李-账目筛选-")) {
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

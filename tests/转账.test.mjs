/* 账户转账的真浏览器回归测试：记一笔转账之后，两个账户的余额各变对、
 * **收支统计一个数都不变**、当日明细里看得见（不带 + / −）、
 * 改金额跟着改、删了回到原样。
 *
 * 为什么单独有一份：转账这件事最容易错的地方就是「顺手把收支也算进去了」，
 * 或者「余额算了两遍」。这两条只有真点一遍、真的对着页面上的数字看才验得到 ——
 * 纯逻辑单测（tests\记账计算.test.mjs）能盯住算法，盯不住页面传了哪些参数给它。
 *
 * 跑法：node tests\转账.test.mjs
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
const J = JSON.stringify;

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

/* ---------------- 页面上那几个数 ---------------- */

/** 账户卡片上每行的名字与「余额 …」那句话 */
const accountsNow = () =>
  ev(`(()=>{
    return [...document.querySelectorAll('#fin-accounts .fin-acc')].map(li=>({
      name: (li.querySelector('.fin-acc-name')||{}).textContent || "",
      sub: ((li.querySelector('.fin-acc-sub')||{}).textContent||"").replace(/\\s+/g,' ').trim(),
      balance: ((li.querySelector('.fin-acc-sub .fin-amount')||{}).textContent||"").trim(),
    }));
  })()`);

/** 概览卡片里某一格的数（「本月支出」「账户总余额」…） */
const sumNow = (label) =>
  ev(`(()=>{
    const box=[...document.querySelectorAll('#fin-overview .fin-sum-item')]
      .find(d=>(d.querySelector('span')||{}).textContent && d.querySelector('span').textContent.includes(${J(label)}));
    if(!box) return null;
    const strong=box.querySelector('strong');
    return strong ? strong.textContent.trim() : null;
  })()`);

/** 当日明细里转账那一块的样子 */
const transferRowsNow = () =>
  ev(`(()=>{
    return [...document.querySelectorAll('#fin-day .fin-row.is-transfer')].map(li=>({
      title: (li.querySelector('.i-title')||{}).textContent || "",
      meta: (li.querySelector('.i-meta')||{}).textContent || "",
      amount: (li.querySelector('.fin-amount')||{}).textContent || "",
    }));
  })()`);

/** 弹窗里转账那一套控件在不在、页签停在哪儿 */
const dialogNow = () =>
  ev(`(()=>{
    // 只认「记一笔」那个弹窗里的页签：页面上环形图那对 支出/收入 按钮也用了 .fin-tab
    const amount=document.querySelector('#tx-amount');
    const dlgEl=amount ? amount.closest('.dlg') : null;
    const tab=dlgEl ? dlgEl.querySelector('.fin-tab.active') : null;
    return {
      tab: tab ? tab.textContent.trim() : null,
      hasFrom: !!document.querySelector('#tx-from'),
      hasTo: !!document.querySelector('#tx-to'),
      hasCats: !!document.querySelector('.fin-cats'),
      toErr: (document.querySelector('#tx-to-err')||{}).textContent || "",
      toErrHidden: document.querySelector('#tx-to-err') ? document.querySelector('#tx-to-err').hidden : null,
    };
  })()`);

/** 填转账表单。金额 / 下拉直接给值就够 —— 它们没有 input 监听，保存时才读 */
async function fillTransfer({ amount, from, to }) {
  await ev(`(()=>{
    ${amount === undefined ? "" : `document.querySelector('#tx-amount').value=${J(String(amount))};`}
    ${from === undefined ? "" : `document.querySelector('#tx-from').value=${J(String(from))};`}
    ${to === undefined ? "" : `document.querySelector('#tx-to').value=${J(String(to))};`}
    return true;
  })()`);
  await sleep(80);
}

async function clickDialog(act) {
  const done = await ev(
    "(()=>{const b=document.querySelector('[data-dlg-act=\"" + act + "\"]');" +
      "if(!b)return false;b.click();return true;})()"
  );
  await sleep(300);
  return done;
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-转账-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const today = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

  // 两个账户 + 今天一笔 100 元的支出（记在微信上）：
  //   微信 期初 1000 → 花掉 100 → 900；银行卡 0
  // 后面转 250 过去，就看这两个数怎么动、以及「本月支出」动没动。
  const dataFile = path.join(dataDir, "数据.json");
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1,
      rev: 0,
      memo: "",
      finance: {
        accounts: [
          { id: "acc-wx", name: "微信", initialBalanceCents: 100000 },
          { id: "acc-bank", name: "银行卡", initialBalanceCents: 0 },
        ],
        transactions: [
          {
            id: "tx-1", type: "expense", amountCents: 10000, date: today,
            category: "餐饮", accountId: "acc-wx", note: "午饭", imagePaths: [],
          },
        ],
        transfers: [],
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
    ok(
      await waitFor("!!document.querySelector('#fin-accounts .fin-acc')", 15000),
      "记账页在真浏览器里起来了（账户卡片画出来了）"
    );

    /* ---- 转之前：两个余额、本月支出 ---- */
    console.log("\n转之前：微信 900、银行卡 0，本月支出 100");
    let accs = await accountsNow();
    eq(accs.length, 2, "账户卡片上两个账户");
    eq(accs[0].balance, "余额 ¥900.00", "微信：期初 1000 − 花掉 100");
    eq(accs[1].balance, "余额 ¥0.00", "银行卡：一分没有");
    const expenseBefore = await sumNow("本月支出");
    eq(expenseBefore, "¥100.00", "本月支出 ¥100.00");
    const totalBefore = await sumNow("账户总余额");
    eq(totalBefore, "¥900.00", "账户总余额 ¥900.00");

    /* ---- 打开转账：停在转账页签、没有分类那一块 ---- */
    console.log("\n点账户卡片上的「转账」：弹窗停在转账页签");
    ok(
      await ev("(()=>{const b=document.querySelector('[data-act=\"tf-add\"]');" +
        "if(!b)return false;b.click();return true;})()"),
      "账户卡片上有「转账」按钮"
    );
    ok(await waitFor("!!document.querySelector('#tx-from')", 5000), "弹窗里有「从」的下拉");
    let dlg = await dialogNow();
    eq(dlg.tab, "转账", "默认就停在「转账」页签");
    ok(dlg.hasTo, "有「到」的下拉");
    eq(dlg.hasCats, false, "转账没有分类那一块（它不是花销）");

    /* ---- 填 250，微信 → 银行卡 ---- */
    console.log("\n填 250 转过去：余额各动 250，收支一个数都不变");
    await fillTransfer({ amount: "250", from: "acc-wx", to: "acc-bank" });
    await clickDialog("save");
    ok(!(await ev("!!document.querySelector('#tx-from')")), "保存之后弹窗关掉了");
    await sleep(400);

    accs = await accountsNow();
    eq(accs[0].balance, "余额 ¥650.00", "微信：900 − 250");
    eq(accs[1].balance, "余额 ¥250.00", "银行卡：0 + 250");
    eq(await sumNow("本月支出"), "¥100.00", "本月支出还是 ¥100.00（转账没进来）");
    eq(await sumNow("本月收入"), "¥0.00", "本月收入也没被算成 0 以外的数");
    eq(await sumNow("账户总余额"), "¥900.00", "账户总余额没变（钱只是换了账户待着）");

    const saved = JSON.parse(fs.readFileSync(dataFile, "utf8")).finance.transfers;
    eq(saved.length, 1, "数据文件里多了一条转账");
    eq(saved[0].amountCents, 25000, "存的是整数分 25000");
    eq(saved[0].fromAccountId + "→" + saved[0].toAccountId, "acc-wx→acc-bank", "从微信到银行卡");
    eq(
      JSON.parse(fs.readFileSync(dataFile, "utf8")).finance.transactions.length, 1,
      "账目那条数没变（转账没混进 transactions）"
    );

    /* ---- 当日明细里看得见 ---- */
    console.log("\n当日明细：转账单列一块，不带 + / −");
    let tfs = await transferRowsNow();
    eq(tfs.length, 1, "明细里有转账那一行");
    eq(tfs[0].meta, "微信 → 银行卡", "写着「从 → 到」");
    eq(tfs[0].amount, "¥250.00", "金额不带 + / −（它不是收支）");

    /* ---- 从 / 到 不能一样 ---- */
    console.log("\n「从」和「到」选成同一个账户：当场拦下来");
    await ev("document.querySelector('[data-act=\"tf-add\"]').click()");
    await waitFor("!!document.querySelector('#tx-from')", 5000);
    await fillTransfer({ amount: "100", from: "acc-wx", to: "acc-wx" });
    await clickDialog("save");
    dlg = await dialogNow();
    ok(dlg.hasFrom, "弹窗没关（还停在转账表单上）");
    eq(dlg.toErrHidden, false, "「到」下面露出错误行");
    ok((dlg.toErr || "").includes("同一个账户"), "错误写的是「不能是同一个账户」（" + dlg.toErr + "）");
    eq(
      JSON.parse(fs.readFileSync(dataFile, "utf8")).finance.transfers.length, 1,
      "数据文件里没多出第二条（拦在保存之前）"
    );
    await clickDialog("cancel");

    /* ---- 编辑：改金额 ---- */
    console.log("\n编辑那条转账：改成 100，余额跟着改");
    ok(
      await ev("(()=>{const b=document.querySelector('#fin-day .fin-row.is-transfer [data-act=\"tf-edit\"]');" +
        "if(!b)return false;b.click();return true;})()"),
      "明细里有「编辑」按钮"
    );
    ok(await waitFor("!!document.querySelector('#tx-from')", 5000), "打开的是转账表单");
    eq((await dialogNow()).tab, "转账", "编辑转账时也停在转账页签");
    eq(await ev("document.querySelector('#tx-amount').value"), "250.00", "金额回填 250.00");
    await fillTransfer({ amount: "100" });
    await clickDialog("save");
    await sleep(400);
    accs = await accountsNow();
    eq(accs[0].balance, "余额 ¥800.00", "微信：900 − 100");
    eq(accs[1].balance, "余额 ¥100.00", "银行卡：0 + 100");
    eq(await sumNow("本月支出"), "¥100.00", "本月支出还是 ¥100.00");

    /* ---- 删除：回到原样 ---- */
    console.log("\n删掉那条转账：余额回到原样");
    await ev("document.querySelector('#fin-day .fin-row.is-transfer [data-act=\"tf-del\"]').click()");
    await sleep(300);
    // 确认框那两颗按钮用的是 data-dlg="yes" / "no"（和编辑弹窗的 data-dlg-act 不是一套）
    const confirmed = await ev(`(()=>{
      const btn=document.querySelector('.dlg-backdrop [data-dlg="yes"]');
      if(!btn) return false;
      btn.click();
      return true;
    })()`);
    ok(confirmed, "弹出确认框并点了「删除」");
    await sleep(500);
    accs = await accountsNow();
    eq(accs[0].balance, "余额 ¥900.00", "微信回到 900");
    eq(accs[1].balance, "余额 ¥0.00", "银行卡回到 0");
    eq(await transferRowsNow().then((r) => r.length), 0, "当日明细里那条转账没了");
    eq(
      JSON.parse(fs.readFileSync(dataFile, "utf8")).finance.transfers.length, 0,
      "数据文件里也删掉了"
    );
    eq(await sumNow("本月支出"), "¥100.00", "本月支出自始至终都是 ¥100.00");

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
        path.basename(full).startsWith("小李-转账-")) {
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

/* 常用账目模板的真浏览器回归测试：在「记一笔」里把填好的存成模板 →
 * 页头下面冒出那颗胶囊 → 点它，弹窗里金额 / 分类 / 账户 / 备注都填好了 →
 * 保存成正常一笔；同一个再存一次会提示「已经有了」；× 把模板删掉。
 *
 * 为什么单独有一份：模板是「存下来 → 下次一点就填好」的闭环，纯逻辑那份盯的是
 * 怎么去重 / 怎么限量（tests\记账计算.test.mjs），盯不住「弹窗里的按钮真存进去没、
 * 点胶囊真回填没、存完模板会不会跟着多一份」。
 *
 * 跑法：node tests\记账模板.test.mjs
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

/** 页面上常用模板那一条此刻的样子 */
const stripNow = () =>
  ev(`(()=>{
    const strip=document.querySelector('.fin-tplstrip');
    if(!strip) return null;
    return [...strip.querySelectorAll('.fin-tpl')].map(el=>({
      label:(el.querySelector('.fin-tpl-fill')||{}).textContent || "",
      title:(el.querySelector('.fin-tpl-fill')||{}).title || "",
      id:(el.querySelector('.fin-tpl-fill')||{}).dataset ? el.querySelector('.fin-tpl-fill').dataset.id : "",
    }));
  })()`);

/** 弹窗里现在填的是什么 */
const dialogNow = () =>
  ev(`(()=>{
    const amount=document.querySelector('#tx-amount');
    if(!amount) return null;
    const activeCat=document.querySelector('.fin-cat-pick.active');
    const acc=document.querySelector('#tx-account');
    return {
      amount: amount.value,
      category: activeCat ? activeCat.textContent.trim() : "",
      account: acc ? (acc.selectedOptions[0] || {}).textContent || "" : "",
      note: (document.querySelector('#tx-note')||{}).value || "",
      hasTplSave: !!document.querySelector('[data-dlg-act="tpl-save"]'),
    };
  })()`);

/** 填「记一笔」表单：金额 / 备注直接给值；分类点那颗按钮；账户选一下 */
async function fillTx({ amount, note, category, accountId }) {
  await ev(`(()=>{
    const a=document.querySelector('#tx-amount');
    if(a) a.value=${JSON.stringify(String(amount))};
    const n=document.querySelector('#tx-note');
    if(n) n.value=${JSON.stringify(String(note))};
    const acc=document.querySelector('#tx-account');
    if(acc && ${JSON.stringify(accountId || "")}) acc.value=${JSON.stringify(String(accountId || ""))};
    return true;
  })()`);
  if (category) {
    await ev(`(()=>{
      const b=[...document.querySelectorAll('.fin-cat-pick')]
        .find(x=>x.textContent.includes(${JSON.stringify(category)}));
      if(!b) return false;
      b.click();
      return true;
    })()`);
  }
  await sleep(150);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-记账模板-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const today = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const dataFile = path.join(dataDir, "数据.json");

  // 一开始一笔账、一个模板都没有：模板那一条应该整条不出现
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1,
      rev: 0,
      memo: "",
      finance: {
        accounts: [
          { id: "acc-wx", name: "微信", initialBalanceCents: 0 },
          { id: "acc-bank", name: "银行卡", initialBalanceCents: 0 },
        ],
        transactions: [],
        transfers: [],
        templates: [],
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
    ok(await waitFor("!!document.querySelector('[data-act=\"add\"]')", 15000), "记账页起来了");

    /* ---- 一个模板都没有时不占地方 ---- */
    console.log("\n还没有模板：那一条不出现");
    eq(await stripNow(), null, "没有模板时整条不显示");

    /* ---- 在「记一笔」里存成模板 ---- */
    console.log("\n把填好的一笔存成模板：弹窗不关，数据里多一个模板");
    await ev("document.querySelector('[data-act=\"add\"]').click()");
    ok(await waitFor("!!document.querySelector('#tx-amount')", 5000), "弹窗开了");
    let dlg = await dialogNow();
    ok(dlg.hasTplSave, "弹窗里有「存成模板」按钮");
    await fillTx({ amount: "25.50", note: "午饭 黄焖鸡", category: "餐饮", accountId: "acc-wx" });
    await clickDialog("tpl-save");
    eq(await ev("!!document.querySelector('#tx-amount')"), true,
      "存完模板弹窗还开着（接着保存这一笔）");
    let tpls = readData(dataFile).finance.templates;
    eq(tpls.length, 1, "数据文件里多了一个模板");
    eq(tpls[0].amountCents, 2550, "金额记的是整数分");
    eq(tpls[0].category, "餐饮", "分类也在");
    eq(tpls[0].accountId, "acc-wx", "账户也在");
    eq(tpls[0].note, "午饭 黄焖鸡", "备注也在");
    eq(tpls[0].date, undefined, "日期不进模板（用哪天的就是哪天的）");

    /* ---- 关掉弹窗：页面上出现那颗胶囊 ---- */
    console.log("\n关掉弹窗：页头下面出现那颗胶囊");
    await clickDialog("cancel");
    ok(await waitFor("!!document.querySelector('.fin-tplstrip')", 5000), "常用那一条出现了");
    let strip = await stripNow();
    eq(strip.length, 1, "上面有一颗胶囊");
    eq(strip[0].label, "午饭 黄焖鸡", "胶囊上写的是备注");
    ok(strip[0].title.includes("支出") && strip[0].title.includes("餐饮"), "移上去能看到是支出·餐饮（" + strip[0].title + "）");

    /* ---- 点胶囊：弹窗填好 ---- */
    console.log("\n点一下胶囊：弹窗里金额 / 分类 / 账户 / 备注都填好了");
    await ev("document.querySelector('.fin-tpl-fill').click()");
    ok(await waitFor("!!document.querySelector('#tx-amount')", 5000), "弹窗开了");
    dlg = await dialogNow();
    eq(dlg.amount, "25.50", "金额填好了");
    ok(dlg.category.includes("餐饮"), "分类也选中了（按钮上带个小图标：" + dlg.category + "）");
    eq(dlg.account, "微信", "账户也选好了");
    eq(dlg.note, "午饭 黄焖鸡", "备注也填好了");

    console.log("\n点保存：正常记成一笔，模板不会跟着多一份");
    await clickDialog("save");
    await sleep(400);
    const data = readData(dataFile);
    eq(data.finance.transactions.length, 1, "账目里多了一笔");
    eq(data.finance.transactions[0].amountCents, 2550, "存的是这笔的金额");
    eq(data.finance.templates.length, 1, "模板还是那一个（没跟着多）");

    /* ---- 再存同样的：提示已经有了 ---- */
    console.log("\n同样的再存一次：提示「已经有了」，不重复加");
    await ev("document.querySelector('[data-act=\"add\"]').click()");
    await waitFor("!!document.querySelector('#tx-amount')", 5000);
    await fillTx({ amount: "25.50", note: "午饭 黄焖鸡", category: "餐饮", accountId: "acc-wx" });
    await clickDialog("tpl-save");
    eq(readData(dataFile).finance.templates.length, 1, "模板还是一个");
    await clickDialog("cancel");

    /* ---- 尾号 × 删掉模板 ---- */
    console.log("\n点胶囊尾巴的 ×：确认之后模板没了，账目一笔不动");
    await ev("document.querySelector('.fin-tpl-del').click()");
    ok(await waitFor("!!document.querySelector('.dlg-backdrop [data-dlg=\"yes\"]')", 5000),
      "弹出确认框");
    await ev("document.querySelector('.dlg-backdrop [data-dlg=\"yes\"]').click()");
    await waitFor("!document.querySelector('.fin-tplstrip')", 5000);
    await sleep(400);   // 等落盘写完再读文件
    eq(await stripNow(), null, "常用那一条又收起来了");
    const after = readData(dataFile);
    eq(after.finance.templates.length, 0, "模板删掉了");
    eq(after.finance.transactions.length, 1, "已经记下的那笔一笔不动");

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
        path.basename(full).startsWith("小李-记账模板-")) {
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

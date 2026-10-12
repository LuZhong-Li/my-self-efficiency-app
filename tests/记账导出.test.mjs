/* 记账「导出 CSV」的真浏览器回归测试：点那个按钮 → 选范围 → 浏览器真的下载一份文件 →
 * 把它读出来逐项核对（表头、BOM、金额格式、备注里的逗号引号、转账两列、月份范围）。
 *
 * 为什么单独有一份：CSV 这东西「看着对」和「真能用」差得远 —— 少一个 BOM，Excel 打开
 * 就是一堆乱码；备注里的逗号没裹引号，整行就串列。这些只有真下载一次、真读一遍文件
 * 才验得到（纯逻辑那份盯的是拼接规则，盯不住「点了按钮到底下没下下来」）。
 *
 * 跑法：node tests\记账导出.test.mjs
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

/** 等下载目录里出现一个 .csv，返回它的路径与内容（去掉 BOM 后的文本） */
async function waitCsv(dir, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const files = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      .filter((f) => f.toLowerCase().endsWith(".csv"));
    if (files.length) {
      const full = path.join(dir, files[0]);
      let text = "";
      try {
        text = fs.readFileSync(full, "utf8");
      } catch {
        text = "";   // 还在写，下一轮再看
      }
      if (text) return { name: files[0], text, raw: text.charCodeAt(0) === 0xfeff };
    }
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}

/** 弹窗底部那颗按钮（导出这个月 / 导出全部 / 取消） */
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-记账导出-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  const dlDir = path.join(tmp, "下载");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(dlDir, { recursive: true });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (x) => x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate());
  const today = ymd(d);
  const month = today.slice(0, 7);
  const lastMonthDate = new Date(d.getFullYear(), d.getMonth() - 1, 15);   // 上个月 15 号
  const lastMonth = ymd(lastMonthDate);

  // 三笔账 + 一条转账：这个月两笔（其中一笔备注里带逗号和引号）、上个月一笔。
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
            id: "tx-1", type: "expense", amountCents: 2550, date: today,
            category: "餐饮", accountId: "acc-wx", note: '午饭 "A, B" 套餐', imagePaths: [],
            createdAt: today + " 12:30",
          },
          {
            id: "tx-2", type: "income", amountCents: 200000, date: today,
            category: "工资", accountId: "acc-bank", note: "", imagePaths: [],
            createdAt: today + " 09:00",
          },
          {
            id: "tx-3", type: "expense", amountCents: 100, date: lastMonth,
            category: "其他", accountId: "acc-wx", note: "上个月那笔", imagePaths: [],
            createdAt: lastMonth + " 08:00",
          },
        ],
        transfers: [
          {
            id: "tf-1", amountCents: 25000, date: today, fromAccountId: "acc-wx",
            toAccountId: "acc-bank", note: "还信用卡", imagePaths: [],
            createdAt: today + " 10:00",
          },
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

    // 让它把下载直接落到我们指定的目录里（无头模式下默认不弹「另存为」）
    try {
      await cdp.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: dlDir,
        eventsEnabled: true,
      });
    } catch {
      await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir });
    }

    await cdp.send("Page.navigate", { url: base + "#finance" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(
      await waitFor("!!document.querySelector('[data-act=\"csv\"]')", 15000),
      "记账页头上有「导出 CSV」按钮"
    );

    /* ---- 点按钮：先问导哪些 ---- */
    console.log("\n点「导出 CSV」：先弹一句问导哪些");
    await ev("document.querySelector('[data-act=\"csv\"]').click()");
    ok(await waitFor("!!document.querySelector('[data-dlg-act=\"csv-all\"]')", 5000),
      "弹窗里有「导出全部」");
    const dlgText = await ev("document.querySelector('.dlg').textContent.replace(/\\s+/g,' ')");
    ok(dlgText.includes("一共 4 条"), "说明里写了总数（3 笔账 + 1 条转账：" + dlgText.slice(0, 60) + "…）");
    ok(dlgText.includes("下载"), "说明里交代了文件落在下载文件夹");

    /* ---- 导出全部 ---- */
    console.log("\n导出全部：文件真的下来了，内容逐项对得上");
    await clickDialog("csv-all");
    let csv = await waitCsv(dlDir);
    ok(Boolean(csv), "下载目录里出现了 .csv 文件");
    if (!csv) return;
    ok(csv.raw, "开头是 UTF-8 BOM（Excel 打开中文不乱码）");
    ok(csv.name.startsWith("记账-") && csv.name.endsWith("全部.csv"),
      "文件名带日期和范围（" + csv.name + "）");

    const lines = csv.text.replace(/^\ufeff/, "").split("\r\n");
    eq(lines[0], "日期,类型,分类,金额,账户,到账账户,备注", "第一行是表头");
    eq(lines.filter(Boolean).length, 5, "表头 + 四行数据");
    ok(lines.some((l) => l.startsWith(lastMonth) && l.includes("上个月那笔")),
      "导出全部：上个月那笔也在");
    ok(lines.some((l) => l === `${today},支出,餐饮,25.50,微信,,"午饭 ""A, B"" 套餐"`),
      "支出那行：金额两位小数、备注里的逗号和引号都照顾到了");
    ok(lines.some((l) => l === `${today},收入,工资,2000.00,银行卡,,`),
      "收入那行：账户名写的是名字不是 id");
    ok(lines.some((l) => l === `${today},转账,,250.00,微信,银行卡,还信用卡`),
      "转账那行：分类留空，转出 / 转入各一列");

    /* ---- 导出这个月 ---- */
    console.log("\n导出这个月：上个月那笔不在里面");
    fs.rmSync(path.join(dlDir, csv.name));   // 先把这个文件挪开，免得下一轮又读到它
    await ev("document.querySelector('[data-act=\"csv\"]').click()");
    await waitFor("!!document.querySelector('[data-dlg-act=\"csv-month\"]')", 5000);
    await clickDialog("csv-month");
    csv = await waitCsv(dlDir);
    ok(Boolean(csv), "又下下来一份");
    if (!csv) return;
    ok(csv.name.endsWith(month + ".csv"), "文件名带上了月份（" + csv.name + "）");
    const monthLines = csv.text.replace(/^\ufeff/, "").split("\r\n").filter(Boolean);
    eq(monthLines.length, 4, "表头 + 这个月的三行");
    eq(monthLines.some((l) => l.includes("上个月那笔")), false, "上个月那笔没进来");
    eq(monthLines.some((l) => l.includes("还信用卡")), true, "这个月的转账在");

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
        path.basename(full).startsWith("小李-记账导出-")) {
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

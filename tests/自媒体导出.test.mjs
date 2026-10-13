/* 自媒体「导出 CSV」的真浏览器回归测试：点那颗按钮 → 选范围 → 浏览器真下载一份文件 →
 * 逐行核对（BOM、12 列表头、发布日 / 排期日、账号名、数字、月份范围）。
 *
 * 为什么单独有一份：纯逻辑那份（tests\自媒体计算.test.mjs 的 contentCsvRows）盯的是
 * 「每行填什么、怎么排」，盯不住「点了按钮到底下没下下来、下下来的文件里对不对」。
 *
 * 跑法：node tests\自媒体导出.test.mjs
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

/** 等下载目录里出现一个 .csv，返回文件名与内容 */
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
        text = "";
      }
      if (text) return { name: files[0], text, raw: text.charCodeAt(0) === 0xfeff };
    }
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}

async function clickDialog(act) {
  const done = await ev(
    "(()=>{const b=document.querySelector('[data-dlg-act=\"" + act + "\"]');" +
      "if(!b)return false;b.click();return true;})()"
  );
  await sleep(350);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-自媒体导出-"));
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
  const lastMonth = ymd(new Date(d.getFullYear(), d.getMonth() - 1, 15));

  // 三条作品：本月已发布（带数据）、本月待发布（只有排期日）、上个月已发布
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
      contents: [
        { id: "w1", accountId: "acc-a", platform: "B站", title: "第一条", status: "已发布",
          planDate: month + "-01", publishDate: month + "-02", link: "https://b23.tv/x",
          views: 12000, likes: 300, comments: 20, collects: 88, fansGain: 15,
          note: '脚本要点 "A, B"', createdAt: month + "-02 20:00" },
        { id: "w2", accountId: "acc-a", platform: "B站", title: "还没发的选题", status: "待发布",
          planDate: month + "-28", publishDate: "", link: "",
          views: 0, likes: 0, comments: 0, collects: 0, fansGain: 0,
          note: "素材在桌面", createdAt: month + "-03 09:00" },
        { id: "w3", accountId: "acc-a", platform: "B站", title: "上个月的老作品", status: "已发布",
          planDate: "", publishDate: lastMonth, link: "",
          views: 500, likes: 10, comments: 1, collects: 2, fansGain: 3,
          note: "", createdAt: lastMonth + " 10:00" },
      ],
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

    try {
      await cdp.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: dlDir,
        eventsEnabled: true,
      });
    } catch {
      await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir });
    }

    await cdp.send("Page.navigate", { url: base + "#media" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor("!!document.querySelector('[data-act=\"csv\"]')", 15000),
      "自媒体页头上有「导出 CSV」按钮");

    /* ---- 先问导哪些 ---- */
    console.log("\n点「导出 CSV」：先弹一句问导哪些");
    await ev("document.querySelector('[data-act=\"csv\"]').click()");
    ok(await waitFor("!!document.querySelector('[data-dlg-act=\"csv-all\"]')", 5000),
      "弹窗里有「导出全部」");
    const dlgText = await ev("document.querySelector('.dlg').textContent.replace(/\\s+/g,' ')");
    ok(dlgText.includes("一共 3 条"), "说明里写了总数（" + dlgText.slice(0, 50) + "…）");
    ok(dlgText.includes("这个月 2 条"), "也写了这个月几条");
    ok(dlgText.includes("12 列"), "交代了有哪些列");

    /* ---- 导出全部 ---- */
    console.log("\n导出全部：文件真下来了，逐行核对");
    await clickDialog("csv-all");
    let csv = await waitCsv(dlDir);
    ok(Boolean(csv), "下载目录里出现了 .csv 文件");
    if (!csv) return;
    ok(csv.raw, "开头是 UTF-8 BOM");
    ok(csv.name.startsWith("自媒体-") && csv.name.endsWith("全部.csv"), "文件名带范围（" + csv.name + "）");
    const lines = csv.text.replace(/^\ufeff/, "").split("\r\n").filter(Boolean);
    eq(lines[0], "日期,状态,标题,平台,账号,播放,点赞,评论,收藏,涨粉,链接,备注", "第一行是 12 列表头");
    eq(lines.length, 4, "表头 + 三条作品");
    ok(lines.some((l) => l === `${month}-02,已发布,第一条,B站,B站小李,12000,300,20,88,15,https://b23.tv/x,"脚本要点 ""A, B"""`),
      "已发布那条：日期是发布日、账号名、各数字、备注里的引号逗号都对");
    ok(lines.some((l) => l === `${month}-28,待发布,还没发的选题,B站,B站小李,0,0,0,0,0,,素材在桌面`),
      "待发布那条：日期用的是排期日，数据列是 0");
    ok(lines.some((l) => l.startsWith(lastMonth + ",已发布,上个月的老作品")), "上个月那条也在（导出全部）");

    /* ---- 导出这个月 ---- */
    console.log("\n导出这个月：上个月那条不在里面");
    fs.rmSync(path.join(dlDir, csv.name));
    await ev("document.querySelector('[data-act=\"csv\"]').click()");
    await waitFor("!!document.querySelector('[data-dlg-act=\"csv-month\"]')", 5000);
    await clickDialog("csv-month");
    csv = await waitCsv(dlDir);
    ok(Boolean(csv), "又下下来一份");
    if (!csv) return;
    ok(csv.name.endsWith(month + ".csv"), "文件名带上了月份（" + csv.name + "）");
    const monthLines = csv.text.replace(/^\ufeff/, "").split("\r\n").filter(Boolean);
    eq(monthLines.length, 3, "表头 + 这个月两条");
    eq(monthLines.some((l) => l.includes("上个月的老作品")), false, "上个月那条没进来");
    eq(monthLines.some((l) => l.includes("还没发的选题")), true, "排期在这个月的那条在（哪怕还没发）");

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
        path.basename(full).startsWith("小李-自媒体导出-")) {
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

/* 热量营养的真浏览器回归测试：菜谱库加一样（米饭 1 碗 200 千卡）→ 早餐加一条
 * （选库里的名字自动带出营养、份数填 1.5）→ 今日营养卡与条目行上的数对得上 →
 * 每日目标就地填、超了标红 → 近 7 天柱状图 → 改份数、删条目 → 数字跟着降。
 *
 * 为什么单独有一份：纯逻辑那份（tests\饮食计算.test.mjs）盯的是换算与档位，
 * 盯不住「菜谱库子页切得过去没、选名字真把营养带出来了没、
 * 条目到底挂到哪一天去了、目标输入框存进 settings 没」。
 *
 * 跑法：node tests\饮食热量.test.mjs
 *   要 Node 22+（内置 fetch / WebSocket 直接说 CDP，不装 puppeteer）；
 *   要本机有 Edge（找不到会退回 Chrome，也可以用 EDGE_PATH 指一个）。
 *   全程在一个临时数据目录里跑，不碰 数据\数据.json，跑完自己清干净。
 * 说明：和别的 .test.mjs 一样不进「自检.cmd」——自检保持纯 Python。
 *      这台机器上没有浏览器 / Python 时打印「跳过」并以 0 退出，免得换台电脑一跑就红。
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

const readData = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** 往弹窗里几个框填值 */
const setDialog = (map) =>
  ev("(()=>{const set=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v;};" +
     Object.entries(map).map(([k, v]) => "set('" + k + "','" + v + "');").join("") +
     "return true;})()");

/** 今日营养卡上那句「已吃 X / 目标 Y 千卡」 */
const nuText = () =>
  ev('document.querySelector(".nu-kcal").textContent.replace(/\\s+/g," ").trim()');

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-饮食热量-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const dataFile = path.join(dataDir, "数据.json");
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1, rev: 0, memo: "",
      foods: [], meals: [], water: [],
      tasks: [], projects: [], trash: [], settings: {},
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
    await cdp.send("DOM.enable");
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    await cdp.send("Page.navigate", { url: base + "#diet/foods" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor('!!document.querySelector(\'[data-act="food-add"]\')', 15000),
      "菜谱库子页起来了");
    ok(await ev('!!document.querySelector(".food-empty")'), "一开始是空状态");

    /* ---- 加一样菜谱 ---- */
    console.log("\n加一样菜谱：米饭 1 碗 200 千卡");
    await ev('document.querySelector(\'[data-act="food-add"]\').click()');
    ok(await waitFor('!!document.getElementById("item-kcal")', 5000), "加菜谱的弹窗开了");
    await setDialog({ "item-name": "米饭", "item-unit": "碗", "item-kcal": "200",
      "item-protein": "4", "item-fat": "0.5", "item-carb": "44" });
    await ev('document.querySelector(\'[data-dlg-act="save"]\').click()');
    await sleep(400);
    const food = readData(dataFile).foods[0];
    ok(Boolean(food), "菜谱存进了数据");
    eq(food.kcal, 200, "热量是数字");
    eq(food.fat, 0.5, "脂肪能是小数");
    ok(await ev('!!document.querySelector(".food-row")'), "列表里出现了这一样");
    eq(await ev('document.querySelector(".food-row .i-title").textContent'), "米饭", "行上写着名字");

    /* ---- 回饮食页，早餐加一条：选名字自动带出营养 ---- */
    console.log("\n早餐加一条：选「米饭」自动带出 200 千卡，份数 1.5");
    await ev('location.hash = "#diet"');
    await waitFor('!!document.querySelector(\'[data-act="mi-add"]\')', 8000);
    await ev('document.querySelector(\'.meal-row[data-slot-row="breakfast"] [data-act="mi-add"]\').click()');
    await waitFor('!!document.getElementById("item-name")', 5000);
    eq(await ev('document.getElementById("item-slot").value'), "早餐", "默认就是早餐");
    await ev('(()=>{const el=document.getElementById("item-name");el.value="米饭";' +
      'el.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
    await sleep(150);
    eq(await ev('document.getElementById("item-kcal").value'), "200",
      "选了库里的名字，每份热量自动带出来了");
    eq(await ev('document.getElementById("item-unit").value'), "碗", "单位也带出来了");
    await setDialog({ "item-amount": "1.5" });
    await ev('document.querySelector(\'[data-dlg-act="save"]\').click()');
    await sleep(500);
    const item = readData(dataFile).meals[0].items[0];
    ok(Boolean(item), "条目挂到了那一天的记录上");
    eq(item.slot, "breakfast", "餐次是键（breakfast）");
    eq(item.name, "米饭", "名字留着");
    eq(item.amount, 1.5, "份数是小数");
    eq(item.kcal, 200, "存的是「每 1 份」的热量（不是乘完的 300）");
    eq(await ev('document.querySelector(".meal-item .mi-kcal").textContent'), "300 千卡",
      "行上显示的是乘完的数（1.5 × 200）");

    /* ---- 今日营养卡：数字、进度、超标标红 ---- */
    console.log("\n今日营养卡：先看「还差多少」，再改目标看「超了多少」");
    ok((await nuText()).includes("300"), "已吃 300 千卡（" + (await nuText()) + "）");
    eq(await ev('document.querySelector(".nu-state").classList.contains("none")'), true,
      "没设目标时是 none（只报数、不画进度）");
    await ev('(()=>{const el=document.getElementById("nu-target-kcal");el.value="2000";' +
      'el.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
    await sleep(400);
    eq(readData(dataFile).settings.nutritionTarget.kcal, 2000, "目标存进了 settings");
    ok((await ev('document.querySelector(".nu-state").textContent')).includes("还差"),
      "写着「还差多少」：" + (await ev('document.querySelector(".nu-state").textContent')));
    await ev('(()=>{const el=document.getElementById("nu-target-kcal");el.value="200";' +
      'el.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
    await sleep(400);
    const overText = await ev('document.querySelector(".nu-state").textContent');
    ok(overText.includes("超了") && overText.includes("100"), "超了 100（" + overText + "）");
    eq(await ev('document.querySelector(".nu-state").classList.contains("over")'), true,
      "超标那行带上 over（页面标红）");

    /* ---- 近 7 天柱状图 ---- */
    console.log("\n近 7 天柱状图：7 根柱，今天那根有高度");
    ok(await waitFor('!!document.querySelector(".chart-trend")', 6000), "柱状图出来了");
    eq(await ev('document.querySelectorAll(".chart-trend-bar").length'), 7, "7 根柱");
    ok((await ev('Number([...document.querySelectorAll(".chart-trend-bar")][6]' +
      '.querySelector("rect").getAttribute("height"))')) > 0, "今天那根有高度");

    /* ---- 改份数与删条目 ---- */
    console.log("\n改份数 → 数字跟着降；删掉这条 → 回到空");
    await ev('document.querySelector(\'.meal-item [data-act="mi-edit"]\').click()');
    await waitFor('!!document.getElementById("item-amount")', 5000);
    eq(await ev('document.getElementById("item-amount").value'), "1.5", "编辑回填份数");
    await setDialog({ "item-amount": "1" });
    await ev('document.querySelector(\'[data-dlg-act="save"]\').click()');
    await sleep(500);
    ok((await nuText()).includes("200"), "份数改成 1 → 已吃 200（" + (await nuText()) + "）");
    await ev('document.querySelector(\'.meal-item [data-act="mi-del"]\').click()');
    await waitFor('!!document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\')', 5000);
    await ev('document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\').click()');
    await sleep(400);
    eq(readData(dataFile).meals[0].items.length, 0, "条目删掉了");
    ok((await nuText()).includes("0"), "已吃回到 0（" + (await nuText()) + "）");

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
        path.basename(full).startsWith("小李-饮食热量-")) {
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

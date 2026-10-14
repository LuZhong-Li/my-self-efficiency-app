/* 重复任务的真浏览器回归测试：建一条「每天」的规则 → 卡片里出现它、写着「下次：…」→
 * 今天那条也自动生成了（带「重复任务」标记）→ 再进一次页面不会多生成一条 →
 * 勾上它再进来还是勾着的 → 把它删掉、重进也不会自己回来（lastRun 生效）→
 * 规则上带子任务时，生成出来的那条也带着同一份清单 → 删规则时确认框写明生成的待办留着。
 *
 * 为什么单独有一份：纯逻辑那份（tests\待办联动.test.mjs）盯的是「今天该补哪几条」，
 * 盯不住「进页面真对表没、删掉的会不会自己回来、卡片上的「下次」算对没、
 * 规则和的弹窗真存进数据没」。这些只有真跑一遍才算验过。
 *
 * 跑法：node tests\重复任务.test.mjs
 *   要 Node 22+（内置 fetch / WebSocket 直接说 CDP，不装 puppeteer）；
 *   要本机有 Edge（找不到会退回 Chrome，也可以用 EDGE_PATH 指一个）。
 *   全程在一个临时数据目录里跑，不碰 数据\数据.json，跑完自己清干净。
 * 说明：和别的 .test.mjs 一样不进「自检.cmd」——自检保持纯 Python。
 *      这台机器上没有浏览器 / Python 时打印「跳过」并以 0 退出，
 *      免得换台电脑一跑就红（跳过不等于通过，别把它当成绿灯）。
 *
 * 规则一律用「每天」：跑测试那天是星期几不确定，写「每周一、三、五」就得赌今天。
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

async function setFields(map) {
  await ev(`(()=>{
    const set=(id,v)=>{const el=document.getElementById(id); if(el) el.value=v;};
    ${Object.entries(map)
      .map(([id, v]) => `set(${JSON.stringify(id)}, ${JSON.stringify(String(v))});`)
      .join("")}
    return true;
  })()`);
  await sleep(150);
}

async function clickDialog(act) {
  const done = await ev(
    "(()=>{const b=document.querySelector('[data-dlg-act=\"" + act + "\"]');" +
      "if(!b)return false;b.click();return true;})()"
  );
  await sleep(400);
  return done;
}

/** 回今日计划页：先绕一下首页再回来，等于「重新进一次页面」 */
async function backToPlan() {
  await ev('location.hash = "#home"');
  await sleep(300);
  await ev('location.hash = "#plan"');
  await waitFor('!!document.querySelector(\'[data-act="repeat-add"]\')', 8000);
  await sleep(200);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-重复任务-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const dataFile = path.join(dataDir, "数据.json");
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1, rev: 0, memo: "",
      tasks: [],
      projects: [], trash: [], settings: {},
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

    await cdp.send("Page.navigate", { url: base + "#plan" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor('!!document.querySelector(\'[data-act="repeat-add"]\')', 15000),
      "今日计划页上有「添加重复任务」");
    eq(await ev('document.querySelector(".repeat-card h2").textContent.trim()'), "重复任务（0 条）",
      "卡片头上写着几条");
    ok(await ev('!!document.querySelector(".repeat-card .empty")'), "一条都没有时给一句空状态");

    /* ---- 建一条「每天」的规则 ---- */
    console.log("\n添加一条重复任务：卡片里出现它，今天那条也生成了");
    await ev('document.querySelector(\'[data-act="repeat-add"]\').click()');
    ok(await waitFor('!!document.getElementById("item-repeat")', 5000),
      "规则弹窗开了（有「重复」那一格）");
    ok(!(await ev('!!document.querySelector(".dlg .attach-host")')),
      "规则弹窗里没有图片区（规则不存图）");
    await setFields({ "item-text": "散步", "item-repeat": "每天" });
    await ev('document.getElementById("item-repeat").dispatchEvent(new Event("input",{bubbles:true}))');
    await sleep(200);
    ok(await ev('document.querySelector(\'[data-rule-preview="repeat"]\').textContent.includes("每天")'),
      "下面那行实时预览写出了「每天」");
    await clickDialog("save");
    const rule = readData(dataFile).tasks.find((t) => t.repeat);
    ok(Boolean(rule), "规则存进了数据");
    eq(rule.date, "", "规则自己不占日期");
    eq(rule.lastRun, new Date().toISOString().slice(0, 10), "规则记下了「今天对过表」");
    await waitFor('!!document.querySelector(".repeat-item")', 5000);
    eq(await ev('document.querySelector(".repeat-item .r-text").textContent.trim()'), "散步",
      "卡片里列出了这条规则");
    eq(await ev('document.querySelector(".repeat-item .chip").textContent.trim()'), "每天",
      "规则那枚胶囊写的是「每天」");
    const hintText = await ev('document.querySelector(".repeat-item .hint").textContent');
    ok(/下次：\d{2}-\d{2}/.test(hintText), "写着「下次：…」这种（" + hintText + "）");

    const todayRow = () =>
      ev(`(()=>{
        const li=[...document.querySelectorAll('.tasks .task')]
          .find(x=>x.querySelector('.t-text') && x.querySelector('.t-text').textContent.trim()==='散步');
        return li ? { id: li.dataset.id, src: (li.querySelector('.t-src')||{}).textContent || "",
                      done: li.classList.contains('done') } : null;
      })()`);
    ok(await waitFor('[...document.querySelectorAll(\'.tasks .task\')].length > 0', 6000),
      "今天的清单里冒出了那条待办");
    let row1 = await todayRow();
    ok(Boolean(row1), "找得到「散步」那一条");
    eq(row1.src, "重复任务", "这条挂着「重复任务」的来源标记");
    eq(readData(dataFile).tasks.filter((t) => t.repeatId).length, 1, "只生成了一条");

    /* ---- 再进一次页面不会多生成 ---- */
    console.log("\n再进一次页面：不会多冒一条出来");
    await backToPlan();
    eq(readData(dataFile).tasks.filter((t) => t.repeatId).length, 1, "还是只有一条");

    /* ---- 勾上再进来，还是那条（状态没丢） ---- */
    console.log("\n勾上它，再进来还是这一条、还是勾着的");
    const id1 = (await todayRow()).id;
    const rowSel = '.tasks .task[data-id="' + id1 + '"]';
    await ev(`(()=>{
      const box=document.querySelector('${rowSel} input[data-act="toggle"]');
      box.checked=true;
      box.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    })()`);
    await sleep(300);
    eq(readData(dataFile).tasks.find((t) => t.id === id1).done, true, "那条勾上了、也落盘了");
    await backToPlan();
    eq(readData(dataFile).tasks.filter((t) => t.repeatId).length, 1, "勾完再进来也不会多一条");
    ok((await todayRow()).done, "再进来还是勾着的");

    /* ---- 删掉今天这条，重进不会自己回来 ---- */
    console.log("\n把今天这条删掉：重进页面它不会自己回来（lastRun 生效）");
    await ev(`document.querySelector('${rowSel} [data-act="delete"]').click()`);
    await waitFor('!!document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\')', 5000);
    await ev('document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\').click()');
    await sleep(400);
    eq(readData(dataFile).tasks.filter((t) => t.repeatId).length, 0, "今天这条进了回收站");
    await backToPlan();
    eq(readData(dataFile).tasks.filter((t) => t.repeatId).length, 0, "重进一次也不会自己回来");
    ok(await ev('!!document.querySelector(".repeat-item")'), "规则本身还在卡片里");

    /* ---- 规则带子任务：生成出来的那条也有清单 ---- */
    console.log("\n规则带子任务：生成出来的那一条也带着清单");
    await ev('document.querySelector(\'[data-act="repeat-add"]\').click()');
    ok(await waitFor('!!document.getElementById("item-repeat")', 5000), "规则弹窗又开了");
    await setFields({ "item-text": "交周报", "item-repeat": "每天" });
    await ev(`(()=>{
      const i=document.querySelector('.dlg .sub-input');
      i.value='写正文';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      return true;
    })()`);
    await sleep(200);
    await ev(`(()=>{
      const i=document.querySelector('.dlg .sub-input');
      i.value='发出去';
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      return true;
    })()`);
    await sleep(200);
    await clickDialog("save");
    ok(await waitFor('[...document.querySelectorAll(\'.tasks .task\')]' +
      '.some(x=>x.textContent.includes(\'交周报\') && x.querySelector(\'.sub-chip\'))', 6000),
      "生成出来的那条带着胶囊");
    eq(await ev('(()=>{const li=[...document.querySelectorAll(\'.tasks .task\')]' +
      '.find(x=>x.textContent.includes(\'交周报\'));' +
      'return li.querySelector(\'.sub-chip\').textContent.trim();})()'), "0/2",
      "生成出来的那条带着 0/2 的清单");
    eq(readData(dataFile).tasks.filter((t) => t.subtasks && t.subtasks.length).length, 2,
      "规则和生成出来那条各有一份清单（各自独立）");

    /* ---- 删规则：确认框写明生成的待办留着 ---- */
    console.log("\n删规则：确认框说清「生成的待办留着」");
    await ev('(()=>{const li=[...document.querySelectorAll(".repeat-item")]' +
      '.find(x=>x.textContent.includes("散步"));' +
      'li.querySelector(\'[data-act="repeat-del"]\').click();return true;})()');
    await waitFor('!!document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\')', 5000);
    const msg = await ev('document.querySelector(".dlg-copy p").textContent');
    ok(msg.includes("留在") && msg.includes("不会跟着消失"), "确认框写明了（" + msg.slice(0, 24) + "…）");
    await ev('document.querySelector(\'.dlg-backdrop [data-dlg="yes"]\').click()');
    await sleep(400);
    eq(readData(dataFile).tasks.filter((t) => t.repeat === "每天" && t.text === "散步").length, 0,
      "那条规则从 tasks 里挪走了");
    ok(readData(dataFile).trash.some((e) => e.table === "tasks" && e.label === "散步"),
      "规则进了回收站（不是直接抹掉）");
    ok(await ev('(()=>{const li=[...document.querySelectorAll(".repeat-item")]' +
      '.find(x=>x.textContent.includes("交周报"));return Boolean(li);})()'),
      "另一条规则还在卡片里（删的是选中的那条）");

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
        path.basename(full).startsWith("小李-重复任务-")) {
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

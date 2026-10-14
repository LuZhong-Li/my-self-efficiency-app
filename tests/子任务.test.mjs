/* 子任务的真浏览器回归测试：弹窗里加两条（回车加、不触发保存）→ 行上出现 0/2 →
 * 点一下就地展开 → 勾一条变 1/2 且父任务没完成 → 两条都勾上父任务自动完成 →
 * 取消一条父任务跟着取消 → 勾父任务两条一起勾上 → 首页和项目详情那两处也带同一枚胶囊。
 *
 * 为什么单独有一份：纯逻辑那份（tests\待办联动.test.mjs）盯的是清单进度和整体勾选，
 * 盯不住「回车会不会顺手把弹窗存了、那枚胶囊点得开没、展开的清单真看得见没、
 * 勾一处另外两处跟着变没」——这些只有真点一遍才算验过。
 *
 * 跑法：node tests\子任务.test.mjs
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

/** 往弹窗里那块子任务清单敲一条：填值 + 敲回车（回车该是「加下一条」，不是「保存」） */
async function addSubtask(text) {
  await ev(
    "(()=>{const i=document.querySelector('.dlg .sub-input');" +
      "if(!i) return false;" +
      "i.value=" + JSON.stringify(String(text)) + ";" +
      "i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));" +
      "return true;})()"
  );
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-子任务-"));
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
      projects: [{ id: "p1", name: "工作台", status: "进行中", intro: "", description: "",
                   startDate: "2026-10-01", expectEndDate: "", tags: [], imagePaths: [] }],
      trash: [], settings: {},
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
    ok(await waitFor('!!document.querySelector(\'[data-act="add"]\')', 15000), "今日计划页起来了");

    /* ---- 弹窗里加两条子任务：回车是「加下一条」，不是「保存」 ---- */
    console.log("\n弹窗里加两条子任务：回车加，别把弹窗关了");
    await ev('document.querySelector(\'[data-act="add"]\').click()');
    ok(await waitFor('!!document.getElementById("item-text")', 5000), "新增任务弹窗开了");
    ok(await ev('!!document.querySelector(\'[data-subtasks="subtasks"]\')'), "弹窗里有子任务那一块");
    await setFields({ "item-text": "把工作台改版做完" });
    await addSubtask("改侧栏");
    await addSubtask("改首页卡片");
    const afterTwo = await ev(`(()=>{
      const rows=[...document.querySelectorAll('.dlg .sub-list .subtask')];
      return { n: rows.length,
               texts: rows.map(li=>li.querySelector('.sub-text').textContent),
               dlgOpen: !!document.getElementById('item-text'),
               hidden: document.getElementById('item-subtasks').value };
    })()`);
    eq(afterTwo.n, 2, "回车两次加进去两条");
    eq(afterTwo.texts.join("、"), "改侧栏、改首页卡片", "两条的文字都对");
    ok(afterTwo.dlgOpen, "回车没把弹窗关掉（那是加下一条，不是保存）");
    ok(afterTwo.hidden.includes("改侧栏") && afterTwo.hidden.includes("改首页卡片"),
      "两条都写进了那条隐藏 input");
    await clickDialog("save");
    const saved = readData(dataFile).tasks[0];
    eq(saved.subtasks.length, 2, "存进数据的是一份两条的清单");
    eq(saved.subtasks[0].done, false, "新加的都没勾");
    ok(Boolean(saved.subtasks[0].id), "每条都有自己的 id（勾选框靠它认人）");

    /* ---- 行上的胶囊 + 就地展开 ---- */
    const sel = '.task[data-id="' + saved.id + '"]';
    const chipNow = () =>
      ev(`(()=>{
        const li=document.querySelector('${sel}');
        const c=li && li.querySelector('.sub-chip');
        return { chip: c ? c.textContent.trim() : "",
                 open: !!li && li.classList.contains('sub-open'),
                 done: !!li && li.classList.contains('done') };
      })()`);
    console.log("\n行上出现 0/2，点一下就地展开清单");
    let v = await chipNow();
    eq(v.chip, "0/2", "行上那枚胶囊写着 0/2");
    await ev(`document.querySelector('${sel} .sub-chip').click()`);
    await sleep(200);
    v = await chipNow();
    ok(v.open, "点完这一行展开了（加了 sub-open）");
    eq(await ev(`document.querySelectorAll('${sel} .subtasks .subtask').length`), 2,
      "展开后看得到两条");
    eq(await ev(`getComputedStyle(document.querySelector('${sel} .subtasks')).display !== "none"`),
      true, "展开的清单是真看得见（不只是加了个 class）");

    /* ---- 父子联动：子 → 父 ---- */
    const checkSub = (i, on) =>
      ev(`(()=>{
        const box=document.querySelectorAll('${sel} .subtasks .subtask input[type=checkbox]')[${i}];
        box.checked=${on ? "true" : "false"};
        box.dispatchEvent(new Event('change',{bubbles:true}));
        return true;
      })()`);
    console.log("\n勾一条子任务：1/2，父任务先别完成");
    await checkSub(0, true);
    await sleep(300);
    v = await chipNow();
    eq(v.chip, "1/2", "胶囊跟着变 1/2");
    eq(v.done, false, "只有一条子任务勾上时，父任务不算完成");
    console.log("\n两条都勾上：2/2，父任务自动完成");
    await checkSub(1, true);
    await sleep(300);
    v = await chipNow();
    eq(v.chip, "2/2", "胶囊 2/2");
    eq(v.done, true, "子任务全勾上 → 父任务自动完成");
    console.log("\n取消一条：父任务跟着取消");
    await checkSub(0, false);
    await sleep(300);
    v = await chipNow();
    eq(v.chip, "1/2", "胶囊回到 1/2");
    eq(v.done, false, "父任务跟着取消");

    /* ---- 父子联动：父 → 子 ---- */
    console.log("\n勾父任务：两条子任务一起勾上；取消父任务：两条一起取消");
    const checkParent = (on) =>
      ev(`(()=>{
        const box=document.querySelector('${sel} input[data-act="toggle"]');
        box.checked=${on ? "true" : "false"};
        box.dispatchEvent(new Event('change',{bubbles:true}));
        return true;
      })()`);
    await checkParent(true);
    await sleep(300);
    v = await chipNow();
    eq(v.chip, "2/2", "勾父任务 → 子任务全勾上");
    eq(v.done, true, "父任务自己也是完成的");
    await checkParent(false);
    await sleep(300);
    v = await chipNow();
    eq(v.chip, "0/2", "取消父任务 → 子任务全取消");
    eq(v.done, false, "父任务自己也不是完成的");

    /* ---- 首页那条也带同一枚胶囊 ---- */
    console.log("\n首页那条也带胶囊（三处共用一份零件）");
    await ev('location.hash = "#home"');
    ok(await waitFor(`!!document.querySelector('${sel} .sub-chip')`, 8000), "首页上也找得到这条");
    eq(await ev(`document.querySelector('${sel} .sub-chip').textContent.trim()`), "0/2",
      "首页那条也写着 0/2");

    /* ---- 开发工作的待办行上也有 ---- */
    console.log("\n开发工作项目详情里那条也带胶囊");
    await ev('location.hash = "#dev/p1"');
    await waitFor('!!document.querySelector(\'[data-act="todo-add"]\')', 8000);
    await ev('document.querySelector(\'[data-act="todo-add"]\').click()');
    const dlgOpen = await waitFor('!!document.getElementById("item-text")', 5000);
    ok(dlgOpen, "项目详情里的新增待办弹窗开了");
    await setFields({ "item-text": "项目里的一条待办" });
    await addSubtask("写单元测试");
    await clickDialog("save");
    ok(await waitFor('!!document.querySelector(\'.tasks .sub-chip\')', 6000),
      "项目详情里那条也带胶囊");
    eq(await ev('document.querySelector(\'.tasks .sub-chip\').textContent.trim()'), "0/1",
      "项目详情里那条写着 0/1");

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
        path.basename(full).startsWith("小李-子任务-")) {
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

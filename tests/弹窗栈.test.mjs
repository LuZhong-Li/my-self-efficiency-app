/* 弹窗栈的真浏览器回归测试：编辑弹窗里点【删除】→ 二级确认弹窗 → 各种收场。
 *
 * 为什么单独有一份：「点【删除】把底层编辑弹窗一起关掉，点【取消】回不来、填的
 * 内容全丢」这个 bug 在记账 / 债务 / 问题 / 进展 / 自媒体几个弹窗里都露过头，
 * 而这类行为只有真的点一遍才看得准——DOM 里到底还剩几个弹窗、焦点落在哪、
 * 取消之后输入框里的字还在不在，静态读代码都容易看走眼。
 *
 * 跑法：node tests\弹窗栈.test.mjs
 *   要 Node 22+（用内置的 fetch / WebSocket 直接说 CDP，不装 puppeteer）；
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

/** 停掉一个进程；Windows 上要连子进程一起 —— Edge 的渲染 / GPU 子进程
 *  会一直攥着临时 profile 目录，只杀主进程的话那个目录删不掉。 */
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

/* ---------------- 找浏览器 / Python / 空端口 ---------------- */

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

/* 和 启动.cmd / 自检.cmd 一个逻辑：挨个试，能 import http.server 的才算数。
   本机 PATH 里排第一的那份 msys2 被「智能应用控制」挡着，所以不能只看 where。 */
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

/* ---------------- CDP：一根 WebSocket 说到底 ---------------- */

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
      // 页面上冒出来的 JS 报错，一条都别放过：弹窗这摊子出问题常常先表现为报错
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

/** 在页面里跑一段表达式，返回它的值（Promise 会被 await 掉） */
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

/** 等一个页面里的条件成立；等不到返回 false（由调用方记成一条失败断言） */
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

/** 点某一层弹窗里的按钮（-1 = 栈顶）：发的是页面里的真实 click，不是绕过去直接改 DOM */
const clickIn = (which, sel) =>
  ev(
    `(()=>{const bs=[...document.querySelectorAll('.dlg-backdrop')];` +
      `const b=bs[${which} < 0 ? bs.length - 1 : ${which}];if(!b)return false;` +
      `const el=b.querySelector(${J(sel)});if(!el)return false;el.click();return true;})()`
  );

async function pressEscape() {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }
}

/* ---------------- 一个模块跑一遍：编辑 → 删除 → 取消 / Esc / 确认 ---------------- */

/**
 * @param {object} m
 * @param {string} m.name        模块名（打印用）
 * @param {string} m.hash        页面地址（#plan / #finance / #media）
 * @param {string} m.openSel     点了能弹出编辑弹窗的那个按钮
 * @param {string} m.title       编辑弹窗标题开头几个字
 * @param {string} m.inputSel    弹窗里的输入框
 * @param {string} m.seedValue   这条记录本来的内容（验证弹窗开对了没）
 * @param {string} m.typed       模拟用户改成的内容
 */
async function dialogStackCase(m) {
  console.log("\n" + m.name + "：编辑弹窗 → 点【删除】→ 确认弹窗");

  await ev("location.hash = " + J(m.hash));
  const ready = await waitFor("!!document.querySelector(" + J(m.openSel) + ")");
  await ev("document.querySelector(" + J(m.openSel) + ").click()");
  ok(
    ready &&
      (await waitFor(
        "!!document.querySelector('.dlg-backdrop .dlg-title') && " +
          "document.querySelector('.dlg-backdrop .dlg-title').textContent.indexOf(" +
          J(m.title) +
          ") === 0"
      )),
    "切到 " + m.hash + " 点【编辑】→ 编辑弹窗弹出（标题「" + m.title + "…」）"
  );
  eq(await ev("document.querySelector(" + J(m.inputSel) + ").value"), m.seedValue, "弹窗里带出的是这条记录本来的内容");

  await ev(
    "(()=>{const i=document.querySelector(" + J(m.inputSel) + ");i.value=" + J(m.typed) + ";" +
      "i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()"
  );
  eq(await ev("document.querySelector(" + J(m.inputSel) + ").value"), m.typed, "往输入框里填了新内容");

  await ev("document.querySelector('[data-dlg-act=\"delete\"]').click()");
  ok(await waitFor("document.querySelectorAll('.dlg-backdrop').length === 2"), "点【删除】→ 确认弹窗弹出，编辑弹窗没被关掉");

  const shot = await ev(`(()=>{
    const bs=[...document.querySelectorAll('.dlg-backdrop')];
    const first=bs[0], last=bs[bs.length-1];
    const hit=document.elementFromPoint(Math.round(innerWidth/2), Math.round(innerHeight/2));
    const inp=document.querySelector(${J(m.inputSel)});
    return {
      firstTitle: first.querySelector('h3').textContent.trim(),
      lastTitle: last.querySelector('h3').textContent.trim(),
      lastIsConfirm: !!last.querySelector('[data-dlg="yes"]'),
      firstIsConfirm: !!first.querySelector('[data-dlg="yes"]'),
      topHit: hit ? (last.contains(hit) ? "confirm" : (first.contains(hit) ? "edit" : "other")) : "none",
      inputKept: inp ? inp.value : null,
      focusInTop: last.contains(document.activeElement),
    };
  })()`);
  eq(shot.firstTitle.indexOf(m.title), 0, "底下压着的还是那个编辑弹窗");
  ok(shot.lastIsConfirm && !shot.firstIsConfirm, "上面那层是删除确认框（「" + shot.lastTitle + "」）");
  eq(shot.topHit, "confirm", "屏幕正中命中的是确认框（确认框叠在编辑弹窗上面）");
  eq(shot.inputKept, m.typed, "编辑弹窗里填的字没丢");
  ok(shot.focusInTop, "焦点落在确认框里（Esc / 回车都是它先接）");

  await clickIn(-1, '[data-dlg="no"]');
  ok(await waitFor("document.querySelectorAll('.dlg-backdrop').length === 1"), "点【取消】→ 确认弹窗消失，只剩编辑弹窗");
  const after = await ev(`(()=>{
    const b=document.querySelector('.dlg-backdrop');
    return {
      title: b && b.querySelector('.dlg-title') ? b.querySelector('.dlg-title').textContent.trim() : null,
      val: document.querySelector(${J(m.inputSel)}) ? document.querySelector(${J(m.inputSel)}).value : null,
      focusInside: b ? b.contains(document.activeElement) : false,
    };
  })()`);
  eq(String(after.title).indexOf(m.title), 0, "取消之后编辑弹窗原样留着");
  eq(after.val, m.typed, "取消之后表单内容一点没丢");
  ok(after.focusInside, "焦点回到编辑弹窗里（不用先点一下才能接着打字）");

  await ev("document.querySelector('[data-dlg-act=\"delete\"]').click()");
  await waitFor("document.querySelectorAll('.dlg-backdrop').length === 2");
  await pressEscape();
  ok(await waitFor("document.querySelectorAll('.dlg-backdrop').length === 1"), "按 Esc 只收掉栈顶的确认弹窗");
  eq(await ev("document.querySelector(" + J(m.inputSel) + ").value"), m.typed, "Esc 之后编辑弹窗里的内容还在");

  await ev(
    "(()=>{const b=document.querySelector('[data-dlg-act=\"delete\"]');b.click();b.click();return true;})()"
  );
  ok(
    await waitFor("document.querySelectorAll('.dlg-backdrop').length === 2"),
    "连点两次【删除】不会堆出第三个弹窗"
  );
  await clickIn(-1, '[data-dlg="no"]');
  await waitFor("document.querySelectorAll('.dlg-backdrop').length === 1");
}

/** 一个模块挂掉不该拖着后面两个一起跑不完：记一条失败，接着下一个 */
async function runCase(m) {
  try {
    await dialogStackCase(m);
  } catch (err) {
    fail += 1;
    console.log("  FAIL " + m.name + " 跑到一半挂了：" + (err && err.message ? err.message : err));
  }
}

/* ---------------- 主角 ---------------- */

async function main() {
  if (typeof WebSocket !== "function") {
    console.log("\n⚠ 跳过：Node 太老（要 22+，用它内置的 fetch / WebSocket 说 CDP）。");
    return "skip";
  }
  const browser = findBrowser();
  if (!browser) {
    console.log("\n⚠ 跳过：这台机器上没找到 Edge / Chrome。");
    console.log("  想跑的话把浏览器路径给 EDGE_PATH，例如：");
    console.log('  set EDGE_PATH=C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    return "skip";
  }
  const python = findPython();
  if (!python) {
    console.log("\n⚠ 跳过：没找到能用的 Python 3（要能 import http.server）。");
    return "skip";
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-弹窗栈-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const today = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

  // 三个模块各一条现成记录，等会儿就从它们身上点【编辑】进弹窗
  const TASK = "t-弹窗栈";
  const TX = "tx-弹窗栈";
  const ACC = "acc-弹窗栈";
  const MEDIA = "ma-弹窗栈";
  fs.writeFileSync(
    path.join(dataDir, "数据.json"),
    JSON.stringify({
      version: 1,
      rev: 0,
      tasks: [
        {
          id: TASK,
          text: "弹窗栈测试用待办",
          note: "原来的备注",
          time: "09:00",
          category: "工作",
          priority: "中",
          date: today,
          belong: "plan",
          done: false,
          createdAt: d.toISOString(),
        },
      ],
      finance: {
        accounts: [{ id: ACC, name: "弹窗栈账户", initialBalanceCents: 100000 }],
        transactions: [
          {
            id: TX,
            type: "expense",
            amountCents: 1234,
            date: today,
            category: "餐饮",
            accountId: ACC,
            note: "弹窗栈测试用账目",
            createdAt: d.toISOString(),
          },
        ],
      },
      mediaAccounts: [
        {
          id: MEDIA,
          name: "弹窗栈账号",
          platform: "B站",
          intro: "",
          baseFollowers: 0,
          targetFollowers: 1000,
          note: "",
          createdAt: d.toISOString(),
        },
      ],
      trash: [],
    }),
    "utf8"
  );

  let server = null;
  let edge = null;
  try {
    // ---- 起服务：临时数据目录 + 一个没人占的端口（免得撞上你正在用的那份）----
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
    console.log("服务：" + base + "（端口临时挑的，不碰你正在用的那份）");

    // ---- 起无头浏览器，按地址栏的调试端口说 CDP ----
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

    await cdp.send("Page.navigate", { url: base });
    await waitFor('document.readyState === "complete"', 15000);
    ok(
      await waitFor('document.querySelectorAll("#side-nav .side-item").length >= 5', 15000),
      "界面在真浏览器里起来了（左侧导航画出来了）"
    );

    // ---- 三个模块，各跑一遍「编辑 → 删除 → 取消」----
    await runCase({
      name: "待办（今日计划）",
      hash: "#plan",
      openSel: '#view li[data-id="' + TASK + '"] [data-act="edit"]',
      title: "修改任务",
      inputSel: "#item-text",
      seedValue: "弹窗栈测试用待办",
      typed: "弹窗栈测试用待办（改过）",
    });

    // ---- 上面那条弹窗还开着，接着把最后一路走完：真的点【确认删除】----
    try {
      console.log("\n待办：点【确认删除】");
      await ev("document.querySelector('[data-dlg-act=\"delete\"]').click()");
      await waitFor("document.querySelectorAll('.dlg-backdrop').length === 2");
      await clickIn(-1, '[data-dlg="yes"]');
      ok(
        await waitFor("document.querySelectorAll('.dlg-backdrop').length === 0", 5000),
        "点【确认删除】→ 确认框和编辑弹窗一起收掉"
      );
      let onDisk = null;
      for (let i = 0; i < 40; i += 1) {
        onDisk = await ev(
          "fetch('/api/data',{cache:'no-store'}).then(r=>r.json()).then(d=>({" +
            "hasTask:(d.tasks||[]).some(t=>t.id===" + J(TASK) + ")," +
            "trashHits:(d.trash||[]).filter(e=>e.row&&e.row.id===" + J(TASK) + ").length}))"
        );
        if (onDisk && onDisk.hasTask === false && onDisk.trashHits > 0) break;
        await sleep(250);
      }
      eq(Boolean(onDisk && onDisk.hasTask), false, "那条待办真的从数据里删掉了（已落盘）");
      ok(onDisk && onDisk.trashHits > 0, "删掉的那条进了回收站（误删能找回）");
      ok(
        await waitFor("!document.querySelector(" + J('#view li[data-id="' + TASK + '"]') + ")"),
        "今日计划列表上那行也没了"
      );
    } catch (err) {
      fail += 1;
      console.log("  FAIL 待办（点【确认删除】）跑到一半挂了：" + (err && err.message ? err.message : err));
    }

    await runCase({
      name: "记账（改一笔）",
      hash: "#finance",
      openSel: '#view li[data-id="' + TX + '"] [data-act="tx-edit"]',
      title: "改一笔",
      inputSel: "#tx-note",
      seedValue: "弹窗栈测试用账目",
      typed: "弹窗栈测试用账目（改过）",
    });
    await runCase({
      name: "自媒体（编辑账号）",
      hash: "#media",
      openSel: '[data-act="acc-edit"][data-id="' + MEDIA + '"]',
      title: "编辑自媒体账号",
      inputSel: "#acc-name",
      seedValue: "弹窗栈账号",
      typed: "弹窗栈账号（改过）",
    });

    // ---- 全程不该冒 JS 报错 ----
    const errors = cdp.pageErrors.filter((t) => !/favicon/i.test(t));
    eq(errors.length, 0, "整个过程页面里没冒出 JS 报错");
    if (errors.length) console.log("      " + errors.slice(0, 3).join("\n      "));
  } finally {
    stopTree(edge);
    stopTree(server);
    await sleep(600);
    // 临时目录：只删自己刚建的那个（前缀 + 必须在系统临时目录里），删不掉也
    // 不能把测试结论带红 —— 这跟被测的代码没关系
    const full = path.resolve(tmp);
    const rel = path.relative(path.resolve(os.tmpdir()), full);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && path.basename(full).startsWith("小李-弹窗栈-")) {
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

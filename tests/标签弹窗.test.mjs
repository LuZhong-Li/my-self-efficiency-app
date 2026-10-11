/* 标签在弹窗里的真浏览器回归测试：填标签 → 实时预览长什么样 → 保存进记录的是数组 →
 * 再打开编辑，回填得对、预览也在。顺带验一下「超量当场拦下来」。
 *
 * 为什么单独有一份：标签在表单里是「一行文本」、在记录里是数组，两头各转一次。
 * 单测能盯住那两次转换（tests\表单计算.test.mjs），但「输入框下面那行预览真的会跟着
 * 变」「保存真的写进了数据文件」只有真点一遍才看得见。
 *
 * 跑法：node tests\标签弹窗.test.mjs
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

/* 和 启动.cmd / 自检.cmd 一个逻辑：挨个试，能 import http.server 的才算数。 */
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

/** 弹窗里标签那一块此刻的样子：输入框的值、预览的胶囊、有没有当场报错 */
const tagBoxNow = () =>
  ev(`(()=>{
    const input=document.getElementById('item-tags');
    const box=document.querySelector('[data-tags-preview="tags"]');
    if(!input || !box) return null;
    return {
      value: input.value,
      candidates: [...document.querySelectorAll('#item-tags-list option')].map(o=>o.value),
      chips: [...box.querySelectorAll('.tag-chip')].map(c=>({ text:c.textContent.trim(), color:c.dataset.c })),
      hint: box.querySelector('.dlg-tags-hint') ? box.querySelector('.dlg-tags-hint').textContent.trim() : null,
      err: box.querySelector('.dlg-tags-err') ? box.querySelector('.dlg-tags-err').textContent.trim() : null,
    };
  })()`);

/** 往标签框里敲一段（走 insertText，和手打一样触发 input 事件） */
async function typeTags(text) {
  await ev("(()=>{const i=document.getElementById('item-tags');i.focus();i.value='';" +
    "i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
  await sleep(80);
  await cdp.send("Input.insertText", { text });
  await sleep(150);
}

/** 弹窗底部那颗按钮（保存 / 取消 / 删除） */
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-标签弹窗-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const today = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

  // 一条已经贴过标签的任务：它的标签要出现在候选里（「打一个字就有得补」）
  const dataFile = path.join(dataDir, "数据.json");
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1,
      rev: 0,
      memo: "",
      tasks: [
        {
          id: "t-已有", text: "已经贴过标签的任务", tags: ["工作"], date: today,
          time: "", category: "工作", priority: "", done: false, note: "",
          belong: "plan", isTodayPlan: false, imagePaths: [],
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

    await cdp.send("Page.navigate", { url: base + "#plan" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(
      await waitFor('!!document.querySelector(\'[data-act="add"]\')', 15000),
      "今日计划页在真浏览器里起来了（有「添加任务」按钮）"
    );

    /* ---- 打开新增弹窗：标签框、候选、预览 ---- */
    console.log("\n新增任务：标签框在那儿、候选是已有的标签、预览跟着打字变");
    await ev('document.querySelector(\'[data-act="add"]\').click()');
    ok(await waitFor("!!document.getElementById('item-tags')", 5000), "弹窗里有标签输入框");
    let box = await tagBoxNow();
    ok(Boolean(box), "输入框下面有那行实时预览（标签画得出来）");
    if (!box) return;      // 后面每条都靠它，没它就没法继续验（这条已经算失败了）
    eq(box.value, "", "新增时标签框是空的");
    ok(box.hint && box.hint.indexOf("最多") >= 0, "空的时候下面写着上限提示（" + box.hint + "）");
    ok(box.candidates.includes("工作"), "候选里有已经用过的标签「工作」");

    await typeTags("工作, 本周");
    box = await tagBoxNow();
    eq(box.value, "工作, 本周", "敲进去的还在框里（没被吃掉）");
    eq(box.chips.length, 2, "下面当场出两枚胶囊");
    eq(box.chips[0].text, "工作", "第一枚是「工作」");
    eq(box.chips[1].text, "本周", "第二枚是「本周」");
    ok(box.chips.every((c) => Number(c.color) >= 1 && Number(c.color) <= 8), "每枚都有颜色档位");
    eq(box.err, null, "两个标签不报错");

    console.log("\n超量：当场提示，而且真的存不进去");
    await typeTags("一,二,三,四,五,六,七,八,九");
    box = await tagBoxNow();
    ok(box.err && box.err.indexOf("最多") >= 0, "第 9 个标签当场提示（" + box.err + "）");
    await clickDialog("save");
    ok(
      await ev("!!document.getElementById('item-tags')"),
      "带错误的表单点保存不会关弹窗（提示还在）"
    );
    const stillOne = (() => {
      const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
      return data.tasks.length;
    })();
    eq(stillOne, 1, "数据文件里没多出这条（拦在保存之前）");

    /* ---- 改成正常的，保存 ---- */
    console.log("\n改成正常的：保存写进数据文件的是数组");
    await typeTags("工作, 本周");
    await ev("(()=>{const i=document.getElementById('item-text');i.value='带标签的新任务';" +
      "i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
    await clickDialog("save");
    ok(!(await ev("!!document.getElementById('item-tags')")), "保存之后弹窗关掉了");
    await sleep(400);
    const saved = JSON.parse(fs.readFileSync(dataFile, "utf8")).tasks.find(
      (t) => t.text === "带标签的新任务"
    );
    ok(Boolean(saved), "数据文件里新增了这条任务");
    eq(J(saved && saved.tags), J(["工作", "本周"]), "存的是数组，不是「工作, 本周」这一串文本");

    /* ---- 再打开编辑：回填 + 预览 ---- */
    console.log("\n再打开编辑：回填成一行文本，预览也画出来");
    const opened = await ev(`(()=>{
      const row=[...document.querySelectorAll('.tasks li')].find(li=>li.textContent.includes('带标签的新任务'));
      if(!row) return false;
      const btn=row.querySelector('[data-act="edit"]');
      if(!btn) return false;
      btn.click();
      return true;
    })()`);
    ok(opened, "找得到那条任务的「编辑」");
    ok(await waitFor("!!document.getElementById('item-tags')", 5000), "编辑弹窗也带标签框");
    box = await tagBoxNow();
    eq(box.value, "工作、本周", "回填成「工作、本周」这种一行文本");
    eq(box.chips.length, 2, "编辑时预览里也是两枚胶囊");
    await clickDialog("cancel");

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
        path.basename(full).startsWith("小李-标签弹窗-")) {
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

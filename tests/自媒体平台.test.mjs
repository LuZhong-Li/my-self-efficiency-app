/* 自媒体「管理平台」的真浏览器回归测试：页头上那颗「平台」按钮 → 弹窗里加 / 删平台 →
 * 下拉跟着变；**已经记下的账号和作品一个字不动**；删平台时那个账号照样能编辑
 * （不会一保存就被悄悄改成别的平台）；至少留一个、最多 12 个、重名不给加。
 *
 * 为什么单独有一份：纯逻辑那份（tests\自媒体计算.test.mjs）盯的是清单怎么洗、
 * 什么算重名、满了怎么办，盯不住「弹窗真存进去没、下拉真跟着换没、已有的账号动没动」。
 *
 * 跑法：node tests\自媒体平台.test.mjs
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

/** 管理平台弹窗此刻的样子：清单里有哪些、错误行写着什么 */
const platDialogNow = () =>
  ev(`(()=>{
    const list=document.getElementById('plat-list');
    if(!list) return null;
    const err=document.getElementById('plat-err');
    const delBtns=[...list.querySelectorAll('[data-plat-del]')];
    return {
      items:[...list.querySelectorAll('li')].map(li=>(li.querySelector('.i-title')||{}).textContent || ""),
      err: err && !err.hidden ? err.textContent : "",
      firstDelDisabled: delBtns.length ? delBtns[0].disabled : null,
      text: document.querySelector('.dlg').textContent.replace(/\\s+/g,' ').trim(),
    };
  })()`);

async function openPlatDialog() {
  await ev("document.querySelector('[data-act=\"plat-manage\"]').click()");
  await waitFor("!!document.getElementById('plat-list')", 5000);
}

async function addPlat(name) {
  await ev(`(()=>{
    const i=document.getElementById('plat-new');
    i.value=${JSON.stringify(String(name))};
    document.getElementById('plat-add').click();
    return true;
  })()`);
  await sleep(250);
}

async function delPlat(name) {
  const done = await ev(`(()=>{
    const b=[...document.querySelectorAll('[data-plat-del]')]
      .find(x=>x.dataset.platDel===${JSON.stringify(String(name))});
    if(!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(250);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-自媒体平台-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const dataFile = path.join(dataDir, "数据.json");
  // 一个「抖音」账号：等下把「抖音」这个平台从清单里删掉，看它动没动
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1,
      rev: 0,
      memo: "",
      mediaAccounts: [
        {
          id: "acc-dy", name: "抖音小李", platform: "抖音", intro: "做产品的过程记录",
          baseFollowers: 1200, targetFollowers: 5000, note: "", createdAt: "",
        },
      ],
      contents: [],
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

    await cdp.send("Page.navigate", { url: base + "#media" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor("!!document.querySelector('[data-act=\"plat-manage\"]')", 15000),
      "自媒体页头上有「平台」按钮");

    /* ---- 默认清单 ---- */
    console.log("\n点开「平台」：默认那七个都在，说明里写明「已有数据不动」");
    await openPlatDialog();
    let view = await platDialogNow();
    eq(view.items.join("/"), "B站/小红书/抖音/公众号/知乎/视频号/其他", "默认七个平台都在");
    ok(view.text.includes("一个字都不动"), "说明里写明了已有账号 / 作品不动");
    eq(readData(dataFile).settings.mediaPlatforms, undefined, "还没改过：数据里不写这个键（用默认）");

    /* ---- 加一个 ---- */
    console.log("\n加一个「播客」：数据里出现清单，弹窗列表里也有它");
    await addPlat("播客");
    view = await platDialogNow();
    eq(view.items.length, 8, "清单里八个了");
    eq(view.items[7], "播客", "新的加在最后（下拉里的顺序）");
    eq(readData(dataFile).settings.mediaPlatforms.join("/"),
      "B站/小红书/抖音/公众号/知乎/视频号/其他/播客", "落盘的是这一份清单");

    console.log("\n重名 / 空名 / 太长：都当场说一句，不往清单里加");
    await addPlat("播客");
    view = await platDialogNow();
    ok(view.err.includes("已经在清单里"), "重名提示（" + view.err + "）");
    eq(view.items.length, 8, "重名不加");
    await addPlat("   ");
    view = await platDialogNow();
    ok(view.err.includes("1～12"), "空名提示（" + view.err + "）");
    await addPlat("这个名字实在是太长了超过十二个字");
    view = await platDialogNow();
    ok(view.err.includes("1～12"), "太长的提示（" + view.err + "）");
    eq(readData(dataFile).settings.mediaPlatforms.length, 8, "两次都不加，清单还是八个");

    /* ---- 删一个平台：已有的账号不受影响 ---- */
    console.log("\n删掉「抖音」：清单里没了，但那个抖音账号一个字不动");
    eq(await delPlat("抖音"), true, "点得动「抖音」那一行的「删掉」");
    view = await platDialogNow();
    eq(view.items.includes("抖音"), false, "清单里没有抖音了");
    const data = readData(dataFile);
    eq(data.settings.mediaPlatforms.includes("抖音"), false, "落盘的清单也少了一个");
    eq(data.mediaAccounts.length, 1, "账号还在");
    eq(data.mediaAccounts[0].platform, "抖音", "账号存的那个平台名一个字没动");
    ok(
      await ev("document.querySelector('.acc-sub').textContent.includes('抖音')"),
      "账号卡片上照旧写着抖音"
    );

    /* ---- 那个账号还编辑得了 ---- */
    console.log("\n编辑那个账号：下拉里照样摆着「抖音」并选中（不会一保存就改掉）");
    await ev("document.querySelector('.dlg-backdrop [data-dlg-act=\"done\"]')?.click()");
    await sleep(200);
    await ev("document.querySelector('[data-act=\"acc-edit\"]').click()");
    await waitFor("!!document.getElementById('acc-platform')", 5000);
    const sel = await ev(`(()=>{
      const s=document.getElementById('acc-platform');
      return { value:s.value, options:[...s.options].map(o=>o.value) };
    })()`);
    eq(sel.value, "抖音", "选中的还是抖音");
    eq(sel.options.includes("抖音"), true, "下拉里留着它（占位那一项）");
    eq(sel.options.includes("播客"), true, "新加的平台也在下拉里");
    await ev("document.querySelector('.dlg-backdrop [data-dlg-act=\"cancel\"]')?.click()");
    await sleep(200);

    /* ---- 只剩一个就不让删 ---- */
    console.log("\n一路删到只剩一个：最后一个不让删");
    await openPlatDialog();
    for (const name of ["B站", "小红书", "公众号", "知乎", "视频号", "其他", "播客"]) {
      await delPlat(name);
    }
    view = await platDialogNow();
    // 按上面的顺序删，最后剩下的是「播客」（它排在最后、又是最后才轮到删）
    eq(view.items.join("/"), "播客", "删到只剩一个：留下的是最后一个没轮到的");
    eq(readData(dataFile).settings.mediaPlatforms.length, 1, "数据里也只剩一个");
    eq(await ev("document.querySelector('[data-plat-del]').disabled"), true,
      "只剩一个时那个「删掉」按钮是灰的");

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
        path.basename(full).startsWith("小李-自媒体平台-")) {
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

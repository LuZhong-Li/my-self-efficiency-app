/* 全局搜索的真浏览器回归测试：在顶栏那个搜索框里敲关键词，看下拉面板出不出得来、
 * 出一条什么、点下去跳到哪个模块。
 *
 * 为什么单独有一份：搜索池那套逻辑（查哪些表、哪些字段）有 搜索.test.mjs 盯着，
 * 不用开浏览器。但「敲进去 → 面板画出来 → 点一下跳走」这一段是搜索框自己的事，
 * 静态读代码看不准 —— 少画一条、点死在一个不存在的地址上、勾了「包含归档记录」
 * 不重搜，这些都只有真的点一遍才看得见。这次修的模块目标 / 粉丝快照还各自带回
 * 不同的跳转地址（#fitness / #study / #media），更要锁一下。
 *
 * 跑法：node tests\搜索交互.test.mjs
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
      // 页面上冒出来的 JS 报错，一条都别放过：搜索面板是拿 innerHTML 拼出来的，
      // 字段取不到时最容易在这里露头
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

/* ---------------- 搜索框上的几个动作 ---------------- */

/**
 * 往搜索框里敲一个词：先把里面清干净（聚焦）、等上一次的结果收干净，再用
 * Input.insertText 送进去 —— 走的是输入框自己的 input 事件，跟手打一样触发那
 * 200ms 的防抖重搜，不是绕过界面直接改数据。
 *
 * 「先等面板收起来」这一步不能省：清了输入框到面板真的收掉之间隔着那 200ms 防抖，
 * 抢在前面读面板，读到的还是上一个词的旧结果（两条断言会互相串味）。
 */
async function typeQuery(q) {
  await ev(
    "(()=>{const i=document.getElementById('search');i.focus();" +
      "i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()"
  );
  await waitFor("document.getElementById('search-panel').hidden === true", 4000);
  if (q) {
    await cdp.send("Input.insertText", { text: q });
    // 敲完等防抖那一拍过去、面板重画完，再读
    await sleep(450);
  }
}

/** 面板此刻的样子：隐藏没隐藏、结果每条带哪个标签 / 什么正文 / 跳哪 */
const panelNow = () =>
  ev(`(()=>{
    const p=document.getElementById('search-panel');
    const none=p.querySelector('.sr-none');
    return {
      hidden: p.hidden,
      none: none ? none.textContent.trim() : null,
      items: [...p.querySelectorAll('.sr-item')].map(b=>({
        tag: b.querySelector('.sr-tag').textContent.trim(),
        text: b.querySelector('.sr-text').textContent.trim(),
        hash: b.dataset.hash,
      })),
    };
  })()`);

/** 搜一个词，把面板结果拿回来 */
async function hits(q) {
  await typeQuery(q);
  return panelNow();
}

/** 面板里有没有「某个标签、正文里带某段字」的一条 */
const hasHit = (p, tag, needle) =>
  p.items.some((it) => it.tag === tag && (!needle || it.text.includes(needle)));

/** 点面板里第一条某标签的结果（真 click），然后看地址跳到哪 */
async function clickHit(tag) {
  const clicked = await ev(`(()=>{
    const bs=[...document.querySelectorAll('#search-panel .sr-item')];
    const b=bs.find(x=>x.querySelector('.sr-tag').textContent.trim()===${J(tag)});
    if(!b)return false;
    b.click();
    return true;
  })()`);
  await sleep(250);
  return { clicked, hash: await ev("location.hash") };
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-搜索交互-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const today = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

  // 一份刚刚够用的数据：每类要搜的东西都摆一条，字段名照数据里真有的写。
  // 关键词挑成一眼能认出来的，免得跟别的记录串味。
  fs.writeFileSync(
    path.join(dataDir, "数据.json"),
    JSON.stringify({
      version: 1,
      rev: 0,
      memo: "",
      tasks: [
        {
          id: "t-搜索", text: "把搜索做全", note: "搜得到每一类才算数", time: "",
          category: "工作", priority: "中", date: today, belong: "plan", done: false,
          createdAt: d.toISOString(),
        },
        {
          id: "t-搜索-归档", text: "去年就归档的旧事", note: "", time: "",
          category: "工作", priority: "低", date: "2025-01-01", belong: "plan",
          done: true, isArchived: true, archivedAt: today, createdAt: d.toISOString(),
        },
      ],
      moduleGoals: {
        fitness: [
          {
            id: "g-搜索-健身", moduleId: "fitness", moduleName: "健身计划",
            mainTarget: "三个月减重到 65kg", cycle: "月度",
            startDate: "2026-09-08", endDate: "2026-12-07",
            dailyRule: "每周一三五力量训练", remark: "练完顺手记体重",
            isActive: true, autoTask: true, lastRun: "",
          },
        ],
        study: [
          {
            id: "g-搜索-学习", moduleId: "study", moduleName: "学习工作",
            mainTarget: "把高数上册过完", cycle: "每日",
            startDate: "2026-09-18", endDate: "", dailyRule: "晚 7 点学两小时",
            remark: "", isActive: true, autoTask: true, lastRun: "",
          },
        ],
      },
      mediaAccounts: [
        {
          id: "ma-搜索", name: "B站小李", platform: "B站", intro: "做产品的过程记录",
          baseFollowers: 1200, targetFollowers: 5000, note: "周更", createdAt: "",
        },
      ],
      mediaFollowers: [{ id: "mf-搜索", accountId: "ma-搜索", date: today, count: 1260 }],
      water: [{ id: "wa-搜索", date: today, cups: 8, ml: 800, note: "早上喝水" }],
      weights: [{ id: "wt-搜索", date: today, kg: 63.2, bodyFat: 17.5 }],
      meals: [
        { id: "m-搜索", date: today, breakfast: "包子豆浆", lunch: "", dinner: "", snack: "" },
      ],
      finance: {
        accounts: [{ id: "acc-搜索", name: "微信", initialBalanceCents: 0 }],
        transactions: [
          {
            id: "tx-搜索", type: "expense", amountCents: 220000, date: today,
            category: "餐饮", accountId: "acc-搜索", note: "午饭 黄焖鸡", createdAt: "",
          },
        ],
      },
      debt: {
        items: [
          {
            id: "d-搜索", name: "花呗", creditor: "支付宝", note: "每月 20 号还款",
            dueDate: "", totalCents: 350000, status: "pending", repayments: [],
          },
        ],
      },
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

    /* ---- 顶栏那条提示文案 ---- */
    console.log("\n顶栏搜索框的占位提示");
    const ph = await ev("document.getElementById('search').placeholder");
    eq(ph, "搜索待办、bug、记账…", "占位提示是精简过的那句");

    // 「放不放得下」按真盒子里量：拿输入框自己的字体把这句话画到 canvas 上量宽度，
    // 跟输入框去掉左右内边距之后剩下的宽度比 —— 比数汉字个数靠谱，也顺带把窄屏
    // 那条媒体查询（max-width: 860px 时宽度掉到 200px）一起验了。
    const fitsInBox = () =>
      ev(`(()=>{
        const i=document.getElementById('search');
        const cs=getComputedStyle(i);
        const c=document.createElement('canvas').getContext('2d');
        c.font=cs.font||(cs.fontSize+' '+cs.fontFamily);
        const need=c.measureText(i.placeholder).width;
        const have=i.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);
        return { need:Math.round(need), have:Math.round(have), box:i.clientWidth };
      })()`);
    const wide = await fitsInBox();
    ok(
      wide.need <= wide.have,
      "宽屏放得下（要 " + wide.need + "px，框里剩 " + wide.have + "px）"
    );
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 800,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(300);
    const narrow = await fitsInBox();
    ok(
      // 860px 那档媒体查询把宽度压到 200px（clientWidth 不算边框，读出来 198）
      narrow.box < 220 && narrow.need <= narrow.have,
      "窄屏（800px 窗口，搜索框只剩 " + narrow.box + "px）也放得下（要 " +
        narrow.need + "px，框里剩 " + narrow.have + "px）"
    );
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await sleep(200);

    /* ---- 这次补上的两类：模块目标、粉丝快照 ---- */
    console.log("\n模块目标（健身 / 学习）：搜得到，点回自己那个模块");
    let p = await hits("减重");
    ok(hasHit(p, "目标", "三个月减重到 65kg"), "搜「减重」命中健身目标");
    p = await hits("65");
    ok(hasHit(p, "目标", "三个月减重到 65kg"), "搜「65」按目标里的数值命中");
    let jump = await clickHit("目标");
    ok(jump.clicked && jump.hash === "#fitness", "点健身目标 → 跳 #fitness（不是死地址）");
    p = await hits("高数上册");
    ok(hasHit(p, "目标", "把高数上册过完"), "搜「高数上册」命中学习目标");
    jump = await clickHit("目标");
    ok(jump.clicked && jump.hash === "#study", "点学习目标 → 跳 #study（一行一个模块）");

    console.log("\n自媒体粉丝快照：粉丝数和平台都搜得到，点回自媒体页");
    p = await hits("1260");
    ok(hasHit(p, "粉丝", "1260 粉"), "搜「1260」按粉丝数命中快照");
    p = await hits("B站");
    ok(hasHit(p, "粉丝"), "搜「B站」命中快照（平台是回账号表里取的）");
    ok(hasHit(p, "账号", "B站小李"), "账号本身也照旧搜得到");
    jump = await clickHit("粉丝");
    ok(jump.clicked && jump.hash === "#media", "点粉丝快照 → 回 #media");

    console.log("\n饮水记录：杯数 / 毫升 / 备注");
    p = await hits("8 杯");
    ok(hasHit(p, "饮水", "8 杯"), "搜「8 杯」按杯数命中");
    p = await hits("800");
    ok(hasHit(p, "饮水", "800 ml"), "搜「800」按毫升数命中");
    p = await hits("早上喝水");
    ok(hasHit(p, "饮水", "早上喝水"), "搜「早上喝水」按备注命中");

    console.log("\n体重记录：数值和日期");
    p = await hits("63.2");
    ok(hasHit(p, "体重", "63.2 kg"), "搜「63.2」按 kg 数值命中（原来只能搜日期）");
    p = await hits(today);
    ok(hasHit(p, "体重"), "搜日期照样命中体重（老行为没动）");

    console.log("\n旧数据源不能被新加的挤掉");
    p = await hits("包子");
    ok(hasHit(p, "饮食", "包子豆浆"), "饮食记录搜得到");
    p = await hits("黄焖鸡");
    ok(hasHit(p, "账目", "午饭 黄焖鸡"), "记账流水按备注搜得到");
    p = await hits("支付宝");
    ok(hasHit(p, "债务", "支付宝"), "最后一张表（债务）也搜得到 —— 按债权人也能搜，没被提前截断");
    p = await hits("记账");
    ok(hasHit(p, "账目"), "搜模块别称「记账」带出账目记录");

    console.log("\n归档：默认不搜，勾上「包含归档记录」才出来");
    p = await hits("去年就归档");
    eq(p.none, "没找到「去年就归档」", "默认搜不到归档的待办");
    ok(!p.hidden, "搜不到也把面板留着（不是一片空白）");
    await ev("document.getElementById('search-archived').click()");
    await waitFor(
      "[...document.querySelectorAll('#search-panel .sr-item')]" +
        ".some(b=>b.querySelector('.sr-tag').textContent.trim()==='待办')",
      5000
    );
    p = await panelNow();
    ok(hasHit(p, "待办", "去年就归档的旧事"), "勾上之后归档的待办出来了");
    await ev("document.getElementById('search-archived').click()");
    await sleep(400);
    eq((await panelNow()).none, "没找到「去年就归档」", "取消勾选又收回去了（勾选框真的在生效）");

    console.log("\n点结果之后：面板收起、输入框清空；查无此词的说法");
    await hits("减重");
    const afterClick = await ev(`(()=>{
      const b=[...document.querySelectorAll('#search-panel .sr-item')][0];
      b.click();
      const inp=document.getElementById('search');
      return { value: inp.value, hidden: document.getElementById('search-panel').hidden };
    })()`);
    eq(afterClick.value, "", "点完结果输入框清空了");
    ok(afterClick.hidden, "点完结果面板收起来了");
    p = await hits("查无此词xyz");
    eq(p.none, "没找到「查无此词xyz」", "查无此词就给一句「没找到」，不硬凑");

    /* ---- 全程不该冒 JS 报错 ---- */
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
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && path.basename(full).startsWith("小李-搜索交互-")) {
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

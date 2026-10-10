/* 游戏娱乐「翻历史」的真浏览器回归测试：点一款游戏的「看记录」之后，区间会被自动
 * 坐实成这款游戏真正玩过的那几天；这时候把游戏名清掉 —— 页面得回到「看某一天」
 * 那个视图，不能挂着一份没人要的日期区间卡在筛选里出不来。反过来，用户自己填的
 * 起止日期要留着（那是他有心筛的，不能连它一起清）。
 *
 * 为什么单独有一份：区间到底算「自动坐实的」还是「用户手填的」，是游戏页自己的
 * 状态，静态读代码看不准 —— 2026-10-11 修的这条就是「清空名字，自动生成的
 * from/to 没跟着清」，只有真的敲一遍键盘才看得见。
 *
 * 跑法：node tests\游戏筛选.test.mjs
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
      // 页面上冒出来的 JS 报错，一条都别放过：筛选那几个框是拿 innerHTML 拼出来的，
      // 状态取不到时最容易在这里露头
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

/* ---------------- 游玩记录卡片此刻的样子 ---------------- */

const cardNow = () =>
  ev(`(()=>{
    const card=document.querySelector('.gm-records');
    const range=card.querySelector('.gm-filter-range');
    return {
      hint: card.querySelector('.card-head .hint').textContent.trim(),
      range: range ? range.textContent.trim() : null,
      clearBtn: !!card.querySelector('[data-act="gm-filter-clear"]'),
      name: card.querySelector('#game-filter-name').value,
      from: card.querySelector('#game-filter-from').value,
      to: card.querySelector('#game-filter-to').value,
      titles: [...card.querySelectorAll('.items .item .i-title')].map(e=>e.textContent.trim()),
    };
  })()`);

/** 点 TOP3 那条「看记录」 */
async function clickHistory() {
  const clicked = await ev(
    "(()=>{const b=document.querySelector('[data-act=\"gm-history\"]');" +
      "if(!b)return false;b.click();return true;})()"
  );
  await sleep(200);
  return clicked;
}

/**
 * 把游戏名一个一个退格删掉，再让它失焦。
 *
 * 走真鼠标点进去 + 真键盘退格 + 真失焦，而不是直接改 value —— 「清空名字」这件事
 * 页面是在 change 事件里处理的，绕过界面改 value 就测不到这条路径了。
 * 点进去那一下不能省：光 focus() 的话 document.activeElement 虽然是对的，但人没
 * 真进到这个框里，退格删不动字（rawKeyDown 和 commands 两样都试过，一样删不动）。
 */
async function clearNameByKeyboard() {
  const box = await ev(`(()=>{const r=document.getElementById('game-filter-name').getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};})()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type, x: box.x, y: box.y, button: "left", clickCount: 1,
    });
  }
  await sleep(120);
  const chars = await ev("document.getElementById('game-filter-name').value.length");
  await cdp.send("Page.bringToFront");
  for (let i = 0; i < chars; i += 1) {
    const key = {
      key: "Backspace", code: "Backspace",
      windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    };
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    await sleep(60);   // 两下之间隔开一点：连着发太快，后发的那几下会被丢掉
  }
  await sleep(150);
  await ev("document.activeElement.blur()");
  await sleep(250);
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-游戏筛选-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (x) => x.getFullYear() + "-" + pad(x.getMonth() + 1) + "-" + pad(x.getDate());
  const now = new Date();
  const today = ymd(now);
  const oldDay = new Date(now);
  oldDay.setDate(oldDay.getDate() - 20);
  const older = ymd(oldDay);

  // 一份刚刚够用的数据：一款游戏、两条记录（今天一条、二十天前一条）。
  // 这样「自动坐实的区间」是 older ~ today 两天，「自己填的区间」可以缩到今天一天 ——
  // 两种区间在列表条数上分得开，断言才咬得住。
  fs.writeFileSync(
    path.join(dataDir, "数据.json"),
    JSON.stringify({
      version: 1,
      rev: 0,
      memo: "",
      games: [
        {
          id: "g-星露谷", name: "星露谷物语", platform: "PC", status: "在玩",
          hours: 0, targetHours: 0, finishDate: "", progress: "农场第二年了",
        },
      ],
      gameRecords: [
        {
          id: "r-今天", gameId: "g-星露谷", gameName: "星露谷物语",
          playDate: today, durationMin: 60, remark: "今天收菜", imagePaths: [],
        },
        {
          id: "r-早先", gameId: "g-星露谷", gameName: "星露谷物语",
          playDate: older, durationMin: 120, remark: "二十天前挖矿", imagePaths: [],
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
    // 无头浏览器里页面不是「系统焦点」状态（document.hasFocus() 是 false），
    // 键盘事件会被丢掉、退格删不动字。把焦点模拟打开，键就送得进去了。
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    await cdp.send("Page.navigate", { url: base + "#game" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(
      await waitFor('!!document.getElementById("game-filter-name")', 15000),
      "游戏页在真浏览器里起来了（游玩记录卡片画出来了）"
    );

    /* ---- 刚进来：看的是今天，没有筛选 ---- */
    console.log("\n刚进来：看的是今天，一个筛选都没挂");
    let p = await cardNow();
    eq(p.range, null, "没筛选时不挂「筛选区间」那一行");
    ok(!p.clearBtn, "没筛选时不出现「清除筛选」");
    eq(p.name, "", "名字框是空的");
    eq(p.titles.join("/"), "星露谷物语", "列表里只有今天那一条");
    ok(p.hint.indexOf(today) === 0, "标题旁写的是这一天的日期（" + p.hint + "）");

    /* ---- 点「看记录」：区间自动坐实 ---- */
    console.log("\n点「看记录」：区间自动坐实成这款游戏玩过的那几天");
    ok(await clickHistory(), "TOP3 那一行有「看记录」");
    ok(
      await waitFor('!!document.querySelector(".gm-records .gm-filter-range")', 5000),
      "切到筛历史（「筛选区间」那一行出来了）"
    );
    p = await cardNow();
    eq(p.name, "星露谷物语", "游戏名填进名字框了");
    eq(p.from, older, "「从」自动坐实成最早那天（" + older + "）");
    eq(p.to, today, "「到」自动坐实成最晚那天（" + today + "）");
    ok(p.clearBtn, "筛历史时出现「清除筛选」");
    eq(p.titles.length, 2, "两条记录都在列表里");
    ok(p.hint.indexOf("筛出 2 条") === 0, "标题旁写的是筛出几条（" + p.hint + "）");

    /* ---- 清空游戏名：自动坐实的区间要跟着清掉 ---- */
    console.log("\n清空游戏名：自动坐实的区间跟着清掉，回到当日视图");
    await clearNameByKeyboard();
    ok(
      await waitFor('!document.querySelector(".gm-records .gm-filter-range")', 5000),
      "「筛选区间」那一行没了（不再卡在筛历史里）"
    );
    p = await cardNow();
    eq(p.name, "", "名字框清空了");
    ok(!p.clearBtn, "「清除筛选」跟着消失");
    eq(p.titles.join("/"), "星露谷物语", "列表回到这一天的记录（二十天前那条不再混进来）");
    ok(p.hint.indexOf(today) === 0, "标题旁回到「某一天」（" + p.hint + "）");

    /* ---- 自己填的日期要留着 ---- */
    console.log("\n自己填的起止日期要留着：清空名字不等于清掉日期");
    ok(await clickHistory(), "再点一次「看记录」");
    ok(
      await waitFor('!!document.querySelector(".gm-records .gm-filter-range")', 5000),
      "又切回筛历史"
    );
    // 日期框要真用键盘敲得分三段（年 / 月 / 日），这里直接把值给它、派发一个真的
    // change —— 走的是页面自己的 change 处理，和上面「清空名字」一样不绕过界面状态
    await ev(
      "(()=>{const i=document.getElementById('game-filter-from');i.value=" + J(today) +
        ";i.dispatchEvent(new Event('change',{bubbles:true}));return true;})()"
    );
    await sleep(250);
    p = await cardNow();
    eq(p.from, today, "手填的日期落到「从」那一格");
    eq(p.titles.length, 1, "区间缩到今天，列表只剩今天这条（日期真的在筛）");

    await clearNameByKeyboard();
    p = await cardNow();
    ok(p.range !== null, "清空名字之后还是筛历史（日期是自己填的，留着）");
    eq(p.from, today, "手填的「从」还在（" + p.from + "）");
    eq(p.titles.length, 1, "还是按这个日期筛出来的那一条");

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
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && path.basename(full).startsWith("小李-游戏筛选-")) {
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

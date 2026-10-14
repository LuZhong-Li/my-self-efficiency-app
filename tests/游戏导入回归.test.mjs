/* Steam 离线导入的真浏览器回归：游戏娱乐页点「导入记录」→ 选一份写进临时目录的真 CSV →
 * 先看解析预览（认出来几行 / 跳过几行 / 哪几行和库里重了）→ 确认导入 →
 * 记录真进了 gameRecords、形状和手动记的一条一模一样、当月统计跟着变 →
 * 同一份再导一遍：预览说会全跳过，库里不重复。
 *
 * 为什么单独有一份：纯逻辑那份（tests\游戏导入.test.mjs）盯的是解析口径，
 * 盯不住「浏览器里选文件那一下真读到了没、预览是不是拿解析结果算的、
 * 落库的形状是不是和手动记的一样、统计有没有自动跟着变」。
 *
 * 跑法：node tests\游戏导入回归.test.mjs
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

const setFields = (map) =>
  ev("(()=>{const set=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v;};" +
     Object.entries(map).map(([k, v]) => "set('" + k + "','" + v + "');").join("") +
     "return true;})()");

/** 把一份真文件塞进文件框：CDP 的 DOM.setFileInputFiles —— 和用户点「选择文件」选它是同一回事。 */
async function pickFile(selector, filePath) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
  const objectId = r.result && r.result.objectId;
  if (!objectId) throw new Error("页面上没找到文件框：" + selector);
  await cdp.send("DOM.setFileInputFiles", { files: [filePath], objectId });
}

const textOf = (selector) =>
  ev("(()=>{const el=document.querySelector('" + selector + "');return el?el.textContent:null;})()");

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "小李-游戏导入-"));
  const dataDir = path.join(tmp, "数据");
  const profile = path.join(tmp, "浏览器");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  // 导入的日期落在「本月」：统计那一格才看得见变化。月份按跑测试这台机器的当前时间算，
  // 不写死 —— 写死的话换个月跑就红，红的原因还和被测的东西没关系。
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const ym = now.getFullYear() + "-" + pad2(now.getMonth() + 1);
  const d13 = ym + "-13";
  const d12 = ym + "-12";
  const d11 = ym + "-11";

  // 中文文件名：顺便验证非 ASCII 的路径也读得到（Windows 上很常见）
  const csvFile = path.join(tmp, "steam 导出.csv");
  fs.writeFileSync(
    csvFile,
    [
      "游戏名,游玩时长,日期,备注",
      "Hades,12.5h," + ym.replace("-", "/") + "/13,通了一次",
      "Stardew Valley,90m," + d12 + ",种地",
      "Hollow Knight,1:30," + d11 + ",打 boss",
      "Celeste,," + ym + "-10,忘写时长了",
    ].join("\r\n") + "\r\n",
    "utf8"
  );

  const dataFile = path.join(dataDir, "数据.json");
  fs.writeFileSync(
    dataFile,
    JSON.stringify({
      version: 1, rev: 0, memo: "",
      games: [
        { id: "g-hades", name: "Hades", platform: "PC", status: "在玩", hours: 0,
          targetHours: 0, finishDate: "", progress: "" },
      ],
      gameRecords: [],
      tasks: [], contents: [], notes: [], trash: [], settings: {},
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

    /* 1) 页头上挂着「导入记录」 */
    console.log("\n游戏娱乐页：导入记录的入口");
    await cdp.send("Page.navigate", { url: base + "#game" });
    await waitFor('document.readyState === "complete"', 15000);
    ok(await waitFor('!!document.querySelector(\'[data-act="add"]\')', 15000), "游戏娱乐页起来了");
    ok(await ev('!!document.querySelector(\'[data-act="gm-import"]\')'), "页头有「导入记录」按钮");
    ok(await ev('!!document.querySelector(\'[data-act="gm-add"]\')'), "「添加游玩记录」还在，两个并排");

    /* 2) 弹窗：说明 + 文件框 + 空预览 */
    console.log("\n导入弹窗：说明 / 文件框 / 空预览");
    await ev('document.querySelector(\'[data-act="gm-import"]\').click()');
    ok(await waitFor('!!document.getElementById("import-file")', 5000), "导入弹窗开了（有文件框）");
    const hint = (await textOf(".dlg-form .hint")) || "";
    ok(hint.includes("不联网"), "说明里写着不会联网");
    ok(hint.includes("CSV"), "说明里写着要选 CSV");
    eq(await ev('document.getElementById("import-file").getAttribute("type")'), "file", "是个文件框");
    eq(await ev('document.getElementById("import-file").getAttribute("accept")'), ".csv,text/csv",
      "文件框只认 CSV");
    ok(await ev('document.querySelector(\'[data-dlg-act="import"]\').disabled'),
      "还没选文件时，导入按钮是灰的");

    /* 3) 选文件 → 预览（还不写库） */
    console.log("\n选一份真 CSV：先给预览，这时候一个字都还没写进数据");
    await pickFile("#import-file", csvFile);
    ok(await waitFor('document.querySelector(".gm-import-preview").textContent.includes("认出来")', 8000),
      "选完文件当场就有预览");
    eq(readData(dataFile).gameRecords.length, 0, "只是预览，还没写进数据");

    const sum = (await textOf(".gm-import-sum")) || "";
    ok(sum.includes("认出来 3 行"), "预览写着「认出来 3 行」（" + sum + "）");
    ok(sum.includes("跳过 1 行"), "预览写着「跳过 1 行」");
    ok(sum.includes("第 5 行") && sum.includes("时长认不出"), "跳过的行连行号和原因一起说");
    const tbl = (await textOf(".gm-import-table")) || "";
    ok(tbl.includes("Hades"), "预览的表里有游戏名");
    ok(tbl.includes("12 小时 30 分钟"), "12.5h 换成了人话（12 小时 30 分钟）");
    ok(tbl.includes(d13), "日期归一成 YYYY-MM-DD 再给人看");
    eq(await textOf('[data-dlg-act="import"]'), "导入 3 条", "确认按钮写着会导入几条");

    /* 4) 确认 → 落库 */
    console.log("\n确认导入：写进 gameRecords");
    await ev('document.querySelector(\'[data-dlg-act="import"]\').click()');
    await sleep(700);
    const rows = readData(dataFile).gameRecords;
    eq(rows.length, 3, "库里多了 3 条游玩记录");
    const byName = Object.fromEntries(rows.map((r) => [r.gameName, r]));
    eq((byName["Hades"] || {}).playDate, d13, "Hades 那条的日期归一成了 " + d13);
    eq((byName["Hades"] || {}).durationMin, 750, "12.5h 存成了 750 分钟");
    eq((byName["Hades"] || {}).remark, "通了一次", "备注带过来了");
    eq((byName["Hades"] || {}).gameId, "g-hades", "名字对得上清单里那款，自动绑了 gameId");
    eq((byName["Stardew Valley"] || {}).durationMin, 90, "90m 就是 90 分钟");
    eq((byName["Stardew Valley"] || {}).gameId, "", "清单里没这款，就不绑 id（照旧当临时记录）");
    eq((byName["Hollow Knight"] || {}).durationMin, 90, "1:30 按 1 小时 30 分算");
    eq((byName["Hollow Knight"] || {}).remark, "打 boss", "带空格的备注也读得到");
    ok(rows.every((r) => r.id && r.createAt), "每条都有 id 和时间戳");
    ok(
      rows.every(
        (r) => Array.isArray(r.tags) && Array.isArray(r.assetIds) && Array.isArray(r.imagePaths)
      ),
      "标签 / 素材 / 图片三栏都在（空数组，不是缺字段）"
    );

    /* 5) 统计 / 排行自动跟着变 */
    console.log("\n统计和排行：同一张表，自动跟着变");
    const monthCell = await ev(
      '(()=>{const c=[...document.querySelectorAll(".gm-stat")]' +
      '.find(n=>n.textContent.includes("本月"));return c?c.textContent.trim():"";})()'
    );
    ok(monthCell.includes("930 分钟"), "「本月」写着 930 分钟（" + monthCell + "）");
    ok(monthCell.includes("15.5 小时"), "「本月」也写着 15.5 小时");
    ok(
      await ev('[...document.querySelectorAll(".gm-top")].some(li=>li.textContent.includes("Hades"))'),
      "TOP 排行里冒出了 Hades"
    );

    /* 6) 同一份再导一遍：全跳过 */
    console.log("\n再导一遍同一份：预览说会全跳过，库里不重复");
    await ev('document.querySelector(\'[data-act="gm-import"]\').click()');
    ok(await waitFor('!!document.getElementById("import-file")', 5000), "弹窗又开出来了");
    await pickFile("#import-file", csvFile);
    ok(await waitFor('document.querySelector(".gm-import-preview").textContent.includes("认出来")', 8000),
      "第二次也有预览");
    const dupe = (await textOf(".gm-import-dupe")) || "";
    ok(dupe.includes("3 行"), "预览说这 3 行和库里重了（" + dupe + "）");
    eq(await textOf('[data-dlg-act="import"]'), "导入 0 条", "确认按钮写着「导入 0 条」");
    ok(await ev('document.querySelector(\'[data-dlg-act="import"]\').disabled'),
      "没有新记录可导时，按钮是灰的");
    eq(readData(dataFile).gameRecords.length, 3, "库里还是那 3 条");
    await ev('document.querySelector(\'[data-dlg-act="import"]\').click()');
    await sleep(400);
    eq(readData(dataFile).gameRecords.length, 3, "点了灰按钮，一条都没多");
    await ev('document.querySelector(\'.dlg-backdrop [data-dlg-act="cancel"]\').click()');
    await sleep(400);
    ok(await ev('!document.querySelector(".dlg-backdrop")'), "「取消」把弹窗关掉了");

    /* 7) 手动记一条，比形状 */
    console.log("\n导入的那条和手动记的一条：字段一模一样");
    await ev('document.querySelector(\'[data-act="gm-add"]\').click()');
    ok(await waitFor('!!document.getElementById("item-gameName")', 5000), "手动记录的弹窗开得出来");
    await setFields({ "item-gameName": "手记一条", "item-duration": "30" });
    await ev('document.querySelector(\'[data-dlg-act="save"]\').click()');
    await sleep(800);
    const manual = readData(dataFile).gameRecords.find((r) => r.gameName === "手记一条");
    ok(Boolean(manual), "手动那条存下来了");
    const keysOf = (o) => Object.keys(o).sort().join(",");
    eq(keysOf(byName["Hades"]), keysOf(manual || {}), "字段一模一样（多一个少一个都会露出来）");

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
        path.basename(full).startsWith("小李-游戏导入-")) {
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

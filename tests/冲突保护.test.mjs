/* store.js 多窗口冲突保护的集成测试。
 *
 * 盯的就是这个 bug：A、B 两个窗口先后读了同一份数据，A 先保存；B 手里还是旧那份，
 * 直接写下去就把 A 的改动覆盖没了。修好之后 B 的保存会被后端按修订号拒掉，
 * 而 B 的改动必须**一直留着**，等用户自己决定 —— 既不静默丢掉，也不覆盖磁盘。
 *
 * 它要碰 DOM，所以自带一套最小桩（window / document / BroadcastChannel / fetch），
 * 不是纯逻辑测试，但也不需要真浏览器。
 * 跑法：node tests\冲突保护.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样不进「自检.cmd」——自检保持纯 Python。
 */

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  if (actual === expected) { pass++; console.log("  ok   " + label); }
  else {
    fail++;
    console.log("  FAIL " + label + "：期望 " + JSON.stringify(expected) +
      "，实际 " + JSON.stringify(actual));
  }
}

/* ---------------- 最小浏览器桩 ---------------- */

const docHandlers = [];
const mq = { matches: false, addEventListener() {} };

globalThis.window = {
  addEventListener() {},
  matchMedia() { return mq; },
};
globalThis.document = {
  documentElement: { dataset: {} },
  hidden: false,
  addEventListener(type, fn) { docHandlers.push([type, fn]); },
};

// 假通道：把 store.js 开的那条记下来，测试里可以冒充「另一个窗口」发消息，
// postMessage 也记下它广播出去的东西。
const channels = [];
const broadcasted = [];
globalThis.BroadcastChannel = class {
  constructor(name) { this.name = name; this.onmessage = null; channels.push(this); }
  postMessage(data) { broadcasted.push(data); }
  close() {}
};

const statusLines = [];
const conflictEvents = [];

/* ---------------- 假的「服务端 + 磁盘」 ---------------- */

let serverRev = 5;
let disk = {
  version: 1, rev: 5, memo: "初始内容",
  tasks: [], settings: { theme: "light", themeMode: "light" },
};
let busyOnce = false;   // 装一次「另一个进程正拿着写入闸」
let getCount = 0;
const posts = [];

/** 装成「另一个窗口刚保存过」：磁盘上已经换成新的一份、修订号也涨了 */
function anotherWindowSaved(rev, memo) {
  serverRev = rev;
  disk = { ...disk, rev, memo };
}

globalThis.fetch = async (url, opts) => {
  if (opts && opts.method === "POST") {
    const sent = JSON.parse(opts.body);
    posts.push(sent);
    if (busyOnce) {
      busyOnce = false;
      return {
        ok: false, status: 409,
        json: async () => ({ ok: false, busy: true, error: "文件正在保存，请稍后重试" }),
      };
    }
    if (sent.rev !== serverRev) {   // 后端那道「修订号对不上就拒写」
      return {
        ok: false, status: 409,
        json: async () => ({
          ok: false, conflict: true, rev: serverRev, error: "另一个窗口刚改过数据",
        }),
      };
    }
    serverRev += 1;
    disk = JSON.parse(opts.body);
    disk.rev = serverRev;
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, rev: serverRev, savedAt: "刚刚" }),
    };
  }
  getCount += 1;
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(disk)) };
};

const Store = await import("../app/web/store.js");
const { store } = Store;
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

Store.onStatus((text) => statusLines.push(text));
Store.onConflict((info) => conflictEvents.push(info));

await Store.initStore();

console.log("载入：手里的修订号就是磁盘上那个");
eq(store.data.rev, 5, "读到 rev = 5");
eq(store.dirty, false, "刚载入没有没落盘的东西");
eq(store.conflict, false, "没有冲突");

console.log("另一个窗口先保存过 → 这一次保存被拒，本窗口改动留住");
anotherWindowSaved(6, "别的窗口写的");
store.data.memo = "本窗口改的";
await Store.touch(true);
await tick();
eq(posts.length, 1, "确实往后端发了一次保存");
eq(posts[0].rev, 5, "带的是本窗口手里的 rev = 5");
eq(store.data.memo, "本窗口改的", "本窗口的改动还在内存里（没被刷新冲掉）");
eq(store.dirty, true, "仍然标着「有改动没落盘」");
eq(store.conflict, true, "进入冲突状态");
eq(store.conflictRev, 6, "记下了磁盘上的 rev = 6");
eq(store.data.rev, 5, "本窗口的 rev 没有被偷偷改成 6");
eq(disk.memo, "别的窗口写的", "磁盘上别人的改动一个字节都没动");
eq(conflictEvents.length, 1, "抛出了冲突事件（弹窗靠它）");
eq(conflictEvents[0].kind, "conflict", "事件类型是 conflict");
eq(statusLines[statusLines.length - 1].includes("数据冲突"), true,
  "状态栏说清了冲突（" + statusLines[statusLines.length - 1] + "）");

console.log("冲突没处理完之前，再点保存也不会往磁盘写");
const beforeBlocked = posts.length;
store.data.memo = "本窗口又改了一次";
await Store.touch(true);
await tick();
eq(posts.length, beforeBlocked, "一次 POST 都没多发");
eq(store.data.memo, "本窗口又改了一次", "改动还是留着");
eq(disk.memo, "别的窗口写的", "磁盘也没被动过");
eq(conflictEvents.length, 2, "把冲突事件再抛一次（不会静默失败，弹窗能再打开）");
eq(conflictEvents[1].kind, "conflict", "第二次抛的还是 conflict");

console.log("点了「导出备份 / 取消」这类动作：改动继续留着，只是暂时不写盘");
Store.holdLocalChanges();
eq(store.conflict, true, "仍是冲突状态");
eq(store.data.memo, "本窗口又改了一次", "改动还在，没被丢掉");

console.log("用户选「刷新并加载最新数据」：这才换掉本窗口那份");
await Store.discardAndReload();
eq(store.data.memo, "别的窗口写的", "换成了磁盘上那份");
eq(store.data.rev, 6, "修订号跟着磁盘走（6）");
eq(store.conflict, false, "冲突解除了");
eq(store.dirty, false, "不再有没落盘的东西");

console.log("冲突解除之后，本窗口照常能存");
store.data.memo = "和好之后改的";
await Store.touch(true);
await tick();
eq(store.data.rev, 7, "保存成功后修订号跟上（7）");
eq(store.dirty, false, "落盘了");
eq(store.conflict, false, "没有冲突");
eq(broadcasted[broadcasted.length - 1].rev, 7, "广播给别的窗口的是新修订号");
eq(disk.memo, "和好之后改的", "磁盘上是本窗口这份");

console.log("撞上「另一个进程正在写盘」（并发）：自动重试，不覆盖");
busyOnce = true;
store.data.memo = "并发时改的";
await Store.touch(true);
await tick();
eq(posts[posts.length - 1].rev, 7, "这一发带的是 rev = 7");
eq(store.conflict, false, "这是「忙」不是冲突，不该吓唬用户");
eq(store.data.memo, "并发时改的", "改动留着等重试");
await sleep(900);                    // 等它 600ms 后自己再试一次
eq(store.data.rev, 8, "自动重试成功，修订号成 8");
eq(disk.memo, "并发时改的", "重试这一次真的写进去了");

console.log("另一个窗口保存了、本窗口没什么要留的 → 直接跟上，不用问");
anotherWindowSaved(9, "别的窗口第三版");
const getsBefore = getCount;
await channels[0].onmessage({ data: { type: "saved", rev: 9 } });
eq(getCount, getsBefore + 1, "重新读了一份磁盘数据");
eq(store.data.memo, "别的窗口第三版", "界面换成了最新那份");
eq(store.data.rev, 9, "修订号也跟上了");
eq(conflictEvents.length, 2, "没打扰用户（没有新的弹窗事件）");

console.log("另一个窗口保存了、本窗口还有没落盘的改动 → 问一句，绝不擅自刷掉");
const getsBefore2 = getCount;
store.data.memo = "本窗口还没落盘的改动";
store.dirty = true;                  // 装成「改过、还没落盘」
await channels[0].onmessage({ data: { type: "saved", rev: 10 } });
eq(getCount, getsBefore2, "没有偷偷重新读磁盘");
eq(store.data.memo, "本窗口还没落盘的改动", "本窗口的改动还留着");
eq(store.data.rev, 9, "修订号也没被改");
eq(conflictEvents.length, 3, "抛了「磁盘已被别处更新」的事件给弹窗");
eq(conflictEvents[2].kind, "disk", "事件类型是 disk");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;

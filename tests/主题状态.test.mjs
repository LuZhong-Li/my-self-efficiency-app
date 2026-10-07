/* store.js 主题状态的集成测试：验证「跟随系统」真的会问系统、并实时跟着变。
 * 它要碰 DOM，所以这里自带一套最小桩（window / document / matchMedia / fetch），
 * 不是纯逻辑测试，但也不需要真浏览器。
 * 跑法：node tests\主题状态.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样不进「自检.cmd」——自检保持纯 Python。 */

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

const mediaListeners = [];
let systemIsDark = false;
const mq = {
  get matches() { return systemIsDark; },
  addEventListener(type, fn) { if (type === "change") mediaListeners.push(fn); },
};
const docHandlers = [];
let askedAbout = "";

globalThis.window = {
  addEventListener() {},
  matchMedia(query) { askedAbout = query; return mq; },
};
globalThis.document = {
  documentElement: { dataset: {} },
  hidden: false,
  addEventListener(type, fn) { docHandlers.push([type, fn]); },
};
globalThis.BroadcastChannel = undefined; // 别真开一条通道，否则 Node 进程不退出

const disk = { rev: 1, settings: { themeMode: "system" } };
const posted = [];
globalThis.fetch = async (url, opts) => {
  if (opts && opts.method === "POST") {
    posted.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, rev: 2, savedAt: "刚刚" }) };
  }
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(disk)) };
};

const Store = await import("../app/web/store.js");
const tick = () => new Promise((r) => setTimeout(r, 0));

await Store.initStore();

console.log("store.js：读系统偏好");
eq(askedAbout, "(prefers-color-scheme: dark)", "问的是「系统是不是深色」");
eq(Store.systemThemeSupported(), true, "浏览器支持这个特性");
eq(Store.themeModeOf(), "system", "读到 themeMode = system");
eq(Store.themeOf(), "light", "系统是浅色 → 界面用浅色");
eq(document.documentElement.dataset.theme, "light", "html 上挂的是 light");
eq(Store.store.data.settings.theme, "light", "老字段 theme 跟着记当前明暗");

console.log("store.js：系统切主题，界面实时跟上（不用刷新）");
systemIsDark = true;
for (const fn of mediaListeners) fn({ matches: true });
eq(document.documentElement.dataset.theme, "dark", "系统切深色 → 立刻变 dark");
eq(Store.themeOf(), "dark", "themeOf 也跟着变");

console.log("store.js：手动固定后就不再跟系统");
Store.setThemeMode("light");
eq(Store.themeModeOf(), "light", "模式固定成浅色");
eq(document.documentElement.dataset.theme, "light", "界面回到浅色");
systemIsDark = false;
for (const fn of mediaListeners) fn({});
systemIsDark = true;
for (const fn of mediaListeners) fn({});
eq(document.documentElement.dataset.theme, "light", "固定浅色后，系统再变也不动");

console.log("store.js：切回跟随系统立刻按当前系统来");
Store.setThemeMode("system");
eq(document.documentElement.dataset.theme, "dark", "系统是深色 → 立刻变深色");
Store.setThemeMode("dark");
eq(document.documentElement.dataset.theme, "dark", "固定深色");

console.log("store.js：老数据从 settings.theme 迁过来");
Store.store.data.settings = { theme: "dark" };
eq(Store.themeModeOf(), "dark", "只有老字段 theme=dark → 当深色模式");
eq(Store.themeOf(), "dark", "界面照旧是深色");
Store.applyTheme();
eq(Store.store.data.settings.themeMode, "dark", "老数据一保存就自动补齐 themeMode = dark");
eq(Store.store.data.settings.theme, "dark", "theme 同时被规范化");
Store.store.data.settings = {};
eq(Store.themeModeOf(), "light", "两个字段都没有 → 浅色（默认）");
Store.applyTheme();
eq(Store.store.data.settings.themeMode, "light", "什么都没有时补齐成浅色，不崩");

console.log("store.js：回到前台补读一次（睡眠唤醒后状态不错位）");
Store.setThemeMode("system");
systemIsDark = true;
for (const fn of mediaListeners) fn({}); // 先把界面变深
eq(document.documentElement.dataset.theme, "dark", "先跟着变成深色");
systemIsDark = false;                    // 系统悄悄切回浅色，但没触发 change
const onVisible = docHandlers.find(([t]) => t === "visibilitychange");
eq(Boolean(onVisible), true, "挂了 visibilitychange 监听");
onVisible[1]();
eq(document.documentElement.dataset.theme, "light", "回到前台补读 → 回到浅色");

console.log("store.js：改动会自动落盘");
await tick();
await tick();
eq(posted.length > 0, true, "切模式会写盘");
eq(posted[posted.length - 1].settings.themeMode, "system", "盘上记的是 themeMode = system");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;

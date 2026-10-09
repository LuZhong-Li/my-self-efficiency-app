/* 外壳：顶部信息栏 + 左侧固定导航 + 当前模块视图 + 底部状态栏 */

import {
  store, initStore, onChange, onStatus, onTheme,
  cycleTheme, themeModeOf, themeOf, systemThemeSupported,
} from "./store.js";
import { THEME_MODE_LABEL, nextThemeMode } from "./theme.js";
import { MODULES } from "./modules.js";
import { renderHome } from "./home.js";
import { renderPlan } from "./plan.js";
import { renderMedia } from "./media.js";
import { renderDev } from "./dev.js";
import { renderStudy } from "./study.js";
import { renderFinance } from "./finance.js";
import { renderFitness } from "./fitness.js";
import { renderDiet } from "./diet.js";
import { renderGame } from "./game.js";
import { renderSettings } from "./settings.js";
import { initSearch } from "./search.js";
import { icon } from "./icons.js";
import { markEnter } from "./ui.js";
import { toast } from "./dialog.js";
import { setupConflict } from "./conflict.js";

const view = document.getElementById("view");
const sideNav = document.getElementById("side-nav");
const statusEl = document.getElementById("status");
const themeBtn = document.getElementById("theme-btn");
let lastRoute = null;

/** 地址形如 #dev/p1：斜杠前面是模块，后面是模块内部的子页面 */
function route() {
  const raw = (location.hash || "").replace(/^#/, "");
  const [id, sub] = raw.split("/");
  return { id: MODULES.some((m) => m.id === id) ? id : "home", sub: sub || "" };
}

function renderNav() {
  const cur = route().id;
  sideNav.innerHTML = MODULES.map(
    (m) =>
      `<a class="side-item${m.id === cur ? " active" : ""}" href="#${m.id}" title="${m.name}">` +
      `<span class="side-icon">${icon(m.icon, 18)}</span>` +
      `<span class="side-label">${m.name}</span></a>`
  ).join("");
}

/** 顶部信息栏中间那句：动态问候 + 今天日期 */
function renderTopGreet() {
  const d = new Date();
  const h = d.getHours();
  const hello =
    h < 5 ? "夜深了" : h < 9 ? "早上好" : h < 12 ? "上午好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  document.getElementById("top-greet").textContent =
    `${hello}，今天是${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ` +
    `星期${"日一二三四五六"[d.getDay()]}`;
}

/** 按钮上的图标表示「点一下会变成什么」：浅→深、深→跟随系统、系统→浅色。
 *  这样三种状态一路循环，图标和提示永远对得上。 */
const NEXT_ICON = { light: "moon", dark: "system", system: "sun" };

function renderThemeButton() {
  const mode = themeModeOf();
  const dark = themeOf() === "dark";
  themeBtn.innerHTML = icon(NEXT_ICON[nextThemeMode(mode)], 18);
  if (mode === "system") {
    const now = systemThemeSupported()
      ? `系统现在是${dark ? "深色" : "浅色"}`
      : "读不到系统明暗，先按浅色显示";
    themeBtn.title = `当前为跟随系统模式（${now}）· 点击切到浅色`;
  } else {
    themeBtn.title = `点击切到${THEME_MODE_LABEL[nextThemeMode(mode)]}`;
  }
}

function render() {
  if (!store.loaded) return;
  renderNav();
  renderThemeButton();
  const { id, sub } = route();
  if (id === "home") renderHome(view);
  else if (id === "plan") renderPlan(view, sub);
  else if (id === "media") renderMedia(view, sub);
  else if (id === "dev") renderDev(view, sub);
  else if (id === "study") renderStudy(view);
  else if (id === "finance") renderFinance(view, sub);
  else if (id === "fitness") renderFitness(view);
  else if (id === "diet") renderDiet(view);
  else if (id === "game") renderGame(view);
  else renderSettings(view);

  const key = id + "/" + sub;
  if (key !== lastRoute) {
    markEnter(view);
    lastRoute = key;
  }
}

function setStatus(text, kind) {
  const mark = kind === "err" ? "⚠️" : kind === "ok" ? "✅" : "";
  statusEl.textContent = "数据状态：" + (mark ? mark + " " : "") + text;
  statusEl.className = "top-status" + (kind === "err" ? " err" : "");
}

async function boot() {
  renderTopGreet();
  onStatus(setStatus);
  onChange(render);
  onTheme(renderThemeButton);
  initSearch();
  setupConflict();
  themeBtn.addEventListener("click", () => {
    const mode = cycleTheme();
    if (store.loaded) toast(`明暗已切到「${THEME_MODE_LABEL[mode]}」`);
  });

  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    const health = await res.json();
    document.getElementById("foot-file").textContent = health.dataFile;
    document.getElementById("foot-server").textContent =
      location.origin + (health.version ? " · " + health.version : "");
  } catch {
    /* 拿不到 health 不影响使用，下面 initStore 失败时会给出提示 */
  }

  try {
    await initStore();
  } catch {
    view.innerHTML = `
      <section class="card">
        <h2>连不上本机服务</h2>
        <p class="hint">请确认那个黑窗口还开着；如果已经关掉，双击项目里的 启动.cmd 重新启动。</p>
      </section>`;
  }

  window.addEventListener("hashchange", render);
}

boot();

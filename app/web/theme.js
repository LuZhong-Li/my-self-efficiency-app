/* 明暗模式：纯逻辑，不碰 DOM 也不碰 store，方便用 Node 直接跑单测。
 *
 * 三种模式互斥，存进 数据.json 的 settings.themeMode：
 *   "light"   固定浅色
 *   "dark"    固定深色
 *   "system"  跟随操作系统（prefers-color-scheme）
 *
 * 只负责「策略 → 实际该用哪种明暗」的换算；真正读系统偏好、改 DOM、
 * 落盘都在 store.js（那边才有 window / document）。
 */

export const THEME_MODES = ["light", "dark", "system"];

export const THEME_MODE_LABEL = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

/** 认得出就是它，认不出就退回浅色。
 *  老数据只有 settings.theme（light / dark），这里顺手按它迁一次。 */
export function normalizeThemeMode(value, legacy) {
  if (THEME_MODES.includes(value)) return value;
  return legacy === "dark" ? "dark" : "light";
}

/** 模式 + 系统当前是不是暗色 → 真正该用的明暗。
 *  system 模式读不到系统偏好（老浏览器）时按浅色兜底。 */
export function resolveTheme(mode, systemDark) {
  if (mode === "dark") return "dark";
  if (mode === "light") return "light";
  return systemDark ? "dark" : "light";
}

/** 顶部快捷按钮的循环：浅色 → 深色 → 跟随系统 → 浅色 */
export function nextThemeMode(mode) {
  const i = THEME_MODES.indexOf(normalizeThemeMode(mode));
  return THEME_MODES[(i + 1) % THEME_MODES.length];
}

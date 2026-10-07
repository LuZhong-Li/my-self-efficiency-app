/* 明暗模式的纯逻辑测试：只测 theme.js 里不碰 DOM 的那部分。
 * 跑法：node tests\主题模式.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：这个测试不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。 */

import {
  THEME_MODES, THEME_MODE_LABEL, normalizeThemeMode, resolveTheme, nextThemeMode,
} from "../app/web/theme.js";

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

console.log("theme.js：三个模式互斥、认得出来");
eq(THEME_MODES.length, 3, "正好三种模式");
eq(THEME_MODES.join(","), "light,dark,system", "顺序就是循环顺序");
eq(normalizeThemeMode("light"), "light", "浅色");
eq(normalizeThemeMode("dark"), "dark", "深色");
eq(normalizeThemeMode("system"), "system", "跟随系统");
eq(normalizeThemeMode(undefined), "light", "没设置过 → 浅色（默认，和以前一样）");
eq(normalizeThemeMode(""), "light", "空串 → 浅色");
eq(normalizeThemeMode("System"), "light", "大小写不对就不认，退回浅色");
eq(normalizeThemeMode("乱写的"), "light", "认不出就退回浅色，不崩");

console.log("theme.js：老数据从 settings.theme 迁过来");
eq(normalizeThemeMode(undefined, "dark"), "dark", "老数据是深色 → 深色");
eq(normalizeThemeMode(undefined, "light"), "light", "老数据是浅色 → 浅色");
eq(normalizeThemeMode(undefined, "乱写的"), "light", "老字段也认不出 → 浅色");
eq(normalizeThemeMode("system", "dark"), "system", "新字段在就以它为准，不被老字段带偏");

console.log("theme.js：实际该用哪种明暗");
eq(resolveTheme("light", true), "light", "固定浅色：系统是深色也不跟");
eq(resolveTheme("dark", false), "dark", "固定深色：系统是浅色也不跟");
eq(resolveTheme("system", true), "dark", "跟随系统：系统深色 → 深色");
eq(resolveTheme("system", false), "light", "跟随系统：系统浅色 → 浅色");
eq(resolveTheme("system", undefined), "light", "跟随系统但读不到系统偏好 → 浅色兜底");
eq(resolveTheme("system", null), "light", "读不到（null）也兜底浅色");

console.log("theme.js：顶部按钮的循环");
eq(nextThemeMode("light"), "dark", "浅色 → 深色");
eq(nextThemeMode("dark"), "system", "深色 → 跟随系统");
eq(nextThemeMode("system"), "light", "跟随系统 → 浅色");
eq(nextThemeMode(undefined), "dark", "没设置过（当浅色）→ 深色");
eq(nextThemeMode("乱写的"), "dark", "认不出（当浅色）→ 深色");
eq(nextThemeMode(nextThemeMode(nextThemeMode("light"))), "light", "转三下回到原点");

console.log("theme.js：按钮文案");
eq(THEME_MODE_LABEL.light, "浅色", "浅色");
eq(THEME_MODE_LABEL.dark, "深色", "深色");
eq(THEME_MODE_LABEL.system, "跟随系统", "跟随系统");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;

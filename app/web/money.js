/* 金额换算与显示。
 *
 * 数据里金额一律存「分」的整数（amountCents），换算只在这里做——
 * 别在别处手写 * 100 / / 100，那是小数误差的来源（0.1 + 0.2 那种）。
 * 这里全是纯函数，不碰 DOM、不碰 store，所以能直接拿 Node 单独测。
 */

/** 把 "25.5" 这样的文本拆成整数分；不合法返回 null。
 *  用字符串拆小数点算，不经过浮点乘法，25.5 一定得到 2550。
 *  只管「长得对不对」，上下限由外面两个函数各自决定。 */
function parseYuan(text) {
  const s = String(text ?? "").trim();
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  const [intPart, fracPart = ""] = s.split(".");
  const cents = Number(intPart) * 100 + Number((fracPart + "00").slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** 记一笔的金额："25.5" → 2550 分。必须大于 0，上限 999,999.99 元
 *  （防手滑多打几个 0）。不合法返回 null。 */
export function yuanToCents(text) {
  const cents = parseYuan(text);
  return cents === null || cents <= 0 || cents > 99999999 ? null : cents;
}

/** 期初余额用："0" / "1826.3" → 整数分，**允许 0**（账户可以一分钱都没有）。
 *  负数、三位小数、非数字还是返回 null。 */
export function yuanToCentsNonNeg(text) {
  const cents = parseYuan(text);
  return cents === null || cents > 99999999 ? null : cents;
}

/** 2550 → "25.50"（不带符号、不带千分位） */
export function centsToYuan(cents) {
  const n = Math.abs(Math.round(Number(cents) || 0));
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;
}

/** 2550 → "¥25.50"；1234567 → "¥12,345.67"；-2550 → "-¥25.50" */
export function fmtMoney(cents) {
  const n = Math.round(Number(cents) || 0);
  return (n < 0 ? "-" : "") + "¥" + thousands(centsToYuan(n));
}

/** 月历格子里用的短格式：1000 元以上缩成 "1.2k"（截断，不四舍五入，
 *  免得把花掉的钱显示小了），否则给两位小数。不带货币符号。 */
export function fmtMoneyShort(cents) {
  const n = Math.abs(Math.round(Number(cents) || 0));
  if (n >= 100000) {
    const k = Math.floor(n / 10000) / 10; // 分 → 千元，保留一位（截断）
    return `${String(k).replace(/\.0$/, "")}k`;
  }
  return thousands(centsToYuan(n));
}

function thousands(text) {
  const [intPart, fracPart] = text.split(".");
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fracPart ? "." + fracPart : "");
}

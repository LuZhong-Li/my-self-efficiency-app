/* 债务的纯计算：只吃数据，不碰 DOM、不碰 store。
 * 和记账那边一个思路——剩余金额不存字段，每次算出来，免得和还款记录漂开。 */

/** 剩余 = 总额 − 已还之和 */
export function remainCents(item) {
  const total = Number(item && item.totalCents) || 0;
  const paid = ((item && item.repayments) || []).reduce(
    (sum, r) => sum + (Number(r.amountCents) || 0), 0);
  return total - paid;
}

/** 结清了没有：手动标过 done，或者剩余已经 ≤ 0 */
export function isSettled(item) {
  return Boolean(item && item.status === "done") || remainCents(item) <= 0;
}

/** "2026-10-20" 距今天几天（负数＝已经过了）。用 Date.UTC 算，
 *  免得夏令时/时区把天数算歪。没填到期日返回 null。 */
export function daysUntil(dueDate, today) {
  if (!dueDate) return null;
  const [y1, m1, d1] = String(dueDate).split("-").map(Number);
  const [y2, m2, d2] = String(today).split("-").map(Number);
  if ([y1, m1, d1, y2, m2, d2].some((n) => !Number.isFinite(n))) return null;
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
}

/** 这一笔现在的状态。7 天内到期算 soon，过了日子还没还完算 overdue。 */
export function dueState(item, today) {
  if (isSettled(item)) return "done";
  const days = daysUntil(item && item.dueDate, today);
  if (days === null) return "none";
  if (days < 0) return "overdue";
  if (days <= 7) return "soon";
  return "normal";
}

/** 合计：我欠别人 / 别人欠我 / 净（正数＝净负债）。只算没结清的。 */
export function totals(items) {
  let oweCents = 0;
  let owedCents = 0;
  for (const it of items || []) {
    if (isSettled(it)) continue;
    const remain = remainCents(it);
    if (it.type === "othersOweMe") owedCents += remain;
    else oweCents += remain;
  }
  return { oweCents, owedCents, netCents: oweCents - owedCents };
}

/** 近 days 天内到期（含已逾期）的未结清债务，按到期日从近到远 */
export function upcoming(items, today, days = 30) {
  return (items || [])
    .filter((it) => !isSettled(it) && it.dueDate)
    .map((it) => ({ item: it, days: daysUntil(it.dueDate, today) }))
    .filter((row) => row.days !== null && row.days <= days)
    .sort((a, b) => a.days - b.days)
    .map((row) => row.item);
}

/** 分成两组：未结清（到期日近的在前，没填到期日的排最后）+ 已结清 */
export function splitBySettled(items, today) {
  const open = [];
  const done = [];
  for (const it of items || []) (isSettled(it) ? done : open).push(it);
  const far = (it) => {
    const days = daysUntil(it.dueDate, today);
    return days === null ? Number.MAX_SAFE_INTEGER : days;
  };
  open.sort((a, b) => far(a) - far(b));
  return { open, done };
}

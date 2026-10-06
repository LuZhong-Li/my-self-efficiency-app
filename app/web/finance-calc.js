/* 记账的纯计算：只吃数组和数字，不碰 DOM、不碰 store。
 * 抽出来的理由：这些是记账里最容易算错的部分（结余方向、预算档位、
 * 哪天算超支），单独放一个文件就能用 Node 一条条断言，不用开浏览器。
 */

/** "2026-10-07" → "2026-10" */
export function monthKey(date) {
  return String(date || "").slice(0, 7);
}

/** "2026-10" → 这个月有几天（new Date(y, m, 0) 就是上个月的最后一天） */
export function daysInMonth(month) {
  const [y, m] = String(month).split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

/** 某天的收支合计 */
export function dayTotals(transactions, date) {
  let expenseCents = 0;
  let incomeCents = 0;
  for (const t of transactions || []) {
    if (t.date !== date) continue;
    if (t.type === "income") incomeCents += Number(t.amountCents) || 0;
    else expenseCents += Number(t.amountCents) || 0;
  }
  return { expenseCents, incomeCents };
}

/** 某月的合计。结余 = 收入 − 支出（正数才是攒下的）。 */
export function monthTotals(transactions, month) {
  let expenseCents = 0;
  let incomeCents = 0;
  for (const t of transactions || []) {
    if (monthKey(t.date) !== month) continue;
    if (t.type === "income") incomeCents += Number(t.amountCents) || 0;
    else expenseCents += Number(t.amountCents) || 0;
  }
  return { expenseCents, incomeCents, balanceCents: incomeCents - expenseCents };
}

/** 这个月每天各花了多少、收了多少：Map<"YYYY-MM-DD", { expenseCents, incomeCents }>
 *  月历画格子时一天查一次，比每天现过滤一遍数组快得多。 */
export function monthByDay(transactions, month) {
  const map = new Map();
  for (const t of transactions || []) {
    if (monthKey(t.date) !== month) continue;
    const cur = map.get(t.date) || { expenseCents: 0, incomeCents: 0 };
    if (t.type === "income") cur.incomeCents += Number(t.amountCents) || 0;
    else cur.expenseCents += Number(t.amountCents) || 0;
    map.set(t.date, cur);
  }
  return map;
}

/** 本月支出按分类汇总，金额从大到小；ratio 是占本月支出的比例。
 *  只算支出：收入分类少、金额集中，混进饼图没什么信息。 */
export function categoryTotals(transactions, month) {
  const sums = new Map();
  let total = 0;
  for (const t of transactions || []) {
    if (monthKey(t.date) !== month || t.type === "income") continue;
    const cents = Number(t.amountCents) || 0;
    sums.set(t.category, (sums.get(t.category) || 0) + cents);
    total += cents;
  }
  return [...sums.entries()]
    .map(([category, cents]) => ({ category, cents, ratio: total ? cents / total : 0 }))
    .sort((a, b) => b.cents - a.cents || (a.category < b.category ? -1 : 1));
}

/** 预算档位。ratio 不封顶（画进度条时自己 Math.min(1, ratio)），
 *  这样「超了多少」还有数可查。 */
export function budgetState(usedCents, budgetCents) {
  const used = Math.max(0, Number(usedCents) || 0);
  const budget = Math.max(0, Number(budgetCents) || 0);
  if (!budget) return { usedCents: used, budgetCents: 0, ratio: 0, level: "none" };
  const ratio = used / budget;
  const level = ratio > 1 ? "over" : ratio >= 0.8 ? "warn" : "ok";
  return { usedCents: used, budgetCents: budget, ratio, level };
}

/** 超支日：当月按天累计支出**第一次超过预算**之后，那些还有支出的日子。
 *  没设预算时返回空集合（没预算就没有「超支」可言）。 */
export function overDays(transactions, month, budgetCents) {
  const out = new Set();
  const budget = Number(budgetCents) || 0;
  if (!budget) return out;
  const byDay = monthByDay(transactions, month);
  let acc = 0;
  for (const day of [...byDay.keys()].sort()) {
    const { expenseCents } = byDay.get(day);
    if (!expenseCents) continue;
    acc += expenseCents;
    if (acc > budget) out.add(day);
  }
  return out;
}

/** 给 Array#sort 用：按 createdAt 从早到晚（同一天的账按记入顺序排） */
export function byCreatedAt(a, b) {
  const x = String(a.createdAt || "");
  const y = String(b.createdAt || "");
  return x < y ? -1 : x > y ? 1 : 0;
}

/** 一个账户的余额（分）：期初 + 这个账户的收入 − 这个账户的支出。
 *  不存余额字段——账目是唯一的可信来源，存了就会跟流水对不上。 */
export function accountBalanceCents(account, transactions) {
  const init = Number(account && account.initialBalanceCents) || 0;
  let net = 0;
  for (const t of transactions || []) {
    if (!account || t.accountId !== account.id) continue;
    net += t.type === "income" ? Number(t.amountCents) || 0 : -(Number(t.amountCents) || 0);
  }
  return init + net;
}

/** 账户余额汇总。已删除的账户（账目还在、账户不在列表里）默认也算进总余额，
 *  所以单独报一份出来，好在界面上说明白。
 *  返回 { listedCents, deletedCents, totalCents, deletedCount }。 */
export function balanceTotals(accounts, transactions) {
  const list = accounts || [];
  const ids = new Set(list.map((a) => a && a.id));
  let listedCents = 0;
  for (const a of list) listedCents += accountBalanceCents(a, transactions);

  let deletedCents = 0;
  const deletedIds = new Set();
  for (const t of transactions || []) {
    if (!t.accountId || ids.has(t.accountId)) continue;
    deletedIds.add(t.accountId);
    deletedCents += t.type === "income" ? Number(t.amountCents) || 0 : -(Number(t.amountCents) || 0);
  }
  return {
    listedCents,
    deletedCents,
    totalCents: listedCents + deletedCents,
    deletedCount: deletedIds.size,
  };
}

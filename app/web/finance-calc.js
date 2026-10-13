/* 记账的纯计算：只吃数组和数字，不碰 DOM、不碰 store。
 * 抽出来的理由：这些是记账里最容易算错的部分（结余方向、预算档位、
 * 哪天算超支），单独放一个文件就能用 Node 一条条断言，不用开浏览器。
 */

import { yuanToCents, yuanToCentsNonNeg, centsToYuan, fmtMoney } from "./money.js";
import { csvCell, csvText } from "./csv.js";

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

/** 本月某个方向的收支按分类汇总，金额从大到小；ratio 是占该方向合计的比例。
 *  type 默认 "expense"（记账页的环形图默认看支出，也可以切到收入）。 */
export function categoryTotals(transactions, month, type = "expense") {
  const sums = new Map();
  let total = 0;
  for (const t of transactions || []) {
    if (monthKey(t.date) !== month || t.type !== type) continue;
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

/**
 * 预算提醒那句话：用了不到 80% 就不提醒（返回 null），80% 起黄、过了 100% 红。
 * 档位本身是 budgetState 给的，这里只管「说出来」——
 * 文案里带真实数字（多少百分比 / 超了多少），颜色和放哪儿由调用方决定。
 * 三个地方共用它：记账页概览的总预算、分类预算每一行、首页的财务摘要。
 *
 * 返回 { level, pct, overCents, short, long }：short 给列表行，long 给能摆下整句的地方。
 */
export function budgetNotice(state) {
  const st = state || {};
  if (st.level !== "warn" && st.level !== "over") return null;
  const pct = Math.round((Number(st.ratio) || 0) * 100);
  const overCents = Math.max(0, (Number(st.usedCents) || 0) - (Number(st.budgetCents) || 0));
  if (st.level === "over") {
    return {
      level: "over", pct, overCents,
      short: `超 ${fmtMoney(overCents)}`,
      long: `已超 ${fmtMoney(overCents)}`,
    };
  }
  // 正好用满（100%）既不能说「快到了」（已经用光了），也还没超 —— 单独一句话
  if (pct >= 100) {
    return { level: "warn", pct, overCents: 0, short: "已用完", long: "已经用完了，后面花的都算超" };
  }
  return {
    level: "warn", pct, overCents: 0,
    short: `已用 ${pct}%`,
    long: `已用 ${pct}%，快到预算了`,
  };
}

/** 分类预算：每设了预算的分类一行，给出这个月用它多少、到哪一档。
 *  只列「设了预算」的分类（没设的不占地方），按用掉的钱从多到少排。
 *  categoryCents 形如 { "餐饮": 50000 }。 */
export function categoryBudgetStates(transactions, month, categoryCents) {
  const budgets = categoryCents || {};
  const used = new Map();
  for (const t of transactions || []) {
    if (monthKey(t.date) !== month || t.type !== "expense") continue;
    used.set(t.category, (used.get(t.category) || 0) + (Number(t.amountCents) || 0));
  }
  return Object.entries(budgets)
    .filter(([, cents]) => (Number(cents) || 0) > 0)
    .map(([category, cents]) => ({
      category,
      ...budgetState(used.get(category) || 0, cents),
    }))
    .sort((a, b) => b.usedCents - a.usedCents || (a.category < b.category ? -1 : 1));
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

/** 一个账户的余额（分）：期初 + 这个账户的收入 − 这个账户的支出 + 转入 − 转出。
 *  不存余额字段——账目和转账是唯一的可信来源，存了就会跟流水对不上。 */
export function accountBalanceCents(account, transactions, transfers = []) {
  const init = Number(account && account.initialBalanceCents) || 0;
  let net = 0;
  for (const t of transactions || []) {
    if (!account || t.accountId !== account.id) continue;
    net += t.type === "income" ? Number(t.amountCents) || 0 : -(Number(t.amountCents) || 0);
  }
  return init + net + transfersOfAccount(transfers, account && account.id).netCents;
}

/** 账户余额汇总。已删除的账户（账目还在、账户不在列表里）默认也算进总余额，
 *  所以单独报一份出来，好在界面上说明白。
 *  返回 { listedCents, deletedCents, totalCents, deletedCount }。 */
export function balanceTotals(accounts, transactions, transfers = []) {
  const list = accounts || [];
  const ids = new Set(list.map((a) => a && a.id));
  let listedCents = 0;
  for (const a of list) listedCents += accountBalanceCents(a, transactions, transfers);

  let deletedCents = 0;
  const deletedIds = new Set();
  for (const t of transactions || []) {
    if (!t.accountId || ids.has(t.accountId)) continue;
    deletedIds.add(t.accountId);
    deletedCents += t.type === "income" ? Number(t.amountCents) || 0 : -(Number(t.amountCents) || 0);
  }
  // 转账也一样：连着已删账户那头的钱别因为账户删了就凭空消失。
  // 两个账户都还在的转账不用管——一边转出一边转入，总余额里正好抵平。
  for (const raw of transfers || []) {
    const t = normalizeTransfer(raw);
    if (t.fromAccountId && !ids.has(t.fromAccountId)) {
      deletedIds.add(t.fromAccountId);
      deletedCents -= t.amountCents;
    }
    if (t.toAccountId && !ids.has(t.toAccountId)) {
      deletedIds.add(t.toAccountId);
      deletedCents += t.amountCents;
    }
  }
  return {
    listedCents,
    deletedCents,
    totalCents: listedCents + deletedCents,
    deletedCount: deletedIds.size,
  };
}

/** 账户表单（添加 / 编辑共用）的校验。纯函数：不碰 DOM，好在 Node 里一条条断言。
 *  入参 { name, initText, accounts, selfId }，返回
 *  { ok, name, initCents, nameErr, initErr }——ok 为 true 时两个 err 都是空串。
 *
 *  规矩（和设计文档一致）：
 *  - 名字：先 trim；空、超过 20 个字、跟别的「在用」账户重名都不行
 *    （重名忽略首尾空白和大小写；改自己时用 selfId 把自己排除掉）；
 *  - 期初余额：留空按 0；不能负数；最多两位小数；上限 999,999.99 元
 *    （跟「记一笔」的金额同一个上限，防手滑多打几个 0）。
 */
export function validateAccountInput({ name, initText, accounts, selfId = "" }) {
  const out = { ok: false, name: "", initCents: 0, nameErr: "", initErr: "" };

  const picked = String(name == null ? "" : name).trim();
  out.name = picked;
  if (!picked) {
    out.nameErr = "账户名称不能为空";
  } else if ([...picked].length > 20) {
    out.nameErr = "账户名称最多 20 个字";
  } else {
    const key = picked.toLowerCase();
    const clash = (accounts || []).some(
      (a) => a && a.id !== selfId && String(a.name || "").trim().toLowerCase() === key
    );
    if (clash) out.nameErr = "已经有同名账户了";
  }

  const raw = String(initText == null ? "" : initText).trim();
  if (raw === "") {
    out.initCents = 0;
  } else if (raw.startsWith("-")) {
    out.initErr = "期初余额不能小于 0";
  } else if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    out.initErr = "期初余额最多两位小数，只能填数字";
  } else {
    const cents = yuanToCentsNonNeg(raw);
    if (cents === null) out.initErr = "期初余额不能超过 999,999.99";
    else out.initCents = cents;
  }

  out.ok = !out.nameErr && !out.initErr;
  return out;
}

/* ---------------- 分类：兜底与当日筛选 ---------------- */

/** 内置的兜底分类。数据里没有 finance.categories（或者某一边是空的）时用这一套。
 *
 *  内容必须和服务端 app/服务.py 的 default_finance() + DEBT_CATEGORIES 一模一样：
 *  正常情况是服务端补（重启后第一次读数据就补上了），但服务端那个进程可能还停在
 *  旧版本上（2026-10-08 踩的就是这个：进程从 10-06 起一直没重启，前端拿到的新
 *  界面配着旧数据，弹窗里那排分类按钮就是空的一片）。有这一份兜底，
 *  界面不靠服务端也能把分类显示出来。
 *  自检里有一条「前端兜底分类和服务端骨架一模一样」盯着这两边别走岔。 */
export const DEFAULT_CATEGORIES = {
  expense: ["餐饮", "交通", "购物", "学习", "娱乐", "住房", "医疗", "其他", "债务还款"],
  income: ["工资", "兼职", "红包", "退款", "其他", "债务收款"],
};

/** 把缺的分类补齐，返回 true 表示真补过（调用方据此决定要不要落盘）。
 *
 *  只补空的那一边：整块 categories 不在、或者某一边不是数组 / 是空数组时才填默认值；
 *  已经有一串分类就一个都不动。将来做「自定义分类」时，用户删掉的分类不该被这里复活。 */
export function ensureCategories(finance) {
  if (!finance || typeof finance !== "object") return false;
  let changed = false;
  const cats = finance.categories;
  if (!cats || typeof cats !== "object" || Array.isArray(cats)) {
    finance.categories = {};
    changed = true;
  }
  for (const kind of ["expense", "income"]) {
    const cur = finance.categories[kind];
    if (!Array.isArray(cur) || !cur.length) {
      finance.categories[kind] = DEFAULT_CATEGORIES[kind].slice();
      changed = true;
    }
  }
  return changed;
}

/** 这一天出现过的分类（按当天条目的先后顺序去重）。
 *  当日明细头上那个筛选下拉用它——只列这天真有的分类，不把一整张分类表铺开。 */
export function dayCategories(list) {
  const out = [];
  for (const t of list || []) {
    const cat = t && t.category;
    if (cat && !out.includes(cat)) out.push(cat);
  }
  return out;
}

/** 按分类过滤；cat 传空串就是「全部」（返回一份浅拷贝，不动传进来的数组）。 */
export function filterByCategory(list, cat) {
  const rows = list || [];
  return cat ? rows.filter((t) => t && t.category === cat) : rows.slice();
}

/* ---------------- 账户转账（2026-10-12 加的） ----------------
   两个账户之间挪钱：单独一张 finance.transfers 表，一条转账就是一行。
   这么做的好处是收支统计压根看不见它 —— monthTotals / categoryTotals /
   环形图 / 预算 / 月历都只收 transactions，一行排除代码都不用写。 */

/** 一条转账读出来规整：金额取整、id 去空白、缺的字段补默认。
 *  读转账一律走这里（老数据、手改坏了的都不会把余额算崩）。 */
export function normalizeTransfer(row) {
  const src = row && typeof row === "object" ? row : {};
  const text = (v) => String(v == null ? "" : v).trim();
  return {
    id: text(src.id),
    amountCents: Math.abs(Math.round(Number(src.amountCents) || 0)),
    date: text(src.date),
    fromAccountId: text(src.fromAccountId),
    toAccountId: text(src.toAccountId),
    note: text(src.note),
    createdAt: text(src.createdAt),
    imagePaths: Array.isArray(src.imagePaths)
      ? src.imagePaths.filter((p) => typeof p === "string" && p.trim())
      : [],
  };
}

/** 这个账户的转入 / 转出 / 净额（分）——余额就是在这上面加一项 */
export function transfersOfAccount(transfers, accountId) {
  const id = String(accountId == null ? "" : accountId).trim();
  let inCents = 0;
  let outCents = 0;
  if (id) {
    for (const raw of transfers || []) {
      const t = normalizeTransfer(raw);
      if (t.toAccountId === id) inCents += t.amountCents;
      if (t.fromAccountId === id) outCents += t.amountCents;
    }
  }
  return { inCents, outCents, netCents: inCents - outCents };
}

/** 转账表单的校验。形状照 validateAccountInput：错误按字段分开报，好在框下面写。
 *  账户不够两个是最要紧的一句，先说它，别去挑金额的毛病。 */
export function validateTransferInput({ amount, date, fromAccountId, toAccountId, accounts }) {
  const out = { ok: false, amountCents: 0, amountErr: "", dateErr: "", fromErr: "", toErr: "", hint: "" };
  const list = accounts || [];
  if (list.length < 2) {
    out.hint = "先在「账户」卡片上加第二个账户，才能记转账（至少要有两个）。";
    return out;
  }
  out.amountCents = yuanToCents(amount);
  if (out.amountCents === null) {
    out.amountErr = "金额要填一个正数，最多两位小数（上限 999,999.99）";
  }
  const day = String(date == null ? "" : date).trim();
  if (!day) out.dateErr = "日期不能为空";
  const from = String(fromAccountId == null ? "" : fromAccountId).trim();
  const to = String(toAccountId == null ? "" : toAccountId).trim();
  const has = (id) => list.some((a) => a && String(a.id) === id);
  if (!from || !has(from)) out.fromErr = "选一个「从」哪个账户转出";
  if (!to || !has(to)) out.toErr = "选一个「到」哪个账户";
  else if (to === from) out.toErr = "「从」和「到」不能是同一个账户";
  out.ok = !out.amountErr && !out.dateErr && !out.fromErr && !out.toErr;
  return out;
}

/* ---------------- CSV 导出（2026-10-13 加的） ----------------
   一行一条记录，账目和转账都在一份里：金额一律正数，方向看「类型」那一列，
   这样 Excel 里按「类型」一筛就是一张表，不用猜正负号是什么意思。
   这里只管把表格拼成文本 —— 真正下载交给浏览器（store.js 的 downloadText）。 */

/** 表头七列：转账多的那两列（分类 / 到账账户）账目留空 */
export const CSV_HEAD = ["日期", "类型", "分类", "金额", "账户", "到账账户", "备注"];

/* 拼格子和拼整份文本都在 csv.js（和自媒体共用一份），这里只管「记账有哪些列」 */

/** 账户 id → 名字；不在列表里（删了的）写「（账户已删）」，不写一个认不出的 id */
function csvAccountName(accounts, id) {
  const key = String(id == null ? "" : id).trim();
  if (!key) return "";
  const hit = (accounts || []).find((a) => a && String(a.id) === key);
  return hit ? String(hit.name || "") : "（账户已删）";
}

/**
 * 账目 + 转账摊成「一行一条」的表格（还没拼成文本，方便单测）。
 * 排序：先按日期，同一天按记录顺序（createdAt）。
 *
 * @param {object[]} txs 账目
 * @param {object[]} transfers 转账
 * @param {{accounts?: object[], month?: string}} options
 *        month 传 "2026-10" 就只导这个月；不传就是全部
 */
export function financeRows(txs, transfers, options = {}) {
  const accounts = options.accounts || [];
  const month = String(options.month || "").trim();
  const keep = (date) => !month || String(date || "").startsWith(month);
  const rows = [];
  for (const t of txs || []) {
    if (!t || typeof t !== "object") continue;
    if (!keep(t.date)) continue;
    rows.push({
      date: String(t.date || ""),
      createdAt: String(t.createdAt || ""),
      row: [
        String(t.date || ""),
        t.type === "income" ? "收入" : "支出",
        String(t.category || ""),
        centsToYuan(t.amountCents),
        csvAccountName(accounts, t.accountId),
        "",
        String(t.note == null ? "" : t.note),
      ],
    });
  }
  for (const raw of transfers || []) {
    const t = normalizeTransfer(raw);
    if (!keep(t.date)) continue;
    rows.push({
      date: t.date,
      createdAt: t.createdAt,
      row: [
        t.date,
        "转账",
        "",
        centsToYuan(t.amountCents),
        csvAccountName(accounts, t.fromAccountId),
        csvAccountName(accounts, t.toAccountId),
        t.note,
      ],
    });
  }
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.createdAt === b.createdAt) return 0;
    return a.createdAt < b.createdAt ? -1 : 1;
  });
  return rows.map((r) => r.row);
}

/** 表格 → CSV 文本：开头带 UTF-8 BOM（Excel 打开中文才不乱码），行尾用 \r\n */
export function financeCsv(rows) {
  return csvText(CSV_HEAD, rows);
}

/* ---------------- 明细的筛选：时间段 + 账户（2026-10-13 加的） ----------------
   明细卡片原来只看「选中的那一天」。这一版能切「本月 / 自定义时间段」，
   再叠一个「只看某个账户」——顺带把一直缺的「整月账目列表」补上了。
   纯逻辑只负责把条件归一成一段时间 + 一个账户，再把那批账挑出来；
   画不画折行、筛选栏长什么样，是 finance.js 的事。 */

/** 明细卡片能选的范围：当天 / 本月 / 自定义时间段 */
export const LEDGER_SCOPES = ["day", "month", "range"];

/**
 * 把筛选条件归一成一段时间 + 一个账户，后面取数和合计都只看这三个。
 *   day   —— 日历上选中的那一天
 *   month —— 选中的那个月（整月账目列表就是它）
 *   range —— 用户自己填的起止日期：填反了自动换过来，只填一头另一头补上，
 *            两头都空就当回「当天」（别一不小心把整本账倒出来）
 * 认不出来的范围一律当「当天」。
 *
 * @param {{scope?: string, from?: string, to?: string, accountId?: string}} filter
 * @param {{selected?: string, month?: string}} ctx
 */
export function ledgerRange(filter, ctx = {}) {
  const f = filter || {};
  const selected = String(ctx.selected || "");
  const month = String(ctx.month || "");
  const scope = LEDGER_SCOPES.includes(f.scope) ? f.scope : "day";
  let from = "";
  let to = "";
  if (scope === "month") {
    from = month ? month + "-01" : "";
    to = month ? month + "-31" : "";
  } else if (scope === "range") {
    from = String(f.from || "").slice(0, 10);
    to = String(f.to || "").slice(0, 10);
    if (!from && !to) {
      from = selected;
      to = selected;
    } else if (!from) from = to;
    else if (!to) to = from;
    if (from > to) {
      const swap = from;
      from = to;
      to = swap;
    }
  } else {
    from = selected;
    to = selected;
  }
  return { scope, from, to, accountId: String(f.accountId || "").trim() };
}

/** 一段时间里的账目合计。结余 = 收入 − 支出（和月度口径一致）。
 *  和 dayTotals 一个脾气：多一个「结余」，省得调用方各算各的。 */
export function rangeTotals(transactions, from, to) {
  let expenseCents = 0;
  let incomeCents = 0;
  for (const t of transactions || []) {
    if (!t) continue;
    const date = String(t.date || "");
    if (from && date < from) continue;
    if (to && date > to) continue;
    if (t.type === "income") incomeCents += Number(t.amountCents) || 0;
    else expenseCents += Number(t.amountCents) || 0;
  }
  return { expenseCents, incomeCents, balanceCents: incomeCents - expenseCents };
}

/**
 * 明细卡片要画的那一批：账目按时间段 + 账户筛出来，转账另外给一份
 * （转账不算收支，所以单列一块、不进 totals）。
 * 转账跟账户的关系是「两头任一边是这个账户都算」——钱从它出或进它都关它的事。
 *
 * @returns {{from: string, to: string, accountId: string,
 *            scope: string,
 *            rows: object[], transfers: object[],
 *            totals: {expenseCents: number, incomeCents: number, balanceCents: number},
 *            count: number}}
 */
export function ledgerOf(transactions, transfers, filter, ctx = {}) {
  const { scope, from, to, accountId } = ledgerRange(filter, ctx);
  const inRange = (date) => (!from || date >= from) && (!to || date <= to);
  const mine = (id) => !accountId || String(id || "") === accountId;
  const rows = (transactions || [])
    .filter((t) => t && inRange(String(t.date || "")) && mine(t.accountId))
    .sort(byCreatedAt);
  const tfs = (transfers || [])
    .map(normalizeTransfer)
    .filter((t) => inRange(t.date) && (mine(t.fromAccountId) || mine(t.toAccountId)))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  // scope 也带出去：界面靠它决定标题、头上那句说明、以及要不要在每行前面写日期
  return {
    scope, from, to, accountId,
    rows, transfers: tfs,
    totals: rangeTotals(rows, from, to),
    count: rows.length,
  };
}

/* ---------------- 常用账目模板（2026-10-13 加的） ----------------
   常记的那几笔（午饭、房租、工资）存成模板，下次点一下就填好。
   模板只存「记一笔」表单里那几个字段：类型 / 分类 / 金额 / 账户 / 备注 ——
   图片不存（每次的截图都不一样），日期也不存（用哪天的就是哪天的）。
   它是配置、不是记录：不进全局搜索、不进明细列表、不参与任何统计。 */

/** 最多存几个模板（再多就该删了） */
export const TEMPLATE_LIMIT = 8;

/**
 * 读一条模板：金额取整、账户 id 去空白、只留该留的键。
 * 类型只认 expense / income —— 转账不做模板（它没有分类，形状也对不上）。
 */
export function normalizeTemplate(row) {
  const src = row && typeof row === "object" ? row : {};
  const text = (v) => String(v == null ? "" : v).trim();
  return {
    id: text(src.id),
    type: src.type === "income" ? "income" : "expense",
    category: text(src.category) || "其他",
    amountCents: Math.abs(Math.round(Number(src.amountCents) || 0)),
    accountId: text(src.accountId),
    note: text(src.note),
  };
}

/** 从一笔账（或者「记一笔」表单里填好的东西）捏一个模板出来 */
export function templateFromTx(row) {
  return normalizeTemplate(row);
}

/** 财务那块里的模板列表（老数据没这个键就是空的，手改坏了也当空） */
export function templatesOf(finance) {
  const list = finance && Array.isArray(finance.templates) ? finance.templates : [];
  return list.map(normalizeTemplate).filter((t) => t.amountCents > 0 || t.note);
}

/** 胶囊上写什么：有备注就用备注，没有就「分类 金额」；收入带个加号好认 */
export function templateLabel(tpl) {
  const t = normalizeTemplate(tpl);
  if (t.note) return t.note;
  const money = fmtMoney(t.amountCents);
  return t.type === "income" ? `${t.category} +${money}` : `${t.category} ${money}`;
}

/**
 * 往列表里加一个模板。同一笔（类型 + 分类 + 金额 + 备注都一样）算重复，不重复加；
 * 满了（TEMPLATE_LIMIT 个）也不加，让用户自己删一个。
 * 返回 { list, status }：status 是 "added" / "dup" / "full"，界面照它说话。
 * 不改传进来的数组（返回新数组），方便单测。
 */
export function addTemplate(list, tpl) {
  const rows = (list || []).map(normalizeTemplate);
  const next = normalizeTemplate(tpl);
  const same = (a, b) =>
    a.type === b.type && a.category === b.category &&
    a.amountCents === b.amountCents && a.note === b.note;
  if (rows.some((r) => same(r, next))) return { list: rows, status: "dup" };
  if (rows.length >= TEMPLATE_LIMIT) return { list: rows, status: "full" };
  const id = next.id || `tpl-${Date.now().toString(36)}-${rows.length}`;
  return { list: rows.concat([{ ...next, id }]), status: "added" };
}

/* ---------------- 近 6 个月趋势（2026-10-13 加的） ----------------
   记账页一直是「一个月一个月」的：月历按月翻、概览和环形图只看当前那个月。
   这一组给趋势图备数据：最近几个月各是多少、柱高按什么比例算、合计与月均。
   口径走现成的 monthTotals —— 图上和概览上的数永远是同一个来源。 */

/** "2026-10" 往回数 → ["2026-05" … "2026-10"]（升序、含当月；跨年接得上） */
export function lastMonths(month, count = 6) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month == null ? "" : month).trim());
  if (!m) return [];
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const end = Number(m[1]) * 12 + (Number(m[2]) - 1);   // 以「0 年 1 月」为 0 的月序号
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const at = end - i;
    out.push(`${Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

/**
 * 每个月那一头的数 + 给画柱用的比例。
 * ratio = 这个月 / 最高的那个月（全是 0 时都给 0，不除零）——柱高直接用它。
 */
export function monthTrend(transactions, months, type = "expense") {
  const list = (months || []).map((month) => {
    const totals = monthTotals(transactions, month);
    return { month, cents: type === "income" ? totals.incomeCents : totals.expenseCents };
  });
  const max = list.reduce((best, row) => Math.max(best, row.cents), 0);
  return list.map((row) => ({ ...row, ratio: max ? row.cents / max : 0 }));
}

/** 卡片头上那句：几个月一共多少、月均多少（空月份也算进分母，好和「每月大概花多少」对上） */
export function trendSummary(series) {
  const rows = series || [];
  const totalCents = rows.reduce((sum, r) => sum + (Number(r && r.cents) || 0), 0);
  return { totalCents, avgCents: rows.length ? Math.round(totalCents / rows.length) : 0 };
}

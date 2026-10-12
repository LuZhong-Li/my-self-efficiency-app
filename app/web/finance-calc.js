/* 记账的纯计算：只吃数组和数字，不碰 DOM、不碰 store。
 * 抽出来的理由：这些是记账里最容易算错的部分（结余方向、预算档位、
 * 哪天算超支），单独放一个文件就能用 Node 一条条断言，不用开浏览器。
 */

import { yuanToCents, yuanToCentsNonNeg, centsToYuan, fmtMoney } from "./money.js";

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

/** CSV 里一个格子：带逗号 / 引号 / 换行的裹进引号，里面的引号翻倍 */
export function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return '"' + text.replace(/"/g, '""') + '"';
}

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
  const lines = [CSV_HEAD].concat(rows || []);
  return "\ufeff" + lines.map((r) => (r || []).map(csvCell).join(",")).join("\r\n") + "\r\n";
}

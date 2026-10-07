/* 首页的纯逻辑：哪个视图显示哪些卡片、卡片正面写什么、提示写什么、
 * 今天的进度怎么算。全部只吃数据、吐结果，不碰 DOM、不碰 store——
 * 这样能像记账、债务那样用 node 直接跑测试（tests/首页视图.test.mjs）。
 *
 * 传进来的 data 和 store.data 长一个样（tasks / contents / projects /
 * finance.transactions / debt.items …），所以这里自带一个认路径的取表函数。
 */

import { SUMMARY_MODULES, HOME_HIGHLIGHT_MODULES, HOME_OTHER_MODULES, moduleOf } from "./modules.js";
import { dayTotals, monthTotals } from "./finance-calc.js";
import { fmtMoney } from "./money.js";
import { upcoming, remainCents, dueState, daysUntil } from "./debt-calc.js";
import { fmtCount, growthText, overviewOf, isArchived, isPublished, weekRangeOf } from "./media-calc.js";

/** 简洁模式最多直接列几条待办，多的收进「查看更多待办」 */
export const HOME_TASK_LIMIT = 4;

/** 视图设置：认不出的一律当简洁（和 store.js 里 skinOf() 的兜底一个写法） */
export function normalizeHomeView(raw) {
  return raw === "full" ? "full" : "simple";
}

/** 快速备忘是不是收起了：只有明确的 true 才算收起（老数据没这个键 = 展开） */
export function normalizeMemoCollapsed(raw) {
  return raw === true;
}

/** 按 "finance.transactions" 这种路径取一张表；缺键、类型不对都给空数组，不抛。 */
export function rows(data, key) {
  const parts = String(key).split(".");
  let holder = data || {};
  for (const part of parts.slice(0, -1)) {
    const next = holder ? holder[part] : null;
    if (!next || typeof next !== "object") return [];
    holder = next;
  }
  const list = holder ? holder[parts[parts.length - 1]] : null;
  return Array.isArray(list) ? list : [];
}

/** 那一天所在周的周一（本地日期，不走 UTC，免得时区把日子算歪） */
export function weekStartOf(today) {
  const [y, m, d] = String(today).split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  const p = (n) => String(n).padStart(2, "0");
  return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate());
}

function compareTasks(a, b) {
  if (Boolean(a.done) !== Boolean(b.done)) return a.done ? 1 : -1;
  const at = a.time || "99:99";
  const bt = b.time || "99:99";
  if (at !== bt) return at < bt ? -1 : 1;
  return (a.createdAt || "") < (b.createdAt || "") ? -1 : 1;
}

/** 今天那几条：做完的排最后，其余按时间点，没填时间点的排最后 */
export function todayTasks(tasks, today) {
  return (tasks || []).filter((t) => t && t.date === today).sort(compareTasks);
}

/** 昨天及更早没做完的，日期从早到晚 */
export function overdueTasks(data, today) {
  return rows(data, "tasks")
    .filter((t) => t && !t.done && t.date && t.date < today)
    .sort((a, b) => (a.date === b.date ? compareTasks(a, b) : a.date < b.date ? -1 : 1));
}

/** 今天的进度：总数 / 已完成 / 待安排 / 百分比，外加「列前 5 条、还剩几条」。
 *  待安排 = 今天没填时间点的条数（跟原来首页那个数字一个口径）。 */
export function progressOf(data, today) {
  const mine = todayTasks(rows(data, "tasks"), today);
  const done = mine.filter((t) => t.done).length;
  return {
    mine,
    total: mine.length,
    done,
    open: mine.length - done,
    untimed: mine.filter((t) => !t.time).length,
    percent: mine.length ? Math.round((done / mine.length) * 100) : 0,
    shown: mine.slice(0, HOME_TASK_LIMIT),
    hidden: Math.max(0, mine.length - HOME_TASK_LIMIT),
  };
}

function newest(items) {
  return items.slice().sort((a, b) => ((a.date || "") < (b.date || "") ? 1 : -1))[0];
}

/** 债务预警：只看已逾期或 7 天内到期的未结清债务，取到期最近的一笔；
 *  没有就返回 null（首页那一行整个不渲染，不留空白）。 */
export function debtWarningOf(data, today) {
  const first = upcoming(rows(data, "debt.items"), today, 7)[0];
  if (!first) return null;
  const remain = remainCents(first);
  const days = daysUntil(first.dueDate, today);
  const late = dueState(first, today) === "overdue";
  return {
    level: late ? "overdue" : "soon",
    itemId: first.id,
    name: first.name,
    remainCents: remain,
    text: `${late ? "已逾期" : "近 7 天待还"}：${first.name} ${fmtMoney(remain)}`,
    tip: late ? `已经过了 ${Math.abs(days)} 天` : days === 0 ? "今天到期" : `${days} 天后到期`,
  };
}

/** 财务摘要：今日支出 / 本月结余 + 一条债务预警（没有就是 null） */
export function financeBriefOf(data, today) {
  const txs = rows(data, "finance.transactions");
  const day = dayTotals(txs, today);
  const month = monthTotals(txs, today.slice(0, 7));
  return {
    hasAny: txs.length > 0,
    hasTodayExpense: day.expenseCents > 0,
    expense: fmtMoney(day.expenseCents),
    balance: fmtMoney(month.balanceCents),
    debt: debtWarningOf(data, today),
  };
}

/** 财务摘要那两格要显示的字：今天没花钱就是 ¥0.00（浅灰），
 *  一笔账都还没有时「本月结余」整格不渲染（不留空壳）。 */
export function financeTextOf(brief) {
  return {
    expenseLabel: "今日支出",
    expenseText: brief.expense,
    expenseMuted: !brief.hasTodayExpense,
    balanceLabel: "本月结余",
    balanceText: brief.hasAny ? brief.balance : "",
  };
}

/** 一张卡片的内容：main 是卡片正面那一行，sub / extra 是完整模式用的第二行，
 *  tip 是鼠标悬浮提示（正面只留核心数字，次要信息都进这里）。 */
export function summaryOf(id, data, today) {
  // 一条记录都没有的模块不摆「0 条」「0 分钟」这种空数字，直接说「暂无数据」；
  // 有记录但当天/本周是 0 的，照常给数字——「本周练了 0 次」本身就是有用的信息。
  if (!hasData(id, data)) return { main: "暂无数据", sub: "" };
  if (id === "media") {
    const items = rows(data, "contents");
    const ov = overviewOf(data, today);
    const growth = growthText(ov.weekGain, ov.lastWeekGain);
    const pending = items.filter((c) => !isArchived(c) && c.status === "待发布").length;
    const week = weekRangeOf(today);
    const weekPublished = items.filter(
      (c) => isPublished(c) && c.publishDate >= week.start && c.publishDate <= week.end
    ).length;
    return {
      main: `总粉 ${fmtCount(ov.totalFollowers)} ｜ 本周 ${growth.text}`,
      sub: `总播放 ${fmtCount(ov.totalViews)} ｜ 待发布 ${pending} 条`,
      extra:
        `本周已发 ${weekPublished} 条` + (ov.hitCount ? ` · 爆款 ${ov.hitCount} 条` : ""),
    };
  }
  if (id === "dev") {
    const running = rows(data, "projects").filter((p) => p.status === "进行中").length;
    const open = rows(data, "issues").filter((i) => !["已解决", "已关闭"].includes(i.status)).length;
    return { main: `${running} 个项目进行中`, sub: `未解决 bug ${open} 条` };
  }
  if (id === "study") {
    const all = rows(data, "studies");
    const start = weekStartOf(today);
    const week = all
      .filter((s) => s.date >= start && s.date <= today)
      .reduce((sum, s) => sum + (Number(s.minutes) || 0), 0);
    const pending = all.filter((s) => !s.reviewed).length;
    const last = newest(all);
    return {
      main: `本周学了 ${week} 分钟`,
      sub: pending
        ? `待复习 ${pending} 条`
        : last
        ? `最近：${last.date} ${last.content || ""}`.trim()
        : "还没有学习记录",
    };
  }
  if (id === "finance") {
    const txs = rows(data, "finance.transactions");
    const day = dayTotals(txs, today);
    const totals = monthTotals(txs, today.slice(0, 7));
    const debt = debtWarningOf(data, today);
    return {
      main: `今日支出 ${fmtMoney(day.expenseCents)}`,
      sub: txs.length ? `本月结余 ${fmtMoney(totals.balanceCents)}` : "还没有记账",
      extra: debt ? debt.text : "",
    };
  }
  if (id === "fitness") {
    const logs = rows(data, "workoutLogs");
    const start = weekStartOf(today);
    const days = new Set(
      logs.filter((l) => l.date >= start && l.date <= today).map((l) => l.date)
    );
    const last = newest(logs);
    return {
      main: `本周练了 ${days.size} 次`,
      sub: last ? `最近一次训练：${last.date}` : "还没有训练记录",
    };
  }
  if (id === "diet") {
    const meal = rows(data, "meals").find((m) => m.date === today);
    const water = rows(data, "water").find((w) => w.date === today);
    const eaten = meal
      ? ["breakfast", "lunch", "dinner", "snack"].filter((k) => (meal[k] || "").trim()).length
      : 0;
    const cups = water ? Number(water.cups) || 0 : 0;
    return { main: `今天记了 ${eaten} 餐`, sub: `喝水 ${cups} 杯` };
  }
  const playing = rows(data, "games").filter((g) => g.status === "在玩");
  return {
    main: playing.length ? `在玩 ${playing.length} 款` : "没有在玩的游戏",
    sub: playing.length ? playing.map((g) => g.name).join("、") : "还没有游戏记录",
  };
}

/** 一张摘要卡片：正面 main、第二行 sub / extra、hover 提示 tip */
export function cardOf(id, data, today) {
  const m = moduleOf(id);
  const s = summaryOf(id, data, today);
  const sub = s.sub || "";
  const extra = s.extra || "";
  return {
    id,
    name: m.name,
    icon: m.icon,
    main: s.main,
    empty: !hasData(id, data),
    sub,
    extra,
    tip: [sub, extra].filter(Boolean).join(" · "),
  };
}

/** 这个视图要画哪些卡：简洁 = 3 张高频（+ 3 张折叠）；完整 = 原来那 7 张平铺 */
export function cardsFor(view, data, today) {
  const mode = normalizeHomeView(view);
  const ids = mode === "full" ? SUMMARY_MODULES : HOME_HIGHLIGHT_MODULES;
  return {
    view: mode,
    highlight: ids.map((id) => cardOf(id, data, today)),
    other: HOME_OTHER_MODULES.map((id) => cardOf(id, data, today)),
  };
}

/** 这个模块到底有没有内容（「其他模块」面板要不要露脸就看它） */
export function hasData(id, data) {
  if (id === "media") {
    return rows(data, "contents").length > 0 || rows(data, "mediaAccounts").length > 0;
  }
  if (id === "dev") return rows(data, "projects").length > 0 || rows(data, "issues").length > 0;
  if (id === "study") return rows(data, "subjects").length > 0 || rows(data, "studies").length > 0;
  if (id === "fitness") return rows(data, "workoutLogs").length > 0 || rows(data, "weights").length > 0;
  if (id === "diet") return rows(data, "meals").length > 0 || rows(data, "water").length > 0;
  if (id === "game") return rows(data, "games").length > 0;
  if (id === "finance") return rows(data, "finance.transactions").length > 0;
  return false;
}

export function otherVisibleIn(data) {
  return HOME_OTHER_MODULES.some((id) => hasData(id, data));
}

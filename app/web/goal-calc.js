/* 模块目标的纯逻辑：目标长什么样、一句人话规则怎么解析成「今天该生成哪几条待办」、
 * 进度怎么算。全部只吃数据、吐结果，不碰 DOM、不碰 store —— 所以能像记账、首页那样
 * 用 node 直接跑断言（tests/目标计算.test.mjs）。页面那边只管把结果画出来。
 *
 * 两个概念分清楚：
 *   · 模块目标（这里）—— 模块级配置，一个模块可以有好几条，存在 data.moduleGoals 里；
 *   · 待办任务（tasks 表）—— 从目标拆出来的单次执行项，自动生成时会在任务上留
 *     sourceModule / goalId / genKey 三个字段，分别用来标来源、算进度、防重复生成。
 *
 * 数据结构（顶层一个 moduleGoals，按模块 id 分桶，每桶一个数组）：
 *   "moduleGoals": {
 *     "fitness": [ { id, moduleId, moduleName, mainTarget, cycle, startDate, endDate,
 *                    dailyRule, remark, isActive, autoTask, lastRun } ]
 *   }
 * 每个目标的字段一个都不少（缺的读出来补默认值），所以页面不用到处判空。
 */

/* ---------------- 三个能用目标的模块 ---------------- */

/** id / 显示名 / 简称（用在来源标签上）/ 进度单位 / 自动生成的待办归到哪个分类 */
export const GOAL_MODULES = [
  { id: "fitness", name: "健身计划", short: "健身", unit: "次", metric: "count", category: "运动" },
  { id: "study", name: "学习工作", short: "学习", unit: "天", metric: "days", category: "学习" },
  { id: "diet", name: "饮食计划", short: "饮食", unit: "天", metric: "days", category: "生活" },
];

export const GOAL_CYCLES = ["每日", "每周", "月度", "自定义起止日期"];

/** getDay() 的 0–6 对应到中文名字 */
export const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function goalModuleOf(id) {
  return GOAL_MODULES.find((m) => m.id === id) || null;
}

/** 自动生成的任务在「今日计划」上挂的来源标签，比如「健身目标任务」。
 *  游戏娱乐没有模块目标，但手动加进去的那条「玩游戏放松」也挂这个标签。 */
export function sourceLabelOf(moduleId) {
  if (moduleId === "game") return "游戏娱乐";
  const mod = goalModuleOf(moduleId);
  return (mod ? mod.short : "模块") + "目标任务";
}

/** 自动生成的任务落到哪个分类（今日计划的分类词表就四个） */
export function categoryOf(moduleId) {
  const mod = goalModuleOf(moduleId);
  return mod ? mod.category : "其他";
}

/* ---------------- 日期小工具（本地时区，不走 UTC） ---------------- */

export function weekdayOf(date) {
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

export function dayOfMonth(date) {
  return Number(String(date).slice(8, 10));
}

/** 那天所在周的周一（和 home-view.js 的 weekStartOf 一个算法） */
export function weekStartOf(today) {
  const [y, m, d] = String(today).split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  const p = (n) => String(n).padStart(2, "0");
  return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate());
}

export function weekRangeOf(today) {
  const start = weekStartOf(today);
  const [y, m, d] = start.split("-").map(Number);
  const end = new Date(y, m - 1, d + 6);
  const p = (n) => String(n).padStart(2, "0");
  return {
    start,
    end: end.getFullYear() + "-" + p(end.getMonth() + 1) + "-" + p(end.getDate()),
  };
}

/* ---------------- 一条目标：补齐字段 ---------------- */

/** 把一条目标补齐成完整形状。认不出的周期按「每日」算；开关缺省都是开。 */
export function normalizeGoal(raw, moduleId) {
  const src = raw && typeof raw === "object" ? raw : {};
  const mod = goalModuleOf(moduleId) || goalModuleOf(src.moduleId) || GOAL_MODULES[0];
  return {
    id: String(src.id || ""),
    moduleId: mod.id,
    moduleName: String(src.moduleName || mod.name),
    mainTarget: String(src.mainTarget || ""),
    cycle: GOAL_CYCLES.includes(src.cycle) ? src.cycle : "每日",
    startDate: String(src.startDate || ""),
    endDate: String(src.endDate || ""),
    dailyRule: String(src.dailyRule || ""),
    remark: String(src.remark || ""),
    isActive: src.isActive !== false,
    autoTask: src.autoTask !== false,
    lastRun: String(src.lastRun || ""),
  };
}

/** 某个模块那几条目标（原样引用，改它就是改数据）。moduleGoals 写成数组也认。 */
export function rawGoals(data, moduleId) {
  const box = data ? data.moduleGoals : null;
  if (!box) return [];
  if (Array.isArray(box)) return box.filter((g) => g && g.moduleId === moduleId);
  const mine = box[moduleId];
  if (!mine) return [];
  return Array.isArray(mine) ? mine : [mine];
}

/** 三个模块的目标全拿出来（进「今日计划」对表时用） */
export function allGoals(data) {
  const out = [];
  for (const mod of GOAL_MODULES) out.push(...rawGoals(data, mod.id));
  return out;
}

/**
 * 拿到某个模块的「桶」（那个数组），顺手把老形状搬成新形状：
 * moduleGoals 整个写成数组 → 按 moduleId 归成桶；一个模块直接放一个对象 → 包成数组。
 * 会写 data.moduleGoals（和 store.js 的 table() 一样，读的时候顺手补形状）。
 */
export function ensureBucket(data, moduleId) {
  if (!data) return [];
  if (Array.isArray(data.moduleGoals)) {
    const buckets = {};
    for (const goal of data.moduleGoals) {
      if (!goal || typeof goal !== "object" || !goal.moduleId) continue;
      (buckets[goal.moduleId] = buckets[goal.moduleId] || []).push(goal);
    }
    data.moduleGoals = buckets;
  }
  if (!data.moduleGoals || typeof data.moduleGoals !== "object") data.moduleGoals = {};
  const bucket = data.moduleGoals[moduleId];
  if (Array.isArray(bucket)) return bucket;
  if (bucket && typeof bucket === "object") {
    data.moduleGoals[moduleId] = [bucket];
    return data.moduleGoals[moduleId];
  }
  data.moduleGoals[moduleId] = [];
  return data.moduleGoals[moduleId];
}

/* ---------------- 自动任务规则：解析 ---------------- */

const WD_CHARS = "一二三四五六日天";
const WD_NUM = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 0,
};

function numOf(ch) {
  return WD_NUM[ch] === undefined ? null : WD_NUM[ch];
}

/** 「每周一、三、五」这种星期串：扫出星期几，外加它在原文里占哪一段（好把它从任务文字里抠掉） */
function scanWeekdays(text) {
  const head = new RegExp(`(?:每\\s*)?(?:周|星期|礼拜)\\s*[${WD_CHARS}1-7]`).exec(text);
  if (!head) return { weekdays: [], start: -1, end: -1 };
  const weekdays = [numOf(head[0].slice(-1))];
  let end = head.index + head[0].length;
  const SEP = new RegExp(`^\\s*(?:、|,|，|和|及|\\/|·)\\s*(?:周|星期|礼拜)?\\s*([${WD_CHARS}1-7])`);
  const PRE = new RegExp(`^\\s*(?:周|星期|礼拜)\\s*([${WD_CHARS}1-7])`);
  // 「一三五」连着写也认；但「三十分钟 / 三号 / 三次」里的三不算（后面跟着量词）
  const ADJ = new RegExp(`^([${WD_CHARS}])(?![十点号次小时分公米元餐顿杯遍组个])`);
  for (;;) {
    const rest = text.slice(end);
    const m = SEP.exec(rest) || PRE.exec(rest) || ADJ.exec(rest);
    if (!m) break;
    const num = numOf(m[1]);
    if (num !== null) weekdays.push(num);
    end += m[0].length;
  }
  return { weekdays: [...new Set(weekdays)], start: head.index, end };
}

/** 「每月 1 号 / 每月一号」 */
function scanMonthlyDays(text) {
  const re = new RegExp(`每\\s*(?:个)?\\s*月\\s*(?:的)?\\s*(\\d{1,2}|[${WD_CHARS}])\\s*[号日]`, "g");
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    const num = /^\d+$/.test(raw) ? Number(raw) : numOf(raw);
    if (num >= 1 && num <= 31) out.push(num);
  }
  return [...new Set(out)];
}

/** 任务文字：把「自动生成 / 待办 / 到今日计划」这些连接词和外面那层括号去掉 */
function cleanText(text) {
  return String(text)
    .replace(/自动生成|自动添加|自动|添加到|放入|加入|同步到|推送到|推送/g, "")
    .replace(/[到进放加]?\s*今日计划/g, "")
    .replace(/[【\[]\s*([^】\]]*?)\s*[】\]]/g, "$1")   // 【力量训练】→ 力量训练
    .replace(/[\s]*(?:待办|任务|提醒|打卡)+$/, "")
    .replace(/^[\s、,，:：;；\-—~～]+/, "")
    .replace(/[\s、,，:：;；]+$/, "")
    .trim();
}

/** 一小段规则里有没有时间词：用来决定逗号两边要不要拆成两条 */
function hasTimeToken(text) {
  return new RegExp(
    `(?:周|星期|礼拜)\\s*[${WD_CHARS}1-7]|每\\s*(?:天|日)|天天|每\\s*(?:个)?\\s*月`
  ).test(text);
}

/** 先按分号 / 句号 / 换行切（本来就是两条规则），再按逗号切（两边都带时间词才算两条） */
function splitClauses(text) {
  const rough = text.split(/[；;。\n]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const chunk of rough) {
    const parts = chunk.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every(hasTimeToken)) out.push(...parts);
    else out.push(chunk);
  }
  return out;
}

/** 一段规则 → 一条条「什么时候做什么」 */
function parseClause(clause) {
  const scan = scanWeekdays(clause);
  const monthlyDays = scanMonthlyDays(clause);
  const everyDay = /每\s*(?:天|日)|天天/.test(clause);
  let rest = clause;
  if (scan.start >= 0) rest = clause.slice(0, scan.start) + clause.slice(scan.end);
  rest = rest.replace(new RegExp(`每\\s*(?:个)?\\s*月\\s*(?:的)?\\s*(?:\\d{1,2}|[${WD_CHARS}])\\s*[号日]`, "g"), "");
  rest = rest.replace(/每\s*(?:天|日)|天天/, "");
  return { weekdays: scan.weekdays, monthlyDays, everyDay, text: cleanText(rest) };
}

/**
 * 把「自动任务规则」那句人话拆成若干条。
 * goal 只用来兜底：规则里没写星期几 / 每月几号时，按周期（每周靠开始日期那天、
 * 月度靠开始日期那个号）来定。
 */
export function parseRule(rule, goal = {}) {
  const text = String(rule || "").trim();
  if (!text) return [];
  return splitClauses(text).map((clause) => parseClause(clause));
}

/** 这一天该不该生成这条 */
export function clauseMatches(clause, date, goal = {}) {
  const wd = weekdayOf(date);
  if (clause.weekdays.length) return clause.weekdays.includes(wd);
  if (clause.monthlyDays.length) return clause.monthlyDays.includes(dayOfMonth(date));
  if (clause.everyDay) return true;
  // 规则里没写时间词：按目标自己的周期兜底
  if (goal.cycle === "每周") {
    return goal.startDate ? wd === weekdayOf(goal.startDate) : false;
  }
  if (goal.cycle === "月度") {
    return goal.startDate ? dayOfMonth(date) === dayOfMonth(goal.startDate) : false;
  }
  return true;    // 每日 / 自定义起止日期
}

/** 一条规则里「什么时候」那半句，给人看的（弹窗下面那句预览、卡片上那行提示） */
export function previewDays(clause, goal = {}) {
  if (clause.weekdays.length) {
    return "每" + clause.weekdays.map((d) => WEEKDAY_NAMES[d]).join("、");
  }
  if (clause.monthlyDays.length) {
    return clause.monthlyDays.map((d) => `每月 ${d} 号`).join("、");
  }
  if (clause.everyDay) return "每天";
  if (goal.cycle === "每周") return goal.startDate ? "每" + WEEKDAY_NAMES[weekdayOf(goal.startDate)] : "每周";
  if (goal.cycle === "月度") return goal.startDate ? `每月 ${dayOfMonth(goal.startDate)} 号` : "每月";
  return "每天";
}

/** ["每周一、周三、周五 力量训练", "周二、周四 有氧"] */
export function rulePreview(rule, goal = {}) {
  return parseRule(rule, goal)
    .map((clause) => `${previewDays(clause, goal)}${clause.text ? " " + clause.text : ""}`.trim())
    .filter(Boolean);
}

/** 上面那些拼成一行（卡片上显示用） */
export function ruleSummary(rule, goal = {}) {
  return rulePreview(rule, goal).join("；");
}

/* ---------------- 今天该生成哪些待办 ---------------- */

/** 目标在不在有效期内，而且是开着的 */
export function isActiveOn(goal, date) {
  if (!goal || goal.isActive === false) return false;
  if (goal.startDate && date < goal.startDate) return false;
  if (goal.endDate && date > goal.endDate) return false;
  return true;
}

function defaultTaskText(goal) {
  const mod = goalModuleOf(goal.moduleId);
  return (mod ? mod.short : "模块") + "目标任务";
}

/** 这一天这条目标该生成哪几条（还没管重复、也没写盘） */
export function tasksForDate(goal, date) {
  if (!goal || goal.autoTask === false || !isActiveOn(goal, date)) return [];
  const out = [];
  parseRule(goal.dailyRule, goal).forEach((clause, index) => {
    if (!clauseMatches(clause, date, goal)) return;
    out.push({
      key: `${goal.id}@${date}#${index}`,
      goalId: goal.id,
      moduleId: goal.moduleId,
      text: clause.text || defaultTaskText(goal),
    });
  });
  return out;
}

/**
 * 对一遍表：给「今天」挑出该补的待办。
 *
 * 防重复靠两道闸：
 *   1. genKey（目标 id + 日期 + 第几条规则）—— 同一个目标同一天同一条规则只生成一次；
 *   2. goal.lastRun —— 今天已经对过表就不再补，所以你自己删掉的那条不会被又加回来。
 *
 * 返回 { newTasks, markRun }：新任务交给调用方补 id / 时间再 push；markRun 那些目标
 * 要把 lastRun 记成今天。纯函数，不写盘、不改入参。
 */
export function planGoalTasks(goals, tasks, date) {
  const existing = new Set((tasks || []).map((t) => t && t.genKey).filter(Boolean));
  const newTasks = [];
  const markRun = [];
  for (const goal of goals || []) {
    if (!goal || goal.autoTask === false || !isActiveOn(goal, date)) continue;
    const items = tasksForDate(goal, date);
    if (!items.length) continue;
    if (goal.lastRun === date) continue;
    for (const item of items) {
      if (existing.has(item.key)) continue;
      existing.add(item.key);
      newTasks.push({
        id: "",
        date,
        time: "",
        text: item.text,
        done: false,
        doneAt: null,
        category: categoryOf(item.moduleId),
        note: "",
        belong: "goal",
        sourceModule: item.moduleId,
        goalId: item.goalId,
        genKey: item.key,
        imagePaths: [],
        createdAt: "",
      });
    }
    markRun.push(goal.id);
  }
  return { newTasks, markRun };
}

/* ---------------- 进度 ---------------- */

/**
 * 一条目标的进度：这条目标生成过的待办里，完成了多少。
 * 不管统计口径还是「本周」，数的都是「这条目标自己生成的待办」，
 * 所以你不勾它就不会虚高；手动加进来的普通待办也不掺进来。
 */
export function progressOf(goal, tasks, today) {
  const mine = (tasks || []).filter((t) => t && goal && t.goalId === goal.id);
  const done = mine.filter((t) => t.done);
  const week = weekRangeOf(today);
  const weekMine = mine.filter((t) => t.date && t.date >= week.start && t.date <= week.end);
  const weekDone = weekMine.filter((t) => t.done);
  const mod = goalModuleOf(goal.moduleId);
  return {
    total: mine.length,
    done: done.length,
    percent: mine.length ? Math.round((done.length * 100) / mine.length) : 0,
    weekTotal: weekMine.length,
    weekDone: weekDone.length,
    weekDays: new Set(weekDone.map((t) => t.date)).size,
    unit: mod ? mod.unit : "次",
    metric: mod ? mod.metric : "count",
    allText: `${done.length} / ${mine.length}`,
  };
}

/** 卡片上那行「月度 · 2026-10-07 → 2027-01-07」 */
export function cycleText(goal) {
  const cycle = goal.cycle === "自定义起止日期" ? "自定义" : goal.cycle;
  const range =
    goal.startDate || goal.endDate
      ? `${goal.startDate || "不限"} → ${goal.endDate || "不限"}`
      : "不限时间";
  return `${cycle} · ${range}`;
}

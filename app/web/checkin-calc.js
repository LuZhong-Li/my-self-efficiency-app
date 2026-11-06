/**
 * 签到（多站点）的纯逻辑：把服务端给的站点列表和状态整理成界面要的样子。
 *
 * 这里不碰 DOM、不发请求，方便用 Node 直接测。
 * 2026-11-04 重构成多站点：原来只有一个 WorkBuddy，现在是一列站点。
 */

/** 本周七个格子，周一起算 */
export function weekCells(week) {
  const src = Array.isArray(week) ? week : [];
  const out = [];
  for (let i = 0; i < 7; i++) out.push({ on: src[i] === true });
  return out;
}

/**
 * 一个站点现在是什么状态。七档，每一档界面上的话都不一样：
 *   unconfigured 还没填凭证 / disabled 关掉了 / broken 定义坏了 /
 *   error 查失败 / checked 已签 / not-checked 没签 / unknown 还没查
 */
export function siteState(site, status) {
  if (!site || typeof site !== "object") return "unknown";
  if (site.error) return "broken";
  if (site.enabled === false) return "disabled";
  if (site.configured === false) return "unconfigured";
  if (!status) return "unknown";
  if (status.ok === false) return "error";
  return status.checked === true ? "checked" : "not-checked";
}

/** 站点名字后面那个小标签：来源（内置 / 自己加的） */
export function sourceTag(site) {
  return site && site.source === "内置" ? "" : "自己加的";
}

/**
 * 一个站点的状态摘要。措辞要明确——「今天已签」就是已签，
 * 不能因为查失败就说成「可能签了」。
 */
export function siteStatusLine(site, status) {
  const st = siteState(site, status);
  if (st === "broken") return site.error || "站点定义有问题";
  if (st === "disabled") return "已关掉，不参与签到";
  if (st === "unconfigured") return "还没填凭证";
  if (st === "unknown") return "点「查状态」看今天签没签";
  if (st === "error") return status.error || "查不到状态";

  const streak = Number(status.streak) || 0;
  const act = status.activityName ? `「${status.activityName}」` : "";
  // 浏览器型站点不一定是「每日签到」：即梦是每日登录即发，
  // 可灵则是每月体验包。后端明确给 activityPeriod 后，不能再写成「今天」。
  if (site.browser && status.activityPeriod === "monthly") {
    const next = status.nextApplyAt ? `；下次可领 ${status.nextApplyAt}` : "";
    return st === "checked" ? `本月已领${act}${next}` : `本月还没领${act}${next}`;
  }
  if (st === "checked") return `今天已签${act}，连续 ${streak} 天`;
  return `今天还没签${act}，连续 ${streak} 天`;
}

/** 积分那一句 */
export function siteCreditLine(status) {
  if (!status || status.ok === false) return "";
  const total = status.total;
  if (total === null || total === undefined) return "";
  const daily = Number(status.dailyCredit) || 0;
  const t = `总积分 ${Number(total) || 0}`;
  // 可灵把余额叫「灵感值」，而且不是每日活动。
  if (status.activityPeriod === "monthly") return `灵感值 ${Number(total) || 0}`;
  return daily ? `${t}，每天可得 ${daily}` : t;
}

/** 凭证有效期 */
export function expiryLine(site, status) {
  const text = (status && status.tokenExpires) || (site && site.tokenExpires);
  return text ? `凭证有效期到 ${text}` : "";
}

/**
 * 主按钮该是什么样子。
 * 已经在忙的那个站点不能重复点——签到接口重复调虽然服务端会拦，
 * 但连着点两下会让状态看起来很奇怪。
 */
export function siteButton(site, status, busySite) {
  // 没有站点就没有可点的按钮。这条不是防御性冗余：
  // 站点列表加载失败时会走到这儿，可点的话点了会打一个空 site 的请求。
  if (!site || typeof site !== "object") return { disabled: true, label: "立即签到" };
  const st = siteState(site, status);
  const busy = busySite === site?.id;
  // 浏览器型站点（如即梦）没有"签到"这个动作，只有"打开页面"。
  // 按钮字样跟着变，不然用户会以为有个按钮能点。
  const act = site.browser ? "打开页面" : "立即签到";
  if (busy) return { disabled: true, label: site.browser ? "打开中…" : "签到中…" };
  if (st === "broken") return { disabled: true, label: "定义有问题" };
  if (st === "disabled") return { disabled: true, label: "已关掉" };
  // 浏览器型站点没登录时，主按钮不是签到，是去登录。
  if (st === "unconfigured") {
    return { disabled: true, label: site.browser ? "先登录" : "先填凭证" };
  }
  if (st === "checked") {
    const label = site.browser && status?.activityPeriod === "monthly"
      ? "本月已领"
      : site.browser ? "今天已领" : "今天已签";
    return { disabled: true, label };
  }
  return { disabled: false, label: act };
}

/** 「查状态」按钮 */
export function queryButton(site, loadingSite) {
  const st = siteState(site, null);
  if (st === "broken" || st === "disabled") return { disabled: true, label: "查状态" };
  if (loadingSite === site?.id) return { disabled: true, label: "查询中…" };
  return { disabled: false, label: "查状态" };
}

/** 签到结果的一句话 */
export function resultLine(res) {
  if (!res || typeof res !== "object") return "";
  if (res.ok === false) return res.error || "签到失败";
  if (res.skipped) return res.message || "今天已经签过了";
  const credit = Number(res.credit) || 0;
  const streak = Number(res.streak) || 0;
  if (credit) return `签到成功，领到 ${credit} 积分，连续 ${streak} 天`;
  return res.message || "签到成功";
}

/**
 * 凭证输入框的即时校验：只拦「明显不对」，真验证交给服务端。
 * 不强制要求 JWT 形状——有些站点用的是普通 session token。
 */
export function tokenHint(text) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, hint: "" };
  const body = t.toLowerCase().startsWith("bearer ") ? t.slice(7).trim() : t;
  if (body.length < 8) return { ok: false, hint: "太短了，是不是没复制全" };
  if (/\s/.test(body)) return { ok: false, hint: "凭证里不该有空格（除了开头的 Bearer）" };
  return { ok: true, hint: "" };
}

/**
 * 有几个站点今天是「还没签」的。用来在标题上提示。
 * 没凭证的、关掉的、定义坏的不算——那些是配置问题，不是没签到。
 */
export function pendingCount(items, statuses) {
  let n = 0;
  for (const it of items || []) {
    const st = siteState(it, statuses?.[it.id]);
    if (st === "not-checked") n += 1;
  }
  return n;
}

/** 一句话总结所有站点：给卡片顶上用 */
export function summaryLine(items, statuses) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return "还没有任何签到站点";
  const counts = { checked: 0, pending: 0, unconfigured: 0, other: 0 };
  for (const it of list) {
    const st = siteState(it, statuses?.[it.id]);
    if (st === "checked") counts.checked += 1;
    else if (st === "not-checked") counts.pending += 1;
    else if (st === "unconfigured") counts.unconfigured += 1;
    else counts.other += 1;
  }
  const parts = [];
  if (counts.checked) parts.push(`${counts.checked} 个已签`);
  if (counts.pending) parts.push(`${counts.pending} 个待签`);
  if (counts.unconfigured) parts.push(`${counts.unconfigured} 个没填凭证`);
  if (!parts.length) parts.push("都没有待办");
  return parts.join("，");
}

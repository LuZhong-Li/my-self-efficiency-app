/* 自媒体：账号 → 数据看板 → 排期日历 → 选题/作品流水线。
 *
 * 这个页面回答两个问题：「这周运营得怎么样」和「接下来发什么」。
 *   账号卡片（粉丝 / 本周涨粉 / 播放 / 待发布）
 *   → 数据概览（汇总 + 近 30 天趋势 + TOP3 爆款，可折叠）
 *   → 月历排期（平台筛选、格子里的标题预览、拖拽排期）
 *   → 当天安排
 *   → 作品列表（想法 → 撰写中 → 剪辑中 → 待发布 → 已发布，外加废弃归档）
 *
 * 算数的部分全在 media-calc.js（纯函数，有 Node 单测），这里只管画和接事件。
 */

import { store, touch, uid, table, esc, todayStr, nowText, moveToTrash } from "./store.js";
import { sectionHead, emptyState, bindFresh, pageHeader } from "./ui.js";
import { askConfirm, toast, openDialog } from "./dialog.js";
import { monthGridHtml, calendarAction, dayLabel } from "./calendar.js";
import { icon } from "./icons.js";
import {
  PLATFORMS,
  ARCHIVED,
  statusesOf,
  isPublished,
  isArchived,
  platformSlug,
  fmtCount,
  followersAt,
  growthText,
  hitLevelOf,
  accountStats,
  overviewOf,
  overviewSeries,
} from "./media-calc.js";

const STATUSES = statusesOf();
const CHART_DAYS = 30; // 趋势图看多少天

/* 页面状态：只影响显示，不进数据文件。放模块级，重画之后还认得。 */
let selected = null; // 排期日历里选中的那一天
let calPlatform = "all"; // 日历的平台筛选
let chartKind = "fans"; // 趋势图看粉丝还是播放
let overviewOpen = true; // 数据概览是不是展开的
let listAccount = "all"; // 作品列表按哪个账号筛
let listStatus = "all"; // all / 五个状态 / archived
let listSort = "plan"; // plan（计划时间）/ created（创建时间）
let listText = ""; // 列表关键词

export function renderMedia(root, sub) {
  const today = todayStr();
  if (!selected) selected = today;

  const accounts = table("mediaAccounts");
  // 从账号卡片点进来（#media/<账号id>）时，列表就按这个账号筛
  if (sub && accounts.some((a) => a.id === sub)) listAccount = sub;

  const items = table("contents");
  const snapshots = table("mediaFollowers");
  const ov = overviewOf(store.data, today);
  const series = overviewSeries(store.data, today, CHART_DAYS);

  root.innerHTML = `
    ${pageHeader(
      "media",
      `<span class="date-chip">共 ${items.length} 条</span>
       <button class="btn small" data-act="acc-new">${icon("settings", 16)}账号管理</button>`
    )}

    <section class="card">
      <div class="card-head">
        <h2>${icon("media", 18)}自媒体账号</h2>
        <span class="hint">${accounts.length ? accounts.length + " 个" : ""}</span>
      </div>
      ${
        accounts.length
          ? `<div class="acc-strip">${accounts
              .map((a) => accCard(a, accountStats(a, items, snapshots, today, accounts)))
              .join("")}</div>`
          : emptyState(
              "还没有自媒体账号",
              "点右上角「账号管理」添加，粉丝和播放才统计得起来。",
              `<button class="btn primary" data-act="acc-new">${icon("plus", 16)}添加账号</button>`,
              "media"
            )
      }
    </section>

    <section class="card">
      <div class="card-head">
        <h2>${icon("grid", 18)}数据概览</h2>
        <span class="card-tools">
          <span class="hint">近 ${CHART_DAYS} 天</span>
          <button class="memo-toggle" data-act="ov-toggle" aria-expanded="${overviewOpen}"
            title="${overviewOpen ? "收起数据概览" : "展开数据概览"}">${icon(
    overviewOpen ? "minus" : "plus",
    16
  )}</button>
        </span>
      </div>
      ${overviewOpen ? overviewBody(ov, series) : `<p class="hint">已收起，点右上角展开。</p>`}
    </section>

    <section class="card">${calendarCard(items, accounts)}</section>

    <section class="card">${dayCard(items, accounts, today)}</section>

    <section class="card">${listSection(accounts, items)}</section>
  `;

  bindFresh(root, { submit: onSubmit, click: onClick, change: onChange, input: onInput });
  setupDragAndDrop(root);
}

function redraw() {
  renderMedia(document.getElementById("view"), location.hash.split("/")[1] || "");
}

/* ---------------- 账号卡片 ---------------- */

/** 平台用首字色块当「图标」：零外链没有各平台的 logo，
    自己画品牌标志既有版权问题，四套皮肤下也不统一。 */
function platformBadge(platform, name) {
  const text = String(platform || name || "?").slice(0, 1);
  return `<span class="acc-badge plat-${platformSlug(platform)}">${esc(text)}</span>`;
}

function accCard(a, st) {
  const week = growthText(st.weekGain, null);
  const tone = st.weekGain > 0 ? "up" : st.weekGain < 0 ? "down" : "flat";
  const tip = [
    st.lastDate ? `最近更新 ${st.lastDate}` : "还没有发布记录",
    st.target ? `目标粉丝 ${fmtCount(st.target)}（${st.targetPercent}%）` : "",
    st.hits ? `爆款 ${st.hits} 条` : "",
  ]
    .filter(Boolean)
    .join(" ｜ ");
  return `
    <div class="acc-card${listAccount === a.id ? " active" : ""}">
      <button class="acc-main" data-act="acc-open" data-id="${esc(a.id)}" title="${esc(tip)}">
        <span class="acc-top">${platformBadge(a.platform, a.name)}<span class="acc-name">${esc(
    a.name
  )}</span></span>
        <span class="acc-sub">${esc(a.platform)} · ${esc(st.activity.text)}</span>
        <span class="acc-num">${fmtCount(st.followers)}<small>粉丝</small></span>
        <span class="acc-week ${tone}">本周 ${week.text}</span>
        <span class="acc-extra">播放 ${fmtCount(st.views)} ｜ 待发布 ${st.pending}</span>
      </button>
      <span class="acc-tools">
        <button class="link" data-act="acc-snap" data-id="${esc(a.id)}"
          title="记一笔今天的粉丝数（趋势曲线以它为锚点）">记粉丝</button>
        <button class="link" data-act="acc-edit" data-id="${esc(a.id)}">编辑</button>
      </span>
    </div>`;
}

/* ---------------- 数据概览 ---------------- */

function ovItem(label, value, tip = "", tone = "") {
  return `
    <div class="ov-cell"${tip ? ` title="${esc(tip)}"` : ""}>
      <span>${esc(label)}</span>
      <strong class="${tone}">${esc(value)}</strong>
      ${tip ? `<small class="${tone}">${esc(tip)}</small>` : ""}
    </div>`;
}

function overviewBody(ov, series) {
  if (!ov.accounts.length && !ov.contents.length) {
    return emptyState("还没有数据", "加上账号、把作品标成已发布，这里就有粉丝和播放了。", "", "grid");
  }
  const growth = growthText(ov.weekGain, ov.lastWeekGain);
  const tone = ov.weekGain > 0 ? "up" : ov.weekGain < 0 ? "down" : "";
  const points = chartKind === "fans" ? series.fans : series.views;
  return `
    <div class="ov-grid">
      ${ovItem("累计粉丝", fmtCount(ov.totalFollowers))}
      ${ovItem("累计播放", fmtCount(ov.totalViews))}
      ${ovItem("点赞 + 收藏", fmtCount(ov.totalLikes + ov.totalCollects))}
      ${ovItem("本周涨粉", growth.text, growth.tip, tone)}
      ${ovItem("本周流量", fmtCount(ov.weekViews))}
      ${ovItem("本月已发布", ov.monthPublished + " 条")}
    </div>
    <div class="ov-chart">
      <div class="ov-tabs" role="group" aria-label="趋势指标">
        <button class="btn small${chartKind === "fans" ? " active" : ""}" data-act="chart" data-kind="fans">粉丝</button>
        <button class="btn small${chartKind === "views" ? " active" : ""}" data-act="chart" data-kind="views">播放</button>
      </div>
      ${lineChartHtml(points, chartKind === "fans" ? "粉丝" : "累计播放")}
    </div>
    ${topHtml(ov.top)}`;
}

/** 手写 SVG 折线：带一层渐变填充。不引图表库（项目零外链），坐标自己算。 */
function lineChartHtml(points, label) {
  if (!points || points.length < 2) {
    return `<p class="hint">数据还不够画一条线，先记几次粉丝、发两条作品。</p>`;
  }
  const values = points.map((p) => p.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const W = 600;
  const H = 140;
  const pad = 8;
  const x = (i) => (i / (points.length - 1)) * W;
  const y = (v) => pad + (1 - (v - min) / span) * (H - pad * 2);
  const line = points
    .map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`)
    .join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  return `
    <svg class="ov-line" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
      aria-label="${esc(label)}近 ${points.length} 天走势">
      <defs>
        <linearGradient id="ov-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.30"></stop>
          <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      <path d="${line} L${W} ${H} L0 ${H} Z" fill="url(#ov-fill)"></path>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"
        vector-effect="non-scaling-stroke"></path>
      <circle cx="${W}" cy="${y(last.value).toFixed(1)}" r="3" fill="var(--accent)"></circle>
    </svg>
    <div class="ov-line-foot">
      <span>${esc(first.date)}<strong>${esc(fmtCount(first.value))}</strong></span>
      <span>现在<strong>${esc(fmtCount(last.value))}</strong></span>
    </div>`;
}

function topHtml(top) {
  if (!top.length) return "";
  return `
    ${sectionHead("爆款 TOP3", top.length, "按播放量")}
    <ul class="items">
      ${top
        .map(
          (t) => `
        <li class="item${t.level ? " hit" : ""}">
          ${
            t.level
              ? `<span class="hit-tag ${t.level}">${t.level === "big" ? "大爆款" : "小爆款"}</span>`
              : ""
          }
          <span class="i-title">${esc(t.title || "（没写标题）")}</span>
          ${platformChip(t.platform)}
          <span class="i-meta">${esc(fmtCount(t.views))} 播放 · ${esc(t.mult)} 倍</span>
        </li>`
        )
        .join("")}
    </ul>
    <p class="hint ov-tip">倍率 = 这条的播放 ÷ 同一账号已发布作品的平均播放。</p>`;
}

/* ---------------- 排期日历 ---------------- */

function platformChip(platform) {
  if (!platform) return "";
  return `<span class="chip plat-tag-${platformSlug(platform)}">${esc(platform)}</span>`;
}

/** 数据里出现过哪些平台：图例和筛选下拉都按实际数据生成，不摆空的。 */
function platformsInUse(items) {
  const seen = [];
  for (const c of items) {
    const p = String(c.platform || "").trim();
    if (p && !seen.includes(p)) seen.push(p);
  }
  return seen;
}

function legendKinds(items) {
  const used = platformsInUse(items);
  return (used.length ? used : PLATFORMS.slice(0, 3)).map((p) => ["plat-" + platformSlug(p), p]);
}

/** 日历筛完之后，这条作品还算不算数 */
function inCalFilter(c) {
  if (calPlatform === "all") return true;
  return String(c.platform || "").trim() === calPlatform;
}

function calItemsOn(items, date) {
  return items.filter(
    (c) => (c.publishDate === date || (!isArchived(c) && c.planDate === date)) && inCalFilter(c)
  );
}

function calendarCard(items, accounts) {
  const used = platformsInUse(items);
  return `
    <div class="cal-filter">
      <label class="inline-field" for="media-cal-platform">平台</label>
      <select id="media-cal-platform" title="只看某个平台的排期">
        <option value="all"${calPlatform === "all" ? " selected" : ""}>全部平台</option>
        ${used
          .map(
            (p) =>
              `<option value="${esc(p)}"${calPlatform === p ? " selected" : ""}>${esc(p)}</option>`
          )
          .join("")}
      </select>
      <span class="hint">${accounts.length ? "把作品卡拖到某一天，就排到那天" : ""}</span>
    </div>
    ${monthGridHtml({
      selected,
      kinds: legendKinds(items.filter(inCalFilter)),
      marksOf: (date) => {
        const list = calItemsOn(items, date);
        const kinds = [];
        for (const c of list) {
          const kind = "plat-" + platformSlug(c.platform);
          if (!kinds.includes(kind)) kinds.push(kind);
        }
        return kinds.map((kind) => ({
          kind,
          done: list.some((c) => isPublished(c) && "plat-" + platformSlug(c.platform) === kind),
        }));
      },
      dayExtraOf: (date) => {
        const list = calItemsOn(items, date);
        if (!list.length) return null;
        return {
          title: list.map((c) => c.title || "（没写标题）").join("；"),
          lines: list.slice(0, 2).map((c) => ({
            text: shortTitle(c.title),
            tone: "plat-" + platformSlug(c.platform),
            strike: isPublished(c),
          })),
        };
      },
    })}`;
}

/** 格子里的标题只留 6 个字，多了加省略号（格子太窄） */
function shortTitle(title) {
  const t = String(title || "（没写标题）");
  return t.length > 6 ? t.slice(0, 6) + "…" : t;
}

/* ---------------- 当天排期 ---------------- */

function dayCard(items, accounts, today) {
  const dayItems = calItemsOn(items, selected);
  return `
    <div class="card-head">
      <h2>${esc(dayLabel(selected))}</h2>
      <span class="hint">${dayItems.length ? dayItems.length + " 条安排" : ""}</span>
    </div>
    <div class="drop-zone" data-drop-day="${esc(selected)}">
      ${
        dayItems.length
          ? `<ul class="items">${dayItems.map((c) => dayRow(c, today)).join("")}</ul>`
          : emptyState("这天没有发布安排", "下面可以给这天排一条内容。", "", "media")
      }
    </div>
    <form class="add-form" id="add-plan" autocomplete="off">
      <input name="title" class="grow" maxlength="120" required placeholder="给这一天排一条内容…">
      <select name="account" title="账号 / 平台">${accountOptions(accounts)}</select>
      <button class="btn primary" type="submit">排到这天</button>
    </form>`;
}

function dayRow(c, today) {
  const published = c.publishDate === selected;
  const late = !published && c.planDate && c.planDate < today;
  return `
    <li class="item${published ? " done" : ""}" data-id="${esc(c.id)}">
      <span class="i-title">${esc(c.title)}</span>
      ${platformChip(c.platform)}
      <span class="chip">${published ? "已发布" : late ? "过期未发" : "计划发布"}</span>
      ${published ? publishedNums(c) : ""}
      ${
        published && c.link
          ? `<a class="link" href="${esc(c.link)}" target="_blank" rel="noreferrer">链接</a>`
          : ""
      }
      <span class="i-actions">
        ${published ? "" : `<button class="link" data-act="cal-publish">标记已发布</button>`}
        <button class="link" data-act="edit">编辑</button>
        <button class="link danger" data-act="delete">删除</button>
      </span>
    </li>`;
}

/* ---------------- 作品列表 ---------------- */

function listSection(accounts, items) {
  const filtering =
    listAccount !== "all" || listStatus !== "all" || Boolean(listText.trim());
  return `
    <div class="card-head">
      <h2>${icon("list", 18)}选题 &amp; 作品</h2>
      <span class="hint" id="media-list-count">${
        filtering ? countText(items, visibleItems(items).length) : countText(items)
      }</span>
    </div>

    <form class="add-form" id="add-form" autocomplete="off">
      <input name="title" class="grow" maxlength="120" required placeholder="选题 / 标题…">
      <select name="account" title="账号 / 平台">${accountOptions(accounts, listAccount.startsWith("p:") ? "" : listAccount === "all" ? "" : listAccount)}</select>
      <select name="status" title="内容状态">${statusOptions("想法")}</select>
      <input name="planDate" type="date" title="计划发布日期（可不填）">
      <button class="btn primary" type="submit">添加</button>
    </form>

    <div class="filter-bar">
      <input id="media-filter" class="grow" maxlength="60" autocomplete="off"
        placeholder="筛选标题 / 备注 / 平台…" value="${esc(listText)}">
      <select id="media-list-account" title="按账号 / 平台筛">
        <option value="all"${listAccount === "all" ? " selected" : ""}>全部账号</option>
        ${accounts
          .map(
            (a) =>
              `<option value="${esc(a.id)}"${listAccount === a.id ? " selected" : ""}>${esc(
                a.name
              )}</option>`
          )
          .join("")}
        ${platformsInUse(items)
          .filter((p) => !accounts.some((a) => a.platform === p))
          .map(
            (p) =>
              `<option value="p:${esc(p)}"${listAccount === "p:" + p ? " selected" : ""}>${
                esc(p)
              }（未绑账号）</option>`
          )
          .join("")}
      </select>
      <select id="media-list-status" title="按状态筛">
        <option value="all"${listStatus === "all" ? " selected" : ""}>全部状态</option>
        ${STATUSES.map(
          (s) =>
            `<option value="${esc(s)}"${listStatus === s ? " selected" : ""}>${esc(s)}</option>`
        ).join("")}
        <option value="archived"${listStatus === "archived" ? " selected" : ""}>已废弃</option>
      </select>
      <select id="media-list-sort" title="排序方式">
        <option value="plan"${listSort === "plan" ? " selected" : ""}>按计划时间</option>
        <option value="created"${listSort === "created" ? " selected" : ""}>按创建时间</option>
      </select>
      <button class="btn small" data-act="list-clear">清空筛选</button>
    </div>

    <div id="media-list-host">${listHtml(items)}</div>`;
}

function countText(items, shown) {
  if (shown === undefined || shown === items.length) return `共 ${items.length} 条`;
  return `筛出 ${shown} / ${items.length} 条`;
}

/** 筛选只影响显示，不动数据 */
function visibleItems(items) {
  const kw = listText.trim().toLowerCase();
  return items.filter((c) => {
    const archived = isArchived(c);
    if (listStatus === "archived") {
      if (!archived) return false;
    } else if (listStatus === "all") {
      if (archived) return false;
    } else if (c.status !== listStatus) {
      return false;
    }
    if (listAccount !== "all") {
      if (listAccount.startsWith("p:")) {
        if (c.accountId || String(c.platform || "").trim() !== listAccount.slice(2)) return false;
      } else if (c.accountId !== listAccount) {
        return false;
      }
    }
    if (!kw) return true;
    return [c.title, c.note, c.platform, accountNameOf(c)].some((v) =>
      String(v || "").toLowerCase().includes(kw)
    );
  });
}

/** 按计划时间：填了日期的在前、从早到晚；没填的按创建时间倒序排后面。 */
function sortRows(list) {
  const key = (c) =>
    listSort === "created" ? c.createdAt || "" : c.planDate || c.publishDate || "";
  return list.slice().sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (listSort === "created") return ka < kb ? 1 : ka > kb ? -1 : 0;
    if (ka && kb && ka !== kb) return ka < kb ? -1 : 1;
    if (Boolean(ka) !== Boolean(kb)) return ka ? -1 : 1;
    const ca = a.createdAt || "";
    const cb = b.createdAt || "";
    return ca < cb ? 1 : ca > cb ? -1 : 0;
  });
}

function accountNameOf(c) {
  if (!c.accountId) return "";
  const a = table("mediaAccounts").find((x) => x.id === c.accountId);
  return a ? a.name : "账号已删";
}

function listHtml(items) {
  const list = visibleItems(items);
  if (!items.length) {
    return emptyState("还没有选题", "把想到的选题先记录下来，再慢慢推进。", "", "media");
  }
  if (!list.length) {
    return emptyState("当前筛选条件下没有内容", "更换筛选条件试试。", "", "media");
  }
  // 空的状态分组不画列表（空 <ul> 没意义），所以也不能往里拖
  const groups = listStatus === "all" ? STATUSES : [listStatus === "archived" ? ARCHIVED : listStatus];
  return groups
    .map((s) => {
      const rows = sortRows(list.filter((c) => (c.status || "想法") === s));
      const head = sectionHead(s, rows.length, rows.length ? "" : "空");
      const body = rows.length
        ? `<ul class="items" data-media-list="${esc(s)}">${rows
            .map((c) => row(c, items))
            .join("")}</ul>`
        : "";
      return head + body;
    })
    .join("");
}

function row(c, items) {
  const published = isPublished(c);
  const level = hitOf(c, items);
  const when = published
    ? `发布于 ${c.publishDate || "—"}`
    : c.planDate
    ? `计划 ${c.planDate}`
    : "还没排期";
  const owner = accountNameOf(c);
  const late = !published && c.planDate && c.planDate < todayStr();
  return `
    <li class="item${published ? " done" : ""}${level ? " hit" : ""}" data-id="${esc(c.id)}">
      ${
        level
          ? `<span class="hit-tag ${level}">${level === "big" ? "大爆款" : "小爆款"}</span>`
          : ""
      }
      <span class="i-title">${esc(c.title)}</span>
      ${platformChip(c.platform)}
      ${owner ? `<span class="i-note">${esc(owner)}</span>` : ""}
      <span class="i-meta">${esc(late ? when + "（已过期）" : when)}</span>
      ${published ? publishedNums(c) : ""}
      <span class="i-actions">
        ${published ? "" : `<button class="link" data-act="publish">标记已发布</button>`}
        <button class="link" data-act="edit">编辑</button>
        <button class="link" data-act="archive">归档</button>
        <button class="link danger" data-act="delete">删除</button>
      </span>
    </li>`;
}

function hitOf(c, items) {
  const pool = items.filter((x) => (x.accountId || "") === (c.accountId || ""));
  return hitLevelOf(c, pool);
}

function publishedNums(c) {
  const bits = [
    Number(c.views) ? `${fmtCount(c.views)} 播放` : "",
    Number(c.likes) ? `${fmtCount(c.likes)} 赞` : "",
    Number(c.fansGain) ? `涨粉 ${fmtCount(c.fansGain)}` : "",
  ].filter(Boolean);
  if (!bits.length) return "";
  return `<span class="i-nums">${bits.map((t) => esc(t)).join(" · ")}</span>`;
}

/* ---------------- 表单零件 ---------------- */

function accountOptions(accounts, current = "") {
  if (!accounts.length) {
    return (
      `<option value="">（先加账号）</option>` +
      PLATFORMS.map(
        (p) => `<option value="${esc(p)}"${p === current ? " selected" : ""}>${esc(p)}</option>`
      ).join("")
    );
  }
  return (
    `<option value=""${current ? "" : " selected"}>不绑定账号</option>` +
    accounts
      .map(
        (a) =>
          `<option value="${esc(a.id)}"${a.id === current ? " selected" : ""}>${esc(a.name)}（${esc(
            a.platform
          )}）</option>`
      )
      .join("")
  );
}

function statusOptions(current) {
  return STATUSES.map(
    (s) => `<option value="${esc(s)}"${s === current ? " selected" : ""}>${esc(s)}</option>`
  ).join("");
}

/** 下拉里选的是账号 id 就是绑账号；没有账号时下拉里放的是平台名，当成平台。 */
function resolvePick(value, accounts) {
  const acc = accounts.find((a) => a.id === value);
  if (acc) return { accountId: acc.id, platform: acc.platform };
  const text = String(value || "").trim();
  return { accountId: "", platform: PLATFORMS.includes(text) ? text : "" };
}

function readNum(el) {
  const n = Math.round(Number(el && el.value) || 0);
  return n > 0 ? n : 0;
}

/* ---------------- 账号弹窗 ---------------- */

function openAccountDialog(id) {
  const accounts = table("mediaAccounts");
  const a = id ? accounts.find((x) => x.id === id) : null;
  const { el, close } = openDialog({
    title: a ? "编辑自媒体账号" : "添加自媒体账号",
    bodyHtml: `
      <label class="fin-label" for="acc-name">账号名称 *</label>
      <input id="acc-name" maxlength="30" placeholder="例：B站小李" value="${esc(a ? a.name : "")}">
      <p class="fin-err" id="acc-err" hidden></p>
      <label class="fin-label" for="acc-platform">平台</label>
      <select id="acc-platform">${PLATFORMS.map(
        (p) => `<option${a && a.platform === p ? " selected" : ""}>${esc(p)}</option>`
      ).join("")}</select>
      <label class="fin-label" for="acc-intro">账号简介</label>
      <input id="acc-intro" maxlength="60" placeholder="一句话说清这个号做什么"
        value="${esc(a ? a.intro || "" : "")}">
      <div class="fin-two">
        <div>
          <label class="fin-label" for="acc-base">初始粉丝量</label>
          <input id="acc-base" type="number" min="0" step="1" value="${esc(
            a ? a.baseFollowers || 0 : 0
          )}">
        </div>
        <div>
          <label class="fin-label" for="acc-target">目标粉丝量</label>
          <input id="acc-target" type="number" min="0" step="1" value="${esc(
            a ? a.targetFollowers || 0 : 0
          )}">
        </div>
      </div>
      <label class="fin-label" for="acc-note">备注</label>
      <input id="acc-note" maxlength="120" value="${esc(a ? a.note || "" : "")}">
      <p class="fin-help">${
        a
          ? "「初始粉丝量」是账号起点；之后的涨粉靠作品里的「这条涨粉」自动加。删除账号不会删作品，它们会显示「账号已删」。"
          : "初始粉丝量填你现在有多少粉，之后跟着作品的涨粉一起长。"
      }</p>`,
    buttons: [
      ...(a ? [{ id: "delete", label: "删除", kind: "danger" }] : []),
      { id: "cancel", label: "取消" },
      { id: "save", label: "保存", kind: "primary" },
    ],
    onAction(act, dlg) {
      if (act === "cancel") return;
      if (act === "delete") {
        askConfirm({
          title: `删除账号「${a.name}」？`,
          message: "账号会进回收站；它名下的作品不会被删，会显示「账号已删」。",
          confirmLabel: "删除",
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          moveToTrash("mediaAccounts", a, a.name);
          close();
          touch(true);
          toast("账号已移入回收站");
        });
        return false; // 等确认框的结果，这个弹窗先别关
      }
      const name = dlg.querySelector("#acc-name").value.trim();
      const err = dlg.querySelector("#acc-err");
      if (!name) {
        err.textContent = "账号名称不能是空的";
        err.hidden = false;
        return false;
      }
      const fields = {
        name,
        platform: dlg.querySelector("#acc-platform").value,
        intro: dlg.querySelector("#acc-intro").value.trim(),
        baseFollowers: readNum(dlg.querySelector("#acc-base")),
        targetFollowers: readNum(dlg.querySelector("#acc-target")),
        note: dlg.querySelector("#acc-note").value.trim(),
      };
      if (a) Object.assign(a, fields);
      else table("mediaAccounts").push({ id: uid(), createdAt: nowText(), ...fields });
      touch(true);
      toast(a ? "账号已更新" : `已添加「${name}」`);
    },
  });
  setTimeout(() => el.querySelector("#acc-name")?.focus(), 0);
}

/* ---------------- 记一笔粉丝 ---------------- */

function openSnapshotDialog(id) {
  const accounts = table("mediaAccounts");
  const a = accounts.find((x) => x.id === id);
  if (!a) return;
  const today = todayStr();
  const current = followersAt(a, table("contents"), table("mediaFollowers"), today, accounts);
  const { el, close } = openDialog({
    title: `记一笔粉丝 · ${a.name}`,
    bodyHtml: `
      <p class="fin-help">记下今天的粉丝数，趋势曲线以它为准；不记的话，曲线按「初始粉丝 + 作品涨粉」往后推。</p>
      <div class="fin-two">
        <div>
          <label class="fin-label" for="snap-date">日期</label>
          <input id="snap-date" type="date" value="${esc(today)}">
        </div>
        <div>
          <label class="fin-label" for="snap-count">粉丝数</label>
          <input id="snap-count" type="number" min="0" step="1" value="${esc(String(current))}">
        </div>
      </div>
      <p class="fin-err" id="snap-err" hidden></p>`,
    buttons: [
      { id: "cancel", label: "取消" },
      { id: "save", label: "记下", kind: "primary" },
    ],
    onAction(act, dlg) {
      if (act === "cancel") return;
      const date = dlg.querySelector("#snap-date").value;
      const err = dlg.querySelector("#snap-err");
      if (!date) {
        err.textContent = "挑一个日期";
        err.hidden = false;
        return false;
      }
      const count = readNum(dlg.querySelector("#snap-count"));
      const snaps = table("mediaFollowers");
      const old = snaps.find((s) => s.accountId === a.id && s.date === date);
      // 同一天再记一次就覆盖那一条，不堆两条互相打架的快照
      if (old) old.count = count;
      else snaps.push({ id: uid(), accountId: a.id, date, count });
      close();
      touch(true);
      toast(`${date}：${fmtCount(count)} 粉`);
    },
  });
  setTimeout(() => el.querySelector("#snap-count")?.focus(), 0);
}

/* ---------------- 作品弹窗 ---------------- */

function openWorkDialog(id) {
  const accounts = table("mediaAccounts");
  const c = id ? table("contents").find((x) => x.id === id) : null;
  const status = c ? c.status || "想法" : "想法";
  const { el, close } = openDialog({
    title: c ? "编辑作品" : "添加作品 / 选题",
    bodyHtml: `
      <label class="fin-label" for="w-title">标题 / 选题 *</label>
      <input id="w-title" maxlength="120" placeholder="这一条讲什么"
        value="${esc(c ? c.title || "" : "")}">
      <p class="fin-err" id="w-err" hidden></p>
      <div class="fin-two">
        <div>
          <label class="fin-label" for="w-account">账号 / 平台</label>
          <select id="w-account">${accountOptions(accounts, c ? c.accountId || "" : "")}</select>
        </div>
        <div>
          <label class="fin-label" for="w-status">内容状态</label>
          <select id="w-status">${statusOptions(status)}</select>
        </div>
      </div>
      <div class="fin-two">
        <div>
          <label class="fin-label" for="w-plan">计划发布日期</label>
          <input id="w-plan" type="date" value="${esc(c ? c.planDate || "" : "")}">
        </div>
        <div>
          <label class="fin-label" for="w-publish">实际发布日期</label>
          <input id="w-publish" type="date" value="${esc(c ? c.publishDate || "" : "")}">
        </div>
      </div>
      <label class="fin-label" for="w-link">作品链接</label>
      <input id="w-link" maxlength="300" placeholder="发布后把链接粘进来"
        value="${esc(c ? c.link || "" : "")}">
      <p class="fin-help" id="w-lock-hint" hidden>标记为「已发布」之后，才能填发布日期、链接和下面这些数据。</p>
      <div class="fin-nums">
        <div><label class="fin-label" for="w-views">浏览 / 播放</label>
          <input id="w-views" type="number" min="0" step="1" value="${esc(c ? c.views || 0 : 0)}"></div>
        <div><label class="fin-label" for="w-likes">点赞</label>
          <input id="w-likes" type="number" min="0" step="1" value="${esc(c ? c.likes || 0 : 0)}"></div>
        <div><label class="fin-label" for="w-comments">评论</label>
          <input id="w-comments" type="number" min="0" step="1" value="${esc(c ? c.comments || 0 : 0)}"></div>
        <div><label class="fin-label" for="w-collects">收藏</label>
          <input id="w-collects" type="number" min="0" step="1" value="${esc(c ? c.collects || 0 : 0)}"></div>
        <div><label class="fin-label" for="w-fans">这条涨粉</label>
          <input id="w-fans" type="number" min="0" step="1" value="${esc(c ? c.fansGain || 0 : 0)}"></div>
      </div>
      <label class="fin-label" for="w-note">备注</label>
      <input id="w-note" maxlength="200" placeholder="脚本要点、素材放在哪…"
        value="${esc(c ? c.note || "" : "")}">`,
    buttons: [
      ...(c ? [{ id: "delete", label: "删除", kind: "danger" }] : []),
      { id: "cancel", label: "取消" },
      { id: "save", label: "保存", kind: "primary" },
    ],
    onAction(act, dlg) {
      if (act === "cancel") return;
      if (act === "delete") {
        askConfirm({
          title: `删除「${c.title}」？`,
          message: "会放进回收站，误删可找回。",
          confirmLabel: "删除",
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          moveToTrash("contents", c, c.title);
          close();
          touch(true);
          toast("已移入回收站");
        });
        return false;
      }
      const title = dlg.querySelector("#w-title").value.trim();
      const err = dlg.querySelector("#w-err");
      if (!title) {
        err.textContent = "标题不能是空的";
        err.hidden = false;
        return false;
      }
      const nextStatus = dlg.querySelector("#w-status").value;
      const published = nextStatus === "已发布";
      const pick = resolvePick(dlg.querySelector("#w-account").value, accounts);
      const fields = {
        title,
        accountId: pick.accountId,
        platform: pick.platform || (c ? c.platform || "" : ""),
        status: nextStatus,
        planDate: dlg.querySelector("#w-plan").value || "",
        publishDate: published ? dlg.querySelector("#w-publish").value || todayStr() : "",
        // 数据字段不管发没发布都照原样存回去：禁用只是不给改，
        // 来回切一次状态不该把已经录进去的播放和涨粉清掉
        link: dlg.querySelector("#w-link").value.trim(),
        views: readNum(dlg.querySelector("#w-views")),
        likes: readNum(dlg.querySelector("#w-likes")),
        comments: readNum(dlg.querySelector("#w-comments")),
        collects: readNum(dlg.querySelector("#w-collects")),
        fansGain: readNum(dlg.querySelector("#w-fans")),
        note: dlg.querySelector("#w-note").value.trim(),
      };
      if (c) Object.assign(c, fields);
      else table("contents").push({ id: uid(), createdAt: nowText(), ...fields });
      close();
      touch(true);
      toast(c ? "已保存" : `已添加「${title}」`);
    },
  });

  // 状态不是「已发布」时，发布日期 / 链接 / 数据都不给填（填了也没意义）
  const sync = () => {
    const published = el.querySelector("#w-status").value === "已发布";
    for (const sel of [
      "#w-publish",
      "#w-link",
      "#w-views",
      "#w-likes",
      "#w-comments",
      "#w-collects",
      "#w-fans",
    ]) {
      const field = el.querySelector(sel);
      if (field) field.disabled = !published;
    }
    const hint = el.querySelector("#w-lock-hint");
    if (hint) hint.hidden = published;
  };
  el.addEventListener("change", (e) => {
    if (e.target.id === "w-status") sync();
  });
  sync();
  setTimeout(() => el.querySelector("#w-title")?.focus(), 0);
}

/* ---------------- 拖拽 ---------------- */

/**
 * 拖拽排期：把作品卡拖到日历格子（或者下面那张「当天」卡）上，计划发布日期就
 * 改成那一天。落点有：每个日历格子，以及当天卡的那块区域（拖过去就到选中日）。
 *
 * 为什么没用项目卡片那套 SortableJS：它跨列表拖拽是「指针一进格子就先把卡片
 * 塞进去」，而日历格子又小又密、一次要建 42 个实例，手指抖一下落错天之后
 * 还会立刻重画，连改都改不了。而且从列表拖到日历要跨大半屏，Sortable 的
 * 自动滚动在这种场景下也不稳。这里用浏览器自带的原生拖拽：落点由 drop 事件
 * 决定（松手那一下才算数），跨屏时的自动滚动浏览器自己会做。
 */
let dragId = "";

function setupDragAndDrop(root) {
  const host = root.querySelector("#media-list-host");
  if (!host) return;

  // 可拖的：列表里的每一条作品（按钮上按住不算，免得点「编辑」时被当成拖拽）
  for (const li of host.querySelectorAll("li.item[data-id]")) {
    li.draggable = true;
    li.addEventListener("dragstart", (e) => {
      dragId = li.dataset.id;
      // 兜底把 id 也记在 body 上：dataTransfer 里的东西在「拖的是选中的文字」
      // 这种情形下会被浏览器换掉，光靠它读回来会拿到一段文字而不是 id
      document.body.dataset.mediaDragId = dragId;
      li.classList.add("card-follow");
      document.body.classList.add("media-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", dragId);
      }
    });
    li.addEventListener("dragend", () => {
      dragId = "";
      delete document.body.dataset.mediaDragId;
      li.classList.remove("card-follow");
      document.body.classList.remove("media-dragging");
      clearDropHints(root);
    });
  }

  // 落点：日历格子 + 当天卡
  const zones = [...root.querySelectorAll(".cal-cell"), ...root.querySelectorAll("[data-drop-day]")];
  for (const zone of zones) {
    // 列表筛选时只重画列表区，日历和当天卡还是原来那些节点，
    // 别把监听叠上去（叠一次就会在 drop 时跑两遍）
    if (zone.dataset.dropReady) continue;
    zone.dataset.dropReady = "1";
    zone.addEventListener("dragover", (e) => {
      const types = e.dataTransfer ? [...e.dataTransfer.types] : [];
      if (!dragId && !types.includes("text/plain")) return;
      e.preventDefault(); // 不拦这一下，浏览器就不认这里是能放的地方
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      zone.classList.add("drop-target");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drop-target"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drop-target");
      const carried = e.dataTransfer ? e.dataTransfer.getData("text/plain") : "";
      const item = find(dragId || document.body.dataset.mediaDragId || carried);
      // 格子上写的是 data-day，当天卡上写的是 data-drop-day（就是选中的那天），
      // 两条路都落成同一个「哪一天」，所以这里不用分情况
      const raw = zone.dataset.dropDay || zone.dataset.day;
      if (!item || !raw) return;
      item.planDate = raw;
      touch(true);
      toast(`「${item.title}」已排到 ${raw}`);
    });
  }
}

function clearDropHints(root) {
  for (const el of root.querySelectorAll(".drop-target")) el.classList.remove("drop-target");
}

/* ---------------- 事件 ---------------- */

function find(id) {
  return table("contents").find((c) => c.id === id) || null;
}

/** 新作品的默认字段：全给上值，省得以后到处判断 undefined */
function blankItem(fields) {
  return {
    id: uid(),
    publishDate: "",
    link: "",
    views: 0,
    likes: 0,
    comments: 0,
    collects: 0,
    fansGain: 0,
    note: "",
    createdAt: nowText(),
    ...fields,
  };
}

function onSubmit(e) {
  const form = e.target;
  const accounts = table("mediaAccounts");

  if (form.id === "add-plan") {
    e.preventDefault();
    const title = form.title.value.trim();
    if (!title) return;
    const pick = resolvePick(form.account.value, accounts);
    table("contents").push(
      blankItem({
        title,
        accountId: pick.accountId,
        platform: pick.platform,
        status: "待发布",
        planDate: selected,
      })
    );
    touch(true);
    toast(`已排到 ${selected}`);
    return;
  }

  if (form.id !== "add-form") return;
  e.preventDefault();
  const title = form.title.value.trim();
  if (!title) return;
  const pick = resolvePick(form.account.value, accounts);
  table("contents").push(
    blankItem({
      title,
      accountId: pick.accountId,
      platform: pick.platform,
      status: form.status.value,
      planDate: form.planDate.value || "",
    })
  );
  touch(true);
}

async function onClick(e) {
  const cal = calendarAction(e);
  if (cal.handled) {
    if (cal.selected) selected = cal.selected;
    redraw();
    return;
  }

  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const li = btn.closest("[data-id]");
  const id = li ? li.dataset.id : btn.dataset.id;

  if (act === "acc-new") return openAccountDialog(null);
  if (act === "acc-edit") return openAccountDialog(id);
  if (act === "acc-snap") return openSnapshotDialog(id);
  if (act === "acc-open") {
    // 切到「只看这个账号」，顺便写进地址，刷新之后还认
    location.hash = "#media/" + id;
    listAccount = id;
    listStatus = "all";
    listText = "";
    redraw();
    return;
  }
  if (act === "ov-toggle") {
    overviewOpen = !overviewOpen;
    redraw();
    return;
  }
  if (act === "chart") {
    chartKind = btn.dataset.kind;
    redraw();
    return;
  }
  if (act === "list-clear") {
    listAccount = "all";
    listStatus = "all";
    listText = "";
    if (location.hash.startsWith("#media/")) location.hash = "#media";
    redraw();
    return;
  }

  const item = id ? find(id) : null;
  if (!item) return;

  if (act === "edit") {
    openWorkDialog(item.id);
  } else if (act === "publish") {
    item.status = "已发布";
    if (!item.publishDate) item.publishDate = todayStr();
    touch(true);
    toast("已标记发布");
  } else if (act === "cal-publish") {
    // 在「某一天」的卡片里标记发布，就算在那一天，不是算今天
    item.status = "已发布";
    item.publishDate = selected;
    touch(true);
    toast(`已按 ${selected} 记为发布`);
  } else if (act === "archive") {
    item.prevStatus = item.status;
    item.status = ARCHIVED;
    touch(true);
    toast("已归档，在「已废弃」里能找回来");
  } else if (act === "delete") {
    const ok = await askConfirm({
      title: `删除「${item.title}」？`,
      message: "会放进回收站，账号不受影响。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    moveToTrash("contents", item, item.title);
    touch(true);
    toast("已移入回收站");
  }
}

function onChange(e) {
  const el = e.target;
  if (el.id === "media-cal-platform") {
    calPlatform = el.value;
    redraw();
    return;
  }
  if (el.id === "media-list-account") {
    listAccount = el.value;
    applyListFilter();
    return;
  }
  if (el.id === "media-list-status") {
    listStatus = el.value;
    applyListFilter();
    return;
  }
  if (el.id === "media-list-sort") {
    listSort = el.value;
    applyListFilter();
  }
}

/** 只重画列表那一块：上面的输入框不动，光标不会跳。 */
function applyListFilter() {
  const root = document.getElementById("view");
  const host = root ? root.querySelector("#media-list-host") : null;
  if (!host) return redraw();
  const items = table("contents");
  host.innerHTML = listHtml(items);
  const count = root.querySelector("#media-list-count");
  if (count) count.textContent = countText(items, visibleItems(items).length);
  setupDragAndDrop(root);
}

function onInput(e) {
  if (e.target.id !== "media-filter") return;
  listText = e.target.value;
  applyListFilter();
}

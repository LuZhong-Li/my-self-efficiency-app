/* 全局搜索：在已经读进来的数据里找，点结果跳到对应模块。
 * 纯粹前端过滤，不新增接口、不新增数据。
 *
 * 「能搜哪些表、哪些字段」在 search-calc.js（纯逻辑、能单测）；这里只管
 * 输入框、下拉面板和跳转。备忘和每周训练安排不是「一行一条」的表，单独补。 */

import { store, esc } from "./store.js";
import { searchAll, allTags, searchByTag, normalizeText } from "./search-calc.js";

const MAX = 20;                 // 面板里最多摆这么多条
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

// 全局搜索默认不看归档条目（归档了就是不希望它再冒出来）；
// 面板底部那个勾选框打开才连归档一起搜。只活在这次会话里。
let includeArchived = false;

// 点中的那个标签（再点一下取消）。只活在这次面板开着的时候，收起面板就清掉。
let activeTag = "";

/** 备忘、每周训练安排这两处不是「一行一条」的表，单独拎出来匹配 */
function extraHits(kw) {
  const out = [];
  const memo = String((store.data && store.data.memo) || "");
  if (memo && normalizeText(memo).includes(kw)) {
    out.push({ module: "home", label: "备忘", text: memo.split("\n")[0].slice(0, 40) });
  }
  const plan = (store.data && store.data.workoutPlan) || {};
  for (const day of WEEKDAYS) {
    const v = String(plan[day] || "");
    if (v && normalizeText(v).includes(kw)) {
      out.push({ module: "fitness", label: "安排", text: `${day} ${v}` });
    }
  }
  return out;
}

/** 搜一次：所有模块的结果 + 备忘 / 安排，按匹配度排好，再截到面板长度 */
function find(query) {
  const kw = normalizeText(query);
  if (!kw || !store.data) return [];
  return searchAll(store.data, query, includeArchived).concat(extraHits(kw)).slice(0, MAX);
}

/** 把命中的关键词裹一层 <mark>，其余部分照旧转义 */
function highlight(text, needle) {
  const t = String(text ?? "");
  const i = t.toLowerCase().indexOf(String(needle).toLowerCase());
  if (!needle || i < 0) return esc(t);
  return (
    esc(t.slice(0, i)) +
    "<mark>" + esc(t.slice(i, i + needle.length)) + "</mark>" +
    esc(t.slice(i + needle.length))
  );
}

export function initSearch() {
  const input = document.getElementById("search");
  const panel = document.getElementById("search-panel");
  if (!input || !panel) return;
  let timer = null;

  function close() {
    panel.hidden = true;
    panel.innerHTML = "";
    activeTag = "";       // 收起面板 = 这次筛选结束，下次打开是干净的
  }

  /** 顶栏那一行：全站已经出现过的标签，点了就只看带它的记录 */
  function tagRowHtml() {
    const list = allTags(store.data).slice(0, 12);
    if (!list.length) return "";
    return `<div class="sr-tags">${
      list
        .map((t) => `<button class="sr-tag-chip${t.name === activeTag ? " on" : ""}"` +
          ` data-tag="${esc(t.name)}" title="${esc(t.count)} 条">${esc(t.name)}</button>`)
        .join("")
    }</div>`;
  }

  /** 底部那个「包含归档记录」，每次重画都带上当前勾选状态 */
  function archiveHtml() {
    return `<label class="sr-archive">
      <input type="checkbox" id="search-archived"${includeArchived ? " checked" : ""}>
      包含归档记录
    </label>`;
  }

  /** 结果列表；没找到时那句要把「标签 + 关键词」都说清楚 */
  function panelHtml(hits, query) {
    if (!hits.length) {
      const what = activeTag
        ? (query.trim() ? `「${esc(activeTag)}」里的「${esc(query.trim())}」` : `贴了「${esc(activeTag)}」的`)
        : `「${esc(query.trim())}」`;
      return `<div class="sr-none">没找到${what}</div>`;
    }
    return hits
      .map(
        (h) => `<button class="sr-item" data-module="${esc(h.module)}" data-hash="${esc(h.hash || h.module)}">
          <span class="sr-tag">${esc(h.label)}</span>
          <span class="sr-text">${highlight(h.text, query.trim())}</span>
        </button>`
      )
      .join("");
  }

  function run() {
    const query = input.value.trim();
    // 空框 + 没点标签：只把标签行摆出来，让人一眼看见自己有哪些标签（不摆结果）。
    // 一个标签都还没有的时候（刚用上这个功能），空框仍然是「收起面板」——
    // 不然一聚焦就弹一块空面板，比现在还烦。
    if (!query && !activeTag) {
      const row = tagRowHtml();
      if (!row) {
        close();
        return;
      }
      panel.innerHTML = row;
      panel.hidden = false;
      return;
    }
    const hits = activeTag
      ? searchByTag(store.data, activeTag, includeArchived, query)
      : find(query);
    panel.innerHTML = tagRowHtml() + panelHtml(hits, query) + archiveHtml();
    panel.hidden = false;
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, 200);
  });
  input.addEventListener("focus", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      close();
      input.blur();
    }
  });
  panel.addEventListener("click", (e) => {
    const tagBtn = e.target.closest("[data-tag]");
    if (tagBtn) {
      // 重画面板会把点中的那颗标签钮换掉（旧的那颗从此「不在文档里」），
      // 等这次点击继续冒到 document 时，下面那句「不在 .search-wrap 里就收起」
      // 就认不出它了 —— 于是刚点开就被收走。所以这一下不再往外传。
      e.stopPropagation();
      activeTag = tagBtn.dataset.tag === activeTag ? "" : tagBtn.dataset.tag;
      run();
      return;
    }
    const btn = e.target.closest("[data-module]");
    if (!btn) return;
    location.hash = "#" + btn.dataset.hash;
    input.value = "";
    close();
  });
  // 勾上「包含归档记录」立刻重搜一次（面板就在 .search-wrap 里，不会被外面的关闭逻辑收走）
  panel.addEventListener("change", (e) => {
    if (e.target.id !== "search-archived") return;
    includeArchived = e.target.checked;
    run();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) close();
  });
}

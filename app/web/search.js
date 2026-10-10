/* 全局搜索：在已经读进来的数据里找，点结果跳到对应模块。
 * 纯粹前端过滤，不新增接口、不新增数据。
 *
 * 「能搜哪些表、哪些字段」在 search-calc.js（纯逻辑、能单测）；这里只管
 * 输入框、下拉面板和跳转。备忘和每周训练安排不是「一行一条」的表，单独补。 */

import { store, esc } from "./store.js";
import { searchAll, normalizeText } from "./search-calc.js";

const MAX = 20;                 // 面板里最多摆这么多条
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

// 全局搜索默认不看归档条目（归档了就是不希望它再冒出来）；
// 面板底部那个勾选框打开才连归档一起搜。只活在这次会话里。
let includeArchived = false;

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
  }

  /** 结果列表 + 底部那个「包含归档记录」，每次重画都带上当前勾选状态 */
  function panelHtml(hits, query) {
    const list = hits.length
      ? hits
          .map(
            (h) => `<button class="sr-item" data-module="${esc(h.module)}" data-hash="${esc(h.hash || h.module)}">
              <span class="sr-tag">${esc(h.label)}</span>
              <span class="sr-text">${highlight(h.text, query.trim())}</span>
            </button>`
          )
          .join("")
      : `<div class="sr-none">没找到「${esc(query)}」</div>`;
    return (
      list +
      `<label class="sr-archive">
        <input type="checkbox" id="search-archived"${includeArchived ? " checked" : ""}>
        包含归档记录
       </label>`
    );
  }

  function run() {
    const query = input.value;
    if (!query.trim()) {
      close();
      return;
    }
    panel.innerHTML = panelHtml(find(query), query);
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

/* 全局搜索：在已经读进来的数据里找，点结果跳到对应模块。
 * 纯粹前端过滤，不新增接口、不新增数据。 */

import { store, esc, table } from "./store.js";

const SOURCES = [
  { table: "tasks", module: "plan", label: "任务", fields: ["text", "note"] },
  { table: "contents", module: "media", label: "自媒体", fields: ["title", "platform"] },
  { table: "projects", module: "dev", label: "项目", fields: ["name", "intro"] },
  { table: "issues", module: "dev", label: "问题", fields: ["title"] },
  { table: "progress", module: "dev", label: "进展", fields: ["text"] },
  { table: "subjects", module: "study", label: "学习对象", fields: ["name", "source", "note"] },
  { table: "studies", module: "study", label: "学习", fields: ["content", "takeaway"] },
  { table: "workoutLogs", module: "fitness", label: "打卡", fields: ["moves", "note"] },
  { table: "weights", module: "fitness", label: "体重", fields: ["date"] },
  { table: "meals", module: "diet", label: "饮食", fields: ["breakfast", "lunch", "dinner", "snack"] },
  { table: "games", module: "game", label: "游戏", fields: ["name", "platform", "progress"] },
  { table: "finance.transactions", module: "finance", label: "账目", fields: ["note", "category"] },
  { table: "debt.items", module: "finance", hash: "finance/debt", label: "债务",
    fields: ["name", "creditor", "note"] },
];

const MAX = 12;

function searchAll(query) {
  const needle = query.trim().toLowerCase();
  if (!needle || !store.data) return [];
  const out = [];
  for (const src of SOURCES) {
    const rows = table(src.table); // table() 认得 "finance.transactions" 这种带点的路径
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const hit = src.fields.find((f) =>
        String(row[f] === undefined || row[f] === null ? "" : row[f])
          .toLowerCase()
          .includes(needle)
      );
      if (hit) {
        out.push({
          module: src.module,
          hash: src.hash,
          label: src.label,
          text: String(row[hit] || row.date || ""),
        });
      }
      if (out.length >= MAX) return out;
    }
  }

  // 两个不是「列表」的数据也不能漏：随手备忘、每周训练安排
  const memo = String(store.data.memo || "");
  if (memo.toLowerCase().includes(needle)) {
    out.push({ module: "home", label: "备忘", text: memo.split("\n")[0].slice(0, 40) });
  }
  const plan = store.data.workoutPlan || {};
  for (const day of ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]) {
    const v = String(plan[day] || "");
    if (v && v.toLowerCase().includes(needle)) {
      out.push({ module: "fitness", label: "安排", text: `${day} ${v}` });
    }
  }
  return out;
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

  function run() {
    const query = input.value;
    if (!query.trim()) {
      close();
      return;
    }
    const hits = searchAll(query);
    panel.innerHTML = hits.length
      ? hits
          .map(
            (h) => `<button class="sr-item" data-module="${esc(h.module)}" data-hash="${esc(h.hash || h.module)}">
              <span class="sr-tag">${esc(h.label)}</span>
              <span class="sr-text">${highlight(h.text, query.trim())}</span>
            </button>`
          )
          .join("")
      : `<div class="sr-none">没找到「${esc(query)}」</div>`;
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
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) close();
  });
}

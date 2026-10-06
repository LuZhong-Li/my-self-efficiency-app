/* 全局搜索：在已经读进来的数据里找，点结果跳到对应模块。
 * 纯粹前端过滤，不新增接口、不新增数据。 */

import { store, esc } from "./store.js";

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
];

const MAX = 12;

function searchAll(query) {
  const needle = query.trim().toLowerCase();
  if (!needle || !store.data) return [];
  const out = [];
  for (const src of SOURCES) {
    const rows = store.data[src.table];
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
            (h) => `<button class="sr-item" data-module="${esc(h.module)}">
              <span class="sr-tag">${esc(h.label)}</span>
              <span class="sr-text">${esc(h.text)}</span>
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
    location.hash = "#" + btn.dataset.module;
    input.value = "";
    close();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) close();
  });
}

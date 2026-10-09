/* 「今日目标」设置弹窗（2026-10-09 加）
 *
 * 每个模块配一个今日目标：类型（数量 / 时长）、目标值、单位、单步增量。
 * 存进 settings.dailyTargets —— 和皮肤 / 首页视图一样跟着数据文件走，两个窗口也同步。
 * 进度本身**不在这里存**：它一直是「今天这组待办按 value 汇总」现算出来的
 * （见 task-calc.js 的 groupPlanTasks / valueOf）。
 *
 * 留空目标值 = 按今天计划了几条算（老口径，单位「项」）；填了才走类型 / 单位 / 步长。
 */

import { store, esc } from "./store.js";
import { openDialog, toast } from "./dialog.js";
import { PLAN_GROUPS, DAILY_TYPES, dailyTargetsOf } from "./task-calc.js";
import { saveDailyTargets } from "./task-actions.js";

export function openDailyTargetDialog() {
  const cfg = dailyTargetsOf(store.data || {});
  const head = ` <div class="dt-row dt-head">
      <span>模块</span><span>类型</span><span>今日目标值</span><span>单位</span><span>单步增量</span>
    </div>`;
  const rows = PLAN_GROUPS.map((m) => {
    const c = cfg[m.key];
    const types = Object.keys(DAILY_TYPES)
      .map((t) => `<option value="${t}"${c.type === t ? " selected" : ""}>${DAILY_TYPES[t]}</option>`)
      .join("");
    return `
      <div class="dt-row">
        <span class="dt-name">${esc(m.name)}</span>
        <select id="dt-type-${m.key}">${types}</select>
        <input id="dt-target-${m.key}" type="number" min="0" step="1" value="${c.targetValue || ""}" placeholder="留空按计划数">
        <input id="dt-unit-${m.key}" type="text" value="${esc(c.unit)}" placeholder="项">
        <input id="dt-step-${m.key}" type="number" min="1" step="1" value="${c.step}">
      </div>`;
  }).join("");

  openDialog({
    title: "今日目标设置",
    bodyHtml: `
      <p class="dlg-hint">目标值留空 = 按今天计划了几条算（单位「项」）。填了目标值就按「类型 / 单位 / 步长」走：
        进度条右边的 + / − 按键照步长追加（数量 +1、时长 +30 分钟这种），可以超额完成。</p>
      <div class="dt-grid">${head}${rows}</div>`,
    buttons: [
      { id: "cancel", label: "取消" },
      { id: "save", label: "保存", kind: "primary" },
    ],
    onAction: (act, el) => {
      if (act !== "save") return true;
      const out = {};
      for (const m of PLAN_GROUPS) {
        const targetValue = Number(el.querySelector("#dt-target-" + m.key).value);
        out[m.key] = {
          type: el.querySelector("#dt-type-" + m.key).value,
          targetValue: Number.isFinite(targetValue) && targetValue > 0 ? targetValue : 0,
          unit: el.querySelector("#dt-unit-" + m.key).value.trim(),
          step: Number(el.querySelector("#dt-step-" + m.key).value) || 1,
        };
      }
      saveDailyTargets(out);
      toast("今日目标已保存");
      return true;
    },
  });
}

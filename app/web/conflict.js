/* 数据冲突 / 磁盘被别处改过时的处理弹窗。
 *
 * 数据层（store.js）发现「本窗口手里的版本跟磁盘对不上」时自己不动手，
 * 只改状态栏、把事件抛出来，由这里问用户怎么处理。事件有两种：
 *   1. kind "conflict" —— 保存时被后端按修订号拒掉了：另一个窗口先改过，
 *      直接写就覆盖掉那边的改动，所以这一次没落到磁盘。
 *   2. kind "disk"     —— 另一个窗口保存了数据，而本窗口还有没落盘的内容
 *      （改过、或表单填了一半）；刷新会把正在编辑的东西冲掉，先问一句。
 *
 * 两条规矩贯穿始终：
 *   · 不管用户选哪条，都**不会**悄悄把本窗口的改动丢掉；
 *   · 要丢也是他自己点「刷新并加载最新数据」才丢，而且还能先导出备份。
 */

import {
  store, onConflict, onStatus,
  discardAndReload, holdLocalChanges, downloadCurrentData,
  reopenConflict,
} from "./store.js";
import { openDialog } from "./dialog.js";

const CONFLICT_BODY = `
  <p class="dlg-hint">你当前窗口加载的数据，已经在另一个浏览器窗口被修改。</p>
  <p class="dlg-hint">如果直接保存，会覆盖掉那个窗口的改动、造成数据丢失 —— 所以这一次没有写入磁盘，你的改动还在这个窗口里。</p>
  <p class="dlg-hint">稳妥的做法：先「导出当前修改备份」，把本窗口这份下载成 JSON 留档，再「刷新并加载最新数据」，两边对照着把改动补回去。</p>`;

const DISK_BODY = `
  <p class="dlg-hint">磁盘上的 数据.json 已经在别处被更新了（多半是你另一个窗口刚保存过）。</p>
  <p class="dlg-hint">本窗口还有没落盘的内容，现在加载最新版本会把它丢掉，所以先问一句。</p>`;

/* 第三种情形（2026-10-14 加）：设置页把数据集换成了别的，本窗口手里还是换之前那一份。
   这种时候后端会按数据集名把保存挡回去 —— 两份数据的修订号可能正好相等，
   光比 rev 是拦不住的（见 服务.py 的 api_save）。 */
const DATASET_BODY = `
  <p class="dlg-hint">你正在用的数据集已经换成了别的（多半是你在设置页切了一下）。</p>
  <p class="dlg-hint">本窗口手里的还是换之前那一份数据，直接保存会把两份混在一起 —— 所以这一次没有写入磁盘。</p>
  <p class="dlg-hint">点「刷新并加载最新数据」重新读一遍当前数据集；想留住本窗口这份改动，就先「导出当前修改备份」。</p>`;

let showing = false;

export function setupConflict() {
  onConflict(show);
  onStatus(paintStatusHint);
  paintStatusHint();
  // 状态栏在有冲突时可点：重新打开处理弹窗（比如上次手滑点了「取消」）
  const statusEl = document.getElementById("status");
  if (statusEl) {
    statusEl.addEventListener("click", () => {
      if (store.conflict) reopenConflict();
    });
  }
}

/** 状态栏在有冲突时变成可点的入口（点一下重新打开处理弹窗） */
function paintStatusHint() {
  const el = document.getElementById("status");
  if (!el) return;
  el.classList.toggle("conflict", store.conflict);
  el.title = store.conflict ? "数据冲突待处理：点这里打开处理窗口" : "";
}

function show(info) {
  paintStatusHint();
  if (showing) return;   // 已经开着一个处理弹窗了，别叠
  showing = true;
  const isDisk = info && info.kind === "disk";
  const isDataset = info && info.kind === "dataset";

  openDialog({
    title: isDisk ? "磁盘数据已更新" : isDataset ? "数据集已经换了" : "数据冲突",
    bodyHtml: isDisk ? DISK_BODY : isDataset ? DATASET_BODY : CONFLICT_BODY,
    buttons: [
      { id: "cancel", label: "取消" },
      { id: "reload", label: "刷新并加载最新数据", kind: "danger" },
      { id: "backup", label: "导出当前修改备份", kind: "primary" },
    ],
    onAction: (id) => {
      if (id === "reload") {
        discardAndReload();      // 唯一会丢本窗口改动的动作，用户点了才做
        return;
      }
      if (id === "backup") {
        downloadCurrentData();
        holdLocalChanges();
        return;
      }
      holdLocalChanges();        // 取消：保持现状，改动留着（还没落盘）
    },
    onClose: () => {
      showing = false;
      paintStatusHint();
    },
  });
}

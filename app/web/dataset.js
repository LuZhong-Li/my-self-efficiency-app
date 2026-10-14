/* 设置页那张「数据集」卡片：一份数据一个文件夹，点一下就换用另一份。
 *
 * 换这一下必须由**服务端**做（数据目录、附件、备份、日志、锁文件这些路径都在它那儿），
 * 所以这里只管三件事：把列表画出来、问一句、告诉服务端，然后整页重载 ——
 * 重载是为了不留任何内存里的旧数据集残留（各模块的状态、填了一半的弹窗）。
 *
 * 名字那一套规则在 dataset-calc.js 里（和服务端同一份口径）：这里用它当场挡住坏名字。
 */

import { store, touch, esc } from "./store.js";
import { askConfirm, openDialog, toast } from "./dialog.js";
import {
  DATASET_NAME_MAX, checkDatasetName, sortDatasets, datasetMetaText,
} from "./dataset-calc.js";

let state = { enabled: false, current: "", root: "", items: [] };

export function datasetCardHtml() {
  return `
    <section class="card" id="ds-card">
      <h2>数据集</h2>
      <p class="hint">
        一份数据一个文件夹（数据、图片、备份、日志都在里面），整份能搬走、整份能备份。
        同一时间只用一份；切换之后页面会重载。
      </p>
      <p class="ds-current">现在在用：<b id="ds-current">—</b></p>
      <ul class="ds-list" id="ds-list"></ul>
      <div class="row">
        <button class="btn small" data-ds-act="new">新建数据集</button>
        <button class="btn small" data-ds-refresh>重新读一遍</button>
      </div>
      <p class="msg" id="ds-msg"></p>
    </section>`;
}

/** 挂上那张卡片：拉一次列表、绑一次事件（settings.js 渲染完调它） */
export async function mountDataset() {
  const card = document.getElementById("ds-card");
  if (!card) return;
  if (!card.dataset.bound) {
    card.dataset.bound = "1";
    card.addEventListener("click", onClick);
  }
  await refreshDatasets();
}

export async function refreshDatasets() {
  let body = null;
  try {
    body = await (await fetch("/api/datasets", { cache: "no-store" })).json();
  } catch {
    body = null;
  }
  state = {
    enabled: Boolean(body && body.enabled),
    current: String((body && body.current) || ""),
    root: String((body && body.root) || ""),
    items: (body && body.items) || [],
  };
  draw();
}

function draw() {
  const cur = document.getElementById("ds-current");
  const list = document.getElementById("ds-list");
  const msg = document.getElementById("ds-msg");
  if (!cur || !list || !msg) return;
  if (!state.enabled) {
    cur.textContent = "—";
    list.innerHTML = "";
    msg.textContent = "这次的数据目录是外面指定的（XIAOLI_DATA_DIR），数据集功能关着。";
    return;
  }
  cur.textContent = state.current || "—";
  list.innerHTML = sortDatasets(state.items, state.current)
    .map(
      (it) => `<li class="ds-row${it.current ? " current" : ""}">
        <span class="ds-name">${esc(it.name)}</span>
        ${it.current ? `<span class="ds-now">在用</span>` : ""}
        <span class="ds-meta" title="${esc(countsTitle(it))}">${esc(datasetMetaText(it))}</span>
        <span class="ds-acts">
          ${
            it.current
              ? ""
              : `<button class="link" data-ds-act="use" data-ds-name="${esc(it.name)}">用这份</button>`
          }
          <button class="link" data-ds-act="rename" data-ds-name="${esc(it.name)}">重命名</button>
          <button class="link" data-ds-act="export" data-ds-name="${esc(it.name)}">导出</button>
        </span>
      </li>`
    )
    .join("");
  msg.textContent = state.root ? "数据根目录：" + state.root : "";
}

/** 悬停提示：这份数据里各有多少（服务端的 summarize() 给的就是这个） */
function countsTitle(item) {
  const pairs = Object.entries((item && item.counts) || {}).filter(([, n]) => n);
  return pairs.length ? pairs.map(([k, n]) => `${k} ${n}`).join(" · ") : "还没有数据";
}

async function onClick(e) {
  const btn = e.target.closest("[data-ds-act], [data-ds-refresh]");
  if (!btn) return;
  if (btn.hasAttribute("data-ds-refresh")) {
    await refreshDatasets();
    return;
  }
  const act = btn.dataset.dsAct;
  const name = btn.dataset.dsName || "";
  if (act === "use") await useDataset(name);
  else if (act === "new") askNewDataset();
  else if (act === "rename") askRenameDataset(name);
  else if (act === "export") await exportDataset(name);
}

/**
 * 切过去。任何一步不成就**绝不切**：先把改动存下来（存不下去说明有冲突，先让人处理），
 * 再让服务端换（它还会拿 rev 对一次），成功了才整页重载。
 */
async function useDataset(name) {
  if (!name || name === state.current) return;
  const warn = store.pendingForm ? "（提醒：现在有弹窗里填了一半的东西，重载会丢掉）" : "";
  const ok = await askConfirm({
    title: `切到数据集「${name}」？`,
    message: `先把现在的改动存下来，再整页重载成那一份数据。两份各存各的，不会混在一起。${warn}`,
    confirmLabel: "切过去",
  });
  if (!ok) return;
  await touch(true);
  if (store.conflict) {
    toast("有改动没存下来，先处理冲突再切", "err");
    return;
  }
  const res = await fetch("/api/dataset-switch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, rev: store.data && store.data.rev }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    toast(body.error || "切换失败", "err");
    return;
  }
  toast(`已切到「${name}」，正在重载…`);
  location.reload();
}

/**
 * 新建一份空数据集。**不自动切过去** —— 建完列表里出现，用户自己点「用这份」。
 */
function askNewDataset() {
  askNameDialog({
    title: "新建数据集",
    hint: "新建的是一份空数据（任务、记账、笔记都是空的），先不切过去 —— 建好之后在列表里点「用这份」。",
    value: "",
    okLabel: "新建",
    action: "new",
    okId: "create",     // 按钮 id 和「干什么」分开：测试和文案都按 create 认它
  });
}

function askRenameDataset(name) {
  askNameDialog({
    title: `重命名数据集「${name}」`,
    hint: "就是给文件夹改个名字，里面的数据和图片一个都不会动。",
    value: name,
    okLabel: "改名",
    action: "rename",
    okId: "rename",
    from: name,
  });
}

/** 新建和重命名共用一个小弹窗：一个名字输入框 + 一行当场校验 */
function askNameDialog({ title, hint, value, okLabel, action, okId, from = "" }) {
  const confirmId = okId || action;
  const dlg = openDialog({
    title,
    bodyHtml: `
      <div class="ds-new">
        <p class="hint">${esc(hint)}</p>
        <label class="inline-field">名字
          <input id="ds-new-name" maxlength="${DATASET_NAME_MAX}" autocomplete="off"
            value="${esc(value)}" placeholder="比如：工作、私人、2026 存档">
        </label>
        <p class="msg" id="ds-new-msg"></p>
      </div>`,
    buttons: [
      { id: "cancel", label: "取消" },
      { id: confirmId, label: okLabel, kind: "primary" },
    ],
    onAction: (id, el) => {
      if (id !== confirmId) return;
      const input = el.querySelector("#ds-new-name");
      const msg = el.querySelector("#ds-new-msg");
      const name = String((input && input.value) || "").trim();
      const bad = checkDatasetName(name, action === "new" ? state.items.map((i) => i.name) : []);
      if (bad) {
        msg.textContent = bad;      // 当场说清楚，弹窗留着让人改
        return false;
      }
      // 真正的活儿是异步的，而 openDialog 只看「同步返回的是不是 false」——
      // 所以这里先同步返回 false 把弹窗留住，做完自己关（和 item-dialog 一个套路）
      (async () => {
        const url = action === "new" ? "/api/dataset-new" : "/api/dataset-rename";
        const payload = action === "new" ? { name } : { name: from, to: name };
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) {
          msg.textContent = body.error || "没成功";
          return;
        }
        dlg.close();
        toast(action === "new"
          ? `已新建「${name}」（还没切过去，点「用这份」才切）`
          : `已改名为「${name}」`);
        // 改的是正在用的那份：路径变了，重载一次最干净（状态栏 / health 都跟着刷新）
        if (action === "rename" && from === state.current) {
          location.reload();
          return;
        }
        await refreshDatasets();
      })();
      return false;
    },
  });
}

/** 导出成 zip：落在**当前**数据集的 导出\ 里（「打开导出文件夹」开的就是它） */
async function exportDataset(name) {
  const res = await fetch("/api/dataset-export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    toast(body.error || "导出失败", "err");
    return;
  }
  toast(`已导出「${name}」到 导出 文件夹（${Math.round((body.bytes || 0) / 1024)} KB）`);
}

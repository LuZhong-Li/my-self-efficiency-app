/* 数据与设置：导出备份 / 导入恢复 / 自动备份 / 打开文件夹 / 主题 / 清空数据 */

import {
  store,
  touch,
  readFromDisk,
  setTheme,
  themeOf,
  setSkin,
  skinOf,
  esc,
  trash,
  restoreFromTrash,
  dropFromTrash,
  emptyTrash,
  TRASH_TABLE_LABEL,
} from "./store.js";
import { bindFresh, pageHeader } from "./ui.js";
import { askConfirm, toast } from "./dialog.js";

let health = null;

// 界面风格：id、名字、一句话说明（和明暗是两个独立维度）
const SKINS = [
  ["glass", "液态玻璃", "磨砂通透、悬浮分层"],
  ["default", "极简", "柔和圆角、轻阴影"],
  ["notebook", "笔记", "紧凑纯平、发丝线"],
  ["neo", "粗野", "硬边框、硬投影"],
];

export async function renderSettings(el) {
  el.innerHTML = `
    ${pageHeader("data")}
    <section class="card">
      <h2>数据放在哪</h2>
      <p class="hint">所有数据就一个文件，随时可以整份复制走。</p>
      <dl class="facts" id="set-facts"></dl>
      <div class="row">
        <button class="btn" data-act="open" data-which="data">打开数据文件夹</button>
        <button class="btn" data-act="open" data-which="backup">打开备份文件夹</button>
        <button class="btn" data-act="open" data-which="export">打开导出文件夹</button>
      </div>
      <p class="msg" id="open-msg"></p>
    </section>

    <section class="card">
      <h2>导出备份</h2>
      <p class="hint">
        把当前数据整份复制到 <code>数据\\导出\\</code>，文件名带时间。
        想放到网盘或移动硬盘，把那个文件复制走就行。
      </p>
      <div class="row">
        <button class="btn primary" data-act="export">导出备份文件</button>
      </div>
      <p class="msg" id="export-msg"></p>
    </section>

    <section class="card">
      <h2>导入恢复</h2>
      <p class="hint">
        选一个之前导出的 JSON 文件，恢复成那一刻的样子。
        当前数据会先自动存一份到备份文件夹，选错了也不怕。
      </p>
      <div class="row">
        <input type="file" id="import-file" accept=".json,application/json">
        <button class="btn" data-act="import">导入并恢复</button>
      </div>
      <p class="msg" id="import-msg"></p>
    </section>

    <section class="card">
      <h2>自动备份</h2>
      <p class="hint">每天第一次打开时自动存一份；下面按时间从新到旧排，超出份数的会被自动删掉。</p>
      <div class="row">
        <label class="inline-field">
          保留最近
          <input type="number" id="keep-input" min="1" max="365" step="1">
          份
        </label>
        <button class="btn small" data-act="backup-now">立即备份一次</button>
      </div>
      <ul class="backup-list" id="backup-list"></ul>
      <p class="msg" id="backup-msg"></p>
    </section>

    <section class="card">
      <h2>外观与标语</h2>
      <p class="hint">风格决定长相，明暗决定亮还是暗；两样互不影响，功能和数据都不变。</p>

      <div class="pref-row">
        <div class="pref-label"><strong>界面风格</strong><small>换一套视觉系统</small></div>
        <div class="skin-picker" role="group" aria-label="界面风格">
          ${SKINS.map(
            ([id, name, desc]) => `
            <button class="skin-opt" data-act="skin" data-skin="${id}">
              <span class="skin-demo" data-skin="${id}"></span>
              <span class="skin-text"><strong>${name}</strong><small>${desc}</small></span>
            </button>`
          ).join("")}
        </div>
      </div>

      <div class="pref-row">
        <div class="pref-label"><strong>明暗</strong><small>长时间看着舒服就行</small></div>
        <div class="row">
          <button class="btn" data-act="theme" data-theme="light">浅色</button>
          <button class="btn" data-act="theme" data-theme="dark">深色</button>
        </div>
      </div>

      <div class="row slogan-row">
        <label class="inline-field" for="slogan">首页一句话标语</label>
        <input id="slogan" maxlength="40" placeholder="比如：今天也要好好过">
      </div>
      <p class="msg" id="slogan-msg"></p>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>回收站</h2>
        <span class="hint" id="trash-count"></span>
      </div>
      <p class="hint">
        删掉的东西先放这儿，误删了能捞回来。只有「彻底删除」才是真没了。
        回收站最多留 200 条，再多的会把最旧的挤出去。
      </p>
      <ul class="items" id="trash-list"></ul>
      <div class="row">
        <button class="btn small" data-act="trash-empty">清空回收站</button>
      </div>
      <p class="msg" id="trash-msg"></p>
    </section>

    <section class="card danger-card">
      <h2>清空数据</h2>
      <p class="hint">把所有任务和记录清掉，回到刚装好的样子。清空前会自动存一份备份。</p>
      <p class="hint">回收站里的东西也会一起清掉。</p>
      <div id="clear-step1">
        <button class="btn danger" data-act="clear-ask">清空所有数据</button>
      </div>
      <div id="clear-step2" hidden>
        <p class="hint">这一步会把现在所有数据删掉，没法撤销（但备份还在）。确认请输入「清空」两个字：</p>
        <div class="row">
          <input id="clear-word" maxlength="8" autocomplete="off" placeholder="在这里输入 清空">
          <button class="btn danger" id="clear-do" data-act="clear-do" disabled>确认清空</button>
          <button class="btn" data-act="clear-cancel">取消</button>
        </div>
      </div>
      <p class="msg" id="clear-msg"></p>
    </section>
  `;

  bindFresh(el, { click: onClick, change: onChange, input: onInput, keydown: onKeydown });

  if (!health) {
    try {
      health = await (await fetch("/api/health", { cache: "no-store" })).json();
    } catch {
      /* 拿不到就在下面显示 — */
    }
  }
  renderFacts();
  renderThemeButtons();
  renderTrash();
  await refreshBackups();
}

/* ---------------- 画 ---------------- */

function factsData() {
  const s = (store.data && store.data.settings) || {};
  return [
    ["数据文件", health ? health.dataFile : "—"],
    ["文件大小", health ? fmtSize(health.dataSize) : "—"],
    ["备份目录", health ? health.backupDir : "—"],
    ["导出目录", health ? health.exportDir : "—"],
    ["备份保留", (s.backupKeep || 14) + " 份"],
  ];
}

function renderFacts() {
  const dl = document.getElementById("set-facts");
  if (!dl) return;
  dl.innerHTML = factsData()
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join("");
}

function renderThemeButtons() {
  const cur = themeOf();
  for (const btn of document.querySelectorAll('[data-act="theme"]')) {
    btn.classList.toggle("active", btn.dataset.theme === cur);
  }
  const curSkin = skinOf();
  for (const btn of document.querySelectorAll('[data-act="skin"]')) {
    btn.classList.toggle("active", btn.dataset.skin === curSkin);
  }
  const keep = document.getElementById("keep-input");
  const s = (store.data && store.data.settings) || {};
  if (keep) keep.value = s.backupKeep || 14;
  const slogan = document.getElementById("slogan");
  if (slogan) slogan.value = s.slogan || "";
}

async function refreshBackups() {
  const box = document.getElementById("backup-list");
  if (!box) return;
  try {
    const res = await fetch("/api/backups", { cache: "no-store" });
    const body = await res.json();
    const items = body.items || [];
    box.innerHTML = items.length
      ? items
          .map(
            (b) => `<li>
              <span class="b-kind">${esc(b.kind)}</span>
              ${b.keep ? `<span class="b-keep">长期保留</span>` : ""}
              <span class="b-name">${esc(b.name)}</span>
              <span class="b-time">${esc(b.mtime)}</span>
              <span class="b-size">${fmtSize(b.size)}</span>
              <button class="link" data-act="keep" data-name="${esc(b.name)}"
                data-keep="${b.keep ? "0" : "1"}">${b.keep ? "取消保留" : "长期保留"}</button>
            </li>`
          )
          .join("")
      : `<li class="b-empty">还没有备份文件。</li>`;
  } catch (err) {
    box.innerHTML = `<li class="b-empty">读不到备份列表：${esc(err && err.message ? err.message : err)}</li>`;
  }
}

function setMsg(id, text, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
  if (text) el.dataset.at = new Date().toLocaleTimeString("zh-CN");
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return "—";
  if (bytes < 1024) return bytes + " 字节";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function renderTrash() {
  const list = document.getElementById("trash-list");
  if (!list) return;
  const items = trash();
  const countEl = document.getElementById("trash-count");
  if (countEl) countEl.textContent = items.length ? `${items.length} 条` : "";
  list.innerHTML = items.length
    ? items
        .map(
          (e) => `<li class="item" data-trash="${esc(e.id)}">
            <span class="chip">${esc(TRASH_TABLE_LABEL[e.table] || e.table)}</span>
            <span class="i-title">${esc(e.label)}</span>
            <span class="i-meta">${esc(e.deletedAt || "")}</span>
            <span class="i-actions">
              <button class="link" data-act="trash-restore">恢复</button>
              <button class="link danger" data-act="trash-purge">彻底删除</button>
            </span>
          </li>`
        )
        .join("")
    : `<li class="b-empty">回收站是空的。</li>`;
}

function findTrashEntry(btn) {
  const li = btn.closest("[data-trash]");
  if (!li) return null;
  return trash().find((e) => e.id === li.dataset.trash) || null;
}

/* ---------------- 和服务说话 ---------------- */

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

/* ---------------- 事件 ---------------- */

async function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;

  try {
    if (act === "open") {
      const r = await post("/api/open-folder", { which: btn.dataset.which });
      setMsg("open-msg", "已打开：" + r.path, "ok");
    } else if (act === "export") {
      setMsg("export-msg", "正在导出…");
      const r = await post("/api/export");
      setMsg("export-msg", `已导出：${r.path}（${fmtSize(r.bytes)}）`, "ok");
    } else if (act === "backup-now") {
      setMsg("backup-msg", "正在备份…");
      const r = await post("/api/backup");
      setMsg("backup-msg", "已备份：" + r.name, "ok");
      await refreshBackups();
    } else if (act === "keep") {
      const r = await post("/api/backup-keep", {
        name: btn.dataset.name,
        keep: btn.dataset.keep === "1",
      });
      setMsg(
        "backup-msg",
        (r.keep ? "已标为长期保留，自动清理时会跳过它：" : "已取消保留：") + r.name,
        "ok"
      );
      await refreshBackups();
    } else if (act === "trash-restore") {
      const entry = findTrashEntry(btn);
      if (!entry) return;
      restoreFromTrash(entry);
      await touch(true);
      toast("已恢复到原来的模块");
    } else if (act === "trash-purge") {
      const entry = findTrashEntry(btn);
      if (!entry) return;
      const ok = await askConfirm({
        title: `彻底删除「${entry.label}」？`,
        message: "这次是真删了，找不回来。",
        confirmLabel: "彻底删除",
        danger: true,
      });
      if (!ok) return;
      dropFromTrash(entry);
      await touch(true);
      toast("已彻底删除");
    } else if (act === "trash-empty") {
      if (!trash().length) {
        toast("回收站本来就是空的", "err");
        return;
      }
      const n = trash().length;
      const ok = await askConfirm({
        title: "清空回收站？",
        message: `里面的 ${n} 条会彻底删除，找不回来了。`,
        confirmLabel: "清空",
        danger: true,
      });
      if (!ok) return;
      emptyTrash();
      await touch(true);
      toast("回收站已清空");
    } else if (act === "import") {
      await doImport();
    } else if (act === "theme") {
      setTheme(btn.dataset.theme);
      renderThemeButtons();
    } else if (act === "skin") {
      setSkin(btn.dataset.skin);
      const found = SKINS.find(([id]) => id === btn.dataset.skin);
      toast(`界面风格已换成「${found ? found[1] : ""}」`);
    } else if (act === "clear-ask") {
      showClearStep(2);
    } else if (act === "clear-cancel") {
      showClearStep(1);
    } else if (act === "clear-do") {
      await doClear();
    }
  } catch (err) {
    const box = {
      open: "open-msg",
      export: "export-msg",
      import: "import-msg",
      "backup-now": "backup-msg",
      keep: "backup-msg",
      "trash-restore": "trash-msg",
      "trash-purge": "trash-msg",
      "trash-empty": "trash-msg",
      "clear-do": "clear-msg",
    }[act];
    if (box) setMsg(box, "没成功：" + err.message, "err");
  }
}

async function doImport() {
  const input = document.getElementById("import-file");
  const file = input && input.files && input.files[0];
  if (!file) {
    setMsg("import-msg", "先选一个 JSON 文件。", "err");
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    setMsg("import-msg", "这个文件打不开，不是有效的 JSON。", "err");
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("version" in parsed)) {
    setMsg("import-msg", "这个文件不像是本程序导出的数据。", "err");
    return;
  }

  const ok = await askConfirm({
    title: `用「${file.name}」覆盖当前数据？`,
    message: "当前数据会先自动存一份到备份文件夹，选错了还能找回来。",
    confirmLabel: "导入并恢复",
  });
  if (!ok) return;

  const r = await post("/api/import", parsed);
  input.value = "";
  await readFromDisk(); // 界面跟着换成导入后的数据
  health = null;
  setMsg("import-msg", `已恢复。导入前的数据存为 ${r.snapshot}`, "ok");
}

async function doClear() {
  const r = await post("/api/clear");
  await readFromDisk();
  health = null;
  showClearStep(1);
  setMsg("clear-msg", `已清空。清空前的数据存为 ${r.snapshot}`, "ok");
}

/** 两步确认：第一步亮出输入框，第二步必须手打「清空」才放行 */
function showClearStep(n) {
  const s1 = document.getElementById("clear-step1");
  const s2 = document.getElementById("clear-step2");
  if (!s1 || !s2) return;
  s1.hidden = n !== 1;
  s2.hidden = n !== 2;
  const word = document.getElementById("clear-word");
  const doBtn = document.getElementById("clear-do");
  if (word) {
    word.value = "";
    if (n === 2) word.focus();
  }
  if (doBtn) doBtn.disabled = true;
}

function onInput(e) {
  if (e.target.id === "slogan") {
    if (!store.data.settings) store.data.settings = {};
    store.data.settings.slogan = e.target.value; // 打字时静默保存，不重画
    touch(false, true);
    return;
  }
  if (e.target.id !== "clear-word") return;
  const doBtn = document.getElementById("clear-do");
  if (doBtn) doBtn.disabled = e.target.value.trim() !== "清空";
}

function onKeydown(e) {
  // 数字框里按回车就等于「提交」，不用非得点别处
  if (e.target.id === "keep-input" && e.key === "Enter") e.target.blur();
}

async function onChange(e) {
  if (e.target.id === "slogan") {
    if (!store.data.settings) store.data.settings = {};
    store.data.settings.slogan = e.target.value.trim();
    await touch(true);
    setMsg("slogan-msg", "标语已保存，回首页就能看到。", "ok");
    return;
  }
  if (e.target.id !== "keep-input") return;
  const n = Math.max(1, Math.min(365, Math.round(Number(e.target.value) || 14)));
  e.target.value = n;
  if (!store.data.settings) store.data.settings = {};
  store.data.settings.backupKeep = n;
  // 先存、等保存完（服务端会顺手清理多余的备份），再刷新列表和提示：
  // 反过来的话，重画会把提示冲掉，列表也会刷在清理之前。
  await touch(true);
  setMsg("backup-msg", `以后最多保留最近 ${n} 份备份。`, "ok");
  await refreshBackups();
}

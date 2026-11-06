/* 设置页那张「自定义适配」卡片：装一个包，换掉应用名、图标、标语。
 *
 * 装 / 删 / 拉的动作全在 服务.py（要碰磁盘和网络），这里只管：
 *   把列表画出来、把用户选的包交给服务端、装完把新名字落到页面上。
 *
 * 包格式和校验规则在 pack-calc.js（纯逻辑，有单测）；
 * 页面上的名字和图标由 pack.js 的 applyPack 落。
 */

import { esc } from "./store.js";
import { askConfirm, toast } from "./dialog.js";
import { parseGitHubInput } from "./pack-calc.js";
import { applyPack, loadPack } from "./pack.js";

let state = { active: "", resolved: null, items: [], dir: "" };
let busy = false;

export function packCardHtml() {
  return `
    <section class="card" id="pack-card">
      <h2>自定义适配</h2>
      <p class="hint">
        装一个适配包，把应用名、图标、标语换成你自己的。包放在
        <code>数据\\…\\适配包\\&lt;id&gt;\\</code> 下面，跟着数据走，不进仓库、不上传。
        现在这一期只改「名字和图标」；界面元素、模块定制留着后面几期。
      </p>
      <p class="ds-current">现在在用：<b id="pack-current">—</b></p>
      <ul class="ds-list" id="pack-list"></ul>
      <p class="msg" id="pack-msg"></p>

      <div class="row">
        <input type="file" id="pack-file" accept=".zip,application/zip">
        <button class="btn" data-pack-act="file">装这个 zip</button>
      </div>
      <p class="hint">zip 里要有 <code>manifest.json</code>（和可选的图标文件），套不套一层文件夹都行。</p>

      <div class="row">
        <label class="inline-field" for="pack-dir">或者装本地文件夹</label>
        <input id="pack-dir" placeholder="比如 D:\\我的适配包" spellcheck="false">
        <button class="btn" data-pack-act="dir">装这个文件夹</button>
      </div>

      <div class="row">
        <label class="inline-field" for="pack-repo">从 GitHub 拉取</label>
        <input id="pack-repo" placeholder="用户名/仓库名，或 用户名/仓库名@分支" spellcheck="false">
        <button class="btn" data-pack-act="github">下载并安装</button>
      </div>
      <p class="hint">
        从 GitHub 拉取是这个程序唯一会联网的地方，只在你点按钮时才发请求；
        仓库里放一份 <code>manifest.json</code> 就能当包用。
      </p>

      <div class="row">
        <button class="btn small" data-pack-act="folder">打开适配包文件夹</button>
        <button class="btn small" data-pack-act="refresh">重新读一遍</button>
        <button class="btn small" data-pack-act="default">恢复默认「小李」</button>
      </div>
    </section>`;
}

/** 挂上那张卡片（settings.js 渲染完调它） */
export async function mountPack() {
  const card = document.getElementById("pack-card");
  if (!card) return;
  if (!card.dataset.bound) {
    card.dataset.bound = "1";
    card.addEventListener("click", onClick);
  }
  await refreshPack();
}

export async function refreshPack() {
  const info = await loadPack();
  state = info || { active: "", resolved: null, items: [], dir: "" };
  applyPack(state);
  draw();
}

function draw() {
  const cur = document.getElementById("pack-current");
  const list = document.getElementById("pack-list");
  if (!cur || !list) return;

  const name = (state.resolved && state.resolved.appName) || "小李";
  cur.textContent = state.active ? `${name}（${state.active}）` : `${name}（默认，没装适配包）`;

  if (!state.items.length) {
    list.innerHTML = `<li class="ds-row hint">还没有装任何适配包。</li>`;
    return;
  }

  list.innerHTML = state.items
    .map((it) => {
      const inUse = it.id && it.id === state.active;
      const broken = Boolean(it.broken);
      const meta = broken
        ? `装坏了：${esc(it.reason || "读不出来")}`
        : [it.version ? "v" + it.version : "", it.author ? "by " + it.author : ""]
            .filter(Boolean)
            .join(" · ") || "—";
      return `<li class="ds-row${inUse ? " current" : ""}${broken ? " pack-broken" : ""}">
        <span class="ds-name">${esc(it.appName || it.id || "—")}</span>
        ${inUse ? `<span class="ds-now">在用</span>` : ""}
        <span class="ds-meta">${meta}</span>
        <span class="pack-actions">
          ${broken ? "" : `<button class="btn small" data-pack-act="use" data-id="${esc(it.id)}">${inUse ? "重新应用" : "用这个"}</button>`}
          <button class="btn small danger" data-pack-act="delete" data-id="${esc(it.id)}">删除</button>
        </span>
      </li>`;
    })
    .join("");
}

/** 发一个 POST 给服务端，统一处理「忙 / 报错 / 结果里有新的包列表」 */
async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `服务端返回 ${res.status}`);
  }
  return data;
}

/** 服务端回了新的包列表（items / active）就接过来，省一次往返 */
function absorb(data) {
  if (!data) return;
  if (Array.isArray(data.items)) {
    state = {
      active: data.active || "",
      resolved: data.resolved || null,
      items: data.items,
      dir: data.dir || state.dir,
    };
    applyPack(state);
    draw();
  }
}

function msg(text, kind) {
  const el = document.getElementById("pack-msg");
  if (!el) return;
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

function setBusy(on) {
  busy = on;
  for (const btn of document.querySelectorAll('#pack-card [data-pack-act]')) {
    btn.disabled = on;
  }
}

async function onClick(ev) {
  const btn = ev.target.closest("[data-pack-act]");
  if (!btn || busy) return;
  const act = btn.dataset.packAct;

  try {
    if (act === "refresh") {
      await refreshPack();
      msg("");
      return;
    }

    if (act === "folder") {
      await post("/api/pack-folder", {});
      return;
    }

    if (act === "default") {
      setBusy(true);
      const data = await post("/api/pack-use", { id: "" });
      absorb(data);
      toast("已恢复默认名称");
      msg("");
      return;
    }

    if (act === "use") {
      setBusy(true);
      const data = await post("/api/pack-use", { id: btn.dataset.id });
      absorb(data);
      toast("已切换适配包");
      msg("");
      return;
    }

    if (act === "delete") {
      const id = btn.dataset.id;
      const yes = await askConfirm({
        title: "删除适配包",
        message: `确定要删掉「${id}」这个适配包吗？只删包里的名字和图标，不动你的数据。`,
        confirmLabel: "删除",
        danger: true,
      });
      if (!yes) return;
      setBusy(true);
      const data = await post("/api/pack-delete", { id });
      absorb(data);
      toast("适配包已删除");
      msg("");
      return;
    }

    if (act === "file") {
      const input = document.getElementById("pack-file");
      const file = input && input.files && input.files[0];
      if (!file) {
        msg("先选一个 zip 文件", "err");
        return;
      }
      setBusy(true);
      msg("正在装…");
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 1) bin += String.fromCharCode(buf[i]);
      const data = await post("/api/pack-install", { data: btoa(bin) });
      absorb(data);
      input.value = "";
      toast("适配包装好了");
      msg(data.warnings && data.warnings.length ? data.warnings.join("；") : "");
      return;
    }

    if (act === "dir") {
      const el = document.getElementById("pack-dir");
      const dir = (el && el.value || "").trim();
      if (!dir) {
        msg("先填文件夹路径", "err");
        return;
      }
      setBusy(true);
      msg("正在装…");
      const data = await post("/api/pack-install", { dir });
      absorb(data);
      toast("适配包装好了");
      msg(data.warnings && data.warnings.length ? data.warnings.join("；") : "");
      return;
    }

    if (act === "github") {
      const el = document.getElementById("pack-repo");
      const raw = (el && el.value || "").trim();
      const parsed = parseGitHubInput(raw);
      if (!parsed.ok) {
        msg(parsed.errors.join("；"), "err");
        return;
      }
      setBusy(true);
      msg("正在从 GitHub 下载…");
      const data = await post("/api/pack-github", {
        owner: parsed.owner,
        repo: parsed.repo,
        ref: parsed.ref,
      });
      absorb(data);
      toast("适配包装好了");
      msg(data.warnings && data.warnings.length ? data.warnings.join("；") : "");
      return;
    }
  } catch (err) {
    msg(String((err && err.message) || err), "err");
  } finally {
    if (busy) setBusy(false);
  }
}

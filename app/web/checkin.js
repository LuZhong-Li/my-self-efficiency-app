/* 设置页那张「每日签到（多站点）」卡片。
 *
 * 2026-11-04 重构成多站点：不再是 WorkBuddy 专用，而是一列站点，
 * 每个站点一行（名字 + 状态 + 本周格子 + 两个按钮），点开可以填凭证。
 *
 * 站点从哪来：服务端读 数据\<数据集>\签到站点\*.json（+ 内置的），
 * 这里只负责画和点。加新站点不用改这个文件。
 *
 * 联网全部发生在服务端（服务.py → 签到.py），这里一次请求都不发到外网。
 * 纯逻辑（状态判断、按钮可点、校验）在 checkin-calc.js，有单测。
 */

import { esc } from "./store.js";
import { toast } from "./dialog.js";
import {
  expiryLine,
  queryButton,
  resultLine,
  siteButton,
  siteCreditLine,
  siteState,
  siteStatusLine,
  sourceTag,
  summaryLine,
  tokenHint,
  weekCells,
} from "./checkin-calc.js";

let sites = [];              // 服务端给的站点列表
let statuses = {};           // {siteId: 状态对象}
let busySite = "";           // 正在签到的站点 id
let loadingSite = "";        // 正在查状态的站点 id
let openPanel = "";          // 展开着凭证区的站点 id
let messages = {};           // {siteId: {text, kind}} 每个站点自己的一行提示
let dir = "";

export function checkinCardHtml() {
  return `
    <section class="card" id="checkin-card">
      <h2>每日签到</h2>
      <p class="hint">
        每天在几个 AI 工具上领积分。这是小李会主动联网的功能之一，
        只在<strong>你点「立即签到」或「查状态」</strong>时才发请求，其余时间一个请求都不发。
      </p>

      <p class="ds-current" id="checkin-summary">加载中…</p>
      <ul class="ck-list" id="checkin-list"></ul>

      <div class="row">
        <button class="btn small" data-ck-act="folder">打开站点文件夹</button>
        <button class="btn small" data-ck-act="reload">重新读一遍</button>
      </div>
      <p class="hint">
        想加一个别的站点？在这个文件夹里放一个 JSON 就能用，不用改代码。
        格式见 <code>docs\\二开-加一个签到站点.md</code>。
      </p>
      <p class="msg" id="checkin-msg"></p>
    </section>`;
}

/** 挂上卡片（settings.js 渲染完调它） */
export async function mountCheckin() {
  const card = document.getElementById("checkin-card");
  if (!card) return;
  if (!card.dataset.bound) {
    card.dataset.bound = "1";
    card.addEventListener("click", onClick);
    card.addEventListener("input", onInput);
  }
  await loadSites();
}

async function loadSites() {
  try {
    const res = await fetch("/api/checkin", { cache: "no-store" });
    const data = await res.json();
    sites = Array.isArray(data.items) ? data.items : [];
    dir = data.dir || "";
  } catch {
    sites = [];
    setMsg("连不上本地服务", "bad");
  }
  // 站点列表变了，清掉已经不存在的那几份状态
  const ids = new Set(sites.map((s) => s.id));
  for (const k of Object.keys(statuses)) if (!ids.has(k)) delete statuses[k];
  draw();
}

function draw() {
  const list = document.getElementById("checkin-list");
  const summary = document.getElementById("checkin-summary");
  if (!list || !summary) return;

  summary.textContent = summaryLine(sites, statuses);

  if (!sites.length) {
    list.innerHTML = `<li class="ds-row hint">还没有任何签到站点。</li>`;
    return;
  }

  list.innerHTML = sites.map((s) => rowHtml(s)).join("");
}

function rowHtml(site) {
  const st = siteState(site, statuses[site.id]);
  const status = statuses[site.id];
  const btn = siteButton(site, status, busySite);
  const qbtn = queryButton(site, loadingSite);
  const msg = messages[site.id];
  const tag = sourceTag(site);

  // 本周格子：只有真拿到状态才画
  const week = status && status.ok && status.week ? weekCells(status.week) : null;
  const names = ["一", "二", "三", "四", "五", "六", "日"];

  const credit = siteCreditLine(status);
  const exp = expiryLine(site, status);
  const meta = [credit, exp].filter(Boolean).join(" · ");

  return `
    <li class="ck-row ck-${st}" data-site="${esc(site.id)}">
      <div class="ck-head">
        <span class="ck-name">${esc(site.name)}</span>
        ${tag ? `<span class="ck-tag">${esc(tag)}</span>` : ""}
        <span class="ck-state">${esc(siteStatusLine(site, status))}</span>
        ${week
          ? `<span class="ck-week">${week
              .map((c, i) => `<span class="ck-cell${c.on ? " on" : ""}" title="周${names[i]}">${names[i]}</span>`)
              .join("")}</span>`
          : ""}
      </div>
      ${meta ? `<div class="ck-meta">${esc(meta)}</div>` : ""}
      <div class="ck-actions">
        <button class="btn ${siteState(site, status) === "not-checked" ? "primary" : ""}"
                data-ck-act="do" data-site="${esc(site.id)}"
                ${btn.disabled ? "disabled" : ""}>${esc(btn.label)}</button>
        <button class="btn small" data-ck-act="status" data-site="${esc(site.id)}"
                ${qbtn.disabled ? "disabled" : ""}>${esc(qbtn.label)}</button>
        <button class="btn small" data-ck-act="panel" data-site="${esc(site.id)}">
          ${
            openPanel === site.id
              ? "收起"
              : site.browser
                ? site.configured
                  ? "账号"
                  : "去登录"
                : "填凭证"
          }
        </button>
      </div>
      ${openPanel === site.id ? panelHtml(site) : ""}
      ${msg ? `<p class="msg ${msg.kind || ""}">${esc(msg.text)}</p>` : ""}
    </li>`;
}

function panelHtml(site) {
  const hint = site.tokenHint ? `<p class="hint">${esc(site.tokenHint)}</p>` : "";

  // 浏览器型站点（如即梦）：凭证是一份登录过的浏览器配置，没 Token 可填。
  // 面板整个换成"登录 / 换账号"，塞个 Token 输入框只会误导。
  if (site.browser) {
    return `
    <div class="ck-panel">
      ${hint}
      <p class="hint">
        登录状态存在 <code>数据\\浏览器配置\\</code> 里，<b>不在</b> 数据.json 里，
        所以备份和导出都不会把它带走。它等同于你的账号登录状态，别发给别人。
      </p>
      <div class="row">
        <button class="btn" data-ck-act="login" data-site="${esc(site.id)}">
          ${site.configured ? "重新登录" : "打开浏览器登录"}
        </button>
        ${
          site.configured
            ? `<button class="btn small danger" data-ck-act="logout" data-site="${esc(site.id)}">
                 清掉登录状态
               </button>`
            : ""
        }
      </div>
      <p class="msg" data-ck-hint="${esc(site.id)}"></p>
    </div>`;
  }

  const vars = Array.isArray(site.vars) ? site.vars : [];
  const extra = vars
    .map(
      (v) => `
      <div class="row">
        <label class="inline-field">${esc(v.name)}${v.required ? "（必填）" : ""}</label>
        <input data-ck-var="${esc(v.name)}" data-site="${esc(site.id)}"
               placeholder="${esc(v.hint || "")}" spellcheck="false" autocomplete="off">
      </div>`
    )
    .join("");

  return `
    <div class="ck-panel">
      ${hint}
      <p class="hint">
        凭证存在 <code>数据\\签到凭证.json</code>，<b>不在</b> 数据.json 里，
        所以备份和导出都不会把凭证带走。它等同于你的登录状态，别发给别人。
      </p>
      <div class="row">
        <input type="password" spellcheck="false" autocomplete="off"
               data-ck-token data-site="${esc(site.id)}"
               placeholder="粘贴凭证（Authorization 里 Bearer 后面那一串）">
        <button class="btn" data-ck-act="save" data-site="${esc(site.id)}">保存</button>
      </div>
      ${extra}
      <p class="msg" data-ck-hint="${esc(site.id)}"></p>
      <div class="row">
        <button class="btn small" data-ck-act="from-script" data-site="${esc(site.id)}">
          从 D:\\自动签到 导入
        </button>
        <button class="btn small danger" data-ck-act="clear" data-site="${esc(site.id)}">
          删掉已存的凭证
        </button>
      </div>
    </div>`;
}

async function onClick(e) {
  const btn = e.target.closest("[data-ck-act]");
  if (!btn) return;
  const act = btn.dataset.ckAct;
  const siteId = btn.dataset.site || "";

  if (act === "folder") {
    try {
      await post("/api/checkin-folder", {});
    } catch (err) {
      setMsg(err.message, "bad");
    }
    return;
  }

  if (act === "reload") {
    await loadSites();
    toast("已重新读取");
    return;
  }

  if (act === "panel") {
    openPanel = openPanel === siteId ? "" : siteId;
    draw();
    return;
  }

  // 浏览器型站点：弹一个真浏览器让用户登录。
  // 登录这个过程必须用户自己来（扫码/验证码），我们只负责把窗口打开。
  if (act === "login") {
    hintFor(siteId, "正在打开浏览器…");
    try {
      const data = await post("/api/checkin-login", { site: siteId });
      hintFor(siteId, data.message || "浏览器打开了，登录完把窗口关掉。", "ok");
    } catch (err) {
      hintFor(siteId, err.message, "bad");
    }
    return;
  }

  if (act === "logout") {
    try {
      await post("/api/checkin-logout", { site: siteId });
      statuses[siteId] = null;
      toast("已清掉登录状态");
      await loadSites();
    } catch (err) {
      hintFor(siteId, err.message, "bad");
    }
    return;
  }

  if (act === "status") {
    await loadStatus(siteId, true);
    return;
  }

  if (act === "do") {
    busySite = siteId;
    messages[siteId] = null;
    draw();
    try {
      const data = await post("/api/checkin", { site: siteId });
      messages[siteId] = { text: resultLine({ ok: true, ...data }), kind: "ok" };
    } catch (err) {
      messages[siteId] = { text: err.message, kind: "bad" };
    }
    busySite = "";
    await loadStatus(siteId, false);   // 不管成败都重新拉一次真实状态
    return;
  }

  if (act === "save") {
    const input = document.querySelector(`[data-ck-token][data-site="${cssEsc(siteId)}"]`);
    const text = input ? input.value.trim() : "";
    const check = tokenHint(text);
    if (!check.ok) {
      hintFor(siteId, check.hint, "bad");
      return;
    }
    const values = { site: siteId, token: text };
    // 额外的变量（比如 device_id）一起带上
    document
      .querySelectorAll(`[data-ck-var][data-site="${cssEsc(siteId)}"]`)
      .forEach((el) => {
        if (el.value.trim()) values[el.dataset.ckVar] = el.value.trim();
      });
    await saveCred(values, input, siteId);
    return;
  }

  if (act === "from-script") {
    await saveCred({ site: siteId, fromScript: true }, null, siteId);
    return;
  }

  if (act === "clear") {
    try {
      await post("/api/checkin-clear", { site: siteId });
      hintFor(siteId, "凭证已删掉。", "ok");
      delete statuses[siteId];
      await loadSites();
    } catch (err) {
      hintFor(siteId, err.message, "bad");
    }
  }
}

async function loadStatus(siteId, showToast) {
  loadingSite = siteId;
  draw();
  try {
    const res = await fetch(
      `/api/checkin-status?site=${encodeURIComponent(siteId)}`,
      { cache: "no-store" }
    );
    statuses[siteId] = await res.json();
  } catch {
    statuses[siteId] = { ok: false, error: "连不上本地服务" };
  }
  loadingSite = "";
  draw();
  if (showToast) toast("已刷新");
}

async function saveCred(body, input, siteId) {
  try {
    const data = await post("/api/checkin-token", body);
    if (input) input.value = "";
    hintFor(siteId, data.expires ? `保存成功，有效期到 ${data.expires}` : "保存成功", "ok");
    await loadSites();
  } catch (err) {
    hintFor(siteId, err.message, "bad");
  }
}

function onInput(e) {
  const el = e.target.closest("[data-ck-token]");
  if (!el) return;
  const siteId = el.dataset.site;
  if (!el.value.trim()) {
    hintFor(siteId, "", "");
    return;
  }
  const check = tokenHint(el.value);
  hintFor(siteId, check.hint, check.hint ? (check.ok ? "ok" : "") : "");
}

/** 某个站点凭证区下面那行提示 */
function hintFor(siteId, text, kind) {
  const el = document.querySelector(`[data-ck-hint="${cssEsc(siteId)}"]`);
  if (!el) return;
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

function setMsg(text, kind) {
  const el = document.getElementById("checkin-msg");
  if (!el) return;
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

/** 站点 id 进选择器前先转义。id 只允许字母数字下划线连字符，正常不会出事，但别赌。 */
function cssEsc(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

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

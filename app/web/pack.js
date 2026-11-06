/* 自定义适配：把「我是谁」画到页面上 —— 页面标题、品牌位、问候语、图标。
 *
 * 纯逻辑在 pack-calc.js（Node 单测直接跑那份）；这里只碰 DOM 和网络。
 * 装包 / 删包 / 拉包的动作在 服务.py，这边只负责读取和应用。
 */

import { iconUrl } from "./pack-calc.js";

/** 最近一次拿到的包信息：{ active, resolved, items, dir } */
let current = null;

export function packInfo() {
  return current;
}

/** 问服务端现在装了什么、用哪个。拿不到就保持 null（页面用默认名）。 */
export async function loadPack() {
  try {
    const res = await fetch("/api/pack", { cache: "no-store" });
    const data = await res.json();
    if (data && data.resolved) {
      current = {
        active: data.active || "",
        resolved: data.resolved,
        items: Array.isArray(data.items) ? data.items : [],
        dir: data.dir || "",
      };
    }
  } catch {
    // 服务端没起来 / 老版本没有这个接口：保持默认，不影响别的功能
  }
  return current;
}

/**
 * 把包里的名字、图标落到页面上；没装包就全部退回默认值。
 *
 * 传 info 就用它（设置页切换后立刻生效），不传就用最近一次读到的。
 */
export function applyPack(info) {
  const src = info || current || { active: "", resolved: null, items: [] };
  const resolved = src.resolved || {};
  const name = resolved.appName || "小李";

  document.title = name;

  for (const el of document.querySelectorAll(".brand")) el.textContent = name;
  document.documentElement.dataset.appName = name;

  // 图标：装了包且有图标就指过去，否则清掉自定义图标（回到浏览器默认）
  const url = iconUrl(resolved);
  const head = document.head;
  let link = head.querySelector('link[rel="icon"]');
  if (!url) {
    if (link) link.remove();
    return;
  }
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    head.appendChild(link);
  }
  // 图标文件一改名字就变，加个查询串防止浏览器拿旧缓存
  link.href = url + (resolved.version ? "?v=" + encodeURIComponent(resolved.version) : "");
}

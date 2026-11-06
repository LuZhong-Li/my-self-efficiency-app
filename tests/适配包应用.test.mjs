/* 把「装包的包名 / 图标真的落到页面上」这件事测一遍。
 *
 * pack.js 是要碰 DOM 的，所以在 node 里搭一个最小 DOM 桩：只实现 applyPack 用到的那几个
 * 方法（querySelectorAll / querySelector / createElement / appendChild / remove），
 * 够把「标题、品牌位、问候语、网页图标」这四处的真实赋值跑一遍。
 *
 * 跑法：node tests\适配包应用.test.mjs
 */

import { applyPack } from "../app/web/pack.js";

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { pass++; console.log("  ok   " + label); }
  else {
    fail++;
    console.log("  FAIL " + label + "：期望 " + b + "，实际 " + a);
  }
}

/* ---------------- 最小 DOM 桩 ---------------- */

function makeDom(brandCount) {
  const brands = [];
  for (let i = 0; i < brandCount; i += 1) brands.push({ textContent: "小李" });

  const head = {
    children: [],
    querySelector(sel) {
      return sel === 'link[rel="icon"]'
        ? this.children.find((c) => c.rel === "icon") || null
        : null;
    },
    appendChild(el) {
      el.parent = this;
      this.children.push(el);
      return el;
    },
  };

  const doc = {
    title: "小李",
    head,
    documentElement: { dataset: {} },
    querySelectorAll(sel) {
      if (sel === ".brand") return brands;
      if (sel === "[data-app-name]") return [];
      return [];
    },
    createElement(tag) {
      return {
        tagName: tag,
        rel: "",
        href: "",
        parent: null,
        remove() {
          if (this.parent) {
            const i = this.parent.children.indexOf(this);
            if (i >= 0) this.parent.children.splice(i, 1);
            this.parent = null;
          }
        },
      };
    },
  };

  globalThis.document = doc;
  return { doc, brands, head };
}

/* ---------------- 用例 ---------------- */

console.log("pack.js：没装包时是默认的「小李」");
{
  const { doc, brands, head } = makeDom(2);
  applyPack({ active: "", resolved: { id: "", appName: "小李", icon: "" }, items: [] });
  eq(doc.title, "小李", "页面标题");
  eq(brands.map((b) => b.textContent), ["小李", "小李"], "两处品牌位都写着「小李」");
  eq(doc.documentElement.dataset.appName, "小李", "根节点上记着应用名");
  eq(head.children.length, 0, "没有自定义图标");
}

console.log("pack.js：装了包就换成包里的名字");
{
  const { doc, brands, head } = makeDom(2);
  applyPack({
    active: "wa",
    resolved: { id: "wa", appName: "我的工作台", icon: "ic.png", version: "1.0" },
    items: [],
  });
  eq(doc.title, "我的工作台", "页面标题换成包里的");
  eq(brands.map((b) => b.textContent), ["我的工作台", "我的工作台"], "品牌位跟着换");
  eq(doc.documentElement.dataset.appName, "我的工作台", "根节点上记着新名字");
  eq(head.children.length, 1, "挂上了一个图标 link");
  eq(head.children[0].rel, "icon", "是 icon 关系");
  eq(head.children[0].href, "pack-icon/wa/ic.png?v=1.0", "指到包里的图标，带版本防缓存");
}

console.log("pack.js：名字超长 / 带怪字符也不炸");
{
  const { doc } = makeDom(1);
  applyPack({ active: "x", resolved: { id: "x", appName: "很长的名字".repeat(10), icon: "" } });
  eq(typeof doc.title, "string", "标题还是个字符串");
  eq(doc.title.length > 0, true, "标题不为空");
}

console.log("pack.js：没写图标就不挂 link");
{
  const { head } = makeDom(1);
  applyPack({ active: "noicon", resolved: { id: "noicon", appName: "无图标", icon: "" } });
  eq(head.children.length, 0, "没有图标就不挂 link");
}

console.log("pack.js：从有图标换到没图标，旧的 link 要摘掉");
{
  const { head } = makeDom(1);
  applyPack({ active: "a", resolved: { id: "a", appName: "甲", icon: "i.png", version: "" } });
  eq(head.children.length, 1, "先挂上一个");
  eq(head.children[0].href, "pack-icon/a/i.png", "指向甲");
  applyPack({ active: "", resolved: { id: "", appName: "小李", icon: "" }, items: [] });
  eq(head.children.length, 0, "换回默认后旧的 link 被摘掉");
}

console.log("pack.js：反复应用同一个包不会越挂越多 link");
{
  const { head } = makeDom(1);
  for (let i = 0; i < 3; i += 1) {
    applyPack({ active: "a", resolved: { id: "a", appName: "甲", icon: "i.png", version: "" } });
  }
  eq(head.children.length, 1, "来回应用三次，只有一条 link");
}

console.log("pack.js：传空 / 传坏数据也不崩");
{
  const { doc, brands } = makeDom(1);
  applyPack({});
  eq(doc.title, "小李", "空对象 → 退回默认名");
  eq(brands[0].textContent, "小李", "品牌位退回默认");
}
{
  const { doc } = makeDom(1);
  applyPack({ active: "a", resolved: null });
  eq(doc.title, "小李", "resolved 是 null → 退回默认名");
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exitCode = 1;

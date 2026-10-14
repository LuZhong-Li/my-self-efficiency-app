/* 笔记的 Markdown 渲染器（app/web/markdown.js）的单元测试。
 * 跑法：node tests\Markdown.test.mjs   （本机 Node v24，不需要 package.json）
 * 说明：和别的 .test.mjs 一样，不进「自检.cmd」——自检是给用户一键跑的，保持纯 Python。
 *      这一份里出现的网址是给「链接怎么渲染」当例子的（测试文件不在零外链扫描范围内）。 */

import { renderMarkdown } from "../app/web/markdown.js";

let pass = 0;
let fail = 0;

function eq(actual, expected, label) {
  if (actual === expected) {
    pass++;
    console.log("  ok   " + label);
  } else {
    fail++;
    console.log("  FAIL " + label + "：期望 " + JSON.stringify(expected) +
      "，实际 " + JSON.stringify(actual));
  }
}

function ok(cond, label) {
  eq(Boolean(cond), true, label);
}

/** 长 HTML 里一个个全等太脆：这两个只看「有没有这一段」 */
const has = (html, bit, label) => ok(html.includes(bit), label);
const no = (html, bit, label) => eq(html.includes(bit), false, label);

console.log("\n【空输入】");
eq(renderMarkdown(""), "", "空串给空串");
eq(renderMarkdown("   \n  \n "), "", "只有空白也给空串");
eq(renderMarkdown(null), "", "传 null 不炸");
eq(renderMarkdown(undefined), "", "传 undefined 不炸");

console.log("\n【标题】");
eq(renderMarkdown("# 标题"), '<h1 class="md-h1">标题</h1>', "一级标题");
eq(renderMarkdown("### 三级"), '<h3 class="md-h3">三级</h3>', "三级标题");
eq(renderMarkdown("###### 六级"), '<h6 class="md-h6">六级</h6>', "六级标题");
eq(renderMarkdown("####### 七个井号"), '<p class="md-p">####### 七个井号</p>',
  "七个井号不是标题（最多六级）");
eq(renderMarkdown("# 标题\n正文"), '<h1 class="md-h1">标题</h1><p class="md-p">正文</p>',
  "标题和正文各成一块");

console.log("\n【行内】");
has(renderMarkdown("**粗**"), "<strong>粗</strong>", "粗体");
has(renderMarkdown("*斜*"), "<em>斜</em>", "斜体");
has(renderMarkdown("~~删~~"), "<del>删</del>", "删除线");
has(renderMarkdown("`代码`"), '<code class="md-code">代码</code>', "行内代码");
has(renderMarkdown("**未闭合"), "**未闭合", "没闭合的粗体原样留着");
eq(renderMarkdown("**未闭合").includes("<strong>"), false, "没闭合就不出 strong");
has(renderMarkdown("`**里**面`"), '<code class="md-code">**里**面</code>',
  "行内代码里的星号不当 Markdown 看");

console.log("\n【代码块】");
const code = renderMarkdown("```\nlet a = 1 < 2;\n**不解析**\n```");
has(code, '<pre class="md-pre"><code>', "代码块外壳");
has(code, "let a = 1 &lt; 2;", "代码块里的尖括号照样转义");
has(code, "**不解析**", "代码块里的 Markdown 不当语法");
eq(code.includes("<strong>"), false, "代码块里不出 strong");
const openFence = renderMarkdown("```\n没收尾");
has(openFence, "没收尾", "没闭合的代码块也收得住（不炸）");

console.log("\n【列表】");
eq(renderMarkdown("- a\n- b"),
  '<ul class="md-ul"><li class="md-li">a</li><li class="md-li">b</li></ul>', "无序列表");
eq(renderMarkdown("* a\n+ b"),
  '<ul class="md-ul"><li class="md-li">a</li><li class="md-li">b</li></ul>',
  "三种记号混着写也是一份列表");
eq(renderMarkdown("1. a\n2. b"),
  '<ol class="md-ol"><li class="md-li">a</li><li class="md-li">b</li></ol>', "有序列表");
eq(renderMarkdown("- a\n\n- b"),
  '<ul class="md-ul"><li class="md-li">a</li></ul><ul class="md-ul"><li class="md-li">b</li></ul>',
  "中间空一行就是两份列表");
has(renderMarkdown("- **粗**的"), '<li class="md-li"><strong>粗</strong>的</li>',
  "列表项里也能有行内语法");

console.log("\n【引用与分割线】");
eq(renderMarkdown("> 引用"), '<blockquote class="md-quote">引用</blockquote>', "引用");
eq(renderMarkdown("> 第一行\n> 第二行"),
  '<blockquote class="md-quote">第一行<br>第二行</blockquote>', "连着两行引用合成一块");
eq(renderMarkdown("---"), '<hr class="md-hr">', "分割线（三个减号）");
eq(renderMarkdown("***"), '<hr class="md-hr">', "三个星号也是分割线");

console.log("\n【链接与图片】");
const link = renderMarkdown("[小李](https://example.com/a)");
has(link, 'class="md-link"', "链接带自己的类");
has(link, 'href="https://example.com/a"', "地址写进去了");
has(link, 'target="_blank"', "新窗口打开");
has(link, 'rel="noopener"', "带上 rel（安全习惯）");
has(renderMarkdown("![封面](attachments/note/20261014_a1b2.png)"),
  '<img class="md-img" src="attachments/note/20261014_a1b2.png" alt="封面">',
  "图片（本地附件路径）");
const bad = renderMarkdown("[点我](javascript:alert(1))");
no(bad, "<a ", "javascript: 地址不生成链接");
has(bad, "javascript:alert(1)", "认不出的地址原样当文字显示");
no(bad, "href=", "压根没有 href 生成出来");
has(renderMarkdown("[锚点](#plan)"), 'href="#plan"', "页内锚点认");

console.log("\n【安全：先转义再插标签】");
const evil = renderMarkdown("<script>alert(1)</script>");
no(evil, "<script", "笔记里的 script 标签不会变成真标签");
has(evil, "&lt;script&gt;", "它被转义成文字");
const attr = renderMarkdown('![x" onerror="alert(1)](attachments/note/a.png)');
no(attr, 'onerror="alert(1)"', "alt 里的引号没法跑出来搞属性注入");
has(renderMarkdown("a & b"), "a &amp; b", "与号转义");
has(renderMarkdown("# <b>标题</b>"), "&lt;b&gt;标题&lt;/b&gt;", "标题里也转义");
has(renderMarkdown("`<i>x</i>`"), '<code class="md-code">&lt;i&gt;x&lt;/i&gt;</code>',
  "行内代码里也转义");

console.log("\n【段落与换行】");
eq(renderMarkdown("第一段\n\n第二段"),
  '<p class="md-p">第一段</p><p class="md-p">第二段</p>', "空行分段");
eq(renderMarkdown("第一行\n第二行"),
  '<p class="md-p">第一行<br>第二行</p>', "单回车是同一段里换行");
eq(renderMarkdown("正文\n\n# 标题"),
  '<p class="md-p">正文</p><h1 class="md-h1">标题</h1>', "段落后面接标题");
eq(renderMarkdown("- a\n正文"),
  '<ul class="md-ul"><li class="md-li">a</li></ul><p class="md-p">正文</p>',
  "列表后面直接接正文（列表到此为止）");
eq(renderMarkdown("windows\r\n换行"), '<p class="md-p">windows<br>换行</p>',
  "Windows 的换行也认");

console.log("\n【一整篇】");
const full = renderMarkdown([
  "# 标题",
  "",
  "一段话，带**粗体**和 `代码`。",
  "",
  "- 甲",
  "- 乙",
  "",
  "> 引用一句",
  "",
  "---",
  "",
  "```",
  "code",
  "```",
].join("\n"));
has(full, '<h1 class="md-h1">标题</h1>', "整篇：标题在");
has(full, "<strong>粗体</strong>", "整篇：粗体在");
has(full, '<ul class="md-ul">', "整篇：列表在");
has(full, '<blockquote class="md-quote">', "整篇：引用在");
has(full, '<hr class="md-hr">', "整篇：分割线在");
has(full, '<pre class="md-pre"><code>code</code></pre>', "整篇：代码块在");

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);

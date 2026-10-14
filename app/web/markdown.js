/* 笔记的 Markdown 渲染器：纯函数，只吃字符串、吐 HTML 片段。
 *
 * 为什么自己写一个：这个项目零外链、不装依赖，引不了现成的库。
 * 好在个人笔记用不上完整的 Markdown 规范 —— 标题 / 粗斜 / 代码 / 列表 / 引用 /
 * 链接图片这几样就够（表格、脚注、公式都不做，见设计文档第 43 节）。
 *
 * 安全规矩（这一条最要紧，顺序不能反）：
 *   1. **先把整段文字转义**，再往里插我们自己生成的标签 ——
 *      所以笔记里写 script 标签只会原样显示成文字；
 *   2. 链接只认 http / https 这两种协议、页内锚点（#）和本地附件路径（attachments/…）；
 *      其它一律不生成 a 标签，原样当文字显示（javascript: 那种就这么被挡住的）；
 *   3. 生成的标签都带自己的 class（md-h1 / md-p / md-code…），样式在 style.css 里。
 */

/** 转义 HTML 里那几个要紧的字符（和 store.js 的 esc 一个实现，纯模块 import 不了那个） */
function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 地址白名单：http / https 开头的、页内锚点（#）、本地附件（attachments/）三种认，
 * 其它给空串（调用方按「原样显示」处理）。
 * 注意：传进来的是**已经转义过**的文本，所以这里不能再转义一次（否则 &amp; 会变成 &amp;amp;）。
 */
function safeUrl(url) {
  const u = String(url || "").trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("#") || u.startsWith("attachments/")) return u;
  return "";
}

/**
 * 行内语法。**入参必须是已经转义过的文本**。
 * 顺序有讲究：行内代码先抠出来（里面的星号不当语法），图片排在链接前面（语法只差一个感叹号）。
 */
function inline(text) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (m, one) => {
    codes.push(one);
    return "\u0000" + (codes.length - 1) + "\u0000";
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => {
    const url = safeUrl(src);
    if (!url) return m;                       // 地址认不出就原样留着
    return `<img class="md-img" src="${url}" alt="${alt}">`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    const url = safeUrl(href);
    if (!url) return m;
    return `<a class="md-link" href="${url}" target="_blank" rel="noopener">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // 最后把代码占位符换回来
  return out.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code class="md-code">${codes[Number(i)]}</code>`);
}

/** 一段普通文字（可能含多个单回车）→ 一个段落 */
function paraHtml(lines) {
  const body = inline(esc(lines.join("\n"))).replace(/\n/g, "<br>");
  return `<p class="md-p">${body}</p>`;
}

/** 引用块（里面也可以有多行） */
function quoteHtml(lines) {
  const body = inline(esc(lines.join("\n"))).replace(/\n/g, "<br>");
  return `<blockquote class="md-quote">${body}</blockquote>`;
}

/**
 * 整段 Markdown → HTML。逐行扫的「状态机」：
 * 攒着当前这一段 / 这份列表 / 这段引用 / 这个代码块，遇到换结构的地方就收口。
 */
export function renderMarkdown(text) {
  const src = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  if (!src.trim()) return "";
  const out = [];
  let para = [];
  let list = null;   // { tag: "ul" | "ol", items: [] }
  let quote = [];
  let code = null;   // 代码块里攒的行

  const flushPara = () => {
    if (para.length) {
      out.push(paraHtml(para));
      para = [];
    }
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((t) => `<li class="md-li">${inline(esc(t))}</li>`).join("");
    out.push(`<${list.tag} class="md-${list.tag}">${items}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(quoteHtml(quote));
      quote = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (const line of src.split("\n")) {
    // 代码块里：原样攒着，只找收尾的那三个反引号
    if (code) {
      if (/^```\s*$/.test(line)) {
        out.push(`<pre class="md-pre"><code>${esc(code.join("\n"))}</code></pre>`);
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^```/.test(line)) {
      flushAll();
      code = [];
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      flushAll();
      const level = head[1].length;
      out.push(`<h${level} class="md-h${level}">${inline(esc(head[2].trim()))}</h${level}>`);
      continue;
    }
    if (/^(?:-{3,}|\*{3,})$/.test(line.trim())) {
      flushAll();
      out.push('<hr class="md-hr">');
      continue;
    }
    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      flushPara();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      flushQuote();
      if (!list || list.tag !== "ul") {
        flushList();
        list = { tag: "ul", items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushPara();
      flushQuote();
      if (!list || list.tag !== "ol") {
        flushList();
        list = { tag: "ol", items: [] };
      }
      list.items.push(numbered[1]);
      continue;
    }
    // 剩下的都是普通正文：列表 / 引用到此为止
    flushList();
    flushQuote();
    para.push(line.trim());
  }
  // 收尾：没闭合的代码块也照原样收住
  if (code) out.push(`<pre class="md-pre"><code>${esc(code.join("\n"))}</code></pre>`);
  flushAll();
  return out.join("");
}

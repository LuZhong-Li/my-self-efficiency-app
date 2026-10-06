/* 内联 SVG 图标。
 *
 * 为什么不用图标字体或图标库：那些要么联网、要么要装依赖。
 * 这里全部手写成几行 path，跟着页面一起走，断网照常显示，
 * 颜色跟着文字走（stroke="currentColor"），换主题自动变。
 */

const PATHS = {
  // 九个模块
  home: '<path d="M4 10.6 12 4l8 6.6V19a1.4 1.4 0 0 1-1.4 1.4h-4.1v-6H9.5v6H5.4A1.4 1.4 0 0 1 4 19z"/>',
  plan: '<path d="M4 6.5h10M4 12h10M4 17.5h6M15.5 16l2 2 3.5-4"/>',
  media: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.4"/><path d="M10.5 9.5l4.5 2.5-4.5 2.5z"/>',
  dev: '<path d="M9.5 8 6 12l3.5 4M14.5 8 18 12l-3.5 4"/>',
  study: '<path d="M12 6.8C10.4 5.7 8.4 5 6 5H4v12.5h2c2.4 0 4.4.7 6 1.8M12 6.8C13.6 5.7 15.6 5 18 5h2v12.5h-2c-2.4 0-4.4.7-6 1.8M12 6.8v12.5"/>',
  fitness: '<path d="M6.5 9v6M4 10.5v3M17.5 9v6M20 10.5v3M6.5 12h11"/>',
  diet: '<path d="M9.5 3.5v6a2 2 0 0 1-4 0v-6M7.5 11.5v9M16.5 3.5c-1.4 1.4-2 3-2 4.8s.6 3.2 2 4.2v8"/>',
  game: '<path d="M7.5 8h9a4 4 0 0 1 4 4v1.2a2.8 2.8 0 0 1-5.1 1.6l-.6-.8H9.2l-.6.8A2.8 2.8 0 0 1 3.5 13.2V12a4 4 0 0 1 4-4Z"/><path d="M8 10.8v2.4M6.8 12h2.4M16 11.6h.01M18 13h.01"/>',
  settings: '<path d="M4 7.5h6M15 7.5h5M4 12h2M11 12h9M4 16.5h6M15 16.5h5"/><circle cx="12.5" cy="7.5" r="2.2"/><circle cx="8.5" cy="12" r="2.2"/><circle cx="12.5" cy="16.5" r="2.2"/>',
  money: '<ellipse cx="12" cy="7" rx="7" ry="3"/><path d="M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7"/><path d="M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/>',

  // 界面零碎
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  arrowRight: '<path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  pencil: '<path d="M5 19h3l9.5-9.5a2.1 2.1 0 0 0-3-3L5 16z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5 20 20"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  trash: '<path d="M5 7.5h14M9.5 7.5v-2h5v2M7 7.5 8 20h8l1-12.5M10.5 11v5.5M13.5 11v5.5"/>',
  undo: '<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3"/>',
  star: '<path d="M12 4.5l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 9.8l5-.7z"/>',
  warning: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4M12 16.8h.01"/>',
  folder: '<path d="M4 7.5h5l1.5 2H20v9H4z"/>',
  export: '<path d="M12 4.5v10M8 10.5l4 4 4-4M5 19h14"/>',
  import: '<path d="M12 15V5M8 8.5l4-4 4 4M5 19h14"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19 4v4h-4"/>',
  bug: '<path d="M12 8a5 5 0 0 1 5 5v2a5 5 0 0 1-10 0v-2a5 5 0 0 1 5-5Z"/><path d="M12 8V5.5M9.5 5 8 3.5M14.5 5 16 3.5M7 11H4M17 11h3M7.5 15 5 17M16.5 15 19 17"/>',
  bulb: '<path d="M9 17h6M10 20h4"/><path d="M12 3.5a5.5 5.5 0 0 1 3.2 9.9c-.5.4-.7.8-.7 1.4v.7h-5v-.7c0-.6-.2-1-.7-1.4A5.5 5.5 0 0 1 12 3.5Z"/>',
  list: '<path d="M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01"/>',
};

export function icon(name, size = 18) {
  const body = PATHS[name] || PATHS.list;
  return (
    `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${body}</svg>`
  );
}

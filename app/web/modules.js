/* 九个模块的唯一清单：侧边导航、首页摘要卡片、全局搜索都从这里取，
 * 免得三处各写一份名字和图标，改一个忘一个。 */

export const MODULES = [
  { id: "home", name: "首页总览", icon: "home", desc: "今天的重点、备忘和各模块状态" },
  { id: "plan", name: "今日计划", icon: "plan", desc: "今天要做的事，可按时间排序" },
  { id: "media", name: "自媒体", icon: "media", desc: "选题到发布的内容流水" },
  { id: "dev", name: "开发工作", icon: "dev", desc: "项目、待办、问题和进展" },
  { id: "study", name: "学习工作", icon: "study", desc: "在学什么、学了多久、有什么心得" },
  { id: "finance", name: "记账", icon: "money", desc: "每天的支出和收入，一个月花了多少" },
  { id: "fitness", name: "健身计划", icon: "fitness", desc: "每周安排、训练打卡和体重" },
  { id: "diet", name: "饮食计划", icon: "diet", desc: "三餐、加餐和喝水" },
  { id: "game", name: "游戏娱乐", icon: "game", desc: "在玩、想玩和通关记录" },
  { id: "data", name: "数据与设置", icon: "settings", desc: "备份、回收站、外观和清空" },
];

/** 首页摘要卡片上要露脸的六个模块（首页、今日计划、设置不在这里） */
export const SUMMARY_MODULES = ["media", "dev", "study", "fitness", "diet", "game", "finance"];

export function moduleOf(id) {
  return MODULES.find((m) => m.id === id) || MODULES[0];
}

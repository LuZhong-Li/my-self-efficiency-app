# -*- coding: utf-8 -*-
r"""小李 · 演示数据

给「开发用的这一份」一键塞一套像样的样例数据，用来演示、截图、看效果。
默认只动这份代码自己的 数据\ 目录，不会碰日常在用的那一份——除非你
用 --data-dir 明确指过去，或者用 --running 指到「现在开着的那一个」。

    python tools\演示数据.py                 载入示例数据
    python tools\演示数据.py --action status   只看现在有哪些数据
    python tools\演示数据.py --action restore  还原成载入前的样子
    python tools\演示数据.py --running         载入到「现在开着的那个小李」
    python tools\演示数据.py --data-dir "D:\小李\数据"

三条安全约定（演示数据是拿来随便玩的，但你的真实数据不是）：
  1. 覆盖前先把现在这份 数据.json 复制成 备份\保留-演示前-<时间>.json；
     「保留-」开头 = 自动清理会跳过它，界面上也标着「长期保留」。
  2. 现在这份要是空的（没任务也没记录），就不生成快照——没东西可丢。
  3. 现在这份有东西、又不是上一次的演示数据时，先问一句，直接回车就取消。
     界面上「数据与设置 → 导入恢复」也能拿 保留-演示前-*.json 还原。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta

APP_NAME = "小李"
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARKER_NAME = ".演示数据"
SNAPSHOT_PREFIX = "保留-演示前-"   # 「保留-」这个前缀服务端会跳过自动清理
PORT_FIRST, PORT_LAST = 8765, 8776


def setup_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


# --------------------------------------------------------------------------
# 文件
# --------------------------------------------------------------------------

def data_dir_of(explicit: str | None, want_running: bool) -> str:
    """数据目录按这个顺序定：--data-dir > --running 找到的那个 > 环境变量 > 这份代码自己的。"""
    if explicit:
        return os.path.abspath(explicit)
    if want_running:
        found = read_running(None)
        if found is None:
            raise SystemExit("  没找到正在运行的小李，去掉 --running 再试，或用 --data-dir 指一个目录。")
        port, _data, data_file = found
        print("  找到了正在运行的小李：http://127.0.0.1:%d" % port)
        return os.path.dirname(data_file)
    env = os.environ.get("XIAOLI_DATA_DIR")
    if env:
        return os.path.abspath(env)
    return os.path.join(BASE_DIR, "数据")


def data_file_of(data_dir: str) -> str:
    return os.path.join(data_dir, "数据.json")


def backup_dir_of(data_dir: str) -> str:
    return os.path.join(data_dir, "备份")


def read_json(path: str) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def atomic_write_json(path: str, obj: object) -> None:
    """和 服务.py 一样：先写临时文件、刷盘、再整体替换。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def time_stamp() -> str:
    return datetime.now().strftime("%Y-%m-%d-%H%M%S")


def marker_path(data_dir: str) -> str:
    return os.path.join(data_dir, MARKER_NAME)


def read_marker(data_dir: str) -> str | None:
    try:
        with open(marker_path(data_dir), "r", encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def write_marker(data_dir: str, snapshot: str | None) -> None:
    with open(marker_path(data_dir), "w", encoding="utf-8", newline="\n") as f:
        f.write("%s\n%s\n" % (time_stamp(), snapshot or ""))


def clear_marker(data_dir: str) -> None:
    try:
        os.remove(marker_path(data_dir))
    except OSError:
        pass


# --------------------------------------------------------------------------
# 现在开着的那个小李
# --------------------------------------------------------------------------

def read_running(data_dir: str | None):
    """扫一遍 8765 起的端口，找正在运行的小李。

    给了 data_dir 就只认「数据目录正好是它」的那个——避免把演示数据
    写到另一个副本上去。返回 (端口, 数据, 数据文件路径)，没找到返回 None。
    """
    for port in range(PORT_FIRST, PORT_LAST + 1):
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:%d/api/health" % port, timeout=0.25
            ) as resp:
                health = json.loads(resp.read().decode("utf-8"))
        except Exception:
            continue
        if health.get("app") != APP_NAME:
            continue
        data_file = str(health.get("dataFile") or "")
        if data_dir and os.path.dirname(os.path.abspath(data_file)) != os.path.abspath(data_dir):
            continue
        data = read_json(data_file)
        if data is None:
            continue
        return port, data, data_file
    return None


def apply_data(data_dir: str, payload: dict) -> str:
    """把 payload 写进去。开着服务就走接口写（修订号由服务端推进，
    保存前还会照例留一份「_最近一次」），没开就直接原子替换文件。"""
    running = read_running(data_dir)
    if running:
        port, live, _path = running
        payload["rev"] = int(live.get("rev") or 0)
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            "http://127.0.0.1:%d/api/data" % port,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise SystemExit("  写入被服务拒了（%s）：%s"
                             % (exc.code, exc.read().decode("utf-8", "replace")))
        if not result.get("ok"):
            raise SystemExit("  写入失败：%s" % result)
        how = "通过正在运行的服务写进去（http://127.0.0.1:%d）" % port
    else:
        current = read_json(data_file_of(data_dir))
        payload["rev"] = int((current or {}).get("rev") or 0) + 1
        payload["updatedAt"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        atomic_write_json(data_file_of(data_dir), payload)
        how = "直接写文件"
    return how


# --------------------------------------------------------------------------
# 看一下现在有什么
# --------------------------------------------------------------------------

COUNT_KEYS = [
    ("tasks", "任务"), ("contents", "自媒体"), ("mediaAccounts", "自媒体账号"),
    ("projects", "项目"), ("issues", "问题"),
    ("progress", "进展"), ("subjects", "学习对象"), ("studies", "学习记录"),
    ("workoutLogs", "训练打卡"), ("weights", "体重"), ("meals", "饮食"),
    ("water", "饮水"), ("games", "游戏"), ("finance.transactions", "账目"),
    ("debt.items", "债务"),
]


def counts(data: dict) -> list[tuple[str, int]]:
    out = []
    for key, label in COUNT_KEYS:
        value = dig(data, key)
        out.append((label, len(value) if isinstance(value, list) else 0))
    return out


def dig(data: dict, path: str):
    """按 "a.b" 取嵌套的值（记账的数据嵌在 finance 一个键里）。"""
    cur = data
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def has_content(data: dict) -> bool:
    """有东西可丢吗？空骨架（全 0）不算。"""
    if str(data.get("memo") or "").strip():
        return True
    if data.get("trash"):
        return True
    return any(n for _label, n in counts(data))


def print_counts(title: str, data: dict) -> None:
    print("  %s" % title)
    print("    " + " | ".join("%s %d" % (label, n) for label, n in counts(data)))
    print("    回收站 %d 条" % len(data.get("trash") or []))


# --------------------------------------------------------------------------
# 样例数据：全部按「今天」算，什么时候跑都是当下这个月的
# --------------------------------------------------------------------------

def demo_data(existing: dict | None) -> dict:
    today = date.today()

    def d(offset: int) -> str:
        return (today + timedelta(days=offset)).isoformat()

    old = existing or {}
    settings = dict(old.get("settings") or {})
    settings.setdefault("theme", "light")
    settings.setdefault("themeMode", "light")
    settings.setdefault("backupKeep", 14)
    settings.setdefault("slogan", "把时间花在看得见的地方")

    projects = [
        {"id": "demo-p1", "name": "小李（个人工作台）", "status": "进行中",
         "intro": "本机运行的个人效率面板：九个模块，一份 JSON。", "startDate": d(-38)},
        {"id": "demo-p2", "name": "英语精读计划", "status": "进行中",
         "intro": "每周三篇精读，把生词和句型记下来。", "startDate": d(-21)},
        {"id": "demo-p3", "name": "房间收纳改造", "status": "已完成",
         "intro": "换掉书桌、加了两个收纳箱。", "startDate": d(-60)},
    ]

    subjects = [
        {"id": "demo-s1", "name": "高等数学（上）", "kind": "课程", "source": "B 站",
         "note": "每周三次，一次一小时左右"},
        {"id": "demo-s2", "name": "英语精读", "kind": "书", "source": "外研社",
         "note": "重点练长难句"},
        {"id": "demo-s3", "name": "Python 练习", "kind": "技能", "source": "自己练",
         "note": "项目驱动，边做边学"},
        {"id": "demo-s4", "name": "《人类简史》", "kind": "书", "source": "中信出版",
         "note": "睡前读一会儿"},
        {"id": "demo-s5", "name": "打字速度", "kind": "技能", "source": "在线练习",
         "note": "目标 80 字/分"},
    ]

    # 学习记录是这张月历的主角：这个月里铺开一整个月的点
    study_plan = [
        (-20, "demo-s1", 90, "极限与连续", "洛必达法则还挺好使", True),
        (-17, "demo-s2", 45, "精读 Unit 3", "长难句拆开看就清楚了", True),
        (-14, "demo-s3", 120, "写了一个小爬虫", "requests 的超时没处理", False),
        (-12, "demo-s4", 30, "第一章", "", True),
        (-10, "demo-s1", 60, "导数与微分", "应用题还是慢", True),
        (-8, "demo-s5", 25, "打字练习", "盲打小指有点跟不上", False),
        (-7, "demo-s2", 40, "背单词 Unit 4", "", True),
        (-6, "demo-s3", 90, "重构那个爬虫", "把重试抽成了函数", False),
        (-5, "demo-s1", 50, "定积分", "换元法还要多练", False),
        (-4, "demo-s4", 35, "第二章", "有意思的一章", True),
        (-3, "demo-s2", 55, "写作练习", "连接词用得比以前顺", False),
        (-2, "demo-s3", 100, "做了一个小工具", "命令行参数用 argparse", False),
        (-1, "demo-s1", 80, "微分方程", "先放着，明天再回看", False),
        (0, "demo-s1", 75, "积分入门", "换元法还要多练", False),
        (0, "demo-s3", 60, "练习题 1-5", "", False),
        (0, "demo-s4", 25, "第三章", "记了两句想抄下来的话", True),
        (1, "demo-s2", 40, "背单词 Unit 5", "", False),
        (2, "demo-s5", 30, "打字练习", "", False),
        (3, "demo-s3", 90, "给工具补测试", "", False),
        (5, "demo-s1", 60, "级数", "", False),
        (7, "demo-s2", 45, "精读 Unit 6", "", False),
        (9, "demo-s4", 30, "第四章", "", False),
        (12, "demo-s3", 90, "整理成一个小项目", "", False),
        (16, "demo-s1", 70, "阶段小结", "", False),
    ]
    studies = [
        {"id": "demo-st%02d" % i, "subjectId": sid, "date": d(offset),
         "minutes": minutes, "content": content, "takeaway": takeaway, "reviewed": reviewed}
        for i, (offset, sid, minutes, content, takeaway, reviewed) in enumerate(study_plan, start=1)
    ]

    tasks = [
        {"id": "demo-t1", "date": d(0), "text": "把论文提纲列出来", "time": "09:00",
         "category": "工作", "done": False, "note": "先写粗纲"},
        {"id": "demo-t2", "date": d(0), "text": "数学刷题 10 道", "time": "10:30",
         "category": "工作", "done": True, "note": "积分那几道"},
        {"id": "demo-t3", "date": d(0), "text": "跑步 5 公里", "time": "19:30",
         "category": "运动", "done": True, "note": ""},
        {"id": "demo-t4", "date": d(0), "text": "回一下邮件", "time": "", "category": "工作",
         "done": False, "note": ""},
        {"id": "demo-t5", "date": d(0), "text": "给家里打个电话", "time": "21:00",
         "category": "生活", "done": False, "note": ""},
        {"id": "demo-t6", "date": d(-1), "text": "整理上周的笔记", "time": "",
         "category": "工作", "done": False, "note": ""},
        {"id": "demo-t7", "date": d(-2), "text": "交水电费", "time": "",
         "category": "生活", "done": False, "note": ""},
        {"id": "demo-t8", "date": d(-4), "text": "把书桌收拾一下", "time": "",
         "category": "生活", "done": False, "note": ""},
        {"id": "demo-t9", "date": d(1), "text": "牙医复诊", "time": "10:00",
         "category": "生活", "done": False, "note": ""},
        {"id": "demo-t10", "date": d(3), "text": "小组分享", "time": "14:00",
         "category": "工作", "done": False, "note": "准备三页 PPT"},
        {"id": "demo-t11", "date": d(6), "text": "交房租", "time": "", "category": "生活",
         "done": False, "note": ""},
        {"id": "demo-t12", "date": d(9), "text": "月度复盘", "time": "20:00",
         "category": "工作", "done": False, "note": ""},
        # 开发工作页里挂在项目上的待办（date 留空，不混进今日计划）
        {"id": "demo-t13", "date": "", "text": "把月历的氛围底再调淡一点", "time": "",
         "category": "工作", "done": False, "note": "", "belong": "dev:demo-p1"},
        {"id": "demo-t14", "date": "", "text": "看看导入恢复的提示文案", "time": "",
         "category": "工作", "done": True, "note": "", "belong": "dev:demo-p1"},
        {"id": "demo-t15", "date": "", "text": "列 10 个常用句型", "time": "",
         "category": "工作", "done": False, "note": "", "belong": "dev:demo-p2"},
    ]
    for task in tasks:
        task.setdefault("belong", "plan")
        task.setdefault("createdAt", d(0) + "T08:00:00")
        if task["done"]:
            task.setdefault("doneAt", d(0) + "T20:00:00")
        else:
            task.setdefault("doneAt", None)

    contents = [
        {"id": "demo-c1", "title": "写作这件小事", "accountId": "demo-ma3", "platform": "公众号",
         "status": "已发布", "planDate": "", "publishDate": d(-12), "link": "",
         "views": 3200, "likes": 180, "comments": 24, "collects": 60, "fansGain": 45,
         "note": "开头用了三个小故事"},
        {"id": "demo-c2", "title": "我是怎么整理学习笔记的", "accountId": "demo-ma3",
         "platform": "公众号", "status": "已发布", "planDate": "", "publishDate": d(-4),
         "link": "", "views": 5600, "likes": 260, "comments": 31, "collects": 90,
         "fansGain": 82, "note": "配了 4 张流程图"},
        {"id": "demo-c3", "title": "十月复盘", "accountId": "demo-ma2", "platform": "小红书",
         "status": "待发布", "planDate": d(3), "publishDate": "", "link": "",
         "views": 0, "likes": 0, "comments": 0, "collects": 0, "fansGain": 0,
         "note": "封面还没做"},
        {"id": "demo-c4", "title": "一个人住的收纳心得", "accountId": "demo-ma2",
         "platform": "小红书", "status": "撰写中", "planDate": "", "publishDate": "",
         "link": "", "views": 0, "likes": 0, "comments": 0, "collects": 0, "fansGain": 0,
         "note": "脚本写了一半点"},
        {"id": "demo-c5", "title": "每天学一小时，一年能走多远", "accountId": "demo-ma3",
         "platform": "公众号", "status": "待发布", "planDate": d(9), "publishDate": "",
         "link": "", "views": 0, "likes": 0, "comments": 0, "collects": 0, "fansGain": 0,
         "note": ""},
        {"id": "demo-c6", "title": "工具推荐：本地跑的效率面板", "accountId": "demo-ma1",
         "platform": "B站", "status": "想法", "planDate": "", "publishDate": "", "link": "",
         "views": 0, "likes": 0, "comments": 0, "collects": 0, "fansGain": 0,
         "note": "要录屏，先写个脚本"},
        {"id": "demo-c7", "title": "把手机相册清空的三个晚上", "accountId": "demo-ma1",
         "platform": "B站", "status": "已发布", "planDate": "", "publishDate": d(-9),
         "link": "", "views": 12000, "likes": 800, "comments": 120, "collects": 320,
         "fansGain": 210, "note": "评论里问备份方案的最多"},
        {"id": "demo-c8", "title": "我用 30 天把书房重做了一遍", "accountId": "demo-ma1",
         "platform": "B站", "status": "已发布", "planDate": "", "publishDate": d(-2),
         "link": "", "views": 43000, "likes": 2600, "comments": 380, "collects": 900,
         "fansGain": 640, "note": "这条明显跑出来了，第二条可以做成系列"},
        {"id": "demo-c9", "title": "宿舍桌面改造清单", "accountId": "demo-ma2",
         "platform": "小红书", "status": "已发布", "planDate": "", "publishDate": d(-6),
         "link": "", "views": 8300, "likes": 520, "comments": 96, "collects": 410,
         "fansGain": 130, "note": ""},
        {"id": "demo-c10", "title": "一个人住的第一年", "accountId": "demo-ma1",
         "platform": "B站", "status": "已发布", "planDate": "", "publishDate": d(-16),
         "link": "", "views": 2600, "likes": 140, "comments": 22, "collects": 70,
         "fansGain": 60, "note": ""},
        {"id": "demo-c11", "title": "早起的三个小办法", "accountId": "demo-ma2",
         "platform": "小红书", "status": "已发布", "planDate": "", "publishDate": d(-13),
         "link": "", "views": 1500, "likes": 90, "comments": 15, "collects": 60,
         "fansGain": 40, "note": ""},
        {"id": "demo-c12", "title": "为什么我开始自己做工具", "accountId": "demo-ma3",
         "platform": "公众号", "status": "已发布", "planDate": "", "publishDate": d(-20),
         "link": "", "views": 1800, "likes": 70, "comments": 12, "collects": 25,
         "fansGain": 20, "note": ""},
        {"id": "demo-c13", "title": "旧数据不用账号也能算", "platform": "知乎",
         "status": "想法", "planDate": "", "publishDate": "", "link": "",
         "views": 0, "likes": 0, "comments": 0, "collects": 0, "fansGain": 0, "note": ""},
    ]

    # 自媒体账号与粉丝快照：快照是「手动校正」的锚点，有它趋势才有真实起点
    media_accounts = [
        {"id": "demo-ma1", "name": "B站小李", "platform": "B站",
         "intro": "一个人做产品的过程记录", "baseFollowers": 1200,
         "targetFollowers": 5000, "note": "周更", "createdAt": "%s 09:00" % d(-40)},
        {"id": "demo-ma2", "name": "小红书小李", "platform": "小红书",
         "intro": "学习方法和收纳", "baseFollowers": 500,
         "targetFollowers": 2000, "note": "", "createdAt": "%s 09:00" % d(-30)},
        {"id": "demo-ma3", "name": "公众号：小李的工作台", "platform": "公众号",
         "intro": "长文，每月两三篇", "baseFollowers": 800,
         "targetFollowers": 3000, "note": "", "createdAt": "%s 09:00" % d(-60)},
    ]
    media_followers = [
        {"id": "demo-mf1", "accountId": "demo-ma1", "date": d(-7), "count": 1260},
        {"id": "demo-mf2", "accountId": "demo-ma2", "date": d(-2), "count": 720},
        {"id": "demo-mf3", "accountId": "demo-ma3", "date": d(-4), "count": 880},
    ]

    issues = [
        {"id": "demo-i1", "projectId": "demo-p1", "title": "切模块时输入框焦点丢了",
         "severity": "中", "status": "待处理"},
        {"id": "demo-i2", "projectId": "demo-p1", "title": "深色下月历圆点对比度偏低",
         "severity": "低", "status": "已解决"},
        {"id": "demo-i3", "projectId": "demo-p2", "title": "生词本没按词频排",
         "severity": "低", "status": "待处理"},
        {"id": "demo-i4", "projectId": "demo-p1", "title": "拖拽后偶尔留一个空占位",
         "severity": "高", "status": "已关闭"},
    ]

    progress = [
        {"id": "demo-g1", "projectId": "demo-p1", "date": d(-6), "text": "月历加了氛围底和卡片格子"},
        {"id": "demo-g2", "projectId": "demo-p2", "date": d(-5), "text": "精读做到 Unit 3"},
        {"id": "demo-g3", "projectId": "demo-p1", "date": d(-3), "text": "顺手把圆点换成低饱和那套"},
        {"id": "demo-g4", "projectId": "demo-p1", "date": d(-1), "text": "补了一遍自检，21 项全过"},
        {"id": "demo-g5", "projectId": "demo-p2", "date": d(0), "text": "整理了一份句型清单"},
        {"id": "demo-g6", "projectId": "demo-p1", "date": d(0), "text": "给演示准备了一份样例数据"},
    ]

    workout_logs = [
        {"id": "demo-w1", "date": d(-13), "moves": "深蹲 3×12 / 硬拉 3×8", "note": ""},
        {"id": "demo-w2", "date": d(-11), "moves": "跑步 5 km", "note": "配速 6'20\""},
        {"id": "demo-w3", "date": d(-9), "moves": "卧推 3×10 / 划船 3×12", "note": ""},
        {"id": "demo-w4", "date": d(-7), "moves": "跑步 6 km", "note": "有点晒"},
        {"id": "demo-w5", "date": d(-5), "moves": "深蹲 3×12 / 肩推 3×10", "note": ""},
        {"id": "demo-w6", "date": d(-3), "moves": "跑步 5 km", "note": "配速 6'10\""},
        {"id": "demo-w7", "date": d(-1), "moves": "引体 3×6 / 划船 3×12", "note": ""},
        {"id": "demo-w8", "date": d(0), "moves": "跑步 5 km", "note": "跑到后面轻松了点"},
    ]

    weight_plan = [
        (-21, 69.2, 19.0), (-18, 69.0, 18.8), (-14, 68.8, 18.6), (-11, 68.9, 18.5),
        (-7, 68.5, 18.3), (-4, 68.4, 18.2), (-1, 68.2, 18.1), (0, 68.1, 18.0),
    ]
    weights = [
        {"id": "demo-k%d" % i, "date": d(offset), "kg": kg, "bodyFat": fat}
        for i, (offset, kg, fat) in enumerate(weight_plan, start=1)
    ]

    meals = [
        {"id": "demo-m1", "date": d(0), "breakfast": "燕麦 + 牛奶 + 一个鸡蛋",
         "lunch": "食堂：番茄牛腩饭", "dinner": "家里做：清炒时蔬 + 米饭", "snack": "一个苹果"},
        {"id": "demo-m2", "date": d(-1), "breakfast": "豆浆 + 包子",
         "lunch": "昨天剩的菜", "dinner": "火锅", "snack": ""},
        {"id": "demo-m3", "date": d(-2), "breakfast": "面包 + 咖啡",
         "lunch": "沙拉", "dinner": "煮面", "snack": "坚果一小把"},
    ]
    water = [
        {"id": "demo-a1", "date": d(0), "cups": 6},
        {"id": "demo-a2", "date": d(-1), "cups": 5},
        {"id": "demo-a3", "date": d(-2), "cups": 7},
    ]

    games = [
        {"id": "demo-j1", "name": "塞尔达传说：王国之泪", "platform": "Switch",
         "status": "在玩", "progress": "主线第三章", "hours": 42},
        {"id": "demo-j2", "name": "空洞骑士：丝之歌", "platform": "PC",
         "status": "想玩", "progress": "", "hours": 0},
        {"id": "demo-j3", "name": "传送门 2", "platform": "PC",
         "status": "已通关", "progress": "单人剧情通关", "hours": 18},
        {"id": "demo-j4", "name": "某款肉鸽", "platform": "Switch",
         "status": "弃坑", "progress": "打到第二层就懒得练了", "hours": 6},
    ]

    accounts = [
        {"id": "demo-a1", "name": "微信", "initialBalanceCents": 0},
        {"id": "demo-a2", "name": "支付宝", "initialBalanceCents": 0},
        {"id": "demo-a3", "name": "现金", "initialBalanceCents": 0},
        {"id": "demo-a4", "name": "银行卡", "initialBalanceCents": 0},
    ]

    # 记账的日期按「本月几号」算，不按「今天偏移几」算：按偏移的话，
    # 月初跑就有半套账落到上个月去了，看着像没数据，也看不到超支的红边。
    last_day = (today.replace(day=1) + timedelta(days=32)).replace(day=1) - timedelta(days=1)

    def md(day: int) -> str:
        return today.replace(day=min(day, last_day.day)).isoformat()

    # 刻意让累计支出在中后段越过预算（¥3,200），这样月历上能看见几圈红边
    tx_plan = [
        (md(1), "expense", 220000, "住房", "demo-a4", "房租"),
        (md(2), "expense", 18600, "餐饮", "demo-a1", "超市"),
        (md(3), "expense", 10000, "交通", "demo-a2", "地铁月卡"),
        (md(4), "expense", 19900, "学习", "demo-a2", "网课"),
        (md(5), "expense", 2550, "餐饮", "demo-a1", "午饭 黄焖鸡"),
        (md(6), "expense", 6890, "购物", "demo-a1", "日用品"),
        (md(7), "expense", 12800, "餐饮", "demo-a1", "和朋友吃饭"),
        (md(9), "expense", 4500, "娱乐", "demo-a1", "电影票"),
        (md(10), "expense", 3200, "餐饮", "demo-a2", "外卖"),
        (md(11), "expense", 3680, "医疗", "demo-a4", "感冒药"),
        (md(13), "expense", 2200, "餐饮", "demo-a1", "午饭"),
        (md(15), "expense", 2800, "交通", "demo-a2", "打车"),
        (md(17), "expense", 29900, "购物", "demo-a2", "换季衣服"),
        (md(19), "expense", 2900, "餐饮", "demo-a1", "咖啡"),
        (md(21), "expense", 2550, "餐饮", "demo-a1", "午饭"),
        (d(0), "expense", 500, "交通", "demo-a2", "地铁"),
        (d(0), "expense", 3580, "购物", "demo-a1", "水果"),
        (md(23), "expense", 4500, "学习", "demo-a2", "一本书"),
        (md(25), "expense", 1500, "娱乐", "demo-a1", "视频会员"),
        (md(5), "income", 800000, "工资", "demo-a4", "月薪"),
        (md(12), "income", 120000, "兼职", "demo-a2", "帮人做了个小活"),
        (md(20), "income", 20000, "红包", "demo-a1", "朋友发的"),
    ]
    transactions = [
        {
            "id": "demo-tx%03d" % i,
            "type": kind,
            "amountCents": cents,
            "date": date_text,
            "category": category,
            "accountId": account,
            "note": note,
            "createdAt": "%s 12:00" % date_text,
        }
        for i, (date_text, kind, cents, category, account, note) in enumerate(tx_plan, start=1)
    ]

    debt_items = [
        {
            "id": "demo-d1", "name": "花呗", "type": "oweOthers", "totalCents": 350000,
            "creditor": "支付宝", "dueDate": md(20), "note": "每月 20 号还款",
            "status": "pending",
            # txId 留空：演示数据里没有对应的账目，界面会写「没有对应账目」
            "repayments": [{"date": md(1), "amountCents": 230000, "txId": ""}],
        },
        {
            "id": "demo-d2", "name": "借给同事的钱", "type": "othersOweMe", "totalCents": 80000,
            "creditor": "小张", "dueDate": d(25), "note": "说好下个月发工资还",
            "status": "pending", "repayments": [],
        },
        {
            "id": "demo-d3", "name": "去年借朋友的钱", "type": "oweOthers", "totalCents": 100000,
            "creditor": "老王", "dueDate": d(-40), "note": "已经还清了",
            "status": "done",
            "repayments": [{"date": d(-45), "amountCents": 100000, "txId": ""}],
        },
    ]

    return {
        "version": 1,
        "rev": 0,                                   # 真正写的时候会重算
        "createdAt": old.get("createdAt") or datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "updatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "tasks": tasks,
        "memo": "演示数据：随便改，改坏了再跑一次 演示数据.cmd 就有了。",
        "contents": contents,
        "projects": projects,
        "issues": issues,
        "progress": progress,
        "subjects": subjects,
        "studies": studies,
        "workoutLogs": workout_logs,
        "workoutPlan": {
            "周一": "深蹲 / 肩推", "周二": "跑步 5 km", "周三": "休息",
            "周四": "卧推 / 划船", "周五": "跑步 5 km", "周六": "引体 / 核心",
            "周日": "休息或散步",
        },
        "weights": weights,
        "meals": meals,
        "water": water,
        "games": games,
        "mediaAccounts": media_accounts,
        "mediaFollowers": media_followers,
        "finance": {
            "accounts": accounts,
            "categories": {
                "expense": ["餐饮", "交通", "购物", "学习", "娱乐", "住房", "医疗", "其他"],
                "income": ["工资", "兼职", "红包", "退款", "其他"],
            },
            "transactions": transactions,
            "budget": {"monthlyTotalCents": 320000, "categoryCents": {}},
            "transfers": [],
        },
        "debt": {"items": debt_items},
        "settings": settings,                       # 你选的皮肤 / 明暗一律保留
        "trash": old.get("trash") or [],            # 回收站也原样留着
    }


# --------------------------------------------------------------------------
# 三个动作
# --------------------------------------------------------------------------

def do_status(data_dir: str) -> None:
    data = read_json(data_file_of(data_dir))
    print("  数据目录：%s" % data_dir)
    if data is None:
        print("  这里还没有 数据.json（第一次启动小李时会自动生成）。")
        return
    print_counts("现在有的是：", data)
    marker = read_marker(data_dir)
    if marker:
        print("  当前是演示数据（载入时间 / 快照：%s）" % marker.replace("\n", " / "))
    else:
        print("  当前不是演示数据。")


def do_load(data_dir: str, assume_yes: bool) -> None:
    os.makedirs(backup_dir_of(data_dir), exist_ok=True)
    existing = read_json(data_file_of(data_dir))
    marked = read_marker(data_dir)
    needs_snapshot = existing is not None and has_content(existing) and not marked

    # 上一次载入时记下的那份快照，这次接着用：重复载入不会把它忘掉
    earlier_snapshot = None
    if marked:
        lines = marked.split("\n")
        earlier_snapshot = lines[1].strip() if len(lines) > 1 and lines[1].strip() else None

    if needs_snapshot:
        print_counts("现在这份数据里有：", existing)
        print()
        print("  载入示例数据会把上面这些临时换成一套演示数据（你原来的东西会")
        print("  先存进 备份\\保留-演示前-*.json，随时能还原）。")
        if not assume_yes:
            try:
                answer = input("  确认请输入「演示」，直接回车取消：").strip()
            except EOFError:
                answer = ""
            if answer != "演示":
                print("  已取消，什么都没动。")
                return

    snapshot = None
    if needs_snapshot:
        snapshot = "%s%s.json" % (SNAPSHOT_PREFIX, time_stamp())
        shutil.copyfile(data_file_of(data_dir), os.path.join(backup_dir_of(data_dir), snapshot))
        print("  你原来的数据已备份成：%s" % snapshot)

    payload = demo_data(existing)
    how = apply_data(data_dir, payload)
    write_marker(data_dir, snapshot or earlier_snapshot)

    print("  已载入示例数据（%s）。" % how)
    print_counts("现在是：", payload)
    print()
    print("  界面开着的话按 F5 刷新一下。想还原就再双击 演示数据.cmd 选 2，")
    print("  或者到「数据与设置 → 导入恢复」里拿上面那份 保留-演示前-*.json。")


def do_restore(data_dir: str) -> None:
    backups = backup_dir_of(data_dir)
    target = None
    marker = read_marker(data_dir)
    if marker:
        lines = marker.split("\n")
        if len(lines) > 1 and lines[1].strip():
            candidate = os.path.join(backups, lines[1].strip())
            if os.path.exists(candidate):
                target = candidate
    if target is None and os.path.isdir(backups):
        names = sorted(
            (n for n in os.listdir(backups)
             if n.startswith(SNAPSHOT_PREFIX) and n.endswith(".json")),
            key=lambda n: os.path.getmtime(os.path.join(backups, n)),
            reverse=True,
        )
        if names:
            target = os.path.join(backups, names[0])
    if target is None:
        print("  没找到「载入演示数据之前」的快照，没什么可还原的。")
        print("  （备份目录里以 %s 开头的文件才会被认出来。）" % SNAPSHOT_PREFIX)
        return

    payload = read_json(target)
    if payload is None:
        raise SystemExit("  快照读不出来：%s" % target)
    how = apply_data(data_dir, payload)
    clear_marker(data_dir)
    print("  已还原：%s" % os.path.basename(target))
    print("  （%s）" % how)
    print_counts("现在是：", payload)
    print("  界面开着的话按 F5 刷新一下。")


def main() -> int:
    setup_console()
    parser = argparse.ArgumentParser(description="小李 · 演示数据")
    parser.add_argument("--action", choices=("load", "restore", "status"), default="load",
                        help="load 载入演示数据 / restore 还原 / status 只看一眼")
    parser.add_argument("--data-dir", default=None,
                        help="指定数据目录（默认：这份代码自己的 数据\\）")
    parser.add_argument("--running", action="store_true",
                        help="指到「现在开着的那个小李」的数据目录")
    parser.add_argument("--yes", action="store_true", help="不问那一句，直接载入")
    args = parser.parse_args()

    data_dir = data_dir_of(args.data_dir, args.running)
    print("=" * 60)
    print("  小李 · 演示数据")
    print("=" * 60)
    print("  数据目录：%s" % data_dir)
    print("-" * 60)

    if args.action == "status":
        do_status(data_dir)
    elif args.action == "restore":
        do_restore(data_dir)
    else:
        do_load(data_dir, args.yes)
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

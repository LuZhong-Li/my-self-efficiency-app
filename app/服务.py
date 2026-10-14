# -*- coding: utf-8 -*-
"""小李 · 本机小服务（v1）

只用 Python 标准库，不装任何第三方包。

它做五件事：
  1. 在本机 127.0.0.1 上起一个小服务，只有你自己的浏览器能访问；
  2. 把 app/web/ 里的界面发给浏览器；
  3. 全部数据存成一个 JSON 文件：数据\\数据.json；
  4. 写入用「先写临时文件、再整体替换」，断电也不会写坏；
  5. 每天第一次启动自动备份一份，只保留最近若干份。

用法：双击项目目录里的 启动.cmd
"""

from __future__ import annotations

import base64
import json
import email.utils
import mimetypes
import os
import shutil
import socket
import sys
import threading
import time
import uuid
import urllib.parse
import webbrowser
import http.client
import zipfile
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_NAME = "小李"
APP_VERSION = "v2.0"

# HTTP 响应头只能是 latin-1，所以「给程序看的」版本号必须保持纯 ASCII。
# 注意：不要把这个变量改成带中文/全角字符的值，否则每个请求都会 500。
SERVER_TOKEN = "XiaoLi/1.0"

# 项目目录就是这个文件的上上级（比如 D:\小李）
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(BASE_DIR, "app", "web")
# 数据放哪儿，两种用法：
#   1) 「一份数据一个文件夹，界面上换着用」（多数据集）—— 默认就是这一种。
#      根目录 = 环境变量 XIAOLI_DATA_ROOT，默认 BASE_DIR\数据；
#      里面一套数据一个子文件夹（默认\、工作\…），现在用哪一份记在 当前数据集.txt。
#   2) 「就是这一份，别管别人」—— 设 XIAOLI_DATA_DIR，指哪用哪，数据集功能整个关掉。
#      自检脚本、演示数据、以及自己把数据挪到别的盘的情况都走这一种。
ENV_DIR = os.environ.get("XIAOLI_DATA_DIR")
DATA_ROOT = os.path.abspath(os.environ.get("XIAOLI_DATA_ROOT")
                            or os.path.join(BASE_DIR, "数据"))
DATASETS_ENABLED = not ENV_DIR
DEFAULT_DATASET = "默认"
CURRENT_FILE = os.path.join(DATA_ROOT, "当前数据集.txt")

# 数据集名字的规则。和前端 app/web/dataset-calc.js 那份必须一模一样
# （tests\自检.py 里有一条盯着三张表对不对得上）。
DATASET_NAME_MAX = 24
DATASET_BAD_CHARS = '\\/:*?"<>|'
DATASET_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}

# 下面九个路径全都按「当前那份数据的目录」算，derive_paths() 是唯一的入口。
# 启动和运行期切换都走它 —— 换了一半（数据文件换了、附件目录没换）是最难查的那种错。
DATA_DIR = ""
DATA_FILE = ""
BACKUP_DIR = ""
EXPORT_DIR = ""
LOG_DIR = ""
LOG_FILE = ""
PREV_FILE = ""
LOCK_FILE = ""
ATTACH_DIR = ""
CURRENT_DATASET = ""     # 关掉数据集功能时是空串（health 里也这么报）


def derive_paths(data_dir: str) -> None:
    """把上面九个路径整体指向这个目录。派生规则只有这一份。"""
    global DATA_DIR, DATA_FILE, BACKUP_DIR, EXPORT_DIR, LOG_DIR, LOG_FILE
    global PREV_FILE, LOCK_FILE, ATTACH_DIR
    DATA_DIR = data_dir
    DATA_FILE = os.path.join(DATA_DIR, "数据.json")
    BACKUP_DIR = os.path.join(DATA_DIR, "备份")
    EXPORT_DIR = os.path.join(DATA_DIR, "导出")
    LOG_DIR = os.path.join(DATA_DIR, "日志")
    LOG_FILE = os.path.join(LOG_DIR, "运行.log")
    PREV_FILE = os.path.join(BACKUP_DIR, "_最近一次.json")
    LOCK_FILE = os.path.join(DATA_DIR, "数据.lock")
    ATTACH_DIR = os.path.join(DATA_DIR, "attachments")


# 写入闸：同一时间只让一个进程写 数据.json。写的时候在数据目录里放一个标记文件，
# 写完删掉；被别人拿着的期间，另外那份的保存会被挡回去（不覆盖）。
# 上次崩在写盘中途会留下残留，超过 LOCK_STALE_SECONDS 就当过期，清掉重来。
LOCK_STALE_SECONDS = 10
# 图片附件：单独一个文件夹，主数据文件里只存相对路径（attachments/模块/文件名）。
# 放在数据目录下面是有意的——备份、整个搬到别的盘都是一整份走，
# 而且 同步到小李.cmd / .gitignore 本来就不碰 数据 目录，图片不会跟着代码跑。
# 附件按模块分格；加新模块往这里补一个名字，前端 attachment-calc.js 也要跟着加
ATTACH_MODULES = (
    "finance", "buglog", "progress",
    "today_plan", "dev_project", "dev_todo", "study_record", "study_item",
    "fitness", "game", "game_record",
    "note", "media_asset",
)
ATTACH_EXTS = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}
# 服务端兜底的单张上限：前端压完一般远小于这个数，这道闸是防手写的请求
ATTACH_MAX_BYTES = 12 * 1024 * 1024

# 备份文件名以这个开头 = 标了「长期保留」，自动清理时跳过
KEEP_PREFIX = "保留-"

DEFAULT_PORT = 8765
PORT_TRIES = 12
DEFAULT_BACKUP_KEEP = 14
MAX_BODY = 32 * 1024 * 1024

LOCK = threading.Lock()

# 首页摘要和自检要数的表
COUNT_KEYS = [
    ("tasks", "任务"),
    ("contents", "自媒体内容"),
    ("mediaAccounts", "自媒体账号"),
    ("projects", "开发项目"),
    ("issues", "问题/bug"),
    ("subjects", "学习对象"),
    ("studies", "学习记录"),
    ("workoutLogs", "训练打卡"),
    ("weights", "体重记录"),
    ("meals", "饮食记录"),
    ("water", "饮水记录"),
    ("games", "游戏"),
    ("gameRecords", "游玩记录"),
    ("finance.transactions", "账目"),
    ("debt.items", "债务"),
    ("notes", "笔记"),
]


# --------------------------------------------------------------------------
# 数据文件
# --------------------------------------------------------------------------

def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log_line(text: str) -> None:
    """往 数据\\日志\\运行.log 追加一行。只记要紧的事，不记每次保存。
    日志超过 1MB 就轮换一次（改名成 运行.log.1），免得无限长大。"""
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 1024 * 1024:
            os.replace(LOG_FILE, LOG_FILE + ".1")
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write("%s  %s\n" % (now_text(), text))
    except OSError:
        pass


def default_finance() -> dict:
    """记账（第 10 个模块）的空骨架。

    transfers / budget.categoryCents / accounts[].initialBalanceCents 这个版本
    先建着不用——第二版做账户余额、转账、分类预算时不用再迁数据。
    """
    return {
        "accounts": [],
        "categories": {
            "expense": ["餐饮", "交通", "购物", "学习", "娱乐", "住房", "医疗", "其他"],
            "income": ["工资", "兼职", "红包", "退款", "其他"],
        },
        "transactions": [],
        "budget": {"monthlyTotalCents": 0, "categoryCents": {}},
        "transfers": [],
        "templates": [],
    }


def default_debt() -> dict:
    """债务欠款的空骨架（和 finance 并列的一个顶层键）。"""
    return {"items": []}


# 记账里这两个分类跟着债务一起加：还款算支出、别人还钱算收入
DEBT_CATEGORIES = {"expense": "债务还款", "income": "债务收款"}


def default_data() -> dict:
    """第一次运行时用的空数据骨架，字段与设计文档第 5 节一致。"""
    return {
        "version": 1,
        "rev": 0,          # 修订号：每写一次加一，用来挡「两个窗口互相覆盖」
        "createdAt": now_text(),
        "tasks": [],
        "memo": "",
        "contents": [],
        # 自媒体：账号 + 粉丝快照（作品还是上面那个 contents，不搬家）
        "mediaAccounts": [],
        "mediaFollowers": [],
        # 自媒体素材：脚本 / 封面 / 参考链接（图片走 attachments/media_asset/，链接存 url）
        # 素材库（2026-10-14 升级成全站共用）：图片 / 链接 / 文本片段三种，
        # 各模块记录只存素材 id（assetIds）。老的 mediaAssets 会在读的时候并进来（见 normalize_data）
        "assets": [],
        # 老表留着（搬家会把它的内容并进 assets 并清空它），免得老数据读进来时没地方认
        "mediaAssets": [],
        "projects": [],
        "issues": [],
        "progress": [],
        # 工时：开发工作底下「哪天在哪个项目上花了多久」（2026-10-14 新增）
        "workLogs": [],
        "subjects": [],   # 学习对象：书 / 课程 / 视频 / 技能
        "studies": [],    # 学习记录：哪天、学什么、多久、心得
        # 模块目标：健身 / 学习 / 饮食三个模块的长期目标，按模块 id 分桶（见 migrate）
        "moduleGoals": {},
        "workoutLogs": [],
        "workoutPlan": {
            "周一": "", "周二": "", "周三": "", "周四": "",
            "周五": "", "周六": "", "周日": "",
        },
        "weights": [],
        "meals": [],
        # 菜谱库：一样东西每份多少热量 / 蛋白 / 脂肪 / 碳水（2026-10-14 新增；
        # 「今天吃了什么」挂在 meals 那条的 items 上，不另开一张表）
        "foods": [],
        # 笔记：第 11 个模块，一篇一条（body 存 Markdown 源码，不存渲染后的 HTML）
        "notes": [],
        "water": [],
        "games": [],
        # 游玩记录：玩一次记一条（哪天、哪款游戏、多久、什么感受），
        # 游戏清单上那个「累计 X 小时」就是这张表加出来的
        "gameRecords": [],
        "finance": default_finance(),
        "debt": default_debt(),
        "settings": {
            "theme": "light",
            # 明暗策略：light / dark / system（跟随系统）。theme 只记当前实际明暗，兼容老版本
            "themeMode": "light",
            # 今日计划里要不要露一条「今天的游玩记录」（游戏娱乐 → 今日计划，可关）
            "planShowGame": False,
            "backupKeep": DEFAULT_BACKUP_KEEP,
            # 图片附件：彻底删掉一条记录时，要不要连它的图片一起删（默认保留，删错了还能找回来）
            "attachments": {"pruneOnDelete": False, "maxEdge": 1920},
            "selfTest": {"saveCount": 0, "lastSavedAt": None},
        },
    }


def ensure_dirs() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(BACKUP_DIR, exist_ok=True)
    os.makedirs(ATTACH_DIR, exist_ok=True)


# --------------------------------------------------------------------------
# 数据集（多套数据文件）：一个数据集 = 一个文件夹
# --------------------------------------------------------------------------

class DatasetError(Exception):
    """名字不合规 / 没有这份数据集 —— 都是「用户改一下就能过」的错，回 400。"""


class DatasetBusy(Exception):
    """正有人在写盘 —— 和写入闸一个口径，回 409 让前端说「稍后重试」。"""


def dataset_dir(name: str) -> str:
    return os.path.join(DATA_ROOT, name)


def check_dataset_name(name: str, existing) -> str:
    """名字合不合规：通过给空串，不通过给一句中文原因。

    和前端 app/web/dataset-calc.js 的 checkDatasetName 是同一套规则、同一批文案：
    服务端这份是权威（真拦），前端那份只为了当场把按钮灰掉 + 说清为什么。
    调用方负责先去首尾空格（两边都这样，免得「尾部空格」在两边的表现不一样）。
    """
    if not name:
        return "得给这份数据起个名字"
    if len(name) > DATASET_NAME_MAX:
        return "名字最多 %d 个字" % DATASET_NAME_MAX
    for ch in name:
        if ch in DATASET_BAD_CHARS:
            return "名字里不能有 \\ / : * ? \" < > |"
        if ord(ch) < 32:
            return "名字里不能有控制字符"
    if name == "." or name == ".." or name.startswith("."):
        return "名字不能以点开头"
    if name.endswith("."):
        return "名字不能以点结尾"
    if name.lower() in DATASET_RESERVED:
        return "「%s」是系统保留的名字" % name
    if name in (existing or []):
        return "已经有一份叫「%s」的了" % name
    return ""


def dataset_names() -> list[str]:
    """根目录下的数据集：认文件夹，跳过点开头的（隐藏 / 临时）、跳过名字不合规的。"""
    out = []
    try:
        entries = os.listdir(DATA_ROOT)
    except OSError:
        return out
    for name in entries:
        if name.startswith(".") or not os.path.isdir(dataset_dir(name)):
            continue
        if check_dataset_name(name, []):     # 手建的怪名字当没看见，别让它进列表
            continue
        out.append(name)
    return sorted(out)


def read_current_dataset() -> str:
    """现在用哪一份。文件读不到、写坏了、记的那份不在了 —— 一律兜回「默认」。

    它写成纯文本就是为了「坏得起」：出什么岔子都还能起来，也还能拿记事本改。
    """
    name = ""
    try:
        with open(CURRENT_FILE, "r", encoding="utf-8") as f:
            name = f.read().strip()
    except OSError:
        name = ""
    if name and not check_dataset_name(name, []) and os.path.isdir(dataset_dir(name)):
        return name
    if name:
        log_line("当前数据集「%s」找不到了，这次按默认来" % name)
    return DEFAULT_DATASET


def write_current_dataset(name: str) -> None:
    """「现在用哪一份」先落盘再换路径：这个文件是权威，崩了下次也切过去了。"""
    os.makedirs(DATA_ROOT, exist_ok=True)
    with open(CURRENT_FILE, "w", encoding="utf-8") as f:
        f.write(name + "\n")


def migrate_legacy_layout() -> list[str]:
    """老布局（数据直接躺在根目录下）一次性搬进 默认\\，返回搬了哪几样。

    只在「根目录下有 数据.json」且「默认\\ 还没有数据」时动手。一样一样搬：
    同一个盘里是改名不是复制，秒完、不多占空间；中途失败也只是没搬完，东西都还在原处。
    内容一个字都不动（不读、不改、不重新序列化），所以 rev 和文件修改时间都是搬之前那样。
    """
    if not os.path.exists(os.path.join(DATA_ROOT, "数据.json")):
        return []
    if os.path.exists(os.path.join(dataset_dir(DEFAULT_DATASET), "数据.json")):
        return []
    target = dataset_dir(DEFAULT_DATASET)
    os.makedirs(target, exist_ok=True)
    moved = []
    for name in sorted(os.listdir(DATA_ROOT)):
        if name == DEFAULT_DATASET or name == os.path.basename(CURRENT_FILE):
            continue
        try:
            shutil.move(os.path.join(DATA_ROOT, name), os.path.join(target, name))
            moved.append(name)
        except OSError as exc:
            print("  ! 搬迁「%s」没成功（%s）：它还在原处，不影响用" % (name, exc))
    if moved:
        write_current_dataset(DEFAULT_DATASET)
    return moved


def boot_paths() -> None:
    """启动时定下「当前是哪一份、九个路径指向哪儿」。"""
    global CURRENT_DATASET
    if not DATASETS_ENABLED:
        # 老变量：就是这一份，数据集功能整体关掉
        CURRENT_DATASET = ""
        derive_paths(os.path.abspath(ENV_DIR))
        return
    moved = migrate_legacy_layout()
    CURRENT_DATASET = read_current_dataset()
    derive_paths(dataset_dir(CURRENT_DATASET))
    if moved:
        log_line("老布局搬进 %s\\：%s" % (DEFAULT_DATASET, "、".join(moved)))
        print("  已把老布局的数据搬进 %s\\（%s）—— 内容一个字没动"
              % (DEFAULT_DATASET, "、".join(moved)))


def dataset_info(name: str) -> dict:
    """列表里那一行：多少条、多大、什么时候动过。

    读**别的**数据集只读那一份原始 JSON：不跑 migrate、不写盘 ——
    看一眼列表不该改动别人的数据。
    """
    file = os.path.join(dataset_dir(name), "数据.json")
    info = {
        "name": name, "current": name == CURRENT_DATASET, "dataFile": file,
        "bytes": 0, "rev": 0, "count": 0, "counts": {}, "updatedAt": "", "mtime": 0,
        "bad": False,
    }
    if not os.path.exists(file):
        return info
    try:
        with open(file, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            raise ValueError("不是一份数据")
    except Exception:
        info["bad"] = True     # 读不出来就如实说，不拿「0 条」糊弄人
        return info
    counts = dict(summarize(raw))
    info.update(
        bytes=os.path.getsize(file), rev=int(raw.get("rev") or 0),
        counts=counts, count=sum(counts.values()),
        updatedAt=str(raw.get("updatedAt") or ""), mtime=os.path.getmtime(file),
    )
    return info


def list_datasets() -> dict:
    if not DATASETS_ENABLED:
        return {"ok": True, "enabled": False, "current": "", "root": "", "items": []}
    return {
        "ok": True, "enabled": True, "current": CURRENT_DATASET, "root": DATA_ROOT,
        "items": [dataset_info(n) for n in dataset_names()],
    }


boot_paths()


# --------------------------------------------------------------------------
# 写入闸：多窗口 / 多进程同时写 数据.json 时，别互相覆盖
# --------------------------------------------------------------------------

class DataBusy(Exception):
    """别人正拿着写入闸，这次写盘要排队"""


def _lock_is_stale() -> bool:
    """锁文件是不是「过期」了：上次崩在写盘中途留下的残留，超过 10 秒就不认它。"""
    try:
        return time.time() - os.path.getmtime(LOCK_FILE) > LOCK_STALE_SECONDS
    except OSError:
        return False


def release_write_lock() -> None:
    """放开写入闸（删掉标记文件）；本来就没有也不报错。"""
    try:
        os.remove(LOCK_FILE)
    except OSError:
        pass


def _make_lock() -> bool:
    """建标记文件。O_CREAT|O_EXCL 的规矩是「谁先建出来谁说了算」，跨进程也管用。"""
    try:
        fd = os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    except OSError:
        # 因为权限之类根本建不出这个文件时，别硬拦：放过去写，总比整个存不了强
        return True
    try:
        os.write(fd, ("%d %s" % (os.getpid(), now_text())).encode("utf-8"))
    finally:
        os.close(fd)
    return True


def acquire_write_lock() -> None:
    """占住写入闸。已经有人拿着时，那把锁要是过期了就清掉再抢一次；
    还抢不到，就抛 DataBusy，让接口回一句「文件正在保存，请稍后重试」。"""
    ensure_dirs()
    if _make_lock():
        return
    if _lock_is_stale():
        log_line("发现过期的写入锁，清掉重来（%s）" % os.path.basename(LOCK_FILE))
        release_write_lock()
        if _make_lock():
            return
    raise DataBusy()


def clear_stale_lock() -> None:
    """启动时清一次：上次崩在写盘中途留下的锁不该挡着这次。
    只在过期时清，免得把另一个进程正在写的那一次误删。"""
    if os.path.exists(LOCK_FILE) and _lock_is_stale():
        release_write_lock()
        log_line("启动时清理了过期的写入锁")


# --------------------------------------------------------------------------
# 图片附件（文件在 数据\attachments\，JSON 里只存相对路径）
# --------------------------------------------------------------------------

def attach_ext(value: str) -> str:
    """把「文件名」或「mime」都归一成白名单里的扩展名；认不出给空串。
    收得了的只有 png / jpg / webp —— 和前端 <input accept> 那一行对齐。"""
    text = str(value or "").strip().lower()
    if "/" in text:                    # 传进来的是 image/jpeg 这种 mime
        text = text.rsplit("/", 1)[-1]
    if "." in text:                    # 传进来的是 小票.PNG 这种文件名
        text = text.rsplit(".", 1)[-1]
    if text == "jpeg":
        text = "jpg"
    return text if text in ATTACH_EXTS else ""


def attach_parse(path: str) -> tuple[str, str] | None:
    """解析 JSON 里存的那条相对路径，顺带把「不能当文件路径用」的挡在外面。

    外面递进来的字符串一律按不可信处理：目录必须是 attachments、模块必须在
    白名单里、文件名必须长成 yyyyMMdd_随机.扩展名，所以
    `attachments/finance/../../数据.json` 这种一定过不了这一关。
    """
    text = urllib.parse.unquote(str(path or "")).replace("\\", "/").strip()
    parts = text.split("/")
    if len(parts) != 3:
        return None
    root, module, name = parts
    if root != "attachments" or module not in ATTACH_MODULES:
        return None
    stem, dot, ext = name.rpartition(".")
    if not dot or ext.lower() not in ("png", "jpg", "jpeg", "webp"):
        return None
    head, sep, tail = stem.partition("_")
    if not sep or len(head) != 8 or not head.isdigit():
        return None
    if not (4 <= len(tail) <= 32) or not tail.isalnum() or not tail.isascii():
        return None
    return module, name


def unique_attach_name(module: str, ext: str) -> str:
    """日期 + 随机串：文件夹里按天挨着排，随机串保证不会撞名。"""
    stamp = datetime.now().strftime("%Y%m%d")
    folder = os.path.join(ATTACH_DIR, module)
    for _ in range(50):
        name = "%s_%s.%s" % (stamp, uuid.uuid4().hex[:8], ext)
        if not os.path.exists(os.path.join(folder, name)):
            return name
    # 理论上到不了这儿（8 位十六进制撞 50 次）；真撞上了就加长再来一次
    return "%s_%s.%s" % (stamp, uuid.uuid4().hex[:16], ext)


def write_attachment(module: str, ext: str, raw: bytes) -> tuple[str, str]:
    """把一张图落盘，返回 (相对路径, 文件名)。先写 .tmp 再整体替换，和 数据.json 一个规矩。"""
    folder = os.path.join(ATTACH_DIR, module)
    os.makedirs(folder, exist_ok=True)
    name = unique_attach_name(module, ext)
    target = os.path.join(folder, name)
    tmp = target + ".tmp"
    with open(tmp, "wb") as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, target)
    return "attachments/%s/%s" % (module, name), name


def attachments_stat() -> tuple[int, int]:
    """附件一共多少张、占多少字节（设置页显示用）。"""
    count = 0
    total = 0
    for root, _dirs, files in os.walk(ATTACH_DIR):
        for name in files:
            if name.endswith(".tmp"):
                continue
            try:
                total += os.path.getsize(os.path.join(root, name))
                count += 1
            except OSError:
                pass
    return count, total


def atomic_write_json(path: str, obj: object) -> None:
    """先写临时文件、刷盘、再整体替换，避免写一半断电弄坏数据。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def load_data() -> dict:
    ensure_dirs()
    if not os.path.exists(DATA_FILE):
        data = default_data()
        atomic_write_json(DATA_FILE, data)
        return data
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        return migrate(json.load(f))


def migrate(data: dict) -> dict:
    """老版本里这块叫「咨询工作」（clients / consults），现在叫「学习工作」
    （subjects / studies）。老键还在、新键还没有时搬一次，搬完把老键删掉；
    字段名不对应的部分按意思就近映射，宁可留着也别丢。"""
    # 多窗口防覆盖那两道闸全靠顶层这两个字段：
    #   version —— 数据格式版本，保存接口拿它认「这是不是本程序的数据」；
    #   rev     —— 修订号，页面读的时候是多少、写回来就必须是多少，对不上就说明
    #              另一个窗口先改过了，这一次写入要拒掉（不覆盖别人的改动）。
    # 手写的、或者拿一份老备份直接盖回 数据.json 的，可能两个都没有。这里补齐：
    # rev 尤其不能空着 —— 页面读不到数字就带不回修订号，那道校验会被悄悄绕过，
    # 于是又回到「后保存的把先保存的覆盖掉」那个丢数据的 bug。
    if "version" not in data:
        data["version"] = 1
    if not isinstance(data.get("rev"), int):
        data["rev"] = 0
    if "clients" in data and "subjects" not in data:
        data["subjects"] = [
            {
                "id": c.get("id"),
                "name": c.get("name", ""),
                "kind": "其它",
                "source": c.get("contact", ""),
                "note": c.get("note", ""),
            }
            for c in (data.get("clients") or [])
        ]
        data.pop("clients", None)
    if "consults" in data and "studies" not in data:
        data["studies"] = [
            {
                "id": c.get("id"),
                "subjectId": c.get("clientId"),
                "date": c.get("date", ""),
                "minutes": c.get("minutes", 0),
                "content": c.get("topic", ""),
                "takeaway": c.get("conclusion", ""),
                "reviewed": bool(c.get("paid")),
            }
            for c in (data.get("consults") or [])
        ]
        data.pop("consults", None)
    if not isinstance(data.get("finance"), dict):
        data["finance"] = default_finance()
    else:
        # 骨架里以后要是加了新键（比如第二版的 transfers），老数据也能补齐
        for key, value in default_finance().items():
            if key not in data["finance"]:
                data["finance"][key] = value
    # 转账（2026-10-12 新增）：两个账户之间挪钱，单独一张 finance.transfers。
    # 键本身上面那段「缺键就补骨架」已经兜住了；这里管两件事：
    # ① 键在但不是数组（手改过）→ 给一个空数组；② 数组里每行缺的字段补齐，
    # 已有值一个都不动（金额取绝对值再取整，防手滑写成负数或带小数）。
    transfers = (data.get("finance") or {}).get("transfers")
    if not isinstance(transfers, list):
        transfers = []
    fixed_transfers = []
    for row in transfers:
        if not isinstance(row, dict):
            continue
        row.setdefault("id", "tf-" + uuid.uuid4().hex[:8])
        try:
            row["amountCents"] = abs(int(row.get("amountCents") or 0))
        except (TypeError, ValueError):
            row["amountCents"] = 0
        for key in ("date", "fromAccountId", "toAccountId", "note", "createdAt"):
            row.setdefault(key, "")
        if not isinstance(row.get("imagePaths"), list):
            row["imagePaths"] = []
        fixed_transfers.append(row)
    data["finance"]["transfers"] = fixed_transfers
    if not isinstance(data.get("debt"), dict) or not isinstance(data["debt"].get("items"), list):
        data["debt"] = default_debt()
    # 两个债务分类也要给老数据补上（缺了才加，有了不动）
    cats = data.setdefault("finance", {}).setdefault("categories", {})
    for kind, name in DEBT_CATEGORIES.items():
        bucket = cats.setdefault(kind, [])
        if name not in bucket:
            bucket.append(name)
    # 自媒体：账号表和粉丝快照表是后加的，老数据补两张空表就行
    if not isinstance(data.get("mediaAccounts"), list):
        data["mediaAccounts"] = []
    if not isinstance(data.get("mediaFollowers"), list):
        data["mediaFollowers"] = []
    # 模块目标（2026-10-07 新增）：顶层一个 moduleGoals，按模块 id 分桶存数组。
    # 老数据没有这个键就补一个空对象；万一手写成了数组，按 moduleId 归成桶，一条都不丢。
    raw_goals = data.get("moduleGoals")
    if isinstance(raw_goals, list):
        buckets: dict = {}
        for goal in raw_goals:
            if isinstance(goal, dict) and goal.get("moduleId"):
                buckets.setdefault(goal["moduleId"], []).append(goal)
        data["moduleGoals"] = buckets
    elif not isinstance(raw_goals, dict):
        data["moduleGoals"] = {}
    # 每条目标的字段补齐（缺的给默认值，已有的一个不动）
    for module_id, bucket in data["moduleGoals"].items():
        rows = bucket if isinstance(bucket, list) else [bucket]
        fixed = []
        for goal in rows:
            if not isinstance(goal, dict):
                continue
            goal.setdefault("id", "goal-" + uuid.uuid4().hex[:8])
            goal.setdefault("moduleId", module_id)
            for key in ("moduleName", "mainTarget", "dailyRule", "remark",
                        "startDate", "endDate", "lastRun"):
                goal.setdefault(key, "")
            goal.setdefault("cycle", "每日")
            goal.setdefault("isActive", True)
            goal.setdefault("autoTask", True)
            fixed.append(goal)
        data["moduleGoals"][module_id] = fixed
    # 自媒体状态改过名：老的「写作中」并进新流水线的「撰写中」
    # （新流水线是 想法 → 撰写中 → 剪辑中 → 待发布 → 已发布）
    for c in data.get("contents") or []:
        if isinstance(c, dict) and c.get("status") == "写作中":
            c["status"] = "撰写中"
        # 素材引用（2026-10-14 新增）：老作品没有 assetIds，读出来补一个空数组，
        # 页面那边就不用到处判空；只补缺的，已有的（字符串）原样留着、顺手滤掉杂物。
        if isinstance(c, dict):
            if not isinstance(c.get("assetIds"), list):
                c["assetIds"] = []
            else:
                c["assetIds"] = [
                    x for x in c["assetIds"] if isinstance(x, str) and x.strip()
                ]
    # 图片附件：老记录没有 imagePaths，读出来先补一个空数组，
    # 页面那边就不用到处判空了；也只是补，不动任何已有字段。
    for row in (data.get("finance") or {}).get("transactions") or []:
        if isinstance(row, dict) and not isinstance(row.get("imagePaths"), list):
            row["imagePaths"] = []
    # bug 条目：图片、详细描述、关联模块、创建/修复时间都是后加的，老记录补齐；
    # 状态 2026-10-07 改过名（处理中 → 进行中、已解决 → 已修复，中间补了「已复现」），
    # 读出来一起搬，页面那边就只用一套口径。
    for row in data.get("issues") or []:
        if not isinstance(row, dict):
            continue
        if not isinstance(row.get("imagePaths"), list):
            row["imagePaths"] = []
        for key in ("desc", "module", "createdAt", "fixedAt", "archivedAt"):
            row.setdefault(key, "")
        # 归档标记（2026-10-08 加的）：老条目一律当没归档，数据一条都不动
        row.setdefault("isArchived", False)
        if row.get("status") == "处理中":
            row["status"] = "进行中"
        elif row.get("status") == "已解决":
            row["status"] = "已修复"
    # 进展条目：也是后加的图片字段
    for row in data.get("progress") or []:
        if isinstance(row, dict) and not isinstance(row.get("imagePaths"), list):
            row["imagePaths"] = []
    # 工时（2026-10-14 新增）：老数据没有这个键就补一张空表；有的逐条补齐字段。
    # 只补不改：分钟和备注一个字都不动（分钟的取整是前端 work-calc.js 的事）。
    if not isinstance(data.get("workLogs"), list):
        data["workLogs"] = []
    for row in data["workLogs"]:
        if not isinstance(row, dict):
            continue
        if not row.get("id"):
            row["id"] = "w-" + uuid.uuid4().hex[:8]
        for key in ("date", "projectId", "note", "createdAt"):
            row.setdefault(key, "")
        row.setdefault("minutes", 0)
    # 热量营养（2026-10-14 新增）：菜谱库 + 每餐的「吃了什么」条目。
    # 只补不改：营养那几个数和份数一个字都不动（换算与进位是前端 diet-calc.js 的事）。
    if not isinstance(data.get("foods"), list):
        data["foods"] = []
    for row in data["foods"]:
        if not isinstance(row, dict):
            continue
        if not row.get("id"):
            row["id"] = "f-" + uuid.uuid4().hex[:8]
        for key in ("name", "unit", "note"):
            row.setdefault(key, "")
        for key in ("kcal", "protein", "fat", "carb"):
            row.setdefault(key, 0)
    for meal in data.get("meals") or []:
        if not isinstance(meal, dict):
            continue
        if not isinstance(meal.get("items"), list):
            meal["items"] = []
        fixed_items = []
        for item in meal["items"]:
            if not isinstance(item, dict):
                continue
            if not item.get("id"):
                item["id"] = "mi-" + uuid.uuid4().hex[:8]
            for key in ("foodId", "name", "unit"):
                item.setdefault(key, "")
            item.setdefault("slot", "snack")
            item.setdefault("amount", 1)
            for key in ("kcal", "protein", "fat", "carb"):
                item.setdefault(key, 0)
            fixed_items.append(item)
        meal["items"] = fixed_items
    # 笔记（2026-10-14 新增）：正文是 Markdown 纯文本，只补形状、不动一个字。
    if not isinstance(data.get("notes"), list):
        data["notes"] = []
    for row in data["notes"]:
        if not isinstance(row, dict):
            continue
        if not row.get("id"):
            row["id"] = "n-" + uuid.uuid4().hex[:8]
        for key in ("title", "body", "createdAt", "updatedAt"):
            row.setdefault(key, "")
        if not isinstance(row.get("imagePaths"), list):
            row["imagePaths"] = []
    # 素材库搬家（2026-10-14）：老的 mediaAssets 并进顶层 assets。
    # id 不变（各表里那些 assetIds 的引用自然还成立）、内容不动，并完把老表清空。
    # 两边都有同 id 时以 assets 那份为准（搬过一次之后就只在 assets 里了）。
    if not isinstance(data.get("assets"), list):
        data["assets"] = []
    seen_asset_ids = {a.get("id") for a in data["assets"] if isinstance(a, dict)}
    for row in data.get("mediaAssets") or []:
        if not isinstance(row, dict):
            continue
        if row.get("id") and row["id"] in seen_asset_ids:
            continue
        data["assets"].append(row)
    data["mediaAssets"] = []
    for row in data["assets"]:
        if not isinstance(row, dict):
            continue
        if not row.get("id"):
            row["id"] = "a-" + uuid.uuid4().hex[:8]
        for key in ("title", "path", "url", "text", "note", "createdAt"):
            row.setdefault(key, "")
        row.setdefault("kind", "link")
        if not isinstance(row.get("tags"), list):
            row["tags"] = []
    # 各表补 assetIds：能挂素材的几张表，老记录一律补一个空数组
    for key in ("contents", "tasks", "issues", "projects", "studies", "subjects",
                "workoutLogs", "gameRecords", "notes"):
        for row in data.get(key) or []:
            if isinstance(row, dict) and not isinstance(row.get("assetIds"), list):
                row["assetIds"] = []
    for row in (data.get("finance") or {}).get("transactions") or []:
        if isinstance(row, dict) and not isinstance(row.get("assetIds"), list):
            row["assetIds"] = []
    # 2026-10-07 第二批：今日计划、开发待办、学习记录、学习对象、训练打卡、游戏
    # 也都能带图片备注了，老记录一律补一个空数组（补了才动，有了不动）
    for key in ("tasks", "studies", "subjects", "workoutLogs", "games"):
        for row in data.get(key) or []:
            if isinstance(row, dict) and not isinstance(row.get("imagePaths"), list):
                row["imagePaths"] = []
    # 游玩记录（2026-10-07 新增）：游戏娱乐从「手填累计时长」改成「玩一次记一条」，
    # 单独一张 gameRecords 表。老数据没有这个键就补一张空表；有的逐条补齐字段，
    # 一条都不丢（游戏清单 games 那边一个字都不动，老的手填 hours 照旧留着）。
    if not isinstance(data.get("gameRecords"), list):
        data["gameRecords"] = []
    plays = []
    for row in data["gameRecords"]:
        if not isinstance(row, dict):
            continue
        row.setdefault("id", "play-" + uuid.uuid4().hex[:8])
        for key in ("gameId", "gameName", "playDate", "remark", "createAt"):
            row.setdefault(key, "")
        row.setdefault("durationMin", 0)
        if not isinstance(row.get("imagePaths"), list):
            row["imagePaths"] = []
        plays.append(row)
    data["gameRecords"] = plays
    # 游戏清单同时扩了两格：每月目标（小时）和通关日期。老数据补空值就行，
    # 原来的 name / platform / status / hours / progress 一个都不动。
    for row in data.get("games") or []:
        if not isinstance(row, dict):
            continue
        row.setdefault("targetHours", 0)
        row.setdefault("finishDate", "")
    # 开发待办多了个「优先级」字段（今日计划的任务也能标，老数据留空）；
    # 归档标记（isArchived / archivedAt）也是后加的，补齐默认值，老的当没归档。
    # isTodayPlan（2026-10-08 加的）：跨模块联动那个「加入今日计划」开关，
    # 老数据补 False；日期字段本来就有的，一个字都不动。
    for row in data.get("tasks") or []:
        if isinstance(row, dict):
            row.setdefault("priority", "")
            row.setdefault("isArchived", False)
            row.setdefault("archivedAt", "")
            row.setdefault("isTodayPlan", False)
            # 重复任务（2026-10-14 新增）：repeat = 一句人话规则（「每周一、三、五」），
            # repeatUntil = 到哪天为止，lastRun = 今天对过表了没有（你自己删掉的那条别补回来）。
            # 生成出来的实例带 genKey / repeatId，那两格不在这儿补
            # （补了反而让老数据看着像生成物）。
            row.setdefault("repeat", "")
            row.setdefault("repeatUntil", "")
            row.setdefault("lastRun", "")
            # 子任务（2026-10-14 新增）：一条待办底下的清单，每条 { id, text, done }。
            # 只补形状、不动文字：缺 id 的补一个（页面上那个勾选框要靠 id 认人），
            # 不是字典的条目扔掉，不是数组的整个当空的。
            subs = row.get("subtasks")
            if not isinstance(subs, list):
                subs = []
            fixed = []
            for sub in subs:
                if not isinstance(sub, dict):
                    continue
                if not sub.get("id"):
                    sub["id"] = "st-" + uuid.uuid4().hex[:8]
                sub.setdefault("text", "")
                sub.setdefault("done", False)
                fixed.append(sub)
            row["subtasks"] = fixed
    # 项目也扩了字段：详细描述、预计结束日期、图片
    # （「一句话简介」是老字段 intro，名字不动，老数据零成本）
    for row in data.get("projects") or []:
        if not isinstance(row, dict):
            continue
        for key in ("description", "expectEndDate"):
            row.setdefault(key, "")
        if not isinstance(row.get("imagePaths"), list):
            row["imagePaths"] = []
    # 标签（2026-10-11 新增）：记录上多一个 tags 字符串数组。
    # 只补缺的：没这个字段、或者被手改成了别的形状，读出来给一个空数组；
    # 已经是数组的原样留着（不清洗、不排序、不去重 —— 那是前端 tag-calc.js 的事）。
    for key in ("tasks", "contents", "mediaAccounts", "projects", "issues", "progress",
                "subjects", "studies", "workoutLogs", "weights", "meals", "water",
                "games", "gameRecords", "workLogs", "foods", "notes"):
        for row in data.get(key) or []:
            if isinstance(row, dict) and not isinstance(row.get("tags"), list):
                row["tags"] = []
    for holder, key in ((data.get("finance") or {}, "transactions"),
                        (data.get("debt") or {}, "items")):
        for row in holder.get(key) or []:
            if isinstance(row, dict) and not isinstance(row.get("tags"), list):
                row["tags"] = []
    # 附件相关的设置项也是后加的，老数据补齐（缺了才补，有了不动）
    settings = data.setdefault("settings", {})
    attach = settings.get("attachments")
    if not isinstance(attach, dict):
        attach = {}
    attach.setdefault("pruneOnDelete", False)
    attach.setdefault("maxEdge", 1920)
    settings["attachments"] = attach
    return data


def save_data(obj: dict) -> int:
    """整份写回，并留一份上一版，防止界面出 bug 把数据写没了。"""
    ensure_dirs()
    with LOCK:
        if os.path.exists(DATA_FILE):
            try:
                shutil.copy2(DATA_FILE, PREV_FILE)
            except OSError:
                pass
        atomic_write_json(DATA_FILE, obj)
        return os.path.getsize(DATA_FILE)


def keep_count(data: dict) -> int:
    try:
        keep = int(data.get("settings", {}).get("backupKeep", DEFAULT_BACKUP_KEEP))
    except (TypeError, ValueError):
        keep = DEFAULT_BACKUP_KEEP
    return max(1, min(keep, 365))


def prune_backups(keep: int) -> None:
    """按时间保留最近的 keep 份。_最近一次.json 和标了「保留-」的不参与清理。"""
    names = [
        n for n in os.listdir(BACKUP_DIR)
        if n.endswith(".json")
        and n != os.path.basename(PREV_FILE)
        and not n.startswith(KEEP_PREFIX)
    ]
    names.sort(key=lambda n: os.path.getmtime(os.path.join(BACKUP_DIR, n)), reverse=True)
    for name in names[keep:]:
        try:
            os.remove(os.path.join(BACKUP_DIR, name))
        except OSError:
            pass


def daily_backup(data: dict) -> str | None:
    """每天第一份，存成 YYYY-MM-DD.json；同一天不重复备份。"""
    ensure_dirs()
    target = os.path.join(BACKUP_DIR, date.today().isoformat() + ".json")
    if os.path.exists(DATA_FILE) and not os.path.exists(target):
        shutil.copyfile(DATA_FILE, target)
        prune_backups(keep_count(data))
        return target
    prune_backups(keep_count(data))
    return None


def time_stamp() -> str:
    return datetime.now().strftime("%Y-%m-%d-%H%M%S")


def write_backup(prefix: str) -> str:
    """把当前数据复制一份进备份目录，返回文件名。
    用 copyfile 而不是 copy2：让备份文件的时间戳是「备份这一刻」，
    否则它会继承数据文件的时间，排序和显示都会乱。
    """
    ensure_dirs()
    name = "%s-%s.json" % (prefix, time_stamp())
    with LOCK:
        if os.path.exists(DATA_FILE):
            shutil.copyfile(DATA_FILE, os.path.join(BACKUP_DIR, name))
    return name


def list_backups() -> list[dict]:
    ensure_dirs()
    out = []
    for name in os.listdir(BACKUP_DIR):
        if not name.endswith(".json") or name == os.path.basename(PREV_FILE):
            continue
        path = os.path.join(BACKUP_DIR, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        out.append({
            "name": name,
            "size": st.st_size,
            "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
            "kind": backup_kind(name),
            "keep": name.startswith(KEEP_PREFIX),
        })
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def backup_kind(name: str) -> str:
    if name.startswith(KEEP_PREFIX):
        name = name[len(KEEP_PREFIX):]
    for prefix, label in (("手动-", "手动"), ("导入前-", "导入前"), ("清空前-", "清空前"),
                          ("演示前-", "演示前")):
        if name.startswith(prefix):
            return label
    return "每日"


def safe_backup_name(name: str) -> str:
    """只允许备份目录里的纯文件名，防止用 ../ 跑到别处去。"""
    base = os.path.basename(str(name or ""))
    if base != name or not base.endswith(".json"):
        raise ValueError("备份文件名不合法")
    path = os.path.join(BACKUP_DIR, base)
    if not os.path.exists(path):
        raise ValueError("找不到这份备份")
    return base


def open_folder(path: str) -> None:
    """在文件管理器里打开一个文件夹（Windows 用 os.startfile）。"""
    os.makedirs(path, exist_ok=True)
    starter = getattr(os, "startfile", None)
    if starter is None:
        raise RuntimeError("这个系统不支持自动打开文件夹，请手动打开：%s" % path)
    starter(path)


def dig(data: dict, path: str):
    """按 "a.b" 取嵌套的值；中间断掉就返回 None。
    记账的数据嵌在 finance 一个键里，启动摘要要数它得走这条路。"""
    cur = data
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def summarize(data: dict) -> list[tuple[str, int]]:
    out = []
    for key, label in COUNT_KEYS:
        value = dig(data, key)
        out.append((label, len(value) if isinstance(value, list) else 0))
    return out


# --------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = SERVER_TOKEN
    protocol_version = "HTTP/1.1"

    # 控制台不刷访问日志，只保留保存记录
    def log_message(self, fmt: str, *args: object) -> None:
        pass

    def log_error(self, fmt: str, *args: object) -> None:
        pass

    # ---------- 小工具 ----------

    def origin_ok(self) -> bool:
        """写请求只认本机页面。
        别的网站在你浏览器里也能 POST 到 127.0.0.1，但它们的 Origin 不是本机，
        在这里直接拒掉。本机的 curl / 脚本没有 Origin，放行。"""
        origin = self.headers.get("Origin") or self.headers.get("Referer") or ""
        if not origin:
            return True
        try:
            host = urllib.parse.urlparse(origin).hostname or ""
        except ValueError:
            return False
        return host in ("127.0.0.1", "localhost", "::1")

    def send_json(self, obj: object, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, text: str, status: int = 200) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---------- GET ----------

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            attach_count, attach_bytes = attachments_stat()
            self.send_json({
                "app": APP_NAME,
                "version": APP_VERSION,
                "dataset": CURRENT_DATASET,
                "dataRoot": DATA_ROOT if DATASETS_ENABLED else "",
                "datasetsEnabled": DATASETS_ENABLED,
                "dataFile": DATA_FILE,
                "backupDir": BACKUP_DIR,
                "exportDir": EXPORT_DIR,
                "attachDir": ATTACH_DIR,
                "attachCount": attach_count,
                "attachBytes": attach_bytes,
                "dataSize": os.path.getsize(DATA_FILE) if os.path.exists(DATA_FILE) else 0,
                "serverTime": now_text(),
            })
            return
        if path == "/api/datasets":
            self.send_json(list_datasets())
            return
        if path == "/api/data":
            self.send_json(load_data())
            return
        if path == "/api/backups":
            self.send_json({"ok": True, "items": list_backups()})
            return
        if path.startswith("/attachments/"):
            self.serve_attachment(path)
            return
        self.serve_static(path)

    # ---------- POST ----------

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]

        # 必须先把请求体读干净再处理。HTTP/1.1 是长连接，如果这段字节
        # 留在缓冲区里，会被当成「下一个请求」的开头，于是下一个请求
        # 会莫名其妙地收到 400 和一张 HTML 错误页。
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            self.send_json({"ok": False, "error": "请求体大小异常"}, 400)
            return
        self._body = self.rfile.read(length) if length > 0 else b""

        if not self.origin_ok():
            log_line("拒绝写入：来源不是本机页面（%s）" % (self.headers.get("Origin") or ""))
            self.send_json({"ok": False, "error": "来源不是本机页面，拒绝写入"}, 403)
            return

        routes = {
            "/api/data": self.api_save,
            "/api/export": self.api_export,
            "/api/backup": self.api_backup_now,
            "/api/backup-keep": self.api_backup_keep,
            "/api/import": self.api_import,
            "/api/clear": self.api_clear,
            "/api/open-folder": self.api_open_folder,
            "/api/attachment": self.api_attachment,
            "/api/attachment-delete": self.api_attachment_delete,
        }
        handler = routes.get(path)
        if handler is None:
            self.send_json({"ok": False, "error": "未知接口"}, 404)
            return
        try:
            handler()
        except Exception as exc:
            self.send_json({"ok": False, "error": "服务端出错：%s" % exc}, 500)

    # ---------- 接口实现 ----------

    def read_json_body(self):
        """解析 do_POST 已经读下来的请求体；空体当成空对象。
        解析失败时已经回过响应，返回 None。"""
        if not getattr(self, "_body", b""):
            return {}
        try:
            return json.loads(self._body.decode("utf-8"))
        except Exception as exc:
            self.send_json({"ok": False, "error": "JSON 解析失败：%s" % exc}, 400)
            return None

    def api_save(self) -> None:
        data = self.read_json_body()
        if data is None:
            return
        if not isinstance(data, dict) or "version" not in data:
            self.send_json({"ok": False, "error": "数据格式不对，拒绝写入"}, 400)
            return

        # 写入闸 + 修订号，两道一起上：
        #   闸（数据.lock）挡住「两个进程同一刻都在写」这种并发竞态；
        #   修订号挡住「两个窗口先后改、后写的把先写的覆盖掉」这种丢数据 ——
        #   页面读取时 rev 是多少，写回来就必须是多少，对不上就拒掉。
        try:
            acquire_write_lock()
        except DataBusy:
            log_line("拒绝写入：文件正在保存中，稍后重试")
            self.send_json({
                "ok": False,
                "busy": True,
                "error": "文件正在保存，请稍后重试",
            }, 409)
            return
        try:
            with LOCK:
                current = load_data()
            cur_rev = int(current.get("rev") or 0)
            sent_rev = data.get("rev")
            if isinstance(sent_rev, int) and sent_rev != cur_rev:
                log_line("拒绝写入：修订号不一致（页面 %s，磁盘 %s）" % (sent_rev, cur_rev))
                self.send_json({
                    "ok": False,
                    "conflict": True,
                    "rev": cur_rev,
                    "error": "另一个窗口刚改过数据",
                }, 409)
                return

            data["rev"] = cur_rev + 1
            data["updatedAt"] = now_text()
            size = save_data(data)
        finally:
            release_write_lock()
        prune_backups(keep_count(data))
        print("  · 已保存到 数据.json（%d 字节，%s）" % (size, now_text()))
        self.send_json({
            "ok": True,
            "savedAt": now_text(),
            "bytes": size,
            "rev": data["rev"],
        })

    def api_backup_now(self) -> None:
        data = load_data()
        name = write_backup("手动")
        prune_backups(keep_count(data))
        print("  · 手动备份：%s" % name)
        log_line("手动备份：%s" % name)
        self.send_json({"ok": True, "name": name, "savedAt": now_text()})

    def api_backup_keep(self) -> None:
        """给某份备份打上 / 去掉「长期保留」标记（改文件名前缀）。"""
        body = self.read_json_body() or {}
        want_keep = bool(body.get("keep"))
        try:
            base = safe_backup_name(body.get("name"))
        except ValueError as exc:
            self.send_json({"ok": False, "error": str(exc)}, 400)
            return

        if want_keep and not base.startswith(KEEP_PREFIX):
            new_name = KEEP_PREFIX + base
        elif not want_keep and base.startswith(KEEP_PREFIX):
            new_name = base[len(KEEP_PREFIX):]
        else:
            new_name = base

        if new_name != base:
            os.replace(os.path.join(BACKUP_DIR, base), os.path.join(BACKUP_DIR, new_name))
        log_line("备份标记：%s → %s" % (new_name, "长期保留" if want_keep else "普通"))
        self.send_json({"ok": True, "name": new_name, "keep": want_keep})

    def api_export(self) -> None:
        os.makedirs(EXPORT_DIR, exist_ok=True)
        name = "备份-%s.json" % time_stamp()
        target = os.path.join(EXPORT_DIR, name)
        with LOCK:
            if os.path.exists(DATA_FILE):
                shutil.copyfile(DATA_FILE, target)
            else:
                atomic_write_json(target, load_data())
        print("  · 已导出：%s" % target)
        log_line("导出备份：%s" % target)
        self.send_json({"ok": True, "name": name, "path": target,
                        "folder": EXPORT_DIR, "bytes": os.path.getsize(target)})

    def api_import(self) -> None:
        data = self.read_json_body()
        if data is None:
            return
        if not isinstance(data, dict) or "version" not in data:
            self.send_json({"ok": False, "error": "这个文件不像是本程序导出的数据"}, 400)
            return
        try:
            acquire_write_lock()
        except DataBusy:
            self.send_json({"ok": False, "busy": True,
                            "error": "文件正在保存，请稍后重试"}, 409)
            return
        try:
            snapshot = write_backup("导入前")
            # 导入也要推进修订号：否则页面手里那个旧号会一直跟磁盘对不上
            data["rev"] = int(load_data().get("rev") or 0) + 1
            data["updatedAt"] = now_text()
            size = save_data(data)
        finally:
            release_write_lock()
        prune_backups(keep_count(data))
        print("  · 已导入恢复（导入前的数据存为 %s）" % snapshot)
        log_line("导入恢复（导入前存为 %s）" % snapshot)
        self.send_json({"ok": True, "snapshot": snapshot, "bytes": size, "data": data})

    def api_clear(self) -> None:
        try:
            acquire_write_lock()
        except DataBusy:
            self.send_json({"ok": False, "busy": True,
                            "error": "文件正在保存，请稍后重试"}, 409)
            return
        try:
            snapshot = write_backup("清空前")
            fresh = default_data()
            fresh["rev"] = int(load_data().get("rev") or 0) + 1
            fresh["updatedAt"] = now_text()
            save_data(fresh)
        finally:
            release_write_lock()
        prune_backups(keep_count(fresh))
        print("  · 已清空数据（清空前存为 %s）" % snapshot)
        log_line("清空数据（清空前存为 %s）" % snapshot)
        self.send_json({"ok": True, "snapshot": snapshot, "data": fresh})

    def api_open_folder(self) -> None:
        body = self.read_json_body()
        if body is None:
            return
        which = (body or {}).get("which", "data")
        folders = {"data": DATA_DIR, "backup": BACKUP_DIR, "export": EXPORT_DIR,
                   "attach": ATTACH_DIR}
        target = folders.get(which)
        if not target:
            self.send_json({"ok": False, "error": "未知的文件夹"}, 400)
            return
        open_folder(target)
        print("  · 已打开文件夹：%s" % target)
        self.send_json({"ok": True, "path": target})

    # ---------- 图片附件 ----------

    def api_attachment(self) -> None:
        """收一张图，写进 数据\\attachments\\模块\\，返回 JSON 里该存的那条相对路径。

        走的是 JSON + base64 而不是 multipart：这个服务只用标准库，
        cgi 那套在 3.13 已经删了，自己拆 multipart 不值当。一次只收一张，
        体积上限见 MAX_BODY，够用。
        """
        body = self.read_json_body()
        if body is None:
            return
        body = body if isinstance(body, dict) else {}
        module = str(body.get("module") or "").strip()
        if module not in ATTACH_MODULES:
            self.send_json({"ok": False, "error": "未知的模块，图片没存下"}, 400)
            return
        ext = attach_ext(body.get("ext") or body.get("name") or body.get("mime"))
        if not ext:
            self.send_json({"ok": False, "error": "只收 png / jpg / webp 的图片"}, 400)
            return
        text = str(body.get("data") or "")
        if text.startswith("data:"):     # 允许前端直接丢一个 dataURL 过来
            text = text.split(",", 1)[-1]
        try:
            raw = base64.b64decode(text, validate=True)
        except Exception:
            self.send_json({"ok": False, "error": "图片数据读不出来"}, 400)
            return
        if not raw:
            self.send_json({"ok": False, "error": "图片是空的"}, 400)
            return
        if len(raw) > ATTACH_MAX_BYTES:
            self.send_json({
                "ok": False,
                "error": "这张图超过 %dMB，太大了" % (ATTACH_MAX_BYTES // 1024 // 1024),
            }, 400)
            return
        rel, name = write_attachment(module, ext, raw)
        log_line("存图片附件：%s（%d 字节）" % (rel, len(raw)))
        print("  · 已存图片附件：%s（%d 字节）" % (rel, len(raw)))
        self.send_json({"ok": True, "path": rel, "name": name, "bytes": len(raw)})

    def api_attachment_delete(self) -> None:
        """删掉几张不再被引用的图片。路径一律先过 attach_parse：
        不是「attachments/白名单模块/日期_随机.扩展名」的，一个都不动。"""
        body = self.read_json_body()
        if body is None:
            return
        paths = (body or {}).get("paths")
        if not isinstance(paths, list):
            paths = []
        deleted = missing = refused = 0
        for item in paths:
            parsed = attach_parse(item)
            if not parsed:
                refused += 1
                continue
            target = os.path.join(ATTACH_DIR, parsed[0], parsed[1])
            if not os.path.isfile(target):
                missing += 1
                continue
            try:
                os.remove(target)
                deleted += 1
            except OSError:
                refused += 1
        if deleted or refused:
            log_line("删图片附件：删掉 %d 张，拒绝 %d 条（找不到 %d 张）" % (deleted, refused, missing))
        self.send_json({"ok": True, "deleted": deleted, "missing": missing, "refused": refused})

    def serve_attachment(self, path: str) -> None:
        """把 数据\\attachments\\ 里的图片发给浏览器。路径同样先过白名单，
        免得有人拿 ../../ 去读别处的文件。"""
        parsed = attach_parse(path.lstrip("/"))
        if not parsed:
            self.send_text("路径不合法", 403)
            return
        target = os.path.join(ATTACH_DIR, parsed[0], parsed[1])
        if not os.path.isfile(target):
            self.send_text("找不到这张图片", 404)
            return
        ctype = ATTACH_EXTS.get(parsed[1].rsplit(".", 1)[-1].lower(), "application/octet-stream")
        st = os.stat(target)
        last_modified = email.utils.formatdate(st.st_mtime, usegmt=True)
        if self.headers.get("If-Modified-Since") == last_modified:
            self.send_response(304)
            self.send_header("Last-Modified", last_modified)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return
        with open(target, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Last-Modified", last_modified)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # ---------- 静态文件 ----------

    def serve_static(self, path: str) -> None:
        if path in ("/", ""):
            path = "/index.html"
        rel = path.lstrip("/").replace("/", os.sep)
        target = os.path.normpath(os.path.join(WEB_DIR, rel))
        if target != WEB_DIR and not target.startswith(WEB_DIR + os.sep):
            self.send_text("路径不合法", 403)
            return
        if not os.path.isfile(target):
            self.send_text("找不到文件：%s" % path, 404)
            return

        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"

        # 静态文件用「每次都回来问一句」的缓存策略：
        # 文件没变就回 304（省掉重新传一遍的功夫，第二次打开更快），
        # 文件改了（我改了代码）立刻就是新的，不会拿着旧页面发呆。
        # /api/ 那些接口仍然是不缓存的，见 send_json。
        st = os.stat(target)
        last_modified = email.utils.formatdate(st.st_mtime, usegmt=True)
        if self.headers.get("If-Modified-Since") == last_modified:
            self.send_response(304)
            self.send_header("Last-Modified", last_modified)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return

        with open(target, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Last-Modified", last_modified)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


# --------------------------------------------------------------------------
# 启动
# --------------------------------------------------------------------------

def setup_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    try:
        import ctypes
        ctypes.windll.kernel32.SetConsoleTitleW(APP_NAME)
    except Exception:
        pass


def open_browser(url: str) -> None:
    """打开默认浏览器；打不开也不该把整个程序弄崩。"""
    try:
        webbrowser.open(url)
    except Exception as exc:
        print("  （没能自动打开浏览器：%s）" % exc)
        print("  请手动打开：%s" % url)


class AlreadyRunning(Exception):
    """端口上已经跑着我们的服务了"""

    def __init__(self, port: int) -> None:
        super().__init__(port)
        self.port = port


class XiaoLiServer(ThreadingHTTPServer):
    """本机小服务用的 HTTP 服务器。这里只为一件事：Windows 上关掉 SO_REUSEADDR。

    Python 的 HTTPServer 默认 allow_reuse_address = True。在 Linux 上它的意思是
    「重启时不用等旧连接散掉」；但在 Windows 上它的意思是「这个端口别人占着也
    让你绑」——绑上去的那个新副本收不到任何连接，浏览器还是连到老的那个。
    表现出来就是：在开发用的那一份里双击 启动.cmd，浏览器打开的却是日常在用的
    那一份的旧界面，然后你以为刚改的东西没生效。

    关掉之后，被占着的端口会老老实实报错，启动逻辑就会往下试 8766、8767……
    再顺手加一道 SO_EXCLUSIVEADDRUSE，免得别的程序反过来抢我们这块端口。
    """

    daemon_threads = True
    allow_reuse_address = os.name != "nt"

    def server_bind(self) -> None:
        exclusive = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if os.name == "nt" and exclusive is not None:
            self.socket.setsockopt(socket.SOL_SOCKET, exclusive, 1)
        super().server_bind()


def running_instance(port: int) -> bool:
    """端口上已经跑着我们的服务吗？

    三处讲究，都是为了启动快：
      1. 用 http.client 直连，不走 urllib 那套（它会看代理环境变量）；
      2. 超时只给 0.25 秒。正常机器上连没人监听的端口是「立刻拒绝」，
         但要是碰上防火墙 / 安全软件把连接「丢掉」而不是「拒绝」，
         就会一直等到超时——给长了，每个端口都要干等一趟；
      3. 只在「找到的第一个可用端口」上问这一句，不把 12 个端口全扫一遍。

    还有一处讲究：必须是「同一份」才算。仓库和日常在用的那份各有各的
    数据目录，另一份开着的时候双击本份的 启动.cmd，不该被它顶掉——
    否则你会以为打开的是开发版，其实看到的是另一个副本的旧界面。
    """
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=0.25)
        conn.request("GET", "/api/health")
        resp = conn.getresponse()
        data = json.loads(resp.read().decode("utf-8"))
        conn.close()
        return resp.status == 200 and data.get("app") == APP_NAME and same_copy(data)
    except Exception:
        return False


def same_copy(health: dict) -> bool:
    """端口上那个小李，是「这一份」吗？看数据目录对不对得上。
    老版本的健康信息里没有 dataFile，那就按老办法认（只认名字）。"""
    data_file = str(health.get("dataFile") or "")
    if not data_file:
        return True
    return os.path.dirname(os.path.abspath(data_file)) == os.path.abspath(DATA_DIR)


def port_candidates() -> list[int]:
    """默认从 8765 开始往后试 12 个；显式指定端口时只试那一个。"""
    forced = None
    if "--port" in sys.argv:
        try:
            forced = int(sys.argv[sys.argv.index("--port") + 1])
        except (IndexError, ValueError):
            forced = None
    if forced is None:
        env = os.environ.get("XIAOLI_PORT", "").strip()
        if env.isdigit():
            forced = int(env)
    if forced:
        return [forced]
    return list(range(DEFAULT_PORT, DEFAULT_PORT + PORT_TRIES))


def start_server() -> tuple[ThreadingHTTPServer, int]:
    """从 8765 往上走一趟：这个端口上是我们自己的服务就抛 AlreadyRunning；
    能绑上就用它开工；被别的程序占着就试下一个。"""
    ports = port_candidates()
    last_error = None
    for port in ports:
        if running_instance(port):
            raise AlreadyRunning(port)
        try:
            return XiaoLiServer(("127.0.0.1", port), Handler), port
        except OSError as exc:
            last_error = exc
    raise SystemExit("端口 %s 都占着，起不来：%s" % (ports, last_error))


def main() -> int:
    setup_console()
    ensure_dirs()
    clear_stale_lock()   # 上次崩在写盘中途留下的锁，别挡着这次

    print("=" * 60)
    print("  %s  %s" % (APP_NAME, APP_VERSION))
    print("=" * 60)

    try:
        httpd, port = start_server()
    except AlreadyRunning as running:
        url = "http://127.0.0.1:%d/" % running.port
        print("  服务已经在运行，直接打开界面：%s" % url)
        print("  （这次没有重复启动；关掉原来那个黑窗口才会真正停止）")
        if "--no-browser" not in sys.argv:
            open_browser(url)
        time.sleep(1.5)  # 让用户看清这行提示再关窗口
        return 0

    # 端口已经绑好了，浏览器可以先开：它加载页面的同时我们把剩下的事做完
    url = "http://127.0.0.1:%d/" % port
    if "--no-browser" not in sys.argv:
        threading.Timer(0.15, lambda: open_browser(url)).start()

    existed = os.path.exists(DATA_FILE)

    data = load_data()
    backup = daily_backup(data) if existed else None

    log_line("启动：端口 %d，数据文件 %s" % (port, DATA_FILE))
    if backup:
        log_line("每日自动备份：%s" % os.path.basename(backup))

    print("  数据文件：%s" % DATA_FILE)
    if DATASETS_ENABLED:
        print("  当前数据集：%s（根目录 %s）" % (CURRENT_DATASET, DATA_ROOT))
    if not existed:
        print("  首次运行，已生成一个空的数据文件。")
    print("  今日备份：%s" % (backup if backup else "已存在，不重复备份"))
    print("  备份目录：%s（只保留最近 %d 份）" % (BACKUP_DIR, keep_count(data)))
    print("  当前数据：%s" % "、".join("%s %d" % (label, n) for label, n in summarize(data)))
    print("-" * 60)
    print("  界面地址：http://127.0.0.1:%d/" % port)
    print("  关掉这个窗口 = 停止程序；数据早已落盘，下次双击继续。")
    print("=" * 60)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
        log_line("停止：关掉了服务窗口")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

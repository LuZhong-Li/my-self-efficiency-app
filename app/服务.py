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
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_NAME = "小李"
APP_VERSION = "v1.0"

# HTTP 响应头只能是 latin-1，所以「给程序看的」版本号必须保持纯 ASCII。
# 注意：不要把这个变量改成带中文/全角字符的值，否则每个请求都会 500。
SERVER_TOKEN = "XiaoLi/1.0"

# 项目目录就是这个文件的上上级（比如 D:\小李）
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(BASE_DIR, "app", "web")
# 想换数据位置（比如挪到别的盘），设环境变量 XIAOLI_DATA_DIR 就行。
# 自检脚本就是靠它在一个临时目录里跑，绝不去碰你的真实数据。
DATA_DIR = os.environ.get("XIAOLI_DATA_DIR") or os.path.join(BASE_DIR, "数据")
DATA_FILE = os.path.join(DATA_DIR, "数据.json")
BACKUP_DIR = os.path.join(DATA_DIR, "备份")
EXPORT_DIR = os.path.join(DATA_DIR, "导出")
LOG_DIR = os.path.join(DATA_DIR, "日志")
LOG_FILE = os.path.join(LOG_DIR, "运行.log")
PREV_FILE = os.path.join(BACKUP_DIR, "_最近一次.json")
# 图片附件：单独一个文件夹，主数据文件里只存相对路径（attachments/模块/文件名）。
# 放在 数据 目录下面是有意的——备份、搬到别的盘（XIAOLI_DATA_DIR）都是一整份走，
# 而且 同步到小李.cmd / .gitignore 本来就不碰 数据 目录，图片不会跟着代码跑。
ATTACH_DIR = os.path.join(DATA_DIR, "attachments")
# 附件按模块分格；加新模块往这里补一个名字，前端 attachment-calc.js 也要跟着加
ATTACH_MODULES = (
    "finance", "buglog", "progress",
    "today_plan", "dev_project", "dev_todo", "study_record", "study_item",
    "fitness", "game",
    "note",
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
    ("finance.transactions", "账目"),
    ("debt.items", "债务"),
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
        "projects": [],
        "issues": [],
        "progress": [],
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
        "water": [],
        "games": [],
        "finance": default_finance(),
        "debt": default_debt(),
        "settings": {
            "theme": "light",
            # 明暗策略：light / dark / system（跟随系统）。theme 只记当前实际明暗，兼容老版本
            "themeMode": "light",
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
        for key in ("desc", "module", "createdAt", "fixedAt"):
            row.setdefault(key, "")
        if row.get("status") == "处理中":
            row["status"] = "进行中"
        elif row.get("status") == "已解决":
            row["status"] = "已修复"
    # 进展条目：也是后加的图片字段
    for row in data.get("progress") or []:
        if isinstance(row, dict) and not isinstance(row.get("imagePaths"), list):
            row["imagePaths"] = []
    # 2026-10-07 第二批：今日计划、开发待办、学习记录、学习对象、训练打卡、游戏
    # 也都能带图片备注了，老记录一律补一个空数组（补了才动，有了不动）
    for key in ("tasks", "studies", "subjects", "workoutLogs", "games"):
        for row in data.get(key) or []:
            if isinstance(row, dict) and not isinstance(row.get("imagePaths"), list):
                row["imagePaths"] = []
    # 开发待办多了个「优先级」字段（今日计划的任务不标，留空）
    for row in data.get("tasks") or []:
        if isinstance(row, dict):
            row.setdefault("priority", "")
    # 项目也扩了字段：详细描述、预计结束日期、图片
    # （「一句话简介」是老字段 intro，名字不动，老数据零成本）
    for row in data.get("projects") or []:
        if not isinstance(row, dict):
            continue
        for key in ("description", "expectEndDate"):
            row.setdefault(key, "")
        if not isinstance(row.get("imagePaths"), list):
            row["imagePaths"] = []
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

        # 修订号：页面读取时是多少，写回来就必须是多少。
        # 对不上说明另一个窗口先改过了，拒掉，免得互相覆盖。
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
        snapshot = write_backup("导入前")
        # 导入也要推进修订号：否则页面手里那个旧号会一直跟磁盘对不上
        data["rev"] = int(load_data().get("rev") or 0) + 1
        data["updatedAt"] = now_text()
        size = save_data(data)
        prune_backups(keep_count(data))
        print("  · 已导入恢复（导入前的数据存为 %s）" % snapshot)
        log_line("导入恢复（导入前存为 %s）" % snapshot)
        self.send_json({"ok": True, "snapshot": snapshot, "bytes": size, "data": data})

    def api_clear(self) -> None:
        snapshot = write_backup("清空前")
        fresh = default_data()
        fresh["rev"] = int(load_data().get("rev") or 0) + 1
        fresh["updatedAt"] = now_text()
        save_data(fresh)
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

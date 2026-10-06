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

import json
import email.utils
import mimetypes
import os
import shutil
import socket
import sys
import threading
import time
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


def default_data() -> dict:
    """第一次运行时用的空数据骨架，字段与设计文档第 5 节一致。"""
    return {
        "version": 1,
        "rev": 0,          # 修订号：每写一次加一，用来挡「两个窗口互相覆盖」
        "createdAt": now_text(),
        "tasks": [],
        "memo": "",
        "contents": [],
        "projects": [],
        "issues": [],
        "progress": [],
        "subjects": [],   # 学习对象：书 / 课程 / 视频 / 技能
        "studies": [],    # 学习记录：哪天、学什么、多久、心得
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
        "settings": {
            "theme": "light",
            "backupKeep": DEFAULT_BACKUP_KEEP,
            "selfTest": {"saveCount": 0, "lastSavedAt": None},
        },
    }


def ensure_dirs() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(BACKUP_DIR, exist_ok=True)


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
            self.send_json({
                "app": APP_NAME,
                "version": APP_VERSION,
                "dataFile": DATA_FILE,
                "backupDir": BACKUP_DIR,
                "exportDir": EXPORT_DIR,
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
        folders = {"data": DATA_DIR, "backup": BACKUP_DIR, "export": EXPORT_DIR}
        target = folders.get(which)
        if not target:
            self.send_json({"ok": False, "error": "未知的文件夹"}, 400)
            return
        open_folder(target)
        print("  · 已打开文件夹：%s" % target)
        self.send_json({"ok": True, "path": target})

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

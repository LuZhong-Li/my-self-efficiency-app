# -*- coding: utf-8 -*-
"""小李 · 一键自检

在一个临时数据目录里自己起一个服务（**不会碰你正在用的数据**），
把关键接口从头到尾过一遍，最后打印一张清单。

用法：双击项目根目录的 自检.cmd；或者在终端运行
      python tests\\自检.py
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "app" / "服务.py"
WEB = ROOT / "app" / "web"

# 一张 1×1 的 png（67 字节），够用来验证「上传 → 落盘 → 取回 → 删掉」这条线
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

ok_list: list[str] = []
bad_list: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (ok_list if ok else bad_list).append(name)
    print(("  [OK]   " if ok else "  [失败] ") + name + (("　" + detail) if detail else ""))


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def call(port: int, path: str, method: str = "GET", body=None, origin: str | None = None):
    """返回 (状态码, 解析后的内容)。"""
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if origin:
        headers["Origin"] = origin
    req = urllib.request.Request(
        "http://127.0.0.1:%d%s" % (port, path), data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except Exception:
            return exc.code, raw
    except Exception as exc:  # 连不上之类
        return 0, str(exc)


def check_no_external() -> None:
    bad = []
    for f in sorted(WEB.rglob("*")):
        if f.suffix not in (".html", ".css", ".js"):
            continue
        text = f.read_text(encoding="utf-8")
        for m in re.finditer(r"https?://[^\s\"')]+", text):
            bad.append("%s → %s" % (f.name, m.group(0)))
    check("界面文件里没有任何外部链接（断网也能用）", not bad, "；".join(bad[:3]))


def fetch_raw(port: int, path: str):
    """取原始字节。call() 是按 JSON 解析的，图片这类二进制得走这一条。"""
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path))
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except Exception as exc:  # 连不上之类
        return 0, str(exc).encode("utf-8")


def main() -> int:
    print("=" * 64)
    print("  小李 · 一键自检")
    print("=" * 64)

    check("服务脚本在位", SERVER.exists(), str(SERVER))
    check_no_external()

    workdir = Path(tempfile.mkdtemp(prefix="xiaoli-selftest-"))
    data_dir = workdir / "数据"
    port = free_port()
    env = dict(os.environ)
    env["XIAOLI_DATA_DIR"] = str(data_dir)

    proc = subprocess.Popen(
        [sys.executable, str(SERVER), "--no-browser", "--port", str(port)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        # 等服务起来
        health = None
        for _ in range(40):
            time.sleep(0.25)
            status, body = call(port, "/api/health")
            if status == 200 and isinstance(body, dict):
                health = body
                break
        check("服务能起来并应答", bool(health))
        if not health:
            raise RuntimeError("服务没起来")

        check("应用名是「小李」", health.get("app") == "小李", str(health.get("app")))
        check("数据写在指定的临时目录里", str(data_dir) in str(health.get("dataFile", "")))

        status, page = call(port, "/")
        check("首页能取到", status == 200 and "小李" in str(page))
        check("模块脚本能取到", call(port, "/app.js")[0] == 200)

        # 数据骨架
        status, data = call(port, "/api/data")
        need = ["tasks", "memo", "contents", "projects", "issues", "progress", "subjects",
                "studies", "workoutLogs", "workoutPlan", "weights", "meals", "water",
                "games", "settings", "finance", "debt", "mediaAccounts", "mediaFollowers"]
        missing = [k for k in need if k not in data]
        check("数据骨架九个模块的字段都在", not missing, "缺：" + ",".join(missing))

        # 保存 + 修订号
        data["memo"] = "自检写入"
        status, saved = call(port, "/api/data", "POST", data)
        check("能写入数据", status == 200 and saved.get("ok"))
        rev1 = saved.get("rev")
        check("写入后修订号加一", isinstance(rev1, int) and rev1 > int(data.get("rev") or 0))

        # 旧修订号应被拒（多窗口防覆盖）
        status, conflict = call(port, "/api/data", "POST", data)
        check("拿旧修订号写入会被拒绝（防两个窗口互相覆盖）",
              status == 409 and conflict.get("conflict"))

        # 来源校验
        fresh = call(port, "/api/data")[1]
        status, denied = call(port, "/api/data", "POST", fresh, origin="http://evil.example")
        check("别的网站的写请求会被拒绝", status == 403, str(denied)[:60])

        # 备份
        status, made = call(port, "/api/backup", "POST", {})
        check("能手动备份", status == 200 and (data_dir / "备份" / made["name"]).exists())

        # 长期保留
        items = call(port, "/api/backups")[1]["items"]
        keep_name = items[0]["name"]
        status, kept = call(port, "/api/backup-keep", "POST", {"name": keep_name, "keep": True})
        check("能给备份打「长期保留」", status == 200 and kept.get("keep"))
        cur = call(port, "/api/data")[1]
        cur["settings"]["backupKeep"] = 1
        call(port, "/api/data", "POST", cur)
        for _ in range(3):
            call(port, "/api/backup", "POST", {})
        names = [b["name"] for b in call(port, "/api/backups")[1]["items"]]
        check("保留份数调小后，标了长期保留的那份还在",
              any(n.startswith("保留-") for n in names))

        # 导出 / 导入往返
        status, exp = call(port, "/api/export", "POST", {})
        exported = json.loads(Path(exp["path"]).read_text(encoding="utf-8"))
        check("能导出备份文件", status == 200 and Path(exp["path"]).exists())

        cur = call(port, "/api/data")[1]
        cur["memo"] = "自检：这是导入前临时改的"
        call(port, "/api/data", "POST", cur)
        status, imp = call(port, "/api/import", "POST", exported)
        after = call(port, "/api/data")[1]
        check("导出再导入能原样还原", after.get("memo") == exported.get("memo"))
        check("导入前会自动留一份快照",
              (data_dir / "备份" / imp["snapshot"]).exists(), imp.get("snapshot", ""))

        # 记账：导出导入也要带着 finance 走
        cur = call(port, "/api/data")[1]
        cur["finance"]["transactions"] = [{
            "id": "tx-selftest", "type": "expense", "amountCents": 2550,
            "date": "2026-10-07", "category": "餐饮", "accountId": "",
            "note": "自检", "createdAt": "2026-10-07 12:30",
        }]
        cur["finance"]["budget"]["monthlyTotalCents"] = 200000
        call(port, "/api/data", "POST", cur)

        status, exp2 = call(port, "/api/export", "POST", {})
        exported2 = json.loads(Path(exp2["path"]).read_text(encoding="utf-8"))
        call(port, "/api/clear", "POST", {})
        call(port, "/api/import", "POST", exported2)
        back2 = call(port, "/api/data")[1]
        check("导出导入往返带着记账数据",
              back2["finance"]["transactions"][0]["amountCents"] == 2550
              and back2["finance"]["budget"]["monthlyTotalCents"] == 200000)

        # 债务：导出导入也要带着走
        cur = call(port, "/api/data")[1]
        cur["debt"]["items"] = [{
            "id": "debt-selftest", "name": "自检债务", "type": "oweOthers",
            "totalCents": 10000, "creditor": "", "dueDate": "2026-10-20",
            "note": "", "status": "pending", "repayments": [],
        }]
        call(port, "/api/data", "POST", cur)
        status, exp3 = call(port, "/api/export", "POST", {})
        exported3 = json.loads(Path(exp3["path"]).read_text(encoding="utf-8"))
        call(port, "/api/clear", "POST", {})
        call(port, "/api/import", "POST", exported3)
        back3 = call(port, "/api/data")[1]
        check("导出导入往返带着债务数据", back3["debt"]["items"][0]["totalCents"] == 10000)

        cats = call(port, "/api/data")[1]["finance"]["categories"]
        check("记账分类里有「债务还款 / 债务收款」",
              "债务还款" in cats.get("expense", []) and "债务收款" in cats.get("income", []))

        # 图片附件：上传 → 落盘 → 取回 → 删除，一条线走完
        status, up = call(port, "/api/attachment", "POST", {
            "module": "finance", "ext": "png",
            "data": base64.b64encode(TINY_PNG).decode("ascii"),
        })
        check("能上传一张图片附件", status == 200 and up.get("ok"), str(up)[:80])
        rel = str(up.get("path") or "")
        on_disk = data_dir / "attachments" / "finance" / rel.rsplit("/", 1)[-1]
        check("图片落在 数据\\attachments\\finance\\ 里",
              rel.startswith("attachments/finance/") and on_disk.exists(),
              rel)
        check("图片的字节数没变", on_disk.exists() and on_disk.stat().st_size == len(TINY_PNG))
        status, served = fetch_raw(port, "/" + rel)
        check("图片能按相对路径取回来", status == 200 and served == TINY_PNG)
        health2 = call(port, "/api/health")[1]
        check("健康信息里带着附件目录和占用",
              str(health2.get("attachDir", "")).endswith("attachments")
              and health2.get("attachCount", 0) >= 1,
              "%s 张 / %s 字节" % (health2.get("attachCount"), health2.get("attachBytes")))

        status, bad = call(port, "/api/attachment", "POST", {
            "module": "别的地方", "ext": "png",
            "data": base64.b64encode(TINY_PNG).decode("ascii"),
        })
        check("往白名单以外的模块传图会被拒", status == 400 and not bad.get("ok"))
        status, bad2 = call(port, "/api/attachment", "POST", {
            "module": "finance", "ext": "gif",
            "data": base64.b64encode(TINY_PNG).decode("ascii"),
        })
        check("gif 这类不是白名单的格式会被拒", status == 400 and not bad2.get("ok"))
        status, bad3 = call(port, "/attachments/finance/..%2F..%2F%E6%95%B0%E6%8D%AE.json")
        check("拿 .. 去读附件目录以外的文件会被拒", status == 403, str(status))
        status, bad4 = call(port, "/attachments/finance/%E9%9A%8F%E4%BE%BF.png")
        check("文件名不合规的附件路径会被拒", status == 403, str(status))
        status, bad5 = call(port, "/attachments/%E5%88%AB%E7%9A%84/20261007_deadbeef.png")
        check("白名单以外的模块目录会被拒", status == 403, str(status))

        status, gone = call(port, "/api/attachment-delete", "POST", {"paths": [
            rel, "attachments/finance/../../数据.json", "attachments/buglog/20261007_deadbeef.png",
        ]})
        check("能删掉指定的图片",
              status == 200 and gone.get("deleted") == 1
              and gone.get("missing") == 1 and gone.get("refused") == 1,
              str(gone))
        check("删完文件真的不在了", not on_disk.exists())
        check("越界的路径一个都没动",
              (data_dir / "数据.json").exists() and call(port, "/api/data")[0] == 200)

        # 开发工作：bug 和项目进展各存各的格子
        status, up2 = call(port, "/api/attachment", "POST", {
            "module": "progress", "ext": "png",
            "data": base64.b64encode(TINY_PNG).decode("ascii"),
        })
        check("图片能存到 attachments/progress/（项目进展那一格）",
              status == 200 and str(up2.get("path", "")).startswith("attachments/progress/"),
              str(up2.get("path")))
        call(port, "/api/attachment-delete", "POST", {"paths": [up2.get("path")]})

        # 第二批模块的格子：今日计划 / 开发待办 / 学习记录 / 学习对象 / 训练打卡 / 游戏
        for module in ("today_plan", "dev_todo", "study_record", "study_item", "fitness", "game"):
            status, up3 = call(port, "/api/attachment", "POST", {
                "module": module, "ext": "png",
                "data": base64.b64encode(TINY_PNG).decode("ascii"),
            })
            ok = status == 200 and str(up3.get("path", "")).startswith("attachments/%s/" % module)
            check("图片能存到 attachments/%s/" % module, ok, str(up3.get("path")))
            call(port, "/api/attachment-delete", "POST", {"paths": [up3.get("path")]})

        # 老的任务 / 学习 / 游戏记录也要补齐新字段
        cur = call(port, "/api/data")[1]
        cur["tasks"] = [{"id": "t-selftest", "date": "2026-10-07", "text": "老任务",
                         "time": "", "category": "工作", "done": False, "note": "",
                         "belong": "plan"}]
        cur["studies"] = [{"id": "st-selftest", "subjectId": "s", "date": "2026-10-07",
                           "minutes": 30, "content": "老学习", "takeaway": "", "reviewed": False}]
        cur["subjects"] = [{"id": "s", "name": "老对象", "kind": "书", "source": "", "note": ""}]
        cur["workoutLogs"] = [{"id": "l-selftest", "date": "2026-10-07", "moves": "深蹲", "note": ""}]
        cur["games"] = [{"id": "g-selftest", "name": "老游戏", "platform": "PC",
                         "status": "在玩", "progress": "", "hours": 1}]
        call(port, "/api/data", "POST", cur)
        back2 = call(port, "/api/data")[1]
        fresh_ok = all(
            back2[key][0].get("imagePaths") == []
            for key in ("tasks", "studies", "subjects", "workoutLogs", "games")
        )
        check("老的任务 / 学习 / 对象 / 打卡 / 游戏读出来都带上 imagePaths: []", fresh_ok)
        check("老任务读出来带上 priority: 空（开发待办才有优先级）",
              back2["tasks"][0].get("priority") == "")

        # 老 bug 条目：字段补齐 + 状态改名（处理中 → 进行中、已解决 → 已修复）
        cur = call(port, "/api/data")[1]
        cur["issues"] = [
            {"id": "bug-selftest-1", "projectId": "p1", "title": "老条目",
             "severity": "高", "status": "处理中"},
            {"id": "bug-selftest-2", "projectId": "p1", "title": "更老的条目",
             "severity": "低", "status": "已解决"},
        ]
        cur["progress"] = [{"id": "prog-selftest", "projectId": "p1",
                            "date": "2026-10-07", "text": "自检的进展"}]
        call(port, "/api/data", "POST", cur)
        back = call(port, "/api/data")[1]
        bug1, bug2 = back["issues"][0], back["issues"][1]
        check("老 bug 条目补齐了详细描述 / 关联模块 / 时间字段",
              bug1.get("desc") == "" and bug1.get("module") == ""
              and bug1.get("createdAt") == "" and bug1.get("fixedAt") == "",
              str({k: bug1.get(k) for k in ("desc", "module", "createdAt", "fixedAt")}))
        check("老 bug 状态「处理中」迁成「进行中」", bug1.get("status") == "进行中", str(bug1.get("status")))
        check("老 bug 状态「已解决」迁成「已修复」", bug2.get("status") == "已修复", str(bug2.get("status")))
        check("老 bug 条目带上 imagePaths: []", bug1.get("imagePaths") == [])
        check("老进展条目也带上 imagePaths: []", back["progress"][0].get("imagePaths") == [])

        # 图片路径只写进 JSON，不写二进制；老记录读出来自动补 imagePaths
        cur = call(port, "/api/data")[1]
        check("老账目读出来自动带上 imagePaths: []",
              cur["finance"]["transactions"][0].get("imagePaths") == [])
        check("附件设置项读出来就带着默认值",
              cur.get("settings", {}).get("attachments") == {"pruneOnDelete": False, "maxEdge": 1920},
              str(cur.get("settings", {}).get("attachments")))

        # 自媒体：账号和粉丝快照要跟着导出导入走
        cur = call(port, "/api/data")[1]
        cur["mediaAccounts"] = [{
            "id": "acc-selftest", "name": "自检号", "platform": "B站", "intro": "",
            "baseFollowers": 100, "targetFollowers": 0, "note": "",
            "createdAt": "2026-10-07 12:00",
        }]
        cur["mediaFollowers"] = [{
            "id": "snap-selftest", "accountId": "acc-selftest",
            "date": "2026-10-07", "count": 260,
        }]
        cur["contents"] = [{
            "id": "c-selftest", "title": "自检作品", "accountId": "acc-selftest",
            "platform": "B站", "status": "写作中", "planDate": "2026-10-10",
            "publishDate": "", "link": "", "views": 0, "likes": 0, "comments": 0,
            "collects": 0, "fansGain": 0, "note": "",
        }]
        call(port, "/api/data", "POST", cur)
        status, exp4 = call(port, "/api/export", "POST", {})
        exported4 = json.loads(Path(exp4["path"]).read_text(encoding="utf-8"))
        call(port, "/api/clear", "POST", {})
        call(port, "/api/import", "POST", exported4)
        back4 = call(port, "/api/data")[1]
        check("导出导入往返带着自媒体账号和粉丝快照",
              back4["mediaAccounts"][0]["baseFollowers"] == 100
              and back4["mediaFollowers"][0]["count"] == 260)
        check("老数据里的「写作中」会迁成「撰写中」",
              back4["contents"][0]["status"] == "撰写中", str(back4["contents"][0]["status"]))

        # 清空
        status, cleared = call(port, "/api/clear", "POST", {})
        now = call(port, "/api/data")[1]
        check("清空后只剩空骨架",
              not now.get("tasks") and not now.get("contents")
              and now.get("mediaAccounts") == [] and now.get("mediaFollowers") == [])
        check("清空后记账回到空骨架",
              now.get("finance", {}).get("transactions") == []
              and now.get("finance", {}).get("budget", {}).get("monthlyTotalCents") == 0)
        check("清空后债务回到空骨架", now.get("debt", {}).get("items") == [])
        check("清空前会自动留一份快照",
              (data_dir / "备份" / cleared["snapshot"]).exists(), cleared.get("snapshot", ""))

        # 运行日志
        log_file = data_dir / "日志" / "运行.log"
        check("运行日志有内容", log_file.exists() and log_file.stat().st_size > 0)

    except Exception as exc:  # noqa: BLE001
        check("自检过程中没出岔子", False, "%s: %s" % (type(exc).__name__, exc))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        shutil.rmtree(workdir, ignore_errors=True)

    print("-" * 64)
    print("  通过 %d 项，失败 %d 项" % (len(ok_list), len(bad_list)))
    if bad_list:
        print("  失败的：")
        for name in bad_list:
            print("    - " + name)
    print("=" * 64)
    return 1 if bad_list else 0


if __name__ == "__main__":
    raise SystemExit(main())

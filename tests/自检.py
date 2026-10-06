# -*- coding: utf-8 -*-
"""小李 · 一键自检

在一个临时数据目录里自己起一个服务（**不会碰你正在用的数据**），
把关键接口从头到尾过一遍，最后打印一张清单。

用法：双击项目根目录的 自检.cmd；或者在终端运行
      python tests\\自检.py
"""

from __future__ import annotations

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
                "games", "settings", "finance"]
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

        # 清空
        status, cleared = call(port, "/api/clear", "POST", {})
        now = call(port, "/api/data")[1]
        check("清空后只剩空骨架", not now.get("tasks") and not now.get("contents"))
        check("清空后记账回到空骨架",
              now.get("finance", {}).get("transactions") == []
              and now.get("finance", {}).get("budget", {}).get("monthlyTotalCents") == 0)
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

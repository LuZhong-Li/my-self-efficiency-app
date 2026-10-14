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
import urllib.parse
import urllib.request
import zipfile
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


def call(port: int, path: str, method: str = "GET", body=None, origin: str | None = None,
         extra: dict | None = None):
    """返回 (状态码, 解析后的内容)。extra 是额外请求头（数据集那道闸用它）。"""
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if origin:
        headers["Origin"] = origin
    if extra:
        headers.update(extra)
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


def js_default_categories() -> dict:
    """把前端那份兜底分类抠出来（app/web/finance-calc.js 里的 DEFAULT_CATEGORIES）。

    它和服务端 default_finance() 是同一个约定，两份必须一模一样。抠不到就返回
    空字典，让下面那条检查报失败——宁可报红，也别悄悄放过。
    """
    text = (WEB / "finance-calc.js").read_text(encoding="utf-8")
    block = re.search(r"DEFAULT_CATEGORIES\s*=\s*\{(.*?)\n\};", text, re.S)
    if not block:
        return {}
    out = {}
    for kind in ("expense", "income"):
        found = re.search(kind + r"\s*:\s*\[(.*?)\]", block.group(1), re.S)
        if found:
            out[kind] = re.findall(r'"([^"]+)"', found.group(1))
    return out


def unquote_js(raw: str) -> str:
    """把单引号字符串的字面量解成真值（只处理 \\ 和 \' —— 这两处只用得到这两种）。

    JS 和 Python 在这两种转义上是一样的，所以同一个函数两边都能用。"""
    out = []
    i = 0
    while i < len(raw):
        if raw[i] == "\\" and i + 1 < len(raw):
            out.append(raw[i + 1])
            i += 2
            continue
        out.append(raw[i])
        i += 1
    return "".join(out)


def dataset_rules_in(path: Path) -> dict:
    """把某个文件里那三张表抠出来（数据集的命名规则）。

    服务端 app\\服务.py 和前端 app/web/dataset-calc.js 是同一套规矩、同一批文案，
    两份必须一模一样 —— 一份是「真拦」，另一份是「当场提示」，对不上就会出现
    「前端说能建、后端回 400」这种莫名其妙的现象。抠不到就少几项，检查自然报红。
    """
    text = path.read_text(encoding="utf-8")
    out = {}
    m = re.search(r"DATASET_NAME_MAX\s*=\s*(\d+)", text)
    if m:
        out["max"] = int(m.group(1))
    m = re.search(r"DATASET_BAD_CHARS\s*=\s*'((?:[^'\\]|\\.)*)'", text)
    if m:
        out["bad"] = unquote_js(m.group(1))
    m = (re.search(r"DATASET_RESERVED\s*=\s*\[(.*?)\]", text, re.S)
         or re.search(r"DATASET_RESERVED\s*=\s*\{(.*?)\n\}", text, re.S))
    if m:
        # 显式写出来的那几个（会含 f"com{i}" 这种带花括号的，滤掉）
        explicit = [s for s in re.findall(r'"([^"]+)"', m.group(1)) if "{" not in s]
        # 两个 range 生成的那两组（服务端是用 range 写的，前端是老实列出来的）
        gen = [p + str(i) for p in ("com", "lpt") for i in range(1, 10)]
        out["reserved"] = sorted(set(explicit) | set(gen))
    return out


def check_dataset_rules() -> None:
    """数据集名字的规则：服务端和前端那三张表必须一模一样。"""
    py_rules = dataset_rules_in(ROOT / "app" / "服务.py")
    js_rules = dataset_rules_in(WEB / "dataset-calc.js")
    check("数据集名字的长度上限前后端一致",
          py_rules.get("max") == js_rules.get("max") and py_rules.get("max") is not None,
          "服务端 %s / 前端 %s" % (py_rules.get("max"), js_rules.get("max")))
    check("数据集名字的禁用字符前后端一致",
          py_rules.get("bad") == js_rules.get("bad") and bool(py_rules.get("bad")),
          "服务端 %r / 前端 %r" % (py_rules.get("bad"), js_rules.get("bad")))
    check("数据集的系统保留名前后端一致",
          py_rules.get("reserved") == js_rules.get("reserved")
          and len(py_rules.get("reserved") or []) == 22,
          "服务端 %s / 前端 %s" % (py_rules.get("reserved"), js_rules.get("reserved")))


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


def start_temp_server(data_dir: Path, root: Path | None = None, expect_under: Path | None = None):
    """起一个临时服务，返回 (进程, 端口, 它自己报的 health)。

    给了 root 就走「根目录 + 数据集」那条新语义（XIAOLI_DATA_ROOT），
    只给 data_dir 就走今天这条老语义（XIAOLI_DATA_DIR = 就是这一份）。
    两个变量都要先清掉再按需要设：环境里留着上一个的话，这条测试就不是它想测的那件事了。
    """
    port = free_port()
    env = dict(os.environ)
    env.pop("XIAOLI_DATA_DIR", None)
    env.pop("XIAOLI_DATA_ROOT", None)
    if root is not None:
        env["XIAOLI_DATA_ROOT"] = str(root)
    else:
        env["XIAOLI_DATA_DIR"] = str(data_dir)
    proc = subprocess.Popen(
        [sys.executable, str(SERVER), "--no-browser", "--port", str(port)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    health = None
    for _ in range(40):
        time.sleep(0.25)
        status, body = call(port, "/api/health")
        if status == 200 and isinstance(body, dict):
            health = body
            break
    # 安全网：临时服务必须真的用临时目录。万一哪个环境变量没被认出来（2026-10-14
    # 就真发生过一次：XIAOLI_DATA_ROOT 还没实现，服务退回去用了项目里那份真实数据），
    # 必须当场停掉、报一条失败 —— 绝不能继续对着真实数据跑下去。
    if health is not None and expect_under is not None:
        inside = str(expect_under) in str(health.get("dataFile", ""))
        if not inside:
            stop_server(proc)
            check("临时服务用的是临时目录（不是项目里那份真实数据）", False,
                  "它说数据文件在 " + str(health.get("dataFile")))
            return proc, port, None
        check("临时服务用的是临时目录（不是项目里那份真实数据）", True)
    return proc, port, health


def stop_server(proc) -> None:
    if not proc:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()


def dict_or(value) -> dict:
    """接口返回的得是个字典；不是就当空字典（断言会因此报红，而不是把自检崩掉）"""
    return value if isinstance(value, dict) else {}


def read_text_or(path: Path, fallback: str = "") -> str:
    """读一个小文本文件；文件不在就给 fallback。
    断言里用它是为了「文件没生成」这条能报成一条失败，而不是把整段自检崩掉。"""
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return fallback


def check_datasets() -> None:
    """数据集（多套数据文件）：老布局自动搬迁 / 列表 / 关掉功能的两种情形。

    单开一份临时根目录 + 一个服务，不去碰上面那个 XIAOLI_DATA_DIR 的临时目录：
    上面那一大段跑的是「就是这一份」的老语义，这里要的是「根目录 + 数据集」的新语义。
    """
    print("\n  数据集（多套数据文件）")
    workdir = Path(tempfile.mkdtemp(prefix="xiaoli-ds-"))
    root = workdir / "数据"
    root.mkdir(parents=True, exist_ok=True)
    # 老布局：数据直接躺在根目录下，还带着一张图片附件
    (root / "数据.json").write_text(
        json.dumps({"version": 1, "rev": 3, "memo": "老布局", "tasks": [], "settings": {}},
                   ensure_ascii=False), encoding="utf-8")
    (root / "attachments" / "finance").mkdir(parents=True, exist_ok=True)
    (root / "attachments" / "finance" / "a.png").write_bytes(TINY_PNG)

    proc = None
    try:
        proc, port, health = start_temp_server(None, root=root, expect_under=workdir)
        check("数据集模式下服务起得来", bool(health))
        if health:
            check("老数据自动搬进 数据\\默认\\",
                  (root / "默认" / "数据.json").exists() and not (root / "数据.json").exists())
            check("图片附件也一起搬过去",
                  (root / "默认" / "attachments" / "finance" / "a.png").exists())
            check("当前数据集写进了 当前数据集.txt",
                  read_text_or(root / "当前数据集.txt").strip() == "默认")
            check("health 报出当前数据集和根目录",
                  health.get("dataset") == "默认" and health.get("datasetsEnabled") is True
                  and str(root) == str(health.get("dataRoot")),
                  str({k: health.get(k) for k in ("dataset", "datasetsEnabled", "dataRoot")}))
            check("搬迁之后数据文件路径指向 默认\\",
                  str(root / "默认") in str(health.get("dataFile")), str(health.get("dataFile")))
            check("老数据的内容一个字没动", call(port, "/api/data")[1].get("memo") == "老布局")
            check("老数据里的修订号也没动", call(port, "/api/data")[1].get("rev") == 3)
            items = dict_or(call(port, "/api/datasets")[1])
            check("列表里有「默认」这一份，并标出它是当前那份",
                  items.get("enabled") is True and items.get("current") == "默认"
                  and [i["name"] for i in items["items"]] == ["默认"], str(items)[:90])
            check("列表报出这份数据的条数",
                  isinstance(items["items"][0].get("count"), int)
                  and str(items["items"][0].get("dataFile", "")).endswith("数据.json"))
            check("搬迁这件事写进了运行日志",
                  (root / "默认" / "日志" / "运行.log").exists()
                  and "老布局搬进" in read_text_or(root / "默认" / "日志" / "运行.log"),
                  "日志里应该有一行「老布局搬进 默认\\」")

            # 坏名字：一个都别想建出来（含想跑到根目录外面去的）
            for bad in ("", "   ", "../跑出去", "带/斜杠", "带\\反斜杠", "a:b", "带*星号",
                        "con", "..", ".", ".隐藏", "结尾是点.", "x" * 25):
                status, err = call(port, "/api/dataset-new", "POST", {"name": bad})
                check("坏名字「%s」被拦下" % (bad or "空"), status == 400, str(err)[:70])

            # 新建：建得出来，但**不**切过去
            status, made = call(port, "/api/dataset-new", "POST", {"name": "工作"})
            check("能新建一份数据集", status == 200 and (root / "工作" / "数据.json").exists(),
                  str(made)[:70])
            check("新建的不自动切过去（还在默认）",
                  call(port, "/api/health")[1].get("dataset") == "默认")
            made_items = dict_or(call(port, "/api/datasets")[1]).get("items") or []
            check("新那份是空骨架（多了那一条，条数是 0）",
                  len(made_items) == 2 and made_items[1].get("count") == 0, str(made_items)[:90])
            status, dup = call(port, "/api/dataset-new", "POST", {"name": "工作"})
            check("重名的新建被拦下", status == 400 and "已经有一份" in str(dup), str(dup)[:70])

            # 切过去
            cur = call(port, "/api/data")[1]
            status, sw = call(port, "/api/dataset-switch", "POST",
                              {"name": "工作", "rev": cur["rev"]})
            check("能切到新建的那一份", status == 200 and sw.get("ok"), str(sw)[:70])
            check("切过去之后读的是新那份（空骨架，不是老数据）",
                  call(port, "/api/data")[1].get("memo") == "")
            check("数据文件真的换到 工作\\ 下面",
                  str(root / "工作") in str(call(port, "/api/health")[1].get("dataFile")))
            status, stale = call(port, "/api/dataset-switch", "POST",
                                 {"name": "默认", "rev": int(cur["rev"]) + 5})
            check("切换时修订号对不上会被拦下（防「切的那一下正有人存」）",
                  status == 409 and stale.get("conflict") is True, str(stale)[:80])

            # 防串数据：拿着「默认」那份的名字去存，必须被挡回去
            status, denied = call(port, "/api/data", "POST", cur,
                                  extra={"X-XiaoLi-Dataset": urllib.parse.quote("默认")})
            check("旧窗口带着旧数据集名保存会被挡回去（防串数据）",
                  status == 409 and denied.get("conflict") is True, str(denied)[:90])
            check("挡回去之后那份数据没被写坏", call(port, "/api/data")[1].get("memo") == "")
            fresh = call(port, "/api/data")[1]
            fresh["memo"] = "工作在写"
            status, ok2 = call(port, "/api/data", "POST", fresh,
                               extra={"X-XiaoLi-Dataset": urllib.parse.quote("工作")})
            check("带着当前数据集名保存照常成功", status == 200 and ok2.get("ok"), str(ok2)[:70])

            # 往「工作」里放一张图（走现成的附件接口，它会写进当前数据集的 attachments\）：
            # 后面验导出 zip 到底有没有把图片带着走，靠它
            status, up = call(port, "/api/attachment", "POST", {
                "module": "finance", "ext": "png",
                "data": base64.b64encode(TINY_PNG).decode("ascii"),
            })
            check("附件写进了当前数据集的 attachments\\",
                  status == 200 and (root / "工作" / "attachments" / "finance").exists(),
                  str(up.get("path")))

            # 切回来：默认那份的数据还在（两份各是各的）
            status, back = call(port, "/api/dataset-switch", "POST", {"name": "默认"})
            check("能切回默认", status == 200, str(back)[:70])
            check("切回来数据还在", call(port, "/api/data")[1].get("memo") == "老布局")
            items2 = dict_or(call(port, "/api/datasets")[1])["items"]
            check("列表里两份都在，当前那份标出来",
                  sorted(i["name"] for i in items2) == ["工作", "默认"]
                  and [i["name"] for i in items2 if i["current"]] == ["默认"], str(items2)[:90])

            # 重命名：文件夹是改名不是重建，里面的数据一个字不动
            status, ren = call(port, "/api/dataset-rename", "POST",
                               {"name": "工作", "to": "工作A"})
            check("能重命名数据集",
                  status == 200 and (root / "工作A" / "数据.json").exists()
                  and not (root / "工作").exists(), str(ren)[:70])
            check("重命名之后里面的数据还在（「工作在写」那句还在）",
                  "工作在写" in read_text_or(root / "工作A" / "数据.json"))
            status, ren_bad = call(port, "/api/dataset-rename", "POST",
                                   {"name": "工作A", "to": "a/b"})
            check("重命名成坏名字也被拦下", status == 400, str(ren_bad)[:70])

            # 导出 zip：落在**当前**数据集的 导出\ 里（「打开导出文件夹」开的就是它）
            status, ex = call(port, "/api/dataset-export", "POST", {"name": "工作A"})
            zpath = Path(str(ex.get("path") or "x"))
            check("能导出成 zip",
                  status == 200 and zpath.exists() and zpath.stat().st_size > 0, str(ex)[:80])
            check("zip 落在当前数据集的 导出\\ 里",
                  str(root / "默认" / "导出") in str(zpath), str(zpath))
            names_in_zip = []
            try:
                with zipfile.ZipFile(zpath) as zf:
                    names_in_zip = zf.namelist()
            except Exception as exc:  # noqa: BLE001
                names_in_zip = ["打不开：" + str(exc)]
            check("zip 里带着那份数据的 数据.json",
                  any(n.endswith("数据.json") for n in names_in_zip), str(names_in_zip[:4]))
            check("zip 里带着图片附件",
                  any(n.startswith("工作A/attachments/") for n in names_in_zip),
                  str(names_in_zip[:4]))
    finally:
        stop_server(proc)
        shutil.rmtree(workdir, ignore_errors=True)

    # 设了 XIAOLI_DATA_DIR：数据集功能整体关掉，行为回到今天这样
    print("\n  XIAOLI_DATA_DIR 时：数据集功能关着")
    workdir2 = Path(tempfile.mkdtemp(prefix="xiaoli-ds-off-"))
    proc2 = None
    try:
        proc2, port2, health2 = start_temp_server(workdir2 / "数据", expect_under=workdir2)
        check("关掉功能时服务照旧起得来", bool(health2))
        if health2:
            check("health 说数据集功能关着", health2.get("datasetsEnabled") is False,
                  str(health2.get("datasetsEnabled")))
            check("关掉时当前数据集是空串（状态栏不显示名字）",
                  health2.get("dataset") == "")
            off = dict_or(call(port2, "/api/datasets")[1])
            check("关掉时列表是空的、enabled 为假",
                  off.get("enabled") is False and off.get("items") == [], str(off)[:80])
            check("关掉时数据文件就在指定的那个目录里（老语义不变）",
                  str(workdir2 / "数据") in str(health2.get("dataFile")),
                  str(health2.get("dataFile")))
            check("关掉时不搞搬迁（根目录里不会被塞出一个 默认\\）",
                  not (workdir2 / "数据" / "当前数据集.txt").exists()
                  and not (workdir2 / "数据" / "默认").exists())
    finally:
        stop_server(proc2)
        shutil.rmtree(workdir2, ignore_errors=True)


def main() -> int:
    print("=" * 64)
    print("  小李 · 一键自检")
    print("=" * 64)

    check("服务脚本在位", SERVER.exists(), str(SERVER))
    check_no_external()
    check_dataset_rules()

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
                "games", "gameRecords", "settings", "finance", "debt", "mediaAccounts",
                "mediaFollowers", "mediaAssets", "moduleGoals",
                "workLogs", "foods", "notes"]
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

        # 写入闸（数据.lock）：一个窗口正在写的时候，另一个窗口的保存被挡回去，不覆盖
        lock_file = data_dir / "数据.lock"
        cur = call(port, "/api/data")[1]
        lock_file.write_text("99999 自检占位", encoding="utf-8")
        status, busy = call(port, "/api/data", "POST", cur)
        check("别人正拿着写入锁时保存被挡回去（返回忙，不覆盖磁盘）",
              status == 409 and busy.get("busy") is True, str(busy)[:80])
        lock_file.unlink()

        # 上次崩了留下的过期锁：超过 10 秒就算残留，清掉重来，保存照常
        cur = call(port, "/api/data")[1]
        lock_file.write_text("99999 崩溃残留", encoding="utf-8")
        old = time.time() - 60
        os.utime(lock_file, (old, old))
        status, saved_after = call(port, "/api/data", "POST", cur)
        check("过期的残留锁会被自动清掉，保存照常成功",
              status == 200 and saved_after.get("ok"), str(saved_after)[:80])
        check("保存完写入锁不残留", not lock_file.exists())

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
        cur["finance"]["transfers"] = [{
            "id": "tf-selftest", "amountCents": 50000, "date": "2026-10-07",
            "fromAccountId": "acc-a", "toAccountId": "acc-b", "note": "自检转账",
            "imagePaths": [],
        }]
        call(port, "/api/data", "POST", cur)

        status, exp2 = call(port, "/api/export", "POST", {})
        exported2 = json.loads(Path(exp2["path"]).read_text(encoding="utf-8"))
        call(port, "/api/clear", "POST", {})
        call(port, "/api/import", "POST", exported2)
        back2 = call(port, "/api/data")[1]
        check("导出导入往返带着记账数据",
              back2["finance"]["transactions"][0]["amountCents"] == 2550
              and back2["finance"]["budget"]["monthlyTotalCents"] == 200000)
        check("导出导入往返带着转账",
              back2["finance"]["transfers"][0]["amountCents"] == 50000
              and back2["finance"]["transfers"][0]["toAccountId"] == "acc-b",
              str(back2["finance"].get("transfers")))

        # 转账（2026-10-12 新增）：老数据没有这个键（或者某一行缺字段），读出来补齐，
        # 已有的值一个都不动。
        cur = call(port, "/api/data")[1]
        cur["finance"].pop("transfers", None)
        call(port, "/api/data", "POST", cur)
        back3 = call(port, "/api/data")[1]
        check("老数据没有 transfers 读出来补成空表",
              back3["finance"].get("transfers") == [],
              str(back3["finance"].get("transfers")))

        cur = call(port, "/api/data")[1]
        cur["finance"]["transfers"] = [{"id": "tf-old", "amountCents": 100}]
        call(port, "/api/data", "POST", cur)
        old_tf = call(port, "/api/data")[1]["finance"]["transfers"][0]
        check("老转账缺的字段读出来补齐（日期 / 两个账户 / 备注 / 图片）",
              old_tf.get("date") == "" and old_tf.get("fromAccountId") == ""
              and old_tf.get("toAccountId") == "" and old_tf.get("note") == ""
              and old_tf.get("imagePaths") == [] and old_tf.get("amountCents") == 100,
              str(old_tf))

        # 常用模板（2026-10-13 新增）：只是个新键，骨架里带上之后老数据读到就自动有了；
        # 行内的字段规整交给前端（finance-calc 的 normalizeTemplate），服务端不碰内容。
        cur = call(port, "/api/data")[1]
        cur["finance"].pop("templates", None)
        call(port, "/api/data", "POST", cur)
        check("老数据没有 templates 读出来补成空表",
              call(port, "/api/data")[1]["finance"].get("templates") == [],
              str(call(port, "/api/data")[1]["finance"].get("templates")))

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
        # 前端也留了一份兜底分类：服务端那个进程还停在旧版本上时（2026-10-08 那次
        # 就是进程从 10-06 起没重启过），「记一笔」里那排分类按钮不至于空一片。
        # 两份必须一致，否则服务端补的跟前端兜底的会走岔。
        js_cats = js_default_categories()
        check("前端兜底分类跟服务端骨架一模一样",
              bool(js_cats) and js_cats.get("expense") == cats.get("expense")
              and js_cats.get("income") == cats.get("income"),
              "前端 %s / 服务端 %s" % (js_cats, cats))

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
        for module in ("today_plan", "dev_project", "dev_todo", "study_record",
                       "study_item", "fitness", "game", "game_record"):
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
                         "belong": "plan", "tags": ["保留我"]}]
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
        # 标签（2026-10-11 新增）：没写过的读出来补一个空数组，页面那边就不用处处判空；
        # 自己写过的原样留着 —— 迁移只补缺的，不清洗、不排序、不去重。
        tags_filled = all(
            back2[key][0].get("tags") == []
            for key in ("studies", "subjects", "workoutLogs", "games")
        )
        check("老的学习 / 对象 / 打卡 / 游戏读出来都带上 tags: []", tags_filled,
              str({k: back2[k][0].get("tags") for k in ("studies", "subjects", "workoutLogs", "games")}))
        check("老任务自己写过的标签一个字节都没动",
              back2["tasks"][0].get("tags") == ["保留我"],
              str(back2["tasks"][0].get("tags")))
        check("老任务读出来带上 priority: 空（开发待办才有优先级）",
              back2["tasks"][0].get("priority") == "")
        # 跨模块联动那个「加入今日计划」开关也是后加的，老任务补 False
        check("老任务读出来补齐「加入今日计划」开关（默认关）",
              back2["tasks"][0].get("isTodayPlan") is False)
        # 重复任务与子任务（2026-10-14 新增）：规则带 repeat / repeatUntil / lastRun 三格，
        # 每条待办带一个 subtasks 数组。老数据一律补齐，形状统一，页面就不用到处判空。
        check("老任务读出来带上重复规则那三格（默认空）",
              back2["tasks"][0].get("repeat") == ""
              and back2["tasks"][0].get("repeatUntil") == ""
              and back2["tasks"][0].get("lastRun") == "",
              str({k: back2["tasks"][0].get(k)
                   for k in ("repeat", "repeatUntil", "lastRun")}))
        check("老任务读出来带上空的子任务清单", back2["tasks"][0].get("subtasks") == [],
              str(back2["tasks"][0].get("subtasks")))
        check("老任务读出来也补齐归档标记（默认没归档）",
              back2["tasks"][0].get("isArchived") is False
              and back2["tasks"][0].get("archivedAt") == "",
              str({k: back2["tasks"][0].get(k) for k in ("isArchived", "archivedAt")}))
        check("老游戏手填的 hours 一个字节都没动", back2["games"][0].get("hours") == 1,
              str(back2["games"][0].get("hours")))
        check("老游戏补齐「每月目标 / 通关日期」两格",
              back2["games"][0].get("targetHours") == 0
              and back2["games"][0].get("finishDate") == "",
              str({k: back2["games"][0].get(k) for k in ("targetHours", "finishDate")}))
        # 手改过 / 别处写进来的子任务：形状补齐（缺 id 的补一个），文字一个字节都不动
        cur_st = call(port, "/api/data")[1]
        cur_st["tasks"] = [{"id": "t-sub", "text": "带子任务的老待办", "date": "2026-10-07",
                            "belong": "plan",
                            "subtasks": [{"text": "改侧栏", "done": True},
                                         {"id": "st-keep", "text": "改首页", "done": False}]}]
        call(port, "/api/data", "POST", cur_st)
        back_st = call(port, "/api/data")[1]["tasks"][0]["subtasks"]
        check("手写的子任务补齐 id / done，文字不动",
              back_st[0].get("text") == "改侧栏" and back_st[0].get("done") is True
              and bool(back_st[0].get("id"))
              and back_st[1].get("id") == "st-keep" and back_st[1].get("done") is False,
              str(back_st))
        # 工时（2026-10-14 新增）：开发工作底下「哪天在哪个项目上花了多久」。
        # 老数据没有这个键就补一张空表；有的逐条补齐字段，一条都不丢。
        check("没有 workLogs 的老数据读出来补成空表",
              back2.get("workLogs") == [], str(back2.get("workLogs")))
        cur_wl = call(port, "/api/data")[1]
        cur_wl["workLogs"] = [{"date": "2026-10-14", "minutes": 90, "note": "手写的一条"}]
        call(port, "/api/data", "POST", cur_wl)
        back_wl = call(port, "/api/data")[1]["workLogs"][0]
        check("手写的工时补齐 id / 项目 / 标签，分钟与备注不动",
              bool(back_wl.get("id")) and back_wl.get("minutes") == 90
              and back_wl.get("note") == "手写的一条" and back_wl.get("projectId") == ""
              and back_wl.get("tags") == [],
              str(back_wl))
        # 热量营养（2026-10-14 新增）：菜谱是顶层一张新表，吃了什么挂在 meals 那条的 items 上。
        # 老数据没有 foods 就补一张空表；meals 逐条补 items（[]），一条都不丢。
        check("没有 foods 的老数据读出来补成空表", back2.get("foods") == [],
              str(back2.get("foods")))
        check("老数据的 meals 逐条补上空的 items",
              all(isinstance(m.get("items"), list) for m in back2.get("meals") or []),
              str(back2.get("meals")))
        cur_nu = call(port, "/api/data")[1]
        cur_nu["foods"] = [{"name": "米饭", "unit": "碗", "kcal": 200}]
        cur_nu["meals"] = [{"date": "2026-10-14", "breakfast": "米饭", "lunch": "",
                            "dinner": "", "snack": "",
                            "items": [{"slot": "breakfast", "name": "米饭", "amount": 1.5,
                                       "kcal": 200}]}]
        call(port, "/api/data", "POST", cur_nu)
        back_nu = call(port, "/api/data")[1]
        back_food = back_nu["foods"][0]
        back_item = back_nu["meals"][0]["items"][0]
        check("手写的菜谱补齐 id / 标签，热量不动",
              bool(back_food.get("id")) and back_food.get("kcal") == 200
              and back_food.get("name") == "米饭" and back_food.get("tags") == [],
              str(back_food))
        check("手写的饮食条目补齐 id / 项目 / 单位 / 三格营养，份数与热量不动",
              bool(back_item.get("id")) and back_item.get("amount") == 1.5
              and back_item.get("kcal") == 200 and back_item.get("slot") == "breakfast"
              and back_item.get("foodId") == "" and back_item.get("protein") == 0,
              str(back_item))
        # 笔记（2026-10-14 新增）：第 11 个模块「笔记」，一张顶层表。
        # 老数据没有这个键就补一张空表；有的逐条补齐字段，正文一个字都不动。
        check("没有 notes 的老数据读出来补成空表", back2.get("notes") == [],
              str(back2.get("notes")))
        cur_nt = call(port, "/api/data")[1]
        cur_nt["notes"] = [{"title": "手写的一条", "body": "# 你好\n- 一\n- 二"}]
        call(port, "/api/data", "POST", cur_nt)
        back_nt = call(port, "/api/data")[1]["notes"][0]
        check("手写的笔记补齐 id / 标签 / 图片 / 时间，标题与正文不动",
              bool(back_nt.get("id")) and back_nt.get("title") == "手写的一条"
              and back_nt.get("body") == "# 你好\n- 一\n- 二"
              and back_nt.get("tags") == [] and back_nt.get("imagePaths") == []
              and back_nt.get("createdAt") == "" and back_nt.get("updatedAt") == "",
              str(back_nt))
        # 素材库（2026-10-14 搬到顶层）：老的 mediaAssets 并进 assets（id 不变、内容不动），
        # 并完把老表清空 —— 这是「搬家」，不是改数据。
        check("没有 assets 又没素材的老数据读出来补成空表", back2.get("assets") == [],
              str(back2.get("assets")))
        cur_as = call(port, "/api/data")[1]
        cur_as["assets"] = []
        cur_as["mediaAssets"] = [{"id": "a-old", "title": "老的素材", "kind": "link",
                                  "url": "example.com/x", "note": "",
                                  "createdAt": "2026-10-01"}]
        cur_as["tasks"] = [{"id": "t-as", "text": "带素材的待办", "date": "2026-10-07",
                            "belong": "plan", "assetIds": ["a-old"]},
                           {"id": "t-plain", "text": "没素材的待办", "date": "2026-10-07",
                            "belong": "plan"}]
        call(port, "/api/data", "POST", cur_as)
        back_as = call(port, "/api/data")[1]
        check("老 mediaAssets 搬进了 assets（id 与内容都不动）",
              [a.get("id") for a in back_as.get("assets") or []] == ["a-old"]
              and back_as["assets"][0].get("title") == "老的素材"
              and back_as["assets"][0].get("url") == "example.com/x",
              str(back_as.get("assets")))
        check("搬完之后老表清空（不重复留一份）", back_as.get("mediaAssets") == [],
              str(back_as.get("mediaAssets")))
        check("待办自己写过的 assetIds 一个字节都没动",
              back_as["tasks"][0].get("assetIds") == ["a-old"],
              str(back_as["tasks"][0].get("assetIds")))
        check("老待办读出来补上空的 assetIds",
              back_as["tasks"][1].get("assetIds") == [],
              str(back_as["tasks"][1].get("assetIds")))
        check("没有 gameRecords 的老数据读出来补成空表",
              back2.get("gameRecords") == [], str(back2.get("gameRecords")))

        # 游玩记录（2026-10-07 新增）：单独一张 gameRecords 表，字段补齐，导出导入带着走
        cur = call(port, "/api/data")[1]
        cur["gameRecords"] = [{
            "id": "play-selftest", "gameId": "g-selftest", "gameName": "老游戏",
            "playDate": "2026-10-07", "durationMin": 120, "remark": "自检",
        }]
        call(port, "/api/data", "POST", cur)
        plays = call(port, "/api/data")[1]["gameRecords"]
        check("游玩记录能整份写回并读回来",
              plays[0]["durationMin"] == 120 and plays[0]["gameName"] == "老游戏",
              str(plays[0]))
        check("游玩记录的缺省字段读出来补齐（createAt / imagePaths）",
              plays[0].get("createAt") == "" and plays[0].get("imagePaths") == [],
              str({k: plays[0].get(k) for k in ("createAt", "imagePaths")}))

        status, exp5 = call(port, "/api/export", "POST", {})
        exported5 = json.loads(Path(exp5["path"]).read_text(encoding="utf-8"))
        call(port, "/api/clear", "POST", {})
        call(port, "/api/import", "POST", exported5)
        back_play = call(port, "/api/data")[1]
        check("导出导入往返带着游玩记录",
              back_play["gameRecords"][0]["durationMin"] == 120
              and back_play["gameRecords"][0]["gameId"] == "g-selftest")

        # 项目也扩了字段（详细描述 / 预计结束 / 图片）
        cur = call(port, "/api/data")[1]
        cur["projects"] = [{"id": "p-selftest", "name": "老项目", "status": "进行中",
                            "intro": "一句话", "startDate": "2026-10-01"}]
        call(port, "/api/data", "POST", cur)
        back3 = call(port, "/api/data")[1]
        proj = back3["projects"][0]
        check("老项目补齐了详细描述 / 预计结束日期 / imagePaths",
              proj.get("description") == "" and proj.get("expectEndDate") == ""
              and proj.get("imagePaths") == [],
              str({k: proj.get(k) for k in ("description", "expectEndDate", "imagePaths")}))
        check("老项目的「一句话简介」还是 intro，没被改名",
              proj.get("intro") == "一句话")

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
        check("老 bug 条目补齐归档标记（默认没归档）",
              bug1.get("isArchived") is False and bug1.get("archivedAt") == "",
              str({k: bug1.get(k) for k in ("isArchived", "archivedAt")}))
        check("老进展条目也带上 imagePaths: []", back["progress"][0].get("imagePaths") == [])

        # 归档是「状态分流」不是删除：归档的条目导出、导入之后一条都不能少
        cur = call(port, "/api/data")[1]
        cur["issues"][0]["isArchived"] = True
        cur["issues"][0]["archivedAt"] = "2026-10-08 09:00"
        cur["tasks"][0]["isArchived"] = True
        cur["tasks"][0]["archivedAt"] = "2026-10-08 09:30"
        call(port, "/api/data", "POST", cur)
        status, exp_arch = call(port, "/api/export", "POST", {})
        call(port, "/api/import", "POST", exp_arch)
        back_arch = call(port, "/api/data")[1]
        check("归档条目导出导入之后还在（归档不删数据）",
              back_arch["issues"][0].get("isArchived") is True
              and back_arch["issues"][0].get("archivedAt") == "2026-10-08 09:00"
              and back_arch["tasks"][0].get("isArchived") is True
              and back_arch["tasks"][0].get("archivedAt") == "2026-10-08 09:30",
              str({k: back_arch["issues"][0].get(k) for k in ("isArchived", "archivedAt")}))

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

        # 素材库（2026-10-14 新增）：新键由骨架补；老作品的 assetIds 补空数组；
        # 导出来的一份里，素材本身也要跟着走
        cur = call(port, "/api/data")[1]
        cur.pop("mediaAssets", None)
        cur["contents"] = [{"id": "c-old", "title": "老作品", "status": "想法",
                            "accountId": "", "platform": "B站"}]
        cur["mediaAssets"] = [{
            "id": "asset-selftest", "title": "自检素材", "kind": "link",
            "url": "https://example.com/a", "note": "参考", "createdAt": "2026-10-14 10:00",
        }]
        call(port, "/api/data", "POST", cur)
        back_assets = call(port, "/api/data")[1]
        # 2026-10-14 晚：素材库升级成全站版，这一条从「mediaAssets 原样留着」改成
        # 「搬进顶层 assets、老表清空」（内容与 id 一个字节都不动，只是换了家）
        check("老 mediaAssets 搬进了顶层 assets，老表清空",
              back_assets.get("mediaAssets") == []
              and any(a.get("id") == "asset-selftest"
                      and a.get("url") == "https://example.com/a"
                      for a in back_assets.get("assets") or []),
              str([back_assets.get("assets"), back_assets.get("mediaAssets")]))
        check("老作品的 assetIds 补齐成空数组",
              back_assets["contents"][0].get("assetIds") == [],
              str(back_assets["contents"][0].get("assetIds")))

        # 模块目标（健身 / 学习 / 饮食）：顶层一个 moduleGoals，按模块 id 分桶
        cur = call(port, "/api/data")[1]
        cur.pop("moduleGoals", None)                 # 装成一份老数据：压根没有这个键
        call(port, "/api/data", "POST", cur)
        back5 = call(port, "/api/data")[1]
        check("老数据没有 moduleGoals 也会自动补成空对象",
              back5.get("moduleGoals") == {}, str(back5.get("moduleGoals")))

        cur = call(port, "/api/data")[1]
        cur["moduleGoals"] = {"fitness": [{
            "id": "goal-selftest", "moduleName": "健身计划", "mainTarget": "三个月减 8kg",
            "cycle": "月度", "startDate": "2026-10-01", "endDate": "2026-12-31",
            "dailyRule": "每周一、三、五力量训练", "remark": "",
        }]}
        call(port, "/api/data", "POST", cur)
        back6 = call(port, "/api/data")[1]
        goal = back6["moduleGoals"]["fitness"][0]
        check("模块目标能整份写回并读回来",
              goal["mainTarget"] == "三个月减 8kg" and goal["cycle"] == "月度"
              and goal["moduleId"] == "fitness",
              str({k: goal.get(k) for k in ("moduleId", "cycle", "startDate")}))
        check("目标的开关和自动生成缺省都是开",
              goal["isActive"] is True and goal["autoTask"] is True,
              str({k: goal.get(k) for k in ("isActive", "autoTask")}))

        # 万一手写成了数组：按 moduleId 归成桶，一条都不能丢
        cur = call(port, "/api/data")[1]
        cur["moduleGoals"] = [
            {"id": "goal-a", "moduleId": "fitness", "mainTarget": "减脂"},
            {"id": "goal-b", "moduleId": "study", "mainTarget": "每天学 2 小时"},
        ]
        call(port, "/api/data", "POST", cur)
        back7 = call(port, "/api/data")[1]
        check("moduleGoals 写成数组时按模块归桶，两条都不丢",
              [g["id"] for g in back7["moduleGoals"].get("fitness", [])] == ["goal-a"]
              and [g["id"] for g in back7["moduleGoals"].get("study", [])] == ["goal-b"],
              str(back7.get("moduleGoals")))

        # 清空
        status, cleared = call(port, "/api/clear", "POST", {})
        now = call(port, "/api/data")[1]
        check("清空后只剩空骨架",
              not now.get("tasks") and not now.get("contents")
              and now.get("mediaAccounts") == [] and now.get("mediaFollowers") == []
              and now.get("gameRecords") == [], str(now.get("gameRecords")))
        check("清空后记账回到空骨架",
              now.get("finance", {}).get("transactions") == []
              and now.get("finance", {}).get("budget", {}).get("monthlyTotalCents") == 0)
        check("清空后债务回到空骨架", now.get("debt", {}).get("items") == [])
        check("清空后模块目标也回到空对象", now.get("moduleGoals") == {}, str(now.get("moduleGoals")))
        check("清空前会自动留一份快照",
              (data_dir / "备份" / cleared["snapshot"]).exists(), cleared.get("snapshot", ""))

        # 磁盘上那份「少了版本字段」的老数据（手写、或者拿老备份直接盖回来的）：
        # 读出来必须自动补齐，否则页面读不到修订号，防覆盖那道闸就被悄悄绕过了。
        old_file = data_dir / "数据.json"
        old_file.write_text(json.dumps(
            {"version": 1, "memo": "没有修订号的老文件", "tasks": [], "settings": {}},
            ensure_ascii=False), encoding="utf-8")
        no_rev = call(port, "/api/data")[1]
        check("老数据没有 rev 时读出来自动补一个数字（不然防覆盖的闸会被绕过）",
              isinstance(no_rev.get("rev"), int), str(no_rev.get("rev")))
        status, saved_no_rev = call(port, "/api/data", "POST", no_rev)
        check("补齐修订号之后照样能保存",
              status == 200 and saved_no_rev.get("ok"), str(saved_no_rev)[:80])

        old_file.write_text(json.dumps({"memo": "连 version 都没有的老文件"},
                                       ensure_ascii=False), encoding="utf-8")
        no_ver = call(port, "/api/data")[1]
        check("连 version 都没有的老文件读出来也补成 1",
              no_ver.get("version") == 1, str(no_ver.get("version")))
        status, saved_no_ver = call(port, "/api/data", "POST", no_ver)
        check("补上 version 之后能正常存回去",
              status == 200 and saved_no_ver.get("ok"), str(saved_no_ver)[:80])

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

    # 数据集（多套数据文件）那一块，单开一份临时根目录和一个服务；放在最后，
    # 因为它和上面那一大段是两套数据目录语义，各跑各的、别互相影响
    check_datasets()

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

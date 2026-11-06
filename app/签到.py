# -*- coding: utf-8 -*-
"""签到引擎（2026-11-04 重构为多站点）。

## 这一版改了什么

原来只有一个 WorkBuddy，域名和接口路径全写死在代码里。要做成可二开的框架，
就得把「哪个站点、发什么请求、从哪取字段」全部变成**数据**，代码只管执行。

## 三层结构

    JSON 站点定义  →  引擎（这个文件）  →  界面
    数据/签到站点/*.json   通用 HTTP + 取值   列表 + 按钮

加一个新站点，**只需要写一个 JSON**，不用改代码、不用重启。见 docs/二开-加一个签到站点.md。

真遇到 JSON 表达不了的（要签名、要解密、要多步交互），在 `PYTHON_SITES` 里写一个
Python 适配函数兜底——接口和 JSON 站点完全一样，界面感觉不到区别。

## 几条硬规矩（别改）

1. 每次先问服务器「今天签没签」，绝不靠本地记录判断——用户可能自己在网页上签过。
2. 签完再查一次复核，不信签到接口自己的话。
3. 凭证存在数据目录下的独立文件里，**不进 数据.json**，
   所以备份、导出、整份搬走都不会把 Token 带走。
4. 只在用户主动点签到、或主动查状态时才联网。平时一个请求都不发。
5. **站点定义的 URL 只允许 https**，且不允许指向本机/内网——不然一个恶意站点定义
   就能变成内网探测工具。

## 接口细节的来源
WorkBuddy 的来自拆解客户端 app.asar，TRAE 的来自读未打包的 main.js，
详见 docs/调研-自动签到.md。
"""

import base64
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

# ---- 常量 -------------------------------------------------------------

CHECKIN_CRED_NAME = "签到凭证.json"
CHECKIN_SITES_DIR = "签到站点"
CHECKIN_TIMEOUT = 20
TOKEN_MAX = 8192
SITE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
NAME_MAX = 24

# 403 的提示分两种情况，别混成一句话
HINT_401 = "登录凭证失效了（401），需要重新填一次。"
HINT_403 = "服务器拒绝了请求（403），可能是账号、地区或风控限制。"


class CheckinError(Exception):
    """签到相关的失败，message 是能直接显示给用户的中文。"""


# ======================================================================
# 取值：从返回的 JSON 里按 "data.list.0.name" 这种路径取
# ======================================================================

_MISSING = object()


def dig(obj, path):
    """按路径取值。支持 a.b.c 和 a.0.b（数组下标）。取不到返回 _MISSING。

    特意不抛异常：站点定义的路径写错了，应该表现为「这个字段没取到」，
    而不是整个签到流程崩掉。
    """
    if not path:
        return obj
    cur = obj
    for part in str(path).split("."):
        if isinstance(cur, dict):
            if part not in cur:
                return _MISSING
            cur = cur[part]
        elif isinstance(cur, list):
            try:
                idx = int(part)
            except ValueError:
                return _MISSING
            if idx < 0 or idx >= len(cur):
                return _MISSING
            cur = cur[idx]
        else:
            return _MISSING
    return cur


def first_value(obj, paths, default=None):
    """一串候选路径，取第一个取到的。站点改版时多写几个候选能少挂几次。"""
    for p in paths:
        v = dig(obj, p)
        if v is not _MISSING and v is not None:
            return v
    return default


def as_bool(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "y", "on", "已签", "已签到")
    return False


def as_int(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


# ======================================================================
# 站点定义：读取 + 校验
# ======================================================================

def sites_dir(data_dir: str) -> str:
    return os.path.join(data_dir, CHECKIN_SITES_DIR)


def _builtin_sites() -> dict:
    """内置站点。用户目录里的同名站点会覆盖这里。"""
    return {"workbuddy": WORKBUDDY_JSON, "jimeng": JIMENG_JSON, "kling": KLING_JSON}


def load_site_defs(data_dir: str) -> dict:
    """读全部站点定义：内置的 + 用户放进去的。

    返回 {id: {"def": 定义, "source": "内置"|"用户", "error": None|错误话}}。
    坏掉的站点也返回（带 error），让界面上能看到「这个站点定义有问题」，
    而不是悄悄消失——用户放了个错的文件却看不到任何反馈，最难查。
    """
    out = {}

    for sid, raw in _builtin_sites().items():
        out[sid] = {"def": raw, "source": "内置", "error": None}

    d = sites_dir(data_dir)
    if os.path.isdir(d):
        for name in sorted(os.listdir(d)):
            if not name.lower().endswith(".json"):
                continue
            path = os.path.join(d, name)
            try:
                with open(path, "r", encoding="utf-8-sig") as f:
                    raw = json.load(f)
            except (ValueError, OSError) as exc:
                sid = os.path.splitext(name)[0]
                out[sid] = {"def": None, "source": "用户", "error": "读不出来：%s" % exc}
                continue

            ok, err = validate_site(raw)
            sid = (raw.get("id") if isinstance(raw, dict) else None) or os.path.splitext(name)[0]
            if not ok:
                # 用户改了内置站点的名字？那就按用户那份算，但标成坏的
                out[sid] = {"def": None, "source": "用户", "error": err}
            else:
                out[sid] = {"def": raw, "source": "用户", "error": None}

    return out


def validate_site(raw) -> tuple[bool, str]:
    """校验一个站点定义。返回 (能不能用, 错误话)。

    规则宁可严一点：站点定义是用户自己手写的，写错了早点告诉他，
    比跑到一半报「取不到字段」好查。
    """
    if not isinstance(raw, dict):
        return False, "应该是一个 JSON 对象"

    # 带下划线开头的是注释字段，不算
    schema = raw.get("schema", 1)
    if schema != 1:
        return False, "schema 是 %r，这个版本只认 1" % (schema,)

    sid = raw.get("id")
    if not isinstance(sid, str) or not SITE_ID_RE.match(sid):
        return False, "id 只能字母数字下划线连字符，1~40 字"

    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        return False, "name 不能为空"
    if len(name) > NAME_MAX:
        return False, "name 最多 %d 个字" % NAME_MAX

    for key in ("status",):
        block = raw.get(key)
        if not isinstance(block, dict):
            return False, "缺 %s 这一段" % key
        ok, err = _validate_request(block, key)
        if not ok:
            return False, err

    chk = raw.get("checkin")
    if chk is not None:
        if not isinstance(chk, dict):
            return False, "checkin 应该是一个对象"
        ok, err = _validate_request(chk, "checkin")
        if not ok:
            return False, err

    # 鉴权
    auth = raw.get("auth") or {}
    if not isinstance(auth, dict):
        return False, "auth 应该是一个对象"
    atype = auth.get("type", "bearer")
    if atype not in ("bearer", "header", "cookie", "none"):
        return False, "auth.type 只能是 bearer / header / cookie / none"

    return True, ""


def _validate_request(block, label) -> tuple[bool, str]:
    url = block.get("url")
    if not isinstance(url, str) or not url:
        return False, "%s.url 不能为空" % label
    ok, err = safe_url(url)
    if not ok:
        return False, "%s.url %s" % (label, err)

    method = block.get("method", "POST")
    if not isinstance(method, str) or method.upper() not in ("GET", "POST", "PUT", "PATCH"):
        return False, "%s.method 只能是 GET / POST / PUT / PATCH" % label

    ex = block.get("extract")
    if ex is not None and not isinstance(ex, dict):
        return False, "%s.extract 应该是一个对象" % label

    body = block.get("body")
    if body is not None and not isinstance(body, (dict, list)):
        return False, "%s.body 应该是一个对象或数组" % label

    headers = block.get("headers")
    if headers is not None and not isinstance(headers, dict):
        return False, "%s.headers 应该是一个对象" % label

    return True, ""


def safe_url(url: str) -> tuple[bool, str]:
    """只允许 https，而且不能指向本机/内网。

    这条是安全底线：站点定义是用户从别处抄来的，如果允许写
    http://127.0.0.1:xxxx 或 192.168.x.x，那这个文件就变成了内网探测工具。
    """
    try:
        u = urllib.parse.urlparse(url)
    except ValueError:
        return False, "不是一个合法网址"
    if u.scheme != "https":
        return False, "只允许 https"
    host = (u.hostname or "").lower()
    if not host:
        return False, "缺主机名"
    if host in ("localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"):
        return False, "不能指向本机"
    if host.endswith(".local") or host.endswith(".internal"):
        return False, "不能指向内网域名"
    # 纯 IP 的内网段
    m = re.match(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$", host)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        if a == 10 or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168) \
                or (a == 169 and b == 254) or a == 127:
            return False, "不能指向内网地址"
    return True, ""


# ======================================================================
# 凭证：一个站点一条
# ======================================================================

def checkin_cred_path(data_dir: str) -> str:
    return os.path.join(data_dir, CHECKIN_CRED_NAME)


def load_creds(data_dir: str) -> dict:
    """读凭证文件。读不到/坏了都返回空 dict。

    用 utf-8-sig：记事本另存会带 BOM，不处理的话 json 解析失败，
    用户会看到「没凭证」而以为程序坏了（早期踩过这个坑）。
    """
    path = checkin_cred_path(data_dir)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (ValueError, OSError):
        return {}


def save_creds(data_dir: str, creds: dict) -> None:
    """整份原子写回：tmp + fsync + replace。"""
    path = checkin_cred_path(data_dir)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(creds, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def get_site_cred(data_dir: str, site_id: str) -> dict:
    entry = load_creds(data_dir).get(site_id)
    return entry if isinstance(entry, dict) else {}


def save_site_cred(data_dir: str, site_id: str, values: dict) -> dict:
    """存一个站点的凭证。

    values 是 {变量名: 值}，比如 {"token": "eyJ...", "device_id": "abc"}。
    兼容老格式：传字符串就当成 token。
    """
    if not SITE_ID_RE.match(site_id or ""):
        raise CheckinError("站点 id 不合法")

    if isinstance(values, str):
        values = {"token": values}

    clean = {}
    for k, v in (values or {}).items():
        if not isinstance(k, str) or not re.match(r"^[A-Za-z_][A-Za-z0-9_]{0,40}$", k):
            raise CheckinError("凭证字段名 %r 不合法" % (k,))
        v = (v or "").strip() if isinstance(v, str) else v
        if isinstance(v, str) and v.lower().startswith("bearer "):
            v = v[7:].strip()
        clean[k] = v

    token = clean.get("token")
    if isinstance(token, str) and token:
        if len(token) > TOKEN_MAX:
            raise CheckinError("凭证太长了，是不是粘错了？")

    if not any(clean.values()):
        raise CheckinError("凭证是空的")

    creds = load_creds(data_dir)
    entry = {
        "values": clean,
        "savedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "savedTs": int(time.time()),
    }
    old = creds.get(site_id)
    if isinstance(old, dict) and "values" not in old and "token" in old:
        entry["values"] = {**{"token": old.get("token")}, **clean}
        entry["savedAt"] = old.get("savedAt") or entry["savedAt"]
        entry["savedTs"] = old.get("savedTs") or entry["savedTs"]

    creds[site_id] = entry
    save_creds(data_dir, creds)
    return entry


def clear_site_cred(data_dir: str, site_id: str) -> bool:
    """删掉一个站点的凭证。

    如果删完一个都不剩，就把文件也一起删了——留个空文件在数据目录里
    会让用户以为「凭证还在」，而且看目录也看不出到底有没有存过。
    """
    creds = load_creds(data_dir)
    if site_id not in creds:
        return False
    del creds[site_id]
    if not creds:
        try:
            os.remove(checkin_cred_path(data_dir))
        except OSError:
            pass
        return True
    save_creds(data_dir, creds)
    return True


def token_expiry(token: str) -> tuple[bool, str]:
    """从 JWT 里读 exp。读不到不报错——不是所有站点的凭证都是 JWT。"""
    if not isinstance(token, str) or token.count(".") != 2:
        return False, ""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
        exp = claims.get("exp")
        if not exp:
            return False, ""
        return True, time.strftime("%Y-%m-%d %H:%M", time.localtime(int(exp)))
    except Exception:
        return False, ""


# ======================================================================
# HTTP：所有站点共用一个发请求的地方
# ======================================================================

def http_json(url, method="POST", body=None, headers=None, timeout=CHECKIN_TIMEOUT) -> dict:
    """发请求并解析 JSON。

    所有站点的失败都长一样（401 / 403 / 超时 / 不是 JSON），
    所以错误话在这里统一成一句人话，界面上不用为每个站点写一遍。
    """
    data = None
    hdrs = {"Accept": "application/json", "User-Agent": "XiaoLi-Checkin/1.0"}
    if headers:
        hdrs.update({k: v for k, v in headers.items() if isinstance(k, str)})

    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")

    req = urllib.request.Request(url, data=data, method=method.upper(), headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise CheckinError(HINT_401)
        if exc.code == 403:
            raise CheckinError(HINT_403)
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:160]
        except Exception:
            pass
        raise CheckinError("服务器返回 HTTP %s。%s" % (exc.code, detail))
    except urllib.error.URLError as exc:
        raise CheckinError("连不上服务器：%s。检查一下网络。" % (exc.reason,))
    except TimeoutError:
        raise CheckinError("请求超时了，网络可能不太稳定。")

    try:
        return json.loads(raw)
    except ValueError:
        raise CheckinError("服务器返回的不是 JSON，接口可能改版了。")


def build_headers(site: dict, values: dict) -> dict:
    """按 auth 配置拼出鉴权头。"""
    auth = site.get("auth") or {}
    atype = auth.get("type", "bearer")
    hdrs = {}

    token = values.get("token") or ""
    if atype == "none" or not token:
        return hdrs
    if atype == "bearer":
        hdrs["Authorization"] = str(auth.get("prefix", "Bearer ")) + token
    elif atype == "header":
        hname = auth.get("header") or "Authorization"
        hdrs[hname] = str(auth.get("prefix", "")) + token
    elif atype == "cookie":
        hdrs["Cookie"] = token
    return hdrs


def build_body(spec, values: dict):
    """把 body 里的 {{变量}} 换成凭证里的值。"""
    if spec is None:
        return {}
    if isinstance(spec, str):
        return render_tpl(spec, values)
    if isinstance(spec, list):
        return [build_body(x, values) for x in spec]
    if isinstance(spec, dict):
        return {k: build_body(v, values) for k, v in spec.items()}
    return spec


def render_tpl(text: str, values: dict) -> str:
    """把 "{{token}}" 换成值。认不出来的原样留着，方便查错。"""
    def repl(m):
        key = m.group(1).strip()
        v = values.get(key)
        return "" if v is None else str(v)
    return re.sub(r"\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}", repl, text)


# ======================================================================
# 执行：查状态 / 签到
# ======================================================================

def _required_vars(site: dict) -> list[str]:
    """这个站点哪些凭证变量是必填的。"""
    out = []
    auth = site.get("auth") or {}
    if auth.get("type", "bearer") != "none":
        out.append("token")
    vars_ = site.get("vars") or {}
    if isinstance(vars_, dict):
        for k, v in vars_.items():
            if isinstance(v, dict) and v.get("required"):
                out.append(k)
    return out


def _missing_vars(site: dict, values: dict) -> list[str]:
    return [k for k in _required_vars(site) if not values.get(k)]


def describe_site(data_dir: str, site_id: str, entry: dict) -> dict:
    """把站点定义 + 凭证状态整理成界面要的列表项。不发请求。"""
    site = entry.get("def") or {}
    values = (get_site_cred(data_dir, site_id).get("values") or {})
    ok, exp = token_expiry(values.get("token") or "")

    # 浏览器型站点（如即梦）：凭证不是 Token，而是一份登录过的浏览器配置。
    # 界面要据此显示「打开浏览器登录」而不是「填 Token」。
    is_browser = site_id in PYTHON_SITES and site.get("auth", {}).get("type") == "none"
    browser_ready = False
    if is_browser:
        try:
            from 签到_浏览器 import profile_ready
            browser_ready = profile_ready(data_dir, site_id)
        except Exception:
            browser_ready = False

    if entry.get("error"):
        configured = False
    elif is_browser:
        configured = browser_ready
    else:
        configured = not _missing_vars(site, values)

    return {
        "id": site_id,
        "name": site.get("name") or site_id,
        "homepage": site.get("homepage") or "",
        "enabled": site.get("enabled", True) is not False,
        "source": entry.get("source") or "用户",
        "error": entry.get("error"),
        "configured": configured,
        "browser": is_browser,
        "browserReady": browser_ready,
        "tokenHint": site.get("token") or "",
        "tokenExpires": exp,
        "tokenExpiresKnown": ok,
        "savedAt": get_site_cred(data_dir, site_id).get("savedAt") or "",
        "vars": [
            {"name": k, "required": bool((v or {}).get("required")),
             "hint": (v or {}).get("hint") or ""}
            for k, v in (site.get("vars") or {}).items()
        ] if isinstance(site.get("vars"), dict) else [],
    }


def list_sites(data_dir: str) -> list[dict]:
    defs = load_site_defs(data_dir)
    out = [describe_site(data_dir, sid, e) for sid, e in defs.items()]
    out.sort(key=lambda s: (not s["enabled"], s["source"] != "内置", s["name"]))
    return out


def _need_site(data_dir: str, site_id: str) -> tuple[dict, dict]:
    defs = load_site_defs(data_dir)
    entry = defs.get(site_id)
    if not entry:
        raise CheckinError("找不到这个签到站点：%s" % site_id)
    if entry.get("error"):
        raise CheckinError("这个站点的定义有问题：%s" % entry["error"])
    site = entry["def"]
    if site.get("enabled") is False:
        raise CheckinError("这个站点已经关掉了，先在设置里打开")
    return site, entry


def _values_or_raise(data_dir: str, site_id: str, site: dict) -> dict:
    values = (get_site_cred(data_dir, site_id).get("values") or {})
    missing = _missing_vars(site, values)
    if missing:
        raise CheckinError("还缺凭证：%s。先在下面填一下。" % "、".join(missing))
    return values


def _do_request(site: dict, block: dict, values: dict) -> dict:
    headers = build_headers(site, values)
    for k, v in (block.get("headers") or {}).items():
        headers[str(k)] = render_tpl(str(v), values)
    body = build_body(block.get("body", {}), values)
    method = block.get("method", "POST")
    payload = None if method.upper() == "GET" else body
    return http_json(block["url"], method=method, body=payload, headers=headers)


def fetch_site_status(data_dir: str, site_id: str) -> dict:
    """查一个站点的签到状态。不改变任何东西。"""
    if site_id in PYTHON_SITES:
        return PYTHON_SITES[site_id]["status"](data_dir)

    site, _ = _need_site(data_dir, site_id)
    values = _values_or_raise(data_dir, site_id, site)

    spec = site.get("status") or {}
    r = _do_request(site, spec, values)

    # 业务错误码：没在 extract 里声明 error_code 就当没有
    ex = spec.get("extract") or {}
    code_path = ex.get("error_code")
    if code_path:
        code = dig(r, code_path)
        if code is not _MISSING and as_int(code, 0) != 0:
            msg = first_value(r, [ex.get("error_msg") or "msg"], "未知错误")
            raise CheckinError("查状态失败：%s（code=%s）" % (msg, code))

    ok, exp = token_expiry(values.get("token") or "")
    return {
        "checked": as_bool(first_value(r, _paths(ex.get("checked"), ["data.checked"]))),
        "streak": as_int(first_value(r, _paths(ex.get("streak"), ["data.streak"]), 0)),
        "dailyCredit": as_int(first_value(r, _paths(ex.get("credit"), ["data.daily_credit"]), 0)),
        "todayCredit": as_int(first_value(r, _paths(ex.get("today_credit"), []), 0)),
        "total": first_value(r, _paths(ex.get("total"), ["data.total"]), None),
        "week": [bool(x) for x in (first_value(r, _paths(ex.get("week"), []), []) or [])],
        "weekDays": as_int(first_value(r, _paths(ex.get("week_days"), []), 0)),
        "activityName": first_value(r, _paths(ex.get("activity_name"), []), "") or "",
        "tokenExpires": exp,
        "tokenExpiresKnown": ok,
    }


def _paths(primary, fallback):
    """一个字段可以写一个路径或一串候选路径。"""
    if primary is None:
        return list(fallback)
    if isinstance(primary, str):
        return [primary] + list(fallback)
    if isinstance(primary, list):
        return list(primary) + list(fallback)
    return list(fallback)


def do_site_checkin(data_dir: str, site_id: str) -> dict:
    """给一个站点签到。先查状态，已签就跳过；签完再复核。"""
    if site_id in PYTHON_SITES:
        return PYTHON_SITES[site_id]["checkin"](data_dir)

    site, _ = _need_site(data_dir, site_id)
    values = _values_or_raise(data_dir, site_id, site)

    spec = site.get("checkin")
    if not spec:
        raise CheckinError("这个站点没有配置签到动作（只有查询）")

    # 第一步：问真实状态
    before = fetch_site_status(data_dir, site_id)
    if before["checked"]:
        return {
            "skipped": True,
            "credit": 0,
            "streak": before["streak"],
            "total": before["total"],
            "message": "今天已经签过了，不用重复签。",
        }

    # 第二步：签到
    r = _do_request(site, spec, values)
    ex = spec.get("extract") or {}
    code_path = ex.get("error_code")
    if code_path:
        code = dig(r, code_path)
        if code is not _MISSING and as_int(code, 0) != 0:
            msg = first_value(r, [ex.get("error_msg") or "msg"], "未知错误")
            raise CheckinError("签到失败：%s（code=%s）" % (msg, code))

    credit = as_int(first_value(r, _paths(ex.get("credit"), ["data.credit"]), 0))
    streak = as_int(first_value(r, _paths(ex.get("streak"), ["data.streak"]), 0))

    # 第三步：复核。签到接口说成功了，也可能实际没生效
    try:
        after = fetch_site_status(data_dir, site_id)
    except CheckinError:
        after = None
    if after is not None and not after["checked"]:
        raise CheckinError(
            "签到接口说成功了，但再查一次显示今天仍是没签。建议去网站上确认一下。"
        )

    return {
        "skipped": False,
        "credit": credit,
        "streak": streak,
        "total": after["total"] if after else None,
        "week": after["week"] if after else [],
        "message": "签到成功，领到 %d 积分。" % credit,
    }


# ======================================================================
# Python 兜底：JSON 表达不了的站点写在这里
# ======================================================================

def _wb_post(path, token):
    return http_json(WB_BASE + path, method="POST", body={}, headers={
        "Authorization": "Bearer " + token,
    })


WB_BASE = "https://www.workbuddy.cn"


def _wb_status(data_dir, values):
    token = values.get("token") or ""
    if not token:
        raise CheckinError("还没填 Token，先在下面填一个。")
    r = _wb_post("/billing/meter/checkin-activity-status", token)
    if r.get("code") != 0:
        raise CheckinError("查状态失败：%s（code=%s）" % (r.get("msg"), r.get("code")))
    d = r.get("data") or {}
    ok, exp = token_expiry(token)
    return {
        "checked": bool(d.get("today_checked_in")),
        "streak": as_int(d.get("streak_days")),
        "dailyCredit": as_int(d.get("daily_credit")),
        "todayCredit": as_int(d.get("today_credit")),
        "total": d.get("total_credits"),
        "week": [bool(x) for x in (d.get("week_progress") or [])],
        "weekDays": as_int(d.get("week_checkin_days")),
        "activityName": d.get("theme_name") or "",
        "tokenExpires": exp,
        "tokenExpiresKnown": ok,
    }


# 站点 id → {"status": fn(data_dir), "checkin": fn(data_dir)}
# 写在这里的站点会**覆盖**同名的 JSON 定义。
# 2026-11-04：只有即梦（jimeng）在这里，因为它要跑真浏览器，JSON 表达不了。
PYTHON_SITES: dict = {}


# ---- 即梦（jimeng）----------------------------------------------------
# 每日积分是「登录即发」，没有领取按钮，也没有可复用的领取接口能安全调。
# 所以这里的「签到」= 打开一次页面，让前端自己去调积分接口，服务端看到访问就发分。
# 详见 app/签到_浏览器.py 的头注释。

JIMENG_URL = "https://jimeng.jianying.com/ai-tool/home"
JIMENG_WANT = [
    "/commerce/v1/benefits/user_credit",           # 余额（含明细、过期时间）
    "/commerce/v1/benefits/user_credit_history",   # 流水（哪天发了多少）
]


def _jm_need_browser(data_dir):
    """即梦必须有浏览器配置，没有就明确让用户去登录。"""
    from 签到_浏览器 import profile_ready
    if not profile_ready(data_dir, "jimeng"):
        raise CheckinError(
            "还没登录过即梦。点下面的「打开浏览器登录」，"
            "在弹出的窗口里登录一次，之后就一直能用了。")


def _jm_pick(bodies):
    """从页面自己的响应里解析余额和今天的发放记录。

    bodies 的键是去掉 query 的完整路径。
    返回结构对齐站点约定的字段。注意即梦没有「签到」这个动作，
    所以 checked 的含义是「今天的每日免费积分到账了没」。
    """
    credit = None
    history = None
    blocked = 0
    for url, body in bodies.items():
        try:
            j = json.loads(body)
        except ValueError:
            continue
        if j.get("ret") != "0":
            blocked += 1
            continue
        inner = j.get("response")
        if not inner:
            continue
        try:
            d = json.loads(inner)
        except ValueError:
            continue
        if url.endswith("/benefits/user_credit"):
            credit = d
        elif url.endswith("/benefits/user_credit_history"):
            history = d

    if credit is None:
        if blocked:
            raise CheckinError(
                "积分接口被风控拦了（返回 1014）。"
                "在桌面点「打开浏览器登录」重登一次往往就好了。")
        raise CheckinError("没读到积分数据，接口可能改版了。")

    c = credit.get("credit") or {}
    total = sum(v for v in c.values() if isinstance(v, int))

    # 今天的「每日免费积分」到账了没
    today = time.strftime("%Y-%m-%d")
    today_credit = 0
    checked = False
    daily_amount = 0
    streak = 0
    records = (history or {}).get("records") or []

    # 连续天数：从今天往前数，每天都有「每日免费积分」就算连续。
    # 即梦不提供连续天数字段，只能自己按日期数——数据在流水里。
    daily_days = set()
    for rec in records:
        title = rec.get("title") or ""
        if "每日" not in title:
            continue
        ts = rec.get("create_time") or 0
        day = time.strftime("%Y-%m-%d", time.localtime(ts)) if ts else ""
        if day:
            daily_days.add(day)
        if day == today:
            today_credit += as_int(rec.get("amount"))
            checked = True
        daily_amount = max(daily_amount, as_int(rec.get("amount")))

    if daily_days:
        d = time.localtime()
        for _ in range(365):
            key = time.strftime("%Y-%m-%d", d)
            if key in daily_days:
                streak += 1
                d = time.localtime(time.mktime(d) - 86400)
            else:
                break

    # 本周格子：周一到周日，看哪天有「每日免费积分」
    now = time.localtime()
    monday = time.mktime((now.tm_year, now.tm_mon, now.tm_mday, 0, 0, 0, 0, 0, -1)) \
        - (now.tm_wday * 86400)
    week = []
    for i in range(7):
        key = time.strftime("%Y-%m-%d", time.localtime(monday + i * 86400))
        week.append(key in daily_days)

    # 过期时间：要的是**赠送积分**的过期时间，不是最早的那条。
    #
    # 2026-11-04 踩过：expiring_credits 里有两类——
    #   {credit_amount: 725, expire_time: ...19:21:23} 会员积分
    #   {credit_amount: 50,  expire_time: ...23:59:59} 当天赠送积分
    # 一开始取了「最早过期的」，结果显示 19:21，看着像今天领的分 19:21 就废了。
    # 实际赠送积分是当天 23:59:59 过期。所以认「金额 = gift_credit」的那条。
    gift_amt = as_int(c.get("gift_credit"))
    expires = ""
    pick_time = None
    for e in (credit.get("expiring_credits") or []):
        t = e.get("expire_time")
        if not t:
            continue
        if gift_amt and as_int(e.get("credit_amount")) == gift_amt:
            pick_time = t
            break
        # 兜底：取最晚的（当天 23:59 一定晚于会员到期，不会更吓人）
        if pick_time is None or t > pick_time:
            pick_time = t
    if pick_time:
        expires = time.strftime("%Y-%m-%d %H:%M", time.localtime(pick_time))

    return {
        "checked": checked,
        "streak": streak,
        "dailyCredit": daily_amount,
        "todayCredit": today_credit,
        "total": total,
        "week": week,
        "weekDays": sum(1 for x in week if x),
        "activityName": "每日免费积分",
        "expires": expires,
        "tokenExpires": expires,
        "tokenExpiresKnown": bool(expires),
        # 即梦特有的说明：这不是「签到」，是「登录就发」
        "note": "即梦没有签到按钮，每日积分是登录后自动发的。"
                "这里的「签到」= 打开一次页面。",
    }


def _jm_status(data_dir: str) -> dict:
    from 签到_浏览器 import visit_site
    _jm_need_browser(data_dir)
    return visit_site(data_dir, "jimeng", JIMENG_URL, JIMENG_WANT, _jm_pick)


def _jm_checkin(data_dir: str) -> dict:
    """「签到」= 打开一次页面。

    打开页面本身就会触发服务端发当天的分，所以这里不需要额外动作。
    做完再复核一次：这次结果里 checked 为真的话，就是真到账了。
    """
    from 签到_浏览器 import visit_site
    _jm_need_browser(data_dir)

    before = None
    try:
        before = visit_site(data_dir, "jimeng", JIMENG_URL, JIMENG_WANT, _jm_pick)
    except CheckinError:
        before = None

    after = visit_site(data_dir, "jimeng", JIMENG_URL, JIMENG_WANT, _jm_pick)

    if not after.get("checked"):
        return {
            "skipped": True,
            "message": "页面打开了，但今天的免费积分还没到账。"
                       "可能服务端有延迟，过几分钟再看。",
            "total": after.get("total"),
        }

    gained = None
    if before is not None and before.get("checked") is False:
        b = before.get("total")
        a = after.get("total")
        if isinstance(b, int) and isinstance(a, int) and a > b:
            gained = a - b

    return {
        "skipped": False,
        "credit": after.get("todayCredit") or gained or after.get("dailyCredit"),
        "streak": after.get("streak"),
        "total": after.get("total"),
        "message": "今天的免费积分已经到账了。",
    }


PYTHON_SITES["jimeng"] = {
    "status": _jm_status,
    "checkin": _jm_checkin,
}


# ---- 可灵（kling）：每月体验包，不是每日签到 --------------------------
# 2026-11-06 真机确认：当前账号没有每日积分活动；平台给的是每月一次
# normal_bonus_monthly「惊喜体验包」。页面加载时会自己调奖励状态和积分余额接口。
# 不调用任何未知领取 API，只让页面做平台定义的动作，再读结果。
KLING_URL = "https://klingai.com/app/"
KLING_WANT = [
    "/api/pay/reward/v2",             # 本月体验包：GRANTED / nextApplyTime
    "/api/account/pointAndTicket",    # 灵感值余额和券
]


def _kling_need_browser(data_dir):
    from 签到_浏览器 import profile_ready
    if not profile_ready(data_dir, "kling"):
        raise CheckinError(
            "还没登录过可灵。点下面的「打开浏览器登录」，"
            "在弹出的窗口里登录一次，之后一直能用了。")


def _kling_time(ms):
    """可灵接口毫秒时间戳 → 本地展示时间；坏数据就留空。"""
    try:
        ms = int(ms or 0)
        if ms <= 0:
            return ""
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(ms / 1000))
    except (TypeError, ValueError, OverflowError):
        return ""


def _kling_pick(bodies):
    """解析可灵页面自己请求的月度体验包状态与余额。"""
    reward = None
    account = None
    for url, body in bodies.items():
        try:
            data = json.loads(body)
        except ValueError:
            continue
        if data.get("result") != 1:
            continue
        if url.endswith("/api/pay/reward/v2"):
            reward = data.get("data") or {}
        elif url.endswith("/api/account/pointAndTicket"):
            account = data.get("data") or {}

    if reward is None:
        raise CheckinError("没读到可灵月度体验包状态，接口可能改版了。")

    state = str(reward.get("status") or "")
    next_ms = reward.get("nextApplyTime") or 0
    next_at = _kling_time(next_ms)
    # GRANTED 是服务端明确说「本月已经发过」。不要靠本地状态猜。
    checked = state == "GRANTED"
    total = as_int((account or {}).get("total"))
    points = (account or {}).get("points") or []
    # 当前有效积分的最早到期时间；本月体验包会有自己的有效期。
    ends = [as_int(p.get("endTime")) for p in points if as_int(p.get("endTime")) > 0]
    expires = _kling_time(min(ends)) if ends else ""
    hint = reward.get("hint") or {}
    note = (hint.get("title") or "")
    if next_at:
        note = (note + "；" if note else "") + "下次可领：" + next_at

    return {
        "checked": checked,
        "streak": 0,                  # 月度活动没有连续天数字段
        "dailyCredit": 0,             # 不是每日活动，故意不伪装成每日积分
        "todayCredit": 0,
        "total": total,
        "week": [],
        "weekDays": 0,
        "activityName": "每月惊喜体验包",
        "activityPeriod": "monthly",
        "expires": expires,
        "nextApplyAt": next_at,
        "nextApplyTime": as_int(next_ms),
        "tokenExpires": expires,
        "tokenExpiresKnown": bool(expires),
        "note": note or "可灵没有每日积分；这是按月发放的体验包。",
    }


def _kling_status(data_dir: str) -> dict:
    from 签到_浏览器 import visit_site
    _kling_need_browser(data_dir)
    return visit_site(data_dir, "kling", KLING_URL, KLING_WANT, _kling_pick)


def _kling_checkin(data_dir: str) -> dict:
    """「打开页面」= 让可灵页面自行处理月度体验包，不主动调领取接口。"""
    after = _kling_status(data_dir)
    if after.get("checked"):
        return {
            "skipped": True,
            "message": "本月体验包已经领取过了。" +
                       ("下次可领：" + after["nextApplyAt"] if after.get("nextApplyAt") else ""),
            "total": after.get("total"),
        }
    return {
        "skipped": True,
        "message": "页面已打开，但平台没有确认体验包已到账；过几分钟再查。",
        "total": after.get("total"),
    }


PYTHON_SITES["kling"] = {
    "status": _kling_status,
    "checkin": _kling_checkin,
}


JIMENG_JSON = {
    "schema": 1,
    "id": "jimeng",
    "name": "即梦",
    "homepage": "https://jimeng.jianying.com",
    "enabled": True,
    "builtin": True,
    "token": (
        "即梦不需要填 Token——它用浏览器登录态。"
        "点下面的「打开浏览器登录」，在弹出的窗口里登录一次即可，之后一直复用。"
    ),
    "auth": {"type": "none"},
    # 这个站点走浏览器，下面的 url 只是给界面显示用
    "status": {"url": JIMENG_URL, "method": "GET", "body": {}, "extract": {}},
}


KLING_JSON = {
    "schema": 1,
    "id": "kling",
    "name": "可灵",
    "homepage": "https://klingai.com/app/",
    "enabled": True,
    "builtin": True,
    "token": (
        "可灵不需要填 Token——它用浏览器登录态。"
        "目前是每月一次的惊喜体验包，没有每日签到活动。"
        "点下面的「打开浏览器登录」，在弹出的窗口里登录一次即可。"
    ),
    "auth": {"type": "none"},
    "status": {"url": KLING_URL, "method": "GET", "body": {}, "extract": {}},
}


# ======================================================================
# 内置站点定义（以数据形式给出，和用户放的 JSON 一个格式）
# ======================================================================

WORKBUDDY_JSON = {
    "schema": 1,
    "id": "workbuddy",
    "name": "WorkBuddy",
    "homepage": "https://www.workbuddy.cn",
    "enabled": True,
    "builtin": True,
    "token": (
        "在 WorkBuddy 客户端里按 F12 → 网络面板 → 找发往 workbuddy.cn 的请求 → "
        "复制请求头里 Authorization 的值（Bearer 后面那一串）。"
        "或者用 D:\\自动签到\\抓Token.cmd 抓下来，再点下面的导入。"
    ),
    "auth": {"type": "bearer"},
    "status": {
        "url": WB_BASE + "/billing/meter/checkin-activity-status",
        "method": "POST",
        "body": {},
        "extract": {
            "error_code": "code",
            "error_msg": "msg",
            "checked": "data.today_checked_in",
            "streak": "data.streak_days",
            "credit": "data.daily_credit",
            "today_credit": "data.today_credit",
            "total": "data.total_credits",
            "week": "data.week_progress",
            "week_days": "data.week_checkin_days",
            "activity_name": "data.theme_name",
        },
    },
    "checkin": {
        "url": WB_BASE + "/billing/meter/daily-checkin",
        "method": "POST",
        "body": {},
        "extract": {
            "error_code": "code",
            "error_msg": "msg",
            "credit": "data.credit",
            "streak": "data.streak_days",
        },
    },
}


# 老接口保留成薄壳，别的代码还在调（外部脚本也照这个写的）
def checkin_cred_path_legacy(data_dir: str) -> str:
    return checkin_cred_path(data_dir)

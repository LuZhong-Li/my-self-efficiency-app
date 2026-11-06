# -*- coding: utf-8 -*-
"""浏览器兜底：需要跑真浏览器的签到站点（2026-11-04 加）。

## 为什么需要这个东西

即梦（jimeng.jianying.com）的每日积分是**登录即发**，没有领取按钮。
但它的积分接口要求带 `x-secsdk-web-signature` 这个签名头——
签名的算法藏在字节的 secsdk JSSDK 里，由浏览器现场计算，纯 Python 复刻不了
（试过：同样的 Cookie 直接 POST，返回 1014 system busy，和浏览器成功时一模一样）。

所以只能让真浏览器去跑：浏览器自己会给页面发出的请求签名，
而页面一加载，前端就会调 `/commerce/v1/benefits/user_credit` 等接口，
服务端看到这次访问就把当天的分发了。

**结论：我们连"领取"这个动作都不需要做，只要打开一次页面。**

## 怎么做的

1. 用系统自带的 Edge（不装任何第三方依赖），`--headless=new`
2. `--user-data-dir` 指向一个专用配置目录（用户在这里登录过一次，之后一直复用）
3. 打开站点首页，等页面自己把接口调完
4. **监听**页面自己发出的请求（`Network.responseReceived`），
   不是我自己 fetch——自己 fetch 没有签名，必然 1014
5. 从响应里读出余额、今天的发放记录
6. 关掉浏览器

## 几条硬规矩

1. **不碰 `credit_receive` 接口。** 那个接口存在，但用途不明
   （任务面板返回空，看不出它是不是给每日积分用的），贸然调用有重复领取的风险。
   页面自己会发什么就让它发什么，我们只读。
2. **不自己发任何请求。** 只监听。这样不会触发任何多余的业务逻辑。
3. **配置目录是凭证。** 里面有登录 Cookie，和 `签到凭证.json` 同级别处理：
   放数据目录（不进 git、不进备份导出）。
4. **不留垃圾进程。** 无论成功失败，`finally` 里一定杀干净。
"""

import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import time
import urllib.request

# 浏览器配置放在数据目录下，和签到凭证平级
BROWSER_PROFILE_DIR = "浏览器配置"

# 启动后等页面加载 + 前端把所有接口调完。实测 18 秒足够，给到 30 秒。
PAGE_WAIT = 30

# 找 Edge 的常见位置。用户如果装了 Chrome 也能用，但优先 Edge（系统自带）。
EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]


class BrowserError(Exception):
    """浏览器相关的失败，message 能直接给用户看。"""


def find_browser() -> str:
    """找一个能用的 Chromium 内核浏览器。找不到就报清楚的话。"""
    for p in EDGE_CANDIDATES:
        if os.path.isfile(p):
            return p
    for p in CHROME_CANDIDATES:
        if os.path.isfile(p):
            return p
    raise BrowserError(
        "找不到 Edge 或 Chrome。这个站点需要真浏览器才能跑——"
        "Windows 一般自带 Edge，如果被删了得装回来。")


def profile_path(data_dir: str, site_id: str) -> str:
    """某个站点的浏览器配置目录。"""
    return os.path.join(data_dir, BROWSER_PROFILE_DIR, site_id)


def profile_ready(data_dir: str, site_id: str) -> bool:
    """配置目录里有没有登录态（判断标准：Cookies 文件存在且有内容）。"""
    base = profile_path(data_dir, site_id)
    # 新版 Edge 的 Cookie 在 Default\Network\Cookies，老的在 Default\Cookies
    for rel in (os.path.join("Default", "Network", "Cookies"), os.path.join("Default", "Cookies")):
        p = os.path.join(base, rel)
        try:
            if os.path.isfile(p) and os.path.getsize(p) > 0:
                return True
        except OSError:
            pass
    return False


def _free_port() -> int:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _wait_cdp(port: int, timeout: float) -> bool:
    """等 CDP 端口起来。"""
    end = time.time() + timeout
    url = "http://127.0.0.1:%d/json/version" % port
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.4)
    return False


def _list_pages(port: int):
    url = "http://127.0.0.1:%d/json/list" % port
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


# ---- 极简 CDP 客户端 ---------------------------------------------------
# 只用得到 Runtime.evaluate 和 Network 事件，没必要引 websocket 库。
# 标准库没有 websocket，所以这里自己实现 RFC 6455 的最小可用子集：
# 只发文本帧、只收文本帧、不处理分片（CDP 的消息都不分片）。

class _CDP:
    def __init__(self, ws_url: str, timeout: float = 45):
        rest = ws_url[5:]
        hostport, path = rest.split("/", 1)
        host, port = hostport.split(":")
        self.sock = socket.create_connection((host, int(port)), timeout=timeout)
        self.sock.settimeout(timeout)
        key = _b64(os.urandom(16))
        self.sock.sendall((
            "GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
            "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n" % (path, hostport, key)).encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            c = self.sock.recv(4096)
            if not c:
                raise BrowserError("连浏览器调试端口失败（握手没回话）。")
            buf += c
        if b" 101 " not in buf.split(b"\r\n")[0]:
            raise BrowserError("浏览器调试端口拒绝了连接。")
        self.buf = b""
        self._id = 0

    def _rx(self, n: int) -> bytes:
        while len(self.buf) < n:
            c = self.sock.recv(65536)
            if not c:
                raise BrowserError("浏览器提前关掉了。")
            self.buf += c
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, payload: dict):
        data = json.dumps(payload).encode()
        head = bytearray([0x81])
        n = len(data)
        mask = os.urandom(4)
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += struct.pack(">H", n)
        else:
            head.append(0x80 | 127)
            head += struct.pack(">Q", n)
        head += mask
        self.sock.sendall(bytes(head) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self) -> dict:
        b1, b2 = self._rx(2)
        op = b1 & 0x0F
        ln = b2 & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", self._rx(2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", self._rx(8))[0]
        mask = self._rx(4) if (b2 & 0x80) else None
        payload = self._rx(ln)
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        if op == 0x8:
            raise BrowserError("浏览器关闭了连接。")
        try:
            return json.loads(payload.decode("utf-8", "replace"))
        except ValueError:
            return {}

    def call(self, method: str, params=None, timeout: float = 40) -> dict:
        self._id += 1
        mid = self._id
        self.send({"id": mid, "method": method, "params": params or {}})
        end = time.time() + timeout
        while time.time() < end:
            msg = self.recv()
            if msg.get("id") == mid:
                if "error" in msg:
                    raise BrowserError("浏览器执行命令失败：%s" % (msg["error"],))
                return msg.get("result") or {}
        raise BrowserError("浏览器没在 %d 秒内回话。" % int(timeout))

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


# ---- 跑一次浏览器 -----------------------------------------------------

def visit_site(data_dir: str, site_id: str, url: str,
               want_paths, pick, timeout: float = PAGE_WAIT) -> dict:
    """打开一次页面，收集指定接口的响应，交给 pick 解析。

    want_paths: URL 片段列表，命中就收集响应体
    pick: fn(dict[name -> 响应文本]) -> dict，返回要展示的数据

    这个函数**不主动发任何请求**，纯粹监听页面自己发的。
    """
    exe = find_browser()
    profile = profile_path(data_dir, site_id)
    os.makedirs(profile, exist_ok=True)

    port = _free_port()
    proc = None
    cdp = None
    try:
        proc = subprocess.Popen(
            [
                exe,
                "--headless=new",
                "--remote-debugging-port=%d" % port,
                "--user-data-dir=%s" % profile,
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--disable-background-networking",
                "--disable-sync",
                "--disable-default-apps",
                "--mute-audio",
                # ⚠️ 先开空白页，**不要**直接开目标网址。
                # 原因（2026-11-04 踩过）：如果直接开目标页，等我们连上 CDP 并
                # Network.enable 时，页面可能早就把积分接口发完了——有时抓得到
                # 有时抓不到，第一次跑要 31 秒才"失败"一次。
                # 空白页 + 先挂监听 + 再导航，才能保证一个请求都不漏。
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

        if not _wait_cdp(port, 25):
            raise BrowserError("浏览器启动超时（25 秒没起来）。")

        pages = _list_pages(port)
        page = None
        for p in pages:
            if p.get("type") == "page" and "webSocketDebuggerUrl" in p:
                page = p
                break
        if not page:
            raise BrowserError("浏览器起来了但没有可用页面。")

        cdp = _CDP(page["webSocketDebuggerUrl"])
        cdp.call("Network.enable")
        cdp.call("Page.enable")

        # 监听挂好了，现在才导航过去。这样页面发的每一个请求都能收到。
        cdp.call("Page.navigate", {"url": url})

        # 收集页面自己发的请求
        wanted = {}
        bodies = {}
        end = time.time() + timeout
        cdp.sock.settimeout(1.0)
        while time.time() < end:
            try:
                msg = cdp.recv()
            except socket.timeout:
                continue
            method = msg.get("method")
            params = msg.get("params") or {}
            rid = params.get("requestId")
            if method == "Network.requestWillBeSent":
                u = (params.get("request") or {}).get("url") or ""
                if any(w in u for w in want_paths):
                    wanted[rid] = u
            elif method == "Network.loadingFinished" and rid in wanted:
                url = wanted[rid]
                # 同一类接口页面可能调好几次（还有带不同 query 的）。
                # 用去掉 query 的路径当键，后来的覆盖先来的——
                # 我们要的是「最后一次的余额」，这样正好。
                key = url.split("?")[0]
                try:
                    res = cdp.call("Network.getResponseBody", {"requestId": rid}, timeout=6)
                    body = res.get("body") or ""
                    if res.get("base64Encoded"):
                        body = base64.b64decode(body).decode("utf-8", "replace")
                    bodies[key] = body
                except Exception:
                    pass

            # 每类接口都拿到过一次就不用等了。
            #
            # ⚠️ 这里**必须用精确结尾匹配**，不能用 `w in k`。
            # 2026-11-04 踩过：want_paths 里 "/.../user_credit" 是
            # "/.../user_credit_history" 的前缀，一旦拿到 history 的响应，
            # `"user_credit" in key` 也成立，于是 history 到齐就误判成「都到齐了」
            # 立刻退出，余额那条还没回来就被丢掉——表现是时好时坏、3 秒就失败。
            if all(any(k.endswith(w) for k in bodies) for w in want_paths):
                break

        if not bodies:
            raise BrowserError(
                "页面打开了，但 %d 秒内没等到积分接口的响应。"
                "多半是登录过期了——点「重新登录」再登一次。" % int(timeout))

        return pick(bodies)

    finally:
        if cdp:
            cdp.close()
        if proc and proc.poll() is None:
            # 整个进程树都要杀，Chromium 会开一堆子进程
            try:
                subprocess.run(["taskkill", "/pid", str(proc.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=15)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass


def open_for_login(data_dir: str, site_id: str, url: str) -> dict:
    """弹一个有界面的浏览器，让用户登录。登录完他关窗口，我们确认一下。"""
    exe = find_browser()
    profile = profile_path(data_dir, site_id)
    os.makedirs(profile, exist_ok=True)

    subprocess.Popen(
        [exe, "--user-data-dir=%s" % profile,
         "--no-first-run", "--no-default-browser-check", url],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return {"ok": True, "profile": profile}


def reset_profile(data_dir: str, site_id: str) -> bool:
    """清掉浏览器配置（登录态没了）。用于「换账号」或配置坏了。"""
    p = profile_path(data_dir, site_id)
    if not os.path.isdir(p):
        return False
    shutil.rmtree(p, ignore_errors=True)
    return True

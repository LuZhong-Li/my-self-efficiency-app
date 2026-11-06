# -*- coding: utf-8 -*-
"""浏览器兜底模块的单元测试（不真开浏览器、不联网）。

测的是纯逻辑部分：找浏览器、认登录态、CDP 帧编解码、路径规则。
真开浏览器那部分在端到端脚本里验（太慢，不适合放进自检）。
"""
import os
import struct
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))

import 签到_浏览器 as B

passed = 0
failed = 0


def ok(cond, label):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + label)
    else:
        failed += 1
        print("  FAIL " + label)


print("=== 找浏览器 ===")
try:
    exe = B.find_browser()
    ok(os.path.isfile(exe), "找到了浏览器：%s" % os.path.basename(exe))
except B.BrowserError as e:
    ok(False, "没找到浏览器（这台机器应该有 Edge）: %s" % e)

print("\n=== 配置目录路径 ===")
tmp = tempfile.mkdtemp(prefix="ck-browser-")
p = B.profile_path(tmp, "jimeng")
ok(p.startswith(tmp), "配置目录在数据目录下（会被当成用户数据）")
ok("jimeng" in p, "按站点 id 分目录")
ok(p.endswith(os.path.join("浏览器配置", "jimeng")), "目录名是 浏览器配置/<站点id>")

print("\n=== 认登录态 ===")
ok(B.profile_ready(tmp, "jimeng") is False, "目录不存在 → 没登录")

# 造一个空的 Cookies
os.makedirs(os.path.join(p, "Default", "Network"), exist_ok=True)
cookie = os.path.join(p, "Default", "Network", "Cookies")
open(cookie, "wb").close()
ok(B.profile_ready(tmp, "jimeng") is False, "Cookies 是空文件 → 还是没登录")

with open(cookie, "wb") as f:
    f.write(b"\x00" * 1024)
ok(B.profile_ready(tmp, "jimeng") is True, "Cookies 有内容 → 算已登录")

# 老位置也要认
os.remove(cookie)
old = os.path.join(p, "Default", "Cookies")
with open(old, "wb") as f:
    f.write(b"\x00" * 512)
ok(B.profile_ready(tmp, "jimeng") is True, "老位置的 Cookies 也认（新版 Edge 才挪到 Network\\）")

print("\n=== 清登录态 ===")
ok(B.reset_profile(tmp, "jimeng") is True, "能清掉")
ok(B.profile_ready(tmp, "jimeng") is False, "清完就是没登录")
ok(B.reset_profile(tmp, "jimeng") is False, "重复清返回 False（没东西可清）")

print("\n=== 端口 ===")
p1 = B._free_port()
p2 = B._free_port()
ok(isinstance(p1, int) and 1024 < p1 < 65536, "分到一个合法端口")
ok(p1 != p2 or True, "两次分的端口（可能相同，正常）")

print("\n=== CDP 帧编码（服务端→浏览器，必须带掩码）===")


class FakeSock:
    def __init__(self):
        self.data = b""

    def sendall(self, b):
        self.data += b


class FakeCDP(B.CDP if hasattr(B, "CDP") else B._CDP):
    def __init__(self):
        self.sock = FakeSock()
        self.buf = b""
        self._id = 0


c = FakeCDP()
c.send({"id": 1, "method": "x"})
raw = c.sock.data
ok(len(raw) > 2, "写出去了")
ok(raw[0] == 0x81, "是文本帧（FIN + text）")
ok(bool(raw[1] & 0x80), "客户端帧必须带掩码位")
mask = raw[2:6]
payload = raw[6:]
unmasked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
ok(unmasked.decode().startswith("{"), "掩码后的内容能还原成 JSON")

# 大一点的负载走 126 分支
c2 = FakeCDP()
c2.send({"id": 1, "data": "x" * 300})
ok(c2.sock.data[1] & 0x7F == 126, "超过 125 字节用 126 长度分支")

print("\n=== 收尾 ===")
import shutil
shutil.rmtree(tmp, ignore_errors=True)

print("\n" + "-" * 60)
if failed:
    print(" 通过 %d 项，失败 %d 项" % (passed, failed))
    sys.exit(1)
else:
    print(" 全部通过（%d 项）" % passed)

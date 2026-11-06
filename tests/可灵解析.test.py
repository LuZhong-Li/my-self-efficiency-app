# -*- coding: utf-8 -*-
"""可灵月度体验包响应解析测试：只喂假响应，不联网、不打开浏览器。"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))
import 签到 as XL

passed = failed = 0


def ok(cond, label):
    global passed, failed
    if cond:
        passed += 1
        print("  ok   " + label)
    else:
        failed += 1
        print("  FAIL " + label)


now = time.localtime()
next_ms = int(time.mktime((now.tm_year, now.tm_mon + 1 if now.tm_mon < 12 else 1,
                           7, 1, 44, 0, 0, 0, -1)) * 1000)
expire_ms = int(time.mktime((now.tm_year, now.tm_mon, min(now.tm_mday + 3, 28),
                             1, 44, 0, 0, 0, -1)) * 1000)
reward = json.dumps({"status": 200, "result": 1, "data": {
    "status": "GRANTED", "activityType": "normal_bonus_monthly",
    "nextApplyTime": next_ms,
    "hint": {"title": "您已领取过本月惊喜体验包"},
}}, ensure_ascii=False)
account = json.dumps({"status": 200, "result": 1, "data": {
    "total": 6600, "points": [{"amount": 6600, "balance": 6600, "endTime": expire_ms}],
}}, ensure_ascii=False)
R = "https://klingai.com/api/pay/reward/v2"
A = "https://klingai.com/api/account/pointAndTicket"

print("=== 正常月度状态 ===")
s = XL._kling_pick({R: reward, A: account})
ok(s["checked"] is True, "GRANTED = 已领")
ok(s["activityPeriod"] == "monthly", "明确是月度活动")
ok(s["total"] == 6600, "读取灵感值余额")
ok(bool(s["nextApplyAt"]), "读取下次可领时间")
ok(bool(s["expires"]), "读取当前积分过期时间")
ok("每月" in s["activityName"], "活动名不能伪装成每日签到")

print("\n=== 未领 / 坏数据 ===")
waiting = json.dumps({"status": 200, "result": 1, "data": {"status": "WAITING", "nextApplyTime": 0}})
ok(XL._kling_pick({R: waiting, A: account})["checked"] is False, "非 GRANTED 不假装已领")
for label, bodies in (("空", {}), ("非 JSON", {R: "x"}), ("服务端失败", {R: json.dumps({"result": 0})})):
    try:
        XL._kling_pick(bodies)
        ok(False, label + " 应明确报错")
    except XL.CheckinError:
        ok(True, label + " 明确报错")
    except Exception as exc:
        ok(False, label + " 不能崩：%r" % exc)

print("\n" + "-" * 60)
if failed:
    print(" 通过 %d 项，失败 %d 项" % (passed, failed))
    sys.exit(1)
print(" 全部通过（%d 项）" % passed)

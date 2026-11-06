# -*- coding: utf-8 -*-
"""即梦解析逻辑的单元测试（2026-11-04）。

只测 `_jm_pick` 这个纯函数：给它假的接口响应，看它解析得对不对。
**不联网、不开浏览器**，所以可以放进自检里跑。

重点盯三件踩过的坑：
1. 前缀误判：user_credit 是 user_credit_history 的前缀（这个坑害我调了一小时）
2. 过期时间取错：会员积分 19:21 到期 ≠ 赠送积分 23:59 到期
3. 风控 1014 要说人话，不能报"接口改版了"
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))

import 签到 as XL

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


def today_ts(hour=10, minute=36):
    t = time.localtime()
    return int(time.mktime((t.tm_year, t.tm_mon, t.tm_mday, hour, minute, 0, 0, 0, -1)))


def today_end():
    t = time.localtime()
    return int(time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 23, 59, 59, 0, 0, -1)))


def wrap(inner_obj):
    """造一个真实的响应外壳：response 是 JSON 字符串，不是对象。"""
    return json.dumps({
        "ret": "0", "errmsg": "success", "svr_time": 1793763197,
        "response": json.dumps(inner_obj, ensure_ascii=False),
    }, ensure_ascii=False)


def credit_body(gift=50, vip=725, gift_end=None, vip_end=None, extra_hist=None):
    gift_end = gift_end if gift_end is not None else today_end()
    vip_end = vip_end if vip_end is not None else today_ts(19, 21)
    return wrap({
        "credit": {"vip_credit": vip, "gift_credit": gift, "purchase_credit": 0},
        "expiring_credits": [
            {"credit_amount": vip, "expire_time": vip_end},
            {"credit_amount": gift, "expire_time": gift_end},
        ],
        "credits_detail": {
            "vip_credits": [{"vip_level": "standard", "residual_credits": vip,
                             "credits_life_end": vip_end}],
            "gift_credits": [{"residual_credits": gift, "credits_life_end": gift_end}],
        },
    })


def history_body(records=None):
    if records is None:
        records = [{"amount": 50, "title": "每日免费积分",
                    "create_time": today_ts(), "status": "Checked"}]
    return wrap({"new_cursor": "0", "has_more": False, "records": records})


URL_C = "https://jimeng.jianying.com/commerce/v1/benefits/user_credit"
URL_H = "https://jimeng.jianying.com/commerce/v1/benefits/user_credit_history"

print("=== 基本解析 ===")
r = XL._jm_pick({URL_C: credit_body(), URL_H: history_body()})
ok(r["checked"] is True, "今天发了分 → checked=True")
ok(r["todayCredit"] == 50, "todayCredit=50")
ok(r["dailyCredit"] == 50, "dailyCredit=50")
ok(r["total"] == 775, "total = 725+50 = 775")
ok(r["streak"] == 1, "连续 1 天")
ok(r["activityName"] == "每日免费积分", "活动名叫每日免费积分")

print("\n=== 过期时间（踩过的坑）===")
ok("23:59" in r["expires"], "过期时间取的是赠送积分那条（23:59），不是会员积分（19:21）")
ok("19:21" not in r["expires"], "不能是会员积分的 19:21")
# 顺序反过来也要对
r2 = XL._jm_pick({URL_C: wrap({
    "credit": {"vip_credit": 725, "gift_credit": 50},
    "expiring_credits": [
        {"credit_amount": 50, "expire_time": today_end()},
        {"credit_amount": 725, "expire_time": today_ts(19, 21)},
    ],
}), URL_H: history_body()})
ok("23:59" in r2["expires"], "顺序换过来也认得出赠送积分")

print("\n=== 今天没发（还没登录/没领到）===")
yesterday = today_ts() - 86400
r3 = XL._jm_pick({
    URL_C: credit_body(gift=0),
    URL_H: history_body([{"amount": 50, "title": "每日免费积分", "create_time": yesterday}]),
})
ok(r3["checked"] is False, "只有昨天的记录 → checked=False")
ok(r3["todayCredit"] == 0, "todayCredit=0")
ok(r3["streak"] == 0, "昨天的不算连续到今天")

print("\n=== 连续天数 ===")
days = [{"amount": 50, "title": "每日免费积分", "create_time": today_ts() - i * 86400}
        for i in range(3)]
r4 = XL._jm_pick({URL_C: credit_body(), URL_H: history_body(days)})
ok(r4["streak"] == 3, "今天 + 前两天都有 → 连续 3 天")
# 中间断一天
gap = [{"amount": 50, "title": "每日免费积分", "create_time": today_ts()},
       {"amount": 50, "title": "每日免费积分", "create_time": today_ts() - 2 * 86400}]
r5 = XL._jm_pick({URL_C: credit_body(), URL_H: history_body(gap)})
ok(r5["streak"] == 1, "中间断一天 → 只算到断的那里（1 天）")

print("\n=== 前缀误判（踩过的坑）===")
# 这是真实场景：页面同时发两个请求，history 先回来、user_credit 后回来。
# 如果判断"都到齐了"用的是 `w in key`，history 一到就误判成齐了，
# 余额那条还没到就被丢掉 → 报"没读到积分数据"。
bodies_history_only = {URL_H: history_body()}
try:
    XL._jm_pick(bodies_history_only)
    ok(False, "只有 history 没有 credit 时应该报错，不能假装成功")
except XL.CheckinError as e:
    ok("没读到积分" in str(e) or "接口" in str(e), "只有 history 时明确报错（不瞎猜）")
ok(URL_H.endswith("/user_credit_history"), "history 的路径确实以 /user_credit 开头（前缀关系成立）")
ok(not URL_C.endswith("/user_credit_history"), "余额路径不以 history 结尾（用 endswith 能区分开）")

print("\n=== 风控 1014 ===")
blocked = json.dumps({"ret": "1014", "errmsg": "system busy", "svr_time": 1793763176})
try:
    XL._jm_pick({URL_C: blocked, URL_H: blocked})
    ok(False, "1014 时应该报错")
except XL.CheckinError as e:
    msg = str(e)
    ok("1014" in msg or "风控" in msg, "1014 时说风控，不说'接口改版'")

print("\n=== 坏数据不能崩 ===")
for label, bodies in [
    ("空 dict", {}),
    ("值不是 JSON", {URL_C: "not json"}),
    ("response 缺失", {URL_C: json.dumps({"ret": "0"})}),
    ("response 不是 JSON", {URL_C: json.dumps({"ret": "0", "response": "{{{"})}),
    ("credit 缺失", {URL_C: wrap({"expiring_credits": []})}),
]:
    try:
        XL._jm_pick(bodies)
        ok(True, "%s → 没崩（返回了结果）" % label)
    except XL.CheckinError:
        ok(True, "%s → 明确报错" % label)
    except Exception as e:
        ok(False, "%s → 崩了：%r" % (label, e))

print("\n" + "-" * 60)
if failed:
    print(" 通过 %d 项，失败 %d 项" % (passed, failed))
    sys.exit(1)
else:
    print(" 全部通过（%d 项）" % passed)

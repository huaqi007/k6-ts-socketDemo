"""
REST 限流功能测试：并发突发请求打限流靶机（8081, MOCK_ORDER_RPS=5），
断言超限响应符合 Binance 约定：HTTP 429/418 + Retry-After 头 + code -1003。
"""
from concurrent.futures import ThreadPoolExecutor

import requests

from helpers.sign import API_KEY, SAMPLE_ORDER, sign_order_query


def _fire_one(rl_base_url):
    query, signature = sign_order_query(SAMPLE_ORDER)
    return requests.post(
        f"{rl_base_url}/api/v3/order?{query}&signature={signature}",
        headers={"X-MBX-APIKEY": API_KEY},
        timeout=5,
    )


def test_burst_triggers_rate_limit(rl_base_url):
    with ThreadPoolExecutor(max_workers=30) as pool:
        responses = list(pool.map(lambda _: _fire_one(rl_base_url), range(30)))

    limited = [r for r in responses if r.status_code in (429, 418)]
    # 必须真的触发限流
    assert len(limited) > 0, "未触发任何 429/418，限流可能未生效"

    # 校验首个被限流响应的头与错误码
    r = limited[0]
    assert r.headers.get("Retry-After") is not None
    assert int(r.headers["Retry-After"]) >= 1
    assert r.json()["code"] == -1003

    # 未被限流的请求应正常成交
    ok = [r for r in responses if r.status_code == 200]
    assert len(ok) > 0

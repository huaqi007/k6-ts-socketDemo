"""
签名下单验签功能测试：1 正 + 4 负，覆盖完整判定分支。
与 k6 的 05-signed-order（性能）、Playwright 的 signed-order.spec（TS 功能）三栈互补。
"""
import time

import requests

from helpers.sign import API_KEY, SAMPLE_ORDER, sign_order_query


def _post_order(base_url, query, signature, api_key=API_KEY):
    return requests.post(
        f"{base_url}/api/v3/order?{query}&signature={signature}",
        headers={"X-MBX-APIKEY": api_key},
        timeout=5,
    )


def test_valid_signature_returns_200(base_url):
    query, signature = sign_order_query(SAMPLE_ORDER)
    r = _post_order(base_url, query, signature)
    assert r.status_code == 200
    body = r.json()
    assert body["orderId"] is not None
    assert body["symbol"] == "BTCUSDT"
    assert body["status"] == "NEW"


def test_tampered_signature_401_1022(base_url):
    query, _ = sign_order_query(SAMPLE_ORDER)
    r = _post_order(base_url, query, "deadbeefdeadbeef")
    assert r.status_code == 401
    assert r.json()["code"] == -1022


def test_wrong_api_key_401_2015(base_url):
    query, signature = sign_order_query(SAMPLE_ORDER)
    r = _post_order(base_url, query, signature, api_key="wrong-api-key")
    assert r.status_code == 401
    assert r.json()["code"] == -2015


def test_missing_signature_400_1102(base_url):
    query, _ = sign_order_query(SAMPLE_ORDER)
    r = requests.post(
        f"{base_url}/api/v3/order?{query}",
        headers={"X-MBX-APIKEY": API_KEY},
        timeout=5,
    )
    assert r.status_code == 400
    assert r.json()["code"] == -1102


def test_expired_timestamp_400_1021(base_url):
    old_ts = int(time.time() * 1000) - 60_000
    query, signature = sign_order_query(SAMPLE_ORDER, timestamp=old_ts)
    r = _post_order(base_url, query, signature)
    assert r.status_code == 400
    assert r.json()["code"] == -1021

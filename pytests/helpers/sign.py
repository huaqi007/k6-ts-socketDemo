"""
sign.py — Binance 风格 HMAC-SHA256 签名助手（Python 版）
============================================================================
与 src/modules/pre-signer.ts、tests/helpers/sign.ts 的签名规则完全一致：
    signature = HMAC_SHA256(secret, 按参数名字母序拼接的 query string)
三套栈（k6 / Playwright / Pytest）对靶机的验签口径统一。
"""
import hashlib
import hmac
import os
import time

API_KEY = os.environ.get("API_KEY", "test-api-key")
API_SECRET = os.environ.get("API_SECRET", "test-api-secret")

SAMPLE_ORDER = {
    "symbol": "BTCUSDT",
    "side": "BUY",
    "type": "LIMIT",
    "timeInForce": "GTC",
    "quantity": 0.01,
    "price": 65000,
}


def sign_order_query(order, recv_window=5000, timestamp=None, secret=None):
    """生成排序后的 query 及其签名，返回 (query, signature)。"""
    params = dict(order)
    params["recvWindow"] = recv_window
    params["timestamp"] = timestamp if timestamp is not None else int(time.time() * 1000)

    query = "&".join(f"{k}={params[k]}" for k in sorted(params.keys()))
    signature = hmac.new(
        (secret or API_SECRET).encode(), query.encode(), hashlib.sha256
    ).hexdigest()
    return query, signature

"""
WebSocket 深度行情功能测试（websocket-client）。
断言：订阅确认 → 深度快照结构有效（bids/asks 非空）→ 增量序列号连续（pu==上一帧u）。
与 k6 的 WS 压测、Playwright 的浏览器 WS 测试三栈互补。
"""
import json
import os

import pytest

websocket = pytest.importorskip("websocket")

WS_URL = os.environ.get("WS_URL", "ws://localhost:8080/ws")


@pytest.mark.ws
def test_depth_subscription_and_sequence():
    ws = websocket.create_connection(WS_URL, timeout=6)
    try:
        ws.send(json.dumps({"method": "SUBSCRIBE", "params": ["btcusdt@depth"], "id": 1}))

        subscribed = False
        depth = []
        deadline_frames = 20  # 最多读 20 帧防止无限阻塞
        while len(depth) < 3 and deadline_frames > 0:
            deadline_frames -= 1
            msg = json.loads(ws.recv())
            if msg.get("method") == "SUBSCRIBED":
                subscribed = True
            elif msg.get("e") == "depthUpdate":
                depth.append(msg)
    finally:
        ws.close()

    assert subscribed, "未收到订阅确认"
    assert len(depth) >= 3, "深度帧不足"

    first = depth[0]
    assert first["s"] == "BTCUSDT"
    assert isinstance(first["bids"], list) and len(first["bids"]) > 0
    assert isinstance(first["asks"], list) and len(first["asks"]) > 0

    # 增量序列号连续：后一帧 pu 应等于前一帧 u
    assert depth[1]["pu"] == depth[0]["u"]
    assert depth[2]["pu"] == depth[1]["u"]

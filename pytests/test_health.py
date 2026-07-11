"""健康检查接口功能测试。"""
import requests


def test_health_ok(base_url):
    r = requests.get(f"{base_url}/api/v1/health", timeout=5)
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

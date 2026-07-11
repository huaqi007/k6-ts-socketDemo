"""
conftest.py — Pytest 会话级夹具：自动拉起（或复用）靶机
============================================================================
- 若 BASE_URL / RL_BASE_URL 指向的靶机已可用（如 docker-compose 里的 mock 服务），
  则直接复用，不再启动本地进程；
- 否则用 `node scripts/mock-server.js` 在本地起两个实例：
    8080 正常靶机、8081 限流靶机（MOCK_ORDER_RPS=5）
  会话结束自动回收。

环境变量：
    BASE_URL     默认 http://localhost:8080
    RL_BASE_URL  默认 http://localhost:8081
"""
import os
import subprocess
import time
from pathlib import Path

import pytest
import requests

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8080")
RL_BASE_URL = os.environ.get("RL_BASE_URL", "http://localhost:8081")

REPO_ROOT = Path(__file__).resolve().parent.parent
MOCK_SCRIPT = REPO_ROOT / "scripts" / "mock-server.js"


def _healthy(base_url, timeout=1.0):
    try:
        r = requests.get(f"{base_url}/api/v1/health", timeout=timeout)
        return r.status_code == 200
    except requests.RequestException:
        return False


def _wait_healthy(base_url, retries=30, interval=0.5):
    for _ in range(retries):
        if _healthy(base_url):
            return True
        time.sleep(interval)
    return False


def _port_of(base_url):
    return base_url.rsplit(":", 1)[-1]


@pytest.fixture(scope="session", autouse=True)
def mock_servers():
    procs = []

    # 正常靶机（8080）
    if not _healthy(BASE_URL):
        env = dict(os.environ, PORT=_port_of(BASE_URL))
        procs.append(subprocess.Popen(["node", str(MOCK_SCRIPT)], env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))

    # 限流靶机（8081, MOCK_ORDER_RPS=5）
    if not _healthy(RL_BASE_URL):
        env = dict(os.environ, PORT=_port_of(RL_BASE_URL), MOCK_ORDER_RPS="5")
        procs.append(subprocess.Popen(["node", str(MOCK_SCRIPT)], env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))

    assert _wait_healthy(BASE_URL), f"正常靶机未就绪: {BASE_URL}"
    assert _wait_healthy(RL_BASE_URL), f"限流靶机未就绪: {RL_BASE_URL}"

    yield

    for p in procs:
        p.terminate()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()


@pytest.fixture
def base_url():
    return BASE_URL


@pytest.fixture
def rl_base_url():
    return RL_BASE_URL

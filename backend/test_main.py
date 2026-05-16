import os
import sqlite3
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def tmp_db(monkeypatch, tmp_path):
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("DB_PATH", str(db_path))
    monkeypatch.setenv("PUREGYM_EMAIL", "test@example.com")
    monkeypatch.setenv("PUREGYM_PIN", "1234")
    monkeypatch.setattr("main.DB_PATH", db_path)
    monkeypatch.setattr("main.PUREGYM_EMAIL", "test@example.com")
    monkeypatch.setattr("main.PUREGYM_PIN", "1234")
    return db_path


@pytest.fixture
def client(tmp_db):
    from main import app, init_db

    init_db()
    return TestClient(app)


@pytest.fixture
def seeded_client(tmp_db):
    from main import app, get_db, init_db

    init_db()
    now = datetime.now(timezone.utc)
    with get_db() as db:
        for i in range(10):
            ts = (now - timedelta(minutes=i * 10)).isoformat()
            db.execute(
                "INSERT INTO readings (timestamp, count, capacity) VALUES (?, ?, ?)",
                (ts, 50 + i * 5, 200),
            )
    return TestClient(app)


class TestHealth:
    def test_health_empty(self, client):
        r = client.get("/api/health")
        assert r.status_code == 200
        assert r.json() == {"status": "ok", "readings": 0}

    def test_health_with_data(self, seeded_client):
        r = seeded_client.get("/api/health")
        assert r.status_code == 200
        assert r.json()["readings"] == 10


class TestStats:
    def test_stats_empty(self, client):
        r = client.get("/api/stats")
        assert r.status_code == 200
        body = r.json()
        assert body["current"] == 0
        assert body["capacity"] == 0
        assert body["last_updated"] == ""

    def test_stats_returns_latest(self, seeded_client):
        r = seeded_client.get("/api/stats")
        assert r.status_code == 200
        body = r.json()
        assert body["current"] == 95
        assert body["capacity"] == 200
        assert body["last_updated"] != ""


class TestToday:
    def test_today_empty(self, client):
        r = client.get("/api/today")
        assert r.status_code == 200
        assert r.json() == []

    def test_today_returns_recent(self, seeded_client):
        r = seeded_client.get("/api/today?tz_offset=0")
        assert r.status_code == 200
        data = r.json()
        assert len(data) > 0
        assert "timestamp" in data[0]
        assert "count" in data[0]

    def test_today_with_tz_offset(self, seeded_client):
        r = seeded_client.get("/api/today?tz_offset=1")
        assert r.status_code == 200

    def test_today_invalid_tz(self, client):
        r = client.get("/api/today?tz_offset=25")
        assert r.status_code == 422


class TestHeatmap:
    def test_heatmap_empty(self, client):
        r = client.get("/api/heatmap")
        assert r.status_code == 200
        assert r.json() == []

    def test_heatmap_returns_grouped(self, tmp_db):
        from main import app, get_db, init_db

        init_db()
        with get_db() as db:
            for day_offset in range(7):
                for hour in range(24):
                    ts = datetime(2026, 5, 12 + day_offset, hour, 30, tzinfo=timezone.utc).isoformat()
                    db.execute(
                        "INSERT INTO readings (timestamp, count, capacity) VALUES (?, ?, ?)",
                        (ts, 30 + hour * 2, 200),
                    )

        client = TestClient(app)
        r = client.get("/api/heatmap?tz_offset=0")
        assert r.status_code == 200
        data = r.json()
        assert len(data) > 0
        for entry in data:
            assert 0 <= entry["day_of_week"] <= 6
            assert 0 <= entry["hour"] <= 23
            assert entry["avg"] >= 0

    def test_heatmap_invalid_tz(self, client):
        r = client.get("/api/heatmap?tz_offset=-15")
        assert r.status_code == 422


class TestPollLoop:
    def test_poll_inserts_reading(self, tmp_db, monkeypatch):
        import main
        from main import get_db, init_db

        init_db()
        monkeypatch.setattr("main.GYM_ID", "123")

        mock_token_response = type("R", (), {
            "status_code": 200,
            "raise_for_status": lambda self: None,
            "json": lambda self: {"access_token": "tok123"},
        })()

        mock_attendance_response = type("R", (), {
            "status_code": 200,
            "raise_for_status": lambda self: None,
            "json": lambda self: {"totalPeopleInGym": 42, "maximumCapacity": 200},
        })()

        original_sleep = main.time.sleep
        main.time.sleep = lambda _: (_ for _ in ()).throw(StopIteration)

        try:
            with patch("main.httpx.post", return_value=mock_token_response), \
                 patch("main.httpx.get", return_value=mock_attendance_response):
                with pytest.raises(StopIteration):
                    main.poll_loop()
        finally:
            main.time.sleep = original_sleep

        with get_db() as db:
            row = db.execute("SELECT count, capacity FROM readings ORDER BY id DESC LIMIT 1").fetchone()
        assert row["count"] == 42
        assert row["capacity"] == 200

    def test_poll_skips_zero_capacity(self, tmp_db):
        from main import get_db, init_db

        init_db()

        mock_token_response = type("R", (), {
            "status_code": 200,
            "raise_for_status": lambda self: None,
            "json": lambda self: {"access_token": "tok123"},
        })()

        mock_attendance_response = type("R", (), {
            "status_code": 200,
            "raise_for_status": lambda self: None,
            "json": lambda self: {"totalPeopleInGym": 0, "maximumCapacity": 0},
        })()

        import main

        main.time.sleep = lambda _: (_ for _ in ()).throw(StopIteration)

        try:
            with patch("main.httpx.post", return_value=mock_token_response), \
                 patch("main.httpx.get", return_value=mock_attendance_response):
                with pytest.raises(StopIteration):
                    main.poll_loop()
        finally:
            import time
            main.time.sleep = time.sleep

        with get_db() as db:
            count = db.execute("SELECT COUNT(*) FROM readings").fetchone()[0]
        assert count == 0

    def test_poll_retries_on_401(self, tmp_db):
        from main import get_db, init_db

        init_db()

        import httpx as real_httpx

        call_log = []

        def mock_post(*args, **kwargs):
            call_log.append("auth")
            resp = type("R", (), {
                "status_code": 200,
                "raise_for_status": lambda self: None,
                "json": lambda self: {"access_token": "tok123"},
            })()
            return resp

        def mock_get(*args, **kwargs):
            if len([c for c in call_log if c == "get"]) == 0:
                call_log.append("get")
                response = real_httpx.Response(401, request=real_httpx.Request("GET", "http://x"))
                raise real_httpx.HTTPStatusError("", request=response.request, response=response)
            call_log.append("get")
            return type("R", (), {
                "status_code": 200,
                "raise_for_status": lambda self: None,
                "json": lambda self: {"totalPeopleInGym": 10, "maximumCapacity": 100},
            })()

        import main

        sleep_count = [0]
        original_sleep = main.time.sleep

        def counting_sleep(_):
            sleep_count[0] += 1
            if sleep_count[0] >= 2:
                raise StopIteration

        main.time.sleep = counting_sleep

        try:
            with patch("main.httpx.post", side_effect=mock_post), \
                 patch("main.httpx.get", side_effect=mock_get):
                with pytest.raises(StopIteration):
                    main.poll_loop()
        finally:
            main.time.sleep = original_sleep

        assert call_log.count("auth") == 2


class TestInitDb:
    def test_creates_tables(self, tmp_db):
        from main import get_db, init_db

        init_db()
        with get_db() as db:
            tables = db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        table_names = [t["name"] for t in tables]
        assert "readings" in table_names

    def test_idempotent(self, tmp_db):
        from main import init_db

        init_db()
        init_db()

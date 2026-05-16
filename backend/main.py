import os
import sqlite3
import threading
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles

DB_PATH = Path(os.getenv("DB_PATH", "data/gym.db"))
PUREGYM_EMAIL = os.environ.get("PUREGYM_EMAIL", "")
PUREGYM_PIN = os.environ.get("PUREGYM_PIN", "")
GYM_ID = os.getenv("GYM_ID", "")
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "600"))
HTTP_TIMEOUT = 15.0


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
    init_db()
    if PUREGYM_EMAIL and PUREGYM_PIN:
        t = threading.Thread(target=poll_loop, daemon=True)
        t.start()
    yield


app = FastAPI(lifespan=lifespan)


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_db() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("""
            CREATE TABLE IF NOT EXISTS readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                count INTEGER NOT NULL,
                capacity INTEGER NOT NULL
            )
        """)
        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(timestamp)
        """)


@contextmanager
def get_db():
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def get_token() -> str:
    r = httpx.post(
        "https://auth.puregym.com/connect/token",
        data={
            "grant_type": "password",
            "username": PUREGYM_EMAIL,
            "password": PUREGYM_PIN,
            "scope": "pgcapi",
            "client_id": "ro.client",
        },
        timeout=HTTP_TIMEOUT,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def resolve_gym_id(token: str) -> str:
    r = httpx.get(
        "https://capi.puregym.com/api/v2/member",
        headers={"Authorization": f"Bearer {token}"},
        timeout=HTTP_TIMEOUT,
    )
    r.raise_for_status()
    return str(r.json()["HomeGym"]["Id"])


def fetch_attendance(token: str, gym_id: str) -> dict:
    r = httpx.get(
        f"https://capi.puregym.com/api/v2/gymSessions/gym?gymId={gym_id}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=HTTP_TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


def poll_loop():
    token = None
    gym_id = GYM_ID

    while True:
        try:
            if token is None:
                token = get_token()
                if not gym_id:
                    gym_id = resolve_gym_id(token)
                    print(f"resolved gym_id={gym_id}")

            data = fetch_attendance(token, gym_id)
            count = data.get("TotalPeopleInGym", 0)
            capacity = data.get("MaximumCapacity", 0) or 300
            ts = datetime.now(timezone.utc).isoformat()

            with get_db() as db:
                db.execute(
                    "INSERT INTO readings (timestamp, count, capacity) VALUES (?, ?, ?)",
                    (ts, count, capacity),
                )
            print(f"[{ts}] count={count} cap={capacity}")

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 401:
                token = None
            else:
                print(f"HTTP error: {e}")
        except Exception as e:
            print(f"Poll error: {e}")
            token = None

        time.sleep(POLL_INTERVAL)


@app.get("/api/health")
def health():
    with get_db() as db:
        count = db.execute("SELECT COUNT(*) FROM readings").fetchone()[0]
    return {"status": "ok", "readings": count}


@app.get("/api/stats")
def stats(tz_offset: int = Query(default=0, ge=-12, le=14)):
    offset_str = f"{tz_offset:+d} hours" if tz_offset != 0 else "0 hours"
    with get_db() as db:
        current = db.execute(
            "SELECT timestamp, count, capacity FROM readings ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if not current:
            return {
                "current": 0, "peak": 0, "avg_now": 0,
                "diff_from_avg": 0, "last_updated": "",
            }

        peak = db.execute("SELECT MAX(count) as peak FROM readings").fetchone()["peak"] or 1

        now = datetime.now(timezone.utc)
        local_now = now + timedelta(hours=tz_offset)
        current_dow = int(local_now.strftime("%w"))
        current_hour = local_now.hour

        avg_row = db.execute(
            f"""
            SELECT avg(count) as avg_count FROM readings
            WHERE cast(strftime('%w', datetime(timestamp, '{offset_str}')) as integer) = ?
            AND cast(strftime('%H', datetime(timestamp, '{offset_str}')) as integer) = ?
            """,
            (current_dow, current_hour),
        ).fetchone()
        avg_now = round(avg_row["avg_count"], 1) if avg_row["avg_count"] else 0

    return {
        "current": current["count"],
        "peak": peak,
        "avg_now": avg_now,
        "diff_from_avg": round(current["count"] - avg_now, 1),
        "last_updated": current["timestamp"],
    }


@app.get("/api/today")
def today_readings(tz_offset: int = Query(default=0, ge=-12, le=14)):
    now = datetime.now(timezone.utc)
    local_offset = timedelta(hours=tz_offset)
    local_now = now + local_offset
    start = local_now.replace(hour=0, minute=0, second=0, microsecond=0) - local_offset
    with get_db() as db:
        rows = db.execute(
            "SELECT timestamp, count, capacity FROM readings WHERE timestamp >= ? ORDER BY timestamp",
            (start.isoformat(),),
        ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/predicted")
def predicted_today(tz_offset: int = Query(default=0, ge=-12, le=14)):
    """Average count for each hour of today + first 6h of tomorrow."""
    now = datetime.now(timezone.utc)
    local_now = now + timedelta(hours=tz_offset)
    current_dow = int(local_now.strftime("%w"))
    next_dow = (current_dow + 1) % 7
    offset_str = f"{tz_offset:+d} hours" if tz_offset != 0 else "0 hours"

    with get_db() as db:
        rows = db.execute(
            f"""
            SELECT
                cast(strftime('%w', datetime(timestamp, '{offset_str}')) as integer) as dow,
                cast(strftime('%H', datetime(timestamp, '{offset_str}')) as integer) as hour,
                avg(count) as avg_count,
                max(count) as max_count,
                min(count) as min_count
            FROM readings
            WHERE cast(strftime('%w', datetime(timestamp, '{offset_str}')) as integer) IN (?, ?)
            GROUP BY dow, hour
            ORDER BY dow, hour
            """,
            (current_dow, next_dow),
        ).fetchall()
    result = []
    for r in rows:
        is_tomorrow = r["dow"] == next_dow
        if is_tomorrow and r["hour"] >= 6:
            continue
        offset = 24 if is_tomorrow else 0
        result.append({
            "hour": r["hour"] + offset,
            "avg": round(r["avg_count"], 1),
            "max": r["max_count"],
            "min": r["min_count"],
        })
    return result


@app.get("/api/heatmap")
def heatmap(tz_offset: int = Query(default=0, ge=-12, le=14)):
    cutoff = (datetime.now(timezone.utc) - timedelta(days=28)).isoformat()
    offset_str = f"{tz_offset:+d} hours" if tz_offset != 0 else "0 hours"
    with get_db() as db:
        rows = db.execute(
            f"""
            SELECT
                cast(strftime('%w', datetime(timestamp, '{offset_str}')) as integer) as dow,
                cast(strftime('%H', datetime(timestamp, '{offset_str}')) as integer) * 2
                    + case when cast(strftime('%M', datetime(timestamp, '{offset_str}')) as integer) >= 30 then 1 else 0 end as slot,
                avg(count) as avg_count
            FROM readings
            WHERE timestamp >= ?
            GROUP BY dow, slot
            ORDER BY dow, slot
            """,
            (cutoff,),
        ).fetchall()
    result = []
    for r in rows:
        dow = (r["dow"] - 1) % 7
        result.append({"day_of_week": dow, "slot": r["slot"], "avg": round(r["avg_count"], 1)})
    return result


@app.get("/api/visits")
def visits():
    """Personal visit history from PureGym."""
    if not PUREGYM_EMAIL or not PUREGYM_PIN:
        return {"visits": [], "summary": None}
    try:
        token = get_token()
        r = httpx.get(
            "https://capi.puregym.com/api/v2/gymSessions/member",
            params={
                "fromDate": "2020-01-01T00:00:00",
                "toDate": datetime.now(timezone.utc).isoformat(),
            },
            headers={"Authorization": f"Bearer {token}"},
            timeout=HTTP_TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        visits = []
        for v in data.get("Visits", []):
            visits.append({
                "start": v.get("StartTime"),
                "duration": v.get("Duration"),
                "gym": v.get("Gym", {}).get("Name", ""),
                "estimated": v.get("IsDurationEstimated", False),
            })
        return {
            "visits": visits,
            "summary": data.get("Summary"),
        }
    except Exception as e:
        print(f"Visits error: {e}")
        return {"visits": [], "summary": None}


@app.get("/api/membership")
def membership():
    """Membership details."""
    if not PUREGYM_EMAIL or not PUREGYM_PIN:
        return {}
    try:
        token = get_token()
        r = httpx.get(
            "https://capi.puregym.com/api/v2/member/membership",
            headers={"Authorization": f"Bearer {token}"},
            timeout=HTTP_TIMEOUT,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"Membership error: {e}")
        return {}


static_dir = Path(__file__).parent / "static"
if static_dir.exists():
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")

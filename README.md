# purergym

Minimal PureGym occupancy dashboard. Polls the PureGym API every 10 minutes, stores readings in SQLite, serves a compact dashboard with live count, today's chart, and a weekly heatmap.

## Setup

```bash
cp .env.example .env
# fill in PUREGYM_EMAIL, PUREGYM_PIN
# GYM_ID is optional (auto-resolves to your home gym)
```

## Deploy

```bash
docker compose up -d --build
```

Runs on port 8000. Data persists in a Docker volume.

## Local dev

```bash
# backend
cd backend
pip install -r requirements.txt
uvicorn main:app --reload

# frontend (separate terminal)
cd frontend
pnpm install
pnpm dev
```

Vite proxies `/api` to `localhost:8000`.

## Tests

```bash
cd backend
pytest test_main.py -v
```

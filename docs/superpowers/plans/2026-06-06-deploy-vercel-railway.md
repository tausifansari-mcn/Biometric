# Deploy Vercel + Railway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the React frontend to Vercel and the FastAPI backend to Railway with all credentials in environment variables, pyodbc/SQL Server support via Dockerfile, and a working CI/CD pipeline.

**Architecture:** Frontend (React CRA) → Vercel static site, root directory `attendance-frontend/`. Backend (FastAPI + pyodbc + mysql-connector) → Railway Docker container built from `attendance-frontend/backend/Dockerfile` which installs Microsoft ODBC Driver 17 (required by pyodbc on Linux). All secrets live in Railway/Vercel environment variable dashboards and `.env` files (never committed).

**Tech Stack:** React 19 (CRA), FastAPI, pyodbc (SQL Server via ODBC 17), mysql-connector-python, python-dotenv, PyJWT, Docker (Debian 11 slim), Railway, Vercel, GitHub Actions

---

## Critical Deployment Blockers Identified

| # | Blocker | Fix |
|---|---------|-----|
| 1 | `pyodbc` requires Microsoft ODBC Driver 17 — not available on Railway's default nixpacks Linux image | Dockerfile: install `msodbcsql17` from Microsoft apt repo |
| 2 | Backend CORS only allows `localhost:3000` | Read `CORS_ORIGINS` from env var |
| 3 | All DB credentials hardcoded in `main.py` | Move to `os.getenv()` + `.env` |
| 4 | `SECRET_KEY` hardcoded (`your-secret-key-change-in-production`) | Move to `JWT_SECRET_KEY` env var |
| 5 | Backend binds to port 8000, not Railway's `$PORT` | Dockerfile `CMD` uses `${PORT:-8000}` |
| 6 | No `/health` endpoint for Railway health checks | Add `GET /health → {"status": "ok"}` |
| 7 | No `vercel.json` — Vercel won't know to SPA-redirect all routes to `index.html` | Create `vercel.json` with rewrites |
| 8 | No `.gitignore` — pycache, `.env`, `node_modules` not excluded | Create root `.gitignore` |

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `attendance-frontend/backend/main.py` | Modify | Env vars, health endpoint, dynamic CORS |
| `attendance-frontend/backend/requirements.txt` | Modify | Add `uvicorn[standard]` |
| `attendance-frontend/backend/Dockerfile` | Create | ODBC Driver 17 install + app packaging |
| `attendance-frontend/backend/railway.json` | Create | Railway service config + health check path |
| `attendance-frontend/backend/Procfile` | Create | Fallback start command for Railway |
| `attendance-frontend/backend/.env.example` | Create | Document all backend env vars |
| `attendance-frontend/vercel.json` | Create | SPA rewrite rules + build config |
| `attendance-frontend/.env.example` | Create | Document frontend env var |
| `.gitignore` | Create | Exclude `.env`, `__pycache__`, `node_modules`, `build` |
| `.github/workflows/deploy-backend.yml` | Create | Auto-deploy backend to Railway on push to main |
| `.github/workflows/deploy-frontend.yml` | Create | Auto-deploy frontend to Vercel on push to main |

---

## Task 1: Fix backend — env vars, health endpoint, dynamic CORS

**Files:**
- Modify: `attendance-frontend/backend/main.py`

- [ ] **Step 1: Rewrite the top of main.py to load env vars**

Replace the hardcoded config block (lines 1–58) with:

```python
import base64
import hashlib
import hmac
import os
import secrets
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Header, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pyodbc
import mysql.connector
from mysql.connector import Error as MySQLError
from datetime import datetime, timedelta
from typing import Literal, Optional
import jwt

load_dotenv()

app = FastAPI(title="Attendance + Holiday API (Multi-DB)")

# CORS — comma-separated list from env, e.g. "https://foo.vercel.app,http://localhost:3000"
_raw_origins = os.getenv("CORS_ORIGINS", "http://localhost:3000")
CORS_ALLOWED_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- JWT Settings ----------
SECRET_KEY = os.getenv("JWT_SECRET_KEY", "change-me-in-production")
ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = 8
PASSWORD_ITERATIONS = 210_000

# ---------- Database Configurations ----------
ATTENDANCE_CONFIG = {
    'server':   os.getenv("SQL_SERVER",   "172.10.10.146"),
    'port':     int(os.getenv("SQL_PORT", "1433")),
    'database': os.getenv("SQL_DATABASE", "NCOSEC"),
    'username': os.getenv("SQL_USER",     "shivamg"),
    'password': os.getenv("SQL_PASSWORD", ""),
    'driver':   os.getenv("SQL_DRIVER",   "{ODBC Driver 17 for SQL Server}"),
}

EMPLOYEE_CONFIG = {
    'host':     os.getenv("MYSQL_HOST",     "122.184.128.90"),
    'port':     int(os.getenv("MYSQL_PORT", "3306")),
    'database': os.getenv("MYSQL_DATABASE", "Shivamgiri"),
    'user':     os.getenv("MYSQL_USER",     "root"),
    'password': os.getenv("MYSQL_PASSWORD", ""),
}
```

- [ ] **Step 2: Add /health endpoint immediately after root()**

Insert after the `@app.get("/")` route (after line 209 in original):

```python
@app.get("/health")
def health():
    return {"status": "ok"}
```

- [ ] **Step 3: Verify no other hardcoded secrets remain**

Run in the backend directory:
```
grep -n "Noida\|vicidial\|your-secret-key\|172\.10\|122\.184\|shivamg\|root" main.py
```
Expected output: empty (no matches)

- [ ] **Step 4: Commit**

```bash
git add attendance-frontend/backend/main.py
git commit -m "fix: move all DB credentials and JWT secret to environment variables; add /health endpoint"
```

---

## Task 2: Update requirements.txt

**Files:**
- Modify: `attendance-frontend/backend/requirements.txt`

- [ ] **Step 1: Replace requirements.txt content**

```
fastapi==0.115.5
uvicorn[standard]==0.32.1
pyodbc==5.2.0
mysql-connector-python==9.1.0
python-dotenv==1.0.1
pyjwt==2.10.1
```

Rationale:
- `uvicorn[standard]` adds websocket + http2 support and is the Railway-recommended form
- Pinned versions prevent surprise build breaks in CI

- [ ] **Step 2: Commit**

```bash
git add attendance-frontend/backend/requirements.txt
git commit -m "fix: pin Python dependencies and use uvicorn[standard] for Railway"
```

---

## Task 3: Create Dockerfile for backend

**Files:**
- Create: `attendance-frontend/backend/Dockerfile`

This is the **most critical file** — without it, pyodbc cannot connect to SQL Server on Railway because the Microsoft ODBC Driver 17 is not available in the default nixpacks image.

- [ ] **Step 1: Create the Dockerfile**

```dockerfile
# Use Debian 11 (bullseye) slim — msodbcsql17 has stable apt support here
FROM python:3.11-slim-bullseye

# Install Microsoft ODBC Driver 17 for SQL Server
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        gnupg2 \
        apt-transport-https \
    && curl https://packages.microsoft.com/keys/microsoft.asc | apt-key add - \
    && curl https://packages.microsoft.com/config/debian/11/prod.list \
        > /etc/apt/sources.list.d/mssql-release.list \
    && apt-get update \
    && ACCEPT_EULA=Y apt-get install -y --no-install-recommends \
        msodbcsql17 \
        unixodbc-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first (cached unless requirements.txt changes)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY . .

# Railway injects PORT at runtime; default to 8000 for local Docker runs
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
```

- [ ] **Step 2: Commit**

```bash
git add attendance-frontend/backend/Dockerfile
git commit -m "feat: add Dockerfile with Microsoft ODBC Driver 17 for Railway deployment"
```

---

## Task 4: Create Railway configuration files

**Files:**
- Create: `attendance-frontend/backend/railway.json`
- Create: `attendance-frontend/backend/Procfile`

- [ ] **Step 1: Create railway.json**

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "startCommand": "uvicorn main:app --host 0.0.0.0 --port $PORT",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 300,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

- [ ] **Step 2: Create Procfile (fallback)**

```
web: uvicorn main:app --host 0.0.0.0 --port $PORT
```

- [ ] **Step 3: Commit**

```bash
git add attendance-frontend/backend/railway.json attendance-frontend/backend/Procfile
git commit -m "feat: add Railway deployment config with Dockerfile builder and health check"
```

---

## Task 5: Create .env.example files

**Files:**
- Create: `attendance-frontend/backend/.env.example`
- Create: `attendance-frontend/.env.example`

- [ ] **Step 1: Create backend .env.example**

```bash
# attendance-frontend/backend/.env.example
# Copy to .env and fill in real values. Never commit .env.

# SQL Server (biometric attendance database)
SQL_SERVER=172.10.10.146
SQL_PORT=1433
SQL_DATABASE=NCOSEC
SQL_USER=shivamg
SQL_PASSWORD=your-sql-password-here
SQL_DRIVER={ODBC Driver 17 for SQL Server}

# MySQL (employee + holiday database)
MYSQL_HOST=122.184.128.90
MYSQL_PORT=3306
MYSQL_DATABASE=Shivamgiri
MYSQL_USER=root
MYSQL_PASSWORD=your-mysql-password-here

# JWT — generate with: python -c "import secrets; print(secrets.token_hex(32))"
JWT_SECRET_KEY=change-this-to-a-random-64-char-hex-string

# CORS — comma-separated list of allowed origins
# Add your Vercel URL here after first deploy, e.g.:
# CORS_ORIGINS=https://biometric-abc123.vercel.app,http://localhost:3000
CORS_ORIGINS=http://localhost:3000
```

- [ ] **Step 2: Create frontend .env.example**

```bash
# attendance-frontend/.env.example
# Copy to .env and fill in real values. Never commit .env.

# Set to your Railway backend URL after backend is deployed
# e.g. https://biometric-backend-production.up.railway.app
REACT_APP_API_BASE_URL=http://localhost:8000
```

- [ ] **Step 3: Commit**

```bash
git add attendance-frontend/backend/.env.example attendance-frontend/.env.example
git commit -m "docs: add .env.example files for both services"
```

---

## Task 6: Create vercel.json for frontend

**Files:**
- Create: `attendance-frontend/vercel.json`

- [ ] **Step 1: Create vercel.json**

Vercel needs this to:
1. Serve the CRA `build/` output
2. Rewrite all unmatched routes to `index.html` (required for React Router — even though this app uses no router, it prevents 404s on hard refresh)

```json
{
  "version": 2,
  "buildCommand": "npm run build",
  "outputDirectory": "build",
  "framework": null,
  "rewrites": [
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

> Note: `"framework": null` tells Vercel not to auto-detect — we control `buildCommand` explicitly.

- [ ] **Step 2: Commit**

```bash
git add attendance-frontend/vercel.json
git commit -m "feat: add vercel.json for React CRA deployment with SPA rewrite"
```

---

## Task 7: Create root .gitignore

**Files:**
- Create: `.gitignore` (repo root)

- [ ] **Step 1: Create .gitignore**

```gitignore
# Python
__pycache__/
*.py[cod]
*.pyo
*.pyd
.Python
*.egg-info/
dist/
build/
.venv/
venv/
env/
.env
*.env

# Node / React
node_modules/
attendance-frontend/build/
attendance-frontend/.env
attendance-frontend/.env.local
attendance-frontend/.env.*.local
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# IDE
.vscode/
.idea/
*.swp
*.swo
.DS_Store
Thumbs.db

# Docker
*.dockerignore

# Misc
*.zip
*.tar.gz
```

- [ ] **Step 2: Also create backend .dockerignore to speed up Docker builds**

Create `attendance-frontend/backend/.dockerignore`:

```
__pycache__
*.py[cod]
*.pyo
.env
.git
.gitignore
*.md
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore attendance-frontend/backend/.dockerignore
git commit -m "chore: add root .gitignore and backend .dockerignore"
```

---

## Task 8: Create GitHub Actions CI/CD workflows

**Files:**
- Create: `.github/workflows/deploy-backend.yml`
- Create: `.github/workflows/deploy-frontend.yml`

Required GitHub repository secrets (set once in repo Settings → Secrets → Actions):
- `RAILWAY_TOKEN` — from Railway dashboard → Account Settings → Tokens
- `VERCEL_TOKEN` — from Vercel dashboard → Account Settings → Tokens
- `VERCEL_ORG_ID` — from `.vercel/project.json` after first Vercel link
- `VERCEL_PROJECT_ID` — from `.vercel/project.json` after first Vercel link

- [ ] **Step 1: Create backend deploy workflow**

```yaml
# .github/workflows/deploy-backend.yml
name: Deploy Backend to Railway

on:
  push:
    branches: [main]
    paths:
      - 'attendance-frontend/backend/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Install Railway CLI
        run: npm install -g @railway/cli@latest

      - name: Deploy to Railway
        run: railway up --service backend --detach
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
        working-directory: attendance-frontend/backend
```

- [ ] **Step 2: Create frontend deploy workflow**

```yaml
# .github/workflows/deploy-frontend.yml
name: Deploy Frontend to Vercel

on:
  push:
    branches: [main]
    paths:
      - 'attendance-frontend/**'
      - '!attendance-frontend/backend/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: attendance-frontend/package-lock.json

      - name: Install dependencies
        run: npm ci
        working-directory: attendance-frontend

      - name: Build
        run: npm run build
        working-directory: attendance-frontend
        env:
          REACT_APP_API_BASE_URL: ${{ secrets.REACT_APP_API_BASE_URL }}

      - name: Deploy to Vercel
        uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          working-directory: attendance-frontend
          vercel-args: '--prod'
```

- [ ] **Step 3: Create workflows directory and commit**

```bash
mkdir -p .github/workflows
git add .github/workflows/deploy-backend.yml .github/workflows/deploy-frontend.yml
git commit -m "feat: add GitHub Actions CI/CD for Railway (backend) and Vercel (frontend)"
```

---

## Task 9: Push all changes to GitHub

- [ ] **Step 1: Verify remote is correct**

```bash
git remote -v
```
Expected: `origin  https://github.com/tausifansari-mcn/Biometric.git (fetch)`

- [ ] **Step 2: Push to main**

```bash
git push origin main
```

- [ ] **Step 3: Verify push succeeded on GitHub**

Open: https://github.com/tausifansari-mcn/Biometric

---

## Task 10: Deploy backend to Railway

Manual first deploy (subsequent deploys happen via GitHub Actions).

- [ ] **Step 1: Install Railway CLI (if not already installed)**

```bash
npm install -g @railway/cli
```

- [ ] **Step 2: Login to Railway**

```bash
railway login
```
This opens a browser window. Complete OAuth flow.

- [ ] **Step 3: Create a new Railway project (or link existing)**

```bash
# Run from the backend directory
cd attendance-frontend/backend
railway init
```
Name the service `biometric-backend`.

- [ ] **Step 4: Link GitHub repo to Railway project**

In Railway dashboard:
1. Open the project → Settings → Source → Connect GitHub repo
2. Select `tausifansari-mcn/Biometric`
3. Set **Root Directory** to `attendance-frontend/backend`
4. Railway auto-detects the Dockerfile

- [ ] **Step 5: Set all environment variables in Railway dashboard**

Navigate to: Project → Service → Variables → Add Variable

```
SQL_SERVER=172.10.10.146
SQL_PORT=1433
SQL_DATABASE=NCOSEC
SQL_USER=shivamg
SQL_PASSWORD=Noida$1234
SQL_DRIVER={ODBC Driver 17 for SQL Server}
MYSQL_HOST=122.184.128.90
MYSQL_PORT=3306
MYSQL_DATABASE=Shivamgiri
MYSQL_USER=root
MYSQL_PASSWORD=vicidialnow
JWT_SECRET_KEY=<generate with: python -c "import secrets; print(secrets.token_hex(32))">
CORS_ORIGINS=http://localhost:3000
```
> `CORS_ORIGINS` will be updated in Task 11 after we get the Vercel URL.

- [ ] **Step 6: Trigger first deploy**

```bash
railway up --detach
```

Expected: Build starts, Docker image built, ODBC driver installed, app starts.

- [ ] **Step 7: Verify health check**

```bash
railway logs --tail 50
```

Then:
```bash
curl https://<your-railway-domain>.up.railway.app/health
```
Expected response: `{"status":"ok"}`

- [ ] **Step 8: Note Railway URL**

Format: `https://biometric-backend-production.up.railway.app`
(visible in Railway dashboard → Settings → Domains)

---

## Task 11: Deploy frontend to Vercel

- [ ] **Step 1: Install Vercel CLI (if not already installed)**

```bash
npm install -g vercel
```

- [ ] **Step 2: Login to Vercel**

```bash
vercel login
```

- [ ] **Step 3: Link and configure project**

```bash
cd attendance-frontend
vercel link
```

Prompts:
- "Link to existing project?" → N (first time)
- "Project name?" → `biometric-attendance`
- "Which directory is your code?" → `.` (current dir = `attendance-frontend/`)
- Framework: detected as Create React App → accept

- [ ] **Step 4: Set the REACT_APP_API_BASE_URL environment variable in Vercel**

```bash
vercel env add REACT_APP_API_BASE_URL production
```
Enter value: `https://<your-railway-domain>.up.railway.app`
(the URL from Task 10 Step 8)

- [ ] **Step 5: Deploy to production**

```bash
vercel --prod
```

Expected output includes: `✅  Production: https://biometric-attendance.vercel.app`

- [ ] **Step 6: Update CORS_ORIGINS on Railway**

Now that we have the Vercel URL, update Railway env var:

In Railway dashboard → Variables:
```
CORS_ORIGINS=https://biometric-attendance.vercel.app,http://localhost:3000
```

Trigger a redeploy:
```bash
railway redeploy
```

- [ ] **Step 7: End-to-end smoke test**

1. Open Vercel URL in browser
2. Login with a valid employee code + `EmpCode@123`
3. Confirm attendance calendar loads
4. Open browser devtools → Network tab → confirm API calls go to Railway URL (not localhost)
5. Confirm no CORS errors in Console

- [ ] **Step 8: Add GitHub secrets for future CI/CD deploys**

In GitHub repo → Settings → Secrets and variables → Actions → New repository secret:

```
RAILWAY_TOKEN=<from Railway Account Settings → Tokens>
VERCEL_TOKEN=<from Vercel Account Settings → Tokens>
VERCEL_ORG_ID=<from attendance-frontend/.vercel/project.json>
VERCEL_PROJECT_ID=<from attendance-frontend/.vercel/project.json>
REACT_APP_API_BASE_URL=https://<your-railway-domain>.up.railway.app
```

---

## Self-Review Checklist

| Requirement | Covered in Task |
|-------------|----------------|
| Analyze repository structure | Pre-plan (done) |
| Fix deployment-blocking issues | Tasks 1–3 |
| Create vercel.json | Task 6 |
| Create railway.json | Task 4 |
| Create Procfile | Task 4 |
| Update requirements.txt | Task 2 |
| Create .gitignore | Task 7 |
| Create .env.example | Task 5 |
| Remove hardcoded DB credentials | Task 1 |
| FastAPI binds to $PORT | Task 3 (Dockerfile CMD) |
| CORS configured for Vercel | Tasks 1 + 11 Step 6 |
| React uses env-based API URL | Pre-existing (App.js line 6) |
| /health endpoint | Task 1 Step 2 |
| pyodbc + SQL Server on Railway | Task 3 (Dockerfile) |
| GitHub Actions CI/CD | Task 8 |
| Deploy backend to Railway | Task 10 |
| Deploy frontend to Vercel | Task 11 |
| Provide production URLs | Task 11 Step 5 + Task 10 Step 8 |
| Final verification | Task 11 Step 7 |

---

## Exact Environment Variables Reference

### Railway (backend)
| Variable | Example Value |
|----------|--------------|
| `SQL_SERVER` | `172.10.10.146` |
| `SQL_PORT` | `1433` |
| `SQL_DATABASE` | `NCOSEC` |
| `SQL_USER` | `shivamg` |
| `SQL_PASSWORD` | _(secret)_ |
| `SQL_DRIVER` | `{ODBC Driver 17 for SQL Server}` |
| `MYSQL_HOST` | `122.184.128.90` |
| `MYSQL_PORT` | `3306` |
| `MYSQL_DATABASE` | `Shivamgiri` |
| `MYSQL_USER` | `root` |
| `MYSQL_PASSWORD` | _(secret)_ |
| `JWT_SECRET_KEY` | _(random hex 32)_ |
| `CORS_ORIGINS` | `https://your-app.vercel.app,http://localhost:3000` |
| `PORT` | _(auto-injected by Railway)_ |

### Vercel (frontend)
| Variable | Example Value |
|----------|--------------|
| `REACT_APP_API_BASE_URL` | `https://biometric-backend-production.up.railway.app` |

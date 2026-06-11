FROM python:3.11-slim-bullseye

# gcc + libfreetds-dev only needed if pymssql has no pre-built wheel
# for the build platform (e.g. arm64). On amd64 the manylinux wheel is used.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        gcc \
        libfreetds-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY attendance-frontend/backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY attendance-frontend/backend/ .

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]

# eva-agent-backend — máquina del Backend Agent del Dev Studio.
#
# Extiende eva-agent-base con runtimes de backend pre-instalados para que el
# agente no pague install-time: Python (venv + pip), PHP, Go, y cliente de
# PostgreSQL. Toolchain de build para compilar dependencias nativas.
#
# Requiere la imagen base construida antes:
#   docker build -t eva-agent-base    docker/agents/base
#   docker build -t eva-agent-backend docker/agents/backend
FROM eva-agent-base

USER root

# python3 + venv + pip: backend en Python (FastAPI/Django/Flask).
# php-cli + composer: backend en PHP (Laravel/Symfony).
# golang: backend en Go.
# postgresql-client: psql para inspeccionar/migrar BD.
# build-essential + pkg-config + libpq-dev: compilar deps nativas (psycopg, etc.).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    php-cli \
    php-mbstring \
    php-xml \
    php-curl \
    composer \
    golang \
    postgresql-client \
    build-essential \
    pkg-config \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Librerías de backend Python comunes, pre-horneadas en un venv del sistema.
RUN python3 -m pip install --no-cache-dir --break-system-packages \
    fastapi \
    uvicorn \
    "psycopg[binary]" \
    sqlalchemy \
    alembic \
    pydantic \
    requests \
    httpx \
    python-dotenv \
    pytest

USER agent
ENV EVA_AGENT_TIER=backend

CMD ["tail", "-f", "/dev/null"]

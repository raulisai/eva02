# eva-agent-testing — máquina del Testing Agent del Dev Studio.
#
# Extiende eva-agent-base con todas las librerías de testing pre-instaladas para
# que el agente no las reinstale por tarea: Playwright (con navegadores y sus
# dependencias de sistema), Vitest/Jest para JS/TS, y pytest para Python.
#
# Requiere la imagen base construida antes:
#   docker build -t eva-agent-base    docker/agents/base
#   docker build -t eva-agent-testing docker/agents/testing
FROM eva-agent-base

USER root

# python3 + pip: para pytest.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Runners de test JS/TS, globales.
RUN npm install -g \
    vitest \
    jest \
    @playwright/test \
    playwright

# Navegadores de Playwright + sus dependencias de sistema (chromium/firefox/webkit).
# `--with-deps` instala las libs del SO; debe correr como root.
RUN npx playwright install --with-deps chromium firefox webkit

# pytest + plugins comunes.
RUN python3 -m pip install --no-cache-dir --break-system-packages \
    pytest \
    pytest-asyncio \
    pytest-cov \
    playwright

# Los navegadores se instalaron en el home de root; muévelos a una ruta que el
# usuario `agent` pueda leer y apúntalo con PLAYWRIGHT_BROWSERS_PATH.
RUN mkdir -p /opt/ms-playwright \
    && cp -r /root/.cache/ms-playwright/. /opt/ms-playwright/ 2>/dev/null || true \
    && chmod -R a+rX /opt/ms-playwright

USER agent
ENV EVA_AGENT_TIER=testing \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

CMD ["tail", "-f", "/dev/null"]

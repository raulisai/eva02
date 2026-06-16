# eva-claude-sandbox — máquina pre-horneada con Claude Code para los agentes
# de código del Dev Studio (backend / frontend / testing).
#
# A diferencia de eva-sandbox (que ejecuta código suelto), esta imagen trae el
# CLI `claude` instalado para que un agente de código corra Claude Code headless
# dentro del contenedor, autenticado con la credencial del org (token de
# suscripción OAuth, API key de Anthropic, o credencial por organización).
#
# Build:    docker build -t eva-claude-sandbox docker/claude-sandbox
# Override: EVA_CLAUDE_SANDBOX_IMAGE=<otra-imagen>
#
# Red en runtime: SIEMPRE ON (--network bridge). Claude Code necesita salir a la
# API de Anthropic. La credencial se inyecta como variable de entorno en runtime
# (CLAUDE_CODE_OAUTH_TOKEN o ANTHROPIC_API_KEY); nunca se hornea en la imagen.
FROM node:20-slim

# git: Claude Code lo usa para operaciones de repo (diffs, commits en /work).
# bash + util-linux (script): shell persistente con PTY real (estado entre pasos).
# ca-certificates + curl: TLS hacia la API de Anthropic.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    bash \
    curl \
    ca-certificates \
    util-linux \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# CLI oficial de Claude Code, pre-horneado para no pagar install-time por tarea.
RUN npm install -g @anthropic-ai/claude-code

# Usuario sin privilegios. /work es el volumen persistente por tarea.
RUN useradd --create-home agent
USER agent
WORKDIR /work

# Claude Code en modo no-interactivo no requiere onboarding; estos flags evitan
# el prompt de telemetría/primer arranque dentro del contenedor.
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    CI=1

CMD ["tail", "-f", "/dev/null"]

# eva-agent-base — máquina base para TODOS los agentes del Dev Studio.
#
# Reemplaza a eva-claude-sandbox como imagen común: trae el CLI `claude` + git +
# herramientas de análisis ligeras (ripgrep, jq). La usan directamente los roles
# de análisis (architect, project_manager, reviewer, deployment, preview, devops),
# y es la base (FROM) de las imágenes especializadas de código (backend/frontend/
# testing).
#
# Build (PRIMERO, las demás dependen de ésta):
#   docker build -t eva-agent-base docker/agents/base
# Override por rol: EVA_AGENT_IMAGE_<ROL>  ·  base: EVA_AGENT_BASE_IMAGE
#
# Red en runtime: SIEMPRE ON (--network bridge). La credencial de Claude Code se
# inyecta como env var en runtime (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY);
# nunca se hornea en la imagen.
FROM node:20-slim

# git: operaciones de repo (diffs, commits en /work).
# bash + util-linux (script): shell persistente con PTY real (estado entre pasos).
# ca-certificates + curl: TLS hacia la API de Anthropic.
# ripgrep + jq: análisis/lectura de repos para los roles de análisis.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    bash \
    curl \
    ca-certificates \
    util-linux \
    ripgrep \
    jq \
    && rm -rf /var/lib/apt/lists/*

# CLI oficial de Claude Code, pre-horneado para no pagar install-time por tarea.
RUN npm install -g @anthropic-ai/claude-code

# Usuario sin privilegios. /work es el volumen persistente por agente.
RUN useradd --create-home agent
USER agent
WORKDIR /work

ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    CI=1 \
    EVA_AGENT_TIER=base

CMD ["tail", "-f", "/dev/null"]

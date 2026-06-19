# eva-agent-frontend — máquina del Frontend Agent del Dev Studio.
#
# Extiende eva-agent-base con el toolchain de frontend pre-instalado: pnpm, yarn,
# y los scaffolders/CLIs más usados (Next.js, Vite, TypeScript) cacheados a nivel
# global para que `create-next-app`/`vite` arranquen sin descargar todo de cero.
#
# Requiere la imagen base construida antes:
#   docker build -t eva-agent-base     docker/agents/base
#   docker build -t eva-agent-frontend docker/agents/frontend
FROM eva-agent-base

USER root

# Gestores de paquetes alternativos a npm (los proyectos los suelen exigir).
RUN corepack enable && corepack prepare pnpm@latest --activate \
    && corepack prepare yarn@stable --activate

# CLIs/herramientas globales de frontend, pre-horneadas.
# create-next-app + vite: scaffolding rápido. typescript + serve: build y preview.
RUN npm install -g \
    create-next-app \
    vite \
    typescript \
    serve

# Pre-cachear React/Next en el cache de npm para acelerar el primer install del
# proyecto (no se instalan globalmente, solo se calientan en el cache).
RUN npm cache add react@latest react-dom@latest next@latest || true

USER agent
ENV EVA_AGENT_TIER=frontend

CMD ["tail", "-f", "/dev/null"]

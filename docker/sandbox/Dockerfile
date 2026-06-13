# eva-sandbox — imagen enriquecida para el sandbox de código de EVA.
#
# SandboxService la usa automáticamente para python (sesiones y one-shot)
# cuando existe localmente; si no, cae a python:3.12-alpine pelado.
#
# Build:    docker build -t eva-sandbox docker/sandbox
# Override: EVA_SANDBOX_IMAGE=<otra-imagen>   (vacío = forzar fallback alpine)
#
# Red en runtime: OFF por defecto (--network none). Si EVA_SANDBOX_ALLOW_NETWORK=true
# el SandboxService puede crear sesiones con --network bridge para downloads.
# Las dependencias van pre-horneadas aquí para que el agente no pague install-time.
FROM python:3.12-slim

# ffmpeg: requerido por yt-dlp para muxing de video+audio en YouTube
# bash + util-linux (script): habilitan el shell persistente con PTY real del
# SandboxService (estado entre pasos + detección de diálogos interactivos).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    bash \
    util-linux \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    requests \
    pandas \
    numpy \
    openpyxl \
    pillow \
    python-dateutil \
    beautifulsoup4 \
    yt-dlp

# Usuario sin privilegios para ejecuciones aisladas (sin red).
# Para sesiones con red, SandboxService puede omitir --read-only para
# que yt-dlp pueda escribir archivos temporales fuera de /work.
RUN useradd --create-home sandbox
USER sandbox
WORKDIR /work

CMD ["tail", "-f", "/dev/null"]

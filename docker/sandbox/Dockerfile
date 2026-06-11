# eva-sandbox — imagen enriquecida para el sandbox de código de EVA.
#
# SandboxService la usa automáticamente para python (sesiones y one-shot)
# cuando existe localmente; si no, cae a python:3.12-alpine pelado.
#
# Build:    docker build -t eva-sandbox docker/sandbox
# Override: EVA_SANDBOX_IMAGE=<otra-imagen>   (vacío = forzar fallback alpine)
#
# Sin red en runtime (--network none) — las dependencias van pre-horneadas aquí.
FROM python:3.12-slim

RUN pip install --no-cache-dir \
    requests \
    pandas \
    numpy \
    openpyxl \
    pillow \
    python-dateutil \
    beautifulsoup4

# Usuario sin privilegios: el contenedor corre read-only + sin red, pero
# tampoco hace falta root para nada.
RUN useradd --create-home sandbox
USER sandbox
WORKDIR /work

CMD ["tail", "-f", "/dev/null"]

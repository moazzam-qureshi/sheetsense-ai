# syntax=docker/dockerfile:1.7

# =============================================================================
# SheetSense AI — sandbox sidecar
# =============================================================================
# Two-stage build: dependencies in the builder image, only the .venv +
# source carried into the runtime image. Final image is ~600MB (pandas +
# numpy + matplotlib + scipy + composio is the weight floor on slim).
# =============================================================================

# === Builder ===
FROM python:3.13-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
# hatchling needs README.md at metadata-validation time (pyproject's
# readme = "README.md" field). Copy it alongside pyproject.toml.
COPY pyproject.toml README.md ./
COPY src ./src
RUN uv sync --no-dev


# === Runtime ===
FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 sandbox \
    && useradd  --uid 1000 --gid sandbox --shell /usr/sbin/nologin --create-home sandbox

WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/src /app/src

# Drop root. The sandbox's threat model is "untrusted LLM-written code
# inside a subprocess" — running the FastAPI parent as non-root is one
# more layer between user code and the container.
USER sandbox

EXPOSE 8001

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS http://localhost:8001/health || exit 1

# uvicorn workers=1 by design: each request spawns its own Python
# subprocess for the sandbox runner, so worker-level concurrency would
# multiply memory pressure without buying us anything.
CMD ["uvicorn", "sheetsense_sandbox.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8001", \
     "--workers", "1", \
     "--proxy-headers", \
     "--forwarded-allow-ips=*"]

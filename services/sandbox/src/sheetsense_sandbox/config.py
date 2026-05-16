"""Sandbox config loaded from env vars (pydantic-settings)."""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All sandbox-side config in one typed object.

    Loaded from process env vars; in compose these come from the project
    .env or the Coolify env panel.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- Composio (for fetching the visitor's sheet) ---
    composio_api_key: str = Field(default="", alias="COMPOSIO_API_KEY")

    # --- Redis (sheet cache) ---
    redis_url: str = Field(default="redis://localhost:6379", alias="REDIS_URL")

    # --- Sandbox tuning ---
    # Wall-clock timeout in seconds. Must exceed RLIMIT_CPU by enough
    # margin that an OS-level kill doesn't race with the Python-level
    # timeout. 12s default leaves room for pandas/numpy/matplotlib cold
    # imports (~3-4s on slim Debian) + actual analysis work.
    timeout_sec: float = Field(default=12.0, alias="SANDBOX_TIMEOUT_SEC")

    # CPU and memory ceilings inside the subprocess.
    #
    # RLIMIT_AS caps *virtual address space*, not RSS (resident set).
    # Empirically measured on python:3.13-slim (linux/amd64):
    #   - bare interpreter:                       VmSize  ~30MB
    #   - + pandas + numpy + matplotlib + scipy:  VmSize ~700MB
    #   - + small plot rendered:                  VmSize ~740MB
    # Linux pre-allocates mmap arenas for the Python heap; most of that
    # virtual is never touched. Actual RSS stays under ~200MB. We set
    # RLIMIT_AS=1024MB to leave headroom for analytics on ~500-row
    # sample sheets without RSS pressure.
    #
    # Production sandboxing (E2B / Modal / Firecracker microVMs) would
    # not need this floor — each request gets its own clean address
    # space. The 1024MB cap is a tradeoff specific to the in-process
    # subprocess approach we use for the portfolio demo.
    # RLIMIT_CPU counts CPU time, not wall-clock. 10s comfortably covers
    # cold pandas/matplotlib import (~3-4s on slim Debian linux/amd64)
    # plus actual analysis work on ~500-row sheets. SIGXCPU fires at
    # soft limit and SIGKILL at hard limit — both equal here.
    rlimit_cpu_sec: int = Field(default=10, alias="SANDBOX_RLIMIT_CPU")
    rlimit_as_mb: int = Field(default=1024, alias="SANDBOX_RLIMIT_AS_MB")

    # Cached sheet TTL (seconds). 15min default — covers a session where
    # the visitor asks follow-up questions without re-fetching the sheet.
    sheet_cache_ttl_sec: int = Field(default=900, alias="SHEET_CACHE_TTL_SEC")

    # Cap on the number of rows returned to the LLM in any single result.
    # The full DataFrame stays in the sandbox; only the trimmed result
    # leaves. This is the architectural keystone: result size is bounded
    # by the LLM context window, not by the user's sheet size.
    max_result_rows: int = Field(default=100, alias="MAX_RESULT_ROWS")

    # Max chart PNG size (KB). Charts beyond this size are rejected to
    # avoid sending megabytes back to the LLM.
    max_chart_kb: int = Field(default=512, alias="MAX_CHART_KB")

    # --- Logging ---
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")


settings = Settings()

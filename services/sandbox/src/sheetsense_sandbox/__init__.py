"""SheetSense AI — Python pandas sandbox sidecar.

Runs LLM-written pandas code in a subprocess with rlimits and a
restricted import hook. The full DataFrame never leaves the sandbox;
only the analysis result flows back to the LLM.
"""

__version__ = "0.1.0"

#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "baseline-ai" / "src"))

from baseline_ai.team_cli import cli  # noqa: E402

if __name__ == "__main__":
    cli()

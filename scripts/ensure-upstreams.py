#!/usr/bin/env python3
"""Repair files omitted from a source-only distribution using pinned upstream commits.

The delivered archive contains locally modified upstream trees.  It normally contains all
source files, but older packaging rules accidentally excluded Pokémon Showdown's `data/`
directory.  This command restores only missing directories from the exact commit recorded
in `config/runtime-lock.json`; it never merges a moving branch.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys


UPSTREAMS = {
    "pokemon-showdown": {
        "url": "https://github.com/smogon/pokemon-showdown.git",
        "lock_key": "pokemonShowdown",
        "target": "vendor/pokemon-showdown",
        "markers": ("data/tags.ts", "data/mods/champions/scripts.ts"),
        "copy": ("data",),
    },
}


def run(command: list[str], *, cwd: Path | None = None) -> None:
    completed = subprocess.run(command, cwd=cwd, check=False)
    if completed.returncode:
        raise RuntimeError(f"Command failed ({completed.returncode}): {' '.join(command)}")


def repair(root: Path, name: str, *, force: bool = False) -> bool:
    spec = UPSTREAMS[name]
    lock = json.loads((root / "config" / "runtime-lock.json").read_text(encoding="utf-8"))
    commit = str(lock["upstreams"][spec["lock_key"]])
    target = root / spec["target"]
    markers = [target / item for item in spec["markers"]]
    if not force and all(path.exists() for path in markers):
        print(f"{name}: complete")
        return False

    checkout = root / ".runtime" / "upstreams" / name
    checkout.parent.mkdir(parents=True, exist_ok=True)
    if not (checkout / ".git").exists():
        if checkout.exists():
            shutil.rmtree(checkout)
        run(["git", "clone", "--filter=blob:none", "--no-checkout", spec["url"], str(checkout)])
    run(["git", "-c", "core.hooksPath=/dev/null", "fetch", "--depth=1", "origin", commit], cwd=checkout)
    run(["git", "-c", "core.hooksPath=/dev/null", "checkout", "--detach", "--force", commit], cwd=checkout)

    target.mkdir(parents=True, exist_ok=True)
    for relative in spec["copy"]:
        if relative == ".":
            for source in checkout.iterdir():
                if source.name == ".git":
                    continue
                destination = target / source.name
                if source.is_dir():
                    shutil.copytree(source, destination, dirs_exist_ok=True)
                else:
                    shutil.copy2(source, destination)
            continue
        source = checkout / relative
        destination = target / relative
        if not source.exists():
            raise RuntimeError(f"Pinned upstream did not contain {relative}")
        if source.is_dir():
            shutil.copytree(source, destination, dirs_exist_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)

    missing = [str(path.relative_to(root)) for path in markers if not path.exists()]
    if missing:
        raise RuntimeError(f"Repair did not restore required files: {', '.join(missing)}")
    print(f"{name}: restored from {commit}")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", default=Path(__file__).resolve().parents[1])
    parser.add_argument("--only", choices=tuple(UPSTREAMS), action="append")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--verify", action="store_true", help="Only check markers; do not access the network")
    args = parser.parse_args()
    root = Path(args.project_root).resolve()
    selected = args.only or list(UPSTREAMS)
    if args.verify:
        missing: list[str] = []
        for name in selected:
            spec = UPSTREAMS[name]
            target = root / spec["target"]
            for marker in spec["markers"]:
                if not (target / marker).exists():
                    missing.append(f"{name}:{marker}")
        if missing:
            print("Missing pinned upstream files:\n- " + "\n- ".join(missing), file=sys.stderr)
            raise SystemExit(1)
        print("Pinned upstream markers are present")
        return
    for name in selected:
        repair(root, name, force=args.force)


if __name__ == "__main__":
    main()

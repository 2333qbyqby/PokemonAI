from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from .arena import run_arena
from .config import load_agents_config
from .registry import BackendRegistry
from .runtime import backend_executable, runtime_catalog, write_instance_configs
from .state import migrate_state


def project_root(value: str | None) -> Path:
    return Path(value or os.environ.get("POKEMONAI_PROJECT_ROOT") or ".").resolve()


def backend_list(root: Path) -> None:
    registry = BackendRegistry.discover(root)
    for spec in registry.specs:
        executable = backend_executable(root, spec.id, spec.entrypoint, spec.runtime)
        installed = executable.is_file() and (spec.runtime != "node" or (root / spec.entrypoint).is_file())
        print(f"{spec.id}\t{'installed' if installed else 'not-installed'}\t{','.join(spec.formats)}")


def backend_install(root: Path, backend_id: str) -> None:
    registry = BackendRegistry.discover(root)
    spec = registry.get(backend_id)
    if spec.runtime != "node":
        raise RuntimeError(f"Unsupported install runtime: {spec.runtime}")
    npm = root / ".runtime" / "node" / ("npm.cmd" if os.name == "nt" else "bin/npm")
    executable = str(npm if npm.is_file() else "npm")
    subprocess.run([executable, "ci"], cwd=root, check=True)
    subprocess.run([executable, "run", "build:agent"], cwd=root, check=True)
    if not (root / spec.entrypoint).is_file():
        raise RuntimeError(f"Backend build did not create: {spec.entrypoint}")
    print(f"Installed {backend_id}")


def backend_doctor(root: Path, backend_id: str | None) -> int:
    agents = load_agents_config(root / "config" / "agents.yaml")
    configs = write_instance_configs(
        root, agents, websocket_url=os.environ.get("POKEMONAI_SHOWDOWN_WS", "ws://127.0.0.1:8000/showdown/websocket")
    )
    failed = False
    for spec in agents.registry.specs:
        if backend_id and spec.id != backend_id:
            continue
        executable = backend_executable(root, spec.id, spec.entrypoint, spec.runtime)
        instances = [item for item in agents.opponents if item.backend_id == spec.id]
        if not executable.is_file():
            print(f"{spec.id}: not installed")
            failed = True
            continue
        for instance in instances:
            command = [str(executable)]
            if spec.runtime == "node":
                command.append(str(root / spec.entrypoint))
            command.extend(["doctor", "--config", str(configs[instance.id])])
            result = subprocess.run(command, cwd=root)
            failed = failed or result.returncode != 0
    return 1 if failed else 0


def backend_remove(root: Path, backend_id: str, *, confirmed: bool) -> None:
    if not confirmed:
        raise SystemExit("Refusing to remove a backend without --yes")
    spec = BackendRegistry.discover(root).get(backend_id)
    targets = [root / ".runtime" / "venvs" / backend_id]
    for target in targets:
        resolved = target.resolve()
        runtime = (root / ".runtime").resolve()
        if runtime not in resolved.parents:
            raise RuntimeError(f"Removal target escaped .runtime: {resolved}")
        if resolved.is_dir():
            shutil.rmtree(resolved)
        elif resolved.exists():
            resolved.unlink()
    agents = load_agents_config(root / "config" / "agents.yaml")
    for opponent in agents.opponents:
        if opponent.backend_id == backend_id:
            (root / "var" / "run" / "status" / f"{opponent.id}.json").unlink(missing_ok=True)
    print(f"Removed optional runtime for {backend_id}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="pokemonai")
    parser.add_argument("--project-root")
    commands = parser.add_subparsers(dest="command", required=True)
    backend = commands.add_parser("backend")
    backend_commands = backend.add_subparsers(dest="backend_command", required=True)
    backend_commands.add_parser("list")
    install = backend_commands.add_parser("install")
    install.add_argument("id")
    doctor = backend_commands.add_parser("doctor")
    doctor.add_argument("id", nargs="?")
    remove = backend_commands.add_parser("remove")
    remove.add_argument("id")
    remove.add_argument("--yes", action="store_true")
    state = commands.add_parser("state")
    state_commands = state.add_subparsers(dest="state_command", required=True)
    migrate = state_commands.add_parser("migrate")
    migrate.add_argument("--prune-legacy", action="store_true")
    arena = commands.add_parser("arena")
    arena_commands = arena.add_subparsers(dest="arena_command", required=True)
    run = arena_commands.add_parser("run")
    run.add_argument("--config", required=True)
    catalog = commands.add_parser("catalog")
    catalog.add_argument("--output")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    root = project_root(args.project_root)
    if args.command == "backend":
        if args.backend_command == "list":
            backend_list(root)
        elif args.backend_command == "install":
            backend_install(root, args.id)
        elif args.backend_command == "doctor":
            raise SystemExit(backend_doctor(root, args.id))
        else:
            backend_remove(root, args.id, confirmed=args.yes)
        return
    if args.command == "state":
        print(json.dumps(migrate_state(root, prune_legacy=args.prune_legacy), ensure_ascii=False, indent=2))
        return
    if args.command == "arena":
        print(run_arena(root, args.config))
        return
    agents = load_agents_config(root / "config" / "agents.yaml")
    value = runtime_catalog(root, agents)
    rendered = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        Path(args.output).write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()

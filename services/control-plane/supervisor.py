from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from typing import Any

from pokemonai_core.config import load_agents_config
from pokemonai_core.runtime import backend_executable, process_alive, write_status


def main() -> None:
    if len(sys.argv) < 4:
        raise SystemExit("Usage: supervisor.py CONFIG PID_ROOT LOG_ROOT [PROJECT_ROOT] [SKIP_BACKEND]")
    config_path, pid_root_value, log_root_value = sys.argv[1:4]
    services = json.loads(Path(config_path).read_text(encoding="utf-8-sig"))
    pid_root = Path(pid_root_value)
    log_root = Path(log_root_value)
    pid_root.mkdir(parents=True, exist_ok=True)
    log_root.mkdir(parents=True, exist_ok=True)
    project_root = Path(sys.argv[4]).resolve() if len(sys.argv) >= 5 else None
    if project_root is not None:
        root = project_root
        skipped = sys.argv[5] if len(sys.argv) >= 6 else ""
        agents = load_agents_config(root / "config" / "agents.yaml")
        for opponent in agents.opponents:
            spec = agents.registry.for_target(opponent.backend)
            executable = backend_executable(root, spec.id, spec.entrypoint, spec.runtime)
            if spec.id == skipped or not executable.is_file():
                continue
            arguments = ["serve", "--config", str(root / "var" / "run" / "instances" / f"{opponent.id}.json")]
            if spec.runtime == "node":
                arguments.insert(0, str(root / spec.entrypoint))
            services.append({
                "name": opponent.id,
                "filePath": str(executable),
                "arguments": arguments,
                "workingDirectory": str(root),
            })
    stopping = False
    processes: dict[str, subprocess.Popen[Any]] = {}
    failures: dict[str, int] = {}
    retry_at: dict[str, float] = {}
    marked_failed: set[str] = set()

    def pid_is_alive(name: str) -> bool:
        process = processes.get(name)
        if process is not None:
            return process.poll() is None
        try:
            pid = int((pid_root / f"{name}.pid").read_text(encoding="ascii"))
            return process_alive(pid)
        except (OSError, ValueError):
            return False

    def stop(*_: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    while not stopping:
        now = time.monotonic()
        for service in services:
            name = service["name"]
            if pid_is_alive(name):
                continue
            if now < retry_at.get(name, 0):
                continue
            count = failures.get(name, 0)
            if count >= 6:
                if project_root is not None and name not in {"showdown", "control-plane"} and name not in marked_failed:
                    write_status(
                        project_root / "var" / "run" / "status" / f"{name}.json",
                        "failed", "连续启动失败，已停止自动重启；请查看进程日志",
                    )
                    marked_failed.add(name)
                continue
            stdout = (log_root / f"{name}.stdout.log").open("ab")
            stderr = (log_root / f"{name}.stderr.log").open("ab")
            process = subprocess.Popen(
                [service["filePath"], *service["arguments"]], cwd=service["workingDirectory"],
                stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                creationflags=(subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0),
            )
            stdout.close()
            stderr.close()
            processes[name] = process
            (pid_root / f"{name}.pid").write_text(str(process.pid), encoding="ascii")
            failures[name] = count + 1
            retry_at[name] = now + min(30, 2 ** count)
        time.sleep(0.5)
    for process in processes.values():
        if process.poll() is None:
            process.terminate()
    for process in processes.values():
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == "__main__":
    main()

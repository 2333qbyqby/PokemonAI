from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import time
from pathlib import Path
from typing import Any

from poke_env import (
    AccountConfiguration,
    MaxBasePowerPlayer,
    RandomPlayer,
    ServerConfiguration,
    SimpleHeuristicsPlayer,
)

from .config import AgentsConfig, OpponentConfig, load_agents_config


LOGGER = logging.getLogger("pokemonai.baseline")


class DecisionLoggingMixin:
    agent_id: str
    decision_log_path: Path

    def choose_move(self, battle: Any):
        started = time.perf_counter()
        order = super().choose_move(battle)
        elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
        entry = {
            "timestamp": time.time(),
            "battle_id": getattr(battle, "battle_tag", "unknown"),
            "turn": getattr(battle, "turn", None),
            "agent_id": self.agent_id,
            "backend": type(self).__mro__[2].__name__,
            "available_moves": [getattr(move, "id", str(move)) for move in battle.available_moves],
            "available_switches": [getattr(mon, "species", str(mon)) for mon in battle.available_switches],
            "selected_action": str(order),
            "decision_ms": elapsed_ms,
        }
        with self.decision_log_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return order


class LoggedRandomPlayer(DecisionLoggingMixin, RandomPlayer):
    pass


class LoggedMaxBasePowerPlayer(DecisionLoggingMixin, MaxBasePowerPlayer):
    pass


class LoggedSimpleHeuristicsPlayer(DecisionLoggingMixin, SimpleHeuristicsPlayer):
    pass


PLAYER_TYPES = {
    "poke_env.random": LoggedRandomPlayer,
    "poke_env.max_base_power": LoggedMaxBasePowerPlayer,
    "poke_env.simple_heuristics": LoggedSimpleHeuristicsPlayer,
}


def create_player(
    opponent: OpponentConfig,
    config: AgentsConfig,
    websocket_url: str,
    authentication_url: str,
    data_dir: Path,
):
    player_type = PLAYER_TYPES[opponent.backend]
    decision_dir = data_dir / "decisions"
    replay_dir = data_dir / "replays"
    decision_dir.mkdir(parents=True, exist_ok=True)
    replay_dir.mkdir(parents=True, exist_ok=True)
    player = player_type(
        account_configuration=AccountConfiguration(opponent.username, None),
        server_configuration=ServerConfiguration(websocket_url, authentication_url),
        battle_format=config.format,
        max_concurrent_battles=1,
        save_replays=str(replay_dir),
    )
    player.agent_id = opponent.id
    player.decision_log_path = decision_dir / f"{opponent.id}.jsonl"
    return player


async def serve_player(player: Any, stop: asyncio.Event) -> None:
    LOGGER.info("%s is ready and waiting for challenges", player.username)
    while not stop.is_set():
        try:
            await player.accept_challenges(None, 1)
            LOGGER.info("%s completed a battle", player.username)
        except asyncio.CancelledError:
            raise
        except Exception:
            LOGGER.exception("%s challenge loop failed; retrying", player.username)
            try:
                await asyncio.wait_for(stop.wait(), timeout=3)
            except asyncio.TimeoutError:
                pass


async def run(args: argparse.Namespace) -> None:
    config = load_agents_config(args.config)
    data_dir = Path(args.data_dir).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))

    players = [
        create_player(
            opponent,
            config,
            args.websocket_url,
            args.authentication_url,
            data_dir,
        )
        for opponent in config.baseline_opponents
    ]
    tasks = [asyncio.create_task(serve_player(player, stop)) for player in players]
    await stop.wait()
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run PokemonAI poke-env opponents")
    parser.add_argument("--config", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument(
        "--websocket-url",
        default=os.environ.get("POKEMONAI_SHOWDOWN_WS", "ws://127.0.0.1:8000/showdown/websocket"),
    )
    parser.add_argument(
        "--authentication-url",
        default=os.environ.get("POKEMONAI_AUTH_URL", "https://play.pokemonshowdown.com/action.php?"),
    )
    return parser


def cli() -> None:
    logging.basicConfig(
        level=os.environ.get("POKEMONAI_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    asyncio.run(run(build_parser().parse_args()))


if __name__ == "__main__":
    cli()

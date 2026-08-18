from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import time
from pathlib import Path
from typing import Any, Iterable

from poke_env import (
    AccountConfiguration,
    MaxBasePowerPlayer,
    RandomPlayer,
    ServerConfiguration,
    SimpleHeuristicsPlayer,
)
from poke_env.teambuilder.teambuilder import Teambuilder

from .champions_compat import assert_champions_poke_env_support
from .config import AgentsConfig, OpponentConfig, load_agents_config
from .team_library import TeamPool
from .vgc_player import VGCHeuristicPlayer


LOGGER = logging.getLogger("pokemonai.baseline")


def _flatten(value: Any) -> Iterable[Any]:
    if isinstance(value, (list, tuple)):
        for item in value:
            yield from _flatten(item)
    elif value is not None:
        yield value


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
            "available_moves": [
                getattr(move, "id", str(move))
                for move in _flatten(getattr(battle, "available_moves", []))
            ],
            "available_switches": [
                getattr(mon, "species", str(mon))
                for mon in _flatten(getattr(battle, "available_switches", []))
            ],
            "selected_action": str(order),
            "decision_ms": elapsed_ms,
        }
        trace = getattr(self, "last_decision_trace", None)
        if trace:
            entry["top_candidates"] = trace[:5]
        with self.decision_log_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return order


class LoggedRandomPlayer(DecisionLoggingMixin, RandomPlayer):
    pass


class LoggedMaxBasePowerPlayer(DecisionLoggingMixin, MaxBasePowerPlayer):
    pass


class LoggedSimpleHeuristicsPlayer(DecisionLoggingMixin, SimpleHeuristicsPlayer):
    pass


class LoggedVGCPlayer(DecisionLoggingMixin, VGCHeuristicPlayer):
    pass


class TeamPoolTeambuilder(Teambuilder):
    """Cycles the validated pool every time poke-env accepts a new challenge."""

    def __init__(self, pool: TeamPool) -> None:
        self.pool = pool

    def yield_team(self) -> str:
        return self.pool.next()


PLAYER_TYPES = {
    "poke_env.random": LoggedRandomPlayer,
    "poke_env.max_base_power": LoggedMaxBasePowerPlayer,
    "poke_env.simple_heuristics": LoggedSimpleHeuristicsPlayer,
    "pokemonai.vgc": LoggedVGCPlayer,
}


def create_player(
    opponent: OpponentConfig,
    config: AgentsConfig,
    websocket_url: str,
    authentication_url: str,
    data_dir: Path,
    project_root: Path,
    pools: dict[str, TeamPool],
):
    player_type = PLAYER_TYPES[opponent.backend]
    format_config = config.format_for_opponent(opponent)
    decision_dir = data_dir / "decisions"
    replay_dir = data_dir / "replays"
    decision_dir.mkdir(parents=True, exist_ok=True)
    replay_dir.mkdir(parents=True, exist_ok=True)

    team: Teambuilder | None = None
    if format_config.team_pool:
        # Each difficulty gets its own deterministic shuffle. Sharing one global pool
        # made the team selected by one bot depend on which other bot accepted a
        # challenge first, which is surprising in a personal single-user deployment.
        pool_key = f"{format_config.team_pool}:{opponent.id}"
        pool = pools.get(pool_key)
        if pool is None:
            index_path = Path(config.team_library_path)
            if not index_path.is_absolute():
                index_path = project_root / index_path
            pool = pools[pool_key] = TeamPool(
                index_path,
                format_config.team_pool,
                seed=opponent.options.get("team_seed", opponent.id),
            )
        team = TeamPoolTeambuilder(pool)

    kwargs: dict[str, Any] = {
        "account_configuration": AccountConfiguration(opponent.username, None),
        "server_configuration": ServerConfiguration(websocket_url, authentication_url),
        "battle_format": format_config.showdown_format,
        "max_concurrent_battles": 1,
        "save_replays": str(replay_dir),
        "accept_open_team_sheet": format_config.open_team_sheets,
        "team": team,
    }
    if opponent.backend == "pokemonai.vgc":
        kwargs.update(
            difficulty=opponent.difficulty,
            style=opponent.style,
            seed=opponent.options.get("seed"),
        )
    player = player_type(**kwargs)
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
    config_path = Path(args.config).resolve()
    config = load_agents_config(config_path)
    project_root = Path(args.project_root).resolve() if args.project_root else config_path.parent.parent
    data_dir = Path(args.data_dir).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))

    if any(opponent.backend == "pokemonai.vgc" for opponent in config.baseline_opponents):
        assert_champions_poke_env_support()

    pools: dict[str, TeamPool] = {}
    players = [
        create_player(
            opponent,
            config,
            args.websocket_url,
            args.authentication_url,
            data_dir,
            project_root,
            pools,
        )
        for opponent in config.baseline_opponents
    ]
    tasks = [asyncio.create_task(serve_player(player, stop)) for player in players]
    await stop.wait()
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run PokémonAI poke-env opponents")
    parser.add_argument("--config", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--project-root", default=os.environ.get("POKEMONAI_PROJECT_ROOT"))
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

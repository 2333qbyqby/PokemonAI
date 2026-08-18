from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

from poke_env import AccountConfiguration, RandomPlayer, ServerConfiguration

from baseline_ai.config import load_agents_config
from baseline_ai.team_library import TeamPool


async def run(args: argparse.Namespace) -> None:
    config_path = Path(args.config).resolve()
    project_root = config_path.parent.parent
    config = load_agents_config(config_path)
    selected = set(args.agent or [])
    results = []
    pools: dict[str, TeamPool] = {}

    for sequence, opponent in enumerate(config.opponents):
        if selected and opponent.id not in selected:
            continue
        format_config = config.format_for_opponent(opponent)
        team = None
        if format_config.team_pool:
            pool = pools.get(format_config.team_pool)
            if pool is None:
                index = Path(config.team_library_path)
                if not index.is_absolute():
                    index = project_root / index
                pool = pools[format_config.team_pool] = TeamPool(index, format_config.team_pool)
            team = pool.next()
        challenger = RandomPlayer(
            account_configuration=AccountConfiguration(
                f"PAITest{int(time.time()) % 10000}{sequence}", None
            ),
            server_configuration=ServerConfiguration(
                args.websocket_url, "https://play.pokemonshowdown.com/action.php?"
            ),
            battle_format=format_config.showdown_format,
            max_concurrent_battles=1,
            accept_open_team_sheet=format_config.open_team_sheets,
            team=team,
        )
        started = time.perf_counter()
        await asyncio.wait_for(
            challenger.send_challenges(opponent.username, 1),
            timeout=args.expert_timeout if opponent.backend == "foul_play" else args.baseline_timeout,
        )
        battles = list(challenger.battles.items())
        if len(battles) != 1:
            raise AssertionError(f"Expected one battle for {opponent.id}, got {len(battles)}")
        tag, battle = battles[0]
        if not battle.finished:
            raise AssertionError(f"Battle {tag} did not finish")
        item = {
            "agent_id": opponent.id,
            "backend": opponent.backend,
            "format_id": opponent.format_id,
            "showdown_format": format_config.showdown_format,
            "battle_id": tag,
            "elapsed_seconds": round(time.perf_counter() - started, 3),
            "won": battle.won,
            "lost": battle.lost,
        }
        results.append(item)
        print(json.dumps(item, ensure_ascii=False), flush=True)

    if not results:
        raise AssertionError("No opponents were selected for integration testing")
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--websocket-url", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--agent", action="append", help="Run only a named agent id")
    parser.add_argument("--baseline-timeout", type=float, default=240)
    parser.add_argument("--expert-timeout", type=float, default=600)
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()

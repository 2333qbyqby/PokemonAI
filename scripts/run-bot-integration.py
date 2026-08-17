from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

from poke_env import AccountConfiguration, RandomPlayer, ServerConfiguration

from baseline_ai.config import load_agents_config


async def run(args: argparse.Namespace) -> None:
    config = load_agents_config(args.config)
    challenger = RandomPlayer(
        account_configuration=AccountConfiguration(
            f"PAITest{int(time.time()) % 100000}", None
        ),
        server_configuration=ServerConfiguration(
            args.websocket_url, "https://play.pokemonshowdown.com/action.php?"
        ),
        battle_format=config.format,
        max_concurrent_battles=1,
    )
    results = []
    seen_battles: set[str] = set()
    for opponent in config.opponents:
        started = time.perf_counter()
        await asyncio.wait_for(
            challenger.send_challenges(opponent.username, 1),
            timeout=args.expert_timeout if opponent.backend == "foul_play" else args.baseline_timeout,
        )
        new_battles = [
            (tag, battle)
            for tag, battle in challenger.battles.items()
            if tag not in seen_battles
        ]
        if len(new_battles) != 1:
            raise AssertionError(
                f"Expected one new battle for {opponent.id}, got {len(new_battles)}"
            )
        tag, battle = new_battles[0]
        seen_battles.add(tag)
        if not battle.finished:
            raise AssertionError(f"Battle {tag} did not finish")
        results.append(
            {
                "agent_id": opponent.id,
                "backend": opponent.backend,
                "battle_id": tag,
                "elapsed_seconds": round(time.perf_counter() - started, 3),
                "won": battle.won,
                "lost": battle.lost,
            }
        )
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--websocket-url", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--baseline-timeout", type=float, default=180)
    parser.add_argument("--expert-timeout", type=float, default=600)
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()

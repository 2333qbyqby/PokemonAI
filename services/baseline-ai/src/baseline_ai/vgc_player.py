"""poke-env runtime adapter for the pure VGC policy."""

from __future__ import annotations

import random
from typing import Any

from poke_env.battle.double_battle import DoubleBattle
from poke_env.player.baselines import RandomPlayer
from poke_env.player.battle_order import DoubleBattleOrder

from .ots_compat import inspect_ots_batch
from .vgc_policy import VGCPolicy


class VGCHeuristicPlayer(RandomPlayer):
    """A legal joint-action VGC player with continuously configurable strength."""

    def __init__(self, *args: Any, difficulty: int = 5, style: str = "balanced", seed: int | None = None, **kwargs: Any) -> None:
        # poke-env 0.15 can miss an OTS rejection when it arrives before the team-
        # preview request. Keep only room identifiers here; all battle state continues
        # to be owned and parsed by poke-env itself.
        self._ots_rejected_before_preview: set[str] = set()
        self._ots_preview_resolved: set[str] = set()
        super().__init__(*args, **kwargs)
        self.policy = VGCPolicy(difficulty=difficulty, style=style, rng=random.Random(seed))
        self.last_decision_trace: list[dict[str, Any]] = []

    async def _handle_battle_message(self, split_messages: Any) -> None:
        """Resume team preview when poke-env 0.15 loses the OTS rejection/request race."""

        batch = inspect_ots_batch(split_messages)
        was_pending = batch.room_id in self._ots_rejected_before_preview
        if batch.saw_rejection and batch.room_id not in self._ots_preview_resolved:
            self._ots_rejected_before_preview.add(batch.room_id)

        await super()._handle_battle_message(split_messages)

        if not self.accept_open_team_sheet or batch.room_id in self._ots_preview_resolved:
            return
        battle = self._battles.get(batch.room_id)

        recover = (
            batch.saw_error_rejection
            or (was_pending and batch.saw_request)
            or batch.rejection_preceded_request
        )
        if recover and battle is not None and battle.teampreview:
            self._ots_rejected_before_preview.discard(batch.room_id)
            self._ots_preview_resolved.add(batch.room_id)
            await self._handle_battle_request(battle)
        elif (
            batch.plain_rejection_positions
            and battle is not None
            and battle.teampreview
        ):
            # In every remaining plain-text ordering, poke-env's own branch has just
            # called _handle_battle_request. Only record completion here.
            self._ots_rejected_before_preview.discard(batch.room_id)
            self._ots_preview_resolved.add(batch.room_id)

    def _battle_finished_callback(self, battle: Any) -> None:
        tag = getattr(battle, "battle_tag", "")
        self._ots_rejected_before_preview.discard(tag)
        self._ots_preview_resolved.discard(tag)
        parent = getattr(super(), "_battle_finished_callback", None)
        if parent:
            parent(battle)

    def choose_move(self, battle: Any):
        if not isinstance(battle, DoubleBattle):
            return super().choose_move(battle)
        orders = DoubleBattleOrder.join_orders(*battle.valid_orders)
        if not orders:
            return self.choose_random_doubles_move(battle)
        selected = self.policy.choose_joint_order(battle, orders)
        self.last_decision_trace = self.policy.last_trace
        return selected

    def teampreview(self, battle: Any) -> str:
        order = self.policy.choose_team_preview(battle)
        team = list(battle.team.values())
        for mon in team:
            mon._selected_in_teampreview = False
        for index in order[:4]:
            team[index - 1]._selected_in_teampreview = True
        return "/team " + "".join(str(index) for index in order)

"""CPU-friendly VGC policy used by PokémonAI.

The module deliberately depends only on Python's standard library and duck-typed battle
objects.  That keeps its strategic scoring unit-testable without a running Showdown
server while the runtime adapter in :mod:`baseline_ai.vgc_player` owns poke-env details.

It is a bounded-rational policy rather than a random bot: every difficulty rejects
catastrophic orders, then samples from a progressively narrower set of reasonable joint
orders.  Two active Pokémon are always scored as one joint action so Fake Out + setup,
redirection + setup, Helping Hand + attack, double targets, and duplicate switches can be
reasoned about together.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations, permutations
import math
import random
import re
from typing import Any, Iterable, Sequence


_ID_RE = re.compile(r"[^a-z0-9]+")


def to_id(value: Any) -> str:
    if value is None:
        return ""
    raw = getattr(value, "id", None) or getattr(value, "name", None) or str(value)
    return _ID_RE.sub("", str(raw).lower())


def _number(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError):
        return default


def _fraction(mon: Any) -> float:
    value = getattr(mon, "current_hp_fraction", None)
    if value is not None:
        return max(0.0, min(1.0, _number(value, 1.0)))
    hp = _number(getattr(mon, "current_hp", None), 0.0)
    max_hp = _number(getattr(mon, "max_hp", None), 0.0)
    return max(0.0, min(1.0, hp / max_hp)) if max_hp > 0 else 1.0


def _stat(mon: Any, name: str) -> float:
    stats = getattr(mon, "stats", None) or {}
    bases = getattr(mon, "base_stats", None) or {}
    return _number(stats.get(name), _number(bases.get(name), 80.0))


def _move_id(move: Any) -> str:
    return to_id(getattr(move, "id", move))


def _move_target(move: Any) -> str:
    target = getattr(move, "target", "")
    # poke-env Target is an Enum whose ``value`` is an integer. Prefer its semantic
    # name; otherwise spread and ally-target detection silently sees values like "5".
    return to_id(getattr(target, "name", None) or getattr(target, "value", None) or target)


def _category(move: Any) -> str:
    category = getattr(move, "category", "")
    return to_id(getattr(category, "name", None) or category)


def _type_id(value: Any) -> str:
    return to_id(getattr(value, "name", None) or value)


def _ability_id(mon: Any) -> str:
    return to_id(getattr(mon, "ability", ""))


def _item_id(mon: Any) -> str:
    return to_id(getattr(mon, "item", ""))


def _species_id(mon: Any) -> str:
    return to_id(getattr(mon, "species", None) or getattr(mon, "name", None) or mon)


def _fainted(mon: Any) -> bool:
    return mon is None or bool(getattr(mon, "fainted", False)) or _fraction(mon) <= 0


def _first_active_turn(mon: Any) -> bool:
    """Return whether switch-in-only moves such as Fake Out can still work.

    poke-env resets ``_active_turns`` on switch-out and increments it at turn
    boundaries.  Treat both 0 and 1 as the first actionable turn so this remains
    robust across request timing and the lightweight test doubles used here.
    """

    return int(_number(getattr(mon, "_active_turns", 0), 0)) <= 1


def _is_move_order(order: Any) -> bool:
    inner = getattr(order, "order", None)
    return inner is not None and (
        hasattr(inner, "base_power")
        or hasattr(inner, "target")
        or inner.__class__.__name__.lower() == "move"
    )


def _is_switch_order(order: Any) -> bool:
    inner = getattr(order, "order", None)
    return inner is not None and not _is_move_order(order) and (
        hasattr(inner, "species") or hasattr(inner, "base_stats")
    )


def _single_orders(joint_order: Any) -> tuple[Any, Any]:
    first = getattr(joint_order, "first_order", None)
    second = getattr(joint_order, "second_order", None)
    if first is not None or second is not None:
        return first, second
    if isinstance(joint_order, (tuple, list)) and len(joint_order) == 2:
        return joint_order[0], joint_order[1]
    raise TypeError(f"Unsupported joint order: {type(joint_order)!r}")


PROTECT_MOVES = frozenset(
    {
        "protect",
        "detect",
        "spikyshield",
        "banefulbunker",
        "kingsshield",
        "silktrap",
        "obstruct",
        "burningbulwark",
    }
)
WIDE_DEFENSE_MOVES = frozenset({"wideguard", "quickguard", "craftyshield", "matblock"})
REDIRECTION_MOVES = frozenset({"followme", "ragepowder", "spotlight"})
SPEED_CONTROL_MOVES = frozenset(
    {"tailwind", "trickroom", "icywind", "electroweb", "bulldoze", "scaryface", "thunderwave"}
)
SETUP_MOVES = frozenset(
    {
        "swordsdance",
        "nastyplot",
        "calmmind",
        "dragondance",
        "quiverdance",
        "bulkup",
        "shellsmash",
        "bellydrum",
        "geomancy",
        "coil",
    }
)
DENIAL_MOVES = frozenset(
    {"fakeout", "taunt", "encore", "spore", "sleeppowder", "hypnosis", "disable", "imprison"}
)
POSITIONING_MOVES = frozenset(
    {"uturn", "voltswitch", "flipturn", "partingshot", "batonpass", "chillyreception"}
)
FIELD_MOVES = frozenset(
    {
        "sunnyday",
        "raindance",
        "snowscape",
        "sandstorm",
        "electricterrain",
        "grassyterrain",
        "mistyterrain",
        "psychicterrain",
        "reflect",
        "lightscreen",
        "auroraveil",
    }
)
RECOVERY_MOVES = frozenset(
    {"recover", "roost", "slackoff", "softboiled", "milkdrink", "synthesis", "moonlight", "morningsun"}
)
HELPING_MOVES = frozenset({"helpinghand"})
SPREAD_TARGETS = frozenset(
    {"alladjacent", "alladjacentfoes", "allfoes", "foeside", "allyside", "all"}
)
SELF_TARGETS = frozenset({"self", "allyside", "userside", "adjacentally", "adjacentallyorself", "allies", "allyteam"})
ALLY_HEALING_MOVES = frozenset({"pollenpuff", "healpulse", "floralhealing", "lifedew", "junglehealing"})
ALLY_TRIGGER_MOVES = frozenset({"beatup"})


@dataclass(frozen=True)
class DifficultyProfile:
    level: int
    temperature: float
    top_k: int
    rational_floor: float
    score_noise: float
    tera_threshold: float
    preview_temperature: float
    opponent_awareness: float


@dataclass(frozen=True)
class ScoredOrder:
    order: Any
    score: float
    components: tuple[tuple[str, float], ...]


def profile_for_difficulty(level: int) -> DifficultyProfile:
    level = max(1, min(10, int(level)))
    progress = (level - 1) / 9.0
    return DifficultyProfile(
        level=level,
        temperature=9.0 - 7.8 * progress,
        top_k=max(2, round(8 - 5 * progress)),
        rational_floor=45.0 - 34.0 * progress,
        score_noise=8.0 - 7.2 * progress,
        tera_threshold=20.0 - 10.0 * progress,
        preview_temperature=7.0 - 5.5 * progress,
        opponent_awareness=0.15 + 0.75 * progress,
    )


class VGCPolicy:
    """Rank and choose legal VGC joint orders using bounded-rational heuristics."""

    def __init__(
        self,
        difficulty: int = 5,
        style: str = "balanced",
        *,
        rng: random.Random | None = None,
    ) -> None:
        self.profile = profile_for_difficulty(difficulty)
        self.style = to_id(style) or "balanced"
        self.rng = rng or random.Random()
        self.last_trace: list[dict[str, Any]] = []

    def choose_joint_order(self, battle: Any, orders: Sequence[Any]) -> Any:
        ranked = self.rank_joint_orders(battle, orders)
        if not ranked:
            raise ValueError("No legal VGC joint order was supplied")
        best = ranked[0].score
        floor = best - self.profile.rational_floor
        reasonable = [candidate for candidate in ranked if candidate.score >= floor]
        reasonable = reasonable[: self.profile.top_k]
        scores = [candidate.score for candidate in reasonable]
        selected = self._sample(reasonable, scores, self.profile.temperature)
        self.last_trace = [
            {
                "rank": index + 1,
                "score": round(candidate.score, 3),
                "order": str(candidate.order),
                "components": {name: round(value, 3) for name, value in candidate.components},
                "selected": candidate is selected,
            }
            for index, candidate in enumerate(ranked[: min(8, len(ranked))])
        ]
        return selected.order

    def rank_joint_orders(self, battle: Any, orders: Sequence[Any]) -> list[ScoredOrder]:
        result: list[ScoredOrder] = []
        for order in orders:
            score, components = self._score_joint_order(battle, order)
            if self.profile.score_noise:
                noise = self.rng.uniform(-self.profile.score_noise, self.profile.score_noise)
                score += noise
                components.append(("bounded-rational noise", noise))
            result.append(ScoredOrder(order, score, tuple(components)))
        result.sort(key=lambda item: item.score, reverse=True)
        return result

    def choose_team_preview(self, battle: Any) -> list[int]:
        """Return a one-based VGC /team permutation: two leads then two in back."""
        mons = list(getattr(battle, "team", {}).values())
        if len(mons) <= 4:
            return list(range(1, len(mons) + 1))
        opponent = list(getattr(battle, "opponent_team", {}).values())
        candidates: list[tuple[float, tuple[int, int, int, int]]] = []
        for selected in combinations(range(len(mons)), 4):
            for leads in permutations(selected, 2):
                backs = tuple(index for index in selected if index not in leads)
                order = (leads[0], leads[1], backs[0], backs[1])
                score = self._score_preview(mons, opponent, order)
                candidates.append((score, order))
        candidates.sort(key=lambda pair: pair[0], reverse=True)
        best = candidates[0][0]
        floor = best - self.profile.rational_floor * 0.45
        pool = [item for item in candidates if item[0] >= floor][
            : max(4, self.profile.top_k * 3)
        ]
        selected = self._sample(pool, [item[0] for item in pool], self.profile.preview_temperature)
        return [index + 1 for index in selected[1]]

    def _sample(self, items: Sequence[Any], scores: Sequence[float], temperature: float) -> Any:
        if len(items) == 1 or temperature <= 0.05:
            return items[0]
        peak = max(scores)
        weights = [math.exp(max(-50.0, (score - peak) / temperature)) for score in scores]
        return self.rng.choices(list(items), weights=weights, k=1)[0]

    def _score_preview(
        self,
        own: Sequence[Any],
        opponent: Sequence[Any],
        order: tuple[int, int, int, int],
    ) -> float:
        chosen = [own[index] for index in order]
        leads = chosen[:2]
        score = sum(self._mon_preview_value(mon, opponent) for mon in chosen)
        score += sum(self._lead_value(mon) for mon in leads)

        lead_moves = [self._known_move_ids(mon) for mon in leads]
        flat_moves = set().union(*lead_moves)
        if "fakeout" in flat_moves and flat_moves & (SETUP_MOVES | {"trickroom", "tailwind"}):
            score += 13.0
        if flat_moves & REDIRECTION_MOVES and flat_moves & (SETUP_MOVES | {"trickroom", "tailwind"}):
            score += 12.0
        if "helpinghand" in flat_moves and any(self._offensive_potential(mon) > 110 for mon in leads):
            score += 7.0
        if "trickroom" in flat_moves:
            average_speed = sum(_stat(mon, "spe") for mon in chosen) / len(chosen)
            score += max(-8.0, min(12.0, (85.0 - average_speed) * 0.25))
        if "tailwind" in flat_moves:
            score += 5.0
        abilities = {_ability_id(mon) for mon in leads}
        if abilities & {"drought", "drizzle", "sandstream", "snowwarning", "hadronengine", "orichalcumpulse"}:
            score += 6.0
        if len({_item_id(mon) for mon in chosen if _item_id(mon)}) != len(
            [mon for mon in chosen if _item_id(mon)]
        ):
            score -= 60.0
        # Reward broad type coverage and avoid duplicating four fragile roles.
        types = [
            _type_id(type_) for mon in chosen for type_ in (getattr(mon, "types", None) or []) if type_
        ]
        score += len(set(types)) * 0.8
        score -= max(0, len(types) - len(set(types))) * 0.25
        return score

    def _mon_preview_value(self, mon: Any, opponent: Sequence[Any]) -> float:
        hp = _stat(mon, "hp")
        bulk = hp * 0.25 + (_stat(mon, "def") + _stat(mon, "spd")) * 0.12
        offense = self._offensive_potential(mon) * 0.14
        speed = _stat(mon, "spe") * 0.05
        utility = len(self._known_move_ids(mon) & (
            PROTECT_MOVES
            | WIDE_DEFENSE_MOVES
            | REDIRECTION_MOVES
            | SPEED_CONTROL_MOVES
            | DENIAL_MOVES
            | POSITIONING_MOVES
        )) * 3.2
        matchup = 0.0
        for target in opponent:
            if _fainted(target):
                continue
            matchup += self._type_matchup(mon, target) * 0.7
        return bulk + offense + speed + utility + matchup

    def _lead_value(self, mon: Any) -> float:
        moves = self._known_move_ids(mon)
        score = 0.0
        score += 8.0 if "fakeout" in moves else 0.0
        score += 6.0 if moves & SPEED_CONTROL_MOVES else 0.0
        score += 6.0 if moves & REDIRECTION_MOVES else 0.0
        score += 4.0 if moves & WIDE_DEFENSE_MOVES else 0.0
        score += 5.0 if _ability_id(mon) in {"intimidate", "drought", "drizzle", "snowwarning", "sandstream"} else 0.0
        return score

    def _known_move_ids(self, mon: Any) -> set[str]:
        moves = getattr(mon, "moves", None) or {}
        values: Iterable[Any] = moves.values() if hasattr(moves, "values") else moves
        return {_move_id(move) for move in values}

    def _offensive_potential(self, mon: Any) -> float:
        return max(_stat(mon, "atk"), _stat(mon, "spa")) + _stat(mon, "spe") * 0.2

    def _score_joint_order(self, battle: Any, joint_order: Any) -> tuple[float, list[tuple[str, float]]]:
        first, second = _single_orders(joint_order)
        active = list(getattr(battle, "active_pokemon", ()) or ())
        opponents = list(getattr(battle, "opponent_active_pokemon", ()) or ())
        while len(active) < 2:
            active.append(None)
        while len(opponents) < 2:
            opponents.append(None)

        components: list[tuple[str, float]] = []
        total = 0.0
        single_scores: list[float] = []
        for slot, order in enumerate((first, second)):
            value = self._score_single_order(battle, slot, active[slot], active, opponents, order)
            single_scores.append(value)
            components.append((f"slot-{slot + 1}", value))
            total += value

        synergy = self._cross_slot_score(battle, active, opponents, first, second, single_scores)
        components.extend(synergy)
        total += sum(value for _, value in synergy)

        if self.style == "aggressive":
            attacks = sum(1 for order in (first, second) if _is_move_order(order) and _number(getattr(order.order, "base_power", 0)) > 0)
            style_value = attacks * 2.8
            total += style_value
            components.append(("aggressive style", style_value))
        elif self.style in {"relaxed", "casual"}:
            safe = sum(1 for order in (first, second) if _move_id(getattr(order, "order", None)) in PROTECT_MOVES or _is_switch_order(order))
            style_value = safe * 1.0
            total += style_value
            components.append(("relaxed style", style_value))
        elif self.style in {"expert", "balanced"}:
            balanced = -abs(single_scores[0] - single_scores[1]) * 0.03
            total += balanced
            components.append(("balanced allocation", balanced))

        return total, components

    def _score_single_order(
        self,
        battle: Any,
        slot: int,
        actor: Any,
        allies: Sequence[Any],
        opponents: Sequence[Any],
        order: Any,
    ) -> float:
        if order is None:
            return -75.0
        order_string = str(order).lower()
        if "pass" in order_string:
            return 0.0 if actor is None or _fainted(actor) else -80.0
        if "default" in order_string:
            return -20.0
        if _is_switch_order(order):
            return self._score_switch(actor, order.order, opponents)
        if not _is_move_order(order):
            return -30.0
        value = self._score_move(battle, slot, actor, allies, opponents, order)
        move_id = _move_id(order.order)
        # Higher difficulties account more strongly for the opponent's best known
        # immediate pressure. Protect and priority attacks naturally mitigate that risk.
        if move_id not in PROTECT_MOVES | WIDE_DEFENSE_MOVES:
            risk = self._incoming_pressure(actor, opponents)
            priority = _number(getattr(order.order, "priority", 0.0))
            mitigation = 0.48 if _number(getattr(order.order, "base_power", 0.0)) > 0 else 0.75
            if priority > 0:
                mitigation *= 0.65
            value -= risk * self.profile.opponent_awareness * 0.075 * mitigation
        return value

    def _score_switch(self, actor: Any, incoming: Any, opponents: Sequence[Any]) -> float:
        if incoming is None or _fainted(incoming):
            return -100.0
        hp = _fraction(incoming)
        value = hp * 18.0 - 7.5  # switching pays a tempo cost
        value += sum(self._type_matchup(incoming, target) for target in opponents if not _fainted(target)) * 2.2
        ability = _ability_id(incoming)
        if ability == "intimidate":
            value += 8.0
        elif ability in {"regenerator", "naturalcure"}:
            value += 2.0
        elif ability in {"drought", "drizzle", "sandstream", "snowwarning", "electricsurge", "grassysurge", "psychicsurge", "mistysurge"}:
            value += 5.0
        if actor is not None:
            danger = sum(-min(0.0, self._type_matchup(actor, target)) for target in opponents if not _fainted(target))
            value += danger * 3.0
            if _fraction(actor) < 0.2:
                value -= 3.0  # sometimes a low-HP Pokémon is better used as a sacrifice
            boosts = getattr(actor, "boosts", None) or {}
            positive = sum(max(0, int(stage)) for stage in boosts.values())
            value -= positive * 3.5
            before = self._incoming_pressure(actor, opponents)
            after = self._incoming_pressure(incoming, opponents)
            value += (before - after) * self.profile.opponent_awareness * 0.10
        return value

    def _score_move(
        self,
        battle: Any,
        slot: int,
        actor: Any,
        allies: Sequence[Any],
        opponents: Sequence[Any],
        order: Any,
    ) -> float:
        move = order.order
        move_id = _move_id(move)
        base_power = max(0.0, _number(getattr(move, "base_power", 0.0)))
        accuracy = _number(getattr(move, "accuracy", 1.0), 1.0)
        if accuracy > 1.5:
            accuracy /= 100.0
        accuracy = max(0.25, min(1.0, accuracy or 1.0))
        expected_hits = max(1.0, _number(getattr(move, "expected_hits", 1.0), 1.0))
        target_kind = _move_target(move)
        selected_target = int(_number(getattr(order, "move_target", 0), 0))
        target_list = self._resolve_targets(opponents, selected_target, target_kind)

        # poke-env uses negative target positions for our own two slots. A handful of
        # VGC moves (most notably Pollen Puff and Beat Up) are intentionally aimed at an
        # ally, so treating every powered move as an attack on the opponent is wrong.
        if selected_target < 0:
            ally_index = abs(selected_target) - 1
            ally = allies[ally_index] if 0 <= ally_index < len(allies) else None
            if ally is None or _fainted(ally):
                return -45.0
            if move_id in ALLY_HEALING_MOVES:
                missing = 1.0 - _fraction(ally)
                return -12.0 if missing < 0.12 else 8.0 + missing * 28.0
            if move_id in ALLY_TRIGGER_MOVES and _ability_id(ally) in {"justified", "stamina", "weakarmor"}:
                return 16.0 + max(0.0, _fraction(ally) - 0.35) * 8.0
            # Deliberately damaging a partner is normally catastrophic. Spread-move ally
            # damage is handled later at the joint-action level instead.
            return -42.0

        if base_power > 0:
            value = 0.0
            for target in target_list:
                if _fainted(target):
                    value -= 15.0
                    continue
                multiplier = self._damage_multiplier(target, move)
                stab = 1.0
                move_type = _type_id(getattr(move, "type", ""))
                actor_types = {_type_id(item) for item in (getattr(actor, "types", None) or []) if item}
                if move_type and move_type in actor_types:
                    stab = 1.5
                category = _category(move)
                attack = _stat(actor, "atk" if category == "physical" else "spa")
                defense = max(30.0, _stat(target, "def" if category == "physical" else "spd"))
                stat_ratio = max(0.55, min(1.9, attack / defense))
                spread = 0.75 if target_kind in SPREAD_TARGETS and len(target_list) > 1 else 1.0
                raw = base_power * accuracy * expected_hits * stab * multiplier * stat_ratio * spread / 9.0
                value += raw
                hp = _fraction(target)
                estimated_percent = raw * 2.2
                if multiplier <= 0:
                    value -= 55.0
                elif estimated_percent >= hp * 100:
                    value += 21.0 + (1.0 - hp) * 5.0
                elif estimated_percent >= hp * 70:
                    value += 8.0
                priority = _number(getattr(move, "priority", 0.0))
                if priority > 0 and hp < 0.35:
                    value += 6.0
            if target_kind in SPREAD_TARGETS and len(target_list) > 1:
                value += 4.0
            if move_id == "fakeout":
                value += 17.0 if _first_active_turn(actor) else -55.0
            if move_id in POSITIONING_MOVES:
                value += 5.0
            if move_id in SPEED_CONTROL_MOVES:
                value += 5.0
        else:
            value = self._score_utility_move(battle, actor, opponents, move)

        if getattr(order, "terastallize", False):
            # Tera is valuable when the current action is already high-impact, but it is a
            # single battle resource and should not be spent on low-value utility.
            value += 12.0 if value >= self.profile.tera_threshold else -14.0
        if getattr(order, "mega", False):
            value += 7.0
        if getattr(order, "z_move", False) or getattr(order, "dynamax", False):
            value += 4.0 if value > 15 else -10.0
        return value

    def _score_utility_move(self, battle: Any, actor: Any, opponents: Sequence[Any], move: Any) -> float:
        move_id = _move_id(move)
        hp = _fraction(actor)
        if move_id in PROTECT_MOVES:
            pressure = self._incoming_pressure(actor, opponents)
            protect_counter = int(_number(getattr(actor, "protect_counter", 0), 0))
            value = 4.0 + pressure * 0.18
            if pressure < 25:
                value -= 8.0
            if protect_counter > 0:
                value -= 20.0
            return value
        if move_id in WIDE_DEFENSE_MOVES:
            return 9.0 + self._incoming_pressure(actor, opponents) * 0.06
        if move_id in REDIRECTION_MOVES:
            return 11.0 + max(0.0, hp - 0.35) * 12.0
        if move_id == "helpinghand":
            return 8.0
        active_effects = self._active_effect_ids(battle)
        if move_id == "trickroom":
            own_speed = _stat(actor, "spe")
            opp_speed = sum(_stat(mon, "spe") for mon in opponents if not _fainted(mon)) / max(1, sum(not _fainted(mon) for mon in opponents))
            value = 12.0 + max(-8.0, min(12.0, (opp_speed - own_speed) * 0.15))
            if "trickroom" in active_effects:
                value -= 18.0
            return value
        if move_id == "tailwind":
            return -10.0 if "tailwind" in active_effects else 16.0
        if move_id in SPEED_CONTROL_MOVES:
            return 11.0
        if move_id in DENIAL_MOVES:
            return 13.0
        if move_id in SETUP_MOVES:
            pressure = self._incoming_pressure(actor, opponents)
            return 19.0 - pressure * 0.12 + hp * 5.0
        if move_id in FIELD_MOVES:
            return 10.0
        if move_id in RECOVERY_MOVES:
            return 5.0 + (1.0 - hp) * 23.0 if hp < 0.78 else -8.0
        boosts = getattr(move, "boosts", None) or {}
        if boosts:
            return 7.0 + sum(_number(stage) for stage in boosts.values()) * 3.0
        status = to_id(getattr(move, "status", None))
        if status in {"slp", "sleep"}:
            return 16.0
        if status in {"brn", "par", "tox", "psn"}:
            return 9.0
        return 1.0

    def _cross_slot_score(
        self,
        battle: Any,
        active: Sequence[Any],
        opponents: Sequence[Any],
        first: Any,
        second: Any,
        single_scores: Sequence[float],
    ) -> list[tuple[str, float]]:
        result: list[tuple[str, float]] = []
        move_ids = [
            _move_id(getattr(order, "order", None)) if _is_move_order(order) else ""
            for order in (first, second)
        ]
        moves = [getattr(first, "order", None), getattr(second, "order", None)]

        if (move_ids[0] in HELPING_MOVES and _is_move_order(second)) or (
            move_ids[1] in HELPING_MOVES and _is_move_order(first)
        ):
            partner_index = 1 if move_ids[0] in HELPING_MOVES else 0
            partner_power = _number(getattr(moves[partner_index], "base_power", 0.0))
            result.append(("Helping Hand synergy", 11.0 if partner_power > 0 else -8.0))

        setup_or_control = SETUP_MOVES | {"trickroom", "tailwind"}
        if (move_ids[0] in REDIRECTION_MOVES and move_ids[1] in setup_or_control) or (
            move_ids[1] in REDIRECTION_MOVES and move_ids[0] in setup_or_control
        ):
            result.append(("redirection setup synergy", 18.0))

        if (
            move_ids[0] == "fakeout"
            and _first_active_turn(active[0])
            and move_ids[1] in setup_or_control
        ) or (
            move_ids[1] == "fakeout"
            and _first_active_turn(active[1])
            and move_ids[0] in setup_or_control
        ):
            result.append(("Fake Out setup synergy", 16.0))

        if (move_ids[0] in PROTECT_MOVES and single_scores[1] > 15) or (
            move_ids[1] in PROTECT_MOVES and single_scores[0] > 15
        ):
            result.append(("Protect partner tempo", 4.0))
        if move_ids[0] in PROTECT_MOVES and move_ids[1] in PROTECT_MOVES:
            result.append(("double Protect conservatism", -8.0))

        target_a = int(_number(getattr(first, "move_target", 0), 0))
        target_b = int(_number(getattr(second, "move_target", 0), 0))
        offensive_a = _is_move_order(first) and _number(getattr(moves[0], "base_power", 0.0)) > 0
        offensive_b = _is_move_order(second) and _number(getattr(moves[1], "base_power", 0.0)) > 0
        if offensive_a and offensive_b and target_a > 0 and target_a == target_b:
            target = opponents[target_a - 1] if target_a <= len(opponents) else None
            hp = _fraction(target) if target is not None else 1.0
            double_value = 7.0 if hp > 0.65 else -9.0
            result.append(("double-target allocation", double_value))

        if move_ids[0] and move_ids[0] == move_ids[1] and move_ids[0] in FIELD_MOVES | {"tailwind", "trickroom"}:
            result.append(("duplicate field setup", -35.0))

        if _is_switch_order(first) and _is_switch_order(second):
            if _species_id(first.order) == _species_id(second.order):
                result.append(("duplicate switch", -150.0))
            else:
                result.append(("double switch tempo", -5.0))

        # Earthquake-like all-adjacent moves can harm the ally.  poke-env's target enum
        # tells us that class even when exact damage simulation is unavailable.
        for index, move in enumerate(moves):
            if not _is_move_order((first, second)[index]):
                continue
            if _move_target(move) == "alladjacent":
                ally = active[1 - index]
                if ally is not None and not self._immune_to_move(ally, move):
                    result.append(("spread ally damage", -12.0))
        return result

    def _resolve_targets(self, opponents: Sequence[Any], selected: int, target_kind: str) -> list[Any]:
        living = [mon for mon in opponents if not _fainted(mon)]
        if target_kind in SPREAD_TARGETS:
            return living
        if selected > 0 and selected <= len(opponents):
            return [opponents[selected - 1]]
        return living[:1]

    def _damage_multiplier(self, target: Any, move: Any) -> float:
        if target is None:
            return 0.0
        try:
            return max(0.0, _number(target.damage_multiplier(move), 1.0))
        except (AttributeError, TypeError, ValueError):
            return 1.0

    def _immune_to_move(self, mon: Any, move: Any) -> bool:
        return self._damage_multiplier(mon, move) <= 0.0

    def _type_matchup(self, attacker: Any, defender: Any) -> float:
        if attacker is None or defender is None:
            return 0.0
        types = [type_ for type_ in (getattr(attacker, "types", None) or []) if type_]
        if not types:
            return 0.0
        # Starting at 0.25 preserves resisted matchups as negative values instead of
        # silently flattening every non-super-effective pairing to neutral.
        best = 0.25
        for type_ in types:
            try:
                multiplier = _number(defender.damage_multiplier(type_), 1.0)
            except (AttributeError, TypeError, ValueError):
                multiplier = 1.0
            best = max(best, multiplier)
        return math.log2(max(0.25, best))

    def _active_effect_ids(self, battle: Any) -> set[str]:
        result: set[str] = set()
        for name in ("fields", "side_conditions", "weather"):
            value = getattr(battle, name, None) or {}
            entries = value.keys() if hasattr(value, "keys") else value
            result.update(to_id(entry) for entry in entries)
        return result

    def _known_incoming_damage(self, attacker: Any, target: Any) -> float:
        moves = getattr(attacker, "moves", None) or {}
        values: Iterable[Any] = moves.values() if hasattr(moves, "values") else moves
        best = 0.0
        for move in values:
            power = max(0.0, _number(getattr(move, "base_power", 0.0)))
            if power <= 0:
                continue
            accuracy = _number(getattr(move, "accuracy", 1.0), 1.0)
            if accuracy > 1.5:
                accuracy /= 100.0
            category = _category(move)
            attack = _stat(attacker, "atk" if category == "physical" else "spa")
            defense = max(30.0, _stat(target, "def" if category == "physical" else "spd"))
            stab = 1.5 if _type_id(getattr(move, "type", "")) in {
                _type_id(item) for item in (getattr(attacker, "types", None) or []) if item
            } else 1.0
            multiplier = self._damage_multiplier(target, move)
            spread = 0.75 if _move_target(move) in SPREAD_TARGETS else 1.0
            estimate = power * max(0.25, min(1.0, accuracy or 1.0)) * stab * multiplier * spread
            estimate *= max(0.55, min(1.9, attack / defense)) * 0.24
            best = max(best, estimate)
        return min(120.0, best)

    def _incoming_pressure(self, mon: Any, opponents: Sequence[Any]) -> float:
        if mon is None:
            return 0.0
        threats: list[float] = []
        for opponent in opponents:
            if _fainted(opponent):
                continue
            known = self._known_incoming_damage(opponent, mon)
            if known <= 0:
                offensive = max(_stat(opponent, "atk"), _stat(opponent, "spa"))
                bulk = max(45.0, (_stat(mon, "def") + _stat(mon, "spd")) / 2)
                matchup = max(0.5, 2 ** max(0.0, self._type_matchup(opponent, mon)))
                known = min(100.0, 34.0 * offensive / bulk * matchup)
            threats.append(known)
        threats.sort(reverse=True)
        # The second opponent can join a double target, but it is discounted because it
        # may act elsewhere, Protect, or switch.
        return min(150.0, sum(value * (1.0 if index == 0 else 0.55) for index, value in enumerate(threats[:2])))

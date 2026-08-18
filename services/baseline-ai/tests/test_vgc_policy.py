from __future__ import annotations

import random
from types import SimpleNamespace

from baseline_ai.vgc_policy import VGCPolicy, profile_for_difficulty


class Type:
    def __init__(self, name: str):
        self.name = name


class Move:
    def __init__(self, name: str, power: int = 0, *, target: str = "normal", category: str = "Physical", type_: str = "Normal"):
        self.id = name
        self.base_power = power
        self.target = target
        self.category = category
        self.type = Type(type_)
        self.accuracy = 1
        self.expected_hits = 1
        self.priority = 0


class Mon:
    def __init__(
        self,
        species: str,
        *,
        hp: float = 1,
        speed: int = 90,
        moves=(),
        multipliers=None,
        ability="",
        active_turns: int = 0,
    ):
        self.species = species
        self.name = species
        self.current_hp_fraction = hp
        self.base_stats = {"hp": 90, "atk": 110, "def": 90, "spa": 100, "spd": 90, "spe": speed}
        self.stats = dict(self.base_stats)
        self.types = [Type("Normal")]
        self.moves = {move.id: move for move in moves}
        self.ability = ability
        self.item = species + " Item"
        self.fainted = False
        self.boosts = {"atk": 0, "def": 0, "spa": 0, "spd": 0, "spe": 0}
        self.protect_counter = 0
        self._active_turns = active_turns
        self._multipliers = multipliers or {}

    def damage_multiplier(self, move):
        key = getattr(move, "id", getattr(move, "name", str(move))).lower()
        return self._multipliers.get(key, 1)


class Order:
    def __init__(self, inner, target=0, *, tera=False):
        self.order = inner
        self.move_target = target
        self.terastallize = tera
        self.mega = self.z_move = self.dynamax = False

    def __str__(self):
        return f"{getattr(self.order, 'id', getattr(self.order, 'species', self.order))}:{self.move_target}"


class Joint:
    def __init__(self, first, second):
        self.first_order = first
        self.second_order = second

    def __str__(self):
        return f"{self.first_order}, {self.second_order}"


class Battle:
    def __init__(self, active, opponents, team=None, opponent_team=None):
        self.active_pokemon = active
        self.opponent_active_pokemon = opponents
        self.team = {str(i): mon for i, mon in enumerate(team or active, 1)}
        self.opponent_team = {str(i): mon for i, mon in enumerate(opponent_team or opponents, 1)}


def test_difficulty_profiles_become_less_random_and_more_selective():
    easy = profile_for_difficulty(1)
    expert = profile_for_difficulty(10)
    assert easy.temperature > expert.temperature
    assert easy.score_noise > expert.score_noise
    assert easy.rational_floor > expert.rational_floor
    assert easy.top_k > expert.top_k


def test_joint_policy_avoids_attacking_an_immunity():
    fire = Move("Flamethrower", 90, category="Special", type_="Fire")
    neutral = Move("Moonblast", 95, category="Special", type_="Fairy")
    protect = Move("Protect")
    own = [Mon("Attacker", moves=(fire, neutral)), Mon("Partner", moves=(protect,))]
    targets = [Mon("Immune", multipliers={"flamethrower": 0}), Mon("Target")]
    bad = Joint(Order(fire, 1), Order(protect))
    good = Joint(Order(neutral, 1), Order(protect))
    policy = VGCPolicy(10, rng=random.Random(1))
    ranked = policy.rank_joint_orders(Battle(own, targets), [bad, good])
    assert ranked[0].order is good


def test_redirection_plus_setup_gets_joint_synergy():
    follow_me = Move("Follow Me")
    swords_dance = Move("Swords Dance")
    tackle = Move("Tackle", 40)
    own = [Mon("Support", moves=(follow_me,)), Mon("Sweeper", moves=(swords_dance, tackle))]
    targets = [Mon("Foe A"), Mon("Foe B")]
    setup = Joint(Order(follow_me), Order(swords_dance))
    weak_attack = Joint(Order(follow_me), Order(tackle, 1))
    policy = VGCPolicy(10, rng=random.Random(2))
    ranked = policy.rank_joint_orders(Battle(own, targets), [weak_attack, setup])
    assert ranked[0].order is setup
    assert any(name == "redirection setup synergy" for name, _ in ranked[0].components)


def test_team_preview_returns_two_leads_and_two_backups():
    fake_out = Move("Fake Out", 40)
    trick_room = Move("Trick Room")
    ordinary = Move("Tackle", 40)
    team = [
        Mon("Fake Out Lead", moves=(fake_out,)),
        Mon("Room Setter", speed=30, moves=(trick_room,)),
        Mon("Slow One", speed=25, moves=(ordinary,)),
        Mon("Slow Two", speed=35, moves=(ordinary,)),
        Mon("Fast Bench", speed=150, moves=(ordinary,)),
        Mon("Other Bench", speed=140, moves=(ordinary,)),
    ]
    opponents = [Mon("Fast Foe", speed=130), Mon("Fast Foe 2", speed=120)]
    policy = VGCPolicy(10, rng=random.Random(3))
    order = policy.choose_team_preview(Battle(team[:2], opponents, team=team, opponent_team=opponents))
    assert len(order) == 4
    assert len(set(order)) == 4
    assert set(order).issubset(set(range(1, 7)))
    assert 1 in order[:2] or 2 in order[:2]


def test_catastrophic_duplicate_switch_is_ranked_last():
    own = [Mon("One"), Mon("Two")]
    targets = [Mon("Foe A"), Mon("Foe B")]
    incoming = Mon("Bench")
    duplicate = Joint(Order(incoming), Order(incoming))
    normal = Joint(Order(Move("Protect")), Order(Move("Protect")))
    ranked = VGCPolicy(10, rng=random.Random(4)).rank_joint_orders(Battle(own, targets), [duplicate, normal])
    assert ranked[-1].order is duplicate


def test_pollen_puff_heals_a_damaged_ally_instead_of_being_scored_as_foe_damage():
    pollen_puff = Move("Pollen Puff", 90, target="any", category="Special", type_="Bug")
    protect = Move("Protect")
    own = [Mon("Support", moves=(pollen_puff,)), Mon("Damaged Ally", hp=0.25, moves=(protect,))]
    targets = [Mon("Foe A"), Mon("Foe B")]
    heal = Joint(Order(pollen_puff, -2), Order(protect))
    attack = Joint(Order(pollen_puff, 1), Order(protect))
    ranked = VGCPolicy(10, rng=random.Random(8)).rank_joint_orders(Battle(own, targets), [attack, heal])
    assert ranked[0].order is heal


def test_active_tailwind_is_not_reselected_without_a_reason():
    tailwind = Move("Tailwind")
    moonblast = Move("Moonblast", 95, category="Special", type_="Fairy")
    protect = Move("Protect")
    own = [Mon("Support", moves=(tailwind, moonblast)), Mon("Partner", moves=(protect,))]
    targets = [Mon("Foe A"), Mon("Foe B")]
    battle = Battle(own, targets)
    battle.side_conditions = {"Tailwind": 2}
    repeat = Joint(Order(tailwind), Order(protect))
    attack = Joint(Order(moonblast, 1), Order(protect))
    ranked = VGCPolicy(10, rng=random.Random(9)).rank_joint_orders(battle, [repeat, attack])
    assert ranked[0].order is attack


def test_high_difficulty_accounts_more_for_known_incoming_pressure():
    strong = Move("Nuke", 180, category="Special", type_="Normal")
    setup = Move("Swords Dance")
    protect = Move("Protect")
    own = [Mon("Fragile", moves=(setup, protect)), Mon("Partner", moves=(protect,))]
    targets = [Mon("Threat", moves=(strong,), speed=150), Mon("Other")]
    battle = Battle(own, targets)
    risky = Joint(Order(setup), Order(protect))
    safe = Joint(Order(protect), Order(protect))
    easy = VGCPolicy(1, rng=random.Random(10)).rank_joint_orders(battle, [risky, safe])
    hard = VGCPolicy(10, rng=random.Random(10)).rank_joint_orders(battle, [risky, safe])
    easy_gap = next(item.score for item in easy if item.order is risky) - next(item.score for item in easy if item.order is safe)
    hard_gap = next(item.score for item in hard if item.order is risky) - next(item.score for item in hard if item.order is safe)
    assert hard_gap < easy_gap


def test_fake_out_is_heavily_penalized_after_the_switch_in_turn():
    fake_out = Move("Fake Out", 40)
    tackle = Move("Tackle", 40)
    protect = Move("Protect")
    own = [Mon("Lead", moves=(fake_out, tackle), active_turns=2), Mon("Partner", moves=(protect,))]
    targets = [Mon("Foe A"), Mon("Foe B")]
    expired = Joint(Order(fake_out, 1), Order(protect))
    ordinary = Joint(Order(tackle, 1), Order(protect))
    ranked = VGCPolicy(10, rng=random.Random(11)).rank_joint_orders(Battle(own, targets), [expired, ordinary])
    assert ranked[0].order is ordinary


def test_target_enum_uses_semantic_name_instead_of_numeric_value():
    from enum import Enum
    from baseline_ai.vgc_policy import _move_target

    class Target(Enum):
        ALL_ADJACENT_FOES = 5

    move = SimpleNamespace(target=Target.ALL_ADJACENT_FOES)
    assert _move_target(move) == "alladjacentfoes"


def test_type_matchup_preserves_resisted_matchups_as_negative():
    attacker = Mon("Fire attacker")
    attacker.types = [Type("Fire")]
    defender = Mon("Resist", multipliers={"fire": 0.5})
    assert VGCPolicy(10)._type_matchup(attacker, defender) < 0

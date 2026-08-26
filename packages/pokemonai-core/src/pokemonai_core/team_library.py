"""Safe, versioned team-source ingestion for PokémonAI.

Only data files are read. GitHub sources must be pinned to a 40-character commit and are
synchronised through the contents/tree APIs; no checked-out repository code is executed.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from fnmatch import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import random
import re
import shutil
import subprocess
import tempfile
from typing import Any, Iterable, Iterator
from urllib.parse import quote
from urllib.request import Request, urlopen
import uuid

import yaml


_ID_RE = re.compile(r"[^a-z0-9]+")
_SOURCE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
_REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_COMMIT_RE = re.compile(r"^[0-9a-fA-F]{40}$")
SUPPORTED_ADAPTERS = frozenset({
    "auto",
    "showdown-directory",
    "vgc-bench",
    "pokemon-vgc-ai",
    "generic-json",
    "generic-yaml",
})
ALLOWED_SUFFIXES = (
    ".txt",
    ".team",
    ".paste",
    ".packed",
    ".paste.txt",
    ".packed.txt",
    ".json",
    ".yaml",
    ".yml",
)


def to_id(value: Any) -> str:
    """Return Pokémon Showdown's ASCII identifier representation."""

    return _ID_RE.sub("", str(value or "").lower())


def pack_name(value: Any) -> str:
    """Sanitise a display field before inserting it into packed-team syntax.

    Packed teams use ``|`` between fields and ``]`` between Pokémon.  Team sources are
    untrusted data, so allowing either delimiter (or control characters) in a nickname
    would let one record mutate the remainder of the generated team.
    """

    text = re.sub(r"[\x00-\x1f\x7f|\]]", "", str(value or ""))
    return " ".join(text.split()).strip()


def _safe_relative(path: str) -> PurePosixPath:
    item = PurePosixPath(path)
    if item.is_absolute() or ".." in item.parts:
        raise ValueError(f"Unsafe source path: {path}")
    return item


def _allowed(path: str) -> bool:
    lowered = path.lower()
    return any(lowered.endswith(suffix) for suffix in ALLOWED_SUFFIXES)


def _git_blob_sha(payload: bytes) -> str:
    header = f"blob {len(payload)}\0".encode("ascii")
    return hashlib.sha1(header + payload).hexdigest()  # noqa: S324 - Git object identity


def _glob_matches(path: str, pattern: str) -> bool:
    """Match Git-style ``**`` patterns, including zero directory components.

    :func:`fnmatch` treats ``**`` like two ordinary ``*`` characters, so a pattern
    such as ``teams/**/*`` would unexpectedly skip ``teams/example.txt``.  Source
    configuration follows normal recursive-glob expectations instead.
    """

    candidates = {pattern}
    current = pattern
    while "/**/" in current:
        current = current.replace("/**/", "/", 1)
        candidates.add(current)
    if pattern.startswith("**/"):
        candidates.add(pattern[3:])
    return any(fnmatch(path, candidate) for candidate in candidates)


@dataclass(frozen=True)
class TeamSourceSpec:
    id: str
    label: str
    type: str
    enabled: bool
    adapter: str = "auto"
    license: str = "UNKNOWN"
    allow_unknown_license: bool = False
    path: str | None = None
    repository: str | None = None
    ref: str | None = None
    include: tuple[str, ...] = ("**/*",)
    format_id: str | None = None
    pool: str | None = None
    max_files: int = 1000
    max_total_bytes: int = 20_000_000


@dataclass(frozen=True)
class TeamSet:
    name: str
    species: str
    item: str = ""
    ability: str = ""
    moves: tuple[str, ...] = ()
    nature: str = ""
    evs: dict[str, int] = field(default_factory=dict)
    ivs: dict[str, int] = field(default_factory=dict)
    gender: str = ""
    level: int = 100
    happiness: int = 255
    shiny: bool = False
    tera_type: str = ""

    def canonical(self) -> dict[str, Any]:
        return {
            "species": to_id(self.species or self.name),
            "item": to_id(self.item),
            "ability": to_id(self.ability),
            "moves": sorted(to_id(move) for move in self.moves),
            "nature": to_id(self.nature),
            "evs": {key: int(self.evs.get(key, 0)) for key in ("hp", "atk", "def", "spa", "spd", "spe")},
            "ivs": {key: int(self.ivs.get(key, 31)) for key in ("hp", "atk", "def", "spa", "spd", "spe")},
            "gender": self.gender,
            "level": int(self.level),
            "happiness": int(self.happiness),
            "shiny": bool(self.shiny),
            "tera_type": to_id(self.tera_type),
        }


@dataclass
class TeamRecord:
    id: str
    name: str
    format_id: str
    pool: str
    source_id: str
    source_label: str
    source_repository: str | None
    source_commit: str | None
    source_path: str
    author: str | None
    license: str
    tags: list[str]
    archetype: str
    paste: str
    packed: str
    roster: list[dict[str, Any]]
    fingerprint: str
    validation_status: str = "unvalidated"
    validation_errors: list[str] = field(default_factory=list)
    duplicate_sources: list[dict[str, str]] = field(default_factory=list)

    def public_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data.pop("validation_errors", None)
        # The browser only needs species identifiers to render a compact roster.
        # Keep full sets in the private catalogue while avoiding unnecessary
        # disclosure and payload growth in the public endpoint.
        data["roster"] = [
            {"species": str(mon.get("species") or "")} for mon in self.roster
        ]
        return data


@dataclass(frozen=True)
class TeamLibraryConfig:
    cache_dir: Path
    library_dir: Path
    sources: tuple[TeamSourceSpec, ...]


def load_team_sources(path: str | Path, *, project_root: str | Path | None = None) -> TeamLibraryConfig:
    config_path = Path(path).resolve()
    root = Path(project_root).resolve() if project_root else config_path.parent.parent.resolve()
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("Team source configuration must be a YAML mapping")
    entries = raw.get("sources")
    if not isinstance(entries, list):
        raise ValueError("sources must be a list")
    sources: list[TeamSourceSpec] = []
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Each team source must be a mapping")
        source = TeamSourceSpec(
            id=str(entry.get("id", "")).strip(),
            label=str(entry.get("label", "")).strip(),
            type=str(entry.get("type", "")).strip().lower(),
            enabled=bool(entry.get("enabled", False)),
            adapter=str(entry.get("adapter", "auto")).strip().lower(),
            license=str(entry.get("license", "UNKNOWN")).strip() or "UNKNOWN",
            allow_unknown_license=bool(entry.get("allow_unknown_license", False)),
            path=str(entry.get("path")).strip() if entry.get("path") else None,
            repository=str(entry.get("repository")).strip() if entry.get("repository") else None,
            ref=str(entry.get("ref")).strip() if entry.get("ref") else None,
            include=tuple(str(item) for item in (entry.get("include") or ["**/*"])),
            format_id=str(entry.get("format_id")).strip() if entry.get("format_id") else None,
            pool=str(entry.get("pool")).strip() if entry.get("pool") else None,
            max_files=max(1, int(entry.get("max_files", 1000))),
            max_total_bytes=max(1, int(entry.get("max_total_bytes", 20_000_000))),
        )
        if not source.id or not source.label or source.type not in {"directory", "github"}:
            raise ValueError("Source id, label, and a supported type are required")
        if not _SOURCE_ID_RE.fullmatch(source.id):
            raise ValueError(f"Source id contains unsafe characters: {source.id!r}")
        if source.adapter not in SUPPORTED_ADAPTERS:
            raise ValueError(f"Unsupported team source adapter for {source.id}: {source.adapter}")
        if source.id in seen:
            raise ValueError(f"Duplicate team source id: {source.id}")
        if source.enabled and source.license.upper() == "UNKNOWN" and not source.allow_unknown_license:
            raise ValueError(
                f"Source {source.id} has an unknown license and cannot be enabled without allow_unknown_license"
            )
        if source.repository and not _REPOSITORY_RE.fullmatch(source.repository):
            raise ValueError(f"Source {source.id} has an invalid repository")
        if source.ref and not _COMMIT_RE.fullmatch(source.ref):
            raise ValueError(f"Source {source.id} has an invalid pinned commit")
        if source.type == "directory" and not source.path:
            raise ValueError(f"Directory source {source.id} requires path")
        if source.type == "github":
            if not source.repository:
                raise ValueError(f"GitHub source {source.id} has an invalid repository")
            if not source.ref:
                raise ValueError(f"GitHub source {source.id} must be pinned to a 40-character commit")
        for pattern in source.include:
            _safe_relative(pattern.replace("*", "x"))
        seen.add(source.id)
        sources.append(source)
    return TeamLibraryConfig(
        cache_dir=_rooted(root, str(raw.get("cache_dir", "var/cache/team-sources"))),
        library_dir=_rooted(root, str(raw.get("library_dir", "var/generated/team-library"))),
        sources=tuple(sources),
    )


def _rooted(root: Path, configured: str) -> Path:
    path = Path(configured)
    return path.resolve() if path.is_absolute() else (root / path).resolve()


def parse_paste(text: str) -> list[TeamSet]:
    blocks = [block.strip() for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n")) if block.strip()]
    sets: list[TeamSet] = []
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not lines or lines[0].startswith(("#", "//")):
            continue
        header = lines[0]
        item = ""
        if " @ " in header:
            header, item = header.rsplit(" @ ", 1)
        gender = ""
        gender_match = re.search(r"\s+\(([MFN])\)$", header)
        if gender_match:
            gender = gender_match.group(1)
            header = header[: gender_match.start()].strip()
        species = header
        name = header
        nickname_match = re.match(r"^(.*?)\s+\(([^()]*)\)$", header)
        if nickname_match:
            name = nickname_match.group(1).strip()
            species = nickname_match.group(2).strip()

        ability = nature = tera_type = ""
        level = 100
        happiness = 255
        shiny = False
        evs: dict[str, int] = {}
        ivs: dict[str, int] = {}
        moves: list[str] = []
        for line in lines[1:]:
            if line.startswith("Ability:"):
                ability = line.partition(":")[2].strip()
            elif line.startswith("Level:"):
                level = int(line.partition(":")[2].strip())
            elif line.startswith("Happiness:"):
                happiness = int(line.partition(":")[2].strip())
            elif line.startswith("Shiny:"):
                shiny = line.partition(":")[2].strip().lower() == "yes"
            elif line.startswith("Tera Type:"):
                tera_type = line.partition(":")[2].strip()
            elif line.startswith("EVs:"):
                evs = _parse_stats(line.partition(":")[2])
            elif line.startswith("IVs:"):
                ivs = _parse_stats(line.partition(":")[2])
            elif line.endswith(" Nature"):
                nature = line[: -len(" Nature")].strip()
            elif line.startswith("-"):
                moves.append(line[1:].strip())
        if not species or not moves:
            continue
        sets.append(
            TeamSet(
                name=name,
                species=species,
                item=item.strip(),
                ability=ability,
                moves=tuple(moves),
                nature=nature,
                evs=evs,
                ivs=ivs,
                gender=gender,
                level=level,
                happiness=happiness,
                shiny=shiny,
                tera_type=tera_type,
            )
        )
    return sets


def _parse_stats(value: str) -> dict[str, int]:
    aliases = {"hp": "hp", "atk": "atk", "def": "def", "spa": "spa", "spd": "spd", "spe": "spe"}
    result: dict[str, int] = {}
    for chunk in value.split("/"):
        match = re.match(r"\s*(\d+)\s+([A-Za-z]+)", chunk)
        if not match:
            continue
        stat = aliases.get(match.group(2).lower())
        if stat:
            result[stat] = int(match.group(1))
    return result


def parse_packed(text: str) -> list[TeamSet]:
    text = text.strip()
    if not text or "|" not in text:
        return []
    sets: list[TeamSet] = []
    for raw_set in text.split("]"):
        fields = raw_set.split("|")
        if len(fields) < 6:
            continue
        name = fields[0]
        species = fields[1] or name
        item = fields[2]
        ability = fields[3]
        moves = tuple(move for move in fields[4].split(",") if move)
        nature = fields[5]
        evs = _unpack_stats(fields[6] if len(fields) > 6 else "", default=0)
        gender = fields[7] if len(fields) > 7 else ""
        ivs = _unpack_stats(fields[8] if len(fields) > 8 else "", default=31)
        shiny = len(fields) > 9 and fields[9] == "S"
        level = int(fields[10]) if len(fields) > 10 and fields[10].isdigit() else 100
        happiness_field = fields[11] if len(fields) > 11 else ""
        happiness_parts = happiness_field.split(",")
        happiness = int(happiness_parts[0]) if happiness_parts and happiness_parts[0].isdigit() else 255
        tera_type = happiness_parts[5] if len(happiness_parts) > 5 else ""
        sets.append(
            TeamSet(
                name=name,
                species=species,
                item=item,
                ability=ability,
                moves=moves,
                nature=nature,
                evs=evs,
                ivs=ivs,
                gender=gender,
                level=level,
                happiness=happiness,
                shiny=shiny,
                tera_type=tera_type,
            )
        )
    return sets


def _unpack_stats(value: str, *, default: int) -> dict[str, int]:
    if not value:
        return {}
    names = ("hp", "atk", "def", "spa", "spd", "spe")
    parts = value.split(",")
    return {
        name: int(parts[index]) if index < len(parts) and parts[index].strip().lstrip("-").isdigit() else default
        for index, name in enumerate(names)
    }


def pack_team(sets: Iterable[TeamSet]) -> str:
    """Encode team sets without allowing source text to inject packed delimiters."""

    packed: list[str] = []
    for team_set in sets:
        species_id = to_id(team_set.species or team_set.name)
        display_name = pack_name(team_set.name or team_set.species) or species_id
        name_id = to_id(display_name)
        species_field = "" if species_id == name_id else species_id
        evs = _pack_stats(team_set.evs, default=0)
        ivs = _pack_stats(team_set.ivs, default=31, blanks_for_default=True)
        extras = f",,,,,{to_id(team_set.tera_type)}" if team_set.tera_type else ""
        fields = [
            display_name,
            species_field,
            to_id(team_set.item),
            to_id(team_set.ability),
            ",".join(to_id(move) for move in team_set.moves),
            pack_name(team_set.nature),
            evs,
            team_set.gender if team_set.gender in {"M", "F", "N"} else "",
            ivs,
            "S" if team_set.shiny else "",
            str(team_set.level) if team_set.level != 100 else "",
            (str(team_set.happiness) if team_set.happiness != 255 else "") + extras,
        ]
        packed.append("|".join(fields))
    return "]".join(packed)


def _pack_stats(values: dict[str, int], *, default: int, blanks_for_default: bool = False) -> str:
    if not values:
        return ""
    fields = []
    for name in ("hp", "atk", "def", "spa", "spd", "spe"):
        value = int(values.get(name, default))
        fields.append("" if blanks_for_default and value == default else (str(value) if value != 0 else ""))
    return ",".join(fields) if any(fields) else ""


def export_paste(sets: Iterable[TeamSet]) -> str:
    blocks: list[str] = []
    for item in sets:
        header = item.name or item.species
        if to_id(header) != to_id(item.species):
            header += f" ({item.species})"
        if item.item:
            header += f" @ {item.item}"
        lines = [header]
        if item.ability:
            lines.append(f"Ability: {item.ability}")
        if item.level != 100:
            lines.append(f"Level: {item.level}")
        if item.evs:
            lines.append("EVs: " + " / ".join(f"{value} {_display_stat(name)}" for name, value in item.evs.items()))
        if item.nature:
            lines.append(f"{item.nature} Nature")
        if item.ivs:
            lines.append("IVs: " + " / ".join(f"{value} {_display_stat(name)}" for name, value in item.ivs.items()))
        if item.tera_type:
            lines.append(f"Tera Type: {item.tera_type}")
        lines.extend(f"- {move}" for move in item.moves)
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _display_stat(name: str) -> str:
    return {
        "hp": "HP",
        "atk": "Atk",
        "def": "Def",
        "spa": "SpA",
        "spd": "SpD",
        "spe": "Spe",
    }.get(name.lower(), name)


def team_fingerprint(sets: Iterable[TeamSet]) -> str:
    canonical = sorted((item.canonical() for item in sets), key=lambda entry: json.dumps(entry, sort_keys=True))
    payload = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def detect_tags(sets: Iterable[TeamSet]) -> tuple[str, list[str]]:
    move_ids = {to_id(move) for item in sets for move in item.moves}
    abilities = {to_id(item.ability) for item in sets}
    tags: list[str] = []
    if move_ids & {"tailwind", "icywind", "electroweb"}:
        tags.append("速度控制")
    if "trickroom" in move_ids:
        tags.append("戏法空间")
    if abilities & {"drought", "orichalcumpulse"} or "sunnyday" in move_ids:
        tags.append("晴天")
    if abilities & {"drizzle"} or "raindance" in move_ids:
        tags.append("雨天")
    if move_ids & {"followme", "ragepowder"}:
        tags.append("重定向")
    if "fakeout" in move_ids:
        tags.append("击掌奇袭")
    if move_ids & {"reflect", "lightscreen", "auroraveil"}:
        tags.append("双墙")
    if move_ids & {"swordsdance", "nastyplot", "calmmind", "dragondance", "quiverdance"}:
        tags.append("强化")
    if not tags:
        tags.append("平衡")
    archetype = "戏法空间" if "戏法空间" in tags else "顺风进攻" if "速度控制" in tags else tags[0]
    return archetype, tags


def prevalidate_team(sets: Iterable[TeamSet], format_id: str) -> list[str]:
    """Run deterministic checks before invoking Pokémon Showdown.

    The Champions mod deliberately replaces vanilla EVs with Stat Points and fixes all
    IVs to 31.  These checks make an incomplete local checkout fail closed instead of
    publishing an obviously illegal team as if Showdown had validated it.  Showdown is
    still the authoritative validator whenever its complete data checkout is present.
    """

    team = list(sets)
    errors: list[str] = []
    if len(team) != 6:
        errors.append(f"A playable team must contain exactly six Pokémon (got {len(team)})")
        return errors

    for index, item in enumerate(team, start=1):
        label = item.species or item.name or f"slot {index}"
        if not to_id(item.species or item.name):
            errors.append(f"Slot {index} is missing a species")
        if not 1 <= len(item.moves) <= 4:
            errors.append(f"{label} must have between one and four moves")
        if len({to_id(move) for move in item.moves}) != len(item.moves):
            errors.append(f"{label} contains duplicate moves")
        if item.level < 1 or item.level > 9999:
            errors.append(f"{label} has an invalid level: {item.level}")

    if format_id.startswith("champions-"):
        species_ids = [to_id(item.species or item.name) for item in team]
        duplicate_species = sorted({species for species in species_ids if species and species_ids.count(species) > 1})
        if duplicate_species:
            errors.append("Species Clause violation: " + ", ".join(duplicate_species))

        item_ids = [to_id(item.item) for item in team if to_id(item.item)]
        duplicate_items = sorted({item for item in item_ids if item_ids.count(item) > 1})
        if duplicate_items:
            errors.append("Item Clause violation: " + ", ".join(duplicate_items))

        for item in team:
            label = item.species or item.name
            stat_points = {name: int(item.evs.get(name, 0)) for name in ("hp", "atk", "def", "spa", "spd", "spe")}
            outside_range = {name: value for name, value in stat_points.items() if value < 0 or value > 32}
            if outside_range:
                rendered = ", ".join(f"{name}={value}" for name, value in outside_range.items())
                errors.append(f"{label} has Stat Points outside 0..32: {rendered}")
            total = sum(stat_points.values())
            if total > 66:
                errors.append(f"{label} has {total} total Stat Points; Champions allows at most 66")
            nonperfect_ivs = {name: value for name, value in item.ivs.items() if int(value) != 31}
            if nonperfect_ivs:
                rendered = ", ".join(f"{name}={value}" for name, value in nonperfect_ivs.items())
                errors.append(f"{label} has non-31 IVs, which Champions does not allow: {rendered}")
    return errors


class TeamSourceSynchronizer:
    def __init__(self, config: TeamLibraryConfig, *, timeout: float = 20.0) -> None:
        self.config = config
        self.timeout = timeout

    def sync(self, source_ids: set[str] | None = None) -> list[dict[str, Any]]:
        manifests: list[dict[str, Any]] = []
        for source in self.config.sources:
            explicitly_selected = bool(source_ids and source.id in source_ids)
            if source_ids and not explicitly_selected:
                continue
            if not source.enabled and not explicitly_selected:
                continue
            if source.license.upper() == "UNKNOWN" and not source.allow_unknown_license:
                raise ValueError(
                    f"Source {source.id} has an unknown license; set allow_unknown_license=true "
                    "only after reviewing its redistribution terms"
                )
            if source.type == "directory":
                manifests.append({"source": source.id, "type": "directory", "status": "local"})
            else:
                manifests.append(self._sync_github(source))
        return manifests

    def _sync_github(self, source: TeamSourceSpec) -> dict[str, Any]:
        assert source.repository and source.ref
        tree_url = f"https://api.github.com/repos/{source.repository}/git/trees/{source.ref}?recursive=1"
        tree = self._json(tree_url)
        if tree.get("truncated"):
            raise ValueError(
                f"GitHub returned a truncated tree for {source.id}; narrow the include patterns"
            )
        files = []
        total = 0
        for entry in tree.get("tree", []):
            path = str(entry.get("path", ""))
            if entry.get("type") != "blob" or not _allowed(path):
                continue
            if not any(_glob_matches(path, pattern) for pattern in source.include):
                continue
            size = int(entry.get("size") or 0)
            files.append((path, size, str(entry.get("sha", ""))))
            total += size
        files.sort(key=lambda entry: entry[0])
        if not files:
            raise ValueError(
                f"Source {source.id} matched no supported team files; keeping the previous cache"
            )
        if len(files) > source.max_files:
            raise ValueError(f"Source {source.id} exceeds max_files ({len(files)} > {source.max_files})")
        if total > source.max_total_bytes:
            raise ValueError(f"Source {source.id} exceeds max_total_bytes ({total})")

        self.config.cache_dir.mkdir(parents=True, exist_ok=True)
        destination = self.config.cache_dir / source.id
        staging = Path(
            tempfile.mkdtemp(prefix=f".{source.id}-staging-", dir=self.config.cache_dir)
        )
        backup = self.config.cache_dir / f".{source.id}-backup-{uuid.uuid4().hex}"
        swapped = False
        try:
            manifest_files: list[dict[str, Any]] = []
            downloaded_total = 0
            for path, size, sha in files:
                safe = _safe_relative(path)
                target = staging.joinpath(*safe.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                raw_url = (
                    f"https://raw.githubusercontent.com/{source.repository}/{source.ref}/"
                    f"{quote(path, safe='/')}"
                )
                payload = self._bytes(raw_url, max_bytes=max(size + 1, 5_000_001))
                if size and len(payload) != size:
                    raise ValueError(
                        f"Downloaded size mismatch for {source.id}:{path} "
                        f"({len(payload)} != {size})"
                    )
                if len(payload) > max(size + 1024, 5_000_000):
                    raise ValueError(f"Unexpectedly large file from {source.id}: {path}")
                downloaded_total += len(payload)
                if downloaded_total > source.max_total_bytes:
                    raise ValueError(
                        f"Downloaded content from {source.id} exceeds max_total_bytes "
                        f"({downloaded_total} > {source.max_total_bytes})"
                    )
                git_blob_sha = _git_blob_sha(payload)
                if sha and git_blob_sha.lower() != sha.lower():
                    raise ValueError(
                        f"Git blob SHA mismatch for {source.id}:{path} "
                        f"({git_blob_sha} != {sha})"
                    )
                target.write_bytes(payload)
                manifest_files.append(
                    {
                        "path": path,
                        "git_blob_sha": sha,
                        "bytes": len(payload),
                        "sha256": hashlib.sha256(payload).hexdigest(),
                    }
                )
            manifest = {
                "source": source.id,
                "repository": source.repository,
                "commit": source.ref,
                "license": source.license,
                "files": manifest_files,
            }
            (staging / "pokemonai-source-manifest.json").write_text(
                json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
            )

            # A completed staging tree replaces the old cache as one directory rename.
            # If anything above fails, the previous cache stays untouched.  The backup
            # also lets us roll back if the second rename unexpectedly fails.
            if destination.exists():
                destination.rename(backup)
            staging.rename(destination)
            swapped = True
            if backup.exists():
                shutil.rmtree(backup)
            return manifest
        except Exception:
            if swapped and destination.exists():
                shutil.rmtree(destination)
            if backup.exists() and not destination.exists():
                backup.rename(destination)
            raise
        finally:
            if staging.exists():
                shutil.rmtree(staging)
            if backup.exists() and destination.exists():
                shutil.rmtree(backup)

    def _bytes(self, url: str, *, max_bytes: int = 25_000_000) -> bytes:
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "PokemonAI-TeamSource/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        token = os.environ.get("GITHUB_TOKEN", "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = Request(url, headers=headers)
        with urlopen(request, timeout=self.timeout) as response:
            payload = response.read(max_bytes + 1)
        if len(payload) > max_bytes:
            raise ValueError(f"Remote response exceeded the {max_bytes}-byte safety limit")
        return payload

    def _json(self, url: str) -> dict[str, Any]:
        return json.loads(self._bytes(url).decode("utf-8"))


class TeamLibraryBuilder:
    def __init__(self, config: TeamLibraryConfig, project_root: str | Path) -> None:
        self.config = config
        self.project_root = Path(project_root).resolve()

    def build(
        self, *, validate: bool = True, source_ids: set[str] | None = None
    ) -> list[TeamRecord]:
        records_by_fingerprint: dict[tuple[str, str, str], TeamRecord] = {}
        for source in self.config.sources:
            explicitly_selected = bool(source_ids and source.id in source_ids)
            if not source.enabled and not explicitly_selected:
                continue
            if source.license.upper() == "UNKNOWN" and not source.allow_unknown_license:
                raise ValueError(
                    f"Source {source.id} has an unknown license; it cannot be included in the built catalogue"
                )
            for file_path, source_path in self._source_files(source):
                for index, (name, sets, original) in enumerate(self._parse_file(file_path), start=1):
                    if len(sets) != 6:
                        continue
                    fingerprint = team_fingerprint(sets)
                    format_id = source.format_id or self._infer_format(file_path, source)
                    pool = source.pool or format_id
                    identity = (format_id, pool, fingerprint)
                    if identity in records_by_fingerprint:
                        records_by_fingerprint[identity].duplicate_sources.append(
                            {"source_id": source.id, "source_path": source_path}
                        )
                        continue
                    archetype, tags = detect_tags(sets)
                    record = TeamRecord(
                        id=f"{source.id}-{fingerprint[:12]}",
                        name=name or file_path.stem.replace(".paste", "").replace(".packed", ""),
                        format_id=format_id,
                        pool=pool,
                        source_id=source.id,
                        source_label=source.label,
                        source_repository=source.repository,
                        source_commit=source.ref,
                        source_path=source_path,
                        author=None,
                        license=source.license,
                        tags=tags,
                        archetype=archetype,
                        paste=export_paste(sets) if not original.strip().startswith(tuple("[{")) else export_paste(sets),
                        packed=pack_team(sets),
                        roster=[item.canonical() | {"name": item.name, "species_name": item.species} for item in sets],
                        fingerprint=fingerprint,
                    )
                    record.validation_errors = prevalidate_team(sets, format_id)
                    if record.validation_errors:
                        record.validation_status = "invalid-precheck"
                    elif validate:
                        self._validate(record)
                    else:
                        record.validation_status = "prevalidated"
                    records_by_fingerprint[identity] = record
        records = sorted(records_by_fingerprint.values(), key=lambda item: (item.format_id, item.name, item.id))
        self._write(records)
        return records

    def _source_files(self, source: TeamSourceSpec) -> Iterator[tuple[Path, str]]:
        if source.type == "directory":
            base = (self.project_root / str(source.path)).resolve()
        else:
            base = (self.config.cache_dir / source.id).resolve()
        if not base.exists():
            return
        for path in sorted(item for item in base.rglob("*") if item.is_file() and _allowed(item.name)):
            resolved = path.resolve(strict=True)
            try:
                relative = resolved.relative_to(base).as_posix()
            except ValueError as error:
                raise ValueError(f"Team source file escapes its configured root: {path}") from error
            if path.name == "pokemonai-source-manifest.json":
                continue
            if any(_glob_matches(relative, pattern) for pattern in source.include):
                if resolved.stat().st_size <= 5_000_000:
                    yield resolved, relative

    def _parse_file(self, path: Path) -> Iterator[tuple[str, list[TeamSet], str]]:
        text = path.read_text(encoding="utf-8", errors="strict")
        lowered = path.name.lower()
        if lowered.endswith((".json", ".yaml", ".yml")):
            data = json.loads(text) if lowered.endswith(".json") else yaml.safe_load(text)
            for index, candidate in enumerate(_team_strings(data), start=1):
                sets = parse_paste(candidate) if " @ " in candidate or "Ability:" in candidate else parse_packed(candidate)
                if sets:
                    yield f"{path.stem} {index}" if index > 1 else path.stem, sets, candidate
            return
        sets = parse_paste(text) if "Ability:" in text or "\n- " in text else parse_packed(text)
        if sets:
            yield path.stem.replace(".paste", "").replace(".packed", ""), sets, text

    def _infer_format(self, path: Path, source: TeamSourceSpec) -> str:
        lowered = path.as_posix().lower()
        if source.adapter == "pokemon-vgc-ai":
            return "champions-ranked-doubles"
        if source.adapter == "vgc-bench":
            # VGC-Bench currently stores Champions teams under reg_ma/reg_mb.  Keep
            # the current playable pool aligned with our Format Pack while preserving
            # older/unknown regulations as research-only classifications.
            if re.search(r"(?:^|/)reg[_ -]?mb(?:/|$)", lowered):
                return "champions-ranked-doubles"
            if re.search(r"(?:^|/)reg[_ -]?ma(?:/|$)", lowered):
                return "vgc-reg-ma"
            match = re.search(r"reg(?:ulation)?[_ -]?([a-z0-9]+)", lowered)
            return f"vgc-reg-{match.group(1)}" if match else "vgc-unclassified"
        if "champions" in lowered or "reg-mb" in lowered or "regmb" in lowered:
            return "champions-ranked-doubles"
        if "vgc" in lowered or "reg" in lowered:
            return "vgc-unclassified"
        return "unclassified"

    def _validate(self, record: TeamRecord) -> None:
        agents_path = self.project_root / "config" / "agents.yaml"
        try:
            from .config import load_agents_config

            agents = load_agents_config(agents_path)
            format_name = agents.format_by_id(record.format_id).showdown_format
        except (FileNotFoundError, KeyError, ValueError):
            record.validation_status = "unclassified"
            return
        cli = self.project_root / "vendor" / "pokemon-showdown" / "pokemon-showdown"
        if not cli.exists() or not (self.project_root / "vendor" / "pokemon-showdown" / "data" / "tags.ts").exists():
            record.validation_status = "prevalidated"
            return
        result = subprocess.run(
            ["node", str(cli), "validate-team", format_name],
            input=record.packed,
            text=True,
            capture_output=True,
            cwd=cli.parent,
            timeout=30,
            check=False,
        )
        if result.returncode == 0:
            record.validation_status = "valid"
        else:
            record.validation_status = "invalid-showdown"
            record.validation_errors = [line for line in result.stderr.splitlines() if line.strip()][-20:]

    def _write(self, records: list[TeamRecord]) -> None:
        self.config.library_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "team_count": len(records),
            "teams": [asdict(record) for record in records],
        }
        (self.config.library_dir / "index.json").write_text(
            json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        usable_records = [record for record in records if not record.validation_status.startswith("invalid")]
        public = {
            "teamCount": len(usable_records),
            "totalTeamCount": len(records),
            "teams": [record.public_dict() for record in usable_records],
        }
        public_path = self.project_root / "var" / "generated" / "public" / "pokemonai-teams.json"
        public_path.parent.mkdir(parents=True, exist_ok=True)
        public_path.write_text(json.dumps(public, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _team_strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        if "|" in value or "Ability:" in value or "\n- " in value:
            yield value
        return
    if isinstance(value, list):
        if value and all(isinstance(item, dict) and ("species" in item or "name" in item) for item in value):
            sets = []
            for item in value:
                sets.append(
                    TeamSet(
                        name=str(item.get("name") or item.get("species") or ""),
                        species=str(item.get("species") or item.get("name") or ""),
                        item=str(item.get("item") or ""),
                        ability=str(item.get("ability") or ""),
                        moves=tuple(str(move) for move in (item.get("moves") or [])),
                        nature=str(item.get("nature") or ""),
                        evs={str(k): int(v) for k, v in (item.get("evs") or {}).items()},
                        ivs={str(k): int(v) for k, v in (item.get("ivs") or {}).items()},
                        level=int(item.get("level") or 100),
                        tera_type=str(item.get("teraType") or item.get("tera_type") or ""),
                    )
                )
            yield export_paste(sets)
        else:
            for item in value:
                yield from _team_strings(item)
        return
    if isinstance(value, dict):
        for key in ("paste", "packed", "team", "teams", "data", "sets"):
            if key in value:
                yield from _team_strings(value[key])


class TeamPool:
    """Loads packed teams by pool for use by runtime players."""

    def __init__(self, index_path: str | Path, pool: str, *, seed: int | str | None = None) -> None:
        data = json.loads(Path(index_path).read_text(encoding="utf-8"))
        self.teams = [
            item["packed"]
            for item in data.get("teams", [])
            if item.get("pool") == pool
            and not str(item.get("validation_status", "")).startswith("invalid")
            and item.get("packed")
        ]
        if not self.teams:
            raise ValueError(f"No usable teams are available in pool {pool!r}")
        random.Random(seed).shuffle(self.teams)
        self._index = 0

    def next(self) -> str:
        value = self.teams[self._index % len(self.teams)]
        self._index += 1
        return value

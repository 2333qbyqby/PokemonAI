from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict
import json
import os
from pathlib import Path
import shutil
import threading
import uuid
from typing import Any, Callable

from pokemonai_core.runtime import atomic_json, utc_now
from pokemonai_core.team_library import to_id

from .adapters import (
    MUNCHSTATS_ATTRIBUTION,
    MUNCHSTATS_URL,
    MunchStatsAdapter,
    validate_snapshot,
)
from .models import FORMAT_IDS, ImportResult


AdapterFactory = Callable[[], MunchStatsAdapter]


class MetaManager:
    def __init__(
        self,
        project_root: str | Path,
        *,
        adapter_factory: AdapterFactory | None = None,
    ) -> None:
        self.project_root = Path(project_root).resolve()
        self.root = self.project_root / "var" / "meta"
        self.imports = self.root / "imports"
        self.current = self.root / "current.json"
        self.previous = self.root / "previous.json"
        self._adapter_factory = adapter_factory or (lambda: MunchStatsAdapter(self.project_root))
        self._lock = threading.RLock()
        self._active_import_id: str | None = None
        self._clean_legacy_layout()
        self.imports.mkdir(parents=True, exist_ok=True)
        current_snapshot = self._read_snapshot(self.current)
        if current_snapshot is not None:
            self._write_catalog_export(current_snapshot)

    def status(self) -> dict[str, Any]:
        current = self._read_snapshot(self.current)
        previous = self._read_snapshot(self.previous)
        return {
            "source": {
                "id": "munchstats",
                "label": MUNCHSTATS_ATTRIBUTION,
                "url": MUNCHSTATS_URL,
            },
            "current": self._snapshot_summary(current),
            "previous": self._snapshot_summary(previous),
            "canRollback": previous is not None,
        }

    def create_import(self) -> ImportResult:
        identifier = self._prepare_import()
        return self._run_import(identifier)

    def start_import(self) -> ImportResult:
        with self._lock:
            if self._active_import_id:
                raise ValueError("An environment data update is already running")
            identifier = self._prepare_import()
            self._active_import_id = identifier
        thread = threading.Thread(
            target=self._run_import,
            args=(identifier,),
            name=f"meta-import-{identifier[:8]}",
            daemon=True,
        )
        thread.start()
        return ImportResult(identifier, "running")

    def _prepare_import(self) -> str:
        identifier = uuid.uuid4().hex
        directory = self.imports / identifier
        directory.mkdir(parents=True, exist_ok=False)
        atomic_json(directory / "manifest.json", asdict(ImportResult(identifier, "running")))
        return identifier

    def _run_import(self, identifier: str) -> ImportResult:
        directory = self.imports / identifier
        manifest_path = directory / "manifest.json"
        staging = directory / "snapshot.json"
        changed_formats: tuple[str, ...] = ()
        source_updated_at: dict[str, str] = {}
        team_source_updated_at: dict[str, str] = {}
        warnings: list[str] = []

        def update_progress(format_id: str, current: int, total: int) -> None:
            if current != total and current % 5:
                return
            result = ImportResult(
                identifier,
                "running",
                changed_formats,
                source_updated_at,
                progress={"formatId": format_id, "current": current, "total": total},
                warnings=tuple(warnings),
            )
            atomic_json(manifest_path, asdict(result))

        try:
            adapter = self._adapter_factory()
            probes = adapter.probe_all()
            source_updated_at = {
                format_id: probes[format_id].source_updated_at
                for format_id in FORMAT_IDS
            }
            team_source_updated_at = {
                format_id: probes[format_id].team_source_updated_at
                for format_id in FORMAT_IDS
            }
            current_snapshot = self._read_snapshot(self.current)
            changed: list[str] = []
            profile_changes: set[str] = set()
            team_changes: set[str] = set()
            for format_id in FORMAT_IDS:
                remote = source_updated_at[format_id]
                remote_team = team_source_updated_at[format_id]
                local_format = current_snapshot["formats"].get(format_id, {}) if current_snapshot else {}
                local = str(local_format.get("sourceUpdatedAt") or "")
                local_team = str(local_format.get("teamSourceUpdatedAt") or "")
                if not local or remote > local or not isinstance(local_format.get("speciesProfiles"), dict):
                    profile_changes.add(format_id)
                elif remote < local:
                    warnings.append(
                        f"{format_id}: MunchStats date {remote} is older than current data {local}; current data was kept"
                    )
                if not local_team or remote_team > local_team or not isinstance(local_format.get("teams"), list):
                    team_changes.add(format_id)
                elif remote_team < local_team:
                    warnings.append(
                        f"{format_id}: MunchStats team date {remote_team} is older than current data {local_team}; current teams were kept"
                    )
                if format_id in profile_changes or format_id in team_changes:
                    changed.append(format_id)
            changed_formats = tuple(changed)
            counts = self._profile_counts(current_snapshot)
            team_counts = self._team_counts(current_snapshot)
            playable_team_counts = self._playable_team_counts(current_snapshot)
            if not changed_formats:
                result = ImportResult(
                    identifier,
                    "up_to_date",
                    source_updated_at=source_updated_at,
                    counts=counts,
                    team_counts=team_counts,
                    playable_team_counts=playable_team_counts,
                    warnings=tuple(warnings),
                )
                atomic_json(manifest_path, asdict(result))
                with self._lock:
                    if self._active_import_id == identifier:
                        self._active_import_id = None
                return result

            snapshot = deepcopy(current_snapshot) if current_snapshot else {
                "schema": "pokemonai-meta",
                "source": "munchstats",
                "attribution": MUNCHSTATS_ATTRIBUTION,
                "sourceUrl": MUNCHSTATS_URL,
                "formats": {},
            }
            snapshot["fetchedAt"] = utc_now()
            snapshot["publishedAt"] = None
            for format_id in changed_formats:
                format_meta = deepcopy(snapshot["formats"].get(format_id, {}))
                if format_id in profile_changes:
                    profile_meta, format_warnings = adapter.fetch_format(probes[format_id], update_progress)
                    format_meta.update(profile_meta)
                    warnings.extend(format_warnings)
                if format_id in team_changes:
                    teams, team_warnings = adapter.fetch_teams(probes[format_id], update_progress)
                    format_meta["teams"] = teams
                    format_meta["teamSourceUpdatedAt"] = probes[format_id].team_source_updated_at
                    warnings.extend(team_warnings)
                snapshot["formats"][format_id] = format_meta
            validate_snapshot(snapshot)
            atomic_json(staging, snapshot)
            counts = self._profile_counts(snapshot)
            team_counts = self._team_counts(snapshot)
            playable_team_counts = self._playable_team_counts(snapshot)
            final_dates = {
                format_id: str(snapshot["formats"][format_id]["sourceUpdatedAt"])
                for format_id in FORMAT_IDS
            }
            result = ImportResult(
                identifier,
                "ready",
                changed_formats,
                final_dates,
                counts,
                team_counts,
                playable_team_counts,
                warnings=tuple(warnings),
            )
        except Exception as error:
            result = ImportResult(
                identifier,
                "failed",
                changed_formats,
                source_updated_at,
                warnings=tuple(warnings),
                error=str(error),
            )
        atomic_json(manifest_path, asdict(result))
        with self._lock:
            if self._active_import_id == identifier:
                self._active_import_id = None
        return result

    def get_import(self, identifier: str) -> dict[str, Any] | None:
        if not identifier.isalnum():
            return None
        try:
            value = json.loads((self.imports / identifier / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return value if isinstance(value, dict) else None

    def publish(self, identifier: str) -> dict[str, Any]:
        with self._lock:
            value = self.get_import(identifier)
            if not value or value.get("state") != "ready":
                raise ValueError("Only a ready environment data update can be published")
            staging = self.imports / identifier / "snapshot.json"
            snapshot = self._read_snapshot(staging)
            if snapshot is None:
                raise ValueError("Staged environment data is invalid")
            snapshot["publishedAt"] = utc_now()
            if self.current.is_file():
                previous_temp = self.previous.with_suffix(".json.next")
                shutil.copy2(self.current, previous_temp)
                os.replace(previous_temp, self.previous)
            atomic_json(self.current, snapshot)
            self._write_catalog_export(snapshot)
            self._retain_recent_imports(2)
            return self.status()

    def rollback(self) -> dict[str, Any]:
        with self._lock:
            current = self._read_snapshot(self.current)
            previous = self._read_snapshot(self.previous)
            if previous is None:
                raise ValueError("No previous environment data is available")
            previous["publishedAt"] = utc_now()
            current_temp = self.root / "rollback-current.json"
            previous_temp = self.root / "rollback-previous.json"
            atomic_json(current_temp, previous)
            if current is not None:
                atomic_json(previous_temp, current)
            os.replace(current_temp, self.current)
            if current is not None:
                os.replace(previous_temp, self.previous)
            elif self.previous.is_file():
                self.previous.unlink()
            self._write_catalog_export(previous)
            return self.status()

    def _read_snapshot(self, path: Path) -> dict[str, Any] | None:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return validate_snapshot(value)
        except (OSError, ValueError, TypeError):
            return None

    def _snapshot_summary(self, snapshot: dict[str, Any] | None) -> dict[str, Any] | None:
        if snapshot is None:
            return None
        return {
            "fetchedAt": snapshot.get("fetchedAt"),
            "publishedAt": snapshot.get("publishedAt"),
            "formats": {
                format_id: {
                    "sourceUpdatedAt": snapshot["formats"][format_id]["sourceUpdatedAt"],
                    "speciesCount": len(snapshot["formats"][format_id]["speciesProfiles"]),
                    "teamSourceUpdatedAt": snapshot["formats"][format_id].get("teamSourceUpdatedAt"),
                    "teamCount": len(snapshot["formats"][format_id].get("teams", [])),
                    "playableTeamCount": sum(
                        1 for team in snapshot["formats"][format_id].get("teams", [])
                        if team.get("packedTeam") and team.get("validationStatus") in {"valid", "prevalidated"}
                    ),
                }
                for format_id in FORMAT_IDS
            },
        }

    def _profile_counts(self, snapshot: dict[str, Any] | None) -> dict[str, int]:
        if snapshot is None:
            return {}
        return {
            format_id: len(snapshot["formats"][format_id]["speciesProfiles"])
            for format_id in FORMAT_IDS
        }

    def _team_counts(self, snapshot: dict[str, Any] | None) -> dict[str, int]:
        if snapshot is None:
            return {}
        return {
            format_id: len(snapshot["formats"][format_id].get("teams", []))
            for format_id in FORMAT_IDS
        }

    def _playable_team_counts(self, snapshot: dict[str, Any] | None) -> dict[str, int]:
        if snapshot is None:
            return {}
        return {
            format_id: sum(
                1 for team in snapshot["formats"][format_id].get("teams", [])
                if team.get("packedTeam") and team.get("validationStatus") in {"valid", "prevalidated"}
            )
            for format_id in FORMAT_IDS
        }

    def player_teams(self, format_id: str | None = None) -> dict[str, Any]:
        if format_id and format_id not in FORMAT_IDS:
            raise ValueError("Unsupported format")
        snapshot = self._read_snapshot(self.current)
        teams: list[dict[str, Any]] = []
        if snapshot:
            selected_formats = (format_id,) if format_id else FORMAT_IDS
            for selected_format in selected_formats:
                for team in snapshot["formats"][selected_format].get("teams", []):
                    if not team.get("packedTeam") or team.get("validationStatus") not in {"valid", "prevalidated"}:
                        continue
                    teams.append({
                        "id": team["id"],
                        "name": team["name"],
                        "format_id": selected_format,
                        "source_label": team.get("sourceLabel", "MunchStats"),
                        "source_repository": team.get("sourceUrl"),
                        "tags": ["MunchStats"],
                        "archetype": team.get("event") or "环境阵容",
                        "paste": team.get("paste", ""),
                        "packed": team["packedTeam"],
                        "roster": [
                            {"species": to_id(species), "species_name": species}
                            for species in team.get("roster", [])
                        ],
                        "validation_status": team["validationStatus"],
                    })
        return {"source": "munchstats", "teamCount": len(teams), "teams": teams}

    def team_catalog(
        self,
        *,
        format_id: str | None = None,
        completeness: str = "all",
        query: str = "",
        sort: str = "recommended",
        cursor: str | None = None,
        limit: int = 30,
    ) -> dict[str, Any]:
        if format_id and format_id not in FORMAT_IDS:
            raise ValueError("Unsupported format")
        if completeness not in {"all", "full-set", "roster-only"}:
            raise ValueError("Unsupported completeness filter")
        if sort not in {"recommended", "updated", "battles"}:
            raise ValueError("Unsupported catalog sort")
        if limit < 1 or limit > 60:
            raise ValueError("Catalog limit must be between 1 and 60")
        try:
            offset = int(cursor or "0")
        except ValueError as error:
            raise ValueError("Invalid catalog cursor") from error
        if offset < 0:
            raise ValueError("Invalid catalog cursor")

        snapshot = self._read_snapshot(self.current)
        summaries: list[dict[str, Any]] = []
        if snapshot:
            selected_formats = (format_id,) if format_id else FORMAT_IDS
            for selected_format in selected_formats:
                for team in snapshot["formats"][selected_format].get("teams", []):
                    summary = self._catalog_summary(team, selected_format)
                    if completeness != "all" and summary["completeness"] != completeness:
                        continue
                    summaries.append(summary)

        normalized_query = query.strip().casefold()
        if normalized_query:
            summaries = [
                team for team in summaries
                if normalized_query in " ".join((
                    team["name"],
                    team.get("player") or "",
                    team.get("event") or "",
                    *(member["displayName"] for member in team["roster"]),
                )).casefold()
            ]

        summaries.sort(key=lambda team: team["name"].casefold())
        if sort in {"recommended", "updated"}:
            summaries.sort(key=lambda team: team["observedAt"], reverse=True)
        if sort in {"recommended", "battles"}:
            summaries.sort(key=lambda team: team.get("usage", {}).get("battles", 0), reverse=True)
        if sort == "recommended":
            summaries.sort(key=lambda team: 0 if team["completeness"] == "full-set" else 1)

        total = len(summaries)
        page = summaries[offset:offset + limit]
        next_offset = offset + len(page)
        return {
            "schema": "pokemonai-team-catalog",
            "source": "munchstats",
            "publishedAt": snapshot.get("publishedAt") if snapshot else None,
            "total": total,
            "nextCursor": str(next_offset) if next_offset < total else None,
            "teams": page,
        }

    def team_catalog_detail(self, team_id: str) -> dict[str, Any] | None:
        snapshot = self._read_snapshot(self.current)
        if snapshot is None:
            return None
        for format_id in FORMAT_IDS:
            for team in snapshot["formats"][format_id].get("teams", []):
                if team.get("id") == team_id:
                    return self._catalog_detail(team, format_id)
        return None

    def catalog_export(self) -> dict[str, Any]:
        snapshot = self._read_snapshot(self.current)
        if snapshot is None:
            return {
                "schema": "pokemonai-team-catalog",
                "source": "munchstats",
                "publishedAt": None,
                "formats": {},
                "teams": [],
            }
        return self._catalog_export(snapshot)

    def _catalog_summary(self, team: dict[str, Any], format_id: str) -> dict[str, Any]:
        completeness = "full-set" if team.get("completeness") == "full-set" else "roster-only"
        validation = str(team.get("validationStatus") or "roster-only")
        if validation not in {"valid", "prevalidated", "roster-only"}:
            validation = "invalid"
        result: dict[str, Any] = {
            "id": str(team.get("id") or ""),
            "formatId": format_id,
            "name": str(team.get("name") or "MunchStats team"),
            "roster": [
                {"species": to_id(species), "displayName": str(species)}
                for species in team.get("roster", [])
            ],
            "completeness": completeness,
            "validationStatus": validation,
            "observedAt": str(team.get("observedAt") or ""),
            "sourceLabel": str(team.get("sourceLabel") or MUNCHSTATS_ATTRIBUTION),
        }
        for source_key, public_key in (("player", "player"), ("event", "event"), ("placing", "placing")):
            value = str(team.get(source_key) or "").strip()
            if value:
                result[public_key] = value
        usage = team.get("usage")
        if isinstance(usage, dict):
            result["usage"] = {
                "battles": max(0, int(usage.get("battles") or 0)),
                "wins": max(0, int(usage.get("wins") or 0)),
                "losses": max(0, int(usage.get("losses") or 0)),
                "winRate": min(1.0, max(0.0, float(usage.get("winRate") or 0))),
                "avgRating": max(0, int(usage.get("avgRating") or 0)),
                "maxRating": max(0, int(usage.get("maxRating") or 0)),
            }
        return result

    def _catalog_detail(self, team: dict[str, Any], format_id: str) -> dict[str, Any]:
        result = self._catalog_summary(team, format_id)
        result["sets"] = deepcopy(team.get("sets", [])) if isinstance(team.get("sets"), list) else []
        if result["completeness"] == "full-set" and result["validationStatus"] in {"valid", "prevalidated"}:
            packed = str(team.get("packedTeam") or "")
            if packed:
                result["packedTeam"] = packed
            paste = str(team.get("paste") or "")
            if paste:
                result["paste"] = paste
        source_url = str(team.get("sourceUrl") or "")
        if source_url:
            result["sourceUrl"] = source_url
        return result

    def _catalog_export(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        teams: list[dict[str, Any]] = []
        for format_id in FORMAT_IDS:
            teams.extend(
                self._catalog_detail(team, format_id)
                for team in snapshot["formats"][format_id].get("teams", [])
            )
        return {
            "schema": "pokemonai-team-catalog",
            "source": "munchstats",
            "publishedAt": snapshot.get("publishedAt"),
            "formats": {
                format_id: {
                    "sourceUpdatedAt": snapshot["formats"][format_id].get("sourceUpdatedAt"),
                    "teamSourceUpdatedAt": snapshot["formats"][format_id].get("teamSourceUpdatedAt"),
                }
                for format_id in FORMAT_IDS
            },
            "teams": teams,
        }

    def _write_catalog_export(self, snapshot: dict[str, Any]) -> None:
        target = self.project_root / "var" / "generated" / "public" / "pokemonai-team-catalog.json"
        atomic_json(target, self._catalog_export(snapshot))

    def _clean_legacy_layout(self) -> None:
        pointer = self.root / "current-pointer.json"
        snapshots = self.root / "snapshots"
        http_cache = self.root / "http-cache"
        legacy_databases = tuple(
            path
            for pattern in ("*.db", "*.db-*", "*.sqlite", "*.sqlite-*", "*.sqlite3", "*.sqlite3-*")
            for path in self.root.glob(pattern)
        )
        legacy = pointer.exists() or snapshots.exists() or http_cache.exists() or bool(legacy_databases)
        if self.current.is_file():
            try:
                value = json.loads(self.current.read_text(encoding="utf-8"))
                legacy = legacy or value.get("schema") != "pokemonai-meta"
            except (OSError, ValueError, AttributeError):
                legacy = True
        if not legacy:
            return
        for path in (pointer, self.current, self.previous):
            path.unlink(missing_ok=True)
        for path in legacy_databases:
            path.unlink(missing_ok=True)
        for path in (snapshots, http_cache, self.imports):
            shutil.rmtree(path, ignore_errors=True)

    def _retain_recent_imports(self, count: int) -> None:
        matches: list[tuple[int, Path]] = []
        for directory in self.imports.glob("*"):
            try:
                value = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if value.get("state") in {"ready", "up_to_date"}:
                matches.append((directory.stat().st_mtime_ns, directory))
        for _, directory in sorted(matches, reverse=True)[count:]:
            shutil.rmtree(directory, ignore_errors=True)

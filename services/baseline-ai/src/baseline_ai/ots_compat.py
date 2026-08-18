"""Small, dependency-free helpers for poke-env 0.15 Open Team Sheets compatibility."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True)
class OTSBatch:
    room_id: str
    request_positions: tuple[int, ...]
    plain_rejection_positions: tuple[int, ...]
    error_rejection_positions: tuple[int, ...]

    @property
    def saw_request(self) -> bool:
        return bool(self.request_positions)

    @property
    def saw_rejection(self) -> bool:
        return bool(self.plain_rejection_positions or self.error_rejection_positions)

    @property
    def saw_error_rejection(self) -> bool:
        return bool(self.error_rejection_positions)

    @property
    def rejection_preceded_request(self) -> bool:
        rejection_positions = self.plain_rejection_positions + self.error_rejection_positions
        return bool(
            self.request_positions
            and rejection_positions
            and min(rejection_positions) < max(self.request_positions)
        )

    @property
    def plain_rejection_followed_request(self) -> bool:
        return bool(
            self.request_positions
            and self.plain_rejection_positions
            and min(self.request_positions) < max(self.plain_rejection_positions)
        )


def inspect_ots_batch(split_messages: Sequence[Sequence[str]]) -> OTSBatch:
    """Describe request/rejection ordering in one parsed Showdown websocket batch."""

    marker = split_messages[0][0] if split_messages and split_messages[0] else ""
    room_id = marker[1:] if marker.startswith(">") else marker
    requests: list[int] = []
    plain: list[int] = []
    errors: list[int] = []
    for position, message in enumerate(split_messages[1:], start=1):
        if not message:
            continue
        if len(message) > 1 and message[1] == "request":
            requests.append(position)
        joined = "|".join(message).lower()
        if "rejected open team sheets." not in joined:
            continue
        if len(message) > 1 and message[1] == "error":
            errors.append(position)
        else:
            plain.append(position)
    return OTSBatch(room_id, tuple(requests), tuple(plain), tuple(errors))

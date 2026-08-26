from __future__ import annotations

import json
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


class SafeHttpClient:
    def __init__(
        self,
        *,
        allowed_hosts: frozenset[str],
        max_bytes: int = 750_000,
        timeout: float = 20.0,
    ) -> None:
        self.allowed_hosts = allowed_hosts
        self.max_bytes = max_bytes
        self.timeout = timeout

    def get_json(self, url: str) -> Any:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in self.allowed_hosts:
            raise ValueError("Remote URL is outside the configured HTTPS allowlist")

        headers = {
            "Accept": "application/json",
            "User-Agent": "PokemonAI personal-learning meta importer",
        }
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                request = Request(url, headers=headers)
                with urlopen(request, timeout=self.timeout) as response:  # noqa: S310 - URL validated above
                    length = int(response.headers.get("Content-Length") or 0)
                    if length > self.max_bytes:
                        raise ValueError(f"Remote response exceeds {self.max_bytes} bytes")
                    payload = response.read(self.max_bytes + 1)
                    if len(payload) > self.max_bytes:
                        raise ValueError(f"Remote response exceeds {self.max_bytes} bytes")
                return json.loads(payload.decode("utf-8-sig"))
            except json.JSONDecodeError as error:
                raise ValueError("MunchStats returned invalid JSON") from error
            except HTTPError as error:
                last_error = error
                if error.code not in {429, 500, 502, 503, 504}:
                    break
                retry_after = error.headers.get("Retry-After") if error.headers else None
                try:
                    delay = min(10.0, max(0.0, float(retry_after)))
                except (TypeError, ValueError):
                    delay = 0.5 * (2**attempt)
                time.sleep(delay)
            except (TimeoutError, URLError) as error:
                last_error = error
                time.sleep(0.5 * (2**attempt))
        raise RuntimeError(f"MunchStats request failed: {last_error}")

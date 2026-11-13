from __future__ import annotations

import os
import stat
import time
from typing import Any

import grpc
import pytest

from waymo_mcp import client as client_module
from waymo_mcp.auth import Credentials
from waymo_mcp.client import DEFAULT_HOME, WaymoClient
from waymo_mcp.wire import Place, lat_lng, message, string

HOME = (25.7793, -80.1919)
FAR = (37.5, -122.2)


def place(name: str, lat: float, lng: float) -> Place:
    raw = message(1, lat_lng(lat, lng)) + message(8, string(1, name))
    return Place(name, f"{name} address", lat, lng, None, raw)


def make_client(**credential_fields: Any) -> WaymoClient:
    return WaymoClient(Credentials("refresh-1", **credential_fields))


def test_home_comes_from_credentials_or_default() -> None:
    assert make_client().home == DEFAULT_HOME
    assert make_client(home_latitude=HOME[0], home_longitude=HOME[1]).home == HOME


def test_token_cache_survives_restart_and_is_private(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logins: list[str] = []

    def fake_authenticate(credentials: Credentials) -> dict[str, Any]:
        logins.append(credentials.refresh_token)
        return {"chauffeur_token": "token-a", "expires_at": int(time.time()) + 3600}

    monkeypatch.setattr(client_module, "authenticate", fake_authenticate)
    cache = tmp_path / "token_cache.json"

    first = WaymoClient(Credentials("refresh-1"), token_cache=cache)
    first._metadata()
    first._metadata()
    assert logins == ["refresh-1"]
    assert stat.S_IMODE(os.stat(cache).st_mode) == 0o600

    restarted = WaymoClient(Credentials("refresh-1"), token_cache=cache)
    assert dict(restarted._metadata())["authorization"] == "Bearer token-a"
    assert logins == ["refresh-1"]

    other_account = WaymoClient(Credentials("refresh-2"), token_cache=cache)
    other_account._metadata()
    assert logins == ["refresh-1", "refresh-2"]


class Unauthenticated(grpc.RpcError):
    def code(self) -> grpc.StatusCode:
        return grpc.StatusCode.UNAUTHENTICATED

    def details(self) -> str:
        return "token rejected"


def test_rejected_login_is_refreshed_once(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tokens = iter(["stale", "fresh"])
    monkeypatch.setattr(
        client_module,
        "authenticate",
        lambda _credentials: {
            "chauffeur_token": next(tokens),
            "expires_at": int(time.time()) + 3600,
        },
    )
    waymo = WaymoClient(Credentials("refresh-1"), token_cache=tmp_path / "t.json")
    seen: list[str] = []

    def send(metadata: tuple[tuple[str, str], ...]) -> bytes:
        seen.append(dict(metadata)["authorization"])
        if len(seen) == 1:
            raise Unauthenticated()
        return b"ok"

    assert waymo._invoke("history", send) == b"ok"
    assert seen == ["Bearer stale", "Bearer fresh"]


def stub_quote(
    monkeypatch: pytest.MonkeyPatch,
    waymo: WaymoClient,
    results: dict[str, Place],
) -> list[tuple[str, float, float]]:
    searches: list[tuple[str, float, float]] = []

    def search_places(query: str, *, bias_lat: float, bias_lng: float, **_: Any):
        searches.append((query, bias_lat, bias_lng))
        return [results[query]]

    monkeypatch.setattr(waymo, "search_places", search_places)
    monkeypatch.setattr(
        waymo,
        "_status_snapshot",
        lambda: ({"active_trip": None, "stale_trip": None}, None),
    )
    monkeypatch.setattr(waymo, "_unary", lambda *_args, **_kwargs: b"")
    monkeypatch.setattr(
        client_module,
        "parse_quote",
        lambda _raw: {
            "proposal_token": "p",
            "estimated_fare": "$7.06",
            "scheduled_options": [],
        },
    )
    return searches


def test_quote_near_home_searches_everything_once_in_parallel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    waymo = make_client(home_latitude=HOME[0], home_longitude=HOME[1])
    searches = stub_quote(
        monkeypatch,
        waymo,
        {
            "Home": place("Home", *HOME),
            "Stop": place("Stop", 25.78, -80.20),
            "Brickell": place("Brickell", 25.767, -80.193),
        },
    )
    quote = waymo.quote("Home", "Brickell", intermediate_stop_queries=["Stop"])
    assert sorted(query for query, _, _ in searches) == ["Brickell", "Home", "Stop"]
    assert all((lat, lng) == HOME for _, lat, lng in searches)
    assert [stop["name"] for stop in quote["intermediate_stops"]] == ["Stop"]
    assert quote["dropoff"]["name"] == "Brickell"


def test_quote_far_from_home_falls_back_to_chained_lookups(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    waymo = make_client(home_latitude=HOME[0], home_longitude=HOME[1])
    pickup = place("SFO", *FAR)
    searches = stub_quote(
        monkeypatch,
        waymo,
        {"SFO": pickup, "Oracle": place("Oracle", 37.77, -122.39)},
    )
    quote = waymo.quote("SFO", "Oracle")
    assert searches[-1] == ("Oracle", pickup.latitude, pickup.longitude)
    assert quote["dropoff"]["name"] == "Oracle"


def test_quote_uses_caller_search_area_when_traveling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    waymo = make_client(home_latitude=HOME[0], home_longitude=HOME[1])
    searches = stub_quote(
        monkeypatch,
        waymo,
        {"SFO": place("SFO", *FAR), "Oracle": place("Oracle", 37.77, -122.39)},
    )
    waymo.quote("SFO", "Oracle", bias_lat=FAR[0], bias_lng=FAR[1])
    assert len(searches) == 2
    assert all((lat, lng) == FAR for _, lat, lng in searches)

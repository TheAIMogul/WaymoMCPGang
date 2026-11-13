"""Client for the private Waymo rider API."""

from __future__ import annotations

import base64
import dataclasses
import hashlib
import json
import math
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import grpc

from .auth import (
    DEFAULT_DEVICE_ID,
    Credentials,
    USER_AGENT,
    authenticate,
    load_credentials,
)
from .wire import (
    Place,
    bytes_fields,
    cancel_trip_request,
    create_trip_request,
    decode,
    parse_cancellation_fee,
    parse_places,
    parse_quote,
    place_search_request,
    propose_trip_request,
    text,
)

HOST = "cartrip-pa.googleapis.com:443"
SERVICE = "/car.taas.client.v2alpha.ClientTripService"
DEFAULT_CREDENTIALS = "~/.config/waymo/credentials.json"
# Place-search center when neither the call nor the credentials name one.
# Override with home_latitude/home_longitude in the credentials file or the
# WAYMO_HOME_LAT/WAYMO_HOME_LNG environment variables.
DEFAULT_HOME = (25.7617, -80.1918)
# Quote lookups run in parallel around the search center. When the previous
# resolved place is farther than this from it, the next lookup is redone
# around that place instead, matching the original chained behavior.
NEARBY_KM = 25.0
TOKEN_CACHE_NAME = "token_cache.json"
RPC = {
    "history": f"{SERVICE}/GetTransactionHistory",
    "status": f"{SERVICE}/GetActiveTrip",
    "places": f"{SERVICE}/GetPlaceCompletions",
    "payments": f"{SERVICE}/ListPaymentMethods",
    "quote": f"{SERVICE}/ProposeTripPlan",
    "book": f"{SERVICE}/CreateTrip",
    "propose_cancel": f"{SERVICE}/ProposeTripCancellation",
    "cancel_fee_ux": f"{SERVICE}/GetCancellationFeeUx",
    "cancel": f"{SERVICE}/CancelActiveTrip",
}

TRIP_STATES = {
    0: "STATE_UNSPECIFIED",
    10: "REQUESTED",
    20: "INFEASIBLE",
    25: "QUEUED",
    30: "TO_PICKUP",
    35: "PICKUP_MOVE_ALONG",
    41: "AT_PICKUP",
    45: "NO_SHOW",
    60: "BOARDING",
    70: "RIDING",
    80: "STOP_DROPOFF",
    90: "FINAL_DROPOFF",
    91: "AT_STOP_ARRIVED",
    92: "AT_STOP_WAITING",
    93: "AT_STOP_READY",
    94: "AT_STOP_VEHICLE_NEARBY",
    95: "AT_STOP_SUSPENDED",
    105: "STRANDED",
    110: "COMPLETED",
    120: "CANCELLED",
}
VEHICLE_TYPES = {
    0: "VEHICLE_TYPE_UNSPECIFIED",
    2: "V5",
    3: "LIBERTY",
    5: "WAV",
    6: "AUX",
    7: "W12",
    8: "APOLLO",
}
ARRIVAL_STATES = {
    0: "WRA_STATE_UNSPECIFIED",
    1: "DISPATCHED",
    2: "ARRIVED",
    3: "CONTINUING_IN_MANUAL",
    4: "CANCELLED",
    5: "INTERRUPTED",
}


class WaymoError(RuntimeError):
    def __init__(self, operation: str, code: str, detail: str):
        super().__init__(f"{operation}: {code}: {detail}")
        self.operation = operation
        self.code = code
        self.detail = detail


class WaymoClient:
    def __init__(
        self,
        credentials: Credentials,
        token_cache: str | Path | None = None,
    ):
        self.credentials = credentials
        if credentials.home_latitude is not None and credentials.home_longitude is not None:
            self.home = (credentials.home_latitude, credentials.home_longitude)
        else:
            self.home = DEFAULT_HOME
        self._token_cache = Path(token_cache).expanduser() if token_cache else None
        self._auth: dict[str, Any] = {}
        self._auth_lock = threading.Lock()
        self._channel = grpc.secure_channel(
            HOST,
            grpc.ssl_channel_credentials(),
            options=(("grpc.max_metadata_size", 64 * 1024),),
        )
        # One status call, one pickup, up to three stops and one dropoff.
        self._pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="waymo")
        self._payments_cache: tuple[float, list[dict[str, Any]]] | None = None

    @classmethod
    def from_environment(cls) -> WaymoClient:
        refresh_token = os.environ.get("WAYMO_REFRESH_TOKEN")
        if refresh_token:
            credentials = Credentials(
                refresh_token,
                os.environ.get("WAYMO_DEVICE_ID", DEFAULT_DEVICE_ID),
                os.environ.get("WAYMO_ACCOUNT_NAME", ""),
            )
            cache_dir = Path(DEFAULT_CREDENTIALS).expanduser().parent
        else:
            path = os.environ.get("WAYMO_CREDENTIALS_FILE", DEFAULT_CREDENTIALS)
            credentials = load_credentials(path)
            cache_dir = Path(path).expanduser().parent
        home_lat = _env_float("WAYMO_HOME_LAT")
        home_lng = _env_float("WAYMO_HOME_LNG")
        if home_lat is not None and home_lng is not None:
            credentials = dataclasses.replace(
                credentials,
                home_latitude=home_lat,
                home_longitude=home_lng,
            )
        cache_setting = os.environ.get("WAYMO_TOKEN_CACHE", "")
        if cache_setting.lower() in {"off", "0", "false", "none"}:
            token_cache = None
        else:
            token_cache = Path(cache_setting) if cache_setting else cache_dir / TOKEN_CACHE_NAME
        return cls(credentials, token_cache=token_cache)

    def _metadata(self) -> tuple[tuple[str, str], ...]:
        with self._auth_lock:
            if not _fresh(self._auth):
                cached = self._read_token_cache()
                if _fresh(cached):
                    self._auth = cached
                else:
                    self._auth = authenticate(self.credentials)
                    self._write_token_cache(self._auth)
            token = self._auth["chauffeur_token"]
        return (
            ("authorization", f"Bearer {token}"),
            ("user-agent", USER_AGENT.replace(" iSL/3.4", "")),
        )

    def _invalidate_auth(self) -> None:
        with self._auth_lock:
            self._auth = {}
            if self._token_cache is not None:
                try:
                    self._token_cache.unlink(missing_ok=True)
                except OSError:
                    pass

    def _token_fingerprint(self) -> str:
        return hashlib.sha256(self.credentials.refresh_token.encode()).hexdigest()[:16]

    def _read_token_cache(self) -> dict[str, Any]:
        if self._token_cache is None:
            return {}
        try:
            data = json.loads(self._token_cache.read_text())
        except (OSError, ValueError):
            return {}
        if not isinstance(data, dict) or data.get("fingerprint") != self._token_fingerprint():
            return {}
        token = data.get("chauffeur_token")
        expires_at = data.get("expires_at")
        if not isinstance(token, str) or not isinstance(expires_at, int):
            return {}
        return {"chauffeur_token": token, "expires_at": expires_at}

    def _write_token_cache(self, auth: dict[str, Any]) -> None:
        if self._token_cache is None:
            return
        payload = json.dumps(
            {
                "fingerprint": self._token_fingerprint(),
                "chauffeur_token": auth["chauffeur_token"],
                "expires_at": int(auth["expires_at"]),
            }
        )
        temporary = self._token_cache.with_name(self._token_cache.name + ".tmp")
        try:
            self._token_cache.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            descriptor = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
                0o600,
            )
            with os.fdopen(descriptor, "w") as handle:
                handle.write(payload)
            os.replace(temporary, self._token_cache)
        except OSError:
            pass

    def _invoke(
        self,
        operation: str,
        send: Callable[[tuple[tuple[str, str], ...]], bytes],
    ) -> bytes:
        started = time.perf_counter()
        try:
            for attempt in range(2):
                try:
                    return send(self._metadata())
                except grpc.RpcError as exc:
                    # A rejected login never reaches Waymo's trip logic, so
                    # one retry with a fresh login is safe for every call.
                    if attempt == 0 and exc.code() == grpc.StatusCode.UNAUTHENTICATED:
                        self._invalidate_auth()
                        continue
                    raise
            raise AssertionError("unreachable")
        except grpc.RpcError as exc:
            code = exc.code().name if exc.code() else "UNKNOWN"
            raise WaymoError(operation, code, exc.details() or "request failed") from exc
        finally:
            self._trace(operation, started)

    def _unary(self, operation: str, payload: bytes = b"", timeout: int = 20) -> bytes:
        method = self._channel.unary_unary(
            RPC[operation],
            request_serializer=lambda value: value,
            response_deserializer=lambda value: value,
        )
        return self._invoke(
            operation,
            lambda metadata: method(payload, metadata=metadata, timeout=timeout),
        )

    def _stream_once(
        self,
        operation: str,
        payload: bytes,
        timeout: int = 15,
    ) -> bytes:
        method = self._channel.stream_stream(
            RPC[operation],
            request_serializer=lambda value: value,
            response_deserializer=lambda value: value,
        )

        def send(metadata: tuple[tuple[str, str], ...]) -> bytes:
            call = method(iter([payload]), metadata=metadata, timeout=timeout)
            try:
                return next(call)
            except StopIteration as exc:
                raise WaymoError(
                    operation,
                    "EMPTY_RESPONSE",
                    "Waymo returned no result",
                ) from exc
            finally:
                call.cancel()

        return self._invoke(operation, send)

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)
        self._channel.close()

    @staticmethod
    def _trace(operation: str, started: float) -> None:
        if os.environ.get("WAYMO_DEBUG_TIMING") == "1":
            elapsed = time.perf_counter() - started
            print(f"waymo rpc {operation}: {elapsed:.3f}s", file=sys.stderr)

    def search_places(
        self,
        query: str,
        *,
        bias_lat: float | None = None,
        bias_lng: float | None = None,
        limit: int = 5,
    ) -> list[Place]:
        query = query.strip()
        if not query:
            raise ValueError("place query cannot be empty")
        center_lat, center_lng = self._center(bias_lat, bias_lng)
        raw = self._stream_once(
            "places",
            place_search_request(query, center_lat, center_lng),
        )
        return parse_places(raw)[:limit]

    def history(self, limit: int = 20) -> list[dict[str, Any]]:
        decoded = decode(self._unary("history"))
        items = decoded.get("2", {}).get("2", []) if isinstance(decoded, dict) else []
        if not isinstance(items, list):
            return []
        trips: list[dict[str, Any]] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            trip_id = text(item.get("1"))
            detail = item.get("3", {})
            if trip_id.startswith("header_") or not isinstance(detail, dict):
                continue
            trips.append(
                {
                    "trip_id": _normalize_trip_id(trip_id),
                    "destination": _deep_text(detail.get("2")),
                    "date": _deep_text(detail.get("3")),
                    "status": _deep_text(detail.get("4")),
                    "price": _deep_text(detail.get("5")),
                }
            )
            if len(trips) >= limit:
                break
        return trips

    def status(self) -> dict[str, Any]:
        status, _template = self._status_snapshot()
        return status

    def _status_snapshot(self) -> tuple[dict[str, Any], bytes | None]:
        response = self._unary("status")
        decoded = decode(response)
        active = _active_trip(decoded)
        stale = None
        if active:
            for trip in self.history(limit=5):
                if (
                    trip["trip_id"] == active["trip_id"]
                    and str(trip.get("status", "")).lower() == "cancelled"
                ):
                    stale, active = active, None
                    break
        trips = bytes_fields(response, 2)
        plans = bytes_fields(trips[0], 5) if trips else []
        return {"active_trip": active, "stale_trip": stale}, plans[0] if plans else None

    def payment_methods(self) -> list[dict[str, Any]]:
        return [record["public"] for record in self._payment_records()]

    def quote(
        self,
        pickup_query: str,
        dropoff_query: str,
        *,
        intermediate_stop_queries: list[str] | None = None,
        intermediate_stop_indices: list[int] | None = None,
        pickup_index: int = 0,
        dropoff_index: int = 0,
        passengers: int = 1,
        scheduled_option_token: str | None = None,
        bias_lat: float | None = None,
        bias_lng: float | None = None,
    ) -> dict[str, Any]:
        intermediate_stop_queries = intermediate_stop_queries or []
        intermediate_stop_indices = intermediate_stop_indices or [
            0
        ] * len(intermediate_stop_queries)
        if len(intermediate_stop_queries) > 3:
            raise ValueError("at most 3 intermediate stops are supported")
        if len(intermediate_stop_indices) != len(intermediate_stop_queries):
            raise ValueError(
                "intermediate_stop_indices must match intermediate_stop_queries"
            )
        if any(index < 0 for index in intermediate_stop_indices):
            raise ValueError("intermediate stop indices cannot be negative")

        # Start the ride-status check and every place lookup at once.
        center = self._center(bias_lat, bias_lng)
        later_queries = [*intermediate_stop_queries, dropoff_query]
        later_indices = [*intermediate_stop_indices, dropoff_index]
        status_future = self._pool.submit(self._status_snapshot)
        pickup_future = self._pool.submit(
            self.search_places,
            pickup_query,
            bias_lat=center[0],
            bias_lng=center[1],
        )
        later_futures = [
            self._pool.submit(
                self.search_places,
                query,
                bias_lat=center[0],
                bias_lng=center[1],
            )
            for query in later_queries
        ]

        ride_state, plan_template = status_future.result()
        if ride_state["active_trip"]:
            raise WaymoError("quote", "ACTIVE_TRIP", "an active trip already exists")
        pickups = pickup_future.result()
        if not pickups:
            raise WaymoError("quote", "PICKUP_NOT_FOUND", pickup_query)
        try:
            pickup = pickups[pickup_index]
        except IndexError as exc:
            raise ValueError("pickup_index is outside the search results") from exc

        intermediate_stops: list[Place] = []
        previous = pickup
        last = len(later_queries) - 1
        for position, (query, future, result_index) in enumerate(
            zip(later_queries, later_futures, later_indices)
        ):
            is_dropoff = position == last
            results = future.result() if _km(previous, center) <= NEARBY_KM else []
            if not results:
                # Far from the search center, or nothing found near it:
                # look again around the previous stop, as the original did.
                results = self.search_places(
                    query,
                    bias_lat=previous.latitude,
                    bias_lng=previous.longitude,
                )
            if not results:
                raise WaymoError(
                    "quote",
                    "DROPOFF_NOT_FOUND" if is_dropoff else "STOP_NOT_FOUND",
                    query,
                )
            try:
                previous = results[result_index]
            except IndexError as exc:
                if is_dropoff:
                    raise ValueError(
                        "dropoff_index is outside the search results"
                    ) from exc
                raise ValueError(
                    f"result index for intermediate stop {query!r} is outside "
                    "the search results"
                ) from exc
            if not is_dropoff:
                intermediate_stops.append(previous)
        dropoff = previous
        result = parse_quote(
            self._unary(
                "quote",
                propose_trip_request(
                    pickup,
                    dropoff,
                    passengers,
                    intermediate_stops=intermediate_stops,
                    scheduled_option_token=scheduled_option_token,
                    plan_template=plan_template,
                ),
                timeout=20,
            )
        )
        selected_scheduled_option = next(
            (
                option
                for option in result["scheduled_options"]
                if option["token"] == scheduled_option_token
            ),
            None,
        )
        if scheduled_option_token and selected_scheduled_option is None:
            selected_scheduled_option = {"token": scheduled_option_token}
        return {
            **result,
            "pickup": pickup.public(),
            "intermediate_stops": [stop.public() for stop in intermediate_stops],
            "dropoff": dropoff.public(),
            "passengers": passengers,
            "selected_scheduled_option": selected_scheduled_option,
        }

    def book(self, proposal_token: str, payment_method_id: str) -> dict[str, Any]:
        if self.status()["active_trip"]:
            raise WaymoError("book", "ACTIVE_TRIP", "an active trip already exists")
        payment = next(
            (
                record
                for record in self._payment_records()
                if record["public"]["id"] == payment_method_id
            ),
            None,
        )
        if payment is None:
            raise WaymoError("book", "PAYMENT_NOT_FOUND", payment_method_id)
        try:
            self._unary(
                "book",
                create_trip_request(proposal_token, payment["booking_token"]),
                timeout=30,
            )
        except WaymoError as exc:
            if exc.code in {"DEADLINE_EXCEEDED", "UNAVAILABLE", "UNKNOWN"}:
                raise WaymoError(
                    "book",
                    "OUTCOME_UNKNOWN",
                    "do not retry; check ride status first",
                ) from exc
            raise
        active = self.status()["active_trip"]
        if not active:
            raise WaymoError(
                "book",
                "OUTCOME_UNKNOWN",
                "CreateTrip returned but no active trip is visible",
            )
        return {"booked": True, "active_trip": active}

    def preview_cancel(self) -> dict[str, Any]:
        before = self.status()["active_trip"]
        if not before:
            return {"can_cancel": False, "reason": "no_active_trip"}
        proposal = self._unary("propose_cancel")
        tokens = bytes_fields(proposal, 2)
        if not tokens:
            raise WaymoError(
                "cancel",
                "TOKEN_MISSING",
                "Waymo returned no cancellation token",
            )
        fee = parse_cancellation_fee(proposal)
        if fee is None:
            try:
                fee = parse_cancellation_fee(self._unary("cancel_fee_ux"))
            except WaymoError:
                pass
        return {
            "can_cancel": True,
            "trip_id": before["trip_id"],
            "cancellation_fee": fee,
            "fee_available": fee is not None,
            "_cancellation_token": tokens[0].decode(errors="replace"),
        }

    def confirm_cancel(
        self,
        cancellation_token: str,
        expected_trip_id: str,
    ) -> dict[str, Any]:
        before = self.status()["active_trip"]
        if not before:
            return {"cancelled": False, "reason": "no_active_trip"}
        if before["trip_id"] != expected_trip_id:
            raise WaymoError(
                "cancel",
                "TRIP_CHANGED",
                "the active trip changed after cancellation preview",
            )
        try:
            self._unary(
                "cancel",
                cancel_trip_request(cancellation_token),
                timeout=20,
            )
        except WaymoError as exc:
            if exc.code in {"DEADLINE_EXCEEDED", "UNAVAILABLE", "UNKNOWN"}:
                raise WaymoError(
                    "cancel",
                    "OUTCOME_UNKNOWN",
                    "do not retry; check ride status first",
                ) from exc
            raise
        return {
            "cancelled": self.status()["active_trip"] is None,
            "trip_id": before["trip_id"],
        }

    def _payment_records(self) -> list[dict[str, Any]]:
        if self._payments_cache and time.monotonic() - self._payments_cache[0] < 300:
            return self._payments_cache[1]
        records: list[dict[str, Any]] = []
        for block in bytes_fields(self._unary("payments"), 2):
            parsed = decode(block)
            if not isinstance(parsed, dict):
                continue
            method_id = text(parsed.get("3"))
            booking_token = _find_hex_token(parsed)
            details = parsed.get("1", {})
            last_four = text(details.get("2")) if isinstance(details, dict) else ""
            if method_id and booking_token:
                records.append(
                    {
                        "booking_token": booking_token,
                        "public": {
                            "id": method_id,
                            "type": "card",
                            "label": (
                                f"Card ending in {last_four}" if last_four else "Card"
                            ),
                        },
                    }
                )
        self._payments_cache = (time.monotonic(), records)
        return records

    def _center(
        self,
        bias_lat: float | None,
        bias_lng: float | None,
    ) -> tuple[float, float]:
        if bias_lat is None or bias_lng is None:
            return self.home
        return bias_lat, bias_lng


def _fresh(auth: dict[str, Any]) -> bool:
    return bool(auth) and int(auth.get("expires_at", 0)) > time.time() + 60


def _env_float(name: str) -> float | None:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return None


def _km(place: Place, center: tuple[float, float]) -> float:
    """Great-circle distance in kilometres between a place and a point."""
    lat1, lng1 = math.radians(place.latitude), math.radians(place.longitude)
    lat2, lng2 = math.radians(center[0]), math.radians(center[1])
    half = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    )
    return 6371.0 * 2 * math.asin(math.sqrt(half))


def _deep_text(value: Any) -> str | None:
    if isinstance(value, dict):
        for child in value.values():
            result = _deep_text(child)
            if result:
                return result
    elif isinstance(value, list):
        for child in value:
            result = _deep_text(child)
            if result:
                return result
    else:
        result = text(value)
        if result and not result.startswith("header_"):
            return result
    return None


def _normalize_trip_id(value: str) -> str:
    if value.isdigit():
        return value
    try:
        decoded = base64.b64decode(value + "==").decode(errors="ignore")
        digits = "".join(character for character in decoded if character.isdigit())
        return digits or value
    except Exception:
        return value


def _location(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    desired = value.get("3")
    if not isinstance(desired, dict):
        return None
    coords = desired.get("1", {})
    display = desired.get("8", {})
    if not isinstance(coords, dict):
        return None
    try:
        latitude = int(coords["1"]) * 1e-7
        longitude = int(coords["2"]) * 1e-7
    except (KeyError, TypeError, ValueError):
        return None
    name = ""
    address = ""
    if isinstance(display, dict):
        name = text(display.get("1"))
        lines = display.get("2", [])
        if not isinstance(lines, list):
            lines = [lines]
        address = ", ".join(filter(None, (text(line) for line in lines)))
    return {
        "name": name or address,
        "address": address,
        "latitude": latitude,
        "longitude": longitude,
    }


def _active_trip(decoded: Any) -> dict[str, Any] | None:
    trip = decoded.get("2") if isinstance(decoded, dict) else None
    if not isinstance(trip, dict):
        return None
    trip_id = text(trip.get("1"))
    if not trip_id:
        return None
    plan = trip.get("5", {})
    legs = plan.get("5") if isinstance(plan, dict) else None
    if isinstance(legs, list):
        leg = next(
            (
                candidate
                for candidate in legs
                if isinstance(candidate, dict) and candidate.get("1")
            ),
            legs[0] if legs else {},
        )
    else:
        leg = legs
    if not isinstance(leg, dict):
        leg = {}
    state = trip.get("4", {})
    state_code = (
        int(state.get("1", 0))
        if isinstance(state, dict) and isinstance(state.get("1", 0), int)
        else 0
    )
    result = {
        "trip_id": _normalize_trip_id(trip_id),
        "state": TRIP_STATES.get(state_code, f"UNKNOWN_{state_code}"),
        "state_code": state_code,
        "pickup": _location(leg.get("2")),
        "dropoff": _location(leg.get("3")),
        "tracking_url": text(trip.get("16")) or None,
    }
    pickup_eta = leg.get("4")
    if isinstance(pickup_eta, dict):
        eta_timestamp = _timestamp(pickup_eta.get("1"))
        if eta_timestamp is not None:
            result["pickup_eta_seconds"] = max(
                0,
                round(eta_timestamp - time.time()),
            )
            result["pickup_eta_at"] = datetime.fromtimestamp(
                eta_timestamp,
                timezone.utc,
            ).isoformat()
    vehicle = _vehicle(trip.get("2"))
    if vehicle:
        result["vehicle"] = vehicle
    arrival = _arrival(trip.get("17"))
    if arrival:
        result["arrival"] = arrival
    configurations = plan.get("3") if isinstance(plan, dict) else None
    scheduled_token = (
        text(configurations.get("2"))
        if isinstance(configurations, dict)
        else ""
    )
    if scheduled_token:
        result["scheduled_option_token"] = scheduled_token
    return result


def _vehicle(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    vehicle_id = text(value.get("1"))
    license_plate = text(value.get("10"))
    if not vehicle_id and not license_plate:
        return None
    vehicle: dict[str, Any] = {
        "vehicle_id": vehicle_id or None,
        "license_plate": license_plate or None,
    }
    position = value.get("2")
    if isinstance(position, dict):
        try:
            vehicle["position"] = {
                "latitude": int(position["1"]) * 1e-7,
                "longitude": int(position["2"]) * 1e-7,
            }
        except (KeyError, TypeError, ValueError):
            pass
    heading = value.get("3")
    if isinstance(heading, int):
        vehicle["heading_degrees"] = heading / 1000
    speed = value.get("18")
    if isinstance(speed, int):
        vehicle["speed_mph"] = speed
    vehicle_type = value.get("8")
    if isinstance(vehicle_type, int):
        vehicle["type"] = VEHICLE_TYPES.get(
            vehicle_type,
            f"UNKNOWN_{vehicle_type}",
        )
    reported_at = _timestamp(value.get("7"))
    if reported_at is not None:
        vehicle["last_reported_at"] = datetime.fromtimestamp(
            reported_at,
            timezone.utc,
        ).isoformat()
    return vehicle


def _arrival(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    state_code = value.get("1")
    position = value.get("4")
    if not isinstance(state_code, int) and not isinstance(position, dict):
        return None
    arrival: dict[str, Any] = {}
    if isinstance(state_code, int):
        arrival["state"] = ARRIVAL_STATES.get(
            state_code,
            f"UNKNOWN_{state_code}",
        )
        arrival["state_code"] = state_code
    if isinstance(position, dict):
        try:
            arrival["position"] = {
                "latitude": int(position["1"]) * 1e-7,
                "longitude": int(position["2"]) * 1e-7,
            }
        except (KeyError, TypeError, ValueError):
            pass
    return arrival or None


def _timestamp(value: Any) -> float | None:
    if not isinstance(value, dict) or not isinstance(value.get("1"), int):
        return None
    seconds = int(value["1"])
    nanos = int(value.get("2", 0))
    return seconds + nanos / 1_000_000_000


def _find_hex_token(value: Any) -> str | None:
    if isinstance(value, dict):
        for child in value.values():
            result = _find_hex_token(child)
            if result:
                return result
    elif isinstance(value, list):
        for child in value:
            result = _find_hex_token(child)
            if result:
                return result
    else:
        candidate = text(value)
        if len(candidate) == 32 and all(
            character in "0123456789abcdef" for character in candidate
        ):
            return candidate
    return None

"""MCP tool surface for Waymo ride management."""

from __future__ import annotations

import atexit
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, Literal

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field

from .client import WaymoClient, WaymoError

mcp = MCPServer(
    "waymo-rides",
    instructions=(
        "Manage Waymo rides. Resolve ambiguous places and get a quote before "
        "booking. Only call booking or cancellation tools after explicit user "
        "authorization. Never retry an OUTCOME_UNKNOWN mutation; check status."
    ),
)

_client: WaymoClient | None = None
_client_lock = threading.Lock()
_quotes: dict[str, tuple[float, dict[str, Any]]] = {}
_quotes_lock = threading.Lock()
QUOTE_TTL_SECONDS = 10 * 60
_cancel_preview: tuple[float, str, str] | None = None
_cancel_preview_lock = threading.Lock()
CANCEL_PREVIEW_TTL_SECONDS = 5 * 60


def _get_client() -> WaymoClient:
    global _client
    with _client_lock:
        if _client is None:
            try:
                _client = WaymoClient.from_environment()
                atexit.register(_client.close)
            except (OSError, ValueError) as exc:
                raise ToolError(
                    "Waymo credentials are not configured. Set WAYMO_REFRESH_TOKEN "
                    "or WAYMO_CREDENTIALS_FILE."
                ) from exc
        return _client


def _call(function: Any, *args: Any, **kwargs: Any) -> Any:
    try:
        return function(*args, **kwargs)
    except WaymoError as exc:
        raise ToolError(f"{exc.code}: {exc.detail}") from exc
    except (OSError, RuntimeError, ValueError) as exc:
        raise ToolError(str(exc)) from exc


@mcp.tool(
    title="Search Waymo places",
    annotations=ToolAnnotations(read_only_hint=True, open_world_hint=True),
)
def waymo_search_places(
    query: Annotated[str, Field(min_length=1, description="Place name or address")],
    bias_latitude: Annotated[
        float | None,
        Field(ge=-90, le=90, description="Search center latitude; defaults to home"),
    ] = None,
    bias_longitude: Annotated[
        float | None,
        Field(ge=-180, le=180, description="Search center longitude; defaults to home"),
    ] = None,
    limit: Annotated[int, Field(ge=1, le=10)] = 5,
) -> dict[str, Any]:
    """Resolve a place name or address to canonical Waymo locations."""
    places = _call(
        _get_client().search_places,
        query,
        bias_lat=bias_latitude,
        bias_lng=bias_longitude,
        limit=limit,
    )
    return {
        "query": query,
        "results": [
            _compact(place.public(index)) for index, place in enumerate(places)
        ],
    }


@mcp.tool(
    title="Get Waymo ride history",
    annotations=ToolAnnotations(read_only_hint=True, open_world_hint=True),
)
def waymo_ride_history(
    limit: Annotated[int, Field(ge=1, le=100)] = 20,
) -> dict[str, Any]:
    """Return recent Waymo trips, including cancelled and completed rides."""
    return {"trips": _compact(_call(_get_client().history, limit))}


@mcp.tool(
    title="Get current Waymo ride status",
    annotations=ToolAnnotations(read_only_hint=True, open_world_hint=True),
)
def waymo_ride_status() -> dict[str, Any]:
    """Return the active ride and any terminal trip still cached by Waymo."""
    return _call(_get_client().status)


@mcp.tool(
    title="List Waymo payment methods",
    annotations=ToolAnnotations(read_only_hint=True, open_world_hint=True),
)
def waymo_list_payment_methods() -> dict[str, Any]:
    """List safe payment-method labels and IDs accepted by the booking tool."""
    return {"payment_methods": _call(_get_client().payment_methods)}


@mcp.tool(
    title="Get a Waymo ride quote",
    annotations=ToolAnnotations(
        read_only_hint=False,
        destructive_hint=False,
        idempotent_hint=False,
        open_world_hint=True,
    ),
)
def waymo_get_quote(
    pickup: Annotated[str, Field(min_length=1, description="Pickup name or address")],
    dropoff: Annotated[
        str,
        Field(min_length=1, description="Dropoff name or address"),
    ],
    intermediate_stops: Annotated[
        list[str] | None,
        Field(
            max_length=3,
            description="Ordered intermediate stop names or addresses",
        ),
    ] = None,
    intermediate_stop_result_indices: Annotated[
        list[int] | None,
        Field(
            max_length=3,
            description=(
                "Search-result index for each intermediate stop; defaults to 0"
            ),
        ),
    ] = None,
    pickup_result_index: Annotated[int, Field(ge=0)] = 0,
    dropoff_result_index: Annotated[int, Field(ge=0)] = 0,
    passengers: Annotated[int, Field(ge=1, le=4)] = 1,
    scheduled_option_token: Annotated[
        str | None,
        Field(
            description=(
                "Token from a prior quote's scheduled_options; omit for ASAP"
            )
        ),
    ] = None,
    bias_latitude: Annotated[
        float | None,
        Field(
            ge=-90,
            le=90,
            description="Center for place lookups, e.g. when traveling; defaults to home",
        ),
    ] = None,
    bias_longitude: Annotated[
        float | None,
        Field(
            ge=-180,
            le=180,
            description="Center for place lookups, e.g. when traveling; defaults to home",
        ),
    ] = None,
) -> dict[str, Any]:
    """Quote an ASAP route, or re-quote using one returned scheduling option.

    Book before mcp_cache_expires_at (10 minutes). Waymo publishes no expiry
    of its own; if booking reports PROPOSAL_STALE, quote again.
    """
    quote = _call(
        _get_client().quote,
        pickup,
        dropoff,
        intermediate_stop_queries=intermediate_stops,
        intermediate_stop_indices=intermediate_stop_result_indices,
        pickup_index=pickup_result_index,
        dropoff_index=dropoff_result_index,
        passengers=passengers,
        scheduled_option_token=scheduled_option_token,
        bias_lat=bias_latitude,
        bias_lng=bias_longitude,
    )
    quote = _compact(
        {
            **quote,
            "mcp_cache_expires_at": (
                datetime.now(timezone.utc) + timedelta(seconds=QUOTE_TTL_SECONDS)
            ).isoformat(),
        }
    )
    with _quotes_lock:
        _quotes[quote["proposal_token"]] = (time.monotonic(), quote)
        _purge_quotes()
    return quote


@mcp.tool(
    title="Book a Waymo ride",
    annotations=ToolAnnotations(
        read_only_hint=False,
        destructive_hint=True,
        idempotent_hint=False,
        open_world_hint=True,
    ),
)
def waymo_book_ride(
    proposal_token: Annotated[
        str,
        Field(min_length=1, description="Token returned by waymo_get_quote"),
    ],
    payment_method_id: Annotated[
        str,
        Field(min_length=1, description="ID returned by waymo_list_payment_methods"),
    ],
    confirmation: Literal["BOOK"],
) -> dict[str, Any]:
    """Book a quoted ride. Call only after the user explicitly requests booking."""
    del confirmation
    with _quotes_lock:
        record = _quotes.get(proposal_token)
        if record is None or time.monotonic() - record[0] > QUOTE_TTL_SECONDS:
            raise ToolError(
                "Unknown or expired proposal token. Call waymo_get_quote again."
            )
    result = _call(_get_client().book, proposal_token, payment_method_id)
    with _quotes_lock:
        _quotes.pop(proposal_token, None)
    return result


@mcp.tool(
    title="Preview Waymo ride cancellation",
    annotations=ToolAnnotations(
        read_only_hint=False,
        destructive_hint=False,
        idempotent_hint=False,
        open_world_hint=True,
    ),
)
def waymo_preview_cancellation() -> dict[str, Any]:
    """Preview cancellation and its fee without cancelling the active ride."""
    global _cancel_preview
    preview = _call(_get_client().preview_cancel)
    token = preview.pop("_cancellation_token", None)
    if preview.get("can_cancel") and token:
        with _cancel_preview_lock:
            _cancel_preview = (
                time.monotonic(),
                preview["trip_id"],
                token,
            )
        preview["preview_expires_at"] = (
            datetime.now(timezone.utc)
            + timedelta(seconds=CANCEL_PREVIEW_TTL_SECONDS)
        ).isoformat()
    return preview


@mcp.tool(
    title="Cancel the active Waymo ride",
    annotations=ToolAnnotations(
        read_only_hint=False,
        destructive_hint=True,
        idempotent_hint=False,
        open_world_hint=True,
    ),
)
def waymo_cancel_ride(confirmation: Literal["CANCEL"]) -> dict[str, Any]:
    """Cancel after a fresh fee preview and explicit user confirmation."""
    global _cancel_preview
    del confirmation
    with _cancel_preview_lock:
        preview = _cancel_preview
        if (
            preview is None
            or time.monotonic() - preview[0] > CANCEL_PREVIEW_TTL_SECONDS
        ):
            _cancel_preview = None
            raise ToolError(
                "No fresh cancellation preview. Call "
                "waymo_preview_cancellation first and show its fee to the user."
            )
    result = _call(_get_client().confirm_cancel, preview[2], preview[1])
    with _cancel_preview_lock:
        _cancel_preview = None
    return result


def _compact(value: Any) -> Any:
    """Drop always-empty fields so replies stay short; keeps empty lists."""
    if isinstance(value, dict):
        return {key: _compact(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_compact(item) for item in value]
    return value


def _purge_quotes() -> None:
    now = time.monotonic()
    expired = [
        token
        for token, (created_at, _quote) in _quotes.items()
        if now - created_at > QUOTE_TTL_SECONDS
    ]
    for token in expired:
        _quotes.pop(token, None)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()

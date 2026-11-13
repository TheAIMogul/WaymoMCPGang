/**
 * Waymo Rider API client for Cloudflare Workers.
 * 1:1 port of src/waymo_mcp/client.py supporting all 9 Waymo RPCs natively.
 *
 * Transport architecture:
 * - Unary RPCs (8/9): POST https://cartrip-pa.googleapis.com/$rpc/car.taas.client.v2alpha.ClientTripService/<Method>
 *   with content-type: application/x-protobuf (bare protobuf body, rich google.rpc.Status errors).
 * - Bidi-streaming GetPlaceCompletions (9/9):
 *   1. Primary: Native gRPC over Worker fetch() -> POST https://cartrip-pa.googleapis.com/car.taas.client.v2alpha.ClientTripService/GetPlaceCompletions
 *      with content-type: application/grpc and 5-byte length-prefixed gRPC frame over Cloudflare's HTTP/2 egress.
 *   2. Fallback 1: Native gRPC over cloudflare:sockets (raw TCP + WebCrypto TLS 1.3 ALPN "h2" + HTTP/2 framing).
 *   3. Fallback 2: OpenStreetMap Nominatim geocoding (self-built Place locations).
 */

import { DEFAULT_DEVICE_ID, RPC_USER_AGENT, authenticate } from "./auth.js";
import { callGrpcOverSocket, frameGrpcMessage, unframeGrpcMessages } from "./h2_tls13.js";
import {
  Place,
  bytesFields,
  cancelTripRequest,
  concatBytes,
  createTripRequest,
  decode,
  latLng,
  message,
  parseCancellationFee,
  parsePlaces,
  parseQuote,
  placeSearchRequest,
  proposeTripRequest,
  string,
  text,
} from "./wire.js";

export const HOST = "cartrip-pa.googleapis.com";
export const SERVICE = "/car.taas.client.v2alpha.ClientTripService";
export const DEFAULT_HOME = [25.7617, -80.1918];
export const NEARBY_KM = 25.0;

export const RPC = {
  history: `${SERVICE}/GetTransactionHistory`,
  status: `${SERVICE}/GetActiveTrip`,
  places: `${SERVICE}/GetPlaceCompletions`,
  payments: `${SERVICE}/ListPaymentMethods`,
  quote: `${SERVICE}/ProposeTripPlan`,
  book: `${SERVICE}/CreateTrip`,
  propose_cancel: `${SERVICE}/ProposeTripCancellation`,
  cancel_fee_ux: `${SERVICE}/GetCancellationFeeUx`,
  cancel: `${SERVICE}/CancelActiveTrip`,
};

export const TRIP_STATES = {
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
};

export const VEHICLE_TYPES = {
  0: "VEHICLE_TYPE_UNSPECIFIED",
  2: "V5",
  3: "LIBERTY",
  5: "WAV",
  6: "AUX",
  7: "W12",
  8: "APOLLO",
};

export const ARRIVAL_STATES = {
  0: "WRA_STATE_UNSPECIFIED",
  1: "DISPATCHED",
  2: "ARRIVED",
  3: "CONTINUING_IN_MANUAL",
  4: "CANCELLED",
  5: "INTERRUPTED",
};

const GRPC_CODE_NAMES = {
  0: "OK",
  1: "CANCELLED",
  2: "UNKNOWN",
  3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND",
  6: "ALREADY_EXISTS",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  11: "OUT_OF_RANGE",
  12: "UNIMPLEMENTED",
  13: "INTERNAL",
  14: "UNAVAILABLE",
  15: "DATA_LOSS",
  16: "UNAUTHENTICATED",
};

const HTTP_TO_GRPC_CODE = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ABORTED",
  412: "FAILED_PRECONDITION",
  429: "RESOURCE_EXHAUSTED",
  499: "CANCELLED",
  500: "INTERNAL",
  501: "UNIMPLEMENTED",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
};

export class WaymoError extends Error {
  constructor(operation, code, detail) {
    super(`${operation}: ${code}: ${detail}`);
    this.name = "WaymoError";
    this.operation = operation;
    this.code = code;
    this.detail = detail;
  }
}

// Module-level auth cache across requests within the same Worker isolate
let cachedAuth = null;
let cachedPayments = null;

async function tokenFingerprint(refreshToken) {
  const bytes = new TextEncoder().encode(refreshToken);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash.subarray(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isFresh(auth, fp) {
  if (!auth || auth.fingerprint !== fp) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return Number(auth.expires_at || 0) > nowSec + 60;
}

function parseRpcError(status, rawBytes, operation) {
  let code = HTTP_TO_GRPC_CODE[status] || "UNKNOWN";
  let detail = `HTTP ${status}`;
  try {
    if (rawBytes && rawBytes.length > 0) {
      const d = decode(rawBytes);
      if (d && typeof d === "object") {
        if (typeof d["1"] === "number" && GRPC_CODE_NAMES[d["1"]]) {
          code = GRPC_CODE_NAMES[d["1"]];
        }
        const msg = text(d["2"]);
        if (msg) detail = msg;
      }
    }
  } catch {}
  return new WaymoError(operation, code, detail);
}

export class WaymoClient {
  constructor(credentials, options = {}) {
    this.credentials = credentials;
    if (
      Number.isFinite(credentials.home_latitude) &&
      Number.isFinite(credentials.home_longitude)
    ) {
      this.home = [credentials.home_latitude, credentials.home_longitude];
    } else {
      this.home = DEFAULT_HOME;
    }
    this.placesMode = options.placesMode || "auto"; // "auto" | "grpc_fetch" | "grpc_socket" | "nominatim"
  }

  static fromEnv(env = {}) {
    const refreshToken = (env.WAYMO_REFRESH_TOKEN || "").trim();
    if (!refreshToken) {
      throw new Error(
        "Waymo credentials are not configured. Set WAYMO_REFRESH_TOKEN secret on the Worker."
      );
    }
    const homeLat = env.WAYMO_HOME_LAT !== undefined ? Number(env.WAYMO_HOME_LAT) : NaN;
    const homeLng = env.WAYMO_HOME_LNG !== undefined ? Number(env.WAYMO_HOME_LNG) : NaN;
    return new WaymoClient(
      {
        refresh_token: refreshToken,
        device_id: (env.WAYMO_DEVICE_ID || DEFAULT_DEVICE_ID).trim(),
        account_name: (env.WAYMO_ACCOUNT_NAME || "").trim(),
        home_latitude: Number.isFinite(homeLat) ? homeLat : null,
        home_longitude: Number.isFinite(homeLng) ? homeLng : null,
      },
      { placesMode: env.WAYMO_PLACES_MODE || "auto" }
    );
  }

  async _metadata() {
    const fp = await tokenFingerprint(this.credentials.refresh_token);
    if (!isFresh(cachedAuth, fp)) {
      const minted = await authenticate(this.credentials);
      cachedAuth = {
        fingerprint: fp,
        chauffeur_token: minted.chauffeur_token,
        expires_at: minted.expires_at,
      };
    }
    return {
      authorization: `Bearer ${cachedAuth.chauffeur_token}`,
      "user-agent": RPC_USER_AGENT,
    };
  }

  _invalidateAuth() {
    cachedAuth = null;
  }

  async _invoke(operation, sendFn) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const md = await this._metadata();
        return await sendFn(md);
      } catch (err) {
        if (attempt === 0 && err instanceof WaymoError && err.code === "UNAUTHENTICATED") {
          this._invalidateAuth();
          continue;
        }
        throw err;
      }
    }
    throw new Error("unreachable");
  }

  async _unary(operation, payload = new Uint8Array(0)) {
    return await this._invoke(operation, async (md) => {
      const url = `https://${HOST}/$rpc${RPC[operation]}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-protobuf",
          "accept": "application/x-protobuf",
          "authorization": md.authorization,
          "user-agent": md["user-agent"],
        },
        body: payload,
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      if (res.status !== 200) {
        throw parseRpcError(res.status, buf, operation);
      }
      return buf;
    });
  }

  async _streamOnceGrpcFetch(operation, payload) {
    return await this._invoke(operation, async (md) => {
      const url = `https://${HOST}${RPC[operation]}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/grpc",
          "te": "trailers",
          "authorization": md.authorization,
          "user-agent": md["user-agent"],
        },
        body: frameGrpcMessage(payload),
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      if (res.headers.get("www-authenticate")) {
        throw new WaymoError(operation, "UNAUTHENTICATED", "Bearer token rejected");
      }
      if (res.status !== 200) {
        throw parseRpcError(res.status, buf, operation);
      }
      const messages = unframeGrpcMessages(buf);
      if (!messages.length) {
        throw new WaymoError(operation, "EMPTY_RESPONSE", "Waymo returned no result");
      }
      return messages[0];
    });
  }

  async _streamOnceGrpcSocket(operation, payload) {
    return await this._invoke(operation, async (md) => {
      const res = await callGrpcOverSocket({
        hostname: HOST,
        port: 443,
        path: RPC[operation],
        payload,
        authorization: md.authorization,
        userAgent: md["user-agent"],
      });
      if (!res.messages.length) {
        throw new WaymoError(operation, "EMPTY_RESPONSE", "Waymo returned no result on HTTP/2 socket");
      }
      return res.firstMessage;
    });
  }

  async _geocodeNominatim(query, limit = 5) {
    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      limit: String(limit),
    });
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: {
        "User-Agent": "WaymoMCPGang/0.1 (Cloudflare Worker MCP)",
        "Accept": "application/json",
      },
    });
    if (!res.ok) {
      throw new WaymoError("places", "UNAVAILABLE", `Nominatim HTTP ${res.status}`);
    }
    const hits = await res.json();
    if (!Array.isArray(hits)) return [];
    return hits.slice(0, limit).map((hit) => {
      const lat = Number.parseFloat(hit.lat);
      const lng = Number.parseFloat(hit.lon);
      const address = String(hit.display_name || query);
      const name = String(hit.name || address.split(",")[0] || query);
      const ggq = concatBytes(
        message(1, latLng(lat, lng)),
        message(8, concatBytes(string(1, name), string(2, address)))
      );
      return new Place(name, address, lat, lng, hit.place_id ? `osm:${hit.place_id}` : null, ggq);
    });
  }

  async searchPlaces(query, { biasLat = null, biasLng = null, limit = 5, mode = null } = {}) {
    const trimmed = String(query || "").trim();
    if (!trimmed) throw new Error("place query cannot be empty");
    const [centerLat, centerLng] = this._center(biasLat, biasLng);
    const activeMode = mode || this.placesMode;

    if (activeMode === "nominatim") {
      return await this._geocodeNominatim(trimmed, limit);
    }

    const reqPayload = placeSearchRequest(trimmed, centerLat, centerLng);
    if (activeMode === "grpc_socket") {
      const raw = await this._streamOnceGrpcSocket("places", reqPayload);
      return parsePlaces(raw).slice(0, limit);
    }
    if (activeMode === "grpc_fetch") {
      const raw = await this._streamOnceGrpcFetch("places", reqPayload);
      return parsePlaces(raw).slice(0, limit);
    }

    // "auto": Try native gRPC over fetch() first, then raw-socket TLS 1.3 HTTP/2, then Nominatim
    try {
      const raw = await this._streamOnceGrpcFetch("places", reqPayload);
      const parsed = parsePlaces(raw).slice(0, limit);
      if (parsed.length > 0) return parsed;
    } catch {}
    try {
      const raw = await this._streamOnceGrpcSocket("places", reqPayload);
      const parsed = parsePlaces(raw).slice(0, limit);
      if (parsed.length > 0) return parsed;
    } catch {}
    return await this._geocodeNominatim(trimmed, limit);
  }

  async history(limit = 20) {
    const decoded = decode(await this._unary("history"));
    let items = decoded?.["2"]?.["2"] ?? [];
    if (!Array.isArray(items)) items = [items];
    const trips = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const tripId = text(item["1"]);
      const detail = item["3"];
      if (!tripId || tripId.startsWith("header_") || !detail || typeof detail !== "object") {
        continue;
      }
      trips.push({
        trip_id: normalizeTripId(tripId),
        destination: deepText(detail["2"]),
        date: deepText(detail["3"]),
        status: deepText(detail["4"]),
        price: deepText(detail["5"]),
      });
      if (trips.length >= limit) break;
    }
    return trips;
  }

  async status() {
    const [st] = await this._statusSnapshot();
    return st;
  }

  async _statusSnapshot() {
    const response = await this._unary("status");
    const decoded = decode(response);
    let active = parseActiveTrip(decoded);
    let stale = null;
    // A trip in a terminal state (completed or cancelled) is finished and must
    // NOT block a new quote or booking, even though Waymo's GetActiveTrip keeps
    // returning it for a while after the ride ends and the app shows nothing.
    const TERMINAL_STATES = new Set([110, 120]); // COMPLETED, CANCELLED
    if (active && TERMINAL_STATES.has(active.state_code)) {
      stale = active;
      active = null;
    }
    if (active) {
      for (const trip of await this.history(5)) {
        if (
          trip.trip_id === active.trip_id &&
          String(trip.status || "").toLowerCase() === "cancelled"
        ) {
          stale = active;
          active = null;
          break;
        }
      }
    }
    const trips = bytesFields(response, 2);
    const plans = trips.length ? bytesFields(trips[0], 5) : [];
    return [{ active_trip: active, stale_trip: stale }, plans.length ? plans[0] : null];
  }

  async paymentMethods() {
    const records = await this._paymentRecords();
    return records.map((r) => r.public);
  }
  async quote(
    pickupQuery,
    dropoffQuery,
    {
      intermediateStopQueries = null,
      intermediateStopIndices = null,
      pickupIndex = 0,
      dropoffIndex = 0,
      passengers = 1,
      scheduledOptionToken = null,
      biasLat = null,
      biasLng = null,
    } = {}
  ) {
    const stopQueries = intermediateStopQueries || [];
    const stopIndices = intermediateStopIndices || stopQueries.map(() => 0);
    if (stopQueries.length > 3) {
      throw new Error("at most 3 intermediate stops are supported");
    }
    if (stopIndices.length !== stopQueries.length) {
      throw new Error("intermediate_stop_indices must match intermediate_stop_queries");
    }
    if (stopIndices.some((idx) => idx < 0)) {
      throw new Error("intermediate stop indices cannot be negative");
    }

    const center = this._center(biasLat, biasLng);
    const laterQueries = [...stopQueries, dropoffQuery];
    const laterIndices = [...stopIndices, dropoffIndex];

    const [statusTuple, pickups, ...laterResultsList] = await Promise.all([
      this._statusSnapshot(),
      this.searchPlaces(pickupQuery, { biasLat: center[0], biasLng: center[1] }),
      ...laterQueries.map((q) =>
        this.searchPlaces(q, { biasLat: center[0], biasLng: center[1] })
      ),
    ]);

    const [rideState, planTemplate] = statusTuple;
    if (rideState.active_trip) {
      throw new WaymoError("quote", "ACTIVE_TRIP", "an active trip already exists");
    }
    if (!pickups.length) {
      throw new WaymoError("quote", "PICKUP_NOT_FOUND", pickupQuery);
    }
    if (pickupIndex < 0 || pickupIndex >= pickups.length) {
      throw new Error("pickup_index is outside the search results");
    }
    const pickup = pickups[pickupIndex];

    const intermediateStops = [];
    let previous = pickup;
    const last = laterQueries.length - 1;
    for (let position = 0; position < laterQueries.length; position++) {
      const query = laterQueries[position];
      const resultIndex = laterIndices[position];
      const isDropoff = position === last;
      let results = km(previous, center) <= NEARBY_KM ? laterResultsList[position] : [];
      if (!results.length) {
        results = await this.searchPlaces(query, {
          biasLat: previous.latitude,
          biasLng: previous.longitude,
        });
      }
      if (!results.length) {
        throw new WaymoError(
          "quote",
          isDropoff ? "DROPOFF_NOT_FOUND" : "STOP_NOT_FOUND",
          query
        );
      }
      if (resultIndex < 0 || resultIndex >= results.length) {
        if (isDropoff) {
          throw new Error("dropoff_index is outside the search results");
        }
        throw new Error(
          `result index for intermediate stop '${query}' is outside the search results`
        );
      }
      previous = results[resultIndex];
      if (!isDropoff) {
        intermediateStops.push(previous);
      }
    }

    const dropoff = previous;
    const rawQuote = await this._unary(
      "quote",
      proposeTripRequest(pickup, dropoff, passengers, {
        intermediateStops,
        scheduledOptionToken,
        planTemplate,
      })
    );
    const result = parseQuote(rawQuote);
    let selectedScheduledOption =
      result.scheduled_options.find((opt) => opt.token === scheduledOptionToken) || null;
    if (scheduledOptionToken && !selectedScheduledOption) {
      selectedScheduledOption = { token: scheduledOptionToken };
    }
    return {
      ...result,
      pickup: pickup.public(),
      intermediate_stops: intermediateStops.map((s) => s.public()),
      dropoff: dropoff.public(),
      passengers,
      selected_scheduled_option: selectedScheduledOption,
    };
  }

  async book(proposalToken, paymentMethodId) {
    const st = await this.status();
    if (st.active_trip) {
      throw new WaymoError("book", "ACTIVE_TRIP", "an active trip already exists");
    }
    const records = await this._paymentRecords();
    const payment = records.find((r) => r.public.id === paymentMethodId) || null;
    if (!payment) {
      throw new WaymoError("book", "PAYMENT_NOT_FOUND", paymentMethodId);
    }
    try {
      await this._unary("book", createTripRequest(proposalToken, payment.booking_token));
    } catch (exc) {
      if (
        exc instanceof WaymoError &&
        ["DEADLINE_EXCEEDED", "UNAVAILABLE", "UNKNOWN"].includes(exc.code)
      ) {
        throw new WaymoError("book", "OUTCOME_UNKNOWN", "do not retry; check ride status first");
      }
      throw exc;
    }
    const after = await this.status();
    if (!after.active_trip) {
      throw new WaymoError(
        "book",
        "OUTCOME_UNKNOWN",
        "CreateTrip returned but no active trip is visible"
      );
    }
    return { booked: true, active_trip: after.active_trip };
  }

  async previewCancel() {
    const before = (await this.status()).active_trip;
    if (!before) {
      return { can_cancel: false, reason: "no_active_trip" };
    }
    const proposal = await this._unary("propose_cancel");
    const tokens = bytesFields(proposal, 2);
    if (!tokens.length) {
      throw new WaymoError("cancel", "TOKEN_MISSING", "Waymo returned no cancellation token");
    }
    let fee = parseCancellationFee(proposal);
    if (fee === null) {
      try {
        fee = parseCancellationFee(await this._unary("cancel_fee_ux"));
      } catch {}
    }
    return {
      can_cancel: true,
      trip_id: before.trip_id,
      cancellation_fee: fee,
      fee_available: fee !== null,
      _cancellation_token: new TextDecoder().decode(tokens[0]),
    };
  }

  async confirmCancel(cancellationToken, expectedTripId) {
    const before = (await this.status()).active_trip;
    if (!before) {
      return { cancelled: false, reason: "no_active_trip" };
    }
    if (before.trip_id !== expectedTripId) {
      throw new WaymoError(
        "cancel",
        "TRIP_CHANGED",
        "the active trip changed after cancellation preview"
      );
    }
    try {
      await this._unary("cancel", cancelTripRequest(cancellationToken));
    } catch (exc) {
      if (
        exc instanceof WaymoError &&
        ["DEADLINE_EXCEEDED", "UNAVAILABLE", "UNKNOWN"].includes(exc.code)
      ) {
        throw new WaymoError(
          "cancel",
          "OUTCOME_UNKNOWN",
          "do not retry; check ride status first"
        );
      }
      throw exc;
    }
    const after = await this.status();
    return {
      cancelled: after.active_trip === null,
      trip_id: before.trip_id,
    };
  }

  async _paymentRecords() {
    const now = Date.now();
    if (cachedPayments && now - cachedPayments.ts < 300_000) {
      return cachedPayments.records;
    }
    const records = [];
    const raw = await this._unary("payments");
    for (const block of bytesFields(raw, 2)) {
      const parsed = decode(block);
      if (!parsed || typeof parsed !== "object") continue;
      const methodId = text(parsed["3"]);
      const bookingToken = findHexToken(parsed);
      const details = parsed["1"];
      const lastFour = details && typeof details === "object" ? text(details["2"]) : "";
      if (methodId && bookingToken) {
        records.push({
          booking_token: bookingToken,
          public: {
            id: methodId,
            type: "card",
            label: lastFour ? `Card ending in ${lastFour}` : "Card",
          },
        });
      }
    }
    cachedPayments = { ts: now, records };
    return records;
  }

  _center(biasLat, biasLng) {
    if (
      biasLat === null ||
      biasLat === undefined ||
      biasLng === null ||
      biasLng === undefined
    ) {
      return this.home;
    }
    return [Number(biasLat), Number(biasLng)];
  }
}
function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

export function km(place, center) {
  const lat1 = toRadians(place.latitude);
  const lng1 = toRadians(place.longitude);
  const lat2 = toRadians(center[0]);
  const lng2 = toRadians(center[1]);
  const half =
    Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2;
  return 6371.0 * 2 * Math.asin(Math.sqrt(half));
}

export function deepText(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const res = deepText(child);
      if (res) return res;
    }
    return null;
  }
  if (value instanceof Uint8Array || typeof value === "string") {
    const res = text(value);
    if (res && !res.startsWith("header_")) return res;
    return null;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value)) {
      const res = deepText(child);
      if (res) return res;
    }
  }
  return null;
}

export function normalizeTripId(value) {
  if (/^\d+$/.test(value)) return value;
  try {
    const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
    const decoded = atob(padded);
    const digits = decoded.replace(/\D+/g, "");
    return digits || value;
  } catch {
    return value;
  }
}

export function parseLocation(value) {
  if (!value || typeof value !== "object") return null;
  const desired = value["3"];
  if (!desired || typeof desired !== "object") return null;
  const coords = desired["1"];
  const display = desired["8"] || {};
  if (!coords || typeof coords !== "object") return null;
  const latRaw = Number(coords["1"]);
  const lngRaw = Number(coords["2"]);
  if (!Number.isFinite(latRaw) || !Number.isFinite(lngRaw)) return null;
  const latitude = latRaw * 1e-7;
  const longitude = lngRaw * 1e-7;
  let name = "";
  let address = "";
  if (display && typeof display === "object") {
    name = text(display["1"]);
    let lines = display["2"] ?? [];
    if (!Array.isArray(lines)) lines = [lines];
    address = lines.map((l) => text(l)).filter(Boolean).join(", ");
  }
  return {
    name: name || address,
    address,
    latitude,
    longitude,
  };
}

export function parseActiveTrip(decoded) {
  const trip = decoded && typeof decoded === "object" ? decoded["2"] : null;
  if (!trip || typeof trip !== "object") return null;
  const tripId = text(trip["1"]);
  if (!tripId) return null;
  const plan = trip["5"] && typeof trip["5"] === "object" ? trip["5"] : {};
  const legs = plan["5"];
  let leg = {};
  if (Array.isArray(legs)) {
    leg =
      legs.find((c) => c && typeof c === "object" && c["1"]) ||
      legs[0] ||
      {};
  } else if (legs && typeof legs === "object") {
    leg = legs;
  }
  const state = trip["4"] && typeof trip["4"] === "object" ? trip["4"] : {};
  const stateCode = typeof state["1"] === "number" ? state["1"] : 0;
  const result = {
    trip_id: normalizeTripId(tripId),
    state: TRIP_STATES[stateCode] || `UNKNOWN_${stateCode}`,
    state_code: stateCode,
    pickup: parseLocation(leg["2"]),
    dropoff: parseLocation(leg["3"]),
    tracking_url: text(trip["16"]) || null,
  };
  const pickupEta = leg["4"];
  if (pickupEta && typeof pickupEta === "object") {
    const etaTimestamp = parseTimestamp(pickupEta["1"]);
    if (etaTimestamp !== null) {
      result.pickup_eta_seconds = Math.max(0, Math.round(etaTimestamp - Date.now() / 1000));
      result.pickup_eta_at = new Date(etaTimestamp * 1000)
        .toISOString()
        .replace(".000Z", "+00:00");
    }
  }
  const vehicle = parseVehicle(trip["2"]);
  if (vehicle) result.vehicle = vehicle;
  const arrival = parseArrival(trip["17"]);
  if (arrival) result.arrival = arrival;
  const configurations = plan["3"];
  const scheduledToken =
    configurations && typeof configurations === "object" ? text(configurations["2"]) : "";
  if (scheduledToken) {
    result.scheduled_option_token = scheduledToken;
  }
  return result;
}

export function parseVehicle(value) {
  if (!value || typeof value !== "object") return null;
  const vehicleId = text(value["1"]);
  const licensePlate = text(value["10"]);
  if (!vehicleId && !licensePlate) return null;
  const vehicle = {
    vehicle_id: vehicleId || null,
    license_plate: licensePlate || null,
  };
  const position = value["2"];
  if (position && typeof position === "object") {
    const latRaw = Number(position["1"]);
    const lngRaw = Number(position["2"]);
    if (Number.isFinite(latRaw) && Number.isFinite(lngRaw)) {
      vehicle.position = {
        latitude: latRaw * 1e-7,
        longitude: lngRaw * 1e-7,
      };
    }
  }
  if (typeof value["3"] === "number") {
    vehicle.heading_degrees = value["3"] / 1000;
  }
  if (typeof value["18"] === "number") {
    vehicle.speed_mph = value["18"];
  }
  if (typeof value["8"] === "number") {
    vehicle.type = VEHICLE_TYPES[value["8"]] || `UNKNOWN_${value["8"]}`;
  }
  const reportedAt = parseTimestamp(value["7"]);
  if (reportedAt !== null) {
    vehicle.last_reported_at = new Date(reportedAt * 1000)
      .toISOString()
      .replace(".000Z", "+00:00");
  }
  return vehicle;
}

export function parseArrival(value) {
  if (!value || typeof value !== "object") return null;
  const stateCode = value["1"];
  const position = value["4"];
  if (typeof stateCode !== "number" && (!position || typeof position !== "object")) {
    return null;
  }
  const arrival = {};
  if (typeof stateCode === "number") {
    arrival.state = ARRIVAL_STATES[stateCode] || `UNKNOWN_${stateCode}`;
    arrival.state_code = stateCode;
  }
  if (position && typeof position === "object") {
    const latRaw = Number(position["1"]);
    const lngRaw = Number(position["2"]);
    if (Number.isFinite(latRaw) && Number.isFinite(lngRaw)) {
      arrival.position = {
        latitude: latRaw * 1e-7,
        longitude: lngRaw * 1e-7,
      };
    }
  }
  return Object.keys(arrival).length ? arrival : null;
}

export function parseTimestamp(value) {
  if (!value || typeof value !== "object" || typeof value["1"] !== "number") {
    return null;
  }
  const seconds = value["1"];
  const nanos = typeof value["2"] === "number" ? value["2"] : 0;
  return seconds + nanos / 1_000_000_000;
}

export function findHexToken(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const res = findHexToken(child);
      if (res) return res;
    }
    return null;
  }
  if (value instanceof Uint8Array || typeof value === "string") {
    const candidate = text(value);
    if (/^[0-9a-f]{32}$/.test(candidate)) return candidate;
    return null;
  }
  if (typeof value === "object") {
    for (const child of Object.values(value)) {
      const res = findHexToken(child);
      if (res) return res;
    }
  }
  return null;
}





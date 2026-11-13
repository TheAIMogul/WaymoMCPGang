/**
 * Pure Cloudflare Worker MCP server for Waymo ride management.
 * Implements MCP Streamable HTTP (JSON-RPC 2.0) and exposes all 8 core Waymo tools.
 */

import { WaymoClient, WaymoError, RPC } from "./client.js";
import { callGrpcOverSocket, frameGrpcMessage, unframeGrpcMessages } from "./h2_tls13.js";
import {
  cancelTripRequest,
  createTripRequest,
  parsePlaces,
  parseQuote,
  placeSearchRequest,
  proposeTripRequest,
} from "./wire.js";

const QUOTE_TTL_MS = 10 * 60 * 1000;
const CANCEL_PREVIEW_TTL_MS = 5 * 60 * 1000;

const SERVER_INFO = {
  name: "waymo-rides",
  version: "0.1.0",
};

const SERVER_INSTRUCTIONS =
  "Manage Waymo rides. Resolve ambiguous places and get a quote before " +
  "booking. Only call booking or cancellation tools after explicit user " +
  "authorization. Never retry an OUTCOME_UNKNOWN mutation; check status.";

const quotesStore = new Map();
let cancelPreviewStore = null;

function purgeQuotes() {
  const now = Date.now();
  for (const [token, entry] of quotesStore.entries()) {
    if (now - entry.createdAt > QUOTE_TTL_MS) {
      quotesStore.delete(token);
    }
  }
}

export function compact(value) {
  if (Array.isArray(value)) {
    return value.map((item) => compact(item));
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== null && v !== undefined) {
        out[k] = compact(v);
      }
    }
    return out;
  }
  return value;
}

const TOOLS = [
  {
    name: "waymo_search_places",
    title: "Search Waymo places",
    description: "Resolve a place name or address to canonical Waymo locations.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Place name or address" },
        bias_latitude: {
          type: ["number", "null"],
          minimum: -90,
          maximum: 90,
          default: null,
          description: "Search center latitude; defaults to home",
        },
        bias_longitude: {
          type: ["number", "null"],
          minimum: -180,
          maximum: 180,
          default: null,
          description: "Search center longitude; defaults to home",
        },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "waymo_ride_history",
    title: "Get Waymo ride history",
    description: "Return recent Waymo trips, including cancelled and completed rides.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "waymo_ride_status",
    title: "Get current Waymo ride status",
    description: "Return the active ride and any terminal trip still cached by Waymo.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "waymo_list_payment_methods",
    title: "List Waymo payment methods",
    description: "List safe payment-method labels and IDs accepted by the booking tool.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "waymo_get_quote",
    title: "Get a Waymo ride quote",
    description:
      "Quote an ASAP route, or re-quote using one returned scheduling option.\n\n" +
      "Book before mcp_cache_expires_at (10 minutes). Waymo publishes no expiry " +
      "of its own; if booking reports PROPOSAL_STALE, quote again.",
    inputSchema: {
      type: "object",
      properties: {
        pickup: { type: "string", minLength: 1, description: "Pickup name or address" },
        dropoff: { type: "string", minLength: 1, description: "Dropoff name or address" },
        intermediate_stops: {
          type: ["array", "null"],
          items: { type: "string" },
          maxItems: 3,
          default: null,
          description: "Ordered intermediate stop names or addresses",
        },
        intermediate_stop_result_indices: {
          type: ["array", "null"],
          items: { type: "integer" },
          maxItems: 3,
          default: null,
          description: "Search-result index for each intermediate stop; defaults to 0",
        },
        pickup_result_index: { type: "integer", minimum: 0, default: 0 },
        dropoff_result_index: { type: "integer", minimum: 0, default: 0 },
        passengers: { type: "integer", minimum: 1, maximum: 4, default: 1 },
        scheduled_option_token: {
          type: ["string", "null"],
          default: null,
          description: "Token from a prior quote's scheduled_options; omit for ASAP",
        },
        bias_latitude: {
          type: ["number", "null"],
          minimum: -90,
          maximum: 90,
          default: null,
          description: "Center for place lookups, e.g. when traveling; defaults to home",
        },
        bias_longitude: {
          type: ["number", "null"],
          minimum: -180,
          maximum: 180,
          default: null,
          description: "Center for place lookups, e.g. when traveling; defaults to home",
        },
      },
      required: ["pickup", "dropoff"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "waymo_book_ride",
    title: "Book a Waymo ride",
    description: "Book a quoted ride. Call only after the user explicitly requests booking.",
    inputSchema: {
      type: "object",
      properties: {
        proposal_token: {
          type: "string",
          minLength: 1,
          description: "Token returned by waymo_get_quote",
        },
        payment_method_id: {
          type: "string",
          minLength: 1,
          description: "ID returned by waymo_list_payment_methods",
        },
        confirmation: { type: "string", enum: ["BOOK"] },
      },
      required: ["proposal_token", "payment_method_id", "confirmation"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "waymo_preview_cancellation",
    title: "Preview Waymo ride cancellation",
    description: "Preview cancellation and its fee without cancelling the active ride.",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "waymo_cancel_ride",
    title: "Cancel the active Waymo ride",
    description: "Cancel after a fresh fee preview and explicit user confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        confirmation: { type: "string", enum: ["CANCEL"] },
      },
      required: ["confirmation"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];
async function executeTool(client, name, args = {}) {
  switch (name) {
    case "waymo_search_places": {
      const query = String(args.query || "");
      if (!query.trim()) throw new Error("query is required");
      const limit = args.limit ?? 5;
      const places = await client.searchPlaces(query, {
        biasLat: args.bias_latitude ?? null,
        biasLng: args.bias_longitude ?? null,
        limit,
        mode: args._mode || null,
      });
      return {
        query,
        results: places.map((place, index) => compact(place.public(index))),
      };
    }

    case "waymo_ride_history": {
      const limit = args.limit ?? 20;
      const trips = await client.history(limit);
      return { trips: compact(trips) };
    }

    case "waymo_ride_status": {
      return await client.status();
    }

    case "waymo_list_payment_methods": {
      return { payment_methods: await client.paymentMethods() };
    }

    case "waymo_get_quote": {
      const pickup = String(args.pickup || "");
      const dropoff = String(args.dropoff || "");
      if (!pickup || !dropoff) throw new Error("pickup and dropoff are required");
      const rawQuote = await client.quote(pickup, dropoff, {
        intermediateStopQueries: args.intermediate_stops ?? null,
        intermediateStopIndices: args.intermediate_stop_result_indices ?? null,
        pickupIndex: args.pickup_result_index ?? 0,
        dropoffIndex: args.dropoff_result_index ?? 0,
        passengers: args.passengers ?? 1,
        scheduledOptionToken: args.scheduled_option_token ?? null,
        biasLat: args.bias_latitude ?? null,
        biasLng: args.bias_longitude ?? null,
      });
      const expiresAt = new Date(Date.now() + QUOTE_TTL_MS)
        .toISOString()
        .replace(".000Z", "+00:00");
      const quote = compact({
        ...rawQuote,
        mcp_cache_expires_at: expiresAt,
      });
      quotesStore.set(quote.proposal_token, { createdAt: Date.now(), quote });
      purgeQuotes();
      return quote;
    }

    case "waymo_book_ride": {
      if (args.confirmation !== "BOOK") {
        throw new Error("confirmation must be the literal string 'BOOK'");
      }
      const proposalToken = String(args.proposal_token || "");
      const paymentMethodId = String(args.payment_method_id || "");
      if (!proposalToken) {
        throw new Error("proposal_token is required. Call waymo_get_quote first.");
      }
      // Stateless booking: Waymo itself validates and expires the proposal
      // token, so we do NOT gate on an in-memory cache. Worker isolates don't
      // share memory, so a quote made on one isolate was often missing when
      // booking landed on another -> "unknown proposal token". Pass the token
      // straight through; if it is stale, client.book surfaces Waymo's
      // PROPOSAL_STALE error instead.
      const result = await client.book(proposalToken, paymentMethodId);
      quotesStore.delete(proposalToken);
      return result;
    }

    case "waymo_preview_cancellation": {
      const preview = await client.previewCancel();
      const token = preview._cancellation_token;
      delete preview._cancellation_token;
      if (preview.can_cancel && token) {
        cancelPreviewStore = {
          createdAt: Date.now(),
          tripId: preview.trip_id,
          token,
        };
        preview.preview_expires_at = new Date(Date.now() + CANCEL_PREVIEW_TTL_MS)
          .toISOString()
          .replace(".000Z", "+00:00");
      }
      return preview;
    }

    case "waymo_cancel_ride": {
      if (args.confirmation !== "CANCEL") {
        throw new Error("confirmation must be the literal string 'CANCEL'");
      }
      if (
        !cancelPreviewStore ||
        Date.now() - cancelPreviewStore.createdAt > CANCEL_PREVIEW_TTL_MS
      ) {
        cancelPreviewStore = null;
        throw new Error(
          "No fresh cancellation preview. Call waymo_preview_cancellation first and show its fee to the user."
        );
      }
      const { token, tripId } = cancelPreviewStore;
      const result = await client.confirmCancel(token, tripId);
      cancelPreviewStore = null;
      return result;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

function isAuthorizedRequest(req, env) {
  const expected = (env.MCP_AUTH_TOKEN || "").trim();
  if (!expected) return false;
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (constantTimeEqual(token, expected)) return true;
  }
  const secretHeader = (req.headers.get("x-waymo-mcp-secret") || "").trim();
  if (secretHeader && constantTimeEqual(secretHeader, expected)) return true;
  return false;
}

async function handleJsonRpcMessage(msg, env) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id: msg?.id ?? null,
      error: { code: -32600, message: "Invalid Request" },
    };
  }

  if (msg.id === undefined) {
    return null;
  }

  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        },
      };

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const client = WaymoClient.fromEnv(env);
        const structured = await executeTool(client, toolName, toolArgs);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(structured) }],
            structuredContent: structured,
            isError: false,
          },
        };
      } catch (err) {
        const message =
          err instanceof WaymoError
            ? `${err.code}: ${err.detail}`
            : String(err?.message || err);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: message }],
            isError: true,
          },
        };
      }
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}
async function runDiagnostics(env) {
  const client = WaymoClient.fromEnv(env);
  const md = await client._metadata();
  const placePayload = placeSearchRequest("Brickell City Centre", ...client.home);

  // 1. Test raw-socket TLS 1.3 (ALPN "h2") + HTTP/2 framing on GetPlaceCompletions
  const socketGrpc = await callGrpcOverSocket({
    hostname: "cartrip-pa.googleapis.com",
    port: 443,
    path: RPC.places,
    payload: placePayload,
    authorization: md.authorization,
    userAgent: md["user-agent"],
  });
  const socketPlaces = parsePlaces(socketGrpc.firstMessage);

  // 2. Test Worker fetch() with content-type: application/grpc on GetPlaceCompletions
  const fetchGrpcRaw = await client._streamOnceGrpcFetch("places", placePayload);
  const fetchPlaces = parsePlaces(fetchGrpcRaw);

  // 3. Test Nominatim geocode fallback
  const nominatimPlaces = await client._geocodeNominatim("Brickell City Centre, Miami", 2);

  return {
    ok: true,
    transports: {
      cloudflare_sockets_tls13_h2: {
        negotiated_alpn: socketGrpc.negotiatedAlpn,
        settings_frame_first_9_bytes: socketGrpc.settingsFrame?.slice(0, 9) || null,
        frames_seen: socketGrpc.framesSeen,
        unframed_bytes: socketGrpc.firstMessage.length,
        places_count: socketPlaces.length,
        top_place: socketPlaces[0]?.public(0) || null,
      },
      worker_fetch_native_grpc: {
        unframed_bytes: fetchGrpcRaw.length,
        places_count: fetchPlaces.length,
        top_place: fetchPlaces[0]?.public(0) || null,
        byte_identical_to_socket_h2:
          fetchGrpcRaw.length === socketGrpc.firstMessage.length &&
          fetchGrpcRaw.every((b, i) => b === socketGrpc.firstMessage[i]),
      },
      nominatim_geocode_fallback: {
        places_count: nominatimPlaces.length,
        top_place: nominatimPlaces[0]?.public(0) || null,
      },
    },
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok", server: SERVER_INFO });
    }

    if (!isAuthorizedRequest(req, env)) {
      return Response.json(
        { error: "Unauthorized: valid Bearer token or X-Waymo-MCP-Secret header required" },
        { status: 401 }
      );
    }

    if (url.pathname === "/diagnostics") {
      try {
        return Response.json(await runDiagnostics(env));
      } catch (err) {
        return Response.json({ ok: false, error: String(err?.stack || err) }, { status: 500 });
      }
    }

    if (req.method !== "POST") {
      return Response.json(
        { error: "Method Not Allowed; POST JSON-RPC 2.0 to /mcp" },
        { status: 405 }
      );
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        { status: 400 }
      );
    }

    if (Array.isArray(body)) {
      const responses = (
        await Promise.all(body.map((item) => handleJsonRpcMessage(item, env)))
      ).filter((r) => r !== null);
      if (!responses.length) return new Response(null, { status: 202 });
      return Response.json(responses);
    }

    const response = await handleJsonRpcMessage(body, env);
    if (response === null) {
      return new Response(null, { status: 202 });
    }
    return Response.json(response);
  },
};





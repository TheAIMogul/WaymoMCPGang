# WaymoMCPGang

A [Model Context Protocol](https://modelcontextprotocol.io/) server for managing
Waymo rides, running entirely on a **single Cloudflare Worker** — no container,
no local process, no sidecar. Point any MCP client (or agent) at it and it can
search places, quote and schedule rides, check live ride status, list payment
methods, and book or cancel rides.

> [!WARNING]
> Unofficial. This uses Waymo's private, reverse-engineered rider API. It is not
> affiliated with or endorsed by Waymo, and the API can change without notice.
> Use it only with your own account. Booking and cancelling spend real money.

## How it works

The Worker talks to Waymo's gRPC backend (`cartrip-pa.googleapis.com`) directly
over Cloudflare's HTTP/2 egress — a plain `fetch()` with `content-type:
application/grpc` and length-prefixed framing, no gRPC library. It mints its own
Waymo auth token at runtime from credentials held in Cloudflare Secrets, so no
tokens live in the code. Every request is gated behind a shared secret.

- `src/index.js` — MCP server (JSON-RPC 2.0 over `POST /mcp`) and the 8 tools
- `src/client.js` — the 9 Waymo RPCs over native gRPC / Google's `$rpc` HTTP bridge
- `src/wire.js` — zero-dependency protobuf codec
- `src/auth.js` — mints the Waymo chauffeur token (Android `aas_et` or OAuth flow)
- `src/h2_tls13.js` — optional raw-socket HTTP/2 path (not used by default)

## Tools

`waymo_search_places`, `waymo_ride_history`, `waymo_ride_status`,
`waymo_list_payment_methods`, `waymo_get_quote`, `waymo_book_ride`,
`waymo_preview_cancellation`, `waymo_cancel_ride`.

Booking and cancelling require a literal `confirmation` argument (`"BOOK"` /
`"CANCEL"`), so an agent cannot trigger them by accident.

## Deploy

Requires [`wrangler`](https://developers.cloudflare.com/workers/wrangler/).

```bash
wrangler deploy
```

Then set the secrets (values are never committed — they live only in Cloudflare):

```bash
wrangler secret put MCP_AUTH_TOKEN       # the shared key callers must present
wrangler secret put WAYMO_REFRESH_TOKEN  # your Waymo/Google credential
wrangler secret put WAYMO_ACCOUNT_NAME   # required for an aas_et master token
wrangler secret put WAYMO_HOME_LAT       # default place-search center (optional)
wrangler secret put WAYMO_HOME_LNG
```

Obtaining the Waymo credential is deliberately outside this repo.

## Use

The MCP endpoint is `POST /mcp`, gated by the `MCP_AUTH_TOKEN`:

```
Authorization: Bearer <MCP_AUTH_TOKEN>
```

Example — list the tools:

```bash
curl -s https://<your-worker>.workers.dev/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "content-type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A request without the key returns `401`.

## License

MIT — see [LICENSE](LICENSE).

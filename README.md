# WaymoMCPGang

An unofficial local [Model Context Protocol](https://modelcontextprotocol.io/)
server for Waymo ride management.

It gives an agent eight tools:

- Search Waymo places
- Get ride history
- Get active ride status, including phase, ETA, vehicle, and arrival data
- List safe payment-method labels
- Get immediate or scheduled quotes with up to three intermediate stops
- Book a quoted ride
- Preview a cancellation and its fee
- Cancel the active ride

> [!WARNING]
> This project uses Waymo's private, reverse-engineered rider API. It is not
> affiliated with or endorsed by Waymo. The API can change without notice.
> Review Waymo's terms and use this only with your own account.

## Requirements

- Python 3.11+
- [`uv`](https://docs.astral.sh/uv/getting-started/installation/)
- A Waymo refresh token from your own signed-in account

The server runs locally over stdio. Your credentials are not sent to a hosted
third-party MCP service.

## 1. Configure credentials

The server checks, in order:

1. `WAYMO_REFRESH_TOKEN` and optional `WAYMO_DEVICE_ID`
2. `WAYMO_CREDENTIALS_FILE`
3. `~/.config/waymo/credentials.json`

The default credential file has this shape:

```json
{
  "refresh_token": "your-token",
  "device_id": "your-device-id"
}
```

Two token kinds are supported in `refresh_token`:

- A standard OAuth refresh token (starts with `1//`), refreshed against
  `oauth2.googleapis.com` with the iOS client and then exchanged for a
  chauffeur token.
- A Google master token (starts with `aas_et/`), captured from the Google
  Play Services sign-in of the Android Waymo app on a device you control.
  It is exchanged for a chauffeur-scoped access token via
  `android.clients.google.com/auth` and additionally requires an
  `account_name` field:

```json
{
  "refresh_token": "aas_et/...",
  "account_name": "you@gmail.com"
}
```

Create it locally with file mode `0600`. Credential acquisition is deliberately
outside this MCP package. Never commit a capture, token, or credential file.

## 2. Add the MCP server

Add this to `~/.cursor/mcp.json` for all Cursor projects, or `.cursor/mcp.json`
inside one project:

```json
{
  "mcpServers": {
    "waymo": {
      "type": "stdio",
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/TheAIMogul/WaymoMCPGang",
        "waymo-mcp"
      ]
    }
  }
}
```

Restart or reload MCP servers in your client. Other MCP clients can use the
same stdio command and arguments.

You can give an agent this repository URL and say:

> Add this local stdio MCP server with uvx, then use its Waymo tools:
> https://github.com/TheAIMogul/WaymoMCPGang

## Safe agent behavior

- Resolve ambiguous places before quoting.
- Use result indices to select ambiguous pickup, stop, and dropoff matches.
- For a scheduled ride, quote once to get available times, then quote again
  with the chosen `scheduled_option_token`.
- Before booking, check status, list payment methods, and get a fresh quote.
- Show the canonical pickup, ordered stops, dropoff, and fare before booking.
- Only pass `confirmation: "BOOK"` after the user explicitly asks to book.
- Before cancellation, call `waymo_preview_cancellation` and show any fee.
- Only pass `confirmation: "CANCEL"` after the user explicitly confirms that
  preview.
- Never retry booking or cancellation after `OUTCOME_UNKNOWN`; check status.
- Do not print refresh, chauffeur, proposal, or internal payment tokens to the
  user.

The server reinforces these rules with MCP annotations, literal confirmation
arguments, and a ten-minute in-memory proposal cache. Client annotations are
hints, not an authorization boundary; only connect this server to agents you
trust.

## Development

```bash
git clone https://github.com/TheAIMogul/WaymoMCPGang
cd WaymoMCPGang
uv sync --extra dev
uv run pytest
uv run waymo-mcp
```

The implementation intentionally contains no HTTP server, database, browser
automation, or captured application files. See [SECURITY.md](SECURITY.md)
before reporting a vulnerability.


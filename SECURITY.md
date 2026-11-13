# Security

## Credentials

Run this MCP server locally. A Waymo refresh token grants access to your rider
account and must be treated as a password.

- Never commit Charles captures, refresh tokens, credential files, or `.env`
  files.
- Prefer `~/.config/waymo/credentials.json` with mode `0600`.
- Do not put a refresh token directly in a shared `mcp.json`.
- Revoke the account session if a token may have been exposed.

The MCP tools never return refresh tokens, chauffeur tokens, or internal
payment booking tokens. Quote proposal tokens are returned because the booking
tool needs them; they are short-lived and should not be shown to the user.

## Mutating tools

Booking and cancellation have destructive MCP annotations and require literal
`BOOK` or `CANCEL` confirmation arguments. These controls reduce accidental
calls but do not authenticate a human. Only expose this server to trusted MCP
clients and agents.

Cancellation also requires a fresh server-cached preview. Agents must show the
previewed fee, when Waymo provides one, before requesting confirmation. Raw
cancellation tokens are never returned by the MCP tool.

When a mutation reports `OUTCOME_UNKNOWN`, do not retry it. Check ride status
first to avoid duplicate or conflicting actions.

## Reporting

Please report vulnerabilities privately through GitHub's security advisory
feature. Do not include live credentials, payment data, trip locations, or
capture files in an issue.

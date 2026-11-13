# Security policy

This is a simulator and a research bridge, not flight-certified software.
Never use `sitl/bridge.py` to command real aircraft without your own safety
review.

## Supported versions

Only the `main` branch is supported; there are no tagged releases yet.

## What is in scope

- `sitl/bridge.py`, `sitl/mock_vehicles.py` and `sitl/tak_bridge.py`:
  WebSocket servers that accept vehicle commands (arm, take off, fly, land)
  or CoT for a TAK network, and send telemetry.
- `tools/server.js`: the batch HTTP API.
- The browser page: scenario, capture and preset files it loads are
  untrusted input.

## Threat model

- All three WebSocket servers and the batch API bind loopback
  (`localhost` / `127.0.0.1`) by default.
- A web page open in the operator's browser can still reach a loopback
  WebSocket (cross-site WebSocket hijacking). The servers therefore refuse,
  with HTTP 403, any handshake whose `Origin` is not the sim's own: http(s)
  on `localhost` / `127.0.0.1` / `[::1]` (any port), `file://` (`null`), the
  GitHub Pages demo (`https://dalailalama.github.io`), or one added with the
  repeatable `--allow-origin ORIGIN` (`--allow-origin '*'` turns the check
  off). A page served from any other host, such as `http://<box>:8000` on
  the LAN, is refused until its origin is added. See `sitl/ws_origin.py`.
- Admitting `null` is what lets a page opened from `file://` connect, but a
  sandboxed iframe on any site also sends `Origin: null` and passes the
  check. If other pages open in the operator's browser are not trusted, use
  `--token`.
- The Origin check does not stop a non-browser client, which can send any
  `Origin`, or none: a handshake with no `Origin` header is treated as a
  non-browser tool and admitted. With `--token SECRET` (or `$BRIDGE_TOKEN`), a
  handshake must also carry `?token=SECRET` in its URL, or it gets HTTP 401.
  Put the token in the sim's Bridge URL field, e.g.
  `ws://host:8765/?token=SECRET`. A server bound beyond loopback
  (`--ws-host 0.0.0.0`; `--host` for `mock_vehicles.py`) with no token
  generates one and prints it, because every host on that network is such a
  client.
- `ws://` is plaintext, token included. Beyond a trusted LAN, use an SSH or
  VPN tunnel, or a TLS (`wss://`) proxy.
- Anyone who holds the token, or who can reach a loopback server from the
  same machine, can command the fleet. Treat the bridge host as part of the
  vehicles' control link.

Do not expose the bridges or the batch API to an untrusted network.

## Reporting a vulnerability

Please do not open a public issue with exploit details. Use GitHub's
private vulnerability reporting ("Report a vulnerability" on the repository's
Security tab). If that is unavailable, open an issue asking for a private
contact and leave the details out.

Include the commit, the component, and the smallest input (scenario JSON,
bridge message or HTTP request) that reproduces the problem.

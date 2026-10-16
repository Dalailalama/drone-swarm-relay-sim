# Security policy

This is a simulator and a research bridge, not flight-certified software.
Never use `sitl/bridge.py` to command real aircraft without your own safety
review.

## Supported versions

Only the `main` branch is supported; there are no tagged releases yet.

## What is in scope

- `sitl/bridge.py` and `sitl/tak_bridge.py`: WebSocket servers that accept
  commands and telemetry. `bridge.py` binds `localhost` by default;
  `tak_bridge.py` binds all interfaces.
- `tools/server.js`: the batch HTTP API, which listens on all interfaces.
- The browser page: scenario, capture and preset files it loads are
  untrusted input.

Do not expose the bridges or the batch API to an untrusted network.

## Reporting a vulnerability

Please do not open a public issue with exploit details. Use GitHub's
private vulnerability reporting ("Report a vulnerability" on the repository's
Security tab). If that is unavailable, open an issue asking for a private
contact and leave the details out.

Include the commit, the component, and the smallest input (scenario JSON,
bridge message or HTTP request) that reproduces the problem.

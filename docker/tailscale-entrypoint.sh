#!/usr/bin/env bash
# Starts Tailscale (userspace networking, no root needed) and publishes the server on the tailnet,
# then runs the app. Skipped entirely when TS_STATE_DIR is unset.
#   TS_STATE_DIR  folder for tailscaled state (persist it; reuse it to keep the same machine/name)
#   TS_HOSTNAME   tailnet name (default: open-parcels)
#   TS_AUTHKEY    only needed on first start, when the state folder is empty
#   TS_SERVE_PORT local port to publish (default: $OPENPARCELS_PORT or 3000)
set -euo pipefail

if [[ -z "${TS_STATE_DIR:-}" ]]; then
  exec "$@"
fi
if [[ ! -w "$TS_STATE_DIR" ]]; then
  echo "[ts] $TS_STATE_DIR is not writable for uid $(id -u): the server runs without the tailnet." \
    "Make the folder or volume writable for uid 1000." >&2
  exec "$@"
fi

# `tailscale serve` proxies every tailnet visitor from 127.0.0.1 and names the real address in
# X-Forwarded-For: trust it, unless the user chose otherwise, so the sign-in throttle tells
# tailnet visitors apart.
export OPENPARCELS_TRUST_PROXY="${OPENPARCELS_TRUST_PROXY:-127.0.0.1}"
sock=/tmp/tailscaled.sock
port="${TS_SERVE_PORT:-${OPENPARCELS_PORT:-3000}}"
ts() { tailscale --socket="$sock" "$@"; }
# Up, or waiting for a login: either way the daemon answers.
answering() { ts status >/dev/null 2>&1 || ts status --json 2>/dev/null | grep -q '"BackendState": "NeedsLogin"'; }

echo "[ts] starting tailscaled (userspace) with state in $TS_STATE_DIR"
# Its log goes to the container's stderr, which Docker's log driver rotates.
tailscaled --tun=userspace-networking --statedir="$TS_STATE_DIR" --socket="$sock" \
  --no-logs-no-support >&2 &
tailscaled_pid=$!

# tailscaled offers no readiness signal: ask its socket, giving up at once if it exited.
for _ in $(seq 60); do
  answering && break
  if ! kill -0 "$tailscaled_pid" 2>/dev/null; then
    echo "[ts] tailscaled exited: the server runs without the tailnet" >&2
    break
  fi
  sleep 1
done

if kill -0 "$tailscaled_pid" 2>/dev/null && ! ts status >/dev/null 2>&1; then
  if [[ -n "${TS_AUTHKEY:-}" ]]; then
    echo "[ts] logging in as ${TS_HOSTNAME:-open-parcels}"
    # The key goes through a private file, never the command line other processes can read.
    keyfile=/tmp/ts-authkey
    (umask 077 && printf '%s' "$TS_AUTHKEY" >"$keyfile")
    status=0
    ts up --auth-key="file:$keyfile" --hostname="${TS_HOSTNAME:-open-parcels}" \
      --accept-dns=false || status=$?
    rm -f "$keyfile"
    if [[ "$status" -ne 0 ]]; then
      echo "[ts] tailscale up failed (exit $status)" >&2
    fi
  else
    echo "[ts] not logged in and no TS_AUTHKEY set: the server runs without the tailnet" >&2
  fi
fi

if ts status >/dev/null 2>&1; then
  if ts serve --bg --https=443 "http://127.0.0.1:$port" >/dev/null &&
    ts serve --bg --http=80 "http://127.0.0.1:$port" >/dev/null; then
    name=$(ts status --json | sed -n 's/.*"DNSName": "\([^"]*\)\.".*/\1/p' | head -1)
    echo "[ts] serving http://127.0.0.1:$port on $name"
  else
    echo "[ts] tailscale serve failed: the server is not published on the tailnet" >&2
  fi
else
  echo "[ts] not connected: the server is not published on the tailnet" >&2
fi

# tini signals only its child, this shell: pass a stop on to the server and to tailscaled, so
# neither is killed hard.
"$@" &
app_pid=$!
trap 'kill -TERM "$app_pid" "$tailscaled_pid" 2>/dev/null || true' TERM INT
status=0
wait "$app_pid" || status=$?
# A stop signal interrupts the first wait; wait again for the server to finish shutting down.
if kill -0 "$app_pid" 2>/dev/null; then
  wait "$app_pid" || status=$?
fi
kill -TERM "$tailscaled_pid" 2>/dev/null || true
wait "$tailscaled_pid" 2>/dev/null || true
exit "$status"

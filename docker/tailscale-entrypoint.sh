#!/bin/sh
# Starts Tailscale (userspace networking, no root needed) and publishes the app on the tailnet,
# then runs the app. Skipped entirely when TS_STATE_DIR is unset.
#   TS_STATE_DIR  folder for tailscaled state (persist it; reuse it to keep the same machine/name)
#   TS_HOSTNAME   tailnet name (default: open-parcels)
#   TS_AUTHKEY    only needed on first start, when the state folder is empty
#   TS_SERVE_PORT local port to publish (default: $OPENPARCELS_PORT or 3000)
set -eu

if [ -n "${TS_STATE_DIR:-}" ]; then
    sock=/tmp/tailscaled.sock
    port="${TS_SERVE_PORT:-${OPENPARCELS_PORT:-3000}}"
    ts() { tailscale --socket="$sock" "$@"; }

    echo "[ts] starting tailscaled (userspace) with state in $TS_STATE_DIR"
    tailscaled --tun=userspace-networking --statedir="$TS_STATE_DIR" --socket="$sock" \
        --no-logs-no-support >/tmp/tailscaled.log 2>&1 &

    i=0
    until ts status >/dev/null 2>&1 || [ "$(ts status --json 2>/dev/null | grep -c '"BackendState": "NeedsLogin"')" = 1 ]; do
        i=$((i + 1))
        [ "$i" -ge 60 ] && { echo "[ts] tailscaled did not come up; see /tmp/tailscaled.log"; break; }
        sleep 1
    done

    if ! ts status >/dev/null 2>&1; then
        if [ -n "${TS_AUTHKEY:-}" ]; then
            echo "[ts] logging in as ${TS_HOSTNAME:-open-parcels}"
            ts up --authkey="$TS_AUTHKEY" --hostname="${TS_HOSTNAME:-open-parcels}" --accept-dns=false || true
        else
            echo "[ts] not logged in and no TS_AUTHKEY set: app runs without the tailnet"
        fi
    fi

    if ts status >/dev/null 2>&1; then
        ts serve --bg --https=443 "http://127.0.0.1:$port" >/dev/null &&
            ts serve --bg --http=80 "http://127.0.0.1:$port" >/dev/null &&
            echo "[ts] serving http://127.0.0.1:$port on $(ts status --json | sed -n 's/.*"DNSName": "\([^"]*\)\.".*/\1/p' | head -1)" ||
            echo "[ts] tailscale serve failed"
    fi
fi

exec "$@"

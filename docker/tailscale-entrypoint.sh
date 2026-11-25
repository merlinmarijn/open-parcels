#!/usr/bin/env bash
# Starts Tailscale (userspace networking, no root needed) and publishes the server on the tailnet,
# then runs the server. Skipped entirely when TS_STATE_DIR is unset.
#
# Tailscale is not in the image (decision record 0004 §3.1): the first start with TS_STATE_DIR set
# downloads the pinned release for this architecture from pkgs.tailscale.com, checks it against the
# SHA-256 pinned below (never trusting what it downloaded) and keeps it in
# $OPENPARCELS_DATA_DIR/tailscale/<version>/. Later starts reuse it; an image that pins a newer
# version fetches that one and removes the old. Without internet, place the release archive
# (tailscale_<version>_<arch>.tgz) in $OPENPARCELS_DATA_DIR/tailscale/ by hand: it is checked the same way.
#   TS_STATE_DIR  folder for tailscaled state (persist it; reuse it to keep the same machine/name)
#   TS_HOSTNAME   tailnet name (default: open-parcels)
#   TS_AUTHKEY    only needed on first start, when the state folder is empty
#   TS_SERVE_PORT local port to publish (default: $OPENPARCELS_PORT or 3000)
set -euo pipefail

# Bump all three together (release step, AGENT.md): the hashes are pkgs.tailscale.com's .sha256 files,
# checked against a download.
TS_VERSION=1.104.7
TS_SHA256_amd64=e56693ff74a64f2591b7e819c280635a100aae1ddfb0ef058fcd052b7cd8d16c
TS_SHA256_arm64=d6bed2720310b328b861f943d7b4016c5358a9bad60575eb51e8143b79068484

if [[ -z "${TS_STATE_DIR:-}" ]]; then
  exec "$@"
fi

# Puts the pinned tailscale and tailscaled into $ts_bin; returns non-zero (and says why) when it cannot.
install_tailscale() {
  local arch sha_var sha cache archive tmp
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "[ts] no pinned Tailscale build for $(uname -m)" >&2; return 1 ;;
  esac
  sha_var="TS_SHA256_$arch"
  sha=${!sha_var}
  cache="${OPENPARCELS_DATA_DIR:-/data}/tailscale"
  ts_bin="$cache/$TS_VERSION"
  [[ -x "$ts_bin/tailscaled" && -x "$ts_bin/tailscale" ]] && return 0
  archive="$cache/tailscale_${TS_VERSION}_${arch}.tgz"
  mkdir -p "$cache"
  if [[ ! -f "$archive" ]]; then
    echo "[ts] downloading Tailscale $TS_VERSION ($arch)"
    # The image has no curl: Node's fetch, with a time limit, writing only on success.
    if ! node -e '
      const [url, file] = process.argv.slice(1);
      fetch(url, { signal: AbortSignal.timeout(120000) })
        .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); })
        .then((body) => require("node:fs").writeFileSync(file, body))
        .catch((e) => { console.error(`[ts] download failed: ${e.message}`); process.exit(1); });
    ' "https://pkgs.tailscale.com/stable/tailscale_${TS_VERSION}_${arch}.tgz" "$archive.part"; then
      rm -f "$archive.part"
      return 1
    fi
    mv "$archive.part" "$archive"
  fi
  if [[ "$(sha256sum "$archive" | cut -d' ' -f1)" != "$sha" ]]; then
    echo "[ts] $archive does not match the pinned SHA-256: removed, not used" >&2
    rm -f "$archive"
    return 1
  fi
  tmp=$(mktemp -d "$cache/.unpack.XXXXXX")
  if ! tar -xzf "$archive" -C "$tmp" --strip-components=1 \
    "tailscale_${TS_VERSION}_${arch}/tailscale" "tailscale_${TS_VERSION}_${arch}/tailscaled"; then
    echo "[ts] $archive could not be unpacked" >&2
    rm -rf "$tmp"
    return 1
  fi
  # Only this version stays: older ones and the archive go.
  find "$cache" -mindepth 1 -maxdepth 1 ! -path "$tmp" -exec rm -rf {} +
  mv "$tmp" "$ts_bin"
  echo "[ts] Tailscale $TS_VERSION installed in $ts_bin"
}
if [[ ! -w "$TS_STATE_DIR" ]]; then
  echo "[ts] $TS_STATE_DIR is not writable for uid $(id -u): the server runs without the tailnet." \
    "Make the folder or volume writable for uid 1000." >&2
  exec "$@"
fi

if ! install_tailscale; then
  echo "[ts] Tailscale is not available: the server runs without the tailnet" >&2
  exec "$@"
fi

# `tailscale serve` proxies every tailnet visitor from 127.0.0.1 and names the real address in
# X-Forwarded-For: trust it, unless the user chose otherwise, so the sign-in throttle tells
# tailnet visitors apart.
export OPENPARCELS_TRUST_PROXY="${OPENPARCELS_TRUST_PROXY:-127.0.0.1}"
sock=/tmp/tailscaled.sock
port="${TS_SERVE_PORT:-${OPENPARCELS_PORT:-3000}}"
ts() { "$ts_bin/tailscale" --socket="$sock" "$@"; }
# Up, or waiting for a login: either way the daemon answers.
answering() { ts status >/dev/null 2>&1 || ts status --json 2>/dev/null | grep -q '"BackendState": "NeedsLogin"'; }

echo "[ts] starting tailscaled (userspace) with state in $TS_STATE_DIR"
# Its log goes to the container's stderr, which Docker's log driver rotates.
"$ts_bin/tailscaled" --tun=userspace-networking --statedir="$TS_STATE_DIR" --socket="$sock" \
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

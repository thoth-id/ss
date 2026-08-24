# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`tela` — browser-to-browser screen sharing (no audio) for a small group inside a
Tailscale tailnet. Bun + TypeScript, **zero dependencies**, no build step, no
`npm install`. Three source files total.

`PLANO.md` is the authoritative spec and task list. Read it before changing
behavior — it records why each design decision exists, and section 5 lists
invariants that must not be broken.

Code comments, UI strings and `PLANO.md` are in Brazilian Portuguese. Match that
when editing.

## Commands

```bash
bun run server.ts          # HTTP+WS on :3000, STUN on UDP :3478
```

Tests need a live server. Background processes from a separate tool invocation
do not survive, so start the server and run the suite in **one** shell command:

```bash
(bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); sleep 2; \
  timeout 90 bun run test.ts; kill $(cat /tmp/p)
```

`test.ts` is a hand-rolled suite (74 assertions), not `bun test`. There is **no
filter flag** — to run a subset, comment out entries in the `/* ---------- run
---------- */` block at the bottom of `test.ts`.

Serving over HTTPS (required for real use, see below):

```bash
tailscale serve --bg 3000   # persists across restarts; only the Bun process needs restarting
```

## Architecture

```
server.ts        Bun.serve: static files + /config + WebSocket signaling + room/sharer state
stun.ts          ~50-line STUN server (node:dgram), Binding Request → XOR-MAPPED-ADDRESS
public/index.html  the entire client: HTML + CSS + JS in one file
test.ts          headless suite (no browser)
```

The server does exactly three things: serve static files, relay signaling
opaquely, answer STUN. **It never touches media.** Media is peer-to-peer.

### Signaling protocol

JSON over WebSocket at `/ws`, discriminated by `t`. Full wire format is in
`README.md` and `PLANO.md` section 4.

The server **never inspects `msg.data`** — it only routes it to `msg.to`. This is
what allows the WebRTC negotiation to change without touching the backend. Do
not add validation, logging or transformation of `data`.

### Directional PeerConnections

The client keeps **two separate maps**, `sending` and `receiving`, keyed by peer
id. A bidirectional PC never exists. Because each PC has exactly one offerer,
there is no glare and perfect negotiation is unnecessary. ICE candidates carry
`dir: "tx" | "rx"` (sender's point of view, inverted on receipt) to disambiguate
which of the two PCs they belong to. Candidates arriving before
`setRemoteDescription` queue on `pc.pending`.

Do not unify these maps.

### The server is the arbiter

`MAX_PEERS` and `MAX_SHARERS` are constants at the top of `server.ts`, and the
server owns both decisions — it is the only place that sees a whole room, so
simultaneous clicks on different machines are only serializable there. Changing
`MAX_SHARERS` to 1 requires editing only that number.

`sharers` broadcast is **state-based, not event-based**: the full set goes to the
whole room on every change, plus a snapshot to each peer on join. That makes it
idempotent and survives reconnect without the client reconstructing state from
deltas. Clients tear down a tile and its receiving PC the moment an id leaves the
set, rather than waiting for `connectionstatechange`.

The socket `close` handler must free the sharer slot — that is the tab-close path.

### Client reconnect

The WebSocket reconnects every 1.5s. On `joined`, if `myId` changed, the client
closes and clears all PCs and tiles before reopening, then re-requests its sharer
slot (the server dropped the old id on close). A `denied` message sets a `dead`
flag that stops the reconnect loop — without it, a full room becomes a busy loop.

## Two things that will bite you

**Secure context.** `getDisplayMedia` only exists in a secure context.
`http://100.x.y.z:3000` is **not** one, so the API is absent from
`navigator.mediaDevices` and sharing is impossible. `localhost` and `https://`
are. Note `localhost` only helps the machine running the server — remote viewers
must use HTTPS. `tailscale serve` provides a real Let's Encrypt cert, but the
tailnet needs HTTPS enabled first (admin console → **DNS → Enable HTTPS**);
without it `tailscale cert` fails and `serve` cannot issue a cert. Never
substitute a self-signed cert.

**Why a STUN server exists here.** Chrome replaces private-IP host candidates
with mDNS `.local` names, and Tailscale's CGNAT range (100.64/10) counts as
private. mDNS needs multicast, which does not cross the tailnet, so those
candidates die silently. The local STUN returns the `100.x` as an `srflx`
candidate, which is not obfuscated. `tailscale serve` proxies TCP/HTTP only and
does **not** cover STUN — peers hit `100.x:3478` directly, so it must stay bound
on `0.0.0.0:3478`.

## Verification status

Signaling, room limits, sharer arbitration and the STUN wire format are covered
headless by `test.ts`. **WebRTC is not**, and cannot be here — no browser, no
second machine. The client JS can only be syntax-checked:

```bash
python3 -c "import re;h=open('public/index.html').read();open('/tmp/c.js','w').write(re.search(r'<script>(.*)</script>',h,re.S).group(1))" && node --check /tmp/c.js
```

ICE over `100.x` **has been exercised once**, over `tailscale serve` HTTPS: video
flowed at 979 kb/s, 1920×1200, 30fps, on a `prflx` candidate pair at 15ms RTT.

`prflx` (peer-reflexive) is a **direct** path — the candidate was learned during
connectivity checks instead of being gathered up front, which is what you expect
when WireGuard delivers packets from an address that was not in the gathered set.
`PLANO.md` T0 anticipated `host` or `srflx` and never listed `prflx`, but it
satisfies the intent: direct, no TURN, no relay.

Still open: that run was **not confirmed to be cross-machine** rather than two
tabs on the host, so re-verify with two distinct tailnet machines. Read the path
field in each tile's telemetry strip — `relay` would mean the STUN path failed.

## Do not trust this claim

An earlier version of the README asserted that identical encoding parameters
across peers make Chrome reuse a single encoder instance instead of one per
connection. **That is unverified and probably wrong** — the usual behavior is one
encoder per PeerConnection. Do not use it as a basis for capacity decisions. If
it matters, measure CPU with 4 destinations against 1.

## Out of scope

Do not implement without an explicit request: audio, chat, recording, an SFU,
TURN, authentication, Tailscale Funnel, persistence, or more than 5 peers.

There is no authentication, and that is deliberate — **the tailnet is the auth
layer**. Do not add Funnel, port forwarding or a public bind without real auth
first. Outside the tailnet peers also stop sharing a network, which breaks the
STUN premise and would require TURN.

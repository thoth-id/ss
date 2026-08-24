# tela

Browser-to-browser screen sharing, no audio, for a small group on a network you
already trust (a Tailscale tailnet, for instance). No TURN, no SFU, no accounts,
no media server. The server does three things: serve the page, relay signaling,
answer STUN. The video goes straight from one browser to another.

Published on npm as **`@thoth-dev/screen-share`**.

## Install and run

Needs [Bun](https://bun.sh) on the machine that runs the server. The package
ships `bin/cli.ts`, `server.ts` and `stun.ts` exactly as written, with no build
step and no `dist/`, and Bun runs them directly.

```bash
bunx @thoth-dev/screen-share
```

That brings up HTTP plus the signaling WebSocket on `:3000`, and STUN on UDP
`:3478`. `npx @thoth-dev/screen-share` also works **if** Bun is already
installed on the machine. Without Bun the shebang (`#!/usr/bin/env bun`) fails
with `env: bun: No such file or directory`, which is terse but names what is
missing.

Then, on the same machine:

```bash
tailscale serve --bg 3000
```

This publishes `https://<machine>.<tailnet>.ts.net` with a real Let's Encrypt
certificate, reachable only from inside the tailnet. **This step is not
optional:** `getDisplayMedia` exists only in a secure context, so serving on
`http://100.64.x.y:3000` makes the API disappear from `navigator.mediaDevices`.

`tailscale serve` needs HTTPS enabled on the tailnet first (admin console,
**DNS → Enable HTTPS**). Without it, `tailscale cert` answers `HTTPS cert
support is not enabled` and serve never comes up.

STUN runs on UDP 3478 directly on the tailnet IP, outside `tailscale serve`,
which proxies TCP only. If your tailnet has restrictive ACLs, open 3478/udp.

## Flags and configuration

```bash
bunx @thoth-dev/screen-share [flags]
```

| flag | env | default | what it does |
|---|---|---|---|
| `-p, --port <n>` | `PORT` | 3000 | HTTP and signaling WebSocket |
| `--stun-port <n>` | `STUN_PORT` | 3478 | STUN UDP port |
| `--peers <n>` | `MAX_PEERS` | 5 | peers per room; the 6th gets `denied` and stays out |
| `--sharers <n>` | `MAX_SHARERS` | 3 | how many transmit at once; the 4th attempt gets `share-denied` |
| `--pixels <n>` | `MAX_CAPTURE_PIXELS` | 1440000 | capture pixel budget (1600×900) |
| `--bg` | | | run in the background |
| `--stop` | | | stop whatever runs in the background on the same port |
| `-h, --help` | | | print the help |
| `-v, --version` | | | print the version |

The CLI only forwards these to `server.ts` through the environment, which keeps
`bun run server.ts` working on its own, with the same variables and no CLI in
the loop. `GET /config` hands `stunPort`, `maxPeers`, `maxSharers` and
`maxCapturePixels` to the client, so no limit is duplicated in the HTML.

The server stays the sole authority over the room limits. It is the only place
that sees a whole room, so two simultaneous clicks on different machines can
only be serialized there.

### Background mode

With `--bg`, the pidfile and the log live in `$XDG_RUNTIME_DIR/screen-share/`,
as `screen-share-<port>.pid` and `screen-share-<port>.log`. Without
`XDG_RUNTIME_DIR` they fall back to a `screen-share-<uid>/` directory inside the
temp dir, created with mode 0700 and refused if it belongs to somebody else. Not
`$TMPDIR` itself, on purpose: its 1777 mode lets any user on the machine plant a
pidfile in the path. The command reports success only once the child's own
`/config` answers, which means after it actually bound the port, not merely
after it was spawned. `--stop --port <n>` kills whatever that pidfile registers.

## Rooms

The room comes from the URL hash: `/#retro`, `/#pair`. With no hash it falls
back to `sala`.

## Why there is a STUN server here

Chrome hides private-IP host candidates behind mDNS names (`.local`), and a
Tailscale address falls in the CGNAT range 100.64/10, which it treats as
private. mDNS needs multicast, multicast does not cross the tailnet, the remote
peer never resolves the name, and ICE fails in silence.

A STUN server inside the tailnet returns the peer's 100.x as an srflx candidate,
which is not obfuscated. It is about 50 lines in `stun.ts`, and it is what makes
the thing connect.

## Topology

Star per sharer, not mesh. Whoever shares opens one `RTCPeerConnection` per
viewer. With 1 sharer and 4 viewers that is 4 connections and an upload of
4 × bitrate. `CAP_BITRATE` is 1.5 Mbps per peer, so roughly 6 Mbps of upload
with 4 viewers.

PeerConnections are **directional**: `sending` and `receiving` are separate maps
and a bidirectional PC never exists. Each PC has exactly one offerer, which
removes glare and makes perfect negotiation unnecessary. Do not unify the two
maps.

### The sharer's CPU cost is a step, not a curve

There is **one encoder per PeerConnection**, and that was measured. With 4
destinations, capturing at 1920×1080 eats 10.1 cores out of 12 and delivers 6 to
9 fps, while 1600×900 costs 2.0 cores at a full 30 fps. Even 1856×1044, only 7%
fewer pixels than 1080p, already drops to 3.8 cores.

The cause is thread oversubscription, not pixel cost. WebRTC gives each
PeerConnection around 8 encode threads at 1920×1080 and above, around 3 below
it. Counted in `/proc`, the sharer's renderer carries 51 threads at 1920×1080
against 33 at 1600×900. Four encoders means 32 encode threads fighting over 12
logical CPUs.

That is why the capture budget exists (`--pixels`, 1,440,000 by default). The
client scales the captured track down to fit the budget while preserving the
screen's real aspect ratio, so 1920×1200 becomes 1518×948. The cut happens
**once at the source**, not once per connection: the N encoders all read the
same track. Any new budget has to stay below 1920×1080 pixels (2,073,600) or the
step comes back.

### Which limit governs what

With `--sharers 3` the room's worst case is 3 sharers × 4 destinations = 12
PeerConnections. But notice which limit drives which cost. **A sharer opens one
PC per destination, that is `--peers - 1` = 4 encoders**, and that number does
not change when a second or third person also starts transmitting. What
`--sharers` controls is how many streams each machine *decodes*, and decoding is
cheap: 0.18 core per stream, measured. That is why the cap went from 2 to 3. The
fear was CPU and it was pointed at the wrong axis.

What still deserves care is the number of people in the room, not the number of
transmitters. If `--peers` ever grows much, it turns into N² and you need an SFU
(mediasoup, LiveKit).

## Protocol

JSON over WebSocket at `/ws`, discriminated by `t`.

Client to server:

```jsonc
{ "t": "join",   "room": "sala", "name": "gabriel" }   // name is optional
{ "t": "rename", "name": "gabriel" }
{ "t": "signal", "to": "<peerId>", "data": { /* opaque */ } }
{ "t": "share-start" }
{ "t": "share-stop" }
```

Server to client:

```jsonc
{ "t": "joined",       "id": "<myId>", "peers": ["<id>", ...] }
{ "t": "denied",       "reason": "room-full" }
{ "t": "peer-joined",  "id": "<id>" }
{ "t": "peer-left",    "id": "<id>" }
{ "t": "names",        "map": { "<id>": "gabriel", ... } }
{ "t": "sharers",      "ids": ["<id>", ...] }
{ "t": "share-denied", "reason": "limit" }
{ "t": "signal",       "from": "<id>", "data": { /* opaque */ } }
```

`sharers` is a **state-based** broadcast: the whole set goes out on every
change, plus a snapshot for whoever just joined. That makes it idempotent, it
survives a reconnect, and the client never has to rebuild state from deltas. An
id that leaves the set has its tile and its PC torn down at once, without
waiting for `connectionstatechange`.

`names` follows the same idea and is **derived from the sockets**: the name
lives on the peer's socket rather than in a separate `Map`, and the published
map is built by walking the room at publish time. Leaving the room erases the
name by itself, with no second cleanup path to drift from `close`. A name is
optional and purely cosmetic, so whoever picks none shows up by id. The server
collapses whitespace, trims, and cuts at 24 characters. A name that is empty
after that gets no entry in the map, which is also how you erase your own.

The server **never** looks inside `data`. That rule is what allows the
negotiation to change without touching the backend. The name travels in a field
of its own (`join`/`rename`) for the same reason, never inside `data`.

## Security

There is no authentication, and that is deliberate: **the tailnet is the auth
layer**. Do not add Funnel, port forwarding or a public bind without real auth
first. Outside the tailnet, peers also stop sharing a network, which breaks the
STUN premise and starts requiring TURN.

## The interface

The UI is in Brazilian Portuguese, so the labels below are quoted as they
appear.

- The telemetry strip under each tile shows bitrate, resolution, fps, candidate
  type and RTT. `host` instead of `srflx` means both peers are on the same
  physical LAN and STUN was never needed.
- On your own tile the strip shows the **captured** resolution. If the encoder
  is sending less than that, the real resolution appears beside it
  (`1600×900 → 640×360 bandwidth`): a correct capture with the output one rung
  down is the whole diagnosis. And if the encoding policy did not take in your
  browser, `política recusada` or `política não confirmada` shows up in place of
  the path field. Without that policy the encoder trades resolution for
  framerate and walks down a ladder that takes tens of seconds to climb back, if
  it climbs at all.
- The bar meter is the last minute of bitrate, one bar per second. A link going
  bad shows up there before the instantaneous number explains why. On a wide
  tile it sits at the end of the telemetry line; on a narrow one it takes a
  full-width band just above it.
- The `eu/` field in the header is your name in the room: optional, up to 24
  characters, kept in the browser's `localStorage` and resent on reconnect.
  Leave it blank and you show up by id. It is a label and nothing more, with no
  login or identity behind it.
- Anyone in the room who is not transmitting appears on a plate with the initial
  of their name, in a rail below the screens. Whoever picked no name shows `_`
  and the id, because ids are hex and the initial of `3f9a1b2c` is nobody.
  Whoever asked to share and is still negotiating shows up as `conectando…`. The
  rail has a height cap on purpose: a plate carries almost no information per
  pixel, and the stage is video area. With nobody transmitting, the plates
  inherit the stage.
- Click a screen (or its `focar` button) to give it the whole stage; the others
  become thumbnails in a rail, presence plates included. `esc` leaves focus.
  `tela cheia` uses the browser's fullscreen API and hides the interface.
- The page never scrolls. The stage takes the height that is left and every tile
  is fitted inside it at the real aspect ratio of the shared screen. Nothing is
  cropped.

## Tuning worth knowing about

- `contentHint = "detail"` is already set: it favors text sharpness over
  smoothness. To share video instead of code, switch it to `"motion"`.
- `degradationPreference = "maintain-resolution"` holds the resolution and drops
  the framerate under pressure. For code that is what you want. Switching to
  `"balanced"` was measured and does **not** relieve CPU with several
  destinations (10.4 cores against 10.1); lowering the framerate was measured
  too and makes it **worse** (11.2 cores at 15fps). The pixel budget is what
  actually helps.
- Raising `--pixels` past 2,073,600 brings back the CPU collapse described under
  Topology.

## Testing (from a clone of the repository)

```bash
(bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); sleep 2; \
  timeout 90 bun run test.ts; kill $(cat /tmp/p)
```

Covers static files, signaling, the room cap, sharer arbitration and the STUN
wire format, all headless, with no browser. **WebRTC is not covered:** ICE
closing over 100.x addresses can only be verified with two real machines on the
tailnet and `chrome://webrtc-internals`.

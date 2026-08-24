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

`test.ts` is a hand-rolled suite (75 assertions), not `bun test`. There is **no
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

`MAX_CAPTURE_PIXELS` lives there too and is served by `/config`. It is the
capture pixel budget: the client scales the captured track down to fit it,
preserving the screen's real aspect ratio, so 1920×1200 becomes 1518×948. The
cut happens **once at the source, not once per PeerConnection** — all N encoders
read the same track. See the measured numbers below for why the budget is
1,440,000 and not something larger.

`sharers` broadcast is **state-based, not event-based**: the full set goes to the
whole room on every change, plus a snapshot to each peer on join. That makes it
idempotent and survives reconnect without the client reconstructing state from
deltas. Clients tear down a tile and its receiving PC the moment an id leaves the
set, rather than waiting for `connectionstatechange`.

The socket `close` handler must free the sharer slot — that is the tab-close path.

### Client layout is computed in JS, on purpose

`main` is a fixed-height stage (`flex: 1; min-height: 0; overflow: hidden`) and
`layout()` positions every tile inside it in pixels. The page never scrolls.

The old CSS grid sized tiles by width alone (`width: 100%` + `aspect-ratio:
16/9`), so on a wide window a single tile grew taller than the viewport, the body
scrolled and the telemetry strip fell below the fold. Do not put it back.

Three things the math depends on:

- **`STRIP = 40` must equal the CSS strip height** (`.wave` 16 + `.fields` 24).
  Tile borders are `box-shadow: inset` and not real borders precisely so they add
  no height — a 1px border would make every tile overflow its slot by 2px.
- **Rows are justified**: every tile in a row shares one height, widths come from
  each tile's real aspect ratio (1600×900 and 1440×900 coexist in one room), and
  the row's height ceiling is `H/rows`, which is what guarantees the block always
  fits. Column count is whichever maximizes total video area — not
  `ceil(sqrt(n))`, which ignores the aspect ratios and the stage shape.
- **Tiles never change parent.** Focus mode only resizes and repositions them;
  moving a `<video>` with a live `srcObject` in the DOM makes it flicker.

Aspect ratio comes from `video.videoWidth/videoHeight`, so `layout()` re-runs on
`loadedmetadata` and on the video's `resize` event (the sharer can switch the
captured window mid-call), plus a `ResizeObserver` on the stage.

### Focus mode

Click a tile (or its `focar` button) to give it the whole stage; the others
become `.mini` thumbnails in a rail — right side when there is width, bottom when
there is not. `esc` exits, a header chip shows what is focused, and each tile has
a `tela cheia` button that fullscreens the `.frame` (the `:fullscreen` rule
overrides the JS-set height, which is why the height lives in `--vh` in the
stylesheet instead of an inline style on the video).

The per-tile signal ribbon (`.wave`) is 60 samples of measured bitrate, one per
second, drawn on a canvas. It is telemetry, not decoration: a link degrading
shows up as a falling tape before the single instantaneous number explains why.

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

The **layout** can be verified headless, unlike WebRTC. Drive Chrome over CDP,
then inject fake sharers into the live page — `canvas.captureStream()` fed to
`attachTile(id, stream)` exercises the real code path, aspect ratios included,
because everything in the client script is a global. The assertion that matters
is `document.documentElement.scrollHeight === innerHeight` in every case (one
tile, two tiles with different aspect ratios, focus mode, 430px wide): the tile
fit exists to keep the page from scrolling. Screenshots caught two things numbers
did not — a ragged row of tiles centered per cell, and a header wrapping to three
lines on a phone.

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

## Encoder cost per destination — measured, no longer a guess

The old claim that identical encoding parameters make Chrome reuse one encoder
was wrong. There is **one encoder per PeerConnection**, and the cost does not
grow linearly — it falls off a cliff.

Measured on a Core 7 150U (12 logical CPUs), Chrome headless *and* headed (both
agreed within 2%), realistic screen content, encoder `libvpx` VP8 **in software**
(`powerEfficientEncoder: false` — this machine exposes no hardware video encode
under Linux). Sharer CPU with 4 destinations:

| capture | sharer CPU | fps delivered per stream |
|---|---|---|
| 1920×1200 | 9.9 cores | 7–11 |
| 1920×1080 | 10.1 cores | 6–9 |
| 1856×1044 | 3.8 cores | 30 |
| 1600×900 | 2.0 cores | 30 |
| 1440×810 | 1.5 cores | 30 |

Scaling by destination count at 1920×1080: 1 → 0.8 cores, **2 → 5.9**, 3 → 9.6,
4 → 10.1. The collapse happens between the first and the second destination.

**The mechanism is thread oversubscription, not pixel cost.** WebRTC gives each
VP8 encoder ~8 worker threads at or above 1920×1080 and ~3 below it. Counted in
`/proc`: the sharer's renderer carries **51 threads at 1920×1080 against 33 at
1600×900** (an idle renderer has 18). Four encoders × 8 threads is 32 encode
threads fighting over 12 logical CPUs. That is why 1856×1044 — only 7% fewer
pixels than 1080p — costs 3.8 cores instead of 10.1.

Two fixes that do **not** work, both measured: lowering the framerate made it
*worse* (11.2 cores at 15fps against 10.1 at 30fps in 1080p), and
`degradationPreference: "balanced"` changed nothing (10.4 against 10.1). Do not
reach for either.

Any capture cap must stay **below 1920×1080 pixels (2,073,600)** or the cliff
comes back. Viewers are not the problem: 4 simultaneous decodes cost 0.2–0.5
cores.

Caveat on these numbers: capture was a fake device fed from a file, not real
`getDisplayMedia`. Real screen capture **adds** cost, so a real machine is worse
than the table, never better.

## Out of scope

Do not implement without an explicit request: audio, chat, recording, an SFU,
TURN, authentication, Tailscale Funnel, persistence, or more than 5 peers.

There is no authentication, and that is deliberate — **the tailnet is the auth
layer**. Do not add Funnel, port forwarding or a public bind without real auth
first. Outside the tailnet peers also stop sharing a network, which breaks the
STUN premise and would require TURN.

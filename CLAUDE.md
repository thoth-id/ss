# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`tela` — browser-to-browser screen sharing (no audio) for a small group inside a
Tailscale tailnet. Bun + TypeScript, **zero dependencies**, no build step, no
`npm install`. Four source files total.

It is packaged for npm as **`@thoth-dev/screen-share`**, runnable with `bunx
@thoth-dev/screen-share` — **once published, which has not happened yet**.
Nothing about the stack changed for that: the package still ships `.ts` as
written, and Bun still runs it directly — no transpilation, no `dist/`.
`bin/cli.ts` is the published entry point (`bin.screen-share` in
`package.json`); it only parses flags and hands the real work to `server.ts`.

Three names, three jobs: the project's internal name stays `tela` — repo, UI
strings and `PLANO.md` keep saying `tela`. The **package name**,
`@thoth-dev/screen-share`, is what `npm install`, `bun add` and `bunx` take, and
what appears in the npmjs.com URL — the org scope exists because a plain
`screen-share` collided with existing package names on the registry. The
**command name**, `screen-share`, is unchanged and unscoped, because `bin` is
keyed by the command, not the package: once installed, the executable on
`PATH` is `screen-share`, and the CLI's own `--help`, `--stop` and pidfiles all
refer to itself that way. Only the not-yet-installed, run-once-via-`bunx` case
needs the package name; everything downstream of installation uses the command
name. Be consistent about which is which when writing docs.

`PLANO.md` is the authoritative spec and task list. Read it before changing
behavior — it records why each design decision exists, and section 5 lists
invariants that must not be broken.

Code comments, UI strings and `PLANO.md` are in Brazilian Portuguese. Match that
when editing.

## Commands

```bash
bun run server.ts          # HTTP+WS on :3000, STUN on UDP :3478
bun bin/cli.ts --help       # CLI flags: -p/--port, --stun-port, --peers,
                             # --sharers, --pixels, --bg, --stop, -h, -v
```

`bin/cli.ts` just sets environment variables (`PORT`, `STUN_PORT`, `MAX_PEERS`,
`MAX_SHARERS`, `MAX_CAPTURE_PIXELS`) and imports `server.ts` — running the
server directly with `bun run server.ts` still works standalone, with the same
env vars, no CLI in the loop. `--bg` backgrounds the process, writes a pidfile
and log to `$TMPDIR/screen-share-<port>.{pid,log}`, and only reports success
once the child's own `/config` answers (it checks the child is alive *before*
probing HTTP, so an already-occupied port doesn't get misreported as success).
`--stop` reads that pidfile and kills it.

Tests need a live server. Background processes from a separate tool invocation
do not survive, so start the server and run the suite in **one** shell command:

```bash
(bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); sleep 2; \
  timeout 90 bun run test.ts; kill $(cat /tmp/p)
```

`test.ts` honours `PORT` and `STUN_PORT` too, so a suite run can dodge a server
that is already up on 3000 — but the vars have to reach **both** processes:

```bash
(PORT=3200 STUN_PORT=3678 bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); sleep 2; \
  PORT=3200 STUN_PORT=3678 timeout 90 bun run test.ts; kill $(cat /tmp/p)
```

`test.ts` is a hand-rolled suite (97 assertions), not `bun test`. There is **no
filter flag** — to run a subset, comment out entries in the `/* ---------- run
---------- */` block at the bottom of `test.ts`.

Serving over HTTPS (required for real use, see below):

```bash
tailscale serve --bg 3000   # persists across restarts; only the Bun process needs restarting
```

## Architecture

```
bin/cli.ts       CLI: flags, --bg/--stop, env handoff to server.ts
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

Peer names (`join`'s optional `name`, `rename`, and the `names` broadcast) are
**derived from the sockets**, not stored in a second map: the name lives in
`ws.data.name` and `namesOf(room)` walks the room's socket set at publish time.
Leaving the room therefore erases the name by itself, with no cleanup path that
can drift from `close`. Same reasoning as the state-based `sharers` broadcast —
the whole map ships on every change, plus a snapshot on join. Names are
cosmetic: whoever picks none shows up by id, `joined.peers` stays an array of
raw ids, and the name never travels inside `data` (the server could not read it
there anyway). Sanitizing happens server-side in one function, `cleanName`:
collapse whitespace, trim, cut at 24. Empty after that means no entry in the
map, which is also how you erase your own name.

### Directional PeerConnections

The client keeps **two separate maps**, `sending` and `receiving`, keyed by peer
id. A bidirectional PC never exists. Because each PC has exactly one offerer,
there is no glare and perfect negotiation is unnecessary. ICE candidates carry
`dir: "tx" | "rx"` (sender's point of view, inverted on receipt) to disambiguate
which of the two PCs they belong to. Candidates arriving before
`setRemoteDescription` queue on `pc.pending`.

Do not unify these maps.

### The server is the arbiter

`MAX_PEERS` and `MAX_SHARERS` live at the top of `server.ts`, and the server
owns both decisions — it is the only place that sees a whole room, so
simultaneous clicks on different machines are only serializable there. All
three limits (`MAX_PEERS`, `MAX_SHARERS`, `MAX_CAPTURE_PIXELS`) read the
environment so the CLI's `--peers`/`--sharers`/`--pixels` flags can override
them; the measured defaults did not change.

They read it through **`int(name, default, max?)`, never `Number(env ?? d)`**.
`??` does not catch the empty string, so `MAX_PEERS=` became 0 and locked
everyone out, and `Number("cinco")` is `NaN` — which makes `set.size >= MAX_*`
*always false*, deleting the room ceiling and the sharer arbitration in silence
while the client kept rendering "3/3" off its own default. Anything that is not
a positive integer falls back to the measured default and names itself on
stderr. An arbiter that read `NaN` is not arbitrating.

`test.ts` derives `MAX_PEERS`/`MAX_SHARERS` from `/config` rather than keeping
literals, so an exported `MAX_PEERS` in the shell cannot fail the suite for a
defect that is not there — that mistake cost 8 false failures before it was
fixed. Its `/config` assertions therefore check shape, not value.

Static files resolve against `import.meta.dir`, not the process cwd — installed
as a package, the process runs from whatever directory invoked `bunx`, and
`"./public"` pointed at nothing there (that is how the page first went missing
in a real install). `resolverEstatico()` in `server.ts` does that resolution
and also guards against path traversal (`../`, encoded slashes) — keep new
static-file logic going through it rather than building paths ad hoc.

**`MAX_SHARERS` does not govern encoder count, and never did.** A sharer opens
one PC per destination, so it runs `MAX_PEERS - 1` encoders whether it is the
only one sharing or one of five. What `MAX_SHARERS` controls is how many streams
each machine *decodes*, measured at 0.18 core each. It was 2 out of a CPU fear
aimed at the wrong axis; it is 3 because 3 is where the clean measurement stops,
not because 4 was shown to hurt. See the sweep below.

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

- **`STRIP_LINE` (24) and `STRIP_BAND` (40) must equal the CSS strip heights** —
  `.fields` alone, and `.fields` plus the gauge band above it. Tile borders are
  `box-shadow: inset` and not real borders precisely so they add no height; a 1px
  border would make every tile overflow its slot by 2px. Which strip is in force
  is decided by a **second fit pass**: `layout()` fits optimistically with
  `STRIP_LINE`, and if the narrowest tile came out under `BAND_BELOW` (600px, the
  width where the telemetry text and the gauge stop sharing one line) it sets
  `strip = STRIP_BAND` and fits again. The strip is uniform across the layout on
  purpose — a ragged ruler between side-by-side tiles looks worse than a band on
  a tile that could have held the inline gauge.
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

The per-tile signal gauge (`.wave`) is 60 samples of measured bitrate, one per
second, drawn on a canvas. It is telemetry, not decoration: a link degrading
shows up as a falling tape before the single instantaneous number explains why.

Its geometry is the reason for the two strips. Stretching 60 samples across a
1900px tile gives each one a 32px slot, so the bars stop touching and the minute
of history reads as sparse ticks in a corner — it looked broken. Above
`BAND_BELOW` the gauge gets its own 156–180px box at the right end of the
telemetry line and a **fixed 3px slot**, so the bar rhythm is identical at every
tile size. Below it there is no room for both on one line, so the gauge takes a
full-width band above the text and the slot stretches to fill it. Either way the
bars touch, which is what makes it read as a tape.

### Presence plates

Every peer in the room gets a tile. Whoever is not sharing gets a **monogram
plate** (`.tile.peer`) instead of a video. This needed **no server or protocol
change**: `peers`, `names` and `sharers` already arrive complete, so
`syncRoster()` — called at the top of `render()` — derives the roster from them.
No second map to drift. It cannot use `attachTile`/`dropTile`, which call
`render()` back.

Plates **never compete with video for grid area**. They are a bottom rail capped
at `min(max(64, H*0.22), H*0.4, PRES_RAIL)` (132), and only inherit the stage
when no video tile exists at all, capped at `PRES_SOLO` (220). The reason is the
whole point of the feature: a monogram carries almost no information per pixel,
while a shared screen shrunk to a third of the stage stops being readable text.
Equal grid cells for everyone — at the room's ceiling that is 3 videos plus 2
plates — would do exactly that. Do not give plates a full grid cell.

Being alone with nobody sharing is the one state that keeps the old empty card:
**a roster of one is not a roster**, so when `peers` is empty no plate is built,
`tiles.size` stays 0 and `idle` means exactly what it always meant.

ids are 8 hex chars (`3f9a1b2c`), so an unnamed peer has no initial worth
showing — `3` is nobody. That plate shows `_`, the prompt cursor waiting to be
typed, on a dashed frame; the label is the id. A named peer shows the first
**grapheme** (`[...name][0]`, not `slice(0,1)` — a name may start with an emoji)
uppercased. A peer who is in `sharers` but whose video has not arrived yet gets
`conectando…` in accent; before this, that person was invisible.

The plate is the same shell as a video tile, so the px fit, the label ruler and
the focus rail all work unchanged — but it has no `.wave`, no `.ctl` and is not
focusable. `sizeWave()`, `tick()` and the band toggle skip it, and `place()`
leaves it out of `minTile` so a plate can never force the telemetry band. Its
face is `--panel`, not `--void`: a video tile is a screen, a plate is interface,
and the colour says which before the label is read. `attachTile` discards the
plate for that id before building the video tile — same `tiles` map, same key.

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

**Settle the transitions before measuring.** `.tile` transitions `left/top/width`
over .16s and `.frame video` transitions `height`. Measuring two rAFs after
`render()` reads the geometry in flight: plates land overlapping (65px apart
instead of 120) and the video box is off its aspect ratio, so `object-fit:
contain` letterboxes it. That produces both false failures and screenshots of a
layout that never renders. Wait ~320ms — twice the transition — then measure.

ICE over `100.x` **is verified cross-machine, and T0 is closed.** Run on
2026-08-24 between a MacBook and this Linux box, both on the tailnet, over
`tailscale serve` HTTPS: the telemetry strips read `srflx · 28ms`,
`srflx · 33ms` and `prflx · 26/30ms`. Direct, no relay, between distinct
machines — which is what T0 asked for. Do not ask for this verification again.

An earlier single run had shown 979 kb/s at 1920×1200, 30fps on a `prflx` pair
at 15ms RTT, but was never confirmed to be cross-machine rather than two tabs on
the host. That doubt is what the 2026-08-24 run settled.

`prflx` (peer-reflexive) is a **direct** path — the candidate was learned during
connectivity checks instead of being gathered up front, which is what you expect
when WireGuard delivers packets from an address that was not in the gathered set.
`PLANO.md` T0 anticipated `host` or `srflx` and never listed `prflx`, but it
satisfies the intent: direct, no TURN, no relay. Read the path field in each
tile's telemetry strip — `relay` would mean the STUN path failed.

### The encoder's resolution ladder, and why the policy must not fail quietly

That same cross-machine run delivered **640×360 at 30fps** from a 1600×900
capture. Measured on a CDP bench driving the real client (only `getDisplayMedia`
swapped for `canvas.captureStream`), 13 runs of 90–100s: **640×360 is not a
capture size, it is a rung.** When the encoder is allowed to trade pixels for
frames it descends a ladder of capture fractions — ¼, ⅜, ½, ¾, 1 — and 640×360
is the ½ rung of 1280×720. Climbing back took 30–40s on a 1ms lossless loopback,
and with moving content it did not climb a single rung in 90s.

`degradationPreference: "maintain-resolution"` is what forbids that ladder. With
it in force the resolution never moved in any run, **even at 2fps**; with it
gone, 1600×900 became 400×225 at 30fps and stayed there, reporting
`qualityLimitationReason: "bandwidth"` for 99.96% of the session while the
estimate said 3.77 Mb/s was available. The symptom's signature is therefore
**full framerate with collapsed resolution** — the opposite trade from the one
this client asks for.

Two client-side lessons, both now encoded in `applyEncoding`:

- **Never fabricate `encodings`.** `params.encodings = [{}]` when
  `getParameters()` returns an empty list changes the length of `encodings`,
  which is precisely what the spec makes `setParameters` reject with
  `InvalidModificationError`. The line existed to guarantee the policy and was
  what destroyed it on a strict browser. Chrome is not strict here, which is why
  the bench could not reproduce the symptom with the product intact.
- **Never swallow the failure.** The old `catch {}` turned "the policy did not
  apply" into "the video looks strange" discovered days later. And
  `setParameters` resolving is not proof: read `degradationPreference` back.

Also: **`83 kb/s` in the strip is not evidence of a thin link.** Static screen
content costs ~80–100 kb/s in VP8 at *any* resolution — the bench delivered the
same 83 kb/s at 6.2× the pixels. Do not diagnose bandwidth from that number.

The sharer's own strip now shows the outbound resolution when it differs from
the capture, plus `qualityLimitationReason`, plus the encoding-policy state in
the (otherwise unused) path field. Before that, whoever caused the collapse was
the one person who could not see it.

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

### Below the cap the cliff is gone — and sharers are not the axis that costs

The table above was measured at or above 1080p, before `MAX_CAPTURE_PIXELS`
existed. A second bench, driving the **real client** (the bench page only swaps
`getDisplayMedia` for a fake device; everything from `getSettings()` on is the
production path, cap included, so every stream ran at 1518×948) re-measured
inside the enforced regime. Same machine, 12 logical CPUs, `libvpx` VP8 in
software. Each "machine" is a separate Chrome with its own `user-data-dir`, CPU
attributed by walking its process tree in `/proc`.

**Cost of one more viewer** — one sharer, room filling up. All rows 30fps,
`qualityLimitationReason: "none"`:

| destinations | sharer cores | Δ | renderer threads |
|---|---|---|---|
| 1 | 0.59 | — | 20 |
| 2 | 0.93–0.95 | +0.36 | 24–26 |
| 3 | 1.54 | +0.59 | 28 |
| 4 | **1.87–2.31** | +0.77 | 33 |

A full room costs a sharer ~2 cores of 12. **There is no cliff below the cap**:
the 0.8 → 5.9 jump the table above records for the first-to-second destination
at 1080p is +0.36 here. The two runs agree with the old table (2.0 at 1600×900)
and with its thread count (33), which is what says the bench measures the
product and not itself. With heavy full-frame motion the same 4 destinations
cost 3.66 cores — still comfortable.

**Cost of one more sharer.** A viewer pays 0.17–0.19 core per stream received,
0.32–0.36 for two: linear. And a machine already encoding to 2 destinations that
starts *also* receiving one stream goes 0.93 → 1.11 — **+0.18, the same as a
pure viewer pays**. Decode adds; it does not interact with encode.

**What the bench could not measure.** Anything past two simultaneous streams on
a machine that is also encoding. Five full Chromes do not fit in 12 cores: at
P=5 the box saturates from S=2 on (`lim: "cpu"`, fps 22 → 7 → 4.5 → 2.7), and
those rows measure the bench, not `tela`. Read the fps and
`qualityLimitationReason` columns before trusting any CPU number here — a cost
that *falls* as load rises is starvation, not efficiency. Two loose ends stay
open: at P=3/S=3 a machine cost 2.56 cores where additivity predicted 1.27,
with fps intact at 29.4 and the system at 68% — unexplained, plausibly
single-box contention but not proven; and the same scenario re-run measured 1.87
against 2.31, so treat everything here as ±20%.

Settling both needs what `PLANO.md` T0 still wants anyway: two or three real
tailnet machines.

### The local STUN answers from the wrong address on a multi-homed host

Measured, and it explains an open question. `stun.ts` binds `0.0.0.0`, so the
kernel picks the reply's source IP by the route to the destination, not by the
address the request arrived on. On this host:

```
request from tailscale0 → 100.x:3478   reply from 100.x         OK
request from wifi       → 100.x:3478   reply from 192.168.15.x  discarded
```

Chrome drops a STUN response whose source differs from the address it asked, so
that interface never forms an `srflx` candidate — its log fills with `Received
non-STUN packet from unknown address`. **Remote tailnet peers are unaffected**:
the route to their `100.x` goes out `tailscale0`, so the source comes out right.
It only misfires for a client on the same machine — which is exactly the "two
tabs on the host" case, and is a concrete candidate explanation for why the one
real ICE run came back `prflx` instead of the `srflx` T0 expected. Not fixed;
recorded.

## Out of scope

Do not implement without an explicit request: audio, chat, recording, an SFU,
TURN, authentication, Tailscale Funnel, persistence, or more than 5 peers.

There is no authentication, and that is deliberate — **the tailnet is the auth
layer**. Do not add Funnel, port forwarding or a public bind without real auth
first. Outside the tailnet peers also stop sharing a network, which breaks the
STUN premise and would require TURN.

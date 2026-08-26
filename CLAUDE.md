# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`tailcast` — browser-to-browser screen sharing (no audio) for a small group inside a
Tailscale tailnet. Bun + TypeScript, **zero dependencies**, no build step, no
`npm install`. Four source files total.

It is published on npm as **`@thoth-dev/tailcast`**, runnable with `bunx
@thoth-dev/tailcast` (`@thoth-dev/screen-share` still resolves as an alias for migration). Nothing about the stack changed for that: the package
still ships `.ts` as written, and Bun still runs it directly — no
transpilation, no `dist/`.
`bin/tailcast.mjs` is the published entry point (`bin.tailcast` in
`package.json`, with `screen-share` kept as an alias), and `bin/cli.ts` is what it hands over to; the CLI only parses
flags and hands the real work to `server.ts`.

**Why there are two files and not one.** On POSIX, npm links
`node_modules/.bin/tailcast` (and the `screen-share` alias) straight at the file named in `bin`, so the
shebang picks the interpreter. With `bin/cli.ts` there (shebang `bun`), a
machine without Bun died in `env` — `env: 'bun': No such file or directory` —
before a single line of ours ran, which is why no message written inside
`cli.ts` could ever have explained it. The launcher has a `node` shebang and
does three things: under Bun already (`process.versions.bun`, i.e. `bunx`) it
imports `cli.ts` directly, so `process.argv` keeps the shape
`argv.slice(2)` expects and no second process appears; otherwise it looks for
`bun` on `PATH`, in `$BUN_INSTALL/bin` and in `~/.bun/bin` (that last one is
the common failure: Bun installed, `npx` running in a non-login shell that
never read the rc) and spawns it; failing that it names what is missing, why
Bun and not Node (`Bun.serve`), and the install line, then exits 1. It does
**not** install anything: a published `bin` that curls a script from another
domain is the postinstall pattern nobody wants.

Being an intermediate process comes with an obligation the old layout did not
have: **the launcher relays `SIGINT`/`SIGTERM`/`SIGHUP` to the child and
mirrors its exit code.** Without the relay, `kill <pid>` on the pid the user
can see killed only the launcher and left `bun` orphaned holding the port
(measured, not assumed). Ctrl-C hides the bug, because the terminal signals
the whole process group; a targeted kill does not. When the child dies of a
signal the launcher removes its own listener for it before re-raising on
itself, otherwise the handler catches the re-raise and the launcher hangs
forever trying to kill a dead child.

Keep the launcher free of CLI logic. Flags, `--bg` and `--stop` all stay in
`cli.ts`.

Three names, three jobs: the project's internal name stays `tailcast` — repo and UI
strings keep saying `tailcast`. The **package name**,
`@thoth-dev/tailcast`, is what `npm install`, `bun add` and `bunx` take, and
what appears in the npmjs.com URL — the org scope exists because a plain
`tailcast` is kept scoped for consistency (and the old `screen-share` alias remains). The
**command name**, `tailcast`, is now primary and unscoped, because `bin` is
keyed by the command, not the package: once installed, the executable on
`PATH` is `tailcast` (and `screen-share` as an alias), and the CLI's own `--help`, `--stop` and pidfiles all
refer to itself that way. Only the not-yet-installed, run-once-via-`bunx` case
needs the package name; everything downstream of installation uses the command
name. Be consistent about which is which when writing docs.

**Everything written for a human to read is in English**: code comments, UI
strings, CLI help, stderr messages, docs. Comments start with a lowercase
letter and use no em-dashes. They earn their place by saying *why*, never by
restating what the line already says: the measured numbers, the bug that was
reproduced, the alternative that looks right and is not. If the code says it,
delete the comment.

Identifiers are in English (`resolveStatic`, `targetBox`, `child`, `zoomBadge`),
and the `localStorage` keys are `tailcast:name` / `tailcast:rooms` (legacy `ss:name` / `ss:rooms` / `ss:nome` / `ss:salas`
are still read for migration and then cleared, so existing users keep their name
and room history without a hard cut).

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
and log to `$XDG_RUNTIME_DIR/tailcast/tailcast-<port>.{pid,log}`
(falling back to a 0700 `tailcast-<uid>/` under the temp dir, refused if
someone else owns it — never `$TMPDIR` directly, whose 1777 mode lets any user
plant a pidfile in the path), and only reports success
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
bin/tailcast.mjs  published bin: node shebang, finds bun or explains why it cannot (screen-share alias kept)
bin/cli.ts       CLI: flags, --bg/--stop, env handoff to server.ts
server.ts        Bun.serve: static files + /config + WebSocket signaling + room/sharer state
stun.ts          ~50-line STUN server (node:dgram), Binding Request → XOR-MAPPED-ADDRESS
public/index.html  the entire client: HTML + CSS + JS in one file
public/sw.js     service worker, network-first — see "Installable (PWA)"
public/manifest.webmanifest   app identity: name, display mode, colours
public/favicon.*, apple-touch-icon.png, android-chrome-*.png, mstile-150x150.png,
                 browserconfig.xml   the thoth favicon set, byte-for-byte as delivered
test.ts          headless suite (no browser)
```

The server does exactly three things: serve static files, relay signaling
opaquely, answer STUN. **It never touches media.** Media is peer-to-peer.

### Signaling protocol

JSON over WebSocket at `/ws`, discriminated by `t`. Full wire format is in
`README.md`.

The server **never inspects `msg.data`** — it only routes it to `msg.to`. This is
what allows the WebRTC negotiation to change without touching the backend. Do
not add validation, logging or transformation of `data`.

Peer names (`join`'s optional `name`, `rename`, and the `names` broadcast) are
**derived from the sockets**, not stored in a second map: the name lives in
`ws.data.name` and `namesOf(room)` walks the room's socket set at publish time.
Leaving the room therefore erases the name by itself, with no cleanup path that
can drift from `close`. Same reasoning as the state-based `sharers` broadcast —
the whole map ships on every change, plus a snapshot on join. Names are
cosmetic **to the server**: whoever picks none shows up by id, `joined.peers`
stays an array of raw ids, and the name never travels inside `data` (the server
could not read it there anyway). The client is stricter than the server here on
purpose — see *The portaria*. Sanitizing happens server-side in one function, `cleanName`:
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
in a real install). `resolveStatic()` in `server.ts` does that resolution
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

**The room session clock is the same lifecycle by necessity.** `startedAt` (in
`joined`) is the epoch the first peer set when the room turned from empty to
one, and it dies in the same `rooms.delete(room)` that erases an empty room. The
client counts from that single timestamp locally — one reference, no periodic
sync — which is why the top pill shows the running time (`#room · 0:42 · 2/3 on air ·
4 in the room`). It could not survive a full empty room even if we wanted
it to: an empty room does not exist, and neither does its clock.

### The shell is a call, not a page

The stage is the whole window (`main { position: absolute; inset: 0 }`) and every
piece of chrome floats over it: the `tela` wordmark top-left, an info pill
top-centre (`#sala · 2/3 no ar · 4 na sala`), and a round-button dock at the
bottom. There is no header bar, no sidebar and no rail.

Floating chrome does not get to cover content, so the stage reserves two bands
for it in the fit: `PAD_TOP` (52) and `PAD_BOT` (84). That is the whole
mechanism, and `bench/layout.ts` asserts it by measuring the dock and pill boxes
against every tile box, not by trusting the constants.

The dock is five buttons, and each one maps to something the product already
does: share (teal to start, red to stop, disabled with the reason in its
`title`), copy link, room, name, and leave-focus. Do not add a button for a
capability that does not exist — there is no audio, no camera and no hang-up
here, however much the reference call UIs have them.

**A dock button that stays coloured means a mode is on** — that is what the
share button says, and copying is not a mode. The copy button used to go green
for 1.4s, which borrowed `.on`'s vocabulary for something that already
happened. It now confirms with a pulse (`.tap`: a .34s squash plus a ring that
expands out of the button and fades), removed and re-added around a forced
reflow so a second click animates again. Clipboard failure is caught rather
than left as an unhandled rejection: `navigator.clipboard` does not exist
outside a secure context, so on plain `http://100.x` the call is a `TypeError`,
and the title says to copy from the address bar instead.

Two type roles, and the split is the point: **mono is machine truth** (ids,
rates, resolutions, candidate types, room names, and the `tela` wordmark, which
is a command), **sans is human words** (buttons, labels, sentences). Before this,
everything was mono and "Compartilhar tela" carried the same visual weight as
`srflx · 33ms`. The sans is the **system stack**, not a webfont: this project
fetches nothing from the network, and a Google Fonts link would break that and
the offline case at once.

### Client layout is computed in JS, on purpose

`main` is a fixed-height stage (`flex: 1; min-height: 0; overflow: hidden`) and
`layout()` positions every tile inside it in pixels. The page never scrolls.

The old CSS grid sized tiles by width alone (`width: 100%` + `aspect-ratio:
16/9`), so on a wide window a single tile grew taller than the viewport, the body
scrolled and the telemetry strip fell below the fold. Do not put it back.

Three things the math depends on:

- **The tile is only the video box.** The name and the telemetry are pills
  floating over the bottom of the frame, so there is no strip to subtract and no
  second fit pass: `STRIP_LINE`, `STRIP_BAND` and `BAND_BELOW` are gone, along
  with the band variant of the gauge. What replaced them is the pair of pills
  sharing one line, which degrades in two measured steps: under `WAVE_BELOW`
  (520) the tape drops and the numbers stay, under `TEL_BELOW` (340) the whole
  telemetry pill goes and only the name remains. The thresholds were set by
  measuring the actual boxes overlapping, and the bench asserts the same way
  (`nome.right <= tel.left`), because a class name proves nothing about pixels.
  Tile borders are still `box-shadow: inset` and not real borders, so they add no
  height.
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

### Receiver-side zoom

Wheel magnifies any non-mini tile, drag pans, double-click (or the indicator)
resets. It is entirely a `transform` on the `<video>`: **no box changes size**,
so the px fit, focus mode, the floating pills and the never-scrolling page are
untouched. `zooms` is a `Map<peerId, {k,x,y}>`; absent means identity. Keep it
that way — a single global tied to `focusId` would have to be reset in the
**five** places that clear it (`dropTile`, `toggleFocus`, the `keydown` handler,
`render()`'s `!tiles.has(focusId)` guard, and `gridBtn.onclick`), and one missed
path leaves a phantom zoom on the next tile.

**Page zoom is not a substitute, and this was measured.** Device pixels across
the displayed video ÷ source width, focused, 1518×948 source:

| page zoom | video in CSS px | device px | dev px / source px |
|---|---|---|---|
| 100% | 1192 × 744 | 1192 | 0.785 |
| 200% | 503 × 314 | 1006 | 0.663 |
| 300% | 128 × 80 | 384 | 0.253 |

Browser zoom makes it **worse** — 0.844× at 200%, 0.322× at 300% — because the
chrome bands are fixed in CSS px (`PAD_TOP` 52, `PAD_BOT` 84, `PAD_X` 14), so
shrinking the CSS viewport hands them a larger fraction of the stage while the
physical window never changes. At 300% the two bands alone are 136 of a 300 CSS
px height. Do not "simplify" this feature away by pointing at ctrl+wheel.

The same table is why the indicator says more than a number. At 100% the fit
already discards detail (0.785), so magnifying **recovers real pixels** up to
`videoWidth / (frameWidth · devicePixelRatio)` and interpolates above it. The
`.zoom` pill turns `.up` at that line.

**The indicator is deliberately not in `.tel`.** That pill needs `.vivo`, which
only the stats interval adds and only for a tile with a live PC — share alone in
a room and it never appears. And `.tile.narrow .tel` hides it below 340px, which
is exactly the small screen where magnifying matters most. It also would have
widened the box whose measured overlap set `WAVE_BELOW`/`TEL_BELOW`.

Three things that are load-bearing and easy to undo:

- **The cursor anchor needs the `t·r` term.** With `transform-origin: 0 0` the
  map is `s = k·p + t`, so the point under the cursor is `p = (c − t)/k` and
  holding it still gives `t' = c·(1 − r) + t·r`, `r = k'/k`. Two variants look
  right and are not, and **they need different gestures to expose**:
  `t' = t + c(1 − r)` survives one notch (`t` is 0 there) and drifts on the
  second; `t' = t + (k − k')c` survives **any number of notches at one point**,
  because while `t = c(1 − k)` it is algebraically equal to the correct rule —
  `t + c(k − k') = c(1 − k')`. It only diverges once `t ≠ c(1 − k)`, i.e. after
  a pan or at a second anchor point. So the bench zooms three times at one
  point *and* once more elsewhere after a drag. Both mutants were run against
  the suite; each fails exactly one of those two cases.
- **`overflow: hidden` belongs on `.frame`, not only `.tile`.** `requestFullscreen`
  is called on `.frame`, and a fullscreen element leaves the flow, so `.tile`'s
  clip no longer reaches the scaled video.
- **The pan clamp is re-applied at the end of `layout()`, after `place()`, and it
  must measure the box `place()` just *targeted*, never `clientWidth`.** The
  bounds are a function of the box, and the box is rewritten by six triggers
  (`ResizeObserver`, `fullscreenchange`, `video.onresize`, `onloadedmetadata`,
  `notice()`, every `render()`). Without the pass, someone joining the room while
  you are at 4× detaches the content from the edge permanently.

  But `.tile` transitions `width`/`height` over .16s, and the pass runs in the
  same tick as `place()`, so `frame.clientWidth` there is the **interpolated**
  width — the clamp confines the pan against a box that no longer exists and the
  video ends up wholly outside its frame, which renders as a black tile with the
  zoom pill on top of it. Measured: exiting focus at 4× on the edge left the
  video's right edge at −614px while the frame started at x=14. That is the same
  read-during-transition the bench section below warns about, committed in the
  product instead. `targetBox()` reads the inline `width`/`--vh` that `place()`
  wrote, which is the target, and falls back to the measured box only in
  fullscreen, where `.frame` has left the flow and `.tile` no longer governs it.

**Desktop only, and on purpose.** Trackpad pinch arrives as ctrl+wheel and lands
in the same handler, but Chrome on Android does not, and there is no
two-finger touch handler here. `touch-action: none` is set on `.frame.zoomed`
so that panning an already-zoomed tile is not stolen by the browser; entering
zoom by touch is simply not implemented. Do not read the 430px bench case as
coverage of it.

**The `.mini` rule lives in the `wheel` handler, not only in `layout()`'s prune
pass.** Pruning after the fact let a thumbnail be magnified to an unreadable
centre crop with no indicator (`.tile.mini .zoom` hides it) and no pan (the
mini's `.ctl` covers the whole frame), and — worse — the zoomed-tile click
suppression then killed click-to-focus, which is the rail's only purpose.

`pointerdown` bails on `e.target.closest(".ctl, .zoom")`: those buttons are
children of `.frame` and only stop propagation on **click**, so without the bail
pressing "tela cheia" and moving 10px panned the video underneath.

**`scrollHeight === innerHeight` cannot fail for zoom.** `.tile` has `overflow:
hidden`, so a transformed descendant's overflow is absorbed there and never
reaches `documentElement`. Keep the assertion — it still guards the fit — but do
not read it as covering zoom.

**And a zoom assertion that reads `zooms` back is not a test of the render.** The
first version of `pontoSob` recomputed the anchor from the same object
`applyZoom` had just written: it checked the update rule's arithmetic and nothing
about what reached the screen, so deleting `transformOrigin = "0 0"` or swapping
`translate() scale()` for `scale() translate()` — each of which destroys the
anchor outright — both passed green. It now inverts the **computed**
`transform`/`transformOrigin` via `DOMMatrix`, and `cobre()` compares the video's
rendered rect against the frame's. Every claim in this section has a mutant that
turns the suite red; the control run stays green. Add a zoom assertion only with
its mutant.

### Presence is a call tile

Everybody in the room gets a tile. Whoever is not sharing gets a **circular
monogram** (`.tile.peer`) where the video would be, which is the same shape a
call gives someone with the camera off. This needs **no server or protocol
change**: `peers`, `names` and `sharers` already arrive complete, so
`syncRoster()` — called at the top of `render()` — derives the roster from them.
No second map to drift. It cannot use `attachTile`/`dropTile`, which call
`render()` back.

**When nobody is sharing, the monograms are the call**: equal cells, `fitGrid`
with a 16:9 aspect, exactly the grid a call app shows. That is the only state
where presence owns the stage. The moment one video exists, the monograms drop
to a bottom rail capped at `min(max(64, H*0.22), H*0.4, PRES_RAIL)` (132),
because a monogram carries almost no information per pixel while a shared screen
shrunk to a third of the stage stops being readable text. At the room's ceiling
that would be 3 videos plus 2 monograms in equal cells. Do not give a monogram a
full grid cell while a video is on the stage.

Being alone with nobody sharing is the one state that keeps the empty card:
**a roster of one is not a roster**, so when `peers` is empty no tile is built,
`tiles.size` stays 0 and the card appears.

ids are 8 hex chars (`3f9a1b2c`), so an unnamed peer has no initial worth
showing — `3` is nobody. That tile shows `_`, the prompt cursor waiting to be
typed, on a dashed circle. Since the portaria makes a name mandatory, this only
happens against a client that does not enforce it. A named peer shows the first
**grapheme** (`[...name][0]`, not `slice(0,1)` — a name may start with an emoji)
uppercased. Somebody in `sharers` whose video has not arrived yet reads
`conectando…` in accent; before this, that person was invisible.

My own pill reads **`Name (você)`**, not just `você`: on a stage of five,
whoever is looking for their own screen is looking for the name they typed. The
marker is a sibling element of the name (`.who em`, `flex: none`, shown by
`.who.eu`), so on a narrow tile the *name* is what ellipsizes — truncating the
marker would cut the one thing that says whose frame it is. The name comes from
`myName` and not `nameOf(myId)` because the `names` broadcast lands after
`joined`, and in that gap I would show up by id. With no valid name (another
client, or before the portaria) it falls back to a bare `você`, which does not
qualify itself twice. `pill()` writes both, and `render()` calls it for every
tile, so a rename lands without rebuilding anything.

### Your rooms are your history, not a directory

The chips in the portaria are the rooms **this browser** has visited, kept in
`localStorage` under `tela:salas` (8 most recent, most recent first). This is a
deliberate limit, and it is worth being precise about why, because "it is P2P so
we cannot know" is the wrong reason:

- **The media is P2P; the signaling is not.** Every socket lives in the same Bun
  process, and `rooms: Map<string, Set<Socket>>` (`server.ts:87`) is a live map
  there. The server knows, right now, which rooms have people in them.
- **The client does not.** It only ever receives `peers`, `names` and `sharers`
  for the room it is in. Showing occupancy for another room means a new message
  in the protocol.
- **An empty room does not exist.** `rooms.delete(room)` when the last socket
  leaves. There is no created, stored or renamed room: it exists while somebody
  is inside. A room you left yesterday is a word you remember.

So occupancy is shown only for the room you are in. A real directory is about ten
lines (a `t: "rooms"` message with name and count, published on join and close),
and the price is not the code: there is no auth, so the room name is the only
partition that exists, and listing them hands every room to everyone on the
tailnet. Do not add it without deciding that trade on purpose.

### Switching rooms without a reload

`ROOM` is `let`, not `const`. The `#` button in the dock opens the portaria on
the room field, and `switchRoom()` closes the socket (clearing
`onclose`/`onmessage` first, so the old socket's reconnect does not race the new
`connect()`), clears `peers`/`names`/`sharers`, calls `resetConnections()` and
reconnects. The server hands out a fresh id per socket, so the `joined` handler
takes the same path it already took on reconnect. Whoever was sharing keeps the
local stream and re-requests the sharer slot in the new room. `hashchange` routes
through the same function, so editing the `#` by hand still works.

### The portaria, and why the name is mandatory

The entry modal **is** the door: `joinRoom()` only sends `join` when
`nameOk(myName)` holds (`MIN_NAME` = 3 graphemes after `cleanName`), so an
unnamed person is connected but in no room at all — the server ignores every
message that arrives before a `join`. That is why the blocking variant refuses to
close on `esc` or on a click outside, and why its confirm button stays disabled
until the field is valid.

The rule is the client's, not the server's. The server still accepts an empty
name, because that is how you *erase* one, and it stays the arbiter only of what
it can actually arbitrate (room and sharer limits). So a different client could
still join unnamed, and `nameOf` keeps falling back to the id for exactly that
case. Do not "fix" that by validating names server-side without deciding what
erasing a name should then mean.

It opens by itself only when there is no valid stored name (first visit in this
browser); after that a shared link opens straight into its room, which is the
whole point of sending a link. The dock's `#` and person buttons reopen the same
modal, unblocked, focused on the room or on the name. Confirming reuses
`setName()` and `switchRoom()` rather than talking to the socket itself.

There is no rename debounce any more. The name is not typed live into the header
any more, it is confirmed in the portaria: one confirmation, one `rename`.

### Client reconnect

The WebSocket reconnects every 1.5s. On `joined`, if `myId` changed, the client
closes and clears all PCs and tiles before reopening, then re-requests its sharer
slot (the server dropped the old id on close). A `denied` message sets a `dead`
flag that stops the reconnect loop — without it, a full room becomes a busy loop.

### Installable (PWA)

`public/manifest.webmanifest`, `public/sw.js` and the icon set at the root of
`public/` make the page installable, so it opens in its own window instead of a
tab. Nothing else changes: same origin, same signaling, same WebRTC.

The service worker is **network-first for everything**, which is backwards for a
PWA and deliberate here. The client is one hand-edited HTML file served from
inside the tailnet, so the network is a millisecond away and a cache hit is the
only way this page could go stale. The cache is a safety net, not the normal
path. `/config` is excluded outright — a cached copy would describe limits that
no longer hold — and `/ws` never reaches a fetch handler anyway.

Offline-first would be pointless: without signaling there is no room. What the
worker buys is (a) installability, since Chrome only offers the prompt to a page
with a manifest, an icon and a `fetch` handler, and (b) a blip mid-call showing
the page that was already loaded instead of the browser's error screen, which
leaves the 1.5s reconnect loop running where a reload would have killed it.

The static handler sends `cache-control: no-cache` on everything but the icons.
Without it the browser invents a freshness lifetime by heuristic, and an
installed PWA is exactly where that becomes an app frozen on an old `sw.js` that
never fetches the new one.

The install button is the last one in the dock and is `hidden` until
`beforeinstallprompt` fires. A button promising an install the browser will not
perform — Firefox and Safari on desktop, or plain http — is worse than no
button. It is last because it is the rarest action and the only one that leaves
for good once used. iOS fires no such event: there the path is Safari's own "Add
to Home Screen", which is what the `apple-mobile-web-app-*` metas serve. They,
not the manifest, carry the name and the standalone mode on iOS.

Losing the address bar costs nothing here, because `roomBtn` already switches
rooms without one.

**The icons are the delivered `thoth` favicon set, copied byte-for-byte, and
they stay that way.** They live at the root of `public/` because that is what
the set's own `head.html` assumes. Do not resize, recolour, recentre or
reassemble them, and never synthesise a maskable icon by extracting the paths
out of `favicon.svg` and filling them: that inverts the mark, and the result is
not the brand. There is no maskable icon in the set, so the manifest declares
none and Android shrinks the 512 inside its own background; a maskable one has
to be delivered, not derived. What is ours to pick is the manifest's
`theme_color` and `background_color`, which follow `--bg` so the splash and the
title bar match the call floor.

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

The **PWA is verified headless** on the same CDP rig: the worker reaches
`activated` and controls the page, Chrome parses the manifest with zero errors,
every icon answers 200, the shell is in `caches`, and a reload with the network
emulated offline still renders the page. Two traps there, both of which produced
wrong numbers first. `Page.navigate` to a URL differing only in the hash is a
**same-document navigation** — the DOM survives, so a page mutated by an earlier
check is still mutated; use `Page.reload`. And `beforeinstallprompt` fires about
a second after load, so anything measured before that is measuring a dock
without the install button.

The **layout** can be verified headless, unlike WebRTC. Drive Chrome over CDP,
then inject fake sharers into the live page — `canvas.captureStream()` fed to
`attachTile(id, stream)` exercises the real code path, aspect ratios included,
because everything in the client script is a global. The assertion that matters
is `document.documentElement.scrollHeight === innerHeight` in every case (one
tile, two tiles with different aspect ratios, focus mode, 430px wide): the tile
fit exists to keep the page from scrolling. Screenshots caught two things numbers
did not — a ragged row of tiles centered per cell, and a header wrapping to three
lines on a phone.

The call redesign was verified this way: `bench/layout.ts` drives the real client
through the blocking portaria (including that no `join` happens before a valid
name, and that `esc` and the scrim do not dismiss it), a populated room with
nobody sharing, one video with the presence rail, two videos of different aspect
ratios, focus, 430px, a name change and a live room switch. Every step asserts
`scrollHeight === innerHeight`, that no tile intersects the dock or the top pill,
and that the name and telemetry pills do not overlap, plus the receiver-side
zoom: anchor across three notches, the pan clamp, the detail threshold and the
indicator (73 assertions, all green). Run it when touching the shell; it is cheaper than reasoning about the
fit:

```bash
(PORT=3200 STUN_PORT=3678 bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); \
  sleep 2; PORT=3200 bun run bench/layout.ts; kill $(cat /tmp/p)
```

The bench dispatches **real** mouse input through `Input.dispatchMouseEvent`,
not synthetic events from `Runtime.evaluate`: the pan calls `setPointerCapture`,
which rejects an invented `pointerId`, and without capture a drag dies at the
element edge and the clamp test passes vacuously. It also kills Chrome from an
`exit`/`uncaughtException` handler — a run that threw used to leave a browser
holding the CDP port, and the next run attached to *that* one, with the old page
loaded, and failed for defects that did not exist.

**Settle the transitions before measuring.** `.tile` transitions `left/top/width`
over .16s and `.frame video` transitions `height`. Measuring two rAFs after
`render()` reads the geometry in flight: tiles land short of their slot and the
video box is off its aspect ratio, so `object-fit: contain` letterboxes it. That produces both false failures and screenshots of a
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
T0 anticipated `host` or `srflx` and never listed `prflx`, but it
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

The lesson that survived: **never swallow the failure.** The old `catch {}`
turned "the policy did not apply" into "the video looks strange" discovered days
later. And `setParameters` resolving is not proof that the field took —
`degradationPreference` is read back.

**A correction, because this file was wrong about it for a while.** An earlier
version of this section claimed `params.encodings = [{}]` — filling in an empty
`encodings` list — was the mechanism, destroying the policy on a "strict
browser". That claim was refuted by measurement and by the spec. WebRTC 1.0
§ 5.2 (*create an RTCRtpSender*, step 11) requires a single encoding entry to
exist when `sendEncodings` is empty, and no algorithm in the spec empties it
afterwards. Chrome 151 measured across seven live states — before negotiation,
`addTrack`, `addTransceiver`, explicit `sendEncodings: []`, no track,
`recvonly`, after offer, after answer — returned `encodings.length === 1` every
time. The list came back empty only on a **stopped** transceiver, where
`setParameters` already rejects with `InvalidStateError` before it ever looks at
`encodings`. So the line was defending against a state the spec forbids, while
itself doing the one thing `setParameters` genuinely rejects (changing the
length). It is gone; `encodings[0]` is indexed directly.

**That refutation measured Chrome, and Chrome only — and the field then pointed
at Safari.** On 2026-08-24, sharing from **Safari** on macOS to Chrome on Linux
over the tailnet, the receiver read `640×360 · 30fps` while the sharer's own
capture was `1600×900`: full framerate, collapsed resolution, the exact
signature of the policy not being in force. With the fixed client served from
this repo, the same pair delivered **`1600×900 · 9fps`** — the opposite trade,
which is `maintain-resolution` doing its job — and the sharer's strip showed no
policy warning, meaning `degradationPreference` read back fine there.

So "the spec guarantees `encodings[0]`" is established for Chrome and for the
spec text; it is **not** established for WebKit, which is the one browser where
the symptom appears. Do not read the paragraph above as closing the question for
Safari.

**Two things still open, both cheap:**

- The good run was **not confirmed to be a cold first share.** The same user
  found that a *second* share comes out at full resolution even on the old
  code, because the bandwidth estimate is already warm — libwebrtc starts at
  300 kb/s, and the resolution ladder's first rung follows the estimate. A
  fresh page sharing on the first try is what separates "the fix worked" from
  "the connection was warm".
- Nobody has read `getParameters()` **inside Safari**. One line in its console
  on the sharing tab answers it:
  `[...sending.values()][0].getSenders().find(s => s.track).getParameters()` —
  `encodings.length` and `degradationPreference` are the two fields that matter.

Related, and measured on the same day: **macOS allows only one screen capture at
a time.** Starting a share in a second Safari tab kills the first one's capture
(the first tile goes black). That is the platform, not this project.

**And `83 kb/s` is not the free-standing fact it was written as.** This file
used to say static screen content costs ~80–100 kb/s in VP8 at *any*
resolution. Measured, it scales with pixels: static content redrawn identically
at 30fps, `lim: "none"`, 15s after the estimate settles, costs **30.5 kb/s at
640×360**, 72.8 at 1600×900 and 269.9 at 1920×1080. The ~80 kb/s figure matches
1600×900, not "any resolution" — the original comparison put a degraded stream
(bitrate set by the bandwidth estimate) next to a static one (set by pixels).
The usable version: a low bitrate alone still does not prove a thin link, but
compare it against the cost *at that resolution*, and 83 kb/s at 640×360 is 2.7×
the static cost, which is a real signal rather than noise.

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

Settling both needs what T0 still wants anyway: two or three real
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

## Releasing

This is the step that keeps getting forgotten, and the drift is visible in the
repo: **0.2.1 is on npm with no git tag**, while `v0.1.1` was tagged before it
was published. "Bumped", "tagged" and "published" are three different states and
nothing here enforces the difference — so do all of it, in this order.

1. **Verify on `main`, after the merge — not on the branch.** Both suites need a
   live server, and both have to be in one shell command:

   ```bash
   (PORT=3200 STUN_PORT=3678 bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); \
     sleep 2; PORT=3200 STUN_PORT=3678 timeout 90 bun run test.ts; \
     PORT=3200 bun run bench/layout.ts; kill $(cat /tmp/p)
   ```

2. **`npm version <patch|minor|major> --no-git-tag-version`.** A merged feature
   is a **minor**, a fix is a patch. `--no-git-tag-version` because the tag is
   created by hand in step 5, so the tag and the release commit point at the
   same object instead of npm inventing a commit of its own.

3. **Pack it and prove the tarball carries the change.** There is no build step
   and no `dist/`; `files` ships 7 entries as written.

   ```bash
   npm pack --pack-destination /tmp
   rm -rf /tmp/rel && mkdir -p /tmp/rel && tar -xzf /tmp/thoth-dev-tailcast-<v>.tgz -C /tmp/rel
   node /tmp/rel/package/bin/tailcast.mjs -p 3300 --stun-port 3778 &
   PORT=3300 STUN_PORT=3778 bun run test.ts        # 97/97 against the packed copy
   ```

   Running the packed launcher **from a foreign directory** is the only check
   that exercises the `import.meta.dir` static-file resolution the way an
   installed package does — a `"./public"` relative path passes every in-repo
   test and serves nothing once installed.

   **Pass the port as a flag, never as an env var.** `bin/cli.ts:100` defaults to
   `{ port: 3000, stunPort: 3478 }` and line ~303 writes `PORT: String(opts.port)`
   into the child env unconditionally, so an inherited `PORT` is silently
   discarded: `PORT=3300 tailcast` serves on **3000**. Only `server.ts` run
   directly honours the environment. Flag > env > default would be the
   conventional order; this is not fixed, just recorded — and it is why a release
   check that sets `PORT` looks like it passed while testing the wrong process.

4. **Commit as `release: <version>`**, touching only `package.json`.

5. **`git tag v<version>`, then `git push && git push --tags`.** Both. This is
   the step 0.2.1 missed.

6. **Publishing is the user's step, not an agent's.** `npm publish` — never
   `bun publish`, which does not read `~/.npmrc` and fails with "missing
   authentication" even after a successful `npm login`. `publishConfig.access` is
   already `public`, so no `--access` flag. The account has 2FA: the publish
   stops with `EOTP` and prints an auth URL that the harness masks, so either the
   user runs it or they hand over the 6-digit code for
   `npm publish --otp=<code>`. Afterwards the npm CDN takes ~100s to propagate;
   a 404 in that window is normal and not a failed publish.

Three names, and a release touches all three (see *What this is*): the **npm**
org is `thoth-dev`, the **GitHub** org is `thoth-id`, and the installed command
is `tailcast` (with `screen-share` as an alias). The `repository` URL in `package.json` keeps `thoth-id` on
purpose. A plain unscoped `tailcast` is now the scoped name; the old `screen-share` alias remains for migration.

## Out of scope

Do not implement without an explicit request: audio, chat, recording, an SFU,
TURN, authentication, Tailscale Funnel, persistence, or more than 5 peers.

There is no authentication, and that is deliberate — **the tailnet is the auth
layer**. Do not add Funnel, port forwarding or a public bind without real auth
first. Outside the tailnet peers also stop sharing a network, which breaks the
STUN premise and would require TURN.

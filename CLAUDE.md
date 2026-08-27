# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`tailcast` — browser-to-browser screen sharing (no media audio) for a small group
inside a Tailscale tailnet. Bun + TypeScript, **no runtime dependencies**, no
build step, no `dist/`: the package ships `.ts` as written and Bun runs it
directly.

There *are* dev dependencies (`biome`, `husky`, `lint-staged`, `bun-types`), so a
clone needs `bun install` before the pre-commit hook works. Nothing they produce
is shipped — `files` in `package.json` lists 7 source entries and that is the
whole tarball.

Six shipped source files: `bin/tailcast.mjs`, `bin/cli.ts`, `server.ts`,
`stun.ts`, `public/index.html`, `public/sw.js`. Two test entry points and six
`bench/` modules on top.

### Three names, three jobs

- **Project**: `tailcast` — the repo, and every UI string.
- **Package**: `@thoth-dev/tailcast` — what `npm install`, `bun add` and `bunx`
  take, and what appears in the npmjs.com URL. `@thoth-dev/screen-share` still
  resolves as a migration alias.
- **Command**: `tailcast`, unscoped, because `bin` is keyed by the command and
  not the package. Once installed, the executable on `PATH` is `tailcast` (with
  `screen-share` kept as an alias), and the CLI's own `--help`, `--stop` and
  pidfiles all refer to itself that way.

Only the not-yet-installed, run-once-via-`bunx` case needs the package name;
everything downstream of installation uses the command name. Be consistent about
which is which when writing docs. A release touches a third org too: the **npm**
org is `thoth-dev`, the **GitHub** org is `thoth-id`, and `repository` in
`package.json` keeps `thoth-id` on purpose.

### Why there are two files in `bin/` and not one

On POSIX, npm links `node_modules/.bin/tailcast` straight at the file named in
`bin`, so the shebang picks the interpreter. With `bin/cli.ts` there (shebang
`bun`), a machine without Bun died in `env` — `env: 'bun': No such file or
directory` — before a single line of ours ran, which is why no message written
inside `cli.ts` could ever have explained it.

`bin/tailcast.mjs` has a `node` shebang and does three things: under Bun already
(`process.versions.bun`, i.e. `bunx`) it imports `cli.ts` directly, so
`process.argv` keeps the shape `argv.slice(2)` expects and no second process
appears; otherwise it looks for `bun` on `PATH`, in `$BUN_INSTALL/bin` and in
`~/.bun/bin` (that last one is the common failure: Bun installed, `npx` running
in a non-login shell that never read the rc) and spawns it; failing that it names
what is missing, why Bun and not Node (`Bun.serve`), and the install line, then
exits 1. It does **not** install anything: a published `bin` that curls a script
from another domain is the postinstall pattern nobody wants.

Being an intermediate process comes with an obligation the old layout did not
have: **the launcher relays `SIGINT`/`SIGTERM`/`SIGHUP` to the child and mirrors
its exit code.** Without the relay, `kill <pid>` on the pid the user can see
killed only the launcher and left `bun` orphaned holding the port (measured, not
assumed). Ctrl-C hides the bug, because the terminal signals the whole process
group; a targeted kill does not. When the child dies of a signal the launcher
removes its own listener for it before re-raising on itself, otherwise the
handler catches the re-raise and the launcher hangs forever trying to kill a dead
child.

Keep the launcher free of CLI logic. Flags, `--bg` and `--stop` all stay in
`cli.ts`.

### Language

**Everything written for a human to read is in English**: code comments, UI
strings, CLI help, stderr messages, docs. Comments start with a lowercase letter
and use no em-dashes. They earn their place by saying *why*, never by restating
what the line already says: the measured numbers, the bug that was reproduced,
the alternative that looks right and is not. If the code says it, delete the
comment.

Identifiers are in English (`resolveStatic`, `targetBox`, `pointUnder`,
`syncRoster`). A few Portuguese leftovers survive in `bench/scenarios.ts`
(`quadro`, `foco`) and in the `.vivo` class — rename them when you touch that
code, not as a sweep.

`localStorage` keys are `tailcast:name`, `tailcast:rooms`, `tailcast:sound` and
`tailcast:quality`.
The legacy `ss:` keys (`ss:name`, `ss:nome`, `ss:rooms`, `ss:salas`, `ss:sound`)
are still read for migration and then cleared, so existing users keep their name,
room history and sound preference without a hard cut. Every read is wrapped:
`localStorage` throws in a restricted context (cookies blocked, sandboxed
iframe).

## Commands

```bash
bun install                 # dev deps: biome, husky, lint-staged
bun run server.ts           # HTTP+WS on :3000, STUN on UDP :3478
bun bin/cli.ts --help       # authoritative flag list
bun run format              # biome check --write ./
bun run lint                # biome lint ./
```

`.husky/pre-commit` runs `npx lint-staged`, which runs `biome check --write` over
staged `.ts/.js/.json/.html/.css/.svg`. **Committing rewrites your staged
files** — tabs, width 100, double quotes, imports organized. Expect the
reformat rather than being surprised by it; `bun run format` first if you want
the diff to be yours.

`bin/cli.ts` only sets environment variables (`PORT`, `STUN_PORT`, `MAX_PEERS`,
`MAX_SHARERS`, `MAX_CAPTURE_PIXELS`) and imports `server.ts` — running the server
directly still works standalone, with the same env vars and no CLI in the loop.
`--bg` backgrounds the process, writes a pidfile and log to
`$XDG_RUNTIME_DIR/tailcast/tailcast-<port>.{pid,log}` (falling back to a 0700
`tailcast-<uid>/` under the temp dir, refused if someone else owns it — never
`$TMPDIR` directly, whose 1777 mode lets any user plant a pidfile in the path),
and only reports success once the child's own `/config` answers (it checks the
child is alive *before* probing HTTP, so an already-occupied port doesn't get
misreported as success). `--stop` reads that pidfile and kills it; `--force`
kills even when `/proc` cannot confirm the process is ours.

`server.ts` prints an ASCII cat plus the version, ports and room limits on
startup. `cli.test.ts` asserts that banner is exactly **11 lines** and that
`--bg` prints it before its status line, so it is not decoration you can retouch
freely.

### Tests

Two suites, and they are not the same shape.

`test.ts` is a hand-rolled suite (**100 assertions**), not `bun test`. It needs a
live server, and background processes from a separate tool invocation do not
survive, so start the server and run the suite in **one** shell command:

```bash
(bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); sleep 2; \
  timeout 90 bun run test.ts; kill $(cat /tmp/p)
```

It honours `PORT` and `STUN_PORT` too, so a run can dodge a server that is
already up on 3000 — but the vars have to reach **both** processes:

```bash
(PORT=3200 STUN_PORT=3678 bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); sleep 2; \
  PORT=3200 STUN_PORT=3678 timeout 90 bun run test.ts; kill $(cat /tmp/p)
```

There is **no filter flag** — to run a subset, comment out entries in the
`/* ---------- run ---------- */` block at the bottom of `test.ts`.

`cli.test.ts` is the one `bun:test` file, and it needs no server: it drives
`bin/cli.ts` through a real `--bg`/`--stop` round trip inside a temp
`XDG_RUNTIME_DIR`, then falls back to `--stop --force`.

```bash
bun test                    # cli.test.ts only
```

`test.ts` derives `MAX_PEERS`/`MAX_SHARERS` from `/config` rather than keeping
literals, so an exported `MAX_PEERS` in the shell cannot fail the suite for a
defect that is not there — that mistake cost 8 false failures before it was
fixed. Its `/config` assertions therefore check shape, not value.

### The layout bench

`bench/` is six modules: `chrome.ts` (spawn, fresh profile per run), `cdp.ts`
(the socket), `input.ts` (real mouse), `measure.ts` (geometry), `scenarios.ts`
(the six scenarios, **73 assertions**) and `layout.ts` (the runner). It honours
`PORT`, `CDP_PORT` (9333) and `BENCH_OUT` (`/tmp/tailcast-bench`).

```bash
(PORT=3200 STUN_PORT=3678 bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); \
  sleep 2; PORT=3200 bun run bench/layout.ts; kill $(cat /tmp/p)
```

Run it when touching the shell; it is cheaper than reasoning about the fit.

### Serving over HTTPS (required for real use)

```bash
tailscale serve --bg 3000   # persists across restarts; only the Bun process needs restarting
```

## Architecture

```
bin/tailcast.mjs   published bin: node shebang, finds bun or explains why it cannot
bin/cli.ts         CLI: flags, --bg/--stop/--force, env handoff to server.ts
server.ts          Bun.serve: static files + /config + WebSocket signaling + room state
stun.ts            ~50-line STUN server (node:dgram), Binding Request → XOR-MAPPED-ADDRESS
public/index.html  the entire client: HTML + CSS + JS in one file
public/sw.js       service worker, network-first — see "Installable (PWA)"
public/manifest.webmanifest   app identity: name, display mode, colours
public/favicon.*, apple-touch-icon.png, android-chrome-*.png, mstile-150x150.png,
                   browserconfig.xml   the thoth favicon set, byte-for-byte as delivered
public/icon-tailcast.png      the wordmark's icon (also the README header)
test.ts            headless suite, needs a live server
cli.test.ts        bun:test, drives the CLI, needs no server
bench/             CDP layout+zoom verification of the real client
docs/protocol.md   the signaling wire format
docs/measurements.md   every number this project acts on, with its run
docs/verification.md   what each suite covers, and the traps in the CDP rig
docs/releasing.md      the six steps, in order
```

The server does exactly three things: serve static files, relay signaling
opaquely, answer STUN. **It never touches media.** Media is peer-to-peer.

### Signaling protocol

Full wire format, and the reasoning behind `data` being opaque, `sharers` being
state-based, `names` being derived from the sockets and `startedAt` sharing the
room's lifecycle: **`docs/protocol.md`**. Read it before changing anything the
client and server both parse.

### Directional PeerConnections

The client keeps **two separate maps**, `sending` and `receiving`, keyed by peer
id. A bidirectional PC never exists. Because each PC has exactly one offerer,
there is no glare and perfect negotiation is unnecessary. ICE candidates carry
`dir: "tx" | "rx"` (sender's point of view, inverted on receipt) to disambiguate
which of the two PCs they belong to. Candidates arriving before
`setRemoteDescription` queue on `pc.pending`.

Do not unify these maps. They are keyed by `"<peerId>#<src>"` now, not by peer
id — see *Two sources at once*.

### The server is the arbiter

`MAX_PEERS` (5) and `MAX_SHARERS` (3) live at the top of `server.ts`, and the
server owns both decisions (`MAX_SHARERS` counts **streams**, not people,
since one peer can hold its screen and its camera at once — see *Two sources at
once*) — it is the only place that sees a whole room, so
simultaneous clicks on different machines are only serializable there. All three
limits (`MAX_PEERS`, `MAX_SHARERS`, `MAX_CAPTURE_PIXELS`) read the environment so
the CLI's `--peers`/`--sharers`/`--pixels` flags can override them; the measured
defaults did not change.

They read it through **`int(name, default, max?)`, never `Number(env ?? d)`**.
`??` does not catch the empty string, so `MAX_PEERS=` became 0 and locked
everyone out, and `Number("cinco")` is `NaN` — which makes `set.size >= MAX_*`
*always false*, deleting the room ceiling and the sharer arbitration in silence
while the client kept rendering "3/3" off its own default. Anything that is not a
positive integer falls back to the measured default and names itself on stderr.
An arbiter that read `NaN` is not arbitrating.

Static files resolve against `import.meta.dir`, not the process cwd — installed
as a package, the process runs from whatever directory invoked `bunx`, and
`"./public"` pointed at nothing there (that is how the page first went missing in
a real install). `resolveStatic()` does that resolution and also guards against
path traversal (`../`, encoded slashes) — keep new static-file logic going
through it rather than building paths ad hoc.

**`MAX_SHARERS` does not govern encoder count, and never did.** A sharer opens
one PC per destination, so it runs `MAX_PEERS - 1` encoders whether it is the
only one sharing or one of five. What `MAX_SHARERS` controls is how many streams
each machine *decodes*, measured at 0.18 core each. It was 2 out of a CPU fear
aimed at the wrong axis; it is 3 because 3 is where the clean measurement stops,
not because 4 was shown to hurt.

`MAX_CAPTURE_PIXELS` (1,440,000) is the capture pixel budget, served by
`/config`. The client scales the captured track down to fit it, preserving the
screen's real aspect ratio, so 1920×1200 becomes 1518×948. The cut happens
**once at the source, not once per PeerConnection** — all N encoders read the
same track. **Any budget must stay below 1920×1080 pixels (2,073,600)** or the
CPU cliff comes back: the measurement is in `docs/measurements.md`, and it is the
single reason this number exists.

### The shell is a call, not a page

The stage is the whole window (`main { position: absolute; inset: 0 }`) and every
piece of chrome floats over it: the wordmark top-left (`icon-tailcast.png` plus
the word `tailcast`, hidden below the narrow breakpoint), an info pill top-centre
(`#room · 0:42 · 2/3 on air · 4 in the room`), and a round-button dock at the
bottom. There is no header bar, no sidebar and no rail.

Floating chrome does not get to cover content, so the stage reserves two bands
for it in the fit: `PAD_TOP` (52) and `PAD_BOT` (84). That is the whole
mechanism, and `bench/scenarios.ts` asserts it by measuring the dock and pill
boxes against every tile box, not by trusting the constants.

Every dock button maps to something the product already does: share (teal to
start, red to stop, disabled with the reason in its `title`), camera (hidden
where there is no camera API), capture quality, copy link, room, name,
leave-focus, sound, and install (hidden until the browser offers it). Do not
add a button for a capability that does not exist — there is no audio and no
hang-up here, however much the reference call UIs have them. **The camera is
the one that was added after this rule was written, and it earned it by
measurement** — see *The camera exists because the phone's screen cannot*.

The quality button is the one that opens a panel instead of acting, because a
profile is a choice among three and round icons cannot say which. `.qmenu` is
`position: fixed` and placed from the button's own box, deliberately: the dock's
height is `PAD_BOT`, the band the tile fit reserves, so a panel growing inside
it would move every tile on the stage. The bench asserts the page still does not
scroll with the menu open.

**Choosing does not close it**, which is the opposite of what a menu normally
does and is the point: a profile applies to the live capture in place, so the
menu staying open is what lets someone try the three against the screen they are
actually sharing. It closes on `esc`, on the button, or on a click anywhere else
— and closing puts the focus back on the button, because hiding a container does
not move the focus off a button inside it, and the next `tab` then started from
an invisible element.

**`[hidden] { display: none !important }` at the top of the sheet is
load-bearing, and it is the file's only `!important`.** The browser's own
`[hidden]` rule is `display: none` at the specificity of a bare attribute, so
*any* class that sets `display` outranks it and the element stays on screen with
`hidden` set. This was four hand-written overrides — `.notice`, `.empty`,
`.gate`, and a fourth added for `.qmenu`, which had spent a release taking
clicks over the stage while `qmenu.hidden` read `true`. Writing a fifth was the
wrong altitude: the element nobody had written one for was **`#installBtn`**,
which is `.dock button { display: grid }`, so the install button was visible in
every browser that never fires `beforeinstallprompt` — Firefox, Safari, plain
`http` — which is the exact button this project says must not exist there. One
general rule covers the next hideable element before it is written. Specificity
cannot beat a class from a bare attribute selector, which is why the
`!important` is not negotiable here.

The bench asserts this **generally**, and generally means every element in the
page and not a list of the ones that use `hidden` today: it walks
`querySelectorAll("*")`, sets the attribute with `toggleAttribute` (so the
source buttons' SVG icons are covered, which have no `hidden` IDL property) and
reads `getComputedStyle(...).display`. A list would have had to name
`#installBtn`, and nobody writes down the name of the element they forgot.
Reverting to the per-element overrides turns that one assertion red with
`installBtn=grid` and leaves the rest green. The closing assertions also click the closed menu's old coordinates
now — reading the `hidden` attribute proved only that the attribute was set.

**A dock button that stays coloured means a mode is on** — that is what the share
and sound buttons say, and copying is not a mode. The copy button used to go
green for 1.4s, which borrowed `.on`'s vocabulary for something that already
happened. It now confirms with a pulse (`.tap`: a .34s squash plus a ring that
expands out of the button and fades), removed and re-added around a forced
reflow so a second click animates again. Clipboard failure is caught rather than
left as an unhandled rejection: `navigator.clipboard` does not exist outside a
secure context, so on plain `http://100.x` the call is a `TypeError`, and the
title says to copy from the address bar instead.

**The accent is `#2f9e88`, and the token that pairs with it is `--ink`.** It
was `#5ad3bb` for a release, which is a neon over a near-black floor. The
pairing is the part worth remembering, not the hue: `.dock button.on` and `.go`
fill with `--accent` and ask for `color: var(--ink)`, and `--ink` was never
declared anywhere. `var()` with no fallback is invalid at computed-value time,
so `color` fell back to `inherit` and painted `--fg` on the accent. A missing
custom property fails silently by design: it does not drop the declaration, it
drops it *at computed-value time*, which no console reports. Whoever changes
`--accent` changes `--ink` with it.

**`--ink` is white, and a dark ink was tried and rejected.** On paper the dark
one wins: `#04100d` on the accent is 7.4:1 against white's 3.3:1. On screen it
loses, and the reason is what the dock is made of: every icon here is a 1.7px
`stroke`, not a filled glyph, so a dark stroke on a mid-tone fill reads as a
hole punched through the button rather than as a symbol drawn on it. The one
place the ratio does bind is the `.go` label, which is real text — white leaves
it at 3.3:1, under AA. That is a known trade and not an oversight: recovering
it means taking the *fill* a tone deeper (about `#26836f`, 4.6:1) while
`--accent` itself stays where it is for the thin strokes over the dark floor,
which need to go the other way.

Two type roles, and the split is the point: **mono is machine truth** (ids,
rates, resolutions, candidate types, room names, and the `tailcast` wordmark,
which is a command), **sans is human words** (buttons, labels, sentences). Before
this, everything was mono and "Share screen" carried the same visual weight as
`srflx · 33ms`. The sans is the **system stack**, not a webfont: this project
fetches nothing from the network, and a Google Fonts link would break that and
the offline case at once.

### Client layout is computed in JS, on purpose

`main` is a fixed-height stage and `layout()` positions every tile inside it in
pixels. The page never scrolls.

The old CSS grid sized tiles by width alone (`width: 100%` + `aspect-ratio:
16/9`), so on a wide window a single tile grew taller than the viewport, the body
scrolled and the telemetry strip fell below the fold. Do not put it back.

Three things the math depends on:

- **The tile is only the video box.** The name and the telemetry are pills
  floating over the bottom of the frame, so there is no strip to subtract and no
  second fit pass. What carries it is the pair of pills sharing one line, which
  degrades in two measured steps: under `WAVE_BELOW` (520) the tape drops and the
  numbers stay, under `TEL_BELOW` (340) the whole telemetry pill goes and only
  the name remains. The thresholds were set by measuring the actual boxes
  overlapping, and the bench asserts the same way (`who.right <= tel.left`),
  because a class name proves nothing about pixels. Tile borders are still
  `box-shadow: inset` and not real borders, so they add no height.
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

Click a tile (or its focus button) to give it the whole stage; the others become
`.mini` thumbnails in a rail — right side when there is width, bottom when there
is not. `esc` exits, a header chip shows what is focused, and each tile has a
`fullscreen` button that fullscreens the `.frame` (the `:fullscreen` rule
overrides the JS-set height, which is why the height lives in `--vh` in the
stylesheet instead of an inline style on the video).

The per-tile signal gauge (`.wave`) is 60 samples of measured bitrate, one per
second, drawn on a canvas. It is telemetry, not decoration: a link degrading
shows up as a falling tape before the single instantaneous number explains why.

Its geometry is the reason for the `WAVE_BELOW` step. Stretching 60 samples
across a 1900px tile gives each one a 32px slot, so the bars stop touching and
the minute of history reads as sparse ticks in a corner — it looked broken. On a
wide tile the gauge gets a 156–180px box at the right end of the telemetry line
and a **fixed 3px slot**, so the bar rhythm is identical at every tile size.
Below the threshold there is no room for both on one line, so the numbers stay
and the tape goes.

### Receiver-side zoom

Wheel magnifies any non-mini tile, drag pans, double-click (or the indicator)
resets. It is entirely a `transform` on the `<video>`: **no box changes size**, so
the px fit, focus mode, the floating pills and the never-scrolling page are
untouched. `zooms` is a `Map<peerId, {k,x,y}>`; absent means identity. Keep it
that way — a single global tied to `focusId` would have to be reset in the
**five** places that clear it (`dropTile`, `toggleFocus`, the `keydown` handler,
`render()`'s `!tiles.has(focusId)` guard, and `gridBtn.onclick`), and one missed
path leaves a phantom zoom on the next tile.

**Page zoom is not a substitute, and this was measured** — the device-pixel table
is in `docs/measurements.md`. Browser zoom makes it *worse*, because the chrome
bands are fixed in CSS px while the physical window never changes. Do not
"simplify" this feature away by pointing at ctrl+wheel. The same table is why the
indicator says more than a number: magnifying recovers real pixels up to
`videoWidth / (frameWidth · devicePixelRatio)` and interpolates above it, and the
`.zoom` pill turns `.up` at that line.

Four things that are load-bearing and easy to undo:

- **The cursor anchor needs the `t·r` term.** With `transform-origin: 0 0` the map
  is `s = k·p + t`, so the point under the cursor is `p = (c − t)/k` and holding
  it still gives `t' = c·(1 − r) + t·r`, `r = k'/k`. Two variants look right and
  are not, and **they need different gestures to expose**:
  `t' = t + c(1 − r)` survives one notch (`t` is 0 there) and drifts on the
  second; `t' = t + (k − k')c` survives **any number of notches at one point**,
  because while `t = c(1 − k)` it is algebraically equal to the correct rule —
  `t + c(k − k') = c(1 − k')`. It only diverges once `t ≠ c(1 − k)`, i.e. after a
  pan or at a second anchor point. So the bench zooms three times at one point
  *and* once more elsewhere after a drag. Both mutants were run against the
  suite; each fails exactly one of those two cases.
- **`overflow: hidden` belongs on `.frame`, not only `.tile`.**
  `requestFullscreen` is called on `.frame`, and a fullscreen element leaves the
  flow, so `.tile`'s clip no longer reaches the scaled video.
- **The pan clamp is re-applied at the end of `layout()`, after `place()`, and it
  must measure the box `place()` just *targeted*, never `clientWidth`.** The
  bounds are a function of the box, and the box is rewritten by six triggers
  (`ResizeObserver`, `fullscreenchange`, `video.onresize`, `onloadedmetadata`,
  `notice()`, every `render()`). Without the pass, someone joining the room while
  you are at 4× detaches the content from the edge permanently. But `.tile`
  transitions `width`/`height` over .16s, and the pass runs in the same tick as
  `place()`, so `frame.clientWidth` there is the **interpolated** width — the
  clamp confines the pan against a box that no longer exists and the video ends
  up wholly outside its frame, which renders as a black tile with the zoom pill
  on top of it. Measured: exiting focus at 4× on the edge left the video's right
  edge at −614px while the frame started at x=14. `targetBox()` reads the inline
  `width`/`--vh` that `place()` wrote, which is the target, and falls back to the
  measured box only in fullscreen, where `.frame` has left the flow and `.tile`
  no longer governs it.
- **The `.mini` rule lives in the `wheel` handler, not only in `layout()`'s prune
  pass.** Pruning after the fact let a thumbnail be magnified to an unreadable
  centre crop with no indicator (`.tile.mini .zoom` hides it) and no pan (the
  mini's `.ctl` covers the whole frame), and — worse — the zoomed-tile click
  suppression then killed click-to-focus, which is the rail's only purpose.

`pointerdown` bails on `e.target.closest(".ctl, .zoom")`: those buttons are
children of `.frame` and only stop propagation on **click**, so without the bail
pressing `fullscreen` and moving 10px panned the video underneath.

**Desktop only, and on purpose.** Trackpad pinch arrives as ctrl+wheel and lands
in the same handler, but Chrome on Android does not, and there is no two-finger
touch handler here. `touch-action: none` is set on `.frame.zoomed` so that
panning an already-zoomed tile is not stolen by the browser; entering zoom by
touch is simply not implemented. Do not read the 430px bench case as coverage of
it.

**The indicator is deliberately not in `.tel`.** That pill needs `.vivo`, which
only the stats interval adds and only for a tile with a live PC — share alone in
a room and it never appears. And `.tile.narrow .tel` hides it below 340px, which
is exactly the small screen where magnifying matters most. It also would have
widened the box whose measured overlap set `WAVE_BELOW`/`TEL_BELOW`.

Two assertion traps live in `docs/verification.md`: `scrollHeight ===
innerHeight` cannot fail for zoom, and an assertion that reads `zooms` back is
not a test of the render. Both once produced green suites over broken renders.

Every claim in this section has a mutant that turns the suite red; the control
run stays green. Add a zoom assertion only with its mutant.

### Two sources at once, and the key that made it possible

The screen and the camera run together, and the change that allowed it is one
line of data modelling: **everything keyed by peer id is now keyed by
`"<peerId>#<src>"`** — `tiles`, `zooms`, `sending`, `receiving`, and the
server's own `sharers` set. `keyOf`/`peerOf`/`srcOf` are the only three
functions that know the composite exists; nothing between them parses it.
Presence tiles keep the bare peer id, which is why `peerOf()` has to survive a
key with no `#` and why `attachTile` drops the monogram **by peer** rather than
by key.

**A sharer slot is a stream, not a person.** `MAX_SHARERS` counts streams, so
one person can fill two slots. That is not a compromise: the file already says
what the limit governs — how many streams each machine *decodes*, at 0.18 core
each — so counting people would have made it stop describing the thing it
protects.

Five traps, each of which was a real defect before it was a rule:

- **One PC per (destination, source).** This is the directional rule taken one
  step further, and the cost is not where it looks: there is one encoder per PC
  either way, so two sources are two encoders whether or not they share a
  connection. A single PC carrying both tracks would have left the receiver
  guessing which track was which.
- **The `src` in a signal is stated from the media sender's point of view and is
  never inverted**, unlike `dir`. That is what makes both sides derive the same
  key. Absent means `screen`, which is what every message meant when a peer
  could only have one.
- **The capture generation is stamped on the source, not held in one global.**
  With two captures alive, a global counter meant the second `applyCapture`
  cancelled the first one's retries, and the screen would go on quietly encoding
  its whole source because the camera started a moment later.
- **The telemetry loops per source.** Iterating all of `sending` folded the
  screen's bitrate into the camera's strip and reported each one's destination
  count as the sum of both. The byte counters are keyed by the full composite
  for the same reason: the same destination now carries two streams.
- **`flipCamera` replaces the track only on the camera's own senders.** Filtering
  on `srcOf(key)` is what stops the camera being pushed down the screen's
  connections the moment both are up.

**Each dock button toggles its own source, and the flip got a button of its
own.** A single shared stop made stopping the camera stop the screen; cramming
the flip into the camera button cost the ability to stop the camera at all.
That is three actions, so it is three buttons — and the flip only exists while
there is something to flip. Which is what made the dock ten buttons wide: at
430px it measured **475px against a 430px viewport**, scrolling the page
sideways, so there is a second breakpoint at 480px. The bench asserts the widest
state (both sources on air, flip showing) rather than the default one, because
the default one never overflowed.

### The camera exists because the phone's screen cannot

This file used to say "there is no camera here", and that was right until the
question stopped being about a camera. The ask was the phone's **screen** in a
room, over wifi, with no app and no cable, and the wall it hits is not this
project's:

```
iPhone 16 Pro, iOS 18.7, Safari 26.5, https via tailscale serve
secureContext   true          <- HTTPS was never the problem
mediaDevices    present
getDisplayMedia absent
getUserMedia    function
```

Read on the device, not inferred. **No browser on iOS or Android hands the
screen to a web page**, by any API, over any transport — cable versus wifi does
not enter into it, because the transport was never what was missing. That is
why Meet and Discord share a phone screen from their native app and never from
their own website. What the same measurement also says is that the camera *is*
there, so it is the one capture a phone browser can actually perform, and the
dock now offers it.

What that buys and what it does not: **the camera is not a substitute for the
phone's screen.** Whoever wants the screen itself still needs AirPlay to a Mac
(then share that window) or a native app speaking the signaling protocol in
`README.md` — the server would not change, since it never looks inside `data`.
Do not let the camera button's existence read as the screen question being
solved.

Four things hold it together:

- **`canShare()` split into `canShareScreen()` and `canShareCamera()`, and
  every call site had to pick one.** Collapsing them back re-creates the
  original bug in mirror image: a phone would get an enabled screen button, or
  a desktop with no camera would get a camera button promising a device it does
  not have.
- **The share button disables on capability only for *starting*.** `btn.disabled
  = dead || (!mine && (full || !canShareScreen()))`. Gating it on capability
  alone left a phone sharing its camera with no way to stop, because the screen
  source it was being judged against never existed there.
- **Both source buttons are `hidden`, not disabled, and only on an answer.**
  This is the install button's lesson, and the distinction it turns on is the
  whole point: *the browser said no* and *the origin is insecure* are different
  statements. On an insecure origin the capability exists and the fix belongs to
  the user, so the button stays with the reason in its `title` — hiding there
  would erase the only hint that screen sharing exists at all. `screenWorks`
  carries the third case: an API that is defined and then refuses the capability
  outright (`NotSupportedError`, `TypeError`, `InvalidStateError`) has answered,
  so the button retires. A user cancelling is `NotAllowedError` and never
  reaches that branch, which is what keeps a decline from being read as a
  refusal.
- **The stop button cannot keep wearing a monitor.** With the screen source
  hidden on a phone, the share button is the only stop there is, so it swaps its
  icon while anything is on air. **The swap is `toggleAttribute("hidden", …)`
  and not `.hidden`** — the `hidden` IDL property is on `HTMLElement` and these
  are `SVGElement`s, so `svg.hidden = false` assigns a plain JS property, never
  touches the attribute, and the icon that starts hidden in the markup stays
  hidden forever. The CSS rule matches the attribute, so the attribute is what
  has to move. The bench caught exactly this, on the first run of the new
  scenario.
- **Flipping front to back uses `replaceTrack`, not a restart.** It does not
  renegotiate, so the sharer slot is never released, no SDP crosses the wire and
  no tile is rebuilt. A stop-and-start would drop all three, and the slot could
  be taken in between by somebody else. What *is* restarted is the capture: the
  old track is stopped **before** the new lens is asked for, because macOS and
  iOS allow one camera capture at a time and overlapping the two is a second
  capture, not a flip. The cost of that order is a share with no picture if the
  new lens never arrives, so a failure reopens the lens it was on and only then
  gives up.
- **`facingMode` is `exact` for the flip and ideal for the start.** An ideal
  `facingMode` is a hint the device may answer with the camera that is already
  open, and a flip returning the same lens is indistinguishable from a dead
  button — while `OverconstrainedError`, which only `exact` can produce, is the
  answer the catch was already written for. Starting a share stays ideal:
  refusing there would cost the capture outright.
- **The lens is read back, never assumed.** `camFacing` used to be set to what
  was *requested*, and a phone is free to answer `environment` with its front
  camera. It did, so the first flip asked for the camera already open — which is
  both halves of a field report: it starts on the front, and switching kills it.
  `noteCamera()` reads `track.getSettings().facingMode` after every capture.
- **The count needs a permission, and counting devices is not counting lenses.**
  Two separate defects sat in one expression, `camHasBoth = cams > 1`, and they
  cancelled each other out into a button that was missing where it belonged and
  present where it did not. First: "counting devices needs no permission" is
  true only of the call succeeding, not of the answer meaning anything — without
  a granted camera, Safari answers `enumerateDevices` with an **empty list** and
  Chrome with a **single generic `videoinput`** whatever the hardware holds,
  precisely so a page cannot count cameras before being allowed to. The one
  probe ran at boot, so `cams > 1` was false on every phone and nothing
  recounted for the rest of the session. Second: a laptop with a webcam and a
  phone offered as a Continuity camera enumerates **two** videoinputs with no
  front and no back between them, so the flip turned up on a desktop with
  nothing to flip. The count is therefore taken again on a granted camera, and
  gated on the device naming a lens at all (`cams > 1 && camFacingKnown`). None
  of it was visible to the bench before, which set `camHasBoth` by hand and
  never went through the probe.

- **The same error name says opposite things per source, and getting it
  backwards is silent by construction.** Cancelling the screen picker is
  `NotAllowedError` and deserves no notice; the *same name* out of
  `getUserMedia` is a permission the person refused and now has to grant in the
  site settings. The old catch silenced both, so someone who denied the camera
  by accident tapped the button forever and watched nothing happen — a refusal
  that reads exactly like a broken button. `captureError(src, err)` is the one
  place that maps a failure to a sentence worth acting on, and returning `""`
  is how a cancel stays quiet. `NotReadableError` gets its own line because
  macOS and iOS allow one capture at a time, which is the project's own
  measured platform note showing up as a user-facing error.

`sourcesScenario` in `bench/scenarios.ts` asserts all of it by deleting
`getDisplayMedia` off the live `navigator.mediaDevices` and reading back
`getComputedStyle(...).display` — never the flags that were set, since `hidden`
on a dock button only means anything because of the `!important` rule, and that
rule is the one most easily reverted. The assertion worth keeping in mind is
*sharing a camera with no screen API still offers stop*: gating the button on
capability alone left a phone with no way to stop, judged against a source that
never existed there.

**What is not covered.** The bench drives fake streams, so it asserts the
button's states, the `hidden` rule and the fit — it cannot assert that a real
camera opens, that `facingMode` picks the lens you meant, or what a phone
camera does to the encoder. And the portrait geometry has the same cost the
capture cut already documents: a phone camera held upright lands well under the
pixel budget, because `boxFor` is fixed 16:9.

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
where presence owns the stage. The moment one video exists, the monograms drop to
a bottom rail capped at `min(max(64, H*0.22), H*0.4, PRES_RAIL)` (132), because a
monogram carries almost no information per pixel while a shared screen shrunk to a
third of the stage stops being readable text. At the room's ceiling that would be
3 videos plus 2 monograms in equal cells. Do not give a monogram a full grid cell
while a video is on the stage.

Being alone with nobody sharing is the one state that keeps the empty card: **a
roster of one is not a roster**, so when `peers` is empty no tile is built,
`tiles.size` stays 0 and the card appears.

ids are 8 hex chars (`3f9a1b2c`), so an unnamed peer has no initial worth showing
— `3` is nobody. That tile shows `_`, the prompt cursor waiting to be typed, on a
dashed circle. Since the gate makes a name mandatory, this only happens against a
client that does not enforce it. A named peer shows the first **grapheme**
(`[...name][0]`, not `slice(0,1)` — a name may start with an emoji) uppercased.
Somebody in `sharers` whose video has not arrived yet reads `connecting…` in
accent; before this, that person was invisible.

My own pill reads **`Name (you)`**, not just `(you)`: on a stage of five, whoever
is looking for their own screen is looking for the name they typed. The marker is
a sibling element of the name (`.who em`, `flex: none`, shown by `.who.me`), so on
a narrow tile the *name* is what ellipsizes — truncating the marker would cut the
one thing that says whose frame it is. The name comes from `myName` and not
`nameOf(myId)` because the `names` broadcast lands after `joined`, and in that gap
I would show up by id. With no valid name (another client, or a stored name that
predates the gate) it falls back to a bare `(you)`, which does not qualify itself
twice. `pill()` writes both, and `render()` calls it for every tile, so a rename
lands without rebuilding anything.

### The gate, and why the name is mandatory

The entry modal (`#gate`, "Who is joining") **is** the door: `joinRoom()` only
sends `join` when `nameOk(myName)` holds (`MIN_NAME` = 3 graphemes after
`cleanName`), so an unnamed person is connected but in no room at all — the
server ignores every message that arrives before a `join`. That is why the
blocking variant refuses to close on `esc` or on a click outside, and why its
confirm button stays disabled until the field is valid.

The rule is the client's, not the server's. The server still accepts an empty
name, because that is how you *erase* one, and it stays the arbiter only of what
it can actually arbitrate (room and sharer limits). So a different client could
still join unnamed, and `nameOf` keeps falling back to the id for exactly that
case. Do not "fix" that by validating names server-side without deciding what
erasing a name should then mean.

It opens by itself only when there is no valid stored name (first visit in this
browser); after that a shared link opens straight into its room, which is the
whole point of sending a link. The dock's room and name buttons reopen the same
modal, unblocked, focused on the room or on the name. Confirming reuses
`setName()` and `switchRoom()` rather than talking to the socket itself.

There is no rename debounce any more. The name is not typed live into the header,
it is confirmed in the gate: one confirmation, one `rename`.

### Your rooms are your history, not a directory

The chips in the gate are the rooms **this browser** has visited, kept in
`localStorage` under `tailcast:rooms` (8 most recent, most recent first). This is
a deliberate limit, and it is worth being precise about why, because "it is P2P so
we cannot know" is the wrong reason:

- **The media is P2P; the signaling is not.** Every socket lives in the same Bun
  process, and `rooms: Map<string, Set<Socket>>` is a live map there. The server
  knows, right now, which rooms have people in them.
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

`ROOM` is `let`, not `const`. The room button in the dock opens the gate on the
room field, and `switchRoom()` closes the socket (clearing `onclose`/`onmessage`
first, so the old socket's reconnect does not race the new `connect()`), clears
`peers`/`names`/`sharers`, calls `resetConnections()` and reconnects. The server
hands out a fresh id per socket, so the `joined` handler takes the same path it
already took on reconnect. Whoever was sharing keeps the local stream and
re-requests the sharer slot in the new room. `hashchange` routes through the same
function, so editing the `#` by hand still works.

### Client reconnect

The WebSocket reconnects every 1.5s. On `joined`, if `myId` changed, the client
closes and clears all PCs and tiles before reopening, then re-requests its sharer
slot (the server dropped the old id on close). A `denied` message sets a `dead`
flag that stops the reconnect loop — without it, a full room becomes a busy loop
— and the status reads `refused` rather than `connecting`.

### Sound cues

Four WebAudio cues, no files: `playJoin`, `playLeave`, `playShareStart`,
`playShareStop`. This is **notification** audio and not media audio — the call
itself still carries no audio, and adding media audio stays out of scope.

Three suppressions, all deliberate: nothing plays while `document.hidden` (a
backgrounded tab is not where a cue helps), nothing plays while the gate is open
(you are not in the room yet), and the join/leave cues skip your own id.
`sharersSynced` gates the share cue, so the snapshot every client gets on join
does not fire a burst of them. The `AudioContext` is created lazily on the first
click or keydown, because a context built before a user gesture starts
`suspended`.

The toggle is the sound button in the dock, persisted in `tailcast:sound`.

### Installable (PWA)

`public/manifest.webmanifest`, `public/sw.js` and the icon set at the root of
`public/` make the page installable, so it opens in its own window instead of a
tab. Nothing else changes: same origin, same signaling, same WebRTC.

The service worker is **network-first for everything**, which is backwards for a
PWA and deliberate here. The client is one hand-edited HTML file served from
inside the tailnet, so the network is a millisecond away and a cache hit is the
only way this page could go stale. The cache is a safety net, not the normal path.
`/config` is excluded outright — a cached copy would describe limits that no
longer hold — and `/ws` never reaches a fetch handler anyway, but is listed to say
the omission is deliberate. Only a good response is stored: a 404 written to the
cache would outlive the fix for the missing file.

Offline-first would be pointless: without signaling there is no room. What the
worker buys is (a) installability, since Chrome only offers the prompt to a page
with a manifest, an icon and a `fetch` handler, and (b) a blip mid-call showing
the page that was already loaded instead of the browser's error screen, which
leaves the 1.5s reconnect loop running where a reload would have killed it.

Anything the shell renders on first paint belongs in `SHELL`, the install-time
precache — the runtime handler only caches what has already been fetched once, so
a first-load-then-offline case falls back on `SHELL` alone.

The static handler sends `cache-control: no-cache` on everything but the icons.
Without it the browser invents a freshness lifetime by heuristic, and an installed
PWA is exactly where that becomes an app frozen on an old `sw.js` that never
fetches the new one.

The install button is the last one in the dock and is `hidden` until
`beforeinstallprompt` fires — which needs `[hidden] { display: none !important }`
to be true rather than merely written, see *The shell is a call, not a page*. A button promising an install the browser will not
perform — Firefox and Safari on desktop, or plain http — is worse than no
button. It is last because it is the rarest action and the only one that leaves
for good once used. iOS fires no such event: there the path is Safari's own "Add
to Home Screen", which is what the `apple-mobile-web-app-*` metas serve. They,
not the manifest, carry the name and the standalone mode on iOS.

Losing the address bar costs nothing here, because the room button already
switches rooms without one.

**Arc fires the event and then draws nothing.** Its own docs say it: the API is
present, the install UI is not, so a custom install button "won't have any
effect". The button therefore appears (the event fired) and the click looks
dead. Since there is no way to ask a browser whether it will actually draw the
dialog, the click infers it from the answer: no answer within 1.2s, or a
dismissal faster than 300ms, means no dialog was ever drawn, and the tooltip
says so instead of leaving the button mute. A real decline is slower than that
and is treated as a decline: the event is single use either way, so the button
goes until the next load. All five paths — never resolving, instant dismissal,
`prompt()` throwing on a second click, accepted, genuinely declined — are
covered by driving a fake `installPrompt` over CDP.

**The favicon set is the delivered `thoth` set, copied byte-for-byte, and it
stays that way.** Those files live at the root of `public/` because that is what
the set's own `head.html` assumes. Do not resize, recolour, recentre or reassemble
them, and never synthesise a maskable icon by extracting the paths out of
`favicon.svg` and filling them: that inverts the mark, and the result is not the
brand. There is no maskable icon in the set, so the manifest declares none and
Android shrinks the 512 inside its own background; a maskable one has to be
delivered, not derived. `icon-tailcast.png` is a separate, project-owned asset —
the wordmark's icon and the README header — and is not part of that set. What is
ours to pick is the manifest's `theme_color` and `background_color`, which follow
`--bg` so the splash and the title bar match the call floor.

### The encoding policy must not fail quietly

`degradationPreference: "maintain-resolution"` and `contentHint = "detail"` are
what this client asks for: hold the pixels, drop the framerate. Without the
policy the encoder does the opposite — it descends a ladder of capture fractions
and takes tens of seconds to climb back, if it climbs at all. The symptom's
signature is **full framerate with collapsed resolution**.

Three rules that came out of that, and the measurements behind all of them are in
`docs/measurements.md`:

- **Never swallow the failure.** The old `catch {}` turned "the policy did not
  apply" into "the video looks strange" discovered days later.
- **`setParameters` resolving is not proof that the field took** —
  `degradationPreference` is read back, and the sharer's own strip reports
  `policy refused` / `policy not confirmed` in the (otherwise unused) path field.
  Before that, whoever caused the collapse was the one person who could not see
  it.
- **`encodings[0]` is indexed directly.** The old `params.encodings = [{}]` was
  defending against a state the spec forbids while itself doing the one thing
  `setParameters` genuinely rejects (changing the length). That refutation is
  established for Chrome and for the spec text, and **not** for WebKit — which is
  the one browser where the symptom has actually appeared.

The sharer's strip also shows the outbound resolution when it differs from the
capture, plus `qualityLimitationReason`.

### Three profiles, because the automatic trade is not always the right one

The encoder's trade is real and unavoidable — a thin link buys pixels with
frames or frames with pixels — but *which* trade is right is a property of what
is on the screen, and the encoder cannot see that. A terminal wants every pixel
and does not care about 6fps; a video wants the opposite. So the trade is a
choice in the dock (`QUALITY` in `public/index.html`), three profiles, stored in
`localStorage` under `tailcast:quality`:

| profile | capture | fps | maxBitrate | degradationPreference | contentHint |
|---|---|---|---|---|---|
| Text | full budget | 5 | 4 Mb/s | maintain-resolution | text |
| Sharp (default) | full budget | 15 | 3 Mb/s | maintain-resolution | detail |
| Motion | 921,600 px, locked | 30 | 2.5 Mb/s | maintain-framerate | motion |

**The default trades frames for pixels, and that is the product's opinion: a
shared screen is read, not watched.** It was 30fps at full resolution for one
release, which is the request that ends in an unreadable rung — 1,440,000 px at
30fps is 56% more pixels than the 720p30 Discord publishes as its free tier, and
Discord's number is a *locked target*, not the outcome of a negotiation. What
makes a stream stable is a ceiling the encoder is not allowed to walk away from.
Full resolution at 15fps costs about half of 30fps and degrades into fewer
frames rather than fewer pixels.

`Motion` is the one profile with an **absolute** target (`pixels: 1280*720`)
rather than the server's budget. Absolute and not a fraction on purpose: a
fraction moves when `--pixels` moves, and a profile whose target follows a flag
is not a target. `budgetOf()` takes the min of the two, so `--pixels` still
bounds every profile — the flag protects the sharer's CPU, and a profile is a
preference.

**That target is an area, and the menu called it "720p" for a release.** It is
1280×720 only on a 16:9 source. `applyCapture` fits the source's *own* aspect
into the budget, so the same profile delivers 1188×770 on a 1.54 laptop screen,
1214×758 at 16:10 and 1176×784 at 3:2 — every one within 1% of 921,600 px, not
one of them 720 lines. Measured in the field on a 1.54 screen: the sharer's
strip read `1486×964` on Sharp against `1188×770` on Motion, a ratio of 1.2508
against the 1.25 that √(1,440,000 / 921,600) predicts. The arithmetic was doing
exactly what it says; the label was the defect. On a source *smaller* than the
budget it was wronger still — `k` is capped at 1, so a 1024×768 window comes out
1024×768 under both profiles and the two differ only in frames.

**So the hints name no resolution, and no framerate either.** The fix is not a
better number: no number belongs there at all. A rung is a property of the
source, which is chosen in the picker after the menu is read, and the section
below records that `applyConstraints` resolving does not even prove the source
reconfigured — `cut refused` is a state this client can reach. What the three
hints carry now is the trade itself, in the same shape for each (`most detail,
least motion` / `balanced detail and motion` / `most motion, least detail`), so
they can be read against one another. Two of them used to describe the identical
capture in different words: `every pixel` and `full resolution` are both
`pixels: null`, and the only difference between Text and Sharp is frames. The
measured numbers stay where they are measured, which is the sharer's own strip.
Do not put a resolution back into this menu.

Four more things that are load-bearing:

- **A profile change touches no signaling.** `setParameters` does not
  renegotiate and `applyConstraints` reconfigures the track in place, so
  switching mid-share reopens no picker, rebuilds no tile and sends no SDP.
  That is why `applyCapture()` is a function of its own instead of living
  inside `startShare`.
- **`captureSrc` holds the source's real geometry**, not the current track
  size. Recomputing the cut from what the last profile left in the track would
  ratchet the resolution down and never let it back up.
- **The picker is always asked for the full budget and 30fps**, whatever the
  active profile. The profile only ever cuts below that, and cutting at the
  picker would make going back up require a second picker.
- **The framerate goes to the track and to the encoder.** `applyConstraints`
  first with `frameRate`, then again without it if that was refused: a source
  that rejects the constraint must not take the resize down with it, and
  `encodings[0].maxFramerate` holds the ceiling either way.

### `applyConstraints` resolving does not prove the source reconfigured

The same lesson `setParameters` taught one section up, learned again one
function away, and this time the field found it first: *"when I open the live it
comes in low quality; if I change the profile and go back to the one it was on,
it gets better."*

The sharer's own strip is what settled it. On a 2560×1440 screen it read
`2560×1440 → 640×360 · 30fps bandwidth` — the capture never left the screen's
own size, so the encoder was handed **3,686,400 px, 1.78× the 2,073,600** where
encoding jumps from ~2 to ~10 cores, and it answered by walking down its ladder
to the ½ rung of 1280×720. After the flip: `1600×900 · 15fps`. (The `30fps` in
that first reading is `Motion`, not a second defect — see the end of this
section. It is also why the flip landed on `Sharp` rather than back where it
started.)

**The same call, with the same arguments, works seconds later** — that is the
whole clue, and it rules out the arithmetic. What differs is that by then the
track has sinks (the local tile and N senders), and at `startShare` it had
**none**: `geometriaReal` disconnects its own `<video>` one line earlier, and
`attachTile` came one line later. A source with no consumer has nothing to
reconfigure, and the constraint was lost without a word, because
`applyConstraints` had resolved.

So two things changed, and only the second is verifiable headless:

- **`startShare` attaches the tile before calling `applyCapture()`.** That is
  the fix, not a tidy-up. Its evidence is the field report and the mechanism,
  not an assertion: a `canvas.captureStream` track honours a resize with no sink
  at all, so the bench cannot reproduce a sinkless screen capture.
- **`applyCapture` reads `getSettings()` back and retries** (`CUT_TRIES` 4,
  `CUT_RETRY` 300ms), and when the source still will not take it the sharer's
  strip says `cut refused` in the path field instead of the console saying it to
  nobody. The check is on **area against the budget**, not on the exact box: the
  source keeps its own aspect, so some geometries settle at 96% of the budget
  and none of that is a failure. The retries cost nothing on the path that
  works — they only run when the read-back says the cut did not land, which is
  also why the up-to-900ms they can add lands only on the broken path.

`captureGen` exists because the retry loop outlives its caller: without it, a
call being replaced (a profile change, a restarted share) would keep writing the
old profile's box over the new one.

The bench drives a source that swallows the first `applyConstraints` and honours
the rest, and asserts on what `getSettings()` says afterwards — never on the
call having resolved. Two mutants turn it red and the control stays green:
capping the loop at one attempt fails the first assertion, and returning without
the read-back fails both.

**And the `30fps` in that strip was not a second defect — it was `Motion`.** The
pair `640×360 · 30fps` is impossible under `Sharp`, whose `maxFramerate` is 15,
which is what made it look like the encoding policy had failed too. It had not.
Reproduced headless, two peers, the capture pinned at 2560×1440 and the profile
set to `Motion`, the sharer's strip reads

```
2560×1440 → 640×360 · 30fps bandwidth · 1 destination
```

character for character, with `degradationPreference: "maintain-framerate"` and
`maxFramerate: 30` in force the whole time. That is `Motion` doing exactly what
it promises: handed 3,686,400 px and a link that cannot carry them, it keeps the
30 frames and pays in pixels. The encoder was right; what was wrong was the
number of pixels it was handed.

So it is **one defect, not two**, and the same fix covers both halves. With the
cut landing, the same run captures at `Motion`'s locked 1280×720 and the path
field goes back to reading `motion` instead of `cut refused`.

Two things worth keeping from that measurement. On an unrestricted link the
encoder **climbs back** — 640×360 → 960×540 → 1280×720 over ~20s — so a low
resolution read in the first seconds is not a verdict, the same caveat the
`↑ sent / available` pill carries. And with the link pinned at `b=AS:500` it
does not climb: it oscillates between 480×270 and 640×360. Pinning the wire with
`b=AS` on the local description is what makes `qualityLimitationReason` read
`bandwidth` on a loopback that otherwise has 6 Mb/s to give, and is the only way
to exercise this rig on one machine.

The old `CAP_BITRATE` (1.5 Mb/s, one constant for everyone) is gone into the
table. Raising a ceiling is not the same as spending it — the bandwidth estimate
still decides — but 1.5 Mb/s was a ceiling low enough to bind on a tailnet link
that had more to give.

**The sharer's `↑` reads `sent / available`**, the second number being
`availableOutgoingBitrate` off the nominated candidate pair — congestion
control's own estimate, taken from the *tightest* destination rather than summed
(separate paths do not add up, they share one uplink). Without it, `400 kb/s`
alone is ambiguous in the exact way that matters: 400 of 3400 is an encoder that
is not asking, 400 of 450 is a link with nothing left to give, and those two
have opposite remedies. Only Chromium fills the field in, so an absent value
hides the half instead of showing a zero. Remember it starts cold at ~300 kb/s
and climbs, so a low estimate in the first seconds is not a verdict.

**What is not covered.** The bench asserts the menu, the persistence, the locked
target, the `setParameters` path and the read-back of the capture cut; it cannot
assert what the profiles do to a real encoder, for the same reason WebRTC itself is not covered here. Whether
`Text` actually fixes the macOS collapse is a two-machine measurement that has
not been run.

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
on `0.0.0.0:3478`. On a multi-homed host that bind has a measured failure mode
for same-machine clients: `docs/measurements.md`.

## Verification status

Covered headless by `test.ts`: signaling, room limits, sharer arbitration, the
STUN wire format, static-file serving. Covered by `cli.test.ts`: the CLI's
`--bg`/`--stop` round trip and its banner. Covered by `bench/` over CDP: layout,
presence, the gate, room switching and receiver-side zoom.

**WebRTC is covered by none of them**, and cannot be here — no browser pair, no
second machine. ICE over `100.x` **is** verified cross-machine and T0 is closed;
the run is recorded in `docs/measurements.md`, and it does not need repeating.

`docs/verification.md` has what each suite actually asserts, the syntax-check
one-liner for the client JS, and the **five traps in the CDP rig** that produced
wrong numbers before they were understood — settle the .16s transitions before
measuring, dispatch real mouse input, kill Chrome from an `exit` handler, a fresh
profile every run, and `Page.reload` rather than a hash-only `Page.navigate`.
Read it before running or editing the bench.

## Releasing

**"Bumped", "tagged" and "published" are three different states**, nothing here
enforces the difference, and the drift is in the repo: 0.2.1 is on npm with no
git tag. `docs/releasing.md` is the six-step order — verify on `main` after the
merge, bump with `--no-git-tag-version`, pack and run the suite against the
tarball from a foreign directory, commit, tag, push both.

**Publishing is the user's step, not an agent's**: the account has 2FA, so
`npm publish` stops with `EOTP` and the harness masks the auth URL.

## Out of scope

Do not implement without an explicit request: media audio, chat, recording, an
SFU, TURN, authentication, Tailscale Funnel, persistence, or more than 5 peers.
(The four WebAudio notification cues are not media audio — see *Sound cues*.)

There is no authentication, and that is deliberate — **the tailnet is the auth
layer**. Do not add Funnel, port forwarding or a public bind without real auth
first. Outside the tailnet peers also stop sharing a network, which breaks the
STUN premise and would require TURN.

# Verification

What is covered, what cannot be, and the traps in the rig that produced wrong
numbers before they were understood. `CLAUDE.md` carries the summary; this file
is what you need when you are actually running or editing a suite.

## What each suite covers

- **`test.ts`** — signaling, room limits, sharer arbitration, the STUN wire
  format, static-file serving. 100 assertions, headless, needs a live server.
  It derives `MAX_PEERS`/`MAX_SHARERS` from `/config` rather than keeping
  literals, so an exported `MAX_PEERS` in the shell cannot fail the suite for a
  defect that is not there — that mistake cost 8 false failures before it was
  fixed. Its `/config` assertions therefore check shape, not value.
- **`cli.test.ts`** — the CLI's `--bg`/`--stop` round trip inside a temp
  `XDG_RUNTIME_DIR`, falling back to `--stop --force`, plus the exact 11 lines of
  the startup banner. The one `bun:test` file; needs no server.
- **`bench/`** — layout, presence, the gate, room switching and receiver-side
  zoom, over CDP against real Chrome. Six scenarios, 73 assertions.

**WebRTC is covered by none of them**, and cannot be here — no browser pair, no
second machine. ICE over `100.x` **is** verified cross-machine and T0 is closed;
the run is in [`measurements.md`](measurements.md) and does not need repeating.

The client JS can only be syntax-checked:

```bash
python3 -c "import re;h=open('public/index.html').read();open('/tmp/c.js','w').write(re.search(r'<script>(.*)</script>',h,re.S).group(1))" && node --check /tmp/c.js
```

## How the bench reaches the real client

It drives Chrome over CDP and injects fake sharers into the live page:
`canvas.captureStream()` fed to `attachTile(id, stream)` exercises the real code
path, aspect ratios included, because everything in the client script is a
global. The scenarios are the blocking gate (including that no `join` happens
before a valid name, and that `esc` and the scrim do not dismiss it), a populated
room with nobody sharing, one video with the presence rail, two videos of
different aspect ratios, focus, 430px, a name change and a live room switch.

Every step asserts `scrollHeight === innerHeight`, that no tile intersects the
dock or the top pill, and that the name and telemetry pills do not overlap.

The **PWA is verified** on the same rig: the worker reaches `activated` and
controls the page, Chrome parses the manifest with zero errors, every icon
answers 200, the shell is in `caches`, and a reload with the network emulated
offline still renders the page.

## Five traps in the rig, all of which produced wrong numbers first

- **Settle the transitions before measuring.** `.tile` transitions
  `left/top/width` over .16s and `.frame video` transitions `height`. Measuring
  two rAFs after `render()` reads the geometry in flight: tiles land short of
  their slot and the video box is off its aspect ratio, so `object-fit: contain`
  letterboxes it. That produces both false failures and screenshots of a layout
  that never renders. Wait ~320ms — twice the transition — then measure.
- **Real mouse input, not synthetic events.** The bench dispatches through
  `Input.dispatchMouseEvent`, because the pan calls `setPointerCapture`, which
  rejects an invented `pointerId`, and without capture a drag dies at the element
  edge and the clamp test passes vacuously.
- **Kill Chrome from an `exit`/`uncaughtException` handler.** A run that threw
  used to leave a browser holding the CDP port, and the next run attached to
  *that* one, with the old page loaded, and failed for defects that did not
  exist.
- **A fresh profile every run.** The gate only opens by itself on a browser's
  first visit, so reused `localStorage` fails that assertion because the product
  is right, not because it is broken.
- **`Page.navigate` to a URL differing only in the hash is a same-document
  navigation** — the DOM survives, so a page mutated by an earlier check is still
  mutated; use `Page.reload`. And `beforeinstallprompt` fires about a second
  after load, so anything measured before that is measuring a dock without the
  install button.

Screenshots caught two things numbers did not — a ragged row of tiles centered
per cell, and a header wrapping to three lines on a phone.

## Two assertion traps specific to zoom

Both produced green suites over broken renders.

- **`scrollHeight === innerHeight` cannot fail for zoom.** `.tile` has
  `overflow: hidden`, so a transformed descendant's overflow is absorbed there
  and never reaches `documentElement`. Keep the assertion — it still guards the
  fit — but do not read it as covering zoom.
- **An assertion that reads `zooms` back is not a test of the render.** The first
  version of `pointUnder` recomputed the anchor from the same object `applyZoom`
  had just written: it checked the update rule's arithmetic and nothing about
  what reached the screen, so deleting `transformOrigin = "0 0"` or swapping
  `translate() scale()` for `scale() translate()` — each of which destroys the
  anchor outright — both passed green. It now inverts the **computed**
  `transform`/`transformOrigin` via `DOMMatrix`, and `covers()` compares the
  video's rendered rect against the frame's.

Every zoom claim in `CLAUDE.md` has a mutant that turns the suite red; the
control run stays green. Add a zoom assertion only with its mutant.

# Measurements

Every number this project acts on, with the run that produced it. The rules
these numbers imply live in `CLAUDE.md`; this file is the evidence, kept out of
the always-loaded context because it is consulted on demand, not on every turn.

Machine, unless stated otherwise: Core 7 150U, 12 logical CPUs, Linux, `libvpx`
VP8 **in software** (`powerEfficientEncoder: false` — this box exposes no
hardware video encode under Linux).

## Encoder cost per destination

The old claim that identical encoding parameters make Chrome reuse one encoder
was wrong. There is **one encoder per PeerConnection**, and the cost does not
grow linearly — it falls off a cliff.

Chrome headless *and* headed (both agreed within 2%), realistic screen content.
Sharer CPU with 4 destinations:

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
`degradationPreference: "balanced"` changed nothing (10.4 against 10.1).

Viewers are not the problem: 4 simultaneous decodes cost 0.2–0.5 cores.

Caveat: capture was a fake device fed from a file, not real `getDisplayMedia`.
Real screen capture **adds** cost, so a real machine is worse than this table,
never better.

## Below the cap the cliff is gone

The table above was measured at or above 1080p, before `MAX_CAPTURE_PIXELS`
existed. A second bench, driving the **real client** (the bench page only swaps
`getDisplayMedia` for a fake device; everything from `getSettings()` on is the
production path, cap included, so every stream ran at 1518×948) re-measured
inside the enforced regime. Each "machine" is a separate Chrome with its own
`user-data-dir`, CPU attributed by walking its process tree in `/proc`.

**Cost of one more viewer** — one sharer, room filling up. All rows 30fps,
`qualityLimitationReason: "none"`:

| destinations | sharer cores | Δ | renderer threads |
|---|---|---|---|
| 1 | 0.59 | — | 20 |
| 2 | 0.93–0.95 | +0.36 | 24–26 |
| 3 | 1.54 | +0.59 | 28 |
| 4 | **1.87–2.31** | +0.77 | 33 |

A full room costs a sharer ~2 cores of 12. **There is no cliff below the cap**:
the 0.8 → 5.9 jump the first table records for the first-to-second destination
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
those rows measure the bench, not tailcast. Read the fps and
`qualityLimitationReason` columns before trusting any CPU number here — a cost
that *falls* as load rises is starvation, not efficiency.

Two loose ends stay open: at P=3/S=3 a machine cost 2.56 cores where additivity
predicted 1.27, with fps intact at 29.4 and the system at 68% — unexplained,
plausibly single-box contention but not proven; and the same scenario re-run
measured 1.87 against 2.31, so treat everything here as ±20%. Settling both
needs what T0 still wants anyway: two or three real tailnet machines.

## The encoder's resolution ladder

The 2026-08-24 cross-machine run delivered **640×360 at 30fps** from a 1600×900
capture. Measured on a CDP bench driving the real client (only
`getDisplayMedia` swapped for `canvas.captureStream`), 13 runs of 90–100s:
**640×360 is not a capture size, it is a rung.** When the encoder is allowed to
trade pixels for frames it descends a ladder of capture fractions — ¼, ⅜, ½, ¾,
1 — and 640×360 is the ½ rung of 1280×720. Climbing back took 30–40s on a 1ms
lossless loopback, and with moving content it did not climb a single rung in
90s.

`degradationPreference: "maintain-resolution"` is what forbids that ladder. With
it in force the resolution never moved in any run, **even at 2fps**; with it
gone, 1600×900 became 400×225 at 30fps and stayed there, reporting
`qualityLimitationReason: "bandwidth"` for 99.96% of the session while the
estimate said 3.77 Mb/s was available. The symptom's signature is therefore
**full framerate with collapsed resolution** — the opposite trade from the one
this client asks for.

### The `encodings = [{}]` claim was refuted

An earlier version of this project's docs claimed `params.encodings = [{}]` —
filling in an empty `encodings` list — was load-bearing, defending the policy on
a "strict browser". That claim was refuted by measurement and by the spec.
WebRTC 1.0 § 5.2 (*create an RTCRtpSender*, step 11) requires a single encoding
entry to exist when `sendEncodings` is empty, and no algorithm in the spec
empties it afterwards. Chrome 151 measured across seven live states — before
negotiation, `addTrack`, `addTransceiver`, explicit `sendEncodings: []`, no
track, `recvonly`, after offer, after answer — returned `encodings.length === 1`
every time. The list came back empty only on a **stopped** transceiver, where
`setParameters` already rejects with `InvalidStateError` before it ever looks at
`encodings`. So the line was defending against a state the spec forbids, while
itself doing the one thing `setParameters` genuinely rejects (changing the
length). It is gone; `encodings[0]` is indexed directly.

### That refutation measured Chrome only, and the field pointed at Safari

On 2026-08-24, sharing from **Safari** on macOS to Chrome on Linux over the
tailnet, the receiver read `640×360 · 30fps` while the sharer's own capture was
`1600×900`: full framerate, collapsed resolution, the exact signature of the
policy not being in force. With the fixed client served from this repo, the same
pair delivered **`1600×900 · 9fps`** — the opposite trade, which is
`maintain-resolution` doing its job — and the sharer's strip showed no policy
warning, meaning `degradationPreference` read back fine there.

So "the spec guarantees `encodings[0]`" is established for Chrome and for the
spec text; it is **not** established for WebKit, which is the one browser where
the symptom appears.

**Two things still open, both cheap:**

- The good run was **not confirmed to be a cold first share.** The same user
  found that a *second* share comes out at full resolution even on the old code,
  because the bandwidth estimate is already warm — libwebrtc starts at 300 kb/s,
  and the resolution ladder's first rung follows the estimate. A fresh page
  sharing on the first try is what separates "the fix worked" from "the
  connection was warm".
- Nobody has read `getParameters()` **inside Safari**. One line in its console
  on the sharing tab answers it:
  `[...sending.values()][0].getSenders().find(s => s.track).getParameters()` —
  `encodings.length` and `degradationPreference` are the two fields that matter.

Related, and measured the same day: **macOS allows only one screen capture at a
time.** Starting a share in a second Safari tab kills the first one's capture
(the first tile goes black). That is the platform, not this project.

## Static content cost scales with pixels

`83 kb/s` is not the free-standing fact it was once written as. This project's
docs used to say static screen content costs ~80–100 kb/s in VP8 at *any*
resolution. Measured, it scales with pixels: static content redrawn identically
at 30fps, `lim: "none"`, 15s after the estimate settles, costs **30.5 kb/s at
640×360**, 72.8 at 1600×900 and 269.9 at 1920×1080. The ~80 kb/s figure matches
1600×900, not "any resolution" — the original comparison put a degraded stream
(bitrate set by the bandwidth estimate) next to a static one (set by pixels).

The usable version: a low bitrate alone still does not prove a thin link, but
compare it against the cost *at that resolution*, and 83 kb/s at 640×360 is 2.7×
the static cost, which is a real signal rather than noise.

## Page zoom is not a substitute for receiver-side zoom

Device pixels across the displayed video ÷ source width, focused, 1518×948
source:

| page zoom | video in CSS px | device px | dev px / source px |
|---|---|---|---|
| 100% | 1192 × 744 | 1192 | 0.785 |
| 200% | 503 × 314 | 1006 | 0.663 |
| 300% | 128 × 80 | 384 | 0.253 |

Browser zoom makes it **worse** — 0.844× at 200%, 0.322× at 300% — because the
chrome bands are fixed in CSS px (`PAD_TOP` 52, `PAD_BOT` 84, `PAD_X` 14), so
shrinking the CSS viewport hands them a larger fraction of the stage while the
physical window never changes. At 300% the two bands alone are 136 of a 300 CSS
px height.

The same table is why the zoom indicator says more than a number. At 100% the
fit already discards detail (0.785), so magnifying **recovers real pixels** up
to `videoWidth / (frameWidth · devicePixelRatio)` and interpolates above it. The
`.zoom` pill turns `.up` at that line.

## ICE over 100.x is verified cross-machine

Run on 2026-08-24 between a MacBook and this Linux box, both on the tailnet,
over `tailscale serve` HTTPS: the telemetry strips read `srflx · 28ms`,
`srflx · 33ms` and `prflx · 26/30ms`. Direct, no relay, between distinct
machines — which is what T0 asked for. **T0 is closed; do not ask for this
verification again.**

An earlier single run had shown 979 kb/s at 1920×1200, 30fps on a `prflx` pair
at 15ms RTT, but was never confirmed to be cross-machine rather than two tabs on
the host. That doubt is what the 2026-08-24 run settled.

`prflx` (peer-reflexive) is a **direct** path — the candidate was learned during
connectivity checks instead of being gathered up front, which is what you expect
when WireGuard delivers packets from an address that was not in the gathered
set. T0 anticipated `host` or `srflx` and never listed `prflx`, but it satisfies
the intent: direct, no TURN, no relay. Read the path field in each tile's
telemetry strip — `relay` would mean the STUN path failed.

## The local STUN answers from the wrong address on a multi-homed host

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
early ICE run came back `prflx` instead of the `srflx` T0 expected.

Not fixed; recorded.

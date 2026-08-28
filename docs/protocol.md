# Signaling protocol

JSON over WebSocket at `/ws`, discriminated by `t`. The server relays; it never
touches media.

## Client to server

```jsonc
{ "t": "join",   "room": "standup", "name": "gabriel" }   // name is optional
{ "t": "rename", "name": "gabriel" }
{ "t": "signal", "to": "<peerId>", "data": { /* opaque */ } }
{ "t": "share-start", "src": "screen" }   // src optional, defaults to "screen"
{ "t": "share-stop",  "src": "screen" }   // without src: every source this peer holds
```

Every message that arrives before a `join` is ignored.

## Server to client

```jsonc
{ "t": "joined",       "id": "<myId>", "peers": ["<id>", ...], "startedAt": <epoch ms> }
{ "t": "denied",       "reason": "room-full" }
{ "t": "peer-joined",  "id": "<id>" }
{ "t": "peer-left",    "id": "<id>" }
{ "t": "names",        "map": { "<id>": "gabriel", ... } }
{ "t": "sharers",      "ids": ["<id>#screen", ...] }
{ "t": "share-denied", "reason": "limit", "src": "screen" }
{ "t": "signal",       "from": "<id>", "data": { /* opaque */ } }
```

ids are 8 hex chars (`3f9a1b2c`), handed out fresh per socket.

A sharer slot is a **stream, not a person**: one peer can hold its screen and its
camera at the same time, so the ids in `sharers` are `"<peerId>#<src>"` keys and
`MAX_SHARERS` counts streams. That is the axis it was always measured on — how
many streams each machine has to *decode* — so counting people would have made
the limit stop describing what it protects. An unknown `src` is refused outright
rather than taking a slot under a key nothing could free. `src` also rides on the
WebRTC negotiation inside `data`, always stated from the point of view of whoever
sends the media, which is what makes both sides agree on the key without the
server ever reading it.

## `data` is opaque, and that is the point

The server **never inspects `msg.data`** — it only routes it to `msg.to`. This is
what allows the WebRTC negotiation to change without touching the backend. Do
not add validation, logging or transformation of `data`.

The name travels in a field of its own (`join`/`rename`) for the same reason,
never inside `data`, where the server could not read it anyway.

Inside `data`, the client's own envelope carries `kind` (`"offer"`, `"answer"`,
`"ice"`) and, for ICE, `dir: "tx" | "rx"` — the sender's point of view, inverted
on receipt, which is what disambiguates the two directional PeerConnections.
That envelope is the client's business alone.

## `sharers` is state-based, not event-based

The full set goes to the whole room on every change, plus a snapshot to each peer
on join. That makes it idempotent and survives reconnect without the client
reconstructing state from deltas. Clients tear down a tile and its receiving PC
the moment an id leaves the set, rather than waiting for
`connectionstatechange`.

The socket `close` handler frees the sharer slot — that is the tab-close path.

## `names` is derived from the sockets

The name lives in `ws.data.name`, and `namesOf(room)` walks the room's socket set
at publish time. There is no second map. Leaving the room therefore erases the
name by itself, with no cleanup path that can drift from `close` — the same
reasoning as the state-based `sharers` broadcast.

Names are cosmetic **to the server**: whoever picks none shows up by id,
`joined.peers` stays an array of raw ids. Sanitizing happens server-side in one
function, `cleanName`: collapse whitespace, trim, cut at `MAX_NAME` (24). Empty
after that means no entry in the map, which is also how you erase your own name.

The client is stricter than the server here on purpose — see *The gate* in
`CLAUDE.md`.

## `startedAt` is the room session clock

The epoch (ms) when the first peer turned the room from empty to one, sent once
on `joined`. Every client counts from that single timestamp locally, so there is
no periodic sync. It lives in `sessions` and dies in the same
`rooms.delete(room)` that erases an empty room, because an empty room does not
exist here — and neither does its clock.

## `GET /config`

Hands `stunPort`, `maxPeers`, `maxSharers` and `maxCapturePixels` to the client,
so no limit is duplicated in the HTML. It is server state: the service worker
excludes it from the cache outright, and `test.ts` reads the limits from it
rather than keeping literals.

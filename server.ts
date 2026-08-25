import type { ServerWebSocket } from "bun";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { startStun } from "./stun";

// resolved against the module, never against the cwd: installed as a package
// the process runs from whatever directory invoked it, and "./public" would
// point at nothing. that is how the page went missing in the first real install.
const PUBLIC_DIR = nodePath.join(import.meta.dir, "public");

/** absolute path inside public/, or null if the route tries to escape it. */
function resolverEstatico(pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null; // broken %-encoding
  }
  // null byte before any resolution: normalize and resolve both preserve the
  // \0, startsWith approves the path, and Bun.file() is what throws later. no
  // file is ever read, but the exception became Bun's error page: 67 KB with
  // the install path and source lines, out of a 20-byte request.
  if (rel.includes("\0")) return null;
  if (rel === "/" || rel === "") rel = "/index.html";
  const alvo = nodePath.resolve(PUBLIC_DIR, "." + nodePath.posix.normalize(rel));
  if (alvo !== PUBLIC_DIR && !alvo.startsWith(PUBLIC_DIR + nodePath.sep)) return null;
  return alvo;
}

// the banner names the version, so a bug report carries it. read lazily and
// defensively: server.ts also runs straight from a clone.
function versao(): string {
  try {
    const raw = readFileSync(nodePath.join(import.meta.dir, "package.json"), "utf8");
    return JSON.parse(raw).version || "?";
  } catch {
    return "?";
  }
}

/* the environment is untrusted input, and Number() accepts things that are not
   numbers: MAX_PEERS= (empty) became 0 and locked everyone out, MAX_PEERS=five
   became NaN, and with NaN every `set.size >= MAX_*` is false, so the room cap
   and the sharer arbitration vanished in silence while the UI kept announcing
   "3/3". the server is the arbiter, and an arbiter that read NaN arbitrates
   nothing. only a positive integer passes; anything else falls back to the
   measured default and names itself on stderr. */
// twin of `num()` in bin/cli.ts: same rule, two sides of the same boundary.
// if the rule changes here, change it there.
function int(nome: string, padrao: number, max = Number.MAX_SAFE_INTEGER): number {
  const bruto = process.env[nome];
  if (bruto === undefined) return padrao;
  const limpo = bruto.trim();
  const n = Number(limpo);
  // the regex is what rejects " 0x10 ", "1e3", "2.5" and "", all accepted by
  // Number() and none of them an integer written as an integer.
  if (!/^\d+$/.test(limpo) || !Number.isSafeInteger(n) || n < 1 || n > max) {
    const faixa = max === Number.MAX_SAFE_INTEGER ? "a positive integer" : `an integer between 1 and ${max}`;
    process.stderr.write(`${nome}=${JSON.stringify(bruto)} is not ${faixa}; using ${padrao}\n`);
    return padrao;
  }
  return n;
}

const PORT = int("PORT", 3000, 65535);
const STUN_PORT = int("STUN_PORT", 3478, 65535);

// peers per room (--peers). the 6th gets `denied` and stays out.
const MAX_PEERS = int("MAX_PEERS", 5);

// how many can transmit at once (--sharers). the server is the only place that
// sees a whole room, so the decision lives here: two simultaneous clicks on
// different machines are only serializable in one place.
//
// it was 2 out of a CPU fear aimed at the wrong axis: a sharer runs
// MAX_PEERS-1 encoders, not MAX_SHARERS. one more sharer creates no encoder
// anywhere, it creates a decode, measured at 0.18 core. 3 is where the clean
// measurement stops; see the table in CLAUDE.md.
const MAX_SHARERS = int("MAX_SHARERS", 3);

// capture pixel budget (1600×900). above 1920×1080 WebRTC gives each
// PeerConnection ~8 encode threads instead of ~3, and with several
// destinations that saturates the CPU: measured with 4 destinations,
// 1920×1080 cost 10.12 of 12 cores at 6-9 fps while 1600×900 cost 1.95 cores
// at a full 30. the default is the measured number.
const MAX_CAPTURE_PIXELS = int("MAX_CAPTURE_PIXELS", 1_440_000);

// cosmetic to the server: whoever picks no name shows up by id, which is the
// only identifier the server guarantees.
const MAX_NAME = 24;

type Client = { id: string; room: string; name: string };
type Socket = ServerWebSocket<Client>;

const rooms = new Map<string, Set<Socket>>();
const sharers = new Map<string, Set<string>>();

// room session clock: the epoch (ms) when the first peer joined. it lives in
// the same lifecycle as the room itself — set when the room is born, deleted
// when it empties — so the whole room counts from one timestamp and nobody
// needs periodic syncing. client-side skew between machines is sub-second and
// irrelevant; everyone anchors on the same value.
const sessions = new Map<string, number>();

function broadcast(room: string, payload: unknown, except?: Socket) {
  const set = rooms.get(room);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const peer of set) if (peer !== except) peer.send(msg);
}

function sharersOf(room: string) {
  let set = sharers.get(room);
  if (!set) sharers.set(room, (set = new Set()));
  return set;
}

// state-based broadcast, not event-based: the whole set ships on every change.
// idempotent, survives reconnect, and the client never rebuilds state from
// deltas.
function publishSharers(room: string) {
  if (!rooms.has(room)) return;
  broadcast(room, { t: "sharers", ids: [...sharersOf(room)] });
}

// sanitizing happens server-side, in one place. empty after this means no entry
// in the map, which is also how you erase your own name.
function cleanName(raw: unknown) {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

// the map is derived from the room's sockets at publish time, not kept in a
// second Map. leaving the room therefore erases the name by itself, with no
// cleanup path that can drift from close.
function namesOf(room: string) {
  const map: Record<string, string> = {};
  for (const peer of rooms.get(room) ?? []) {
    if (peer.data.name) map[peer.data.id] = peer.data.name;
  }
  return map;
}

function publishNames(room: string) {
  if (!rooms.has(room)) return;
  broadcast(room, { t: "names", map: namesOf(room) });
}

Bun.serve<Client>({
  port: PORT,

  /* safety net for the whole handler, not just the null byte. without error()
     Bun answers with its debug page, and the default is development mode
     because NODE_ENV !== "production" in any `bunx`. that is 67 KB carrying the
     absolute install path and source excerpts, reachable by anyone who reaches
     the port. the stack stays on the server, where it is useful. */
  error(err) {
    console.error(err);
    return new Response("internal error", { status: 500 });
  },

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const data: Client = { id: crypto.randomUUID().slice(0, 8), room: "", name: "" };
      return server.upgrade(req, { data })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname === "/config") {
      return Response.json({ stunPort: STUN_PORT, maxPeers: MAX_PEERS, maxSharers: MAX_SHARERS, maxCapturePixels: MAX_CAPTURE_PIXELS });
    }

    const alvo = resolverEstatico(url.pathname);
    if (!alvo) return new Response("not found", { status: 404 });
    const file = Bun.file(alvo);
    return (await file.exists())
      ? new Response(file)
      : new Response("not found", { status: 404 });
  },

  websocket: {
    message(ws, raw) {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.t === "join") {
        if (ws.data.room) return; // already in; a repeated join is a no-op

        const room = String(msg.room || "room").slice(0, 64);
        let set = rooms.get(room);
        if (!set) rooms.set(room, (set = new Set()));

        if (set.size >= MAX_PEERS) {
          // never enters the Set, emits no peer-joined and leaves ws.data.room
          // empty, so the close() later announces nobody.
          ws.send(JSON.stringify({ t: "denied", reason: "room-full" }));
          if (!set.size) rooms.delete(room);
          return;
        }

        ws.data.room = room;
        ws.data.name = cleanName(msg.name);
        const peers = [...set].map((p) => p.data.id);
        // the first peer in an empty room is also the room's birth: that is
        // when the session clock starts.
        if (set.size === 0) sessions.set(room, Date.now());
        set.add(ws);

        ws.send(JSON.stringify({ t: "joined", id: ws.data.id, peers, startedAt: sessions.get(room) }));
        // snapshot of who is transmitting, for whoever just arrived. this is
        // what makes the state-based broadcast survive a reconnect.
        ws.send(JSON.stringify({ t: "sharers", ids: [...sharersOf(room)] }));
        broadcast(room, { t: "peer-joined", id: ws.data.id }, ws);
        // if they brought a name the map changed for the whole room, so one
        // broadcast serves both sides.
        if (ws.data.name) publishNames(room);
        else ws.send(JSON.stringify({ t: "names", map: namesOf(room) }));
        return;
      }

      if (!ws.data.room) return; // nothing below makes sense outside a room

      if (msg.t === "rename") {
        const name = cleanName(msg.name);
        if (name === ws.data.name) return; // idempotent, no re-broadcast
        ws.data.name = name;
        publishNames(ws.data.room);
        return;
      }

      if (msg.t === "share-start") {
        const set = sharersOf(ws.data.room);
        if (!set.has(ws.data.id) && set.size >= MAX_SHARERS) {
          ws.send(JSON.stringify({ t: "share-denied", reason: "limit" }));
          return;
        }
        if (set.has(ws.data.id)) return; // idempotent, no re-broadcast
        set.add(ws.data.id);
        publishSharers(ws.data.room);
        return;
      }

      if (msg.t === "share-stop") {
        const set = sharersOf(ws.data.room);
        if (!set.delete(ws.data.id)) return;
        publishSharers(ws.data.room);
        return;
      }

      // opaque relay: the server never looks inside data, it only delivers.
      if (msg.t === "signal" && msg.to) {
        const set = rooms.get(ws.data.room);
        if (!set) return;
        for (const peer of set) {
          if (peer.data.id === msg.to) {
            peer.send(JSON.stringify({ t: "signal", from: ws.data.id, data: msg.data }));
            break;
          }
        }
      }
    },

    close(ws) {
      const room = ws.data.room;
      if (!room) return; // never got in (denied by a full room, say)

      const set = rooms.get(room);
      if (!set) return;
      set.delete(ws);

      // the tab-close path: free the sharer slot.
      const wasSharing = sharers.get(room)?.delete(ws.data.id);
      // the name lives on the socket, so leaving already took it out of the
      // map. someone who left unnamed changes nothing and needs no broadcast.
      const hadName = !!ws.data.name;

      if (!set.size) {
        rooms.delete(room);
        sharers.delete(room);
        sessions.delete(room);
        return;
      }

      broadcast(room, { t: "peer-left", id: ws.data.id });
      if (wasSharing) publishSharers(room);
      if (hadName) publishNames(room);
    },
  },
});

startStun(STUN_PORT);

console.log(
  `ss ${versao()}\n` +
  `  http        http://localhost:${PORT}\n` +
  `  stun  udp   :${STUN_PORT}\n` +
  `  room        ${MAX_PEERS} peers  ·  ${MAX_SHARERS} sharers`
);

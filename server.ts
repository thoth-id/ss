import type { ServerWebSocket } from "bun";
import { startStun } from "./stun";

const PORT = Number(process.env.PORT ?? 3000);
const STUN_PORT = Number(process.env.STUN_PORT ?? 3478);

// Teto de peers por sala. O 6º recebe `denied` e não entra.
const MAX_PEERS = 5;

// Quantas pessoas podem transmitir ao mesmo tempo. Vira 1 trocando o número.
// O servidor é o único ponto que vê a sala inteira, então a decisão mora aqui:
// dois cliques simultâneos em máquinas diferentes só são serializáveis num lugar.
const MAX_SHARERS = 2;

type Client = { id: string; room: string };
type Socket = ServerWebSocket<Client>;

const rooms = new Map<string, Set<Socket>>();
const sharers = new Map<string, Set<string>>();

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

// Broadcast baseado em estado, não em evento: manda o conjunto inteiro toda vez
// que ele muda. Idempotente, sobrevive a reconnect, e o cliente nunca precisa
// reconstruir estado a partir de deltas.
function publishSharers(room: string) {
  if (!rooms.has(room)) return;
  broadcast(room, { t: "sharers", ids: [...sharersOf(room)] });
}

Bun.serve<Client>({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const data: Client = { id: crypto.randomUUID().slice(0, 8), room: "" };
      return server.upgrade(req, { data })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    }

    if (url.pathname === "/config") {
      return Response.json({ stunPort: STUN_PORT, maxPeers: MAX_PEERS, maxSharers: MAX_SHARERS });
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file("./public" + path);
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
        if (ws.data.room) return; // já entrou; join repetido é no-op

        const room = String(msg.room || "sala").slice(0, 64);
        let set = rooms.get(room);
        if (!set) rooms.set(room, (set = new Set()));

        if (set.size >= MAX_PEERS) {
          // Não entra no Set, não emite peer-joined e ws.data.room fica vazio,
          // então o close() depois não vai anunciar um peer que ninguém viu.
          ws.send(JSON.stringify({ t: "denied", reason: "room-full" }));
          if (!set.size) rooms.delete(room);
          return;
        }

        ws.data.room = room;
        const peers = [...set].map((p) => p.data.id);
        set.add(ws);

        ws.send(JSON.stringify({ t: "joined", id: ws.data.id, peers }));
        // Estado atual de quem transmite, pra quem acabou de chegar. É o que
        // faz o broadcast por estado sobreviver a reconnect.
        ws.send(JSON.stringify({ t: "sharers", ids: [...sharersOf(room)] }));
        broadcast(room, { t: "peer-joined", id: ws.data.id }, ws);
        return;
      }

      if (!ws.data.room) return; // nada abaixo faz sentido fora de uma sala

      if (msg.t === "share-start") {
        const set = sharersOf(ws.data.room);
        if (!set.has(ws.data.id) && set.size >= MAX_SHARERS) {
          ws.send(JSON.stringify({ t: "share-denied", reason: "limit" }));
          return;
        }
        if (set.has(ws.data.id)) return; // idempotente, não re-broadcasta
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

      // Relay opaco: o servidor nunca olha dentro de data, só entrega.
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
      if (!room) return; // nunca entrou (ex: denied por sala cheia)

      const set = rooms.get(room);
      if (!set) return;
      set.delete(ws);

      // Caminho do fechamento de aba: libera a vaga de sharer.
      const wasSharing = sharers.get(room)?.delete(ws.data.id);

      if (!set.size) {
        rooms.delete(room);
        sharers.delete(room);
        return;
      }

      broadcast(room, { t: "peer-left", id: ws.data.id });
      if (wasSharing) publishSharers(room);
    },
  },
});

startStun(STUN_PORT);

console.log(`http  :${PORT}`);
console.log(`stun  udp :${STUN_PORT}`);
console.log(`peers/sala ${MAX_PEERS}  ·  sharers ${MAX_SHARERS}`);

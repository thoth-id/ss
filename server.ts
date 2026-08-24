import type { ServerWebSocket } from "bun";
import nodePath from "node:path";
import { startStun } from "./stun";

// Resolvido contra o módulo, nunca contra o cwd: instalado como pacote, o
// processo roda do diretório de quem chamou, e "./public" apontaria para o
// nada. Foi assim que a página sumiu no primeiro teste de instalação real.
const PUBLIC_DIR = nodePath.join(import.meta.dir, "public");

/** Caminho absoluto dentro de public/, ou null se a rota tenta escapar dele. */
function resolverEstatico(pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null; // %-encoding quebrado
  }
  if (rel === "/" || rel === "") rel = "/index.html";
  const alvo = nodePath.resolve(PUBLIC_DIR, "." + nodePath.posix.normalize(rel));
  if (alvo !== PUBLIC_DIR && !alvo.startsWith(PUBLIC_DIR + nodePath.sep)) return null;
  return alvo;
}

const PORT = Number(process.env.PORT ?? 3000);
const STUN_PORT = Number(process.env.STUN_PORT ?? 3478);

// Teto de peers por sala (flag --peers). O 6º recebe `denied` e não entra.
const MAX_PEERS = Number(process.env.MAX_PEERS ?? 5);

// Quantas pessoas podem transmitir ao mesmo tempo (flag --sharers).
// O servidor é o único ponto que vê a sala inteira, então a decisão mora aqui:
// dois cliques simultâneos em máquinas diferentes só são serializáveis num lugar.
//
// Era 2 por medo de CPU, e o medo estava no eixo errado: o número de encoders
// de quem transmite é MAX_PEERS-1, não MAX_SHARERS. Um sharer a mais não cria
// encoder nenhum na máquina de ninguém — cria um decode, que custa 0,18 core.
// Medido: 4 destinos custam ~2 cores de 12, e receber um segundo stream soma
// 0,18. Ver a tabela no CLAUDE.md. 3 é onde a medição limpa termina; 4 e 5 não
// foram medidos porque 5 Chromes não cabem numa caixa de 12 cores.
const MAX_SHARERS = Number(process.env.MAX_SHARERS ?? 3);

// Teto de pixels da captura (equivalente a 1600×900). Acima de 1920×1080 o
// WebRTC passa a usar ~8 threads de encode por PeerConnection em vez de ~3, e
// com vários destinos isso satura a CPU: medido em bancada com 4 destinos,
// 1920×1080 custou 10,12 cores de 12 e entregou 6–9 fps, enquanto 1600×900
// custou 1,95 cores com 30 fps cheios. O padrão é o número medido; a flag
// --pixels existe para quem quiser testar outro, não para uso rotineiro.
const MAX_CAPTURE_PIXELS = Number(process.env.MAX_CAPTURE_PIXELS ?? 1_440_000);

// Teto do nome escolhido por cada peer. Só cosmético: quem não escolher aparece
// pelo id, que é o que o servidor garante ser único.
const MAX_NAME = 24;

type Client = { id: string; room: string; name: string };
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

// Saneamento num lugar só, no servidor: colapsa espaços, apara e corta em
// MAX_NAME. Nome vazio depois disso não vira entrada no mapa — o cliente cai no
// id. É também o caminho de apagar o próprio nome.
function cleanName(raw: unknown) {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

// O mapa é derivado dos sockets da sala na hora de publicar, não guardado num
// Map à parte. Assim sair da sala já apaga o nome, sem um segundo caminho de
// limpeza que possa divergir do close. Mesmo motivo do broadcast por estado dos
// sharers: o mapa inteiro vai junto toda vez, e nunca precisa ser reconstruído
// de deltas do outro lado.
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
        ws.data.name = cleanName(msg.name);
        const peers = [...set].map((p) => p.data.id);
        set.add(ws);

        ws.send(JSON.stringify({ t: "joined", id: ws.data.id, peers }));
        // Estado atual de quem transmite, pra quem acabou de chegar. É o que
        // faz o broadcast por estado sobreviver a reconnect.
        ws.send(JSON.stringify({ t: "sharers", ids: [...sharersOf(room)] }));
        broadcast(room, { t: "peer-joined", id: ws.data.id }, ws);
        // Nomes: snapshot pra quem chegou. Se ele trouxe nome, o mapa mudou pra
        // sala inteira e um broadcast só atende os dois lados.
        if (ws.data.name) publishNames(room);
        else ws.send(JSON.stringify({ t: "names", map: namesOf(room) }));
        return;
      }

      if (!ws.data.room) return; // nada abaixo faz sentido fora de uma sala

      if (msg.t === "rename") {
        const name = cleanName(msg.name);
        if (name === ws.data.name) return; // idempotente, não re-broadcasta
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
      // O nome mora no socket, então sair já o tirou do mapa; só falta contar
      // pra sala. Quem saiu sem nome não muda nada e não gera broadcast à toa.
      const hadName = !!ws.data.name;

      if (!set.size) {
        rooms.delete(room);
        sharers.delete(room);
        return;
      }

      broadcast(room, { t: "peer-left", id: ws.data.id });
      if (wasSharing) publishSharers(room);
      if (hadName) publishNames(room);
    },
  },
});

startStun(STUN_PORT);

console.log(`http  :${PORT}`);
console.log(`stun  udp :${STUN_PORT}`);
console.log(`peers/sala ${MAX_PEERS}  ·  sharers ${MAX_SHARERS}`);

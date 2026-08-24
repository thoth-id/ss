// Suíte headless. Cobre servidor estático, signaling, STUN, teto de peers (T1),
// arbitragem de sharers (T2), nomes de peers e a parte servidor do reconnect (T3).
//
// WebRTC não é coberto aqui — precisa de browser e duas máquinas (T0).
//
//   (bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); sleep 2; \
//     timeout 60 bun run test.ts; kill $(cat /tmp/p)

import dgram from "node:dgram";

// Mesmas variáveis que o servidor lê, pra poder subir a suíte numa porta livre
// sem derrubar um servidor que já esteja rodando em 3000.
const PORT = Number(process.env.PORT ?? 3000);
const STUN_PORT = Number(process.env.STUN_PORT ?? 3478);

const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

const MAX_PEERS = 5;
const MAX_SHARERS = 3;

let pass = 0;
let fail = 0;

function ok(name: string, cond: unknown, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  }
}

function eq(name: string, got: unknown, want: unknown) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(name, same, same ? undefined : { got, want });
}

/** Abre um socket que acumula tudo que chega num array. */
async function peer(label: string) {
  const ws = new WebSocket(WS);
  const msgs: any[] = [];
  ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error(`${label}: falha ao abrir`));
  });
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  // name é opcional no protocolo; só entra na mensagem quem passar.
  const join = (room: string, name?: string) =>
    send(name === undefined ? { t: "join", room } : { t: "join", room, name });
  const of = (t: string) => msgs.filter((m) => m.t === t);
  const first = (t: string) => of(t)[0];
  const last = (t: string) => of(t).at(-1);
  return {
    label, ws, msgs, send, join, of, first, last,
    id: () => first("joined")?.id as string | undefined,
    close: () => ws.close(),
  };
}

const settle = () => Bun.sleep(300);

/** N peers na mesma sala, cada um já com `joined`. */
async function room(name: string, n: number) {
  const ps = [];
  for (let i = 0; i < n; i++) {
    const p = await peer(`${name}-${i}`);
    p.join(name);
    await settle();
    ps.push(p);
  }
  return ps;
}

/* ---------- estático ---------- */

async function testStatic() {
  console.log("\nestático + /config");

  const root = await fetch(HTTP + "/");
  const body = await root.text();
  ok("GET / responde 200", root.status === 200, root.status);
  ok("GET / serve o index.html", body.includes("<title>tela</title>"));
  ok("index tem o botão de compartilhar", body.includes('id="shareBtn"'));

  const cfg = await fetch(HTTP + "/config");
  const json: any = await cfg.json();
  ok("GET /config responde 200", cfg.status === 200, cfg.status);
  eq("/config devolve stunPort", json.stunPort, STUN_PORT);
  eq("/config devolve maxPeers", json.maxPeers, MAX_PEERS);
  eq("/config devolve maxSharers", json.maxSharers, MAX_SHARERS);
  ok(
    "/config devolve maxCapturePixels como número > 0",
    typeof json.maxCapturePixels === "number" && json.maxCapturePixels > 0,
    json.maxCapturePixels,
  );

  const miss = await fetch(HTTP + "/nao-existe");
  eq("rota inexistente dá 404", miss.status, 404);
}

/* ---------- signaling ---------- */

async function testJoin() {
  console.log("\njoin / joined");

  const a = await peer("a");
  a.join("r-join");
  await settle();

  const joined = a.first("joined");
  ok("primeiro peer recebe joined", !!joined);
  ok("joined traz um id", typeof joined?.id === "string" && joined.id.length > 0, joined?.id);
  eq("primeiro peer vê a sala vazia", joined?.peers, []);
  eq("primeiro peer recebe snapshot de sharers vazio", a.first("sharers")?.ids, []);
  eq("primeiro peer recebe snapshot de names vazio", a.first("names")?.map, {});

  const b = await peer("b");
  b.join("r-join");
  await settle();

  eq("segundo peer vê o primeiro na lista", b.first("joined")?.peers, [joined.id]);
  eq("primeiro peer é notificado do segundo", a.first("peer-joined")?.id, b.id());
  ok("quem entra não recebe peer-joined de si mesmo", b.of("peer-joined").length === 0);

  a.close();
  b.close();
  await settle();
}

async function testLeave() {
  console.log("\npeer-left");

  const [a, b] = await room("r-left", 2);
  const bId = b.id();
  b.close();
  await settle();

  eq("close propaga peer-left com o id certo", a.first("peer-left")?.id, bId);

  a.close();
  await settle();
}

async function testRoomIsolation() {
  console.log("\nisolamento entre salas");

  const a = await peer("a");
  const b = await peer("b");
  a.join("sala-1");
  await settle();
  b.join("sala-2");
  await settle();

  eq("peer de outra sala não aparece na lista", b.first("joined")?.peers, []);
  ok("peer de outra sala não gera peer-joined", a.of("peer-joined").length === 0);

  b.send({ t: "signal", to: a.id(), data: { kind: "offer", sdp: "x" } });
  await settle();
  ok("signal não atravessa sala", a.of("signal").length === 0, a.of("signal"));

  // sharer numa sala não vaza pra outra
  a.send({ t: "share-start" });
  await settle();
  eq("sharers de sala-1 tem o peer", a.last("sharers")?.ids, [a.id()]);
  eq("sharers não vaza pra sala-2", b.last("sharers")?.ids, []);

  a.close();
  b.close();
  await settle();
}

async function testSignalRelay() {
  console.log("\nrelay de signal");

  const [a, b, c] = await room("r-sig", 3);
  const aId = a.id();

  // data com forma arbitrária: o servidor não deve inspecionar nem validar (I2)
  const payload = { kind: "offer", sdp: { type: "offer", sdp: "v=0\r\n" }, nested: { x: [1, 2] } };
  a.send({ t: "signal", to: b.id(), data: payload });
  await settle();

  const got = b.first("signal");
  ok("destinatário recebe o signal", !!got);
  eq("signal preserva o from", got?.from, aId);
  eq("servidor repassa data intacto (I2)", got?.data, payload);
  ok("remetente não recebe eco", a.of("signal").length === 0);
  ok("terceiro peer não recebe o signal", c.of("signal").length === 0, c.of("signal"));

  a.send({ t: "signal", to: "ffffffff", data: { kind: "ice" } });
  await settle();
  ok("signal para id inexistente é ignorado sem quebrar", a.ws.readyState === WebSocket.OPEN);

  a.ws.send("{isso nao e json");
  await settle();
  ok("json inválido não derruba a conexão", a.ws.readyState === WebSocket.OPEN);

  a.close(); b.close(); c.close();
  await settle();
}

/* ---------- T1: teto de peers ---------- */

async function testMaxPeers() {
  console.log(`\nT1: teto de ${MAX_PEERS} peers`);

  const ps = await room("cheia", MAX_PEERS);
  ok(`os ${MAX_PEERS} primeiros entram`, ps.every((p) => !!p.id()), ps.map((p) => p.id()));

  const extra = await peer("sexto");
  extra.join("cheia");
  await settle();

  eq("6º peer recebe denied", extra.first("denied")?.reason, "room-full");
  ok("6º peer não recebe joined", !extra.first("joined"), extra.msgs);
  ok("6º peer não recebe snapshot de sharers", !extra.first("sharers"));
  ok("6º peer não recebe snapshot de names", !extra.first("names"));

  // Ninguém viu o sexto entrar: o primeiro peer só viu os outros 4.
  eq("6º não aparece na lista de ninguém", ps[0].of("peer-joined").length, MAX_PEERS - 1);
  ok("os 5 primeiros seguem conectados", ps.every((p) => p.ws.readyState === WebSocket.OPEN));

  // Uma vaga liberada deixa o próximo entrar.
  ps[0].close();
  await settle();
  const late = await peer("setimo");
  late.join("cheia");
  await settle();
  ok("vaga liberada permite nova entrada", !!late.first("joined"), late.msgs);
  ok("quem entrou na vaga não recebeu denied", !late.first("denied"));

  extra.close();
  late.close();
  ps.slice(1).forEach((p) => p.close());
  await settle();
}

/* ---------- T2: arbitragem de sharers ---------- */

async function testSharerArbitration() {
  console.log(`\nT2: arbitragem, máximo ${MAX_SHARERS} sharers`);

  // Uma pessoa a mais que o teto: a última é justamente a que precisa ser
  // negada. Tudo deriva de MAX_SHARERS para que mexer no teto continue sendo
  // trocar um número só, aqui e no servidor.
  const ps = await room("arb", MAX_SHARERS + 1);
  const ids = ps.map((p) => p.id()!);
  const extra = ps[MAX_SHARERS];          // o que não cabe
  const extraId = ids[MAX_SHARERS];

  for (let i = 0; i < MAX_SHARERS; i++) {
    ps[i].send({ t: "share-start" });
    await settle();
    eq(`${i + 1}º sharer entra no conjunto`, ps[i].last("sharers")?.ids, ids.slice(0, i + 1));
  }
  eq("broadcast chega na sala inteira", extra.last("sharers")?.ids, ids.slice(0, MAX_SHARERS));

  const before = extra.of("sharers").length;
  extra.send({ t: "share-start" });
  await settle();
  eq(`${MAX_SHARERS + 1}ª tentativa recebe share-denied`, extra.first("share-denied")?.reason, "limit");
  eq("share-denied não gera broadcast", extra.of("sharers").length, before);
  ok("quem foi negado não entra no conjunto", !extra.last("sharers")?.ids.includes(extraId));
  ok("share-denied vai só pro remetente", ps[0].of("share-denied").length === 0);

  // Nenhum broadcast em nenhum momento passou do teto.
  const todos = ps.flatMap((p) => p.of("sharers"));
  ok(
    `nenhum broadcast passou de ${MAX_SHARERS} ids`,
    todos.every((m) => m.ids.length <= MAX_SHARERS),
    todos.map((m) => m.ids.length)
  );

  // share-start repetido é idempotente e não re-broadcasta.
  const antes = extra.of("sharers").length;
  ps[0].send({ t: "share-start" });
  await settle();
  eq("share-start repetido não re-broadcasta", extra.of("sharers").length, antes);

  // share-stop libera a vaga.
  ps[0].send({ t: "share-stop" });
  await settle();
  eq("share-stop remove do conjunto", extra.last("sharers")?.ids, ids.slice(1, MAX_SHARERS));

  // share-stop de quem não está compartilhando é no-op.
  const antesStop = extra.of("sharers").length;
  ps[0].send({ t: "share-stop" });
  await settle();
  eq("share-stop redundante é no-op", extra.of("sharers").length, antesStop);

  // Com vaga aberta, o antes negado consegue.
  extra.send({ t: "share-start" });
  await settle();
  eq("vaga liberada permite novo sharer", extra.last("sharers")?.ids,
     [...ids.slice(1, MAX_SHARERS), extraId]);

  ps.forEach((p) => p.close());
  await settle();
}

async function testSharerLeave() {
  console.log("\nT2: fechar aba libera a vaga");

  const [a, b, c] = await room("saida", 3);
  const [aId, bId] = [a.id(), b.id()];

  a.send({ t: "share-start" });
  b.send({ t: "share-start" });
  await settle();
  eq("dois sharers ativos", c.last("sharers")?.ids, [aId, bId]);

  // Fechamento de aba do sharer.
  a.close();
  await settle();
  eq("close do sharer libera a vaga", c.last("sharers")?.ids, [bId]);
  eq("close também emite peer-left", c.first("peer-left")?.id, aId);

  // Quem não era sharer não deve gerar broadcast de sharers ao sair.
  const antes = b.of("sharers").length;
  c.close();
  await settle();
  eq("saída de não-sharer não re-broadcasta sharers", b.of("sharers").length, antes);

  b.close();
  await settle();
}

async function testSharerSnapshot() {
  console.log("\nT2: snapshot pra quem chega depois");

  const [a] = await room("snap", 1);
  a.send({ t: "share-start" });
  await settle();

  const late = await peer("atrasado");
  late.join("snap");
  await settle();

  eq("quem chega depois recebe o conjunto atual", late.first("sharers")?.ids, [a.id()]);

  a.close();
  late.close();
  await settle();
}

async function testShareBeforeJoin() {
  console.log("\nT2: share fora de sala");

  const orphan = await peer("orfao");
  orphan.send({ t: "share-start" });
  orphan.send({ t: "share-stop" });
  orphan.send({ t: "signal", to: "abc", data: {} });
  await settle();

  ok("share-start sem join é ignorado", orphan.of("sharers").length === 0, orphan.msgs);
  ok("conexão sobrevive", orphan.ws.readyState === WebSocket.OPEN);

  orphan.close();
  await settle();
}

/* ---------- nomes ---------- */

/** Compara mapas de nome sem depender da ordem das chaves. */
function eqMap(name: string, got: unknown, want: Record<string, string>) {
  const norm = (o: any) => Object.entries(o ?? {}).sort(([x], [y]) => (x < y ? -1 : 1));
  eq(name, norm(got), norm(want));
}

async function testNames() {
  console.log("\nnomes de peers");

  const a = await peer("a");
  a.join("nomes", "gabriel");
  await settle();
  const aId = a.id()!;

  eqMap("quem entra com nome já se vê no mapa", a.last("names")?.map, { [aId]: "gabriel" });

  const b = await peer("b");
  b.join("nomes");
  await settle();
  const bId = b.id()!;

  // Snapshot: quem chega depois recebe os nomes de quem já estava.
  eqMap("snapshot traz o nome de quem já estava", b.last("names")?.map, { [aId]: "gabriel" });
  ok("quem entra sem nome não aparece no mapa", !(bId in (b.last("names")?.map ?? {})));

  // Nome de quem entra chega nos demais.
  const c = await peer("c");
  c.join("nomes", "ana");
  await settle();
  const cId = c.id()!;
  eqMap("nome de quem entra chega nos demais", a.last("names")?.map, {
    [aId]: "gabriel",
    [cId]: "ana",
  });

  // rename propaga pra sala inteira.
  b.send({ t: "rename", name: "beatriz" });
  await settle();
  const esperado = { [aId]: "gabriel", [bId]: "beatriz", [cId]: "ana" };
  eqMap("rename chega em quem já estava", a.last("names")?.map, esperado);
  eqMap("rename chega em quem entrou depois", c.last("names")?.map, esperado);
  eqMap("quem renomeou também recebe o mapa", b.last("names")?.map, esperado);

  const antesIgual = a.of("names").length;
  b.send({ t: "rename", name: "beatriz" });
  await settle();
  eq("rename com o mesmo nome não re-broadcasta", a.of("names").length, antesIgual);

  // Saneamento: corte em 24 e colapso de espaços.
  b.send({ t: "rename", name: "z".repeat(40) });
  await settle();
  eq("nome de 40 chars chega cortado em 24", a.last("names")?.map[bId], "z".repeat(24));

  b.send({ t: "rename", name: "  ana   maria \n silva  " });
  await settle();
  eq("espaços colapsados e aparados", a.last("names")?.map[bId], "ana maria silva");

  // Nome vazio é o caminho de apagar o próprio nome.
  b.send({ t: "rename", name: "   " });
  await settle();
  ok("nome só de espaços some do mapa", !(bId in a.last("names").map), a.last("names").map);
  eqMap("apagar o nome não mexe no dos outros", a.last("names")?.map, {
    [aId]: "gabriel",
    [cId]: "ana",
  });

  // join também sanea, não só rename.
  const d = await peer("d");
  d.join("nomes", "   " + "w".repeat(30));
  await settle();
  eq("nome no join também é saneado", a.last("names")?.map[d.id()!], "w".repeat(24));

  // Nomes não vazam entre salas.
  const e = await peer("e");
  e.join("outra-sala", "carla");
  await settle();
  eqMap("outra sala só vê o próprio nome", e.last("names")?.map, { [e.id()!]: "carla" });
  ok(
    "nome não atravessa sala",
    !Object.values(a.last("names")?.map ?? {}).includes("carla"),
    a.last("names")?.map,
  );

  // Sair da sala tira o nome do mapa de quem fica — o nome mora no socket.
  a.close();
  await settle();
  eqMap("saída remove o nome do mapa", c.last("names")?.map, {
    [cId]: "ana",
    [d.id()!]: "w".repeat(24),
  });

  // Quem sai sem nome não muda o mapa e não deve gerar broadcast.
  const antesSaida = c.of("names").length;
  b.close();
  await settle();
  eq("saída de quem não tem nome não re-broadcasta", c.of("names").length, antesSaida);

  // rename fora de sala é ignorado, como share-start.
  const orphan = await peer("orfao-nome");
  orphan.send({ t: "rename", name: "ninguem" });
  await settle();
  ok("rename sem join é ignorado", orphan.of("names").length === 0, orphan.msgs);
  ok("conexão sobrevive ao rename fora de sala", orphan.ws.readyState === WebSocket.OPEN);

  orphan.close(); c.close(); d.close(); e.close();
  await settle();
}

/* ---------- T3: reconnect (lado servidor) ---------- */

async function testReconnect() {
  console.log("\nT3: reconnect");

  const [a, b] = await room("recon", 2);
  const aId = a.id();
  const bId = b.id();

  a.send({ t: "share-start" });
  await settle();
  eq("sharer registrado antes da queda", b.last("sharers")?.ids, [aId]);

  // Queda do socket do sharer.
  a.close();
  await settle();
  eq("queda libera a vaga do sharer", b.last("sharers")?.ids, []);
  eq("queda emite peer-left", b.first("peer-left")?.id, aId);

  // Volta com id novo e repede a vaga, como o cliente faz em `joined`.
  const a2 = await peer("a-reconectado");
  a2.join("recon");
  await settle();

  const newId = a2.id();
  ok("reconnect recebe um id novo", !!newId && newId !== aId, { aId, newId });
  eq("reconnect vê o peer que ficou", a2.first("joined")?.peers, [bId]);
  eq("snapshot mostra ninguém compartilhando", a2.first("sharers")?.ids, []);

  a2.send({ t: "share-start" });
  await settle();
  eq("reconnect recupera a vaga com o id novo", b.last("sharers")?.ids, [newId]);
  ok("id antigo não aparece no conjunto", !b.last("sharers")?.ids.includes(aId));

  a2.close();
  b.close();
  await settle();
}

/* ---------- stun ---------- */

const MAGIC = 0x2112a442;

async function testStun() {
  console.log("\nSTUN");

  const sock = dgram.createSocket("udp4");
  const tid = crypto.getRandomValues(new Uint8Array(12));

  const req = Buffer.alloc(20);
  req.writeUInt16BE(0x0001, 0); // Binding Request
  req.writeUInt16BE(0, 2); // sem atributos
  req.writeUInt32BE(MAGIC, 4);
  Buffer.from(tid).copy(req, 8);

  const answer = new Promise<{ buf: Buffer; localPort: number }>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("STUN não respondeu em 3s")), 3000);
    sock.on("message", (buf) => {
      clearTimeout(timer);
      res({ buf, localPort: sock.address().port });
    });
  });

  await new Promise<void>((res) => sock.bind(0, "127.0.0.1", res));
  sock.send(req, STUN_PORT, "127.0.0.1");

  let buf: Buffer, localPort: number;
  try {
    ({ buf, localPort } = await answer);
  } catch (e) {
    ok("STUN responde ao Binding Request", false, String(e));
    sock.close();
    return;
  }

  ok("STUN responde ao Binding Request", true);
  eq("tipo é Binding Success Response", buf.readUInt16BE(0), 0x0101);
  eq("magic cookie ecoado", buf.readUInt32BE(4), MAGIC);
  eq("transaction id espelhado", [...buf.subarray(8, 20)], [...tid]);
  eq("length cobre o atributo", buf.readUInt16BE(2), 12);
  eq("atributo é XOR-MAPPED-ADDRESS", buf.readUInt16BE(20), 0x0020);
  eq("tamanho do atributo", buf.readUInt16BE(22), 8);
  eq("family é IPv4", buf.readUInt8(25), 0x01);

  const port = buf.readUInt16BE(26) ^ (MAGIC >>> 16);
  const addr = (buf.readUInt32BE(28) ^ MAGIC) >>> 0;
  const ip = [addr >>> 24, (addr >>> 16) & 255, (addr >>> 8) & 255, addr & 255].join(".");

  eq("porta decodificada bate com a de origem", port, localPort);
  eq("IP decodificado bate com a origem", ip, "127.0.0.1");

  sock.send(Buffer.from([1, 2, 3]), STUN_PORT, "127.0.0.1");
  await Bun.sleep(200);
  ok("lixo em UDP não mata o STUN", true);

  sock.close();
}

/* ---------- run ---------- */

await testStatic();
await testJoin();
await testLeave();
await testRoomIsolation();
await testSignalRelay();
await testMaxPeers();
await testSharerArbitration();
await testSharerLeave();
await testSharerSnapshot();
await testShareBeforeJoin();
await testNames();
await testReconnect();
await testStun();

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);

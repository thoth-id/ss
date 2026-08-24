# Porte do `tela` para o pacote npm `screen-share` — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portar o servidor de Bun para Node puro e publicá-lo como o CLI `npx screen-share`, sem dependências e sem build step.

**Architecture:** O `Bun.serve` sai e entra `node:http` mais um servidor WebSocket RFC 6455 escrito à mão, dividido em codec puro (`ws-frame.js`) e ciclo de vida de socket (`ws.js`). A máquina de estado de sala, sharers e nomes é copiada do `server.ts` sem alteração de lógica — ela já é agnóstica de transporte. O `stun.ts` é renomeado e nada mais, porque já roda sob Node sem alteração.

**Tech Stack:** Node ≥ 20, JavaScript com tipos em JSDoc, módulos ES, zero dependências de runtime e de desenvolvimento.

**Spec:** `docs/superpowers/specs/2026-08-24-pacote-npm-design.md` — leia antes de começar. Ele registra *por que* cada decisão existe e traz a evidência medida de cada uma.

## Global Constraints

- **Zero dependências.** Nem `dependencies`, nem `devDependencies`. Só `node:*`.
- **Sem build step.** Nada de compilar, transpilar ou minificar. O que está no repositório é o que é publicado.
- **JavaScript com JSDoc, nunca `.ts`.** O Node recusa type stripping dentro de `node_modules`.
- **Node ≥ 20** (`engines`). Usamos `node:test`? **Não** — a suíte é feita à mão, no estilo do `test.ts` atual.
- **Comentários de código, strings de UI e documentação em português do Brasil.** Nomes de identificador em inglês, como já é hoje.
- **`public/index.html` é intocável neste plano.** Ele é asset empacotado. Nenhuma tarefa aqui o modifica.
- **Sem `console.log` de debug** no código final. O único output esperado é o banner de boot do CLI.
- **Não commitar** `node_modules/`, `*.tgz`, `*.pem`, `*.key`, `*.crt`.

---

## Estrutura de arquivos ao final

```
bin/cli.js         flags, clamps, guarda de runtime, banner, --bg/--stop
server.js          node:http: estáticos + /config + sala/sharers/names
ws.js              handshake, acumulador por socket, keepalive, attachWebSocket
ws-frame.js        codec RFC 6455 puro: parseFrame / encodeFrame. Sem I/O.
stun.js            renomeado de stun.ts, lógica intocada
public/index.html  INTOCADO
test.js            suíte de integração, renomeada de test.ts
test-ws.js         unidade: codec e acumulador. Roda sem servidor.
package.json       publicável
```

`ws-frame.js` existe separado de propósito: é onde moram todos os bugs de framing, é puro, e por isso é testável sem abrir socket nenhum. A ordem das tarefas garante que ele esteja verde antes de qualquer coisa tocar num socket de verdade.

---

## Task 1: Codec RFC 6455 puro (`ws-frame.js`)

**Files:**
- Create: `ws-frame.js`
- Test: `test-ws.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `parseFrame(buf: Buffer)` → `{ frame: { fin: boolean, opcode: number, payload: Buffer }, rest: Buffer }` | `{ need: true }` | `{ error: number, reason: string }`
  - `encodeFrame(opcode: number, payload: Buffer)` → `Buffer`
  - `encodeText(s: string)` → `Buffer`
  - `encodeClose(code: number, reason?: string)` → `Buffer`
  - `OP = { TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa, CONT: 0x0 }`
  - `CLOSE = { NORMAL: 1000, PROTOCOL: 1002, TOO_BIG: 1009 }`

- [ ] **Step 1: Escrever o arquivo de teste com os casos que pegam bug de verdade**

Crie `test-ws.js`. O estilo segue o `test.ts` atual: helpers `ok`/`eq` contando `pass`/`fail`, e `process.exit(fail ? 1 : 0)` no fim.

```js
/* Suíte de unidade do codec WebSocket. Não abre socket nenhum: é tudo função
   pura, e é justamente onde moram os bugs de framing. */
import { parseFrame, encodeFrame, encodeText, encodeClose, OP, CLOSE } from "./ws-frame.js";

let pass = 0, fail = 0;
function ok(what, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FALHOU ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
function eq(what, got, want) { ok(what, Object.is(got, want), { got, want }); }

/** Monta um frame mascarado, como um cliente manda. */
function clientFrame(opcode, payload, { fin = true, mask = Buffer.from([1, 2, 3, 4]) } = {}) {
  const body = Buffer.from(payload);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  const head = [];
  head.push((fin ? 0x80 : 0) | opcode);
  if (body.length < 126) head.push(0x80 | body.length);
  else if (body.length < 65536) head.push(0x80 | 126, body.length >> 8, body.length & 0xff);
  else {
    head.push(0x80 | 127, 0, 0, 0, 0,
      (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff,
      (body.length >>> 8) & 0xff, body.length & 0xff);
  }
  return Buffer.concat([Buffer.from(head), mask, masked]);
}

function texto() {
  const r = parseFrame(clientFrame(OP.TEXT, "oi"));
  ok("frame de texto simples decodifica", r.frame?.payload.toString() === "oi", r);
  eq("fin verdadeiro", r.frame.fin, true);
  eq("resto vazio", r.rest.length, 0);
}

function doisNoMesmoChunk() {
  const buf = Buffer.concat([clientFrame(OP.TEXT, "um"), clientFrame(OP.TEXT, "dois")]);
  const a = parseFrame(buf);
  eq("primeiro de dois no mesmo chunk", a.frame.payload.toString(), "um");
  const b = parseFrame(a.rest);
  eq("segundo de dois no mesmo chunk", b.frame.payload.toString(), "dois");
  eq("nada sobrando", b.rest.length, 0);
}

function byteAByte() {
  // O teste que pega quase todo bug de acumulador: entrega um byte por vez e
  // exige `need` até o último.
  const full = clientFrame(OP.TEXT, "mensagem de tamanho razoável");
  let incompletos = 0;
  for (let i = 1; i < full.length; i++) {
    const r = parseFrame(full.subarray(0, i));
    if (r.need) incompletos++;
    else { ok("byte a byte: decodificou cedo demais em " + i, false, r); return; }
  }
  eq("byte a byte: todos os prefixos pedem mais", incompletos, full.length - 1);
  const r = parseFrame(full);
  eq("byte a byte: completo decodifica", r.frame.payload.toString(), "mensagem de tamanho razoável");
}

function corteNoComprimento16() {
  const full = clientFrame(OP.TEXT, "x".repeat(300)); // usa comprimento de 16 bits
  ok("corte no meio do comprimento de 16 bits pede mais", parseFrame(full.subarray(0, 3)).need === true);
  ok("corte no meio da chave de máscara pede mais", parseFrame(full.subarray(0, 6)).need === true);
  eq("comprimento de 16 bits decodifica", parseFrame(full).frame.payload.length, 300);
}

function semMascara() {
  const f = clientFrame(OP.TEXT, "oi");
  f[1] &= 0x7f; // desliga o bit de máscara sem remover a chave
  const r = parseFrame(f);
  eq("frame do cliente sem máscara é erro de protocolo", r.error, CLOSE.PROTOCOL);
}

function rsvSetado() {
  const f = clientFrame(OP.TEXT, "oi");
  f[0] |= 0x40; // RSV1, o que o permessage-deflate usaria
  eq("RSV setado é erro de protocolo", parseFrame(f).error, CLOSE.PROTOCOL);
}

function controleInvalido() {
  const grande = clientFrame(OP.PING, "p".repeat(126));
  eq("control frame acima de 125 bytes é erro", parseFrame(grande).error, CLOSE.PROTOCOL);
  const fragmentado = clientFrame(OP.PING, "p", { fin: false });
  eq("control frame fragmentado é erro", parseFrame(fragmentado).error, CLOSE.PROTOCOL);
}

function closeComCodigo() {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(CLOSE.NORMAL, 0);
  const r = parseFrame(clientFrame(OP.CLOSE, payload));
  eq("close carrega o código", r.frame.payload.readUInt16BE(0), CLOSE.NORMAL);
}

function encoda() {
  const f = encodeText("olá");
  eq("frame do servidor não é mascarado", (f[1] & 0x80) >>> 7, 0);
  eq("frame do servidor tem fin", (f[0] & 0x80) >>> 7, 1);
  eq("opcode de texto", f[0] & 0x0f, OP.TEXT);
  eq("payload utf-8 correto", f.subarray(2).toString("utf8"), "olá");

  const medio = encodeFrame(OP.TEXT, Buffer.alloc(300));
  eq("300 bytes usa comprimento de 16 bits", medio[1], 126);
  eq("comprimento de 16 bits escrito", medio.readUInt16BE(2), 300);

  const grande = encodeFrame(OP.TEXT, Buffer.alloc(70000));
  eq("70000 bytes usa comprimento de 64 bits", grande[1], 127);
  eq("comprimento de 64 bits escrito", Number(grande.readBigUInt64BE(2)), 70000);

  const c = encodeClose(CLOSE.PROTOCOL, "nope");
  eq("close encodado tem opcode certo", c[0] & 0x0f, OP.CLOSE);
  eq("close encodado tem o código", c.readUInt16BE(2), CLOSE.PROTOCOL);
}

function idaEVolta() {
  // O que encodamos tem que ser lido de volta se remascarado.
  for (const n of [0, 1, 125, 126, 127, 300, 65535, 65536, 70000]) {
    const texto = "y".repeat(n);
    const r = parseFrame(clientFrame(OP.TEXT, texto));
    ok(`ida e volta com ${n} bytes`, r.frame?.payload.toString() === texto, r.error ?? r.need);
  }
}

console.log("\ncodec");
texto(); doisNoMesmoChunk(); byteAByte(); corteNoComprimento16();
semMascara(); rsvSetado(); controleInvalido(); closeComCodigo();
encoda(); idaEVolta();

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node test-ws.js`
Expected: FALHA — `Cannot find module './ws-frame.js'`.

- [ ] **Step 3: Implementar o codec**

Crie `ws-frame.js`:

```js
/* Codec RFC 6455. Funções puras, sem I/O: o acumulador e o socket moram no
   ws.js. Separado porque é aqui que bug de framing nasce, e assim ele é
   testável sem abrir conexão. */

export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
export const CLOSE = { NORMAL: 1000, PROTOCOL: 1002, TOO_BIG: 1009 };

// Teto por frame. O total remontado é limitado no ws.js, que é quem enxerga a
// sequência inteira de fragmentos.
const MAX_FRAME = 1_000_000;

/**
 * Lê um frame do início de `buf`.
 * @param {Buffer} buf
 * @returns {{frame:{fin:boolean,opcode:number,payload:Buffer},rest:Buffer}
 *          |{need:true}
 *          |{error:number,reason:string}}
 */
export function parseFrame(buf) {
  if (buf.length < 2) return { need: true };

  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;

  // RSV só é diferente de zero com extensão negociada, e nós nunca negociamos
  // nenhuma — o Chrome oferece permessage-deflate no handshake e nós não
  // ecoamos, então RSV setado aqui é protocolo quebrado.
  if ((b0 & 0x70) !== 0) return { error: CLOSE.PROTOCOL, reason: "RSV setado sem extensão negociada" };

  // A RFC exige máscara em todo frame que vem do cliente. Sem esta checagem, um
  // parser leria 4 bytes de payload como chave e devolveria lixo silencioso.
  if ((b1 & 0x80) === 0) return { error: CLOSE.PROTOCOL, reason: "frame do cliente sem máscara" };

  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return { need: true };
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return { need: true };
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_FRAME)) return { error: CLOSE.TOO_BIG, reason: "frame acima do teto" };
    len = Number(big);
    off = 10;
  }
  if (len > MAX_FRAME) return { error: CLOSE.TOO_BIG, reason: "frame acima do teto" };

  // Control frames não podem ser fragmentados nem passar de 125 bytes.
  if (opcode >= 0x8) {
    if (!fin) return { error: CLOSE.PROTOCOL, reason: "control frame fragmentado" };
    if (len > 125) return { error: CLOSE.PROTOCOL, reason: "control frame acima de 125 bytes" };
  }

  if (buf.length < off + 4 + len) return { need: true };

  const mask = buf.subarray(off, off + 4);
  off += 4;
  const payload = Buffer.from(buf.subarray(off, off + len));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

  return { frame: { fin, opcode, payload }, rest: buf.subarray(off + len) };
}

/**
 * Monta um frame do servidor. Nunca mascarado, como a RFC exige.
 * @param {number} opcode @param {Buffer} payload @returns {Buffer}
 */
export function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? "");
  const b0 = 0x80 | opcode;
  if (body.length < 126) return Buffer.concat([Buffer.from([b0, body.length]), body]);
  if (body.length < 65536) {
    const h = Buffer.alloc(4);
    h[0] = b0; h[1] = 126; h.writeUInt16BE(body.length, 2);
    return Buffer.concat([h, body]);
  }
  const h = Buffer.alloc(10);
  h[0] = b0; h[1] = 127; h.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([h, body]);
}

/** @param {string} s */
export const encodeText = (s) => encodeFrame(OP.TEXT, Buffer.from(s, "utf8"));

/** @param {number} code @param {string} [reason] */
export function encodeClose(code, reason = "") {
  const r = Buffer.from(reason, "utf8");
  const p = Buffer.alloc(2 + r.length);
  p.writeUInt16BE(code, 0);
  r.copy(p, 2);
  return encodeFrame(OP.CLOSE, p);
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd /home/andreello/dev/share && node test-ws.js`
Expected: PASSA, `0 falharam`, exit 0.

- [ ] **Step 5: Commit**

```bash
cd /home/andreello/dev/share
git add ws-frame.js test-ws.js
git commit -m "feat(ws): Add a pure RFC 6455 frame codec with unit tests"
```

---

## Task 2: Handshake, acumulador e keepalive (`ws.js`)

**Files:**
- Create: `ws.js`
- Modify: `test-ws.js` (adiciona a seção de acumulador e handshake)

**Interfaces:**
- Consumes: `parseFrame`, `encodeFrame`, `encodeText`, `encodeClose`, `OP`, `CLOSE` do Task 1.
- Produces:
  - `attachWebSocket(server, { path, onOpen, onMessage, onClose })` → `() => void` (função que desliga o keepalive)
  - `acceptKey(key: string)` → `string` — exportada para teste
  - `createConnection(socket, { onMessage, onClose })` → objeto com `.feed(buf)`, `.send(text)`, `.close(code, reason)`, `.data` — exportada para teste sem socket real
- O objeto passado aos callbacks (`sock`) tem: `sock.send(string)`, `sock.close(code?, reason?)`, `sock.data` (objeto livre onde o `server.js` guarda `{ id, room, name }`).

- [ ] **Step 1: Escrever os testes de acumulador e handshake**

Acrescente ao `test-ws.js`, antes do bloco de contagem final:

```js
import { acceptKey, createConnection } from "./ws.js";

/** Conexão de mentira: coleta o que seria escrito no socket. */
function fakeSocket() {
  const escrito = [];
  return {
    escrito,
    destruido: false,
    write(b) { escrito.push(Buffer.from(b)); return true; },
    destroy() { this.destruido = true; },
    on() {}, setNoDelay() {}, setKeepAlive() {},
  };
}

function handshakeAccept() {
  // Vetor da própria RFC 6455, seção 1.3.
  eq("Sec-WebSocket-Accept bate com o vetor da RFC",
    acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
}

function acumuladorPorPedacos() {
  const s = fakeSocket();
  const recebidas = [];
  const c = createConnection(s, { onMessage: (_, t) => recebidas.push(t), onClose: () => {} });
  const full = clientFrame(OP.TEXT, JSON.stringify({ t: "join", room: "sala" }));
  for (const b of full) c.feed(Buffer.from([b]));      // um byte por vez
  eq("acumulador remonta frame entregue byte a byte", recebidas.length, 1);
  eq("conteúdo intacto", recebidas[0], JSON.stringify({ t: "join", room: "sala" }));
}

function cemFramesNumWriteSo() {
  const s = fakeSocket();
  const recebidas = [];
  const c = createConnection(s, { onMessage: (_, t) => recebidas.push(t), onClose: () => {} });
  const partes = [];
  for (let i = 0; i < 100; i++) partes.push(clientFrame(OP.TEXT, `m${i}`));
  c.feed(Buffer.concat(partes));
  eq("100 frames num único chunk", recebidas.length, 100);
  eq("último íntegro", recebidas[99], "m99");
}

function remontaFragmentos() {
  // O Chrome fragmenta texto acima de 64 KiB, e de forma intermitente. Recusar
  // continuation seria uma regressão silenciosa. Ver spec 5.1.
  const s = fakeSocket();
  const recebidas = [];
  const c = createConnection(s, { onMessage: (_, t) => recebidas.push(t), onClose: () => {} });
  c.feed(clientFrame(OP.TEXT, "hel", { fin: false }));
  c.feed(clientFrame(OP.CONT, "lo ", { fin: false }));
  c.feed(clientFrame(OP.CONT, "world", { fin: true }));
  eq("três fragmentos viram uma mensagem", recebidas.length, 1);
  eq("fragmentos remontados na ordem", recebidas[0], "hello world");
}

function controleEntreFragmentos() {
  const s = fakeSocket();
  const recebidas = [];
  const c = createConnection(s, { onMessage: (_, t) => recebidas.push(t), onClose: () => {} });
  c.feed(clientFrame(OP.TEXT, "ab", { fin: false }));
  c.feed(clientFrame(OP.PING, "p"));                    // control no meio é legal
  c.feed(clientFrame(OP.CONT, "cd", { fin: true }));
  eq("ping entre fragmentos não quebra a remontagem", recebidas[0], "abcd");
  ok("ping foi respondido com pong",
    s.escrito.some((b) => (b[0] & 0x0f) === OP.PONG));
}

function continuationOrfa() {
  const s = fakeSocket();
  const c = createConnection(s, { onMessage: () => {}, onClose: () => {} });
  c.feed(clientFrame(OP.CONT, "x", { fin: true }));
  ok("continuation sem início fecha a conexão", s.destruido === true);
}

function tetoDoTotalRemontado() {
  const s = fakeSocket();
  const recebidas = [];
  const c = createConnection(s, { onMessage: (_, t) => recebidas.push(t), onClose: () => {} });
  // Dois fragmentos de 600 KB somam mais de 1 MB, mesmo cada um cabendo sozinho.
  c.feed(clientFrame(OP.TEXT, "z".repeat(600_000), { fin: false }));
  c.feed(clientFrame(OP.CONT, "z".repeat(600_000), { fin: true }));
  eq("total remontado acima do teto não vira mensagem", recebidas.length, 0);
  ok("e a conexão é fechada", s.destruido === true);
}

function exatamenteNoTeto() {
  // A borda importa: teto exato passa, teto+1 fecha. Sem os dois, um erro de
  // > contra >= passa despercebido.
  const s1 = fakeSocket();
  const r1 = [];
  createConnection(s1, { onMessage: (_, t) => r1.push(t), onClose: () => {} })
    .feed(clientFrame(OP.TEXT, "z".repeat(1_000_000)));
  eq("mensagem exatamente no teto passa", r1.length, 1);

  const s2 = fakeSocket();
  const r2 = [];
  createConnection(s2, { onMessage: (_, t) => r2.push(t), onClose: () => {} })
    .feed(clientFrame(OP.TEXT, "z".repeat(1_000_001)));
  eq("um byte acima do teto não passa", r2.length, 0);
  ok("e fecha a conexão", s2.destruido === true);
}

function fechaComCodigo() {
  const s = fakeSocket();
  let fechou = false;
  const c = createConnection(s, { onMessage: () => {}, onClose: () => { fechou = true; } });
  const p = Buffer.alloc(2); p.writeUInt16BE(CLOSE.NORMAL, 0);
  c.feed(clientFrame(OP.CLOSE, p));
  ok("close do cliente é ecoado", s.escrito.some((b) => (b[0] & 0x0f) === OP.CLOSE));
  ok("onClose foi chamado", fechou);
}

console.log("\nhandshake e acumulador");
handshakeAccept(); acumuladorPorPedacos(); cemFramesNumWriteSo();
remontaFragmentos(); controleEntreFragmentos(); continuationOrfa();
tetoDoTotalRemontado(); exatamenteNoTeto(); fechaComCodigo();
```

Mova o bloco `console.log(\`\n${pass} passaram...\`)` e o `process.exit` para depois dessas chamadas.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd /home/andreello/dev/share && node test-ws.js`
Expected: FALHA — `Cannot find module './ws.js'`.

- [ ] **Step 3: Implementar o `ws.js`**

```js
/* Servidor WebSocket RFC 6455 sem dependência. O codec puro está no
   ws-frame.js; aqui mora o acumulador por socket, o handshake e o keepalive.

   O keepalive não é enfeite: o Bun.serve fechava socket inativo em 120s
   sozinho, e o node:http não tem equivalente — nenhum dos timeouts dele
   sobrevive ao upgrade. Sem isso, um socket half-open (tampa do notebook,
   queda de Wi-Fi) nunca dispara `close`, e o `close` é quem libera a vaga de
   sharer. Dois fantasmas e ninguém mais consegue compartilhar. */

import { createHash } from "node:crypto";
import { parseFrame, encodeFrame, encodeText, encodeClose, OP, CLOSE } from "./ws-frame.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 1_000_000;   // teto do total remontado
const PING_MS = 30_000;
const MISSED_PONGS_LIMIT = 2;

/** @param {string} key */
export function acceptKey(key) {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/**
 * Máquina de estado de uma conexão já em WebSocket. Exportada sem socket real
 * para poder ser testada com um duplo.
 */
export function createConnection(socket, { onMessage, onClose }) {
  let buf = Buffer.alloc(0);
  let fragOp = 0;
  let fragParts = [];
  let fragLen = 0;
  let fechado = false;

  const conn = {
    /** espaço livre para o server.js guardar { id, room, name } */
    data: {},
    missedPongs: 0,
    send(text) {
      if (fechado) return;
      socket.write(encodeText(text));
    },
    ping() {
      if (fechado) return;
      socket.write(encodeFrame(OP.PING, Buffer.alloc(0)));
    },
    close(code = CLOSE.NORMAL, reason = "") {
      if (fechado) return;
      fechado = true;
      try { socket.write(encodeClose(code, reason)); } catch {}
      socket.destroy();
      onClose(conn);
    },
    feed(chunk) {
      if (fechado) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

      for (;;) {
        const r = parseFrame(buf);
        if (r.need) return;
        if (r.error) return conn.close(r.error, r.reason);
        buf = r.rest;

        const { fin, opcode, payload } = r.frame;

        if (opcode === OP.CLOSE) return conn.close(CLOSE.NORMAL, "");
        if (opcode === OP.PING) { socket.write(encodeFrame(OP.PONG, payload)); continue; }
        if (opcode === OP.PONG) { conn.missedPongs = 0; continue; }

        if (opcode === OP.CONT) {
          if (!fragOp) return conn.close(CLOSE.PROTOCOL, "continuation sem início");
          fragLen += payload.length;
          if (fragLen > MAX_MESSAGE) return conn.close(CLOSE.TOO_BIG, "mensagem acima do teto");
          fragParts.push(payload);
          if (!fin) continue;
          const inteiro = Buffer.concat(fragParts);
          fragOp = 0; fragParts = []; fragLen = 0;
          onMessage(conn, inteiro.toString("utf8"));
          continue;
        }

        if (opcode !== OP.TEXT && opcode !== OP.BINARY) {
          return conn.close(CLOSE.PROTOCOL, "opcode desconhecido");
        }
        if (fragOp) return conn.close(CLOSE.PROTOCOL, "novo data frame no meio de um fragmento");

        if (!fin) {
          fragOp = opcode;
          fragParts = [payload];
          fragLen = payload.length;
          if (fragLen > MAX_MESSAGE) return conn.close(CLOSE.TOO_BIG, "mensagem acima do teto");
          continue;
        }
        if (payload.length > MAX_MESSAGE) return conn.close(CLOSE.TOO_BIG, "mensagem acima do teto");
        onMessage(conn, payload.toString("utf8"));
      }
    },
    /** usado pelo attachWebSocket quando o socket morre por fora */
    dropped() {
      if (fechado) return;
      fechado = true;
      onClose(conn);
    },
  };

  return conn;
}

/**
 * Pendura o WebSocket num servidor node:http.
 * @returns {() => void} desliga o keepalive
 */
export function attachWebSocket(server, { path = "/ws", onOpen, onMessage, onClose }) {
  const vivos = new Set();

  server.on("upgrade", (req, socket, head) => {
    const recusa = (status, texto) => {
      socket.write(`HTTP/1.1 ${status} ${texto}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    let pathname;
    try { pathname = new URL(req.url, "http://localhost").pathname; }
    catch { return recusa(400, "Bad Request"); }
    if (pathname !== path) return recusa(404, "Not Found");

    // `Connection` casado como token: proxies mandam "keep-alive, Upgrade".
    const conexao = String(req.headers.connection ?? "").toLowerCase();
    if (!conexao.split(",").some((t) => t.trim() === "upgrade")) return recusa(400, "Bad Request");
    if (String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") return recusa(400, "Bad Request");
    if (String(req.headers["sec-websocket-version"] ?? "") !== "13") return recusa(426, "Upgrade Required");

    // Sem esta checagem, sha1(undefined + GUID) não lança: produz um Accept
    // bogus e um 101 inválido que o cliente rejeita sem explicação.
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || !key) return recusa(400, "Bad Request");

    // Não ecoamos Sec-WebSocket-Protocol nem Sec-WebSocket-Extensions: o Chrome
    // oferece permessage-deflate e ecoar ligaria uma compressão que não
    // implementamos (e aí RSV1 chegaria setado).
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const conn = createConnection(socket, {
      onMessage,
      onClose: (c) => { vivos.delete(c); onClose(c); },
    });
    vivos.add(conn);

    socket.on("data", (chunk) => conn.feed(chunk));
    socket.on("error", () => { vivos.delete(conn); conn.dropped(); });
    socket.on("close", () => { vivos.delete(conn); conn.dropped(); });

    // O `head` traz o que já chegou junto do upgrade. Costuma vir vazio, mas
    // depender disso seria assumir comportamento de rede.
    if (head?.length) conn.feed(head);

    onOpen(conn);
  });

  const timer = setInterval(() => {
    for (const conn of vivos) {
      if (conn.missedPongs >= MISSED_PONGS_LIMIT) { conn.close(CLOSE.NORMAL, "sem resposta"); continue; }
      conn.missedPongs++;
      conn.ping();
    }
  }, PING_MS);
  timer.unref();

  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd /home/andreello/dev/share && node test-ws.js`
Expected: PASSA, `0 falharam`, exit 0.

- [ ] **Step 5: Commit**

```bash
cd /home/andreello/dev/share
git add ws.js test-ws.js
git commit -m "feat(ws): Add handshake, per-socket accumulator and keepalive"
```

---

## Task 3: Portar o servidor (`server.js`, `stun.js`)

**Files:**
- Create: `server.js`
- Rename: `stun.ts` → `stun.js`
- Delete: `server.ts` (só depois que o `server.js` estiver verde)

**Interfaces:**
- Consumes: `attachWebSocket` do Task 2, `startStun` do `stun.js`.
- Produces: `start({ port, stunPort, host, maxPeers, maxSharers, maxCapturePixels })` → `Promise<{ close(): void }>`. Resolve **só depois** que HTTP e UDP estiverem ouvindo, ou rejeita — o Task 5 depende disso para não reportar sucesso de um processo morto.

- [ ] **Step 1: Renomear o STUN**

`stun.ts` não tem uma anotação de tipo sequer e não usa nenhuma API de Bun. É rename e nada mais.

```bash
cd /home/andreello/dev/share
git mv stun.ts stun.js
node --check stun.js
```
Expected: sem saída, exit 0.

- [ ] **Step 2: Escrever o `server.js`**

A máquina de estado de sala, sharers e nomes é **copiada do `server.ts` sem alteração de lógica**. O mapeamento é mecânico:

| no `server.ts` (Bun) | no `server.js` (Node) |
|---|---|
| `ws.data.id` / `.room` / `.name` | `sock.data.id` / `.room` / `.name` |
| `ws.send(JSON.stringify(x))` | `sock.send(JSON.stringify(x))` |
| `Set<Socket>` de sockets da sala | idem, com o objeto `conn` do `ws.js` |
| `Bun.serve({ fetch })` | `createServer(handler)` |
| `Bun.file("./public"+p)` | ver o `servirEstatico` abaixo |

```js
/* Servidor: estáticos + /config + relay de signaling. Nunca toca em mídia.
   Node puro, sem dependência. O WebSocket vem do ws.js. */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachWebSocket } from "./ws.js";
import { startStun } from "./stun.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MAX_NAME = 24;

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * Resolve um caminho de request dentro do pacote.
 *
 * A guarda é em `path`, NUNCA em `URL`: fileURLToPath e readFile(URL) LANÇAM
 * ERR_INVALID_FILE_URL_PATH em caminhos com %2F, e um throw síncrono no handler
 * do node:http é uncaughtException — o processo inteiro morre, levando HTTP,
 * WebSocket e STUN juntos. Um único curl derrubaria o servidor.
 *
 * @param {string} pathname @returns {string|null} caminho absoluto, ou null se escapa
 */
function resolverEstatico(pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel === "/" || rel === "") rel = "/index.html";
  const alvo = path.resolve(PUBLIC_DIR, "." + path.posix.normalize(rel));
  if (alvo !== PUBLIC_DIR && !alvo.startsWith(PUBLIC_DIR + path.sep)) return null;
  return alvo;
}

/**
 * @param {{port?:number,stunPort?:number,host?:string,maxPeers?:number,
 *          maxSharers?:number,maxCapturePixels?:number}} opts
 */
export async function start(opts = {}) {
  const PORT = opts.port ?? 3000;
  const STUN_PORT = opts.stunPort ?? 3478;
  const HOST = opts.host ?? "0.0.0.0";
  const MAX_PEERS = opts.maxPeers ?? 5;
  const MAX_SHARERS = opts.maxSharers ?? 2;
  const MAX_CAPTURE_PIXELS = opts.maxCapturePixels ?? 1_440_000;

  /** @type {Map<string, Set<any>>} */ const rooms = new Map();
  /** @type {Map<string, Set<string>>} */ const sharers = new Map();

  const broadcast = (room, payload, except) => {
    const set = rooms.get(room);
    if (!set) return;
    const msg = JSON.stringify(payload);
    for (const peer of set) if (peer !== except) peer.send(msg);
  };
  const sharersOf = (room) => {
    let set = sharers.get(room);
    if (!set) sharers.set(room, (set = new Set()));
    return set;
  };
  const publishSharers = (room) => {
    if (!rooms.has(room)) return;
    broadcast(room, { t: "sharers", ids: [...sharersOf(room)] });
  };
  const cleanName = (raw) => String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  const namesOf = (room) => {
    const map = {};
    for (const peer of rooms.get(room) ?? []) if (peer.data.name) map[peer.data.id] = peer.data.name;
    return map;
  };
  const publishNames = (room) => {
    if (!rooms.has(room)) return;
    broadcast(room, { t: "names", map: namesOf(room) });
  };

  const server = createServer(async (req, res) => {
    // node:http morre a cada exceção não prevista no handler. Sem este try, um
    // request malformado derruba o processo inteiro.
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === "/config") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          stunPort: STUN_PORT, maxPeers: MAX_PEERS,
          maxSharers: MAX_SHARERS, maxCapturePixels: MAX_CAPTURE_PIXELS,
        }));
        return;
      }

      const alvo = resolverEstatico(url.pathname);
      if (!alvo) { res.writeHead(404); res.end("not found"); return; }
      let corpo;
      try { corpo = await readFile(alvo); }
      catch { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-type": TIPOS[path.extname(alvo)] ?? "application/octet-stream" });
      res.end(corpo);
    } catch {
      try { res.writeHead(500); res.end("erro interno"); } catch {}
    }
  });

  attachWebSocket(server, {
    path: "/ws",
    onOpen(sock) { sock.data = { id: randomUUID().slice(0, 8), room: "", name: "" }; },

    onMessage(sock, raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.t === "join") {
        if (sock.data.room) return; // já entrou; join repetido é no-op
        const room = String(msg.room || "sala").slice(0, 64);
        let set = rooms.get(room);
        if (!set) rooms.set(room, (set = new Set()));

        if (set.size >= MAX_PEERS) {
          sock.send(JSON.stringify({ t: "denied", reason: "room-full" }));
          if (!set.size) rooms.delete(room);
          return;
        }

        sock.data.room = room;
        sock.data.name = cleanName(msg.name);
        const peers = [...set].map((p) => p.data.id);
        set.add(sock);

        sock.send(JSON.stringify({ t: "joined", id: sock.data.id, peers }));
        sock.send(JSON.stringify({ t: "sharers", ids: [...sharersOf(room)] }));
        if (sock.data.name) publishNames(room);
        else sock.send(JSON.stringify({ t: "names", map: namesOf(room) }));
        broadcast(room, { t: "peer-joined", id: sock.data.id }, sock);
        return;
      }

      if (!sock.data.room) return;

      if (msg.t === "rename") {
        const name = cleanName(msg.name);
        if (name === sock.data.name) return;
        sock.data.name = name;
        publishNames(sock.data.room);
        return;
      }

      if (msg.t === "share-start") {
        const set = sharersOf(sock.data.room);
        if (!set.has(sock.data.id) && set.size >= MAX_SHARERS) {
          sock.send(JSON.stringify({ t: "share-denied", reason: "limit" }));
          return;
        }
        if (set.has(sock.data.id)) return;
        set.add(sock.data.id);
        publishSharers(sock.data.room);
        return;
      }

      if (msg.t === "share-stop") {
        const set = sharersOf(sock.data.room);
        if (!set.delete(sock.data.id)) return;
        publishSharers(sock.data.room);
        return;
      }

      // Relay opaco: o servidor nunca olha dentro de data, só entrega.
      if (msg.t === "signal" && msg.to) {
        const set = rooms.get(sock.data.room);
        if (!set) return;
        for (const peer of set) {
          if (peer.data.id === msg.to) {
            peer.send(JSON.stringify({ t: "signal", from: sock.data.id, data: msg.data }));
            break;
          }
        }
      }
    },

    onClose(sock) {
      const room = sock.data?.room;
      if (!room) return;
      const set = rooms.get(room);
      if (!set) return;
      set.delete(sock);

      const wasSharing = sharers.get(room)?.delete(sock.data.id);

      if (!set.size) { rooms.delete(room); sharers.delete(room); return; }

      broadcast(room, { t: "peer-left", id: sock.data.id });
      if (wasSharing) publishSharers(room);
      publishNames(room);
    },
  });

  // Os dois sockets precisam estar de pé ANTES de reportar sucesso. O
  // EADDRINUSE do dgram chega assíncrono e mataria o processo depois do CLI já
  // ter dito "rodando" e gravado o pidfile.
  const stun = await new Promise((ok, err) => {
    const s = startStun(STUN_PORT);
    s.once("error", err);
    s.once("listening", () => { s.removeListener("error", err); ok(s); });
  });

  await new Promise((ok, err) => {
    server.once("error", (e) => { stun.close(); err(e); });
    server.listen(PORT, HOST, () => { server.removeAllListeners("error"); ok(); });
  });

  return { close() { server.close(); stun.close(); } };
}
```

- [ ] **Step 3: Verificar sintaxe e subir uma vez à mão**

```bash
cd /home/andreello/dev/share
node --check server.js && node --check ws.js && node --check ws-frame.js
node -e "
import('./server.js').then(async (m) => {
  const s = await m.start({ port: 3399, stunPort: 3499 });
  const cfg = await fetch('http://127.0.0.1:3399/config').then(r => r.json());
  console.log('config:', JSON.stringify(cfg));
  const html = await fetch('http://127.0.0.1:3399/').then(r => r.status);
  console.log('index:', html);
  const trav = await fetch('http://127.0.0.1:3399/..%2Fserver.js').then(r => r.status);
  console.log('traversal:', trav);
  const ainda = await fetch('http://127.0.0.1:3399/config').then(r => r.status);
  console.log('vivo depois do traversal:', ainda);
  s.close(); process.exit(0);
});
"
```
Expected: `config: {"stunPort":3499,...,"maxCapturePixels":1440000}`, `index: 200`, `traversal: 404`, **`vivo depois do traversal: 200`** — essa última linha é o teste de regressão do achado mais grave da revisão.

- [ ] **Step 3b: Verificar as recusas de handshake**

Estas precisam de servidor de verdade, porque testam a resposta HTTP antes do upgrade — não dá pra cobrir no `test-ws.js`.

```bash
cd /home/andreello/dev/share
node -e "
import('./server.js').then(async (m) => {
  const s = await m.start({ port: 3398, stunPort: 3498 });
  const casos = [
    ['sem Sec-WebSocket-Key', { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13' }],
    ['versão errada',         { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '8', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }],
    ['rota errada',           { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }],
  ];
  const net = await import('node:net');
  for (const [nome, h] of casos) {
    const rota = nome === 'rota errada' ? '/naoexiste' : '/ws';
    const linhas = Object.entries(h).map(([k, v]) => k + ': ' + v).join('\\r\\n');
    const resp = await new Promise((ok) => {
      const c = net.connect(3398, '127.0.0.1', () => {
        c.write('GET ' + rota + ' HTTP/1.1\\r\\nHost: x\\r\\n' + linhas + '\\r\\n\\r\\n');
      });
      let b = ''; c.on('data', (d) => { b += d; c.destroy(); }); c.on('close', () => ok(b.split('\\r\\n')[0]));
    });
    console.log(nome + ' -> ' + resp);
  }
  s.close(); process.exit(0);
});
"
```
Expected: `sem Sec-WebSocket-Key -> HTTP/1.1 400 Bad Request`, `versão errada -> HTTP/1.1 426 Upgrade Required`, `rota errada -> HTTP/1.1 404 Not Found`. Nenhum `101`, e o processo continua vivo até o fim.

- [ ] **Step 4: Commit**

```bash
cd /home/andreello/dev/share
git add server.js stun.js
git commit -m "feat(server): Port the server from Bun.serve to node:http"
```

---

## Task 4: Portar a suíte de integração (`test.js`)

**Files:**
- Rename: `test.ts` → `test.js`
- Modify: `test.js` (dois `Bun.sleep`, e o arranque do servidor)

**Interfaces:**
- Consumes: `start()` do Task 3.
- Produces: nada. É o portão de integração.

O conteúdo dos testes **não muda**. Eles usam o `WebSocket` global, que o Node ≥ 22 tem nativamente e que é um cliente RFC 6455 real — de brinde ele oferece `permessage-deflate` no handshake, o que exercita a recusa de extensão do Task 2.

- [ ] **Step 1: Renomear e trocar o `Bun.sleep`**

```bash
cd /home/andreello/dev/share
git mv test.ts test.js
```

Troque as duas ocorrências (linhas ~63 e ~563 no arquivo atual):

```js
// no topo do arquivo, junto dos outros imports
import { setTimeout as sleep } from "node:timers/promises";
```
```js
// era: const settle = () => Bun.sleep(300);
const settle = () => sleep(300);
```
```js
// era: await Bun.sleep(200);
await sleep(200);
```

Confirme que não sobrou nenhum: `grep -n 'Bun\.' test.js` deve não retornar nada.

- [ ] **Step 2: Rodar a suíte contra o servidor novo**

O `test.js` já respeita `PORT`/`STUN_PORT`, então use portas altas para não colidir com um servidor que já esteja rodando em 3000.

```bash
cd /home/andreello/dev/share
(PORT=3400 STUN_PORT=3500 node -e "import('./server.js').then(m=>m.start({port:3400,stunPort:3500}))" > /tmp/s.log 2>&1 & echo $! > /tmp/p); \
  sleep 2; PORT=3400 STUN_PORT=3500 timeout 90 node test.js; rc=$?; kill $(cat /tmp/p) 2>/dev/null; exit $rc
```
Expected: **todas as asserções passam, `0 falharam`, exit 0.** Se algo falhar aqui, é bug do `ws.js` ou do `server.js` — não altere o conteúdo dos testes para acomodar. O valor deste passo é justamente ser um teste que não foi escrito para esta implementação.

- [ ] **Step 3: Apagar o `server.ts`**

Só agora, com a suíte verde contra o `server.js`:

```bash
cd /home/andreello/dev/share
git rm server.ts
```

- [ ] **Step 4: Commit**

```bash
cd /home/andreello/dev/share
git add test.js
git commit -m "test: Run the existing suite against the Node server"
```

---

## Task 5: O CLI (`bin/cli.js`)

**Files:**
- Create: `bin/cli.js`

**Interfaces:**
- Consumes: `start()` do Task 3.
- Produces: o executável. Nenhuma outra tarefa depende dele em código.

- [ ] **Step 1: Escrever o CLI**

```js
#!/usr/bin/env node
/* CLI do screen-share. Sobe HTTP + STUN, opcionalmente em background.

   Três coisas aqui existem por causa de bug medido, não por precaução:
   - a guarda de runtime, porque `bun run` e `bunx --bun` usam Bun, e sob Bun o
     101 do upgrade não chega ao fio: a página carrega, /config responde e
     nenhum WebSocket abre, com o cliente em loop de reconexão para sempre;
   - a espera de readiness antes de gravar o pidfile, porque o EADDRINUSE do
     STUN chega assíncrono e o pai reportaria sucesso de um processo já morto;
   - o pidfile com O_EXCL e checagem de cmdline, porque uma segunda instância
     sobrescrevia o pidfile da primeira e deixava o --stop mirando num cadáver.
*/

import { spawn } from "node:child_process";
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { networkInterfaces, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (typeof globalThis.Bun !== "undefined") {
  console.error(
    "screen-share precisa rodar sob Node, não Bun.\n" +
    "Sob Bun o upgrade de WebSocket não completa e nenhuma conexão abre.\n" +
    "Use `npx screen-share` ou `bunx screen-share` (sem --bun)."
  );
  process.exit(1);
}

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, "..");

const estadoDir = process.env.XDG_STATE_HOME
  ? path.join(process.env.XDG_STATE_HOME, "screen-share")
  : path.join(homedir(), ".local", "state", "screen-share");
const PIDFILE = path.join(estadoDir, "screen-share.pid");

/** @param {string[]} argv */
function parseArgs(argv) {
  const o = {
    port: 3000, stunPort: 3478, host: "0.0.0.0",
    peers: 5, sharers: 2, maxPixels: 1_440_000,
    bg: false, stop: false, child: false,
  };
  const num = (v, nome) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) { console.error(`valor inválido para ${nome}: ${v}`); process.exit(1); }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bg") o.bg = true;
    else if (a === "--stop") o.stop = true;
    else if (a === "--internal-child") o.child = true;
    else if (a === "--host") o.host = String(argv[++i]);
    else if (a === "--stun-port") o.stunPort = num(argv[++i], a);
    else if (a === "--peers") o.peers = num(argv[++i], a);
    else if (a === "--sharers") o.sharers = num(argv[++i], a);
    else if (a === "--max-pixels") o.maxPixels = num(argv[++i], a);
    else if (/^\d+$/.test(a)) o.port = num(a, "porta");
    else if (a === "-h" || a === "--help") { ajuda(); process.exit(0); }
    else { console.error(`opção desconhecida: ${a}`); ajuda(); process.exit(1); }
  }

  // Clamps. O PLANO.md lista "mais de 5 peers" como fora de escopo, e acima de
  // 2.073.600 pixels o colapso de CPU medido volta (10,1 cores de 12, 6–9 fps).
  if (o.peers > 5) { console.error("aviso: --peers acima de 5 não é suportado; usando 5"); o.peers = 5; }
  if (o.maxPixels > 2_073_599) {
    console.error("aviso: --max-pixels acima de 2073599 derruba a CPU de quem compartilha; usando 2073599");
    o.maxPixels = 2_073_599;
  }
  return o;
}

function ajuda() {
  console.log(`screen-share [porta]        padrão 3000

  --bg                  roda em background e devolve o prompt
  --stop                encerra a instância em background
  --host <addr>         padrão 0.0.0.0
  --stun-port <n>       padrão 3478
  --peers <n>           padrão 5, máximo 5
  --sharers <n>         padrão 2
  --max-pixels <n>      padrão 1440000, máximo 2073599`);
}

function enderecos(port) {
  const out = [];
  for (const lista of Object.values(networkInterfaces())) {
    for (const i of lista ?? []) {
      if (i.family === "IPv4" && !i.internal) out.push(`http://${i.address}:${port}`);
    }
  }
  return out;
}

function pidVivo(pid) {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmd.includes("screen-share") || cmd.includes("cli.js");
  } catch { return false; }
}

function pararBackground() {
  if (!existsSync(PIDFILE)) { console.log("nada rodando em background."); return; }
  const pid = Number(readFileSync(PIDFILE, "utf8").trim());
  if (!pidVivo(pid)) {
    unlinkSync(PIDFILE);
    console.log(`pidfile órfão removido (pid ${pid} não existe mais).`);
    return;
  }
  process.kill(pid, "SIGTERM");
  // O filho também apaga o pidfile no handler de SIGTERM. Quem chegar depois
  // encontra ENOENT, e isso é sucesso, não erro.
  try { unlinkSync(PIDFILE); } catch {}
  console.log(`encerrado (pid ${pid}).`);
}

function gravarPid(pid) {
  mkdirSync(estadoDir, { recursive: true });
  try {
    const fd = openSync(PIDFILE, "wx");   // O_EXCL: não sobrescreve pidfile alheio
    writeSync(fd, String(pid));
    closeSync(fd);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const antigo = Number(readFileSync(PIDFILE, "utf8").trim());
    if (pidVivo(antigo)) {
      console.error(`já existe um screen-share em background (pid ${antigo}). Use --stop antes.`);
      process.exit(1);
    }
    unlinkSync(PIDFILE);
    gravarPid(pid);
  }
}

const o = parseArgs(process.argv.slice(2));

if (o.stop) { pararBackground(); process.exit(0); }

const opcoes = {
  port: o.port, stunPort: o.stunPort, host: o.host,
  maxPeers: o.peers, maxSharers: o.sharers, maxCapturePixels: o.maxPixels,
};

async function rodar() {
  const { start } = await import(path.join(RAIZ, "server.js"));
  try {
    await start(opcoes);
  } catch (e) {
    // EADDRINUSE de qualquer um dos dois sockets cai aqui, ANTES de qualquer
    // relato de sucesso.
    console.error(`falha ao subir: ${e.code === "EADDRINUSE" ? `porta ocupada (${e.message})` : e.message}`);
    process.exit(1);
  }
  return true;
}

if (o.child) {
  await rodar();
  process.stdout.write("READY\n");            // o pai só grava o pidfile ao ver isto
  const limpar = () => { try { unlinkSync(PIDFILE); } catch {} process.exit(0); };
  process.on("SIGTERM", limpar);
  process.on("SIGINT", limpar);
} else if (o.bg) {
  const args = [
    fileURLToPath(import.meta.url), String(o.port), "--internal-child",
    "--host", o.host, "--stun-port", String(o.stunPort),
    "--peers", String(o.peers), "--sharers", String(o.sharers),
    "--max-pixels", String(o.maxPixels),
  ];
  const filho = spawn(process.execPath, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let erro = "";
  filho.stderr.on("data", (b) => { erro += b; });
  const pronto = await new Promise((ok) => {
    let saida = "";
    filho.stdout.on("data", (b) => { saida += b; if (saida.includes("READY")) ok(true); });
    filho.on("exit", () => ok(false));
    setTimeout(() => ok(false), 10_000);
  });
  if (!pronto) {
    process.stderr.write(erro || "o servidor não subiu (sem saída de erro).\n");
    process.exit(1);
  }
  gravarPid(filho.pid);
  filho.unref();
  console.log(`screen-share em background (pid ${filho.pid}). Pare com: screen-share --stop`);
  banner();
  process.exit(0);
} else {
  await rodar();
  banner();
}

function banner() {
  console.log(`\nhttp  :${o.port}   ·   stun udp :${o.stunPort}`);
  console.log(`peers/sala ${o.peers}  ·  sharers ${o.sharers}  ·  captura até ${o.maxPixels} px\n`);
  for (const u of enderecos(o.port)) console.log(`  ${u}`);
  console.log(`  http://localhost:${o.port}`);
  console.log(`
Sem HTTPS, compartilhar tela só funciona em localhost — o navegador não expõe a
captura fora de contexto seguro. Para publicar com certificado válido:

  tailscale serve --bg ${o.port}

Não há autenticação: quem alcançar ${o.host}:${o.port} entra na sala. É
intencional. O STUN em UDP ${o.stunPort} precisa ficar acessível direto; o
tailscale serve só faz proxy de TCP e não cobre ele.`);
}
```

- [ ] **Step 2: Testar o caminho de erro, que é o que a revisão pegou**

```bash
cd /home/andreello/dev/share
chmod +x bin/cli.js
# ocupa a UDP de propósito e confirma que o CLI NÃO mente
node -e "import('node:dgram').then(d=>d.createSocket('udp4').bind(3478))" & sleep 1
node bin/cli.js 3000 --bg; echo "exit=$?"
kill %1 2>/dev/null
```
Expected: mensagem de porta ocupada e **exit=1**. Nenhum "rodando em background", e nenhum pidfile criado.

- [ ] **Step 3: Testar o caminho feliz e o `--stop`**

```bash
cd /home/andreello/dev/share
node bin/cli.js 3401 --stun-port 3501 --bg && sleep 1 && \
  curl -s http://127.0.0.1:3401/config && echo && \
  node bin/cli.js --stop && sleep 1 && \
  (curl -s --max-time 2 http://127.0.0.1:3401/config || echo "derrubado, como esperado")
```
Expected: pidfile criado, `/config` responde JSON, `--stop` encerra, e o `curl` seguinte falha.

- [ ] **Step 4: Commit**

```bash
cd /home/andreello/dev/share
git add bin/cli.js
git commit -m "feat(cli): Add the screen-share CLI with background mode"
```

---

## Task 6: `package.json` publicável e teste de empacotamento

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Reescrever o `package.json`**

```json
{
  "name": "screen-share",
  "version": "0.1.0",
  "description": "Servidor de compartilhamento de tela P2P. Sem SFU, sem TURN, sem conta, sem dependências.",
  "type": "module",
  "license": "MIT",
  "bin": { "screen-share": "./bin/cli.js" },
  "files": ["bin", "public", "server.js", "ws.js", "ws-frame.js", "stun.js"],
  "engines": { "node": ">=20" },
  "repository": { "type": "git", "url": "git+https://github.com/thoth-id/ss.git" },
  "keywords": ["screen-sharing", "webrtc", "p2p", "tailscale", "stun"],
  "scripts": {
    "start": "node bin/cli.js",
    "test": "node test-ws.js && (node -e \"import('./server.js').then(m=>m.start({port:3400,stunPort:3500}))\" > /tmp/ss-test.log 2>&1 & echo $! > /tmp/ss-test.pid); sleep 2; PORT=3400 STUN_PORT=3500 node test.js; rc=$?; kill \"$(cat /tmp/ss-test.pid)\" 2>/dev/null; exit $rc"
  }
}
```

Note que `private: true` sai (o npm recusa publicar com ele) e `UNLICENSED` vira `MIT`. `test.js` e `test-ws.js` **não** entram em `files`: ficam no repositório e fora do tarball.

- [ ] **Step 2: Rodar a suíte inteira pelo `npm test`**

Run: `cd /home/andreello/dev/share && npm test`
Expected: as duas suítes verdes, exit 0.

- [ ] **Step 3: Provar o empacotamento a partir de um cwd sem assets**

```bash
cd /home/andreello/dev/share && npm pack --silent
W=$(mktemp -d); mv screen-share-*.tgz "$W/"; cd "$W"
tar tzf screen-share-*.tgz | sort
npm init -y > /dev/null 2>&1 && npm install --silent ./screen-share-*.tgz > /dev/null 2>&1
./node_modules/.bin/screen-share 3402 --stun-port 3502 --bg && sleep 1
curl -s http://127.0.0.1:3402/config; echo
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3402/
./node_modules/.bin/screen-share --stop
cd - > /dev/null && rm -rf "$W"
```
Expected: o `tar tzf` lista `package/public/index.html` e os cinco `.js`; o `/config` responde; o `/` devolve `200` **rodando de um diretório que não tem `public/`** — é a prova de que a resolução é relativa ao pacote.

- [ ] **Step 4: Commit**

```bash
cd /home/andreello/dev/share
git add package.json
git commit -m "build: Make the package publishable as screen-share"
```

---

## Task 7: Reescrever a documentação

**Files:**
- Modify: `CLAUDE.md`, `PLANO.md`, `README.md`

Documentação que descreve um runtime que saiu é pior do que não ter documentação. Estas três abrem afirmando "Bun + TypeScript, três arquivos de fonte".

- [ ] **Step 1: `CLAUDE.md`**

Trocar, mantendo o inglês do arquivo:
- "Bun + TypeScript, **zero dependencies**, no build step, no `npm install`" → "Node ≥ 20 + JavaScript with JSDoc types, **zero dependencies**, no build step".
- "Three source files total" → cinco (`bin/cli.js`, `server.js`, `ws.js`, `ws-frame.js`, `stun.js`), mais `public/index.html`.
- O bloco de comandos: `bun run server.ts` → `node bin/cli.js`; o comando de teste vira o `npm test` do Task 6.
- Acrescentar uma seção curta explicando **por que Node e não Bun**, com a evidência: sob Bun o 101 do upgrade não chega ao fio.
- Acrescentar que `ws.js`/`ws-frame.js` são o ponto de risco e que `test-ws.js` roda sem servidor.

- [ ] **Step 2: `PLANO.md`**

- Seção 2 (stack e layout): mesma troca de runtime e de lista de arquivos.
- Seção 5 (invariantes), duas emendas registradas **como emendas**, não como preservação:
  - **I2** ganha nota: existe agora um teto de 1 MB por mensagem no transporte. Não é inspeção de `data` — o servidor continua sem olhar dentro —, mas é um contrato de tamanho que não existia sob o `Bun.serve`.
  - **I4** é enfraquecida na prática: como CLI público o bind padrão é `0.0.0.0` e não há auth. Existe `--host` para restringir e o banner de boot torna a exposição visível, mas a invariante original ("nunca escuta na internet pública") deixa de ser garantida pelo código e passa a ser escolha do operador.
  - **I5** é *preservada e reforçada*: não geramos certificado e não existe `--cert/--key`. TLS só por proxy na frente.

- [ ] **Step 3: `README.md`**

As três frases da seção 6 da spec, sem eufemismo: não há autenticação; não há TURN e por isso parte dos pares entre redes diferentes não conecta; sem HTTPS não existe compartilhamento fora de `localhost`. Mais a seção de instalação com `npx screen-share --bg 3000` e o `tailscale serve` como caminho recomendado de TLS.

- [ ] **Step 4: Verificar que nenhuma referência morta sobreviveu**

```bash
cd /home/andreello/dev/share
grep -rniE 'bun|\.ts\b|server\.ts|stun\.ts|test\.ts' README.md CLAUDE.md PLANO.md
```
Expected: só ocorrências legítimas — a explicação histórica de *por que* o Bun saiu, e nada mais. Qualquer instrução no imperativo mandando rodar `bun` é falha.

- [ ] **Step 5: Commit**

```bash
cd /home/andreello/dev/share
git add README.md CLAUDE.md PLANO.md
git commit -m "docs: Rewrite the docs for the Node runtime and the CLI"
```

---

## Ordem e portões

1. Tasks 1 e 2 (`ws-frame.js`, `ws.js`) **antes** de qualquer coisa tocar num socket real. É o portão que a spec §10 pede.
2. Task 3 depende de 2. Task 4 é o portão de integração: a suíte existente, sem alteração de conteúdo, verde contra a implementação nova.
3. Task 5 depende de 3. Tasks 6 e 7 fecham.

**Bloqueio externo:** outro agente está com `server.ts`, `test.ts`, `CLAUDE.md`, `PLANO.md`, `README.md` e `public/index.html` na mão implementando o NOME. As Tasks 3, 4 e 7 tocam exatamente esses arquivos. **Não comece a Task 3 antes que aquele trabalho esteja commitado e a suíte esteja verde.** Tasks 1 e 2 criam arquivos novos e podem começar imediatamente.

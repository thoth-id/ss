# Design: publicar o `tela` como `screen-share` no npm

Data: 2026-08-24. Status: revisado adversarialmente, pronto para virar plano.

> **Revisão 2.** A v1 desta spec passou por revisão adversarial que reproduziu
> cada afirmação técnica. Onze achados entraram; três eram graves o bastante para
> mudar o desenho (crash por `%2F`, fragmentação de frame pelo Chrome, ausência de
> keepalive). O que mudou está registrado na seção 12.

## 1. Objetivo

Transformar o projeto num CLI publicável:

```bash
npx screen-share --bg 3000     # HTTP em :3000, STUN em UDP :3478
tailscale serve --bg 3000      # HTTPS real por cima, opcional
```

O valor é ser um servidor de compartilhamento de tela **rápido e barato**: ele
nunca toca em mídia, só faz signaling e STUN, então não há custo de banda por
sessão. O preço é conectividade — seção 6.

## 2. Decisões, com a evidência que as sustenta

**D1. Node puro, sem Bun.** Sob Bun, o `node:http` aceita o `upgrade` e o
`socket.write` reporta sucesso, mas **o 101 não chega ao fio** — o cliente não
recebe byte nenhum e nunca abre. Sob Node o mesmo código faz o round trip
completo. Quatro contornos foram testados sob Bun (`resume()` antes do write,
write em `setImmediate`, interceptar em `connection`, `node:net` puro): só o
`node:net` funciona, e o híbrido `net.createServer` + `httpSrv.emit("connection")`
quebra o HTTP comum sob Bun. Manter os dois runtimes exigiria escrever o HTTP na
mão também. O Bun sai.

**D2. Fonte em `.js` com tipos em JSDoc.** O Node recusa type stripping dentro de
`node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), e nenhuma flag
contorna: `--experimental-strip-types` dá o mesmo erro e
`--experimental-transform-types` não existe. **Existe** uma saída — um shim de
~12 linhas com `module.registerHooks` + `module.stripTypeScriptTypes` carrega
`.ts` de dentro de `node_modules`, verificado funcionando inclusive em cadeia
`.ts → .ts`. Recusamos essa saída por três motivos: as duas APIs são
experimentais, imprimem `ExperimentalWarning` no stderr a cada execução, e metem
uma camada de loader entre o `npx` e o servidor. **Não é impossível; é caro e
instável, e por isso não fazemos.**

**D3. Nenhuma geração de certificado.** Com `tailscale serve` na frente, o
Tailscale termina o TLS com Let's Encrypt válido e repassa em HTTP puro — não há
cert a gerar. O `node:crypto` também não emite certificado: `createCertificate` e
`generateCertificate` são `undefined`, `X509Certificate` só tem leitores, e
`crypto.Certificate` é só SPKAC. Shell-out para `openssl` seria possível, e é
recusado porque adiciona dependência de binário e produz exatamente o self-signed
que a invariante I5 proíbe.

**D4. Sem autenticação.** Decisão de produto, explícita e reafirmada. O README diz
isso na primeira tela.

**D5. Nome `screen-share`.** Livre no registry (`tela` está tomado, v0.0.4
abandonado). Muda **só o pacote e o comando**: projeto, repositório e UI continuam
`tela`. Quem roda digita `npx screen-share`; quem abre a página vê `tela`.

**D6. Mesmo repositório.**

**D7. O NOME por peer entra na v1.** Já está sendo implementado em paralelo e
adiciona ao formato de fio: campo `name` no `join`, mensagem `rename`
cliente→servidor, e broadcast `names` com o mapa inteiro. O porte carrega isso
junto; não é trabalho separado.

## 3. Superfície real do porte

| arquivo | situação |
|---|---|
| `stun.ts` | **zero API de Bun e zero anotação de tipo.** Rodou sob Node sem alteração e devolveu Binding Success correto, bindado em `0.0.0.0`. É um `git mv` para `.js` e nada mais. |
| `server.ts` | onde mora o TypeScript de verdade: `import type { ServerWebSocket }`, `type Client`, `type Socket`, `Bun.serve<Client>`, parâmetros anotados. Mais `Bun.serve` e `Bun.file`. |
| `test.ts` | **dois** `Bun.sleep`. |
| `public/index.html` | **intocado.** Vira asset empacotado. |

A contagem de asserções está em movimento por causa do NOME, então o plano não
deve citar número fixo: o portão é "a suíte inteira verde, sem alteração de
conteúdo dos testes existentes".

## 4. Arquivos depois da mudança

```
bin/cli.js         flags, --bg/--stop, guarda de runtime, avisos de boot
server.js          node:http: estáticos + /config + sala/sharers/names
ws.js              servidor WebSocket RFC 6455 na mão (NOVO — todo o risco)
stun.js            renomeado, lógica intocada
public/index.html  intocado
test.js            suíte atual + cobertura de framing do ws.js
package.json       publicável
```

## 5. Detalhes que decidem a implementação

### 5.1 `ws.js`

**Acumulador obrigatório.** Um chunk de TCP pode trazer vários frames ou meio
frame. Buffer por socket, consumindo enquanto houver frame completo.

**Remontagem de fragmentos — não é opcional.** A v1 desta spec dizia que a
aplicação não gera fragmentação e que tratar `0x0` continuation como erro era
aceitável. **Medido: é falso.** O Chrome fragmenta frames de texto acima de
65536 bytes, e **de forma intermitente** — a mesma mensagem de 66000 bytes veio
ora em 1 frame, ora em 2, em repetições do mesmo teste. Acima de 96000 é sempre
fragmentada. O corte não é alinhado (200 KB viraram 124852 + 6148 + 69053 bytes).
O SDP real hoje é confortável — `offer.sdp` medido em 5649 chars com candidates,
mensagem de signaling inteira em 6057 bytes, um frame só, ~10× de margem — mas o
`data` é opaco por definição e pode crescer. E o `Bun.serve` **remonta hoje**,
verificado: três frames `0x1`/`0x0`/`0x0` chegaram como uma `MESSAGE` de 11 bytes.
Recusar continuation seria uma regressão silenciosa e intermitente. São ~10 linhas
sobre o acumulador: `fragOp` + `fragParts`, teto aplicado ao **total remontado**,
rejeitando só o ilegal de verdade (continuation sem início, data frame novo no
meio de um fragmento).

**Keepalive e idle timeout — não é opcional.** O `Bun.serve` faz isso de graça e
foi medido: cliente que completa o handshake e silencia recebe um ping do servidor
em t+104 s e é fechado em t+120 s com `1006 "WebSocket timed out from
inactivity"`. Nenhum default do `node:http` cobre isso — `headersTimeout`,
`requestTimeout` e `keepAliveTimeout` param no upgrade, e `setKeepAlive` é off.
Sem isso, um socket half-open (tampa do notebook, queda de Wi-Fi, rota do tailnet
mudando — rotina neste app) **nunca dispara `close`**, e o `CLAUDE.md` é
explícito: o `close` é quem libera a vaga de sharer. Dois fantasmas e ninguém mais
compartilha; cinco e a sala fica inacessível. Ping do servidor a cada ~30 s,
`lastPong` por socket, `destroy()` após dois perdidos.

**Conformidade que o parser precisa ter:**

- Frame do cliente **sempre** mascarado; do servidor **nunca**. Frame de entrada
  sem máscara → fechar com 1002. Verificado que o `Bun.serve` simplesmente ignora
  em silêncio — um parser que assume o bit de máscara leria 4 bytes de payload
  como chave e devolveria JSON corrompido.
- **RSV ≠ 0 → 1002.** Chrome e o `WebSocket` do Node oferecem
  `Sec-WebSocket-Extensions: permessage-deflate` no handshake. O `ws.js` **não**
  ecoa o header (o Bun também não) e rejeita RSV1.
- **Não ecoar `Sec-WebSocket-Protocol`.** Verificado que o `Bun.serve` ecoa um
  subprotocolo que nunca declarou; não repetir isso.
- `Sec-WebSocket-Key` ausente → **400**. `sha1(undefined + GUID)` não lança:
  produz um Accept bogus e um 101 inválido.
- `Connection` casado como **token**, não igualdade de string — proxies mandam
  `keep-alive, Upgrade`.
- Control frames ≤ 125 bytes e nunca fragmentados. Close ecoa o código (o Chrome
  manda payload de 2 bytes). Ping responde pong.
- Comprimentos 7 / 16 / 64 bits. Teto de 1 MB no total remontado.
- Backpressure: `socket.write` retornando `false` é advisory, não perde dado. Não
  tratar como erro.
- Sobras do buffer após `\r\n\r\n` precisam ser tratadas (o `head` do evento
  `upgrade` veio vazio nos dois runtimes, mas não dá para depender disso).

**Interface**, corrigida — a da v1 esquecia o filtro de rota e o método de envio:

```js
attachWebSocket(httpServer, {
  path: "/ws",                    // o server.ts filtra por pathname hoje
  onOpen(sock), onMessage(sock, text), onClose(sock),
})
// sock.send(string) e sock.data = { id, room, name }
```

Toda a máquina de estado de sala, sharers e names é copiada do `server.ts` sem
alteração de lógica — ela já é agnóstica de transporte.

### 5.2 Estáticos: guarda em `path`, nunca em `URL`

`Bun.file("./public" + path)` é relativo ao **cwd**, e `npx` roda de onde o
usuário estiver. Precisa virar relativo ao pacote.

**A troca ingênua introduz um kill remoto.** `fileURLToPath`/`readFileSync(URL)`
**lançam** `ERR_INVALID_FILE_URL_PATH` em caminhos com `%2F`, e um throw síncrono
dentro do handler do `node:http` é `uncaughtException` — o processo inteiro morre,
levando HTTP, WebSocket e STUN juntos, porque é um processo só. Verificado: um
`curl --path-as-is '…/..%2Fx'` derrubou o servidor, e o request seguinte não teve
resposta. Hoje o mesmo request é um 404 mudo. Com `--bg` e `stdio: "ignore"` o
stack trace não vai a lugar nenhum: o usuário vê prompt, pidfile, e nada
funcionando.

Então: `decodeURIComponent` → normalizar → `path.resolve(PUBLIC_DIR, rel)` →
exigir `startsWith(PUBLIC_DIR + sep)` → só então ler. E o handler inteiro dentro
de `try/catch` → 500, porque `node:http` sem isso morre a cada exceção não
prevista.

A resolução relativa ao pacote foi validada ponta a ponta: `npm pack` → instalar →
rodar o bin de um cwd sem asset nenhum → o `index.html` empacotado foi servido.

### 5.3 O CLI

```
npx screen-share [porta]        padrão 3000
  --bg / --stop
  --host <addr>                 padrão 0.0.0.0
  --stun-port <n>               padrão 3478
  --sharers <n>                 padrão 2
  --peers <n>                   padrão 5,  clampado em 5
  --max-pixels <n>              padrão 1440000, clampado em 2073599
```

`--cert/--key` **saiu da v1**: pelo próprio argumento de D3 ninguém no caso de uso
alvo executaria, e ele abre a porta que a invariante I5 fecha. Quem quer TLS põe
proxy na frente.

`--peers` é clampado porque o `PLANO.md` §8 lista "mais de 5 peers" como fora de
escopo; `--max-pixels` é clampado abaixo de 2.073.600 porque acima disso o
colapso de CPU medido volta (10,1 cores de 12, 6–9 fps). Flag sem clamp é convite.

**O `--bg` da v1 mentia.** `startStun()` retorna normalmente e o `EADDRINUSE` do
`dgram` chega um tick depois como `error` não tratado, matando o processo.
Verificado: com a UDP ocupada, o CLI imprimiu "rodando em background (pid N)",
gravou o pidfile, e o processo já estava morto — zero diagnóstico. Pior, uma
segunda instância com a porta HTTP tomada **sobrescreveu o pidfile da primeira**,
deixando o `--stop` apontando para um cadáver enquanto o servidor real seguia no
ar. Portanto:

- bindar HTTP **e** UDP no processo pai, ou exigir readiness do filho por IPC, e
  só então imprimir e gravar o pidfile;
- `.on("error")` explícito nos dois sockets, com mensagem útil;
- pidfile com flag `wx` (O_EXCL); conferir `/proc/<pid>/cmdline` antes de matar;
  `unlink` no `exit` **e** em handlers de `SIGTERM`/`SIGINT`, porque o SIGTERM
  padrão não roda handler de `exit`;
- fallback XDG correto é `~/.local/state`, **não** `os.tmpdir()` — pidfile em
  `/tmp` compartilhado é plantável por outro usuário local.

**Guarda de runtime no topo do `bin/cli.js`.** Verificado com pacote real:
`npx` e `bunx` respeitam o shebang e usam Node, mas `bun run <bin>` e
`bunx --bun` usam Bun — e aí a página carrega, `/config` responde e **nenhum
WebSocket abre**, com o cliente em loop de reconexão de 1,5 s para sempre. Três
linhas: se `Bun` existir, erro claro e `exit(1)`.

**Banner de boot.** Sem TLS na frente, dizer que compartilhar só funciona de
`localhost` e imprimir o `tailscale serve --bg <porta>` preenchido. Listar as
URLs alcançáveis por interface. E, já que o bind é `0.0.0.0` e não há auth, dizer
em uma linha o que está exposto e para quem — a decisão é do operador, mas ela
precisa ser visível.

**Continua valendo:** `tailscale serve` só faz proxy de TCP. O STUN em UDP 3478
fica exposto direto.

## 6. O que o README precisa dizer, sem rodeio

1. **Não há autenticação.** Quem alcança a porta entra na sala. É intencional.
2. **Não há TURN.** Em rede plana (tailnet, LAN) fecha direto sempre; entre redes
   diferentes, parte dos pares não fecha — NAT simétrico dos dois lados é o caso
   clássico. É o que torna o servidor barato. A telemetria mostra o tipo de
   candidate, então dá para diagnosticar.
3. **Sem HTTPS não existe compartilhamento** fora de `localhost`.

## 7. Testes

O `ws.js` é o risco, e a lista da v1 não o cobria: ela usava só cliente feito à
mão, que produz exatamente os frames que a implementação espera. Adicionar:

- **entregar um frame byte a byte** — um teste só que pega quase todo bug de
  acumulador;
- split caindo **dentro do campo de comprimento de 16 bits** e **dentro da chave
  de máscara**;
- continuation remontada em 3 partes; control frame **entre** fragmentos;
- frame **não mascarado** → 1002; **RSV1** setado → 1002;
- close com código ecoado; ping com payload; ping > 125 bytes;
- mensagem exatamente no teto e um byte acima;
- 100 frames num único `write`;
- `Sec-WebSocket-Key` ausente → 400.

**Portão de integração:** rodar a suíte existente **sem alteração de conteúdo**
contra o `ws.js`, usando o `WebSocket` global do Node — que é um cliente RFC 6455
real e, de brinde, oferece `permessage-deflate` (teste negativo útil de RSV).
Custa trocar os dois `Bun.sleep` por `setTimeout` de `node:timers/promises`.

Ordem: os testes de framing vêm **antes** de ligar o `ws.js` ao `server.js`.

## 8. Fora do escopo da v1

Geração de certificado self-signed, `--cert/--key`, TURN, autenticação, SFU,
Funnel, persistência. O NOME **saiu** desta lista (ver D7).

## 9. Invariantes: auditoria honesta

A v1 desta spec afirmava que as invariantes "não mudam" e, na mesma frase,
reescrevia uma. Corrigindo:

- **I1** (PCs direcionais): é do cliente, intocado. ✅
- **I2** (relay opaco): lógica copiada, o servidor continua sem olhar `data`. ✅
  Ressalva: o teto de 1 MB é uma **política de tamanho nova** sobre `data` que o
  Bun não tinha — verificado que um frame único de 2 MB passa hoje. Não é
  inspeção, mas é um contrato novo e merece ser nomeado no `PLANO.md`.
- **I3** (STUN em `0.0.0.0:3478`): preservado e verificado sob Node. ✅
- **I4** (nunca escutar na internet pública sem auth): **enfraquecida na prática.**
  `server.listen(port)` sobe em `0.0.0.0`, e como pacote de `npx` a população de
  operadores muda. A v1 nem oferecia mecanismo de escolha; agora existe `--host`,
  e o banner de boot torna a exposição visível. Ainda assim é uma emenda, não uma
  preservação, e o `PLANO.md` precisa registrá-la como tal.
- **I5** (HTTPS via `tailscale serve`, **nunca** self-signed): **preservada, e
  mais forte que na v1** — cortar `--cert/--key` e não gerar cert nenhum fecha as
  duas portas que a v1 tinha aberto enquanto afirmava não ter aberto.

## 10. Risco principal

O `ws.js`, e a revisão confirmou o porquê: dos onze achados, seis eram dele, e
três teriam passado em teste feliz — a fragmentação intermitente do Chrome só
aparece com mensagem grande, o half-open só aparece com rede real, e o frame não
mascarado só aparece com cliente hostil. Mitigação: seção 7, com os testes de
framing antes da integração.

## 11. Impacto na documentação existente

`CLAUDE.md` e `PLANO.md` §2 abrem com "Bun + TypeScript, três arquivos de fonte".
Depois de D1 e D2 isso vira Node + JavaScript com JSDoc, cinco arquivos de fonte.
Reescrever no mesmo passo do porte, não depois: documentação que descreve um
runtime que saiu é pior do que não ter documentação. O `PLANO.md` §5 precisa das
emendas de I2 e I4 registradas na seção 9.

## 12. O que a revisão adversarial mudou

Graves, mudaram o desenho: crash remoto por `%2F` na resolução de assets (5.2);
fragmentação intermitente de frame pelo Chrome acima de 64 KiB (5.1); ausência de
keepalive e idle timeout, com vazamento de vaga de sharer (5.1).

Médios: `--bg` reportando sucesso para processo morto e sobrescrevendo pidfile
alheio (5.3); `bun run`/`bunx --bun` quebrando em silêncio (5.3); D2 afirmando
"impossível" onde o correto é "possível, experimental, recusado" (2).

Menores: `--peers`/`--max-pixels` sem clamp (5.3); auditoria de invariantes errada
sobre I5 e leniente sobre I4 (9); doze itens de conformidade faltando no parser
(5.1); testes que não cobriam o risco declarado (7); imprecisões de inventário (3).

Uma imprecisão foi **do reviewer**: ele contou 77 asserções onde a suíte reportava
75. Nenhum dos dois números vale hoje — o NOME levou o arquivo a 90 call sites
enquanto a revisão rodava. Daí a seção 3 não citar número fixo.

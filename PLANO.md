# Plano de execução: `tela` (screen share P2P sobre Tailscale)

Documento auto-contido. Quem executar não participou das conversas anteriores.

---

## 1. O que é

Compartilhamento de tela browser-a-browser, sem áudio, para um grupo pequeno
(alvo: 5 pessoas) dentro de um tailnet Tailscale. Mesh WebRTC puro, sem SFU.

O servidor faz três coisas e só: serve o HTML estático, faz relay opaco de
signaling por WebSocket, e responde STUN. Ele **nunca** toca em mídia.

## 2. Stack e layout

Bun + TypeScript, sem dependências externas. Nada de npm install para
desenvolver o projeto em si — ver seção 11 sobre o pacote publicado.

```
bin/cli.ts       CLI: flags, --bg/--stop, repassa config por env pro server.ts
server.ts        Bun.serve: estático + /config + WebSocket de signaling
stun.ts          servidor STUN mínimo (~50 linhas, node:dgram)
public/
  index.html     cliente inteiro: HTML + CSS + JS, arquivo único
```

Rodar direto do repo: `bun run server.ts`. Sobe HTTP em `:3000` e STUN em UDP
`:3478`. Publicado no npm, o comando é `bunx screen-share` (seção 11).

## 3. Estado atual

### Verificado funcionando

Suíte headless rodada contra o código atual (Bun 1.4), 0 falhas:

- servidor sobe, serve `index.html`, responde `/config`, 404 em rota inexistente
- `join` responde `joined` com id e lista de peers
- `peer-joined` chega nos demais; `peer-left` propaga no close
- salas isoladas entre si
- `signal` chega no destinatário certo e não ecoa no remetente
- nomes de peers: `join`/`rename` saneados, `names` por estado, snapshot no
  join, nome apagado ao sair da sala e nenhum vazamento entre salas
- arbitragem de sharers derivada de `MAX_SHARERS`: o (N+1)-ésimo recebe
  `share-denied`, nenhum broadcast passa do teto, vaga liberada volta a aceitar
- STUN devolve Binding Success Response com XOR-MAPPED-ADDRESS correto
  (testado com cliente `dgram` cru: transaction id espelhado, family IPv4,
  IP e porta decodificados batem)

### NÃO verificado

Nada de WebRTC foi testado. Não houve browser, `getDisplayMedia`, segunda
máquina nem tailnet no ambiente de teste. **ICE fechando sobre IPs 100.x é a
maior incógnita do projeto e ainda não foi exercitada uma única vez.**

### Já implementado no cliente (não refazer)

- Modelo direcional de PeerConnections: maps separados `sending` e `receiving`.
  Nunca existe PC bidirecional. Cada PC tem um offerer único, então não há glare
  e não é preciso perfect negotiation. **Não mexer nisso.**
- ICE candidates carregam `dir: "tx" | "rx"` (ponto de vista do remetente,
  invertido no receptor) para desambiguar de qual das duas PCs vieram.
- Fila de ICE candidates chegados antes de `setRemoteDescription` (`pc.pending`).
- Layout de tiles calculado em JS (`layout()`), não em CSS grid: o palco tem
  altura fixa e cada tile é encaixado dentro dela pela proporção real do vídeo.
  A página não rola em nenhuma contagem de telas. `STRIP_LINE` (24) e
  `STRIP_BAND` (40) têm que continuar iguais às alturas da faixa no CSS, e as
  bordas dos tiles são `box-shadow: inset` justamente para não somarem altura.
  Qual das duas vale sai de um segundo passe: encaixa com a linha, e se o tile
  mais estreito ficou abaixo de `BAND_BELOW` (600px), refaz com a faixa.
- Modo foco: clique numa tela joga ela no palco inteiro e manda as outras para
  uma trilha de miniaturas (à direita, ou embaixo em tela estreita). `esc` sai.
  Os tiles nunca trocam de pai no DOM — mover um `<video>` com `srcObject` pisca.
- Medidor de bitrate por tile: 60 amostras, uma por segundo, em canvas. No tile
  largo mora na própria linha da telemetria, com fatia fixa de 3px; no estreito
  vira faixa de largura cheia acima do texto, com a fatia esticada. Nos dois
  casos as barras se encostam — esticar 60 amostras num tile de 1900px dava 32px
  de fatia e a fita virava tique esparso no canto.
- `maxBitrate` 1.5 Mb/s, `maxFramerate` 30, `degradationPreference:
  "maintain-resolution"`, `contentHint = "detail"`.
- Telemetria por tile a cada 1s: bitrate, resolução, fps, tipo de candidate, RTT.
- Sala pelo hash da URL (`#nome`). Reconnect automático do WebSocket.
- Campo de nome no cabeçalho: opcional, guardado no `localStorage`, mandado no
  `join` e por `rename` com debounce de 400ms (blur e Enter mandam na hora).
  Quem não escolhe nome aparece pelo id em toda a interface (`nameOf`).
- Placa de presença: quem está na sala e não transmite ganha um tile com
  monograma (`.tile.peer`), derivado de `peers`/`names`/`sharers` em
  `syncRoster()`, sem mudança nenhuma no servidor nem no protocolo — o cliente
  já sabia quem estava lá. **As placas não disputam área com o vídeo**: ficam
  numa trilha embaixo com teto de 132px, e só herdam o palco quando não há
  nenhum tile de vídeo (teto de 220px). Dar célula cheia de grid pra elas
  colocaria a tela compartilhada em um terço do palco, que é onde o texto dela
  deixa de ser legível — foi medido a olho nas capturas. Sozinho não há roster
  (uma placa só não informa nada), então `tiles.size` continua 0 e o card de
  vazio aparece como antes. Sem nome escolhido a placa mostra `_`, o cursor do
  prompt, porque o id é hex e a inicial dele não diz nada. Quem está em
  `sharers` mas cujo vídeo ainda não chegou aparece como `conectando…` — antes
  essa pessoa era invisível.

### Lacunas reais

1. Servidor não tem teto de peers por sala. Aceitou 7 numa sala de 5 sem reclamar.
2. Não existe arbitragem de quem pode compartilhar. Qualquer número de pessoas
   pode transmitir ao mesmo tempo. Com 5 pessoas todas compartilhando são 20
   PeerConnections e 4 encoders por máquina.
3. `stopShare()` fecha as PCs locais mas não avisa ninguém. O tile do outro lado
   só some quando o `connectionstatechange` cai sozinho, o que demora.
4. Reconnect gera `myId` novo sem derrubar as PCs antigas. Vaza conexão.

---

## 4. Protocolo atual (wire format)

JSON sobre WebSocket em `/ws`. Campo discriminador é `t`.

**Cliente → servidor**

```jsonc
{ "t": "join",   "room": "sala", "name": "gabriel" }   // name é opcional
{ "t": "rename", "name": "gabriel" }
{ "t": "signal", "to": "<peerId>", "data": { /* opaco */ } }
```

**Servidor → cliente**

```jsonc
{ "t": "joined",      "id": "<meuId>", "peers": ["<id>", ...] }
{ "t": "peer-joined", "id": "<id>" }
{ "t": "peer-left",   "id": "<id>" }
{ "t": "names",       "map": { "<id>": "gabriel", ... } }
{ "t": "signal",      "from": "<id>", "data": { /* opaco */ } }
```

**Nomes.** São cosméticos: quem não escolher aparece pelo id, que é o único
identificador que o servidor garante ser único. `peers` em `joined` continua
sendo lista de ids crus, e o nome nunca viaja dentro de `data` — passaria pelo
relay opaco, que por I2 o servidor não pode ler.

O nome mora no socket (`ws.data.name`), não num `Map` à parte, e o mapa
publicado é derivado dos sockets da sala na hora de publicar. Assim sair da sala
já apaga o nome, sem um segundo caminho de limpeza que possa divergir do
`close`. O broadcast é por estado, igual ao de `sharers`: o mapa inteiro vai
junto a cada mudança, mais um snapshot pra quem acabou de entrar.

Saneamento acontece no servidor, numa função só: espaços colapsados, aparado,
cortado em 24 caracteres. Nome vazio depois disso não vira entrada no mapa — é
também o caminho de apagar o próprio nome. `rename` com o mesmo nome não
re-broadcasta, mesmo espírito do `share-start` idempotente.

**Dentro de `data`** (o servidor nunca inspeciona isso):

```jsonc
{ "kind": "offer",  "sdp": {...} }
{ "kind": "answer", "sdp": {...} }
{ "kind": "ice",    "dir": "tx" | "rx", "candidate": {...} }
```

Manter `data` opaco no servidor é regra, não detalhe. É o que permite mudar a
negociação sem tocar no backend.

---

## 5. Invariantes

Não quebrar nenhuma destas. Cada uma existe por um motivo específico.

**I1. Uma PeerConnection por sentido, nunca bidirecional.**
Se A e B transmitem um pro outro, são duas PCs distintas. Uma PC compartilhada
faria os dois criarem offer simultaneamente (glare) e exigiria perfect
negotiation. O desenho atual torna isso impossível por construção.

**I2. O servidor não olha dentro de `data`.**

**I3. O STUN precisa continuar bindado em `0.0.0.0:3478`.**
Ele existe porque o Chrome troca host candidates de IP privado por nomes mDNS
`.local`, e a faixa CGNAT do Tailscale (100.64/10) conta como privada. mDNS
depende de multicast, que não atravessa o tailnet, então esses candidates morrem
em silêncio. O STUN devolve o 100.x como srflx, que não sofre obfuscation.
`tailscale serve` só faz proxy de TCP/HTTP e **não** cobre o STUN UDP. Peers
batem direto no `100.x:3478`.

**I4. A aplicação nunca escuta na internet pública.**
Não há autenticação no app, e é intencional: o tailnet é a camada de auth. Não
adicionar Funnel, port forwarding ou bind público sem antes implementar auth de
verdade. Fora do tailnet os peers também deixam de compartilhar rede, o que
quebraria a premissa do STUN e passaria a exigir TURN.

**I5. HTTPS via `tailscale serve`, não self-signed.**
`getDisplayMedia` só existe em secure context. `tailscale serve --bg 3000` emite
cert Let's Encrypt válido para o nome `.ts.net`.

---

## 6. Tarefas

Executar em ordem. T0 vem antes de qualquer código.

### T0 — Validar o baseline (bloqueia todo o resto)

Sem isso, as tarefas seguintes podem estar polindo algo que não conecta.

1. `bun run server.ts` numa máquina do tailnet.
2. `tailscale serve --bg 3000` (HTTPS precisa estar habilitado no admin console
   em DNS > Enable HTTPS).
3. Abrir a URL `.ts.net` em duas máquinas diferentes do tailnet.
4. Uma compartilha, a outra deve ver a tela.
5. Ler o campo de path na telemetria do tile.

**Aceite:** vídeo aparece do outro lado e o tipo de candidate é `host` ou
`srflx`. Registrar qual foi.

**Se falhar:** abrir `chrome://webrtc-internals`, achar a PC e ver em que estado
o ICE parou. Sintoma esperado se o STUN não estiver sendo alcançado: só
aparecem candidates com nome terminando em `.local` e o pair nunca chega a
`succeeded`. Nesse caso confirmar que a UDP 3478 está acessível pelo 100.x
(`nc -zvu <ip-tailnet> 3478`) e que o firewall local não está bloqueando.

**Não prosseguir para T1 enquanto T0 não passar.**

---

### T1 — Teto de peers por sala

`server.ts`. Constante `MAX_PEERS = 5`.

No handler de `join`, se a sala já tem `MAX_PEERS`, responder
`{ "t": "denied", "reason": "room-full" }` e **não** adicionar ao Set nem
emitir `peer-joined`. O cliente mostra o motivo e não tenta reconectar em loop.

Atenção: o reconnect automático atual reenvia `join` a cada 1.5s. Ao receber
`denied`, o cliente precisa parar de reconectar, senão vira busy loop.

**Aceite:** 6º peer recebe `denied`; os 5 primeiros seguem intactos; o 6º não
aparece na lista de ninguém.

---

### T2 — Arbitragem de sharers (a tarefa principal)

O servidor é o único ponto que vê a sala inteira, então a decisão mora nele.
Dois cliques simultâneos em máquinas diferentes só são serializáveis num lugar.

Constante `MAX_SHARERS`. Deixar como constante para mudar trocando um número,
sem refatorar nada — o `test.ts` deriva o tamanho da sala do T2 da mesma
constante. Nasceu 2; virou **3** depois da medição da seção 10.

**Estado no servidor:** `sharers: Map<room, Set<peerId>>`.

**Novas mensagens cliente → servidor:**

```jsonc
{ "t": "share-start" }
{ "t": "share-stop" }
```

**Nova mensagem servidor → cliente (broadcast para a sala inteira):**

```jsonc
{ "t": "sharers", "ids": ["<id>", ...] }
```

Broadcast baseado em estado, não em evento. Manda o conjunto inteiro toda vez
que ele muda. É idempotente, sobrevive a reconnect e evita o cliente ter que
reconstruir estado a partir de deltas.

Regras:

- `share-start` com `sharers.size >= MAX_SHARERS` → responder só ao remetente
  `{ "t": "share-denied", "reason": "limit" }`, não alterar o Set.
- `share-start` aceito → adiciona ao Set, broadcast `sharers`.
- `share-stop` → remove do Set, broadcast `sharers`.
- `close` do socket → remove do Set se estiver lá, broadcast `sharers`.
  Não esquecer deste. É o caminho do fechamento de aba.

**No cliente:**

- `startShare()` chama `getDisplayMedia` primeiro (o picker precisa do gesto do
  usuário e não pode esperar round-trip), depois manda `share-start`. Se vier
  `share-denied`, parar os tracks imediatamente, zerar `localStream` e mostrar
  o motivo.
- `stopShare()` manda `share-stop`.
- Ao receber `sharers`, desabilitar o botão de compartilhar se o conjunto já
  está cheio e eu não estou nele.
- Ao receber `sharers`, derrubar tile e PC de `receiving` de qualquer id que
  saiu do conjunto. Isso resolve a lacuna 3 de graça: o tile some na hora em vez
  de esperar o `connectionstatechange`.

**Aceite:**
- 3ª tentativa de share recebe `share-denied` e o broadcast `sharers` nunca
  passa de 2 ids.
- Fechar a aba de um sharer libera a vaga.
- Tile do sharer que parou some em menos de 1s nos outros.

---

### T3 — Reconnect limpo

Hoje `ws.onclose` reconecta, recebe `joined` com `myId` novo, mas as PCs antigas
continuam abertas apontando pro id velho.

Em `joined`, se `myId` mudou em relação ao anterior, fechar e limpar tudo:
`sending`, `receiving`, `tiles`. Se `localStream` ainda existe, reabrir os
envios com os ids novos (o código atual já faz `peers.forEach(openSend)`, só
falta a limpeza antes) e reenviar `share-start`.

**Aceite:** derrubar a rede por 5s e voltar não deixa PC órfã
(`sending.size + receiving.size` bate com o esperado) nem tile duplicado.

---

## 7. Como testar

**Signaling e servidor: headless, sem browser.** Todas as regras de T1 e T2 são
testáveis com clientes WebSocket puros em Bun, porque o servidor nunca inspeciona
`data`. Padrão: abrir N `new WebSocket("ws://127.0.0.1:3000/ws")`, mandar `join`,
coletar mensagens num array, dar `await Bun.sleep(300)` entre passos e assertar.

Subir servidor e teste no mesmo comando de shell (processo em background numa
invocação separada não sobrevive):

```bash
(bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); sleep 2; \
  timeout 30 bun run test.ts; kill $(cat /tmp/p)
```

**WebRTC: só manualmente, com duas máquinas no tailnet.** Não há como cobrir
isso headless aqui. `chrome://webrtc-internals` é a ferramenta.

---

## 8. Fora de escopo

Não implementar sem pedido explícito: áudio, chat, gravação, SFU, TURN,
autenticação, Funnel, persistência, mais de 5 peers.

## 9. Ponto a verificar, não a confiar

`applyEncoding()` tem um comentário afirmando que parâmetros idênticos em todos
os peers fazem o Chrome reaproveitar uma única instância de encoder em vez de
uma por conexão. **Isso não foi verificado e provavelmente está errado** — o
comportamento usual é um encoder por PeerConnection. Não usar essa afirmação
como base para decisão de capacidade. Se importar, medir uso de CPU com 4
destinos e comparar com 1.

---

## 10. Custo de CPU: os dois eixos, medidos

Feita numa bancada que sobe N instâncias de Chrome (uma por "máquina", cada uma
com `user-data-dir` próprio, CPU atribuída percorrendo a árvore de processos em
`/proc`) contra o **cliente real** — a página de bancada só troca o
`getDisplayMedia` por um device falso alimentado por y4m; do `getSettings()` em
diante o caminho é o de produção, corte de pixels incluído, então todo stream
rodou a 1518×948. Core 7 150U, 12 lógicas, `libvpx` VP8 em software.

### Os dois eixos não custam a mesma coisa

Com **P** pessoas na sala e **S** transmitindo, o custo **na sua máquina** é:

| o que você paga | fórmula | eixo |
|---|---|---|
| encoders | `P-1`, se você transmite | mais gente **assistindo** |
| upload | `(P-1) x 1,5 Mb/s` | mais gente **assistindo** |
| decoders | `S`, menos o seu próprio | mais gente **compartilhando** |
| download | `(S-1) x 1,5 Mb/s` | mais gente **compartilhando** |

O número de encoders de quem transmite é ditado por `MAX_PEERS`, **não** por
`MAX_SHARERS`. Um sharer a mais não cria encoder nenhum na máquina de ninguém.

### Mais gente assistindo — o eixo caro

Um sharer só, sala enchendo. Todas as linhas a 30fps e
`qualityLimitationReason: "none"`:

| destinos | cores do sharer | Δ | threads do renderer |
|---|---|---|---|
| 1 | 0,59 | — | 20 |
| 2 | 0,93–0,95 | +0,36 | 24–26 |
| 3 | 1,54 | +0,59 | 28 |
| 4 | **1,87–2,31** | +0,77 | 33 |

Sala cheia custa ~2 cores de 12 pra quem transmite. **O degrau não existe abaixo
do cap**: o salto de 0,8 → 5,9 cores entre o primeiro e o segundo destino, que a
seção de performance do README registra a 1920×1080, aqui é +0,36. Com movimento
pesado de quadro inteiro os mesmos 4 destinos custam 3,66 cores.

Dois sinais de que a bancada mede o produto e não a si mesma: 2,31 cores contra
os 2,0 medidos antes a 1600×900, e 33 threads de renderer contra os 33
registrados lá.

### Mais gente compartilhando — o eixo barato

Um viewer paga 0,17–0,19 core por stream recebido e 0,32–0,36 por dois: linear.
E uma máquina que já transmite para 2 destinos, ao passar a **também receber**
um stream, vai de 0,93 → 1,11 — **+0,18, o mesmo que um viewer puro paga**.
Decode soma; não interage com encode.

### O que a bancada NÃO conseguiu medir

Qualquer coisa acima de dois streams simultâneos numa máquina que também
transmite. Cinco Chromes inteiros não cabem em 12 cores: com P=5 a caixa satura
a partir de S=2 (`lim: "cpu"`, fps caindo 22 → 7 → 4,5 → 2,7) e essas linhas
medem a bancada, não o `tela`.

**Antes de confiar em qualquer número de CPU aqui, leia o fps e o
`qualityLimitationReason` ao lado.** Custo que *cai* enquanto a carga sobe é
estrangulamento, não eficiência — foi assim que uma leitura apressada quase
virou conclusão.

Duas pontas soltas:

1. Com P=3 e S=3, cada máquina custou 2,56 cores onde a aditividade previa 1,27,
   com fps intacto em 29,4 e sistema em 68%. Sem explicação. Contenção de caixa
   única é plausível, mas não foi provada.
2. O mesmo cenário (P=5, S=1) mediu 2,31 numa rodada e 1,87 em outra. Trate tudo
   nesta seção como ±20%.

Fechar as duas exige o que o T0 já pede: duas ou três máquinas de verdade do
tailnet.

### Por que `MAX_SHARERS` virou 3, e não 5

Os dois componentes de S=3 estão medidos limpos: 4 encoders (~2,0–2,3 cores) e
2 decodes (+0,36), dando ~2,4 cores de 12. Ir até 5 seria extrapolação — o
argumento estrutural continua de pé, mas não há medição que o sustente. 3 é onde
a medição limpa termina, não onde 4 se mostrou ruim.

### Achado colateral: o STUN responde do endereço errado em host multi-homed

`stun.ts` faz bind em `0.0.0.0`, então o kernel escolhe o IP de origem da
resposta pela rota até o destino, e não pelo endereço que recebeu o pedido:

```
pedido saindo por tailscale0 → 100.x:3478   resposta de 100.x          OK
pedido saindo por wifi       → 100.x:3478   resposta de 192.168.15.x   descartada
```

O Chrome descarta resposta STUN cuja origem difere do endereço que ele
perguntou, então aquela interface nunca forma `srflx` — o log dele enche de
`Received non-STUN packet from unknown address`. **Peers remotos do tailnet não
sofrem**: a rota até o `100.x` deles sai pela `tailscale0` e a origem sai certa.
Só quebra com cliente na mesma máquina — que é exatamente o caso "duas abas no
host", e é candidato concreto a explicar por que a única rodada real de ICE
voltou `prflx` em vez do `srflx` que o T0 esperava. Não corrigido; registrado.

---

## 11. Empacotamento npm

O projeto virou publicável no registry do npm sob o nome **`screen-share`**.
Isso mudou só a forma de distribuir e invocar; não mudou o stack. Uma spec e
um plano mais ambiciosos foram escritos antes disso e avaliaram portar o
servidor para `node:http` com um WebSocket escrito à mão, para tirar a
dependência do Bun (`docs/superpowers/specs/2026-08-24-pacote-npm-design.md`
e `docs/superpowers/plans/2026-08-24-pacote-npm.md`). **Esse porte não foi o
caminho seguido.** O que foi implementado manteve Bun e TypeScript ponta a
ponta: `bin/cli.ts`, `server.ts` e `stun.ts` são publicados como escritos, sem
transpilação e sem `dist/`, e é o Bun que os executa direto — os dois
documentos acima registram uma exploração descartada, não o desenho atual.

**Como se roda.** `bunx screen-share [flags]`. O shebang do `bin/cli.ts` é
`#!/usr/bin/env bun`. Quem roda `npx screen-share` numa máquina sem Bun recebe
`env: bun: No such file or directory` — seco, mas nomeia o que falta; com Bun
instalado, `npx` funciona igual a `bunx`.

**CLI.** `bin/cli.ts` só faz três coisas: parseia flags, decide primeiro plano
ou segundo (`--bg`/`--stop`), e repassa a configuração ao `server.ts` por
variável de ambiente — nenhuma lógica de servidor mora ali. Flags: `-p/--port`
(3000), `--stun-port` (3478), `--peers` (5), `--sharers` (3), `--pixels`
(1440000), `--bg`, `--stop`, `-h/--help`, `-v/--version`. `--bg` grava pidfile
em `$TMPDIR/screen-share-<porta>.pid` e log em
`$TMPDIR/screen-share-<porta>.log`, e só reporta sucesso depois que o
`/config` do processo filho responder com a config *dele* — checando primeiro
que o filho segue vivo, e só então sondando o HTTP, porque uma porta já
ocupada por outro processo também responde 200 e um sondador que olhasse só o
HTTP daria o servidor como no ar com o nosso processo já morto de
`EADDRINUSE`. `--stop` lê o pidfile e mata o processo registrado nele.

**`server.ts` passou a ler os três limites do ambiente**, com os mesmos
números medidos como padrão: `MAX_PEERS = process.env.MAX_PEERS ?? 5`,
`MAX_SHARERS = process.env.MAX_SHARERS ?? 3`,
`MAX_CAPTURE_PIXELS = process.env.MAX_CAPTURE_PIXELS ?? 1_440_000`. Isso é o
que permite as flags do CLI sem duplicar a lógica dos limites em dois lugares:
`bin/cli.ts` só seta `PORT`, `STUN_PORT`, `MAX_PEERS`, `MAX_SHARERS` e
`MAX_CAPTURE_PIXELS` no ambiente do processo filho. Rodar `bun run server.ts`
direto do repo continua funcionando sozinho, com as mesmas variáveis, sem o
CLI no meio.

**Dois bugs que só apareceram numa instalação de verdade, os dois corrigidos
aqui:**

1. Os estáticos resolviam `"./public"` contra o cwd do processo. Instalado
   como pacote, o processo roda do diretório de quem chamou `bunx`, então
   `/config` respondia mas a própria página dava "not found". Agora
   `resolverEstatico()`, em `server.ts`, resolve contra `import.meta.dir` e
   guarda contra traversal (`../`, `%2e%2e`, barras codificadas — tudo 404
   agora, verificado).
2. `--bg` reportava sucesso mesmo com a porta já ocupada: sondava `/config`
   antes de checar se o processo filho seguia vivo, e qualquer 200 satisfazia
   a checagem, inclusive o de quem já ocupava a porta. Agora a checagem de
   vida vem primeiro, o corpo da resposta é validado como sendo do próprio
   filho (compara `stunPort`), e o `EADDRINUSE` do filho é impresso a partir
   do arquivo de log em vez de o comando morrer em silêncio.

**Verificado:** suíte de 97 asserções verde contra o `server.ts` modificado, e
empacotar + instalar + rodar a partir de um diretório de consumidor separado
serve a página real.

**O que não muda.** `PLANO.md` continua descrevendo o projeto pelo nome
interno `tela` — repositório, UI e este documento seguem `tela`; só o pacote
publicado e o comando de CLI são `screen-share`. As seções 5 (invariantes) e
9–10 (medições de CPU) descrevem `server.ts`/`stun.ts` e continuam valendo sem
alteração — nada no empacotamento toca em signaling, mídia ou STUN.

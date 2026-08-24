# tela

Compartilhamento de tela P2P entre navegadores, sem áudio, para um grupo
pequeno dentro de uma rede que você já confia (ex.: um tailnet Tailscale). Sem
TURN, sem SFU, sem conta, sem servidor de mídia: o servidor só faz relay de
signaling e responde STUN — o vídeo vai direto de um navegador a outro.

Empacotado para o npm sob o nome **`@thoth-dev/screen-share`** — ainda não publicado.

## Instalar e rodar

Exige [Bun](https://bun.sh) instalado na máquina que sobe o servidor: o
pacote publica `bin/cli.ts`, `server.ts` e `stun.ts` como escritos, sem build
e sem `dist/`, e é o Bun que os executa direto.

> **A publicação ainda não aconteceu.** Enquanto ela não acontece, o `bunx`
> abaixo não resolve. A partir de um clone do repositório o equivalente é
> `bun run bin/cli.ts`, com as mesmas flags.

```bash
bunx @thoth-dev/screen-share
```

Sobe HTTP + WebSocket de signaling em `:3000` e STUN em UDP `:3478`.
`npx @thoth-dev/screen-share` também funciona **se** Bun já estiver instalado na máquina;
sem Bun, o shebang (`#!/usr/bin/env bun`) falha com
`env: bun: No such file or directory` — seco, mas nomeia o que falta.

Depois, na mesma máquina:

```bash
tailscale serve --bg 3000
```

Isso publica `https://<maquina>.<tailnet>.ts.net` com cert válido do Let's Encrypt,
acessível só de dentro do tailnet. **Esse passo não é opcional:** `getDisplayMedia`
só existe em secure context, então servir em `http://100.64.x.y:3000` faz a API
sumir do `navigator.mediaDevices`.

O `tailscale serve` precisa que HTTPS esteja habilitado no tailnet
(admin console → **DNS → Enable HTTPS**). Sem isso, `tailscale cert` responde
`HTTPS cert support is not enabled` e o serve não sobe.

O STUN roda em UDP 3478 direto no IP do tailnet, fora do `tailscale serve`
(que só proxia TCP). Se você tem ACL restritiva no tailnet, libere 3478/udp.

## Flags

```bash
bunx @thoth-dev/screen-share [flags]
```

| flag | padrão | o que faz |
|---|---|---|
| `-p, --port <n>` | 3000 | porta HTTP + WebSocket de signaling |
| `--stun-port <n>` | 3478 | porta UDP do STUN |
| `--peers <n>` | 5 | teto de peers por sala |
| `--sharers <n>` | 3 | quantos transmitem ao mesmo tempo |
| `--pixels <n>` | 1440000 | teto de pixels da captura (= 1600×900) |
| `--bg` | — | sobe em segundo plano |
| `--stop` | — | encerra o que está em segundo plano na mesma porta |
| `-h, --help` | — | mostra a ajuda |
| `-v, --version` | — | mostra a versão |

Com `--bg`, o pidfile e o log ficam em `$XDG_RUNTIME_DIR/screen-share/` —
`screen-share-<porta>.pid` e `screen-share-<porta>.log` — ou, sem
`XDG_RUNTIME_DIR`, num `screen-share-<uid>/` dentro do diretório temporário,
criado com modo 0700 e recusado se pertencer a outra pessoa. Não é `$TMPDIR`
direto de propósito: ali o modo 1777 deixa qualquer usuário da máquina plantar
um pidfile no caminho. O comando só reporta sucesso depois que o
`/config` do processo filho responde — isto é, depois que ele de fato bindou a
porta, não só depois de ter sido lançado. `--stop --port <n>` encerra o que
está registrado naquele pidfile.

## Testar (a partir do repositório)

```bash
(bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); sleep 2; \
  timeout 90 bun run test.ts; kill $(cat /tmp/p)
```

Cobre estático, signaling, teto de peers, arbitragem de sharers e o wire format
do STUN — tudo headless, sem browser. **WebRTC não é coberto:** ICE fechando
sobre IPs 100.x só se verifica com duas máquinas de verdade no tailnet e
`chrome://webrtc-internals`.

## Por que tem um STUN aqui

O Chrome esconde host candidates de IP privado atrás de nomes mDNS (`.local`),
e IP de Tailscale cai na faixa CGNAT 100.64/10, que ele trata como privado.
mDNS depende de multicast, multicast não atravessa o tailnet, o peer remoto
nunca resolve o nome e o ICE falha em silêncio.

Um STUN dentro do tailnet devolve o 100.x do peer como srflx candidate, que não
sofre obfuscation. São ~50 linhas em `stun.ts` e é o que faz a coisa conectar.

## Topologia

Star por sharer, não mesh. Quem compartilha abre um `RTCPeerConnection` por
viewer. Com 1 sharer e 4 viewers: 4 conexões, upload = 4 × bitrate.

`CAP_BITRATE` está em 1.5 Mbps por peer (~6 Mbps de upload com 4 viewers).

As PeerConnections são **direcionais**: `sending` e `receiving` são maps
separados e nunca existe uma PC bidirecional. Cada PC tem um offerer único, o
que elimina glare e dispensa perfect negotiation. Não unifique os dois maps.

É **um encoder por PeerConnection**, e isso foi medido. O custo de CPU de quem
compartilha não é curva, é degrau: com 4 destinos, capturar em 1920×1080 come
10,1 cores de 12 e entrega 6–9 fps, enquanto 1600×900 custa 2,0 cores com 30 fps
cheios. Até 1856×1044 — só 7% menos pixels que 1080p — já cai pra 3,8 cores.

A causa é oversubscription de thread, não custo de pixel: o WebRTC dá ~8 threads
de encode por PeerConnection a partir de 1920×1080 e ~3 abaixo disso. Contado no
`/proc`, o renderer de quem compartilha carrega 51 threads em 1920×1080 contra
33 em 1600×900. Com 4 encoders são 32 threads de encode disputando 12 lógicas.

Por isso existe o teto de pixels da captura (`--pixels`, padrão 1.440.000): o
cliente reduz o track capturado pra caber no orçamento preservando o aspecto
real da tela (1920×1200 vira 1518×948). O corte é **na fonte, uma vez só**, e
não por conexão — os N encoders leem o mesmo track. Qualquer teto novo precisa
ficar abaixo de 1920×1080 pixels (2.073.600), senão o degrau volta.

Com `--sharers 3` (padrão) o pior caso da sala são 3 sharers × 4 destinos = 12
PeerConnections. Mas repare em qual limite manda no quê: **quem transmite abre
uma PC por destino, ou seja `--peers - 1` = 4 encoders**, e esse número não
muda se uma segunda ou terceira pessoa também começar a transmitir. O que
`--sharers` controla é quantos streams cada máquina *decodifica*, e decode é
barato — 0,18 core por stream, medido. Foi por isso que o teto subiu de 2 para
3: o medo era de CPU e estava no eixo errado.

O que continua valendo o cuidado é o número de pessoas na sala, não o de
transmissores. Se um dia `--peers` crescer muito, vira N² e você precisa de um
SFU (mediasoup, LiveKit).

## Limites

Os três limites (`--peers`, `--sharers`, `--pixels`) partem de constantes no
topo do `server.ts` que agora leem do ambiente (`PORT`, `STUN_PORT`,
`MAX_PEERS`, `MAX_SHARERS`, `MAX_CAPTURE_PIXELS`), e o CLI só os repassa. O
servidor continua sendo a única autoridade: é o único ponto que vê a sala
inteira, então dois cliques simultâneos em máquinas diferentes só são
serializáveis lá.

| flag / env | valor padrão | o que faz |
|---|---|---|
| `--peers` / `MAX_PEERS` | 5 | 6º peer recebe `denied` e não entra na sala |
| `--sharers` / `MAX_SHARERS` | 3 | 4ª tentativa de compartilhar recebe `share-denied` |

Para permitir um sharer só, `bunx @thoth-dev/screen-share --sharers 1`. Nada mais muda.

## Protocolo

JSON sobre WebSocket em `/ws`, discriminado por `t`.

Cliente → servidor:

```jsonc
{ "t": "join",   "room": "sala", "name": "gabriel" }   // name é opcional
{ "t": "rename", "name": "gabriel" }
{ "t": "signal", "to": "<peerId>", "data": { /* opaco */ } }
{ "t": "share-start" }
{ "t": "share-stop" }
```

Servidor → cliente:

```jsonc
{ "t": "joined",       "id": "<meuId>", "peers": ["<id>", ...] }
{ "t": "denied",       "reason": "room-full" }
{ "t": "peer-joined",  "id": "<id>" }
{ "t": "peer-left",    "id": "<id>" }
{ "t": "names",        "map": { "<id>": "gabriel", ... } }
{ "t": "sharers",      "ids": ["<id>", ...] }
{ "t": "share-denied", "reason": "limit" }
{ "t": "signal",       "from": "<id>", "data": { /* opaco */ } }
```

`sharers` é broadcast **baseado em estado**: manda o conjunto inteiro toda vez
que ele muda, mais um snapshot pra quem acabou de entrar. É idempotente,
sobrevive a reconnect e o cliente nunca precisa reconstruir estado a partir de
deltas. Quem sai do conjunto tem tile e PC derrubados na hora, sem esperar o
`connectionstatechange`.

`names` segue a mesma ideia e é **derivado dos sockets**: o nome mora no socket
do peer, não num `Map` à parte, e o mapa publicado é montado percorrendo a sala
na hora. Sair da sala apaga o nome sozinho, sem um segundo caminho de limpeza
pra divergir do `close`. Nome é opcional e só cosmético — quem não escolher
aparece pelo id. O servidor colapsa espaços, apara e corta em 24 caracteres;
nome vazio depois disso não entra no mapa, que é como se apaga o próprio nome.

O servidor **nunca** olha dentro de `data`. É essa regra que permite mudar a
negociação sem tocar no backend. O nome, por isso mesmo, viaja em campo próprio
(`join`/`rename`) e nunca dentro de `data`.

## Salas

A sala vem do hash da URL: `/#retro`, `/#pair`. Sem hash, cai em `sala`.

## Configuração

| env | default | o que faz |
|---|---|---|
| `PORT` | 3000 | HTTP + WebSocket de signaling |
| `STUN_PORT` | 3478 | STUN UDP |
| `MAX_PEERS` | 5 | teto de peers por sala |
| `MAX_SHARERS` | 3 | quantos transmitem ao mesmo tempo |
| `MAX_CAPTURE_PIXELS` | 1440000 | teto de pixels da captura |

Rodando via `bunx @thoth-dev/screen-share`, essas variáveis são as flags da seção acima —
o CLI só as repassa por ambiente ao `server.ts`, o que mantém `bun run
server.ts` funcionando sozinho, sem o CLI no meio.

`GET /config` devolve `stunPort`, `maxPeers`, `maxSharers` e `maxCapturePixels`
pro cliente, então os limites não ficam duplicados no HTML.

## Segurança

Não há autenticação, e é intencional: **o tailnet é a camada de auth**. Não
adicione Funnel, port forwarding ou bind público sem antes implementar auth de
verdade. Fora do tailnet os peers também deixam de compartilhar rede, o que
quebra a premissa do STUN e passa a exigir TURN.

## Ajustes que valem a pena

- `contentHint = "detail"` já está setado: prioriza nitidez de texto sobre fluidez.
  Se for compartilhar vídeo em vez de código, troque para `"motion"`.
- `degradationPreference = "maintain-resolution"` mantém a resolução e derruba
  o framerate sob pressão. Para código é o que você quer. Trocar por `"balanced"`
  foi medido e **não** alivia CPU com vários destinos (10,4 cores contra 10,1);
  baixar o framerate também foi medido e **piora** (11,2 cores a 15fps). Quem
  resolve é o teto de pixels.
- O teto de pixels da captura (`--pixels`, servido no `/config`) é 1.440.000
  por padrão — equivalente a 1600×900. Subir esse número acima de 2.073.600
  traz de volta o colapso de CPU descrito em Topologia.
- A faixa de telemetria embaixo de cada tile mostra bitrate, resolução, fps,
  tipo de candidate e RTT. Se aparecer `host` em vez de `srflx`, os dois peers
  estão na mesma LAN física e o STUN nem foi necessário.
- No seu próprio tile a faixa mostra a resolução **capturada**. Se o encoder
  estiver mandando menos que isso, aparece a resolução real ao lado
  (`1600×900 → 640×360 bandwidth`) — captura certa com saída num degrau abaixo
  é o diagnóstico inteiro. E se a política de encoding não tiver entrado no seu
  browser, o texto `política recusada` ou `política não confirmada` aparece no
  lugar do campo de caminho. Sem ela o encoder troca resolução por framerate e
  desce uma escada que demora dezenas de segundos para subir de volta — ou não sobe.
- O medidor de barras é o bitrate do último minuto, uma barra por segundo. Queda
  de link aparece nele antes de o número instantâneo explicar o motivo. Em tile
  largo ele fica no fim da linha de telemetria; em tile estreito, numa faixa de
  largura cheia logo acima dela.
- O campo `eu/` no cabeçalho é o seu nome na sala: opcional, até 24 caracteres,
  guardado no `localStorage` do navegador e reenviado no reconnect. Quem deixar
  em branco aparece pelo id. É só rótulo — não há login nem identidade nenhuma
  por trás dele.
- Quem está na sala e não está transmitindo aparece numa placa com a inicial do
  nome, numa trilha embaixo das telas. Quem não escolheu nome mostra `_` e o id:
  o id é hex, e a inicial de `3f9a1b2c` não é ninguém. Quem pediu para
  compartilhar e ainda está negociando aparece como `conectando…`. A trilha tem
  teto de altura de propósito — placa não carrega informação por pixel, e o
  palco é área de vídeo. Com ninguém transmitindo, as placas herdam o palco.
- Clique numa tela (ou no botão `focar`) para jogá-la no palco inteiro; as outras
  viram miniaturas numa trilha — as placas de presença também. `esc` sai do foco.
  `tela cheia` usa a API de fullscreen do navegador e some com toda a interface.
- A página nunca rola: o palco tem a altura que sobra e cada tile é encaixado
  dentro dela, na proporção real da tela compartilhada. Nada é cortado.

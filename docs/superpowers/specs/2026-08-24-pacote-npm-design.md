# Design: publicar o `tela` como `screen-share` no npm

Data: 2026-08-24. Status: aprovado para virar plano de execução.

## 1. Objetivo

Transformar o projeto num CLI publicável, de modo que qualquer pessoa rode:

```bash
npx screen-share --bg 3000     # HTTP em :3000, STUN em UDP :3478
tailscale serve --bg 3000      # HTTPS real por cima, opcional
```

A proposta de valor é ser um servidor de compartilhamento de tela **rápido e
barato**: ele nunca toca em mídia, só faz signaling e STUN, então não há custo de
banda por sessão. O preço disso é conectividade — ver seção 6.

## 2. Decisões já tomadas, com a evidência que as sustenta

Cada uma foi medida nesta máquina, não deduzida.

**D1. Node puro, sem Bun.** O `node:http` do Bun não fecha o round trip de
upgrade: o evento `upgrade` dispara e o handshake escreve, mas `socket.on("data")`
nunca entrega e o cliente não chega a abrir. Uma implementação única em APIs Node
quebraria `bun run server.ts`, então o Bun sai. Consequência: o projeto deixa de
ser um projeto Bun.

**D2. Fonte em `.js` com tipos em JSDoc, não `.ts`.** O Node **se recusa** a fazer
type stripping em arquivos dentro de `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), e `--experimental-strip-types`
explícito não sobrescreve. Publicar `.ts` cru é impossível; compilar violaria o
"sem build step". JSDoc preserva as duas regras.

**D3. Nenhuma geração de certificado na v1.** Com `tailscale serve` na frente, o
Tailscale termina o TLS com um cert Let's Encrypt válido e repassa em HTTP puro —
o servidor não precisa de cert nenhum. O `node:crypto` também não sabe *emitir*
certificado (`X509Certificate` é só leitor; não existe `createCertificate`), então
a alternativa custaria uma dependência ou ~200 linhas de ASN.1 para uma
funcionalidade que o usuário principal nunca executaria. O CLI aceita
`--cert/--key` para quem já tem arquivo de cert.

**D4. Sem autenticação.** Decisão de produto, explícita e reafirmada. O README
precisa dizer isso na primeira tela, sem eufemismo.

**D5. Nome `screen-share`.** Verificado livre no registry. `tela` está tomado
(v0.0.4, abandonado). O nome muda **só no pacote publicado e no comando**: o
projeto, o repositório e a UI continuam se chamando `tela`. Quem roda digita
`npx screen-share`; quem abre a página vê `tela`. Se um dia isso incomodar, é uma
troca de string, não de arquitetura.

**D6. Mesmo repositório.** O pacote é o projeto; não se cria repo novo.

## 3. Superfície real do porte

O inventário mostrou que quase tudo já é portável:

| arquivo | situação |
|---|---|
| `stun.ts` | **zero API de Bun.** Rodou sem alteração sob Node 26 e devolveu Binding Success correto. Só renomear para `.js` e trocar os tipos por JSDoc. |
| `server.ts` | três pontos: `import type { ServerWebSocket } from "bun"` (some), `Bun.serve`, `Bun.file`. |
| `test.ts` | um ponto: `Bun.sleep`. |
| `public/index.html` | **inalterado.** Vira asset empacotado. |

Nenhum arquivo usa sintaxe TypeScript não-apagável (sem `enum`, `namespace` ou
parameter properties), então a conversão para JSDoc é mecânica.

## 4. Arquivos depois da mudança

```
bin/cli.js         parsing de flags, --bg/--stop, avisos de boot
server.js          node:http: estáticos + /config + sala/sharers
ws.js              servidor WebSocket RFC 6455 escrito na mão (NOVO)
stun.js            inalterado em lógica, só renomeado
public/index.html  intocado
test.js            suíte atual + cobertura nova do ws.js
package.json       publicável
```

`ws.js` é o único código genuinamente novo, e é onde mora o risco.

## 5. Detalhes que decidem a implementação

### 5.1 O servidor WebSocket (`ws.js`)

A prova de conceito que rodou sob Node **assumia um frame por evento `data`**, e
isso está errado em TCP. A implementação real precisa de um buffer acumulador por
socket:

- Um chunk de TCP pode conter **vários frames**, ou **meio frame**. Acumula em
  `Buffer.concat` e consome enquanto houver frame completo.
- Frames vindos do cliente são **sempre mascarados** (a RFC exige). Frames do
  servidor **nunca** são.
- Comprimentos: 0–125 inline, `126` → 16 bits, `127` → 64 bits. Um SDP fica em
  poucos KB, então a faixa de 16 bits é a que importa na prática, mas as três
  precisam existir.
- Opcodes: `0x1` texto (o único que a aplicação usa), `0x8` close (ecoa e
  encerra), `0x9` ping (responde pong). `0x0` continuation: a aplicação não gera
  fragmentação, então tratar como erro de protocolo e fechar é aceitável — mas
  tem que ser explícito, não silencioso.
- Teto de tamanho de mensagem (1 MB) para não virar vetor de memória.
- Handshake: exige `Upgrade: websocket` e `Sec-WebSocket-Version: 13`, responde
  `Sec-WebSocket-Accept = base64(sha1(key + GUID))`.

Interface exposta, desenhada para o `server.js` não saber nada de framing:

```js
attachWebSocket(httpServer, { onOpen(sock), onMessage(sock, text), onClose(sock) })
```

`sock.data` guarda `{ id, room }`, espelhando o que o `Bun.serve` dava de graça.
Toda a máquina de estado de sala e sharers do `server.ts` atual é copiada sem
alteração de lógica — ela já é agnóstica de transporte.

### 5.2 Estáticos relativos ao pacote

`Bun.file("./public" + path)` é relativo ao **cwd**, e `npx` roda de onde o
usuário estiver. Vira `new URL("./public/", import.meta.url)`. Validado ponta a
ponta: `npm pack` → instalar → rodar o bin de um diretório sem nenhum asset → o
`index.html` empacotado foi servido.

Aproveitar para adicionar guarda explícita de path traversal. Hoje as tentativas
retornam 404 (testei `/../server.ts`, `/..%2F…`, `/%2e%2e/…`, `/public/../…`,
`/....//…`), mas isso é consequência da normalização do `URL`, não de uma decisão.
Num pacote público a guarda deve ser deliberada.

### 5.3 O CLI

```
npx screen-share [porta]        padrão 3000
  --bg                          destaca do terminal e devolve o prompt
  --stop                        mata a instância em background
  --stun-port <n>               padrão 3478
  --peers <n>                   padrão 5
  --sharers <n>                 padrão 2
  --max-pixels <n>              padrão 1440000
  --cert <arq> --key <arq>      sobe em HTTPS direto, sem proxy na frente
```

`--bg` usa `spawn(process.execPath, [...], { detached: true, stdio: "ignore" })`
seguido de `.unref()`, com pidfile no diretório de estado XDG
(`$XDG_STATE_HOME/screen-share/`, caindo para `os.tmpdir()`). `--stop` lê o
pidfile e encerra.

No boot, sem `--cert`, imprimir um aviso que resolve o problema em vez de só
apontá-lo: dizer que compartilhar só funciona de `localhost` até haver HTTPS na
frente, e imprimir o comando `tailscale serve --bg <porta>` já preenchido. Listar
as URLs alcançáveis por interface, para colar direto.

**Continua valendo:** o `tailscale serve` só faz proxy de TCP. O STUN em UDP 3478
fica exposto direto e os peers batem nele sem passar pelo proxy.

## 6. O que o README precisa dizer, sem rodeio

1. **Não há autenticação.** Quem alcança a porta entra na sala. É intencional.
2. **Não há TURN.** Dentro de uma rede plana (tailnet, LAN) fecha direto sempre.
   Entre redes diferentes, parte dos pares não fecha — NAT simétrico dos dois
   lados é o caso clássico. É o que torna o servidor barato: ele nunca faz relay.
   A faixa de telemetria mostra o tipo de candidate, então dá para diagnosticar.
3. **Sem HTTPS não existe compartilhamento** fora de `localhost`.

## 7. Testes

A suíte atual (75 asserções) roda contra o servidor e cobre signaling, limites de
sala, arbitragem de sharers e o formato de fio do STUN. Ela precisa:

- rodar sob `node` (trocar `Bun.sleep` por `setTimeout` de `node:timers/promises`);
- ganhar cobertura de **framing** para o `ws.js`, que é o código novo e arriscado:
  frame mascarado simples, dois frames num chunk só, um frame partido em dois
  chunks, comprimento de 16 bits, close, ping/pong, e frame acima do teto.

O comando de teste continua precisando de servidor vivo num único shell, como
hoje.

## 8. Fora do escopo da v1

Nome de exibição por peer (o "NOME" já mencionado como próximo passo), geração de
certificado self-signed, TURN, autenticação, SFU, Funnel, persistência.

## 9. Impacto na documentação existente

`CLAUDE.md` abre dizendo "Bun + TypeScript, zero dependencies, no build step, no
npm install" e "three source files total". Depois de D1 e D2 isso vira Node +
JavaScript com JSDoc, e são cinco arquivos. `PLANO.md` seção 2 tem o mesmo
problema. Ambos precisam ser reescritos no mesmo passo do porte, não depois —
documentação que descreve um runtime que saiu é pior do que não ter documentação.

As invariantes da seção 5 do `PLANO.md` **não** mudam: I1 (PCs direcionais) é do
cliente, I2 (relay opaco) e I3 (STUN em `0.0.0.0:3478`) sobrevivem ao porte, I4
(sem bind público sem auth) passa a ser uma escolha consciente do operador que
roda o CLI, e I5 vira "TLS por proxy na frente, ou `--cert/--key`".

## 10. Risco principal

O `ws.js`. É o único código sem precedente no repositório, e bugs de framing são
do tipo que passa em teste feliz e quebra com SDP grande ou sob chunking de rede
real. Mitigação: os testes de framing da seção 7 vêm antes da integração, e o
`server.js` só é ligado ao `ws.js` depois deles verdes.

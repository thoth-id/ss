#!/usr/bin/env bun
/* CLI do screen-share.

   O shebang é bun, não node: o servidor usa Bun.serve para o WebSocket e não
   há equivalente em Node. É justamente por isso que este arquivo não é mais o
   `bin` do pacote: com ele lá, quem rodava `npx @thoth-dev/screen-share` sem
   Bun instalado morria no `env`, antes de qualquer linha nossa. Quem entra
   agora é o screen-share.mjs — Node executa, acha o bun e chega aqui. Rodar
   `bun bin/cli.ts` à mão continua idêntico.

   Nada aqui é lógica de servidor: isto lê flags, decide primeiro plano ou
   segundo, e entrega o resto ao server.ts. */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Opts = {
  port: number;
  stunPort: number;
  maxPeers?: number;
  maxSharers?: number;
  maxCapturePixels?: number;
};

// `import.meta.dir` é o idioma já usado no server.ts para a mesma pergunta.
const RAIZ = path.join(import.meta.dir, "..");

// Lido sob demanda: só --help e --version querem a versão, e antes disso todo
// `screen-share --bg` pagava um readFileSync mais um JSON.parse para nada.
const versao = (): string =>
  JSON.parse(readFileSync(path.join(RAIZ, "package.json"), "utf8")).version;

const ajuda = () => `screen-share ${versao()} — compartilhamento de tela P2P, sem conta e sem servidor de mídia

  bunx @thoth-dev/screen-share [flags]

  -p, --port <n>       porta HTTP (padrão 3000)
      --stun-port <n>  porta UDP do STUN (padrão 3478). Uma segunda instância
                       precisa desta TAMBÉM diferente, não só de --port
      --peers <n>      teto de peers por sala (padrão 5)
      --sharers <n>    quantos transmitem ao mesmo tempo (padrão 3)
      --pixels <n>     teto de pixels da captura (padrão 1440000, = 1600×900)
      --bg             sobe em segundo plano
      --stop           encerra o que está em segundo plano
      --force          com --stop, encerra mesmo sem poder confirmar o processo
  -h, --help
  -v, --version

  O servidor nunca toca na mídia: serve os estáticos, repassa o signaling e
  responde STUN. O vídeo vai direto de um navegador ao outro.

  Não há autenticação, e isso é deliberado. Quem alcança a porta entra na
  sala. Use dentro de um tailnet, uma VPN ou uma rede em que você confia —
  nunca exposto à internet aberta.

  Compartilhar tela exige contexto seguro: localhost funciona, IP puro não.
  Para outras máquinas, ponha HTTPS na frente (ex.: tailscale serve --bg 3000).`;

const ILIMITADO = Number.MAX_SAFE_INTEGER;

/* Inteiro, e dentro da faixa em que ele significa alguma coisa. `Number()`
   sozinho aceita " 0x10 " (vira 16), "1e3" e "2.5", e nenhum desses é um
   inteiro escrito como inteiro — daí a regex de dígitos. A faixa importa tanto
   quanto: `--port 99999` passava, o Bun clampava para 65535, e o banner
   anunciava uma porta em que ninguém escutava enquanto o pidfile ficava
   chaveado pelo número impossível. */
// Gêmeo de `int()` no server.ts, de propósito: mesma regra, dois lados da mesma
// fronteira — aqui valida argumento de linha de comando, lá valida ambiente, e
// as mensagens de erro precisam falar de coisas diferentes. Um quinto arquivo
// para 15 linhas custaria mais ao projeto do que a duplicação. Se a regra mudar
// num, mude no outro.
function num(valor: string, flag: string, min: number, max = ILIMITADO): number {
  const limpo = valor.trim();
  const n = Number(limpo);
  if (!/^\d+$/.test(limpo) || !Number.isSafeInteger(n) || n < min || n > max) {
    const faixa = max === ILIMITADO ? `um inteiro >= ${min}` : `um inteiro entre ${min} e ${max}`;
    process.stderr.write(`valor inválido para ${flag}: ${valor}\nEsperado ${faixa}.\n`);
    process.exit(1);
  }
  return n;
}

/* ---------- flags ---------- */

const argv = process.argv.slice(2);
const opts: Opts = { port: 3000, stunPort: 3478 };
let bg = false;
let stop = false;
let forcar = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  const proximo = (): string => {
    const v = argv[++i];
    if (v === undefined) {
      process.stderr.write(`${a} espera um valor\n`);
      process.exit(1);
    }
    return v;
  };
  if (a === "-h" || a === "--help") { process.stdout.write(ajuda() + "\n"); process.exit(0); }
  else if (a === "-v" || a === "--version") { process.stdout.write(versao() + "\n"); process.exit(0); }
  else if (a === "-p" || a === "--port") opts.port = num(proximo(), a, 1, 65535);
  else if (a === "--stun-port") opts.stunPort = num(proximo(), a, 1, 65535);
  else if (a === "--peers") opts.maxPeers = num(proximo(), a, 1);
  else if (a === "--sharers") opts.maxSharers = num(proximo(), a, 1);
  else if (a === "--pixels") opts.maxCapturePixels = num(proximo(), a, 1);
  else if (a === "--bg") bg = true;
  else if (a === "--stop") stop = true;
  else if (a === "--force") forcar = true;
  else {
    process.stderr.write(`flag desconhecida: ${a}\n\nRode com --help.\n`);
    process.exit(1);
  }
}

// Subir e encerrar são pedidos opostos. Antes o --stop vencia calado, o que
// deixa quem escreveu os dois achando que fez a outra coisa.
if (bg && stop) {
  process.stderr.write(`--bg e --stop pedem coisas opostas; use uma de cada vez.\n`);
  process.exit(1);
}

/* ---------- onde mora o estado ---------- */

/* O pidfile ficava solto em $TMPDIR, que é 1777: qualquer usuário da máquina
   podia plantar um screen-share-<porta>.pid, e o --stop obedecia — matando o
   processo que aquele número apontasse e reportando "encerrado". Sem atacante
   nenhum, o mesmo acontece por reciclagem de pid: um pidfile órfão depois de um
   reboot faz o --bg recusar ou o --stop acertar um processo alheio que herdou o
   número. O registro (e o log, que é do mesmo dono) passam a morar num
   diretório só nosso. */
function dirEstado(): string {
  const base = process.env.XDG_RUNTIME_DIR;
  const uid = typeof process.getuid === "function" ? process.getuid() : "sem-uid";
  const dir = base ? path.join(base, "screen-share") : path.join(tmpdir(), `screen-share-${uid}`);

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e: any) {
    process.stderr.write(`não consegui criar ${dir}: ${e?.message ?? e}\n`);
    process.exit(1);
  }

  // `recursive: true` não reclama de diretório que já existe nem corrige o modo
  // dele, então um diretório plantado antes, com 0777, passaria batido e o
  // isolamento seria só aparente. Conferir dono e permissão é o que torna a
  // garantia real; sem ela, recusar é melhor do que fingir.
  try {
    const st = statSync(dir);
    const alheio = typeof process.getuid === "function" && st.uid !== process.getuid();
    const frouxo = (st.mode & 0o077) !== 0;
    if (alheio || frouxo) {
      process.stderr.write(
        `${dir} não é privado: dono ${st.uid}, modo ${(st.mode & 0o777).toString(8)}.\n` +
        `Remova esse diretório e rode de novo.\n`
      );
      process.exit(1);
    }
  } catch (e: any) {
    process.stderr.write(`não consegui conferir ${dir}: ${e?.message ?? e}\n`);
    process.exit(1);
  }

  return dir;
}

/* Preparado sob demanda, não no carregamento do módulo. `dirEstado()` aborta
   quando o diretório de estado é de outra pessoa ou está com modo frouxo — o
   que é a decisão certa para --bg e --stop, que gravam ali, e a errada para uma
   subida em primeiro plano, que não toca no diretório e morria por causa dele.
   Reproduzido: `XDG_RUNTIME_DIR` frouxo derrubava `screen-share` sem nenhuma
   flag, por permissão de um caminho que aquela execução nunca usaria. */
let pidfile = "";
let logPath = "";
function prepararEstado() {
  const dir = dirEstado();
  pidfile = path.join(dir, `screen-share-${opts.port}.pid`);
  logPath = path.join(dir, `screen-share-${opts.port}.log`);
}

/** Pid registrado para esta porta, ou null se não há registro utilizável. */
function lerPid(): number | null {
  let bruto: string;
  try {
    bruto = readFileSync(pidfile, "utf8");
  } catch {
    // Ausente, diretório no lugar do arquivo (EISDIR virava stack trace), sem
    // permissão: para quem pergunta, os três casos são "não há registro".
    return null;
  }
  const limpo = bruto.trim();
  if (!/^\d+$/.test(limpo)) return null; // lixo é o mesmo que ausente
  const pid = Number(limpo);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/* Confirma que o pid é um servidor nosso antes de mandar sinal nele. O número
   pode ter sido plantado, ou só ter sobrado de antes de um reboot e já
   pertencer a outro processo. Em Linux o /proc responde a pergunta; onde ele
   não existe não há resposta, e a regra passa a ser não matar sem o usuário
   mandar. null = indecidível. */
function nosso(pid: number): boolean | null {
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    if (!existsSync("/proc")) return null; // plataforma sem /proc
    return false; // /proc existe e esse processo não, ou não é nosso de ler
  }
  return cmdline.split("\0").some((arg) => arg.endsWith("server.ts"));
}

/* Única forma de apagar o registro — havia três, duas com contratos opostos.
   Ausente é sucesso: quem chama quer o caminho livre, não o arquivo morto.
   Qualquer outra falha é fatal, porque o O_EXCL lá na frente esbarraria no
   EEXIST e o CLI subiria um servidor só para matá-lo em seguida.

   Não trata mais o caso de diretório plantado no lugar do arquivo: `dirEstado()`
   já garante um diretório 0700 de dono conferido, então plantar ali exigiria ser
   o próprio dono — que não precisa de armadilha para se sabotar. */
function limparRegistro() {
  try {
    unlinkSync(pidfile);
  } catch (e: any) {
    if (e?.code === "ENOENT") return;
    process.stderr.write(
      `não consegui limpar o registro em ${pidfile} (${e?.code}); remova-o à mão.\n`,
    );
    process.exit(1);
  }
}

function lerLog(): string {
  try {
    return readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

/* ---------- --stop ---------- */

if (stop) {
  prepararEstado();
  const pid = lerPid();
  if (pid === null) {
    process.stderr.write(`nada rodando em segundo plano na porta ${opts.port}\n`);
    process.exit(1);
  }

  const identidade = nosso(pid);
  if (identidade === false) {
    // Pid reciclado ou pidfile plantado; nos dois casos, matar seria acertar um
    // terceiro que não tem nada com isso.
    process.stdout.write(
      `o pid ${pid} registrado para a porta ${opts.port} não é um screen-share; não vou encerrá-lo.\n` +
      `Limpando o registro.\n`
    );
    limparRegistro();
    process.exit(0);
  }
  if (identidade === null && !forcar) {
    process.stderr.write(
      `não dá para confirmar que o pid ${pid} é um screen-share nesta plataforma (sem /proc).\n` +
      `Nada foi encerrado. Se tem certeza, repita com --force.\n`
    );
    process.exit(1);
  }

  try {
    process.kill(pid);
    process.stdout.write(`encerrado (pid ${pid})\n`);
  } catch {
    process.stdout.write(`pid ${pid} já não existia; limpando o registro\n`);
  }
  limparRegistro();
  process.exit(0);
}

/* ---------- ambiente do servidor ---------- */

// O server.ts lê tudo do ambiente. Passar por env em vez de argumento mantém
// `bun run server.ts` funcionando sozinho, sem o CLI no meio.
// Só o delta. Copiar `process.env` inteiro aqui e depois reescrevê-lo sobre si
// mesmo no caminho de primeiro plano custava ~228 setenv para mudar de duas a
// cinco variáveis.
const env: Record<string, string> = {
  PORT: String(opts.port),
  STUN_PORT: String(opts.stunPort),
};
if (opts.maxPeers) env.MAX_PEERS = String(opts.maxPeers);
if (opts.maxSharers) env.MAX_SHARERS = String(opts.maxSharers);
if (opts.maxCapturePixels) env.MAX_CAPTURE_PIXELS = String(opts.maxCapturePixels);

const alvoServidor = path.join(RAIZ, "server.ts");

/* ---------- --bg ---------- */

/* Camada 1 contra o sucesso falso do --bg: tentar bindar a porta aqui, antes de
   spawnar qualquer coisa. Uma sonda HTTP não serve de prova — quem já ocupa a
   porta responde /config exatamente igual, e comparar o stunPort da resposta
   compara a *configuração*, não o processo: outro screen-share com STUN padrão
   passa no teste. Bindar é a pergunta certa e a resposta é imediata. O socket é
   fechado antes do spawn; a janela que sobra entre fechar e o filho bindar é o
   que as camadas 2 e 3 cobrem. */
function sondarPorta(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "EDESCONHECIDO"));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(null)));
  });
}

/* A porta do STUN é UDP e é a outra metade da mesma pergunta. Sondar só a TCP
   deixava passar o caso mais provável de todos: duas instâncias, --port
   diferente e --stun-port igual, porque o padrão 3478 é um só. O filho morria
   de EADDRINUSE no dgram e a mensagem mandava trocar --port, que estava livre.
   O bind é em 0.0.0.0 porque é onde o stun.ts binda — sondar 127.0.0.1 não
   veria um ocupante preso a outra interface. */
function sondarUdp(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const s = createSocket("udp4");
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "EDESCONHECIDO"));
    s.bind(port, "0.0.0.0", () => s.close(() => resolve(null)));
  });
}

if (bg) {
  prepararEstado();
  // A sonda vem antes de mexer no pidfile e antes de abrir o log: assim o
  // perdedor de uma corrida não trunca o log do vencedor nem apaga o registro
  // dele, e sai com a mensagem certa em vez da cauda do log alheio.
  const falha = await sondarPorta(opts.port);
  if (falha) {
    const registrado = lerPid();
    const dica =
      registrado !== null && nosso(registrado) === true
        ? ` Parece ser o screen-share de pid ${registrado}: encerre com --stop --port ${opts.port}.`
        : "";
    process.stderr.write(
      falha === "EADDRINUSE"
        ? `a porta ${opts.port} já está ocupada.${dica}\nUse --port com outro número.\n`
        : `não consegui bindar a porta ${opts.port} (${falha}).\n`
    );
    process.exit(1);
  }

  // A outra metade da mesma pergunta. O --stun-port padrão é um só, então duas
  // instâncias com --port diferente colidem aqui e em nenhum outro lugar.
  const falhaUdp = await sondarUdp(opts.stunPort);
  if (falhaUdp) {
    process.stderr.write(
      falhaUdp === "EADDRINUSE"
        ? `a porta UDP ${opts.stunPort}, do STUN, já está ocupada.\n` +
          `Cada instância precisa da sua: use --stun-port com outro número.\n`
        : `não consegui bindar a porta UDP ${opts.stunPort} (${falhaUdp}).\n`
    );
    process.exit(1);
  }

  // Porta livre significa que qualquer pidfile desta porta está obsoleto: o
  // processo que ele aponta, se ainda existe, não está mais escutando aqui.
  limparRegistro();

  // stdio num arquivo, não em "ignore": sem isso um servidor que morre ao subir
  // morre sem deixar rastro, e o usuário fica com uma falha sem diagnóstico.
  //
  // Truncado a cada subida, não em append. Dois motivos: a camada 3 procura
  // EADDRINUSE neste log, e um EADDRINUSE de uma execução anterior faria uma
  // subida boa ser recusada; e um log que só descreve a execução corrente é o
  // que impede o banner de sucesso do vencedor de aparecer na cauda da
  // mensagem de erro do perdedor. Truncar sai mais barato que um log por
  // processo, que só teria nome depois do spawn e ainda espalharia arquivos.
  const log = openSync(logPath, "w", 0o600);

  let erroSpawn: NodeJS.ErrnoException | null = null;
  const filho = spawn(process.execPath, [alvoServidor], {
    env, detached: true, stdio: ["ignore", log, log],
  });
  // Sem este ouvinte, uma falha de spawn emite 'error' sem quem escute e derruba
  // o próprio CLI com um stack, antes de qualquer mensagem útil.
  filho.on("error", (e) => { erroSpawn = e as NodeJS.ErrnoException; });
  filho.unref();

  if (filho.pid === undefined) {
    closeSync(log);
    process.stderr.write(`não consegui iniciar ${process.execPath}\n`);
    process.exit(1);
  }
  const pid = filho.pid;

  const prazo = Date.now() + 8000;
  let pronto = false;
  let morreu = false;

  while (Date.now() < prazo) {
    if (erroSpawn) break;

    // A checagem de vida vem antes do fetch. Ela não prova que o filho bindou —
    // nos primeiros 200–300 ms ele está vivo por ainda estar carregando —, mas
    // prova o contrário quando falha, e é isso que corta a espera cedo.
    try { process.kill(pid, 0); } catch { morreu = true; break; }

    try {
      const r = await fetch(`http://127.0.0.1:${opts.port}/config`, {
        signal: AbortSignal.timeout(500),
      });
      // Só prontidão, nunca identidade: /config respondido não diz quem
      // respondeu. Quem decide que o servidor é o nosso são as camadas 1 a 3.
      if (r.ok) { pronto = true; break; }
    } catch {}

    await new Promise((r) => setTimeout(r, 150));
  }

  // Camada 2: o EADDRINUSE mata o filho em ~300 ms, e no começo ele está vivo
  // por estar carregando, não por ter bindado. Meio segundo depois de a sonda
  // passar, "continua vivo?" já significa o que parece significar.
  if (pronto) {
    await new Promise((r) => setTimeout(r, 500));
    try { process.kill(pid, 0); } catch { pronto = false; morreu = true; }
  }

  // Camada 3: mesmo vivo, se o log dele acusa EADDRINUSE então quem respondeu a
  // sonda não era ele.
  if (pronto && lerLog().includes("EADDRINUSE")) {
    pronto = false;
    morreu = true;
  }

  if (!pronto) {
    try { process.kill(pid); } catch {}
    const cauda = lerLog().trimEnd().split("\n").slice(-8).join("\n");
    process.stderr.write(
      erroSpawn
        ? `não consegui iniciar o servidor: ${erroSpawn.message}\n`
        : morreu
          ? `o servidor morreu ao subir na porta ${opts.port}.\n` +
            (cauda ? `\n${cauda}\n\n` : "") +
            `Porta ocupada? Tente --port com outro número.\n`
          : `o servidor não respondeu em 8s na porta ${opts.port}.\n` +
            (cauda ? `\n${cauda}\n\n` : "") +
            `Log completo em ${logPath}\n`
    );
    process.exit(1);
  }

  // Só agora o registro passa a existir, e criado com O_EXCL e 0600: o arquivo é
  // nosso ou não é usado, e ninguém mais na máquina o reescreve.
  try {
    const fd = openSync(pidfile, "wx", 0o600);
    writeSync(fd, String(pid));
    closeSync(fd);
  } catch (e: any) {
    // Alguém registrou esta porta entre a sonda e agora. Deixar o filho de pé
    // sem caminho de --stop seria criar exatamente o órfão que tudo isto existe
    // para evitar.
    try { process.kill(pid); } catch {}
    process.stderr.write(
      `outro processo registrou a porta ${opts.port} enquanto o servidor subia (${e?.code ?? e}).\n` +
      `O servidor que eu tinha subido foi encerrado. Tente de novo.\n`
    );
    process.exit(1);
  }

  process.stdout.write(
    `screen-share em segundo plano\n` +
    `  http        http://localhost:${opts.port}\n` +
    `  stun  udp   :${opts.stunPort}\n` +
    `  pid         ${pid}\n\n` +
    `Encerrar: bunx @thoth-dev/screen-share --stop --port ${opts.port}\n`
  );
  process.exit(0);
}

/* ---------- primeiro plano ---------- */

Object.assign(process.env, env);
// pathToFileURL, não o caminho cru: import() de caminho absoluto funciona no
// Bun sobre POSIX e é acidente, não contrato — a forma portátil é uma URL.
await import(pathToFileURL(alvoServidor).href);

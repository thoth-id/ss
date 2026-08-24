#!/usr/bin/env bun
/* CLI do screen-share.

   O shebang é bun, não node: o servidor usa Bun.serve para o WebSocket e não
   há equivalente em Node. Quem rodar `npx screen-share` sem Bun instalado
   recebe `env: bun: No such file or directory` — seco, mas nomeia o que
   falta. O comando documentado é `bunx screen-share`.

   Nada aqui é lógica de servidor: isto lê flags, decide primeiro plano ou
   segundo, e entrega o resto ao server.ts. */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Opts = {
  port: number;
  stunPort: number;
  maxPeers?: number;
  maxSharers?: number;
  maxCapturePixels?: number;
};

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSAO: string = JSON.parse(readFileSync(path.join(RAIZ, "package.json"), "utf8")).version;

const AJUDA = `screen-share ${VERSAO} — compartilhamento de tela P2P, sem conta e sem servidor de mídia

  bunx screen-share [flags]

  -p, --port <n>       porta HTTP (padrão 3000)
      --stun-port <n>  porta UDP do STUN (padrão 3478)
      --peers <n>      teto de peers por sala (padrão 5)
      --sharers <n>    quantos transmitem ao mesmo tempo (padrão 3)
      --pixels <n>     teto de pixels da captura (padrão 1440000, = 1600×900)
      --bg             sobe em segundo plano
      --stop           encerra o que está em segundo plano
  -h, --help
  -v, --version

  O servidor nunca toca na mídia: serve os estáticos, repassa o signaling e
  responde STUN. O vídeo vai direto de um navegador ao outro.

  Não há autenticação, e isso é deliberado. Quem alcança a porta entra na
  sala. Use dentro de um tailnet, uma VPN ou uma rede em que você confia —
  nunca exposto à internet aberta.

  Compartilhar tela exige contexto seguro: localhost funciona, IP puro não.
  Para outras máquinas, ponha HTTPS na frente (ex.: tailscale serve --bg 3000).`;

function num(valor: string, flag: string): number {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) {
    process.stderr.write(`valor inválido para ${flag}: ${valor}\n`);
    process.exit(1);
  }
  return n;
}

/* ---------- flags ---------- */

const argv = process.argv.slice(2);
const opts: Opts = { port: 3000, stunPort: 3478 };
let bg = false;
let stop = false;

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
  if (a === "-h" || a === "--help") { process.stdout.write(AJUDA + "\n"); process.exit(0); }
  else if (a === "-v" || a === "--version") { process.stdout.write(VERSAO + "\n"); process.exit(0); }
  else if (a === "-p" || a === "--port") opts.port = num(proximo(), a);
  else if (a === "--stun-port") opts.stunPort = num(proximo(), a);
  else if (a === "--peers") opts.maxPeers = num(proximo(), a);
  else if (a === "--sharers") opts.maxSharers = num(proximo(), a);
  else if (a === "--pixels") opts.maxCapturePixels = num(proximo(), a);
  else if (a === "--bg") bg = true;
  else if (a === "--stop") stop = true;
  else {
    process.stderr.write(`flag desconhecida: ${a}\n\nRode com --help.\n`);
    process.exit(1);
  }
}

const pidfile = path.join(tmpdir(), `screen-share-${opts.port}.pid`);

/* ---------- --stop ---------- */

if (stop) {
  if (!existsSync(pidfile)) {
    process.stderr.write(`nada rodando em segundo plano na porta ${opts.port}\n`);
    process.exit(1);
  }
  const pid = Number(readFileSync(pidfile, "utf8").trim());
  try {
    process.kill(pid);
    process.stdout.write(`encerrado (pid ${pid})\n`);
  } catch {
    process.stdout.write(`pid ${pid} já não existia; limpando o registro\n`);
  }
  try { unlinkSync(pidfile); } catch {}
  process.exit(0);
}

/* ---------- ambiente do servidor ---------- */

// O server.ts lê tudo do ambiente. Passar por env em vez de argumento mantém
// `bun run server.ts` funcionando sozinho, sem o CLI no meio.
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  PORT: String(opts.port),
  STUN_PORT: String(opts.stunPort),
};
if (opts.maxPeers) env.MAX_PEERS = String(opts.maxPeers);
if (opts.maxSharers) env.MAX_SHARERS = String(opts.maxSharers);
if (opts.maxCapturePixels) env.MAX_CAPTURE_PIXELS = String(opts.maxCapturePixels);

const alvoServidor = path.join(RAIZ, "server.ts");

/* ---------- --bg ---------- */

if (bg) {
  if (existsSync(pidfile)) {
    const antigo = Number(readFileSync(pidfile, "utf8").trim());
    let vivo = false;
    try { process.kill(antigo, 0); vivo = true; } catch {}
    if (vivo) {
      process.stderr.write(`já há um screen-share na porta ${opts.port} (pid ${antigo})\n`);
      process.exit(1);
    }
    try { unlinkSync(pidfile); } catch {}
  }

  // stdio num arquivo, não em "ignore": sem isso um servidor que morre ao subir
  // morre sem deixar rastro, e o usuário fica com uma falha sem diagnóstico.
  const logPath = path.join(tmpdir(), `screen-share-${opts.port}.log`);
  const log = openSync(logPath, "a");

  const filho = spawn(process.execPath, [alvoServidor], {
    env, detached: true, stdio: ["ignore", log, log],
  });
  filho.unref();

  // Não basta ter spawnado: porta ocupada mata o processo logo depois, e
  // reportar sucesso aí seria mentir.
  const prazo = Date.now() + 8000;
  let pronto = false;
  let morreu = false;

  while (Date.now() < prazo) {
    // A checagem de vida vem ANTES do fetch, e não depois. Quem já ocupa a
    // porta também responde 200, então uma sonda que só olha o HTTP dá o
    // servidor como pronto enquanto o nosso processo já morreu de EADDRINUSE.
    // Vivo aqui significa que ele bindou: o Bun.serve teria lançado, se não.
    try { process.kill(filho.pid!, 0); } catch { morreu = true; break; }

    try {
      const r = await fetch(`http://127.0.0.1:${opts.port}/config`, {
        signal: AbortSignal.timeout(500),
      });
      if (r.ok) {
        const cfg = (await r.json()) as { stunPort?: number };
        if (cfg.stunPort === opts.stunPort) { pronto = true; break; }
      }
    } catch {}

    await new Promise((r) => setTimeout(r, 150));
  }

  if (!pronto) {
    try { process.kill(filho.pid!); } catch {}
    let cauda = "";
    try {
      cauda = readFileSync(logPath, "utf8").trimEnd().split("\n").slice(-8).join("\n");
    } catch {}
    process.stderr.write(
      morreu
        ? `o servidor morreu ao subir na porta ${opts.port}.\n` +
          (cauda ? `\n${cauda}\n\n` : "") +
          `Porta ocupada? Tente --port com outro número.\n`
        : `o servidor não respondeu em 8s na porta ${opts.port}.\n` +
          (cauda ? `\n${cauda}\n\n` : "") +
          `Log completo em ${logPath}\n`
    );
    process.exit(1);
  }

  writeFileSync(pidfile, String(filho.pid));
  process.stdout.write(
    `screen-share em segundo plano\n` +
    `  http        http://localhost:${opts.port}\n` +
    `  stun  udp   :${opts.stunPort}\n` +
    `  pid         ${filho.pid}\n\n` +
    `Encerrar: bunx screen-share --stop --port ${opts.port}\n`
  );
  process.exit(0);
}

/* ---------- primeiro plano ---------- */

for (const [k, v] of Object.entries(env)) process.env[k] = v;
await import(alvoServidor);

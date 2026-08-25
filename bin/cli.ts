#!/usr/bin/env bun
/* ss command line.

   the shebang is bun, not node: the server uses Bun.serve for the signaling
   WebSocket and there is no equivalent in Node. that is also why this file is
   no longer the package `bin`: with it there, anyone running
   `npx @thoth-dev/screen-share` without Bun died inside `env`, before a single
   line of ours ran. screen-share.mjs is the entry point now, and running
   `bun bin/cli.ts` by hand is unchanged.

   no server logic here: this reads flags, decides foreground or background,
   and hands the rest to server.ts. */

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

const RAIZ = path.join(import.meta.dir, "..");

// read on demand: every `screen-share --bg` used to pay a readFileSync plus a
// JSON.parse for a version only --help and --version ask for.
const versao = (): string =>
  JSON.parse(readFileSync(path.join(RAIZ, "package.json"), "utf8")).version;

const ajuda = () => `ss ${versao()} - peer-to-peer screen sharing, no account and no media server

  bunx @thoth-dev/screen-share [flags]

  -p, --port <n>       HTTP port (default 3000)
      --stun-port <n>  STUN UDP port (default 3478). a second instance needs
                       this one different TOO, not just --port
      --peers <n>      peers per room (default 5)
      --sharers <n>    how many transmit at once (default 3)
      --pixels <n>     capture pixel budget (default 1440000, = 1600×900)
      --bg             run in the background
      --stop           stop what runs in the background
      --force          with --stop, kill even when the process cannot be confirmed
  -h, --help
  -v, --version

  the server never touches the media: it serves the static files, relays the
  signaling and answers STUN. the video goes straight from one browser to
  the other.

  there is no authentication, and that is deliberate. whoever reaches the port
  joins the room. use it inside a tailnet, a VPN or a network you trust, never
  exposed to the open internet.

  sharing a screen requires a secure context: localhost works, a bare IP does
  not. for other machines put HTTPS in front (tailscale serve --bg 3000).`;

const ILIMITADO = Number.MAX_SAFE_INTEGER;

/* an integer, and inside the range where it means something. Number() alone
   accepts " 0x10 " (as 16), "1e3" and "2.5", none of them an integer written as
   an integer, hence the digit regex. the range matters just as much: `--port
   99999` used to pass, Bun clamped it to 65535, and the banner announced a port
   nobody listened on while the pidfile was keyed by the impossible number. */
// twin of `int()` in server.ts, on purpose: same rule, two sides of the same
// boundary. here it validates a command-line argument, there the environment,
// and the error messages have to talk about different things. a fifth file for
// 15 lines would cost the project more than the duplication. if the rule
// changes in one, change the other.
function num(valor: string, flag: string, min: number, max = ILIMITADO): number {
  const limpo = valor.trim();
  const n = Number(limpo);
  if (!/^\d+$/.test(limpo) || !Number.isSafeInteger(n) || n < min || n > max) {
    const faixa = max === ILIMITADO ? `an integer >= ${min}` : `an integer between ${min} and ${max}`;
    process.stderr.write(`invalid value for ${flag}: ${valor}\nExpected ${faixa}.\n`);
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
      process.stderr.write(`${a} expects a value\n`);
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
    process.stderr.write(`unknown flag: ${a}\n\nRun with --help.\n`);
    process.exit(1);
  }
}

// starting and stopping are opposite requests. --stop used to win silently,
// which leaves whoever typed both thinking they did the other thing.
if (bg && stop) {
  process.stderr.write(`--bg and --stop ask for opposite things; use one at a time.\n`);
  process.exit(1);
}

/* ---------- where the state lives ---------- */

/* the pidfile used to sit loose in $TMPDIR, which is 1777: any user on the
   machine could plant a screen-share-<port>.pid and --stop would obey, killing
   whatever that number pointed at and reporting success. with no attacker at
   all, pid recycling does the same: an orphan pidfile after a reboot makes --bg
   refuse or --stop hit an unrelated process that inherited the number. */
function dirEstado(): string {
  const base = process.env.XDG_RUNTIME_DIR;
  const uid = typeof process.getuid === "function" ? process.getuid() : "no-uid";
  const dir = base ? path.join(base, "screen-share") : path.join(tmpdir(), `screen-share-${uid}`);

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e: any) {
    process.stderr.write(`could not create ${dir}: ${e?.message ?? e}\n`);
    process.exit(1);
  }

  // `recursive: true` neither complains about an existing directory nor fixes
  // its mode, so one planted earlier with 0777 would pass and the isolation
  // would only look real. checking owner and permission is what makes the
  // guarantee true; without it, refusing beats pretending.
  try {
    const st = statSync(dir);
    const alheio = typeof process.getuid === "function" && st.uid !== process.getuid();
    const frouxo = (st.mode & 0o077) !== 0;
    if (alheio || frouxo) {
      process.stderr.write(
        `${dir} is not private: owner ${st.uid}, mode ${(st.mode & 0o777).toString(8)}.\n` +
        `Remove that directory and try again.\n`
      );
      process.exit(1);
    }
  } catch (e: any) {
    process.stderr.write(`could not check ${dir}: ${e?.message ?? e}\n`);
    process.exit(1);
  }

  return dir;
}

/* prepared on demand, not at module load. `dirEstado()` aborts when the state
   directory belongs to somebody else or has a loose mode, which is the right
   call for --bg and --stop, which write there, and the wrong one for a
   foreground run, which never touches it. reproduced: a loose XDG_RUNTIME_DIR
   killed a plain `screen-share` over a path that run would never use. */
let pidfile = "";
let logPath = "";
function prepararEstado() {
  const dir = dirEstado();
  pidfile = path.join(dir, `screen-share-${opts.port}.pid`);
  logPath = path.join(dir, `screen-share-${opts.port}.log`);
}

/** pid registered for this port, or null if there is no usable record. */
function lerPid(): number | null {
  let bruto: string;
  try {
    bruto = readFileSync(pidfile, "utf8");
  } catch {
    // absent, a directory where the file should be (EISDIR became a stack
    // trace), no permission: to the caller all three are "no record".
    return null;
  }
  const limpo = bruto.trim();
  if (!/^\d+$/.test(limpo)) return null; // garbage is the same as absent
  const pid = Number(limpo);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/* confirms the pid is one of our servers before signalling it. the number may
   have been planted, or just left over from before a reboot and now belong to
   something else. on Linux /proc answers that; where it does not exist there is
   no answer, and the rule becomes do not kill without being told to.
   null = undecidable. */
function nosso(pid: number): boolean | null {
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    if (!existsSync("/proc")) return null; // platform without /proc
    return false; // /proc exists and that process does not, or is not ours
  }
  return cmdline.split("\0").some((arg) => arg.endsWith("server.ts"));
}

/* the only way to erase the record; there were three, two with opposite
   contracts. absent counts as success: the caller wants the path free, not the
   file dead. any other failure is fatal, because the O_EXCL further down would
   hit EEXIST and the CLI would start a server only to kill it. */
function limparRegistro() {
  try {
    unlinkSync(pidfile);
  } catch (e: any) {
    if (e?.code === "ENOENT") return;
    process.stderr.write(
      `could not clear the record at ${pidfile} (${e?.code}); remove it by hand.\n`,
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
    process.stderr.write(`nothing running in the background on port ${opts.port}\n`);
    process.exit(1);
  }

  const identidade = nosso(pid);
  if (identidade === false) {
    // recycled pid or planted pidfile; either way, killing would hit a third
    // party with nothing to do with this.
    process.stdout.write(
      `pid ${pid} registered for port ${opts.port} is not an ss server; leaving it alone.\n` +
      `Clearing the record.\n`
    );
    limparRegistro();
    process.exit(0);
  }
  if (identidade === null && !forcar) {
    process.stderr.write(
      `cannot confirm that pid ${pid} is an ss server on this platform (no /proc).\n` +
      `Nothing was stopped. If you are sure, repeat with --force.\n`
    );
    process.exit(1);
  }

  try {
    process.kill(pid);
    process.stdout.write(`stopped (pid ${pid})\n`);
  } catch {
    process.stdout.write(`pid ${pid} was already gone; clearing the record\n`);
  }
  limparRegistro();
  process.exit(0);
}

/* ---------- server environment ---------- */

// server.ts reads everything from the environment. going through env instead of
// arguments keeps `bun run server.ts` working on its own, with no CLI in the
// loop. only the delta: copying all of process.env here and rewriting it over
// itself in the foreground path cost ~228 setenv calls to change two to five.
const env: Record<string, string> = {
  PORT: String(opts.port),
  STUN_PORT: String(opts.stunPort),
};
if (opts.maxPeers) env.MAX_PEERS = String(opts.maxPeers);
if (opts.maxSharers) env.MAX_SHARERS = String(opts.maxSharers);
if (opts.maxCapturePixels) env.MAX_CAPTURE_PIXELS = String(opts.maxCapturePixels);

const alvoServidor = path.join(RAIZ, "server.ts");

/* ---------- --bg ---------- */

/* layer 1 against a false success: bind the port here, before spawning
   anything. an HTTP probe proves nothing, since whoever already holds the port
   answers /config identically, and comparing the stunPort in that answer
   compares the *configuration*, not the process. binding is the right question
   and the answer is immediate. the socket is closed before the spawn; layers 2
   and 3 cover the window between closing it and the child binding. */
function sondarPorta(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "EUNKNOWN"));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(null)));
  });
}

/* the STUN port is UDP and the other half of the same question. probing only
   TCP let the likeliest case through: two instances, different --port, same
   --stun-port, because the 3478 default is one number. the child died of
   EADDRINUSE in dgram and the message told the user to change --port, which was
   free. the bind is on 0.0.0.0 because that is where stun.ts binds. */
function sondarUdp(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const s = createSocket("udp4");
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "EUNKNOWN"));
    s.bind(port, "0.0.0.0", () => s.close(() => resolve(null)));
  });
}

if (bg) {
  prepararEstado();
  // the probe comes before touching the pidfile and before opening the log, so
  // the loser of a race truncates neither the winner's log nor its record, and
  // exits with its own message instead of the tail of somebody else's.
  const falha = await sondarPorta(opts.port);
  if (falha) {
    const registrado = lerPid();
    const dica =
      registrado !== null && nosso(registrado) === true
        ? ` Looks like the ss server at pid ${registrado}: stop it with --stop --port ${opts.port}.`
        : "";
    process.stderr.write(
      falha === "EADDRINUSE"
        ? `port ${opts.port} is already taken.${dica}\nUse --port with another number.\n`
        : `could not bind port ${opts.port} (${falha}).\n`
    );
    process.exit(1);
  }

  const falhaUdp = await sondarUdp(opts.stunPort);
  if (falhaUdp) {
    process.stderr.write(
      falhaUdp === "EADDRINUSE"
        ? `the STUN UDP port ${opts.stunPort} is already taken.\n` +
          `Each instance needs its own: use --stun-port with another number.\n`
        : `could not bind UDP port ${opts.stunPort} (${falhaUdp}).\n`
    );
    process.exit(1);
  }

  // a free port means any pidfile for it is stale: the process it names, if it
  // still exists, is no longer listening here.
  limparRegistro();

  // stdio to a file, not "ignore": without this a server that dies on startup
  // dies without a trace, and the user is left with a failure and no diagnosis.
  //
  // truncated on every start, not appended. layer 3 greps this log for
  // EADDRINUSE, and one from an earlier run would make a good start be refused;
  // and a log that only describes the current run is what keeps the winner's
  // success banner out of the tail of the loser's error.
  const log = openSync(logPath, "w", 0o600);

  let erroSpawn: NodeJS.ErrnoException | null = null;
  const filho = spawn(process.execPath, [alvoServidor], {
    env, detached: true, stdio: ["ignore", log, log],
  });
  // without this listener a spawn failure emits 'error' with nobody listening
  // and takes the CLI down with a stack, before any useful message.
  filho.on("error", (e) => { erroSpawn = e as NodeJS.ErrnoException; });
  filho.unref();

  if (filho.pid === undefined) {
    closeSync(log);
    process.stderr.write(`could not start ${process.execPath}\n`);
    process.exit(1);
  }
  const pid = filho.pid;

  const prazo = Date.now() + 8000;
  let pronto = false;
  let morreu = false;

  while (Date.now() < prazo) {
    if (erroSpawn) break;

    // the liveness check comes before the fetch. it does not prove the child
    // bound the port, since for the first 200-300 ms it is alive merely because
    // it is still loading, but it proves the opposite when it fails, and that
    // is what cuts the wait short.
    try { process.kill(pid, 0); } catch { morreu = true; break; }

    try {
      const r = await fetch(`http://127.0.0.1:${opts.port}/config`, {
        signal: AbortSignal.timeout(500),
      });
      // readiness only, never identity: /config answering does not say who
      // answered. layers 1 to 3 are what decide the server is ours.
      if (r.ok) { pronto = true; break; }
    } catch {}

    await new Promise((r) => setTimeout(r, 150));
  }

  // layer 2: EADDRINUSE kills the child in ~300 ms, and early on it is alive
  // because it is loading, not because it bound. half a second after the probe
  // passes, "still alive?" means what it looks like it means.
  if (pronto) {
    await new Promise((r) => setTimeout(r, 500));
    try { process.kill(pid, 0); } catch { pronto = false; morreu = true; }
  }

  // layer 3: alive or not, if its log shows EADDRINUSE then whoever answered
  // the probe was not it.
  if (pronto && lerLog().includes("EADDRINUSE")) {
    pronto = false;
    morreu = true;
  }

  if (!pronto) {
    try { process.kill(pid); } catch {}
    const cauda = lerLog().trimEnd().split("\n").slice(-8).join("\n");
    process.stderr.write(
      erroSpawn
        ? `could not start the server: ${erroSpawn.message}\n`
        : morreu
          ? `the server died starting up on port ${opts.port}.\n` +
            (cauda ? `\n${cauda}\n\n` : "") +
            `Port taken? Try --port with another number.\n`
          : `the server did not answer within 8s on port ${opts.port}.\n` +
            (cauda ? `\n${cauda}\n\n` : "") +
            `Full log at ${logPath}\n`
    );
    process.exit(1);
  }

  // only now does the record exist, created with O_EXCL and 0600: the file is
  // ours or it is not used, and nobody else on the machine rewrites it.
  try {
    const fd = openSync(pidfile, "wx", 0o600);
    writeSync(fd, String(pid));
    closeSync(fd);
  } catch (e: any) {
    // somebody registered this port between the probe and now. leaving the
    // child up with no --stop path would create exactly the orphan all of this
    // exists to prevent.
    try { process.kill(pid); } catch {}
    process.stderr.write(
      `another process registered port ${opts.port} while the server was starting (${e?.code ?? e}).\n` +
      `The server I had started was stopped. Try again.\n`
    );
    process.exit(1);
  }

  process.stdout.write(
    `ss ${versao()}  ·  background\n` +
    `  http        http://localhost:${opts.port}\n` +
    `  stun  udp   :${opts.stunPort}\n` +
    `  pid         ${pid}\n\n` +
    `Stop it: bunx @thoth-dev/screen-share --stop --port ${opts.port}\n`
  );
  process.exit(0);
}

/* ---------- foreground ---------- */

Object.assign(process.env, env);
// pathToFileURL, not the raw path: import() of an absolute path works in Bun on
// POSIX by accident, not by contract. the portable form is a URL.
await import(pathToFileURL(alvoServidor).href);

#!/usr/bin/env bun
/* tailcast command line.

   the shebang is bun, not node: the server uses Bun.serve for the signaling
   WebSocket and there is no equivalent in Node. that is also why this file is
   no longer the package `bin`: with it there, anyone running
   `npx @thoth-dev/screen-share` without Bun died inside `env`, before a single
   line of ours ran. screen-share.mjs is the entry point now, and running
   `bun bin/cli.ts` by hand is unchanged.

   no server logic here: this reads flags, decides foreground or background,
   and hands the rest to server.ts. */

import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
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

const ROOT = path.join(import.meta.dir, "..");

// read on demand: every `screen-share --bg` used to pay a readFileSync plus a
// JSON.parse for a version only --help and --version ask for.
const getVersion = (): string =>
	JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const CAT = [
	"  ,-.       _,---._ __  / \\",
	" /  )    .-'       `./ /   \\",
	"(  (   ,'            `/    /|",
	" \\  `-\"             \\'\\   / |",
	"  `.              ,  \\ \\ /  |",
	"   /`.          ,'-`----Y   |",
	"  (            ;        |   '",
	"  |  ,-.    ,-'         |  /",
	"  |  | (   |            | /",
	"  )  |  \\  `.___________|/",
	"  `--'   `--'",
].join("\n");

const helpText =
	() => `${CAT}\n\ntailcast ${getVersion()} - peer-to-peer screen sharing, no account and no media server

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

const UNLIMITED = Number.MAX_SAFE_INTEGER;

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
function parseNumber(value: string, flag: string, min: number, max = UNLIMITED): number {
	const trimmed = value.trim();
	const n = Number(trimmed);
	if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(n) || n < min || n > max) {
		const range =
			max === UNLIMITED ? `an integer >= ${min}` : `an integer between ${min} and ${max}`;
		process.stderr.write(`invalid value for ${flag}: ${value}\nExpected ${range}.\n`);
		process.exit(1);
	}
	return n;
}

/* ---------- flags ---------- */

const argv = process.argv.slice(2);
const opts: Opts = { port: 3000, stunPort: 3478 };
let bg = false;
let stop = false;
let force = false;

for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === undefined) continue;
	const nextValue = (): string => {
		const v = argv[++i];
		if (v === undefined) {
			process.stderr.write(`${a} expects a value\n`);
			process.exit(1);
		}
		return v;
	};
	if (a === "-h" || a === "--help") {
		process.stdout.write(`${helpText()}\n`);
		process.exit(0);
	} else if (a === "-v" || a === "--version") {
		process.stdout.write(`${getVersion()}\n`);
		process.exit(0);
	} else if (a === "-p" || a === "--port") opts.port = parseNumber(nextValue(), a, 1, 65535);
	else if (a === "--stun-port") opts.stunPort = parseNumber(nextValue(), a, 1, 65535);
	else if (a === "--peers") opts.maxPeers = parseNumber(nextValue(), a, 1);
	else if (a === "--sharers") opts.maxSharers = parseNumber(nextValue(), a, 1);
	else if (a === "--pixels") opts.maxCapturePixels = parseNumber(nextValue(), a, 1);
	else if (a === "--bg") bg = true;
	else if (a === "--stop") stop = true;
	else if (a === "--force") force = true;
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
function getStateDir(): string {
	const base = process.env.XDG_RUNTIME_DIR;
	const uid = typeof process.getuid === "function" ? process.getuid() : "no-uid";
	const dir = base ? path.join(base, "screen-share") : path.join(tmpdir(), `screen-share-${uid}`);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : String(e);
		process.stderr.write(`could not create ${dir}: ${message}\n`);
		process.exit(1);
	}

	// `recursive: true` neither complains about an existing directory nor fixes
	// its mode, so one planted earlier with 0777 would pass and the isolation
	// would only look real. checking owner and permission is what makes the
	// guarantee true; without it, refusing beats pretending.
	try {
		const st = statSync(dir);
		const ownedByOther = typeof process.getuid === "function" && st.uid !== process.getuid();
		const tooPermissive = (st.mode & 0o077) !== 0;
		if (ownedByOther || tooPermissive) {
			process.stderr.write(
				`${dir} is not private: owner ${st.uid}, mode ${(st.mode & 0o777).toString(8)}.\n` +
					`Remove that directory and try again.\n`,
			);
			process.exit(1);
		}
	} catch (e: unknown) {
		const message = e instanceof Error ? e.message : String(e);
		process.stderr.write(`could not check ${dir}: ${message}\n`);
		process.exit(1);
	}

	return dir;
}

/* prepared on demand, not at module load. `getStateDir()` aborts when the state
   directory belongs to somebody else or has a loose mode, which is the right
   call for --bg and --stop, which write there, and the wrong one for a
   foreground run, which never touches it. reproduced: a loose XDG_RUNTIME_DIR
   killed a plain `screen-share` over a path that run would never use. */
let pidfile = "";
let logPath = "";
function prepareState() {
	const dir = getStateDir();
	pidfile = path.join(dir, `screen-share-${opts.port}.pid`);
	logPath = path.join(dir, `screen-share-${opts.port}.log`);
}

/** pid registered for this port, or null if there is no usable record. */
function readPid(): number | null {
	let raw: string;
	try {
		raw = readFileSync(pidfile, "utf8");
	} catch {
		// absent, a directory where the file should be (EISDIR became a stack
		// trace), no permission: to the caller all three are "no record".
		return null;
	}
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null; // garbage is the same as absent
	const pid = Number(trimmed);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/* confirms the pid is one of our servers before signalling it. the number may
   have been planted, or just left over from before a reboot and now belong to
   something else. on Linux /proc answers that; where it does not exist there is
   no answer, and the rule becomes do not kill without being told to.
   null = undecidable. */
function isOurServer(pid: number): boolean | null {
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
function clearRecord() {
	try {
		unlinkSync(pidfile);
	} catch (e: unknown) {
		let code: unknown;
		if (e !== null && typeof e === "object" && "code" in e) {
			code = e.code;
		}
		if (code === "ENOENT") return;
		process.stderr.write(
			`could not clear the record at ${pidfile} (${code}); remove it by hand.\n`,
		);
		process.exit(1);
	}
}

function readLog(): string {
	try {
		return readFileSync(logPath, "utf8");
	} catch {
		return "";
	}
}

/* ---------- --stop ---------- */

if (stop) {
	prepareState();
	const pid = readPid();
	if (pid === null) {
		process.stderr.write(`nothing running in the background on port ${opts.port}\n`);
		process.exit(1);
	}

	const identity = isOurServer(pid);
	if (identity === false) {
		// recycled pid or planted pidfile; either way, killing would hit a third
		// party with nothing to do with this.
		process.stdout.write(
			`pid ${pid} registered for port ${opts.port} is not a tailcast server; leaving it alone.\n` +
				`Clearing the record.\n`,
		);
		clearRecord();
		process.exit(0);
	}
	if (identity === null && !force) {
		process.stderr.write(
			`cannot confirm that pid ${pid} is a tailcast server on this platform (no /proc).\n` +
				`Nothing was stopped. If you are sure, repeat with --force.\n`,
		);
		process.exit(1);
	}

	try {
		process.kill(pid);
		process.stdout.write(`stopped (pid ${pid})\n`);
	} catch {
		process.stdout.write(`pid ${pid} was already gone; clearing the record\n`);
	}
	clearRecord();
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

const serverTarget = path.join(ROOT, "server.ts");

/* ---------- --bg ---------- */

/* layer 1 against a false success: bind the port here, before spawning
   anything. an HTTP probe proves nothing, since whoever already holds the port
   answers /config identically, and comparing the stunPort in that answer
   compares the *configuration*, not the process. binding is the right question
   and the answer is immediate. the socket is closed before the spawn; layers 2
   and 3 cover the window between closing it and the child binding. */
function probePort(port: number): Promise<string | null> {
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
function probeUdp(port: number): Promise<string | null> {
	return new Promise((resolve) => {
		const s = createSocket("udp4");
		s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "EUNKNOWN"));
		s.bind(port, "0.0.0.0", () => s.close(() => resolve(null)));
	});
}

if (bg) {
	prepareState();
	// the probe comes before touching the pidfile and before opening the log, so
	// the loser of a race truncates neither the winner's log nor its record, and
	// exits with its own message instead of the tail of somebody else's.
	const portError = await probePort(opts.port);
	if (portError) {
		const registered = readPid();
		const hint =
			registered !== null && isOurServer(registered) === true
				? ` Looks like the tailcast server at pid ${registered}: stop it with --stop --port ${opts.port}.`
				: "";
		process.stderr.write(
			portError === "EADDRINUSE"
				? `port ${opts.port} is already taken.${hint}\nUse --port with another number.\n`
				: `could not bind port ${opts.port} (${portError}).\n`,
		);
		process.exit(1);
	}

	const udpError = await probeUdp(opts.stunPort);
	if (udpError) {
		process.stderr.write(
			udpError === "EADDRINUSE"
				? `the STUN UDP port ${opts.stunPort} is already taken.\n` +
						`Each instance needs its own: use --stun-port with another number.\n`
				: `could not bind UDP port ${opts.stunPort} (${udpError}).\n`,
		);
		process.exit(1);
	}

	// a free port means any pidfile for it is stale: the process it names, if it
	// still exists, is no longer listening here.
	clearRecord();

	// stdio to a file, not "ignore": without this a server that dies on startup
	// dies without a trace, and the user is left with a failure and no diagnosis.
	//
	// truncated on every start, not appended. layer 3 greps this log for
	// EADDRINUSE, and one from an earlier run would make a good start be refused;
	// and a log that only describes the current run is what keeps the winner's
	// success banner out of the tail of the loser's error.
	const log = openSync(logPath, "w", 0o600);

	let spawnError: NodeJS.ErrnoException | null = null;
	const child = spawn(process.execPath, [serverTarget], {
		env,
		detached: true,
		stdio: ["ignore", log, log],
	});
	// without this listener a spawn failure emits 'error' with nobody listening
	// and takes the CLI down with a stack, before any useful message.
	child.on("error", (e) => {
		spawnError = e as NodeJS.ErrnoException;
	});
	child.unref();

	if (child.pid === undefined) {
		closeSync(log);
		process.stderr.write(`could not start ${process.execPath}\n`);
		process.exit(1);
	}
	const pid = child.pid;
	const deadline = Date.now() + 8000;
	let ready = false;
	let died = false;

	while (Date.now() < deadline) {
		if (spawnError) break;

		// the liveness check comes before the fetch. it does not prove the child
		// bound the port, since for the first 200-300 ms it is alive merely because
		// it is still loading, but it proves the opposite when it fails, and that
		// is what cuts the wait short.
		try {
			process.kill(pid, 0);
		} catch {
			died = true;
			break;
		}

		try {
			const r = await fetch(`http://127.0.0.1:${opts.port}/config`, {
				signal: AbortSignal.timeout(500),
			});
			// readiness only, never identity: /config answering does not say who
			// answered. layers 1 to 3 are what decide the server is ours.
			if (r.ok) {
				ready = true;
				break;
			}
		} catch {}

		await new Promise((r) => setTimeout(r, 150));
	}

	// layer 2: EADDRINUSE kills the child in ~300 ms, and early on it is alive
	// because it is loading, not because it bound. half a second after the probe
	// passes, "still alive?" means what it looks like it means.
	if (ready) {
		await new Promise((r) => setTimeout(r, 500));
		try {
			process.kill(pid, 0);
		} catch {
			ready = false;
			died = true;
		}
	}

	// layer 3: alive or not, if its log shows EADDRINUSE then whoever answered
	// the probe was not it.
	if (ready && readLog().includes("EADDRINUSE")) {
		ready = false;
		died = true;
	}

	if (!ready) {
		try {
			process.kill(pid);
		} catch {}
		const tail = readLog().trimEnd().split("\n").slice(-8).join("\n");
		process.stderr.write(
			spawnError
				? `could not start the server: ${spawnError.message}\n`
				: died
					? `the server died starting up on port ${opts.port}.\n` +
						(tail ? `\n${tail}\n\n` : "") +
						`Port taken? Try --port with another number.\n`
					: `the server did not answer within 8s on port ${opts.port}.\n` +
						(tail ? `\n${tail}\n\n` : "") +
						`Full log at ${logPath}\n`,
		);
		process.exit(1);
	}

	// only now does the record exist, created with O_EXCL and 0600: the file is
	// ours or it is not used, and nobody else on the machine rewrites it.
	try {
		const fd = openSync(pidfile, "wx", 0o600);
		writeSync(fd, String(pid));
		closeSync(fd);
	} catch (e: unknown) {
		// somebody registered this port between the probe and now. leaving the
		// child up with no --stop path would create exactly the orphan all of this
		// exists to prevent.
		try {
			process.kill(pid);
		} catch {}
		let code: unknown;
		if (e !== null && typeof e === "object" && "code" in e) {
			code = e.code;
		}
		process.stderr.write(
			`another process registered port ${opts.port} while the server was starting (${code ?? String(e)}).\n` +
				`The server I had started was stopped. Try again.\n`,
		);
		process.exit(1);
	}

	process.stdout.write(
		`tailcast ${getVersion()}  ·  background\n` +
			`  http        http://localhost:${opts.port}\n` +
			`  stun  udp   :${opts.stunPort}\n` +
			`  pid         ${pid}\n\n` +
			`Stop it: bunx @thoth-dev/screen-share --stop --port ${opts.port}\n`,
	);
	process.exit(0);
}

/* ---------- foreground ---------- */

Object.assign(process.env, env);
// pathToFileURL, not the raw path: import() of an absolute path works in Bun on
// POSIX by accident, not by contract. the portable form is a URL.
await import(pathToFileURL(serverTarget).href);

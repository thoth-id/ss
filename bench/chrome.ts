import { mkdirSync, rmSync } from "node:fs";
import type { Subprocess } from "bun";

export const PORT = Number(process.env.PORT) || 3000;
export const DBG = Number(process.env.CDP_PORT) || 9333;
export const OUT = process.env.BENCH_OUT || "/tmp/tailcast-bench";

mkdirSync(OUT, { recursive: true });
// a fresh profile every run: the gate only opens by itself on this browser's
// first visit, so reusing localStorage would fail that assertion because the
// product is right, not because it is broken.
rmSync(`${OUT}/prof`, { recursive: true, force: true });

export let proc: Subprocess | null = null;

// `chromium` is on PATH on the Linux box this suite was written on and on no
// macOS install: there the binary lives inside the .app bundle and is not
// linked anywhere. hard-coding one name made the bench unrunnable on the very
// machine whose Safari/Chrome behaviour is being chased, so the name is an env
// var with the two usual defaults behind it.
const CHROME =
	process.env.CHROME ||
	(process.platform === "darwin"
		? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
		: "chromium");

export function ensureChrome(): Subprocess {
	if (proc) return proc;
	proc = Bun.spawn(
		[
			CHROME,
			"--headless=new",
			"--disable-gpu",
			"--hide-scrollbars",
			"--mute-audio",
			`--remote-debugging-port=${DBG}`,
			`--user-data-dir=${OUT}/prof`,
			"--no-first-run",
			"--window-size=1440,900",
			"about:blank",
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	return proc;
}

// an exception mid-suite must not leave a Chrome alive: the next run attaches
// to THAT one, with the old page loaded and the room already joined, and fails
// for defects that do not exist.
const cleanup = () => {
	try {
		proc?.kill();
	} catch {}
};

process.on("exit", cleanup);
process.on("uncaughtException", (e) => {
	console.error(e);
	cleanup();
	process.exit(1);
});
process.on("unhandledRejection", (e) => {
	console.error(e);
	cleanup();
	process.exit(1);
});

export function killChrome(): void {
	cleanup();
}

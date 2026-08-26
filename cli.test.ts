import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = import.meta.dir;
const CAT_START = "  ,-.       _,---._";
const CAT_END = "  `--'   `--'";

type Result = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
	const { promise, resolve, reject } = Promise.withResolvers<Result>();
	const child = spawn(process.execPath, [path.join(ROOT, "bin/cli.ts"), ...args], {
		cwd: ROOT,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
	child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
	child.once("error", reject);
	child.once("close", (code) => resolve({ code, stdout, stderr }));
	return promise;
}

function freeTcpPort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (address === null || typeof address === "string") {
			server.close();
			reject(new Error("could not determine a free TCP port"));
			return;
		}
		const port = address.port;
		server.close(() => resolve(port));
	});
	return promise;
}

function freeUdpPort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const socket = createSocket("udp4");
	socket.once("error", reject);
	socket.bind(0, "127.0.0.1", () => {
		const address = socket.address();
		const port = address.port;
		socket.close(() => resolve(port));
	});
	return promise;
}

test("background mode prints the ASCII banner in the terminal", async () => {
	const [port, stunPort] = await Promise.all([freeTcpPort(), freeUdpPort()]);
	const runtimeDir = mkdtempSync(path.join(tmpdir(), "tailcast-cli-test-"));
	const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir };
	const pidfile = path.join(runtimeDir, "tailcast", `tailcast-${port}.pid`);

	try {
		const started = await runCli(
			["--bg", "--port", String(port), "--stun-port", String(stunPort)],
			env,
		);

		assert.equal(started.code, 0, started.stderr || started.stdout);
		const bannerEnd = started.stdout.indexOf("\n\ntailcast ");
		assert.ok(bannerEnd > 0, "--bg output should include the banner before its status");
		const banner = started.stdout.slice(0, bannerEnd);
		assert.equal(
			banner.split("\n").length,
			11,
			"--bg output should include every ASCII banner line",
		);
		assert.ok(banner.startsWith(CAT_START) && banner.endsWith(CAT_END));
	} finally {
		if (existsSync(pidfile)) {
			let stopped = await runCli(["--stop", "--port", String(port)], env);
			if (stopped.code !== 0) {
				stopped = await runCli(["--stop", "--force", "--port", String(port)], env);
			}
			assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout);
		}
		rmSync(runtimeDir, { recursive: true, force: true });
	}
});

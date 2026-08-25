#!/usr/bin/env node
/* ss launcher.

   this file exists because of the shebang, and for no other reason. on POSIX
   npm links `node_modules/.bin/screen-share` straight at the file named in
   `bin`, so its first line picks the interpreter. with `bin` pointing at
   cli.ts, shebang `bun`, anyone running `npx @thoth-dev/screen-share` without
   Bun installed got

     env: 'bun': No such file or directory

   and not one line of our code ever ran: `env` died first, so no message
   written inside cli.ts could have appeared there. hence a file Node can
   execute, whose only job is to find Bun or explain why it could not.

   the runtime is not a style preference: server.ts uses Bun.serve for the
   signaling WebSocket and there is no equivalent in Node.

   no CLI logic here. flags, --bg and --stop all stay in cli.ts. */

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(AQUI, "cli.ts");

const EXE = process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"];

/* where to look, in order. PATH is the normal case; the two after it are the
   annoying one and the likeliest of all: Bun installed in ~/.bun/bin, which the
   installer writes into the shell rc, and `npx` running in a non-login shell
   that never read that rc. finding the binary there is the difference between
   working and telling the user to reinstall what they already have. */
const diretorios = () => {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const bunInstall = process.env.BUN_INSTALL;
  if (bunInstall) dirs.push(path.join(bunInstall, "bin"));
  const casa = homedir();
  if (casa) dirs.push(path.join(casa, ".bun", "bin"));
  return dirs;
};

// existing is not enough: a directory named `bun` on PATH would pass a test
// that only looks for presence.
const executavel = (p) => {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const acharBun = () => {
  for (const dir of diretorios()) {
    for (const nome of EXE) {
      const alvo = path.join(dir, nome);
      if (executavel(alvo)) return alvo;
    }
  }
  return null;
};

const FALTA = `ss needs Bun, and I could not find one on this machine.

  The server uses Bun.serve for the signaling WebSocket, and Node has no
  equivalent. What is missing is the runtime, not a dependency.

  Install it:

    curl -fsSL https://bun.sh/install | bash

  And run:

    bunx @thoth-dev/screen-share

  If Bun is already installed, then the shell that ran this command does not
  have its directory on PATH. I looked in PATH, in $BUN_INSTALL/bin and in
  ~/.bun/bin. Export BUN_INSTALL or call bun by its full path.
`;

/* already inside Bun, via `bunx` or a hand-written `bun bin/screen-share.mjs`.
   importing cli.ts directly saves a process and, more importantly, keeps the
   process.argv it expects: whoever reads `argv.slice(2)` cannot be handed an
   extra level of indirection. */
if (process.versions.bun) {
  await import(pathToFileURL(CLI).href);
} else {
  const bun = acharBun();
  if (!bun) {
    process.stderr.write(FALTA);
    process.exit(1);
  }

  const filho = spawn(bun, [CLI, ...process.argv.slice(2)], { stdio: "inherit" });

  // without this listener a failed spawn emits 'error' with nobody listening,
  // and Node takes the process down with a stack trace instead of a sentence.
  filho.on("error", (err) => {
    process.stderr.write(`could not execute ${bun}: ${err.message}\n`);
    process.exit(1);
  });

  /* relaying signals is the duty of whoever became the middle process. while
     `bin` was cli.ts itself, the pid the user saw was bun's and `kill <pid>`
     stopped the server. with a layer in between the same kill hits only the
     launcher and leaves bun orphaned holding the port, measured, not assumed.
     Ctrl-C hides this because the terminal signals the whole process group; a
     targeted kill does not. */
  const SINAIS = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sinal of SINAIS) {
    process.on(sinal, () => {
      if (!filho.killed) filho.kill(sinal);
    });
  }

  /* the exit code is cli.ts's, not ours: a --stop that found no pidfile exits
     1, and the caller needs to see that 1. death by signal has no code, and
     relaying it as 0 would claim success, so we kill ourselves with the same
     signal and let the shell report what happened. removeAllListeners is not
     decoration: with the listener above still installed, Node hands the signal
     to it instead of dying, and the launcher would hang trying to kill a child
     that is already dead. */
  filho.on("exit", (codigo, sinal) => {
    if (sinal) {
      process.removeAllListeners(sinal);
      process.kill(process.pid, sinal);
      return;
    }
    process.exit(codigo ?? 1);
  });
}

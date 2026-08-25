#!/usr/bin/env node
/* Lançador do screen-share.

   Este arquivo existe por causa do shebang, e por nenhum outro motivo. No
   POSIX o npm liga `node_modules/.bin/screen-share` direto no arquivo do
   campo `bin`, então quem escolhe o interpretador é a primeira linha dele.
   Com `bin` apontando para o cli.ts — shebang `bun` — quem rodava
   `npx @thoth-dev/screen-share` sem Bun instalado recebia

     env: 'bun': No such file or directory

   e nenhuma linha do nosso código chegava a rodar: o `env` morria antes.
   Nenhuma mensagem escrita dentro do cli.ts podia aparecer ali. Por isso o
   `bin` passou a apontar para cá, um arquivo que o Node executa, cuja única
   função é achar o Bun ou explicar por que não achou.

   O runtime não é preferência de estilo: o server.ts usa Bun.serve para o
   WebSocket do signaling e não há equivalente em Node.

   Nada de lógica de CLI aqui — flags, --bg e --stop continuam todos no
   cli.ts, que é quem sabe o que fazer com eles. */

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(AQUI, "cli.ts");

const EXE = process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"];

/* Onde procurar, em ordem. O PATH é o caso normal; os dois seguintes são o
   caso chato e o mais provável de todos: Bun instalado em ~/.bun/bin, que o
   instalador escreve no rc do shell, e `npx` rodando num shell não
   interativo que nunca leu esse rc. Achar o binário ali é a diferença entre
   funcionar e mandar o usuário reinstalar o que ele já tem. */
const diretorios = () => {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const bunInstall = process.env.BUN_INSTALL;
  if (bunInstall) dirs.push(path.join(bunInstall, "bin"));
  const casa = homedir();
  if (casa) dirs.push(path.join(casa, ".bun", "bin"));
  return dirs;
};

// Executável de verdade: existir não basta, e um diretório chamado `bun` no
// PATH passaria por um teste que só olha existência.
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

const FALTA = `screen-share precisa do Bun, e não encontrei nenhum nesta máquina.

  O servidor usa Bun.serve para o WebSocket do signaling, e não existe
  equivalente em Node — falta o runtime, não uma dependência.

  Instale:

    curl -fsSL https://bun.sh/install | bash

  E rode:

    bunx @thoth-dev/screen-share

  Se o Bun já está instalado, então o shell que rodou este comando não tem o
  diretório dele no PATH — procurei no PATH, em $BUN_INSTALL/bin e em
  ~/.bun/bin. Exporte BUN_INSTALL ou chame o bun por caminho completo.
`;

/* Já estamos dentro do Bun — `bunx`, ou um `bun bin/screen-share.mjs` à mão.
   Importar o cli.ts direto poupa um processo e, mais importante, mantém o
   process.argv que ele espera: quem lê `argv.slice(2)` não pode ganhar um
   nível de indireção no meio. */
if (process.versions.bun) {
  await import(pathToFileURL(CLI).href);
} else {
  const bun = acharBun();
  if (!bun) {
    process.stderr.write(FALTA);
    process.exit(1);
  }

  const filho = spawn(bun, [CLI, ...process.argv.slice(2)], { stdio: "inherit" });

  // Sem este ouvinte um spawn que falha emite 'error' sem quem escute, e o
  // Node derruba o processo com um stack trace no lugar de uma frase.
  filho.on("error", (err) => {
    process.stderr.write(`não consegui executar ${bun}: ${err.message}\n`);
    process.exit(1);
  });

  /* Repassar sinal é obrigação de quem virou intermediário. Enquanto o `bin`
     era o próprio cli.ts, o pid que o usuário via era o do bun e um
     `kill <pid>` derrubava o servidor. Com uma camada no meio o mesmo kill
     mata só o lançador e deixa o bun órfão segurando a porta — medido, não
     suposto. Ctrl-C escapa disso porque o terminal sinaliza o grupo inteiro;
     um kill mirado, não. */
  const SINAIS = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sinal of SINAIS) {
    process.on(sinal, () => {
      if (!filho.killed) filho.kill(sinal);
    });
  }

  /* O código de saída é do cli.ts, não nosso: --stop que não achou pidfile
     sai 1, e quem chamou precisa ver esse 1. Morte por sinal não tem código
     — repassar como 0 diria que deu tudo certo, então nos matamos com o
     mesmo sinal e deixamos o shell relatar o que de fato aconteceu. O
     removeAllListeners não é adorno: com o ouvinte de cima ainda instalado, o
     Node entrega o sinal a ele em vez de morrer, e o lançador ficaria pendurado
     tentando matar um filho que já morreu. */
  filho.on("exit", (codigo, sinal) => {
    if (sinal) {
      process.removeAllListeners(sinal);
      process.kill(process.pid, sinal);
      return;
    }
    process.exit(codigo ?? 1);
  });
}

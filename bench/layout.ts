import { mkdirSync, rmSync } from "node:fs";

// Verificação de layout do cliente real, headless, por CDP.
//
// O encaixe dos tiles é calculado em px pelo layout(), não pelo CSS, então
// mexer na casca pode quebrar em silêncio: a asserção que importa é que a
// página nunca role. Este script sobe o Chrome, abre o cliente de verdade e
// injeta sharers falsos com canvas.captureStream() em attachTile() — tudo no
// script do cliente é global, então o caminho exercitado é o de produção,
// proporções incluídas.
//
// Precisa de um servidor no ar. Num comando só, porque background de outra
// invocação não sobrevive:
//
//   (PORT=3200 STUN_PORT=3678 bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); \
//     sleep 2; bun run bench/layout.ts; kill $(cat /tmp/p)
//
// WebRTC de verdade continua fora de alcance daqui: sem browser remoto, sem
// segunda máquina. Isto cobre layout, presença, portaria e troca de sala.
// Mesmas variáveis que o test.ts honra, pra desviar de um servidor já no ar.
const PORT = Number(process.env.PORT) || 3000;
const DBG = Number(process.env.CDP_PORT) || 9333;
const OUT = process.env.BENCH_OUT || "/tmp/tela-bench";
mkdirSync(OUT, { recursive: true });
// Perfil zerado a cada rodada: a portaria só abre sozinha na primeira visita
// deste navegador, então reaproveitar o localStorage falharia essa asserção
// por acerto do produto, não por defeito.
rmSync(`${OUT}/prof`, { recursive: true, force: true });

const proc = Bun.spawn([
  "chromium", "--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${OUT}/prof`,
  "--no-first-run", "--window-size=1440,900", "about:blank",
], { stdout: "ignore", stderr: "ignore" });

// Exceção no meio da suíte não pode deixar um Chrome vivo: a rodada seguinte se
// conecta NELE, com a página antiga carregada e a sala já entrada, e falha por
// defeitos que não existem. Custou um ciclo inteiro descobrir isso.
const encerra = () => { try { proc.kill(); } catch {} };
process.on("exit", encerra);
process.on("uncaughtException", (e) => { console.error(e); encerra(); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); encerra(); process.exit(1); });

async function alvo() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${DBG}/json/list`).then((r) => r.json());
      const page = list.find((t: any) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error("chromium não respondeu");
}

const ws = new WebSocket(await alvo());
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const espera = new Map<number, (v: any) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && espera.has(m.id)) espera.get(m.id)!(m);
};
function cdp(method: string, params: any = {}): Promise<any> {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => espera.set(id, r));
}
async function evalJS(expr: string) {
  const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
}
async function shot(nome: string) {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  await Bun.write(`${OUT}/cdp-${nome}.png`, Buffer.from(r.result.data, "base64"));
}
async function tela(w: number, h: number) {
  await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
}

// Roda e arraste de verdade, pelo Input do CDP. Evento sintético do Runtime não
// serve aqui: o pan chama setPointerCapture, que rejeita um pointerId inventado,
// e sem captura o arraste morre na borda do elemento — o teste passaria vazio.
async function roda(x: number, y: number, dy: number) {
  await cdp("Input.dispatchMouseEvent",
    { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy, pointerType: "mouse" });
  await Bun.sleep(60);
}
async function arrasta(x0: number, y0: number, x1: number, y1: number) {
  await cdp("Input.dispatchMouseEvent",
    { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  const N = 8;
  for (let i = 1; i <= N; i++) {
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1,
      x: Math.round(x0 + ((x1 - x0) * i) / N), y: Math.round(y0 + ((y1 - y0) * i) / N), pointerType: "mouse" });
  }
  await cdp("Input.dispatchMouseEvent",
    { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  await Bun.sleep(80);
}
async function clica(x: number, y: number) {
  await cdp("Input.dispatchMouseEvent",
    { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  await cdp("Input.dispatchMouseEvent",
    { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  await Bun.sleep(80);
}

await cdp("Page.enable");
await cdp("Runtime.enable");
await tela(1440, 900);
await cdp("Page.navigate", { url: `http://127.0.0.1:${PORT}/#sala` });
await Bun.sleep(1500);
for (let i = 0; i < 60 && !(await evalJS('typeof ROOM !== "undefined"')); i++) await Bun.sleep(250);

const falhas: string[] = [];
function checa(nome: string, cond: boolean, detalhe = "") {
  console.log(`  ${cond ? "ok  " : "FALHA"}  ${nome}${cond ? "" : "  " + detalhe}`);
  if (!cond) falhas.push(nome);
}

// O encaixe transiciona left/top/width/height em .16s. Medir dois rAFs depois
// lê geometria em voo: tile fora da proporção, pílula ainda no lugar antigo.
// Duas vezes a transição.
const assenta = () => Bun.sleep(340);

async function medir() {
  return await evalJS(`(() => {
    const st = document.getElementById("stage").getBoundingClientRect();
    const dock = document.querySelector(".dock").getBoundingClientRect();
    const topo = document.querySelector(".top").getBoundingClientRect();
    const bate = (r, o) =>
      !(r.right <= o.left || r.left >= o.right || r.bottom <= o.top || r.top >= o.bottom);
    const tiles = [...document.querySelectorAll(".tile")].map((t) => {
      const r = t.getBoundingClientRect();
      const v = t.querySelector("video");
      return { id: t.dataset.id, x: r.x, y: r.y, w: r.width, h: r.height,
               peer: t.classList.contains("peer"),
               foraDoPalco: r.bottom > st.bottom + 1 || r.right > st.right + 1 || r.top < st.top - 1,
               sobDock: bate(r, dock), sobTopo: bate(r, topo),
               vw: v ? v.getBoundingClientRect().width : 0,
               vh: v ? v.getBoundingClientRect().height : 0 };
    });
    return {
      rola: document.documentElement.scrollHeight > innerHeight,
      scrollH: document.documentElement.scrollHeight, innerH: innerHeight,
      stage: { w: st.width, h: st.height },
      tiles,
      nomes: [...document.querySelectorAll(".tile .who b")].map((b) => b.textContent),
      // As duas pílulas dividem a borda de baixo do tile. Encavalar é o modo
      // de falhar aqui, e ele é medível: comparar as caixas, não as classes.
      pilulas: [...document.querySelectorAll(".tile:not(.peer)")].map((t) => {
        const nome = t.querySelector(".who").getBoundingClientRect();
        const tel = t.querySelector(".tel");
        if (getComputedStyle(tel).display === "none") return true;
        return nome.right <= tel.getBoundingClientRect().left;
      }),
      gate: !document.getElementById("gate").hidden,
      goOff: document.getElementById("gateGo").disabled,
      myId: typeof myId !== "undefined" ? myId : null,
      topo: [...document.querySelectorAll(".top span")].filter((s) => !s.hidden).map((s) => s.textContent),
    };
  })()`);
}

const dentro = (m: any) =>
  m.tiles.every((t: any) => !t.foraDoPalco && !t.sobDock && !t.sobTopo) &&
  m.pilulas.every(Boolean);

console.log("\n--- portaria: nome é obrigatório e ela é a porta ---");
let m = await medir();
checa("portaria abre sozinha", m.gate === true);
checa("não entrou na sala antes do nome", m.myId === null, String(m.myId));
checa("botão entrar começa desligado", m.goOff === true);
checa("página não rola", !m.rola, `${m.scrollH} > ${m.innerH}`);
await shot("1-portaria");

await evalJS(`(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  document.getElementById("gateScrim").click();
})()`);
await Bun.sleep(200);
m = await medir();
checa("esc e clique fora não fecham sem nome", m.gate === true);

async function digita(v: string) {
  await evalJS(`(() => {
    const n = document.getElementById("gateName");
    n.value = ${JSON.stringify(v)};
    n.dispatchEvent(new Event("input"));
  })()`);
}
await digita("GM");
checa("2 letras não passam", await evalJS(`document.getElementById("gateGo").disabled`));
await digita("GMG");
checa("3 letras passam", !(await evalJS(`document.getElementById("gateGo").disabled`)));

await evalJS(`document.getElementById("gateGo").click()`);
for (let i = 0; i < 40 && !(await evalJS("!!myId")); i++) await Bun.sleep(200);
m = await medir();
checa("entrou depois de responder", !!m.myId && m.gate === false, `${m.myId} gate=${m.gate}`);

// Sala povoada: a grade de call de quem está sem transmitir.
await evalJS(`(() => {
  window.fake = (w, h) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    let k = 0;
    setInterval(() => {
      g.fillStyle = "#0e1a1f"; g.fillRect(0, 0, w, h);
      g.fillStyle = "#5ad3bb"; g.fillRect((k = (k + 20) % w), 40, 160, 90);
      g.fillStyle = "#dbe4e8"; g.fillRect(60, h - 140, w * 0.5, 26);
    }, 66);
    return c.captureStream(15);
  };
  peers.add("aaaa1111"); peers.add("bbbb2222"); peers.add("cccc3333");
  names.set("aaaa1111", "GRO"); names.set("bbbb2222", "Malu"); names.set("cccc3333", "Ana");
  sharers = new Set();
  render();
})()`);
await assenta();
m = await medir();
console.log("\n--- 4 na sala, ninguém transmitindo (a call) ---");
checa("página não rola", !m.rola, `${m.scrollH} > ${m.innerH}`);
checa("todo mundo tem tile", m.tiles.length === 4 && m.tiles.every((t: any) => t.peer), String(m.tiles.length));
checa("nada encavalado: dock, pílula, rótulo", dentro(m), JSON.stringify(m.tiles));
checa("célula igual pra todo mundo", new Set(m.tiles.map((t: any) => Math.round(t.h))).size === 1,
  JSON.stringify(m.tiles.map((t: any) => Math.round(t.h))));
checa("pílula conta a sala", m.topo.join(" ") === "#sala 0/3 no ar 4 na sala", JSON.stringify(m.topo));
await shot("2-call-sem-video");

console.log("\n--- 1 tela no ar: vídeo manda, presença desce pra trilha ---");
await evalJS(`(() => { sharers = new Set(["aaaa1111"]); render(); attachTile("aaaa1111", fake(1600, 900)); })()`);
await assenta();
m = await medir();
const video = m.tiles.filter((t: any) => !t.peer);
const placas = m.tiles.filter((t: any) => t.peer);
checa("página não rola", !m.rola, `${m.scrollH} > ${m.innerH}`);
checa("nada encavalado: dock, pílula, rótulo", dentro(m), JSON.stringify(m.tiles));
checa("1 vídeo e 3 monogramas", video.length === 1 && placas.length === 3);
checa("trilha de presença tem teto", placas.every((p: any) => p.h <= 132), JSON.stringify(placas.map((p: any) => p.h)));
checa("vídeo é maior que a trilha", video[0].h > placas[0].h * 2, `${video[0].h} vs ${placas[0].h}`);
checa("proporção preservada", Math.abs(video[0].vw / video[0].vh - 16 / 9) < 0.02, `${video[0].vw}×${video[0].vh}`);
await shot("3-um-video");

console.log("\n--- 2 telas, proporções diferentes ---");
await evalJS(`(() => { sharers = new Set(["aaaa1111","bbbb2222"]); render(); attachTile("bbbb2222", fake(1440, 900)); })()`);
await assenta();
m = await medir();
const vids = m.tiles.filter((t: any) => !t.peer);
checa("página não rola", !m.rola, `${m.scrollH} > ${m.innerH}`);
checa("nada encavalado: dock, pílula, rótulo", dentro(m), JSON.stringify(m.tiles));
checa("dois vídeos no palco", vids.length === 2, String(vids.length));
checa("linha justificada: mesma altura", Math.abs(vids[0].h - vids[1].h) < 2, `${vids[0].h} vs ${vids[1].h}`);
await shot("4-dois-videos");

console.log("\n--- foco ---");
await evalJS(`toggleFocus("aaaa1111")`);
await assenta();
m = await medir();
const foco = m.tiles.find((t: any) => t.id === "aaaa1111");
const mini = m.tiles.find((t: any) => t.id === "bbbb2222");
checa("página não rola", !m.rola, `${m.scrollH} > ${m.innerH}`);
checa("nada encavalado: dock, pílula, rótulo", dentro(m), JSON.stringify(m.tiles));
checa("o focado é maior que a miniatura", foco.w > mini.w * 2, `${foco.w} vs ${mini.w}`);
checa("botão de grade acende no foco", !(await evalJS(`document.getElementById("gridBtn").disabled`)));
await shot("5-foco");

await evalJS(`document.getElementById("gridBtn").click()`);
await assenta();
checa("botão de grade sai do foco", (await evalJS("focusId")) === null);

console.log("\n--- zoom de quem vê ---");
// Ancoragem: o ponto do vídeo sob o cursor não pode andar. Em coordenadas do
// elemento, com origem 0 0 e mapa s = k·p + t, esse ponto é p = (c − t)/k. É o
// que a fórmula errada quebra a partir do SEGUNDO entalhe, quando t deixa de
// ser zero — o primeiro passa em qualquer versão, por isso o teste dá dois.
await evalJS(`toggleFocus("aaaa1111")`);
await assenta();
await evalJS(`window.pontoSob = (id, cx, cy) => {
  const f = tiles.get(id).querySelector(".frame");
  const r = f.getBoundingClientRect();
  const z = zooms.get(id) || { k: 1, x: 0, y: 0 };
  return { px: (cx - r.left - z.x) / z.k, py: (cy - r.top - z.y) / z.k,
           k: z.k, x: z.x, y: z.y, W: f.clientWidth, H: f.clientHeight,
           left: r.left, top: r.top };
}`);
const cx = Math.round(await evalJS(`(() => { const r = tiles.get("aaaa1111").querySelector(".frame").getBoundingClientRect(); return r.left + r.width / 2; })()`));
const cy = Math.round(await evalJS(`(() => { const r = tiles.get("aaaa1111").querySelector(".frame").getBoundingClientRect(); return r.top + r.height / 2; })()`));

const p0 = await evalJS(`pontoSob("aaaa1111", ${cx}, ${cy})`);
await roda(cx, cy, -240);
const p1 = await evalJS(`pontoSob("aaaa1111", ${cx}, ${cy})`);
checa("a roda amplia", p1.k > 1.05, `k=${p1.k}`);
checa("âncora no 1º entalhe", Math.abs(p1.px - p0.px) < 1 && Math.abs(p1.py - p0.py) < 1,
  `(${p0.px.toFixed(1)},${p0.py.toFixed(1)}) -> (${p1.px.toFixed(1)},${p1.py.toFixed(1)})`);

await roda(cx, cy, -240);
const p2 = await evalJS(`pontoSob("aaaa1111", ${cx}, ${cy})`);
checa("a roda acumula", p2.k > p1.k + 0.05, `${p1.k} -> ${p2.k}`);
checa("âncora no 2º entalhe (t já não é zero)",
  Math.abs(p2.px - p0.px) < 1 && Math.abs(p2.py - p0.py) < 1,
  `esperado (${p0.px.toFixed(1)},${p0.py.toFixed(1)}), veio (${p2.px.toFixed(1)},${p2.py.toFixed(1)})`);

await roda(cx, cy, -240);
const p3 = await evalJS(`pontoSob("aaaa1111", ${cx}, ${cy})`);
checa("âncora no 3º entalhe", Math.abs(p3.px - p0.px) < 1 && Math.abs(p3.py - p0.py) < 1,
  `esperado (${p0.px.toFixed(1)},${p0.py.toFixed(1)}), veio (${p3.px.toFixed(1)},${p3.py.toFixed(1)})`);

// Teto: nem a roda infinita passa de ZOOM_MAX.
for (let i = 0; i < 12; i++) await roda(cx, cy, -240);
checa("teto de zoom respeitado", (await evalJS(`zooms.get("aaaa1111").k`)) <= 4.0001,
  String(await evalJS(`zooms.get("aaaa1111").k`)));

// Confinamento: arrastar longe encosta na borda e para. Esta é a asserção com
// dentes — scrollHeight não serve, porque .tile tem overflow: hidden e absorve
// qualquer transbordo do descendente transformado.
await arrasta(cx, cy, cx + 5000, cy);
let z = await evalJS(`zooms.get("aaaa1111")`);
checa("pan não descola pela direita", Math.abs(z.x) < 0.5, `x=${z.x}`);
await arrasta(cx, cy, cx - 5000, cy);
z = await evalJS(`zooms.get("aaaa1111")`);
const lim = await evalJS(`(() => { const f = tiles.get("aaaa1111").querySelector(".frame");
  return f.clientWidth * (1 - zooms.get("aaaa1111").k); })()`);
checa("pan não descola pela esquerda", Math.abs(z.x - lim) < 1, `x=${z.x} limite=${lim}`);
await arrasta(cx, cy, cx, cy - 5000);
z = await evalJS(`zooms.get("aaaa1111")`);
const limY = await evalJS(`(() => { const f = tiles.get("aaaa1111").querySelector(".frame");
  return f.clientHeight * (1 - zooms.get("aaaa1111").k); })()`);
checa("pan não descola por cima", Math.abs(z.y - limY) < 1, `y=${z.y} limite=${limY}`);

// O quadro tem que recortar por si: em tela cheia o .tile sai do fluxo e o
// overflow dele não alcança mais o vídeo escalado.
checa("o quadro recorta o vídeo ampliado",
  (await evalJS(`getComputedStyle(tiles.get("aaaa1111").querySelector(".frame")).overflow`)) === "hidden",
  await evalJS(`getComputedStyle(tiles.get("aaaa1111").querySelector(".frame")).overflow`));

// Indicador: zoom é um modo, e um modo tem que ser visível. Fora do .tel, que
// exige .vivo (PC no ar) e desaparece em .narrow.
const ind = await evalJS(`(() => {
  const t = tiles.get("aaaa1111"), e = t.querySelector(".zoom");
  if (!e) return null;
  const cs = getComputedStyle(e);
  return { txt: e.textContent, vis: cs.display !== "none", dentroDoTel: !!e.closest(".tel"),
           upscale: e.classList.contains("up") };
})()`);
checa("indicador existe e aparece", !!ind && ind.vis, JSON.stringify(ind));
checa("indicador diz o fator", !!ind && /[\d.,]+\s*×/.test(ind.txt), JSON.stringify(ind?.txt));
checa("indicador fora do .tel", !!ind && !ind.dentroDoTel, JSON.stringify(ind));
checa("a 4× num tile de 1440 o indicador marca upscale", !!ind && ind.upscale === true, JSON.stringify(ind));

// A fronteira, que é o que o indicador existe pra dizer: até o nativo ampliar
// recupera detalhe que chegou e foi jogado fora pelo encaixe; acima, interpola.
// Testar só o extremo de 4× não prova que o limiar está no lugar certo.
const fronteira = await evalJS(`(() => {
  const t = tiles.get("aaaa1111"), f = t.querySelector(".frame"), v = t.querySelector("video");
  const nativo = v.videoWidth / (f.clientWidth * devicePixelRatio);
  const leia = (k) => { zooms.set("aaaa1111", { k, x: 0, y: 0 }); applyZoom("aaaa1111");
    return t.querySelector(".zoom").classList.contains("up"); };
  return { nativo, abaixo: leia(nativo * 0.9), acima: leia(nativo * 1.1) };
})()`);
checa("abaixo do nativo não é upscale", fronteira.abaixo === false, JSON.stringify(fronteira));
checa("acima do nativo é upscale", fronteira.acima === true, JSON.stringify(fronteira));
checa("o nativo é maior que 1 (o encaixe reduz o vídeo)", fronteira.nativo > 1,
  `nativo=${fronteira.nativo}`);

// Clique não arranca de perto quem está lendo, e o clique pós-pan não foca.
checa("clique não sai do foco enquanto há zoom", (await evalJS("focusId")) === "aaaa1111");
await clica(cx, cy);
checa("clique com zoom não muda o foco", (await evalJS("focusId")) === "aaaa1111",
  String(await evalJS("focusId")));

// Zerar volta à identidade sem estado fantasma.
await evalJS(`(() => { zooms.delete("aaaa1111"); applyZoom("aaaa1111"); })()`);
const limpo = await evalJS(`(() => {
  const t = tiles.get("aaaa1111");
  const e = t.querySelector(".zoom");
  return { tr: t.querySelector("video").style.transform, cls: t.querySelector(".frame").className,
           ind: e ? getComputedStyle(e).display : "ausente" };
})()`);
checa("zerar apaga transform, classe e indicador",
  limpo.tr === "" && !limpo.cls.includes("zoomed") && limpo.ind === "none", JSON.stringify(limpo));

// Miniatura não carrega zoom: numa trilha de 150px focar dá mais pixel que
// qualquer ampliação, e lá não há gesto.
await evalJS(`(() => { focusId = null; render(); })()`);
await assenta();
const cx2 = Math.round(await evalJS(`(() => { const r = tiles.get("bbbb2222").querySelector(".frame").getBoundingClientRect(); return r.left + r.width / 2; })()`));
const cy2 = Math.round(await evalJS(`(() => { const r = tiles.get("bbbb2222").querySelector(".frame").getBoundingClientRect(); return r.top + r.height / 2; })()`));
await roda(cx2, cy2, -240);
checa("zoom vale em tile fora do foco", (await evalJS(`zooms.has("bbbb2222")`)) === true);
await evalJS(`toggleFocus("aaaa1111")`);
await assenta();
checa("virar miniatura descarta o zoom", (await evalJS(`zooms.has("bbbb2222")`)) === false);

// Layout intacto sob zoom: o transform não participa do encaixe.
await roda(cx, cy, -240);
await assenta();
m = await medir();
checa("página não rola com zoom", !m.rola, `${m.scrollH} > ${m.innerH}`);
checa("nada encavalado com zoom", dentro(m), JSON.stringify(m.tiles));
await shot("5b-zoom");

// Não contamina o resto do bench.
await evalJS(`(() => { for (const id of [...zooms.keys()]) { zooms.delete(id); applyZoom(id); }
  focusId = null; render(); })()`);
await assenta();
checa("bench sai do zoom limpo", (await evalJS("zooms.size")) === 0 && (await evalJS("focusId")) === null);

console.log("\n--- 430px de largura ---");
await tela(430, 780);
await assenta();
await assenta();
m = await medir();
checa("página não rola", !m.rola, `${m.scrollH} > ${m.innerH}`);
checa("nada encavalado: dock, pílula, rótulo", dentro(m), JSON.stringify(m.tiles));
checa("nome e telemetria não se encavalam", m.pilulas.every(Boolean), JSON.stringify(m.pilulas));
checa("a fita sai antes do número",
  (await evalJS(`[...document.querySelectorAll(".tile:not(.peer)")].every((t) => t.classList.contains("tight"))`)));
await shot("6-estreito");

console.log("\n--- nome pelo dock ---");
await tela(1440, 900);
await evalJS(`document.getElementById("meBtn").click()`);
await Bun.sleep(200);
checa("dock abre a portaria destravada", await evalJS(`!document.getElementById("gate").hidden && !gateTrava`));
await digita("Gabriel");
await evalJS(`document.getElementById("gateGo").click()`);
await Bun.sleep(500);
checa("nome sobe pro servidor e volta", (await evalJS(`names.get(myId)`)) === "Gabriel", await evalJS("myName"));
const minhaPilula = await evalJS(`(() => {
  const w = [...document.querySelectorAll(".tile")].find((t) => t.dataset.id === myId).querySelector(".who");
  const em = w.querySelector("em");
  return { nome: w.querySelector("b").textContent, marca: em.textContent, visivel: getComputedStyle(em).display !== "none" };
})()`);
checa("a pílula do meu tile diz o nome", minhaPilula.nome === "Gabriel", JSON.stringify(minhaPilula));
checa("e a marca (você) ao lado", minhaPilula.marca === "(você)" && minhaPilula.visivel);

console.log("\n--- troca de sala ---");
const idAntes = await evalJS("myId");
await evalJS(`switchRoom("trabalho")`);
await Bun.sleep(900);
m = await medir();
checa("id novo do servidor", !!m.myId && m.myId !== idAntes, `${idAntes} -> ${m.myId}`);
checa("palco limpo", m.tiles.length === 0, String(m.tiles.length));
checa("hash acompanha", (await evalJS("location.hash")) === "#trabalho", await evalJS("location.hash"));
checa("pílula acompanha", (await evalJS(`document.getElementById("topRoom").textContent`)) === "#trabalho");
checa("página não rola", !m.rola, `${m.scrollH} > ${m.innerH}`);
await shot("7-troca-sala");

console.log(falhas.length ? `\n${falhas.length} FALHA(S): ${falhas.join(", ")}` : "\ntudo verde");
ws.close();
proc.kill();
process.exit(falhas.length ? 1 : 0);

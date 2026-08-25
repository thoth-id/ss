import { mkdirSync, rmSync } from "node:fs";

// headless layout verification of the real client, over CDP.
//
// the tile fit is computed in px by layout(), not by the CSS, so touching the
// shell can break it silently: the assertion that matters is that the page
// never scrolls. this script starts Chrome, opens the real client and injects
// fake sharers into attachTile() with canvas.captureStream(). everything in the
// client script is global, so the path exercised is the production one, aspect
// ratios included.
//
// needs a live server, in one command, because a background process from
// another invocation does not survive:
//
//   (PORT=3200 STUN_PORT=3678 bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); \
//     sleep 2; bun run bench/layout.ts; kill $(cat /tmp/p)
//
// real WebRTC stays out of reach here: no remote browser, no second machine.
// this covers layout, presence, the gate and switching rooms. same variables
// test.ts honours, so a run can dodge a server that is already up.
const PORT = Number(process.env.PORT) || 3000;
const DBG = Number(process.env.CDP_PORT) || 9333;
const OUT = process.env.BENCH_OUT || "/tmp/ss-bench";
mkdirSync(OUT, { recursive: true });
// a fresh profile every run: the gate only opens by itself on this browser's
// first visit, so reusing localStorage would fail that assertion because the
// product is right, not because it is broken.
rmSync(`${OUT}/prof`, { recursive: true, force: true });

const proc = Bun.spawn([
  "chromium", "--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${OUT}/prof`,
  "--no-first-run", "--window-size=1440,900", "about:blank",
], { stdout: "ignore", stderr: "ignore" });

// an exception mid-suite must not leave a Chrome alive: the next run attaches
// to THAT one, with the old page loaded and the room already joined, and fails
// for defects that do not exist.
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
  throw new Error("chromium did not answer");
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

// real wheel and drag, through CDP's Input. a synthetic event from Runtime does
// not work here: the pan calls setPointerCapture, which rejects an invented
// pointerId, and without capture the drag dies at the element edge, so the test
// would pass vacuously.
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
await cdp("Page.navigate", { url: `http://127.0.0.1:${PORT}/#room` });
await Bun.sleep(1500);
for (let i = 0; i < 60 && !(await evalJS('typeof ROOM !== "undefined"')); i++) await Bun.sleep(250);

const falhas: string[] = [];
function checa(nome: string, cond: boolean, detalhe = "") {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${nome}${cond ? "" : "  " + detalhe}`);
  if (!cond) falhas.push(nome);
}

// the fit transitions left/top/width/height over .16s. measuring two rAFs
// later reads geometry in flight: a tile off its aspect ratio, a pill still in
// its old place. wait twice the transition.
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
      // the two pills share the tile's bottom edge. overlapping is the way
      // this fails, and it is measurable: compare boxes, not class names.
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

console.log("\n--- gate: the name is mandatory and the modal is the door ---");
let m = await medir();
checa("the gate opens by itself", m.gate === true);
checa("no room joined before a name", m.myId === null, String(m.myId));
checa("the enter button starts disabled", m.goOff === true);
checa("the page does not scroll", !m.rola, `${m.scrollH} > ${m.innerH}`);
await shot("1-gate");

await evalJS(`(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  document.getElementById("gateScrim").click();
})()`);
await Bun.sleep(200);
m = await medir();
checa("esc and an outside click do not close it unnamed", m.gate === true);

async function digita(v: string) {
  await evalJS(`(() => {
    const n = document.getElementById("gateName");
    n.value = ${JSON.stringify(v)};
    n.dispatchEvent(new Event("input"));
  })()`);
}
await digita("GM");
checa("2 letters do not pass", await evalJS(`document.getElementById("gateGo").disabled`));
await digita("GMG");
checa("3 letters pass", !(await evalJS(`document.getElementById("gateGo").disabled`)));

await evalJS(`document.getElementById("gateGo").click()`);
for (let i = 0; i < 40 && !(await evalJS("!!myId")); i++) await Bun.sleep(200);
m = await medir();
checa("joined after answering", !!m.myId && m.gate === false, `${m.myId} gate=${m.gate}`);

// a populated room: the call grid of everybody not transmitting.
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
console.log("\n--- 4 in the room, nobody transmitting (the call) ---");
checa("the page does not scroll", !m.rola, `${m.scrollH} > ${m.innerH}`);
checa("everybody has a tile", m.tiles.length === 4 && m.tiles.every((t: any) => t.peer), String(m.tiles.length));
checa("nothing overlaps: dock, pill, label", dentro(m), JSON.stringify(m.tiles));
checa("equal cells for everybody", new Set(m.tiles.map((t: any) => Math.round(t.h))).size === 1,
  JSON.stringify(m.tiles.map((t: any) => Math.round(t.h))));
checa("the pill counts the room",
  m.topo.length === 4 && m.topo[0] === "#room" && /^\d+:\d{2}(:\d{2})?$/.test(m.topo[1]) &&
  m.topo[2] === "0/3 on air" && m.topo[3] === "4 in the room",
  JSON.stringify(m.topo));
await shot("2-call-no-video");

console.log("\n--- 1 screen on air: video rules, presence drops to the rail ---");
await evalJS(`(() => { sharers = new Set(["aaaa1111"]); render(); attachTile("aaaa1111", fake(1600, 900)); })()`);
await assenta();
m = await medir();
const video = m.tiles.filter((t: any) => !t.peer);
const placas = m.tiles.filter((t: any) => t.peer);
checa("the page does not scroll", !m.rola, `${m.scrollH} > ${m.innerH}`);
checa("nothing overlaps: dock, pill, label", dentro(m), JSON.stringify(m.tiles));
checa("1 video and 3 monograms", video.length === 1 && placas.length === 3);
checa("the presence rail is capped", placas.every((p: any) => p.h <= 132), JSON.stringify(placas.map((p: any) => p.h)));
checa("the video is bigger than the rail", video[0].h > placas[0].h * 2, `${video[0].h} vs ${placas[0].h}`);
checa("aspect ratio preserved", Math.abs(video[0].vw / video[0].vh - 16 / 9) < 0.02, `${video[0].vw}×${video[0].vh}`);
await shot("3-one-video");

console.log("\n--- 2 screens, different aspect ratios ---");
await evalJS(`(() => { sharers = new Set(["aaaa1111","bbbb2222"]); render(); attachTile("bbbb2222", fake(1440, 900)); })()`);
await assenta();
m = await medir();
const vids = m.tiles.filter((t: any) => !t.peer);
checa("the page does not scroll", !m.rola, `${m.scrollH} > ${m.innerH}`);
checa("nothing overlaps: dock, pill, label", dentro(m), JSON.stringify(m.tiles));
checa("two videos on stage", vids.length === 2, String(vids.length));
checa("justified row: same height", Math.abs(vids[0].h - vids[1].h) < 2, `${vids[0].h} vs ${vids[1].h}`);
await shot("4-two-videos");

console.log("\n--- focus ---");
await evalJS(`toggleFocus("aaaa1111")`);
await assenta();
m = await medir();
const foco = m.tiles.find((t: any) => t.id === "aaaa1111");
const mini = m.tiles.find((t: any) => t.id === "bbbb2222");
checa("the page does not scroll", !m.rola, `${m.scrollH} > ${m.innerH}`);
checa("nothing overlaps: dock, pill, label", dentro(m), JSON.stringify(m.tiles));
checa("the focused one is bigger than the thumbnail", foco.w > mini.w * 2, `${foco.w} vs ${mini.w}`);
checa("the grid button lights up in focus", !(await evalJS(`document.getElementById("gridBtn").disabled`)));
await shot("5-focus");

await evalJS(`document.getElementById("gridBtn").click()`);
await assenta();
checa("the grid button leaves focus", (await evalJS("focusId")) === null);

console.log("\n--- receiver-side zoom ---");
// anchoring: the point of video under the cursor must not move. in element
// coordinates, with origin 0 0 and the map s = k·p + t, that point is
// p = (c − t)/k. the wrong formula breaks it from the SECOND notch on, once t
// stops being zero; the first passes in any version, hence two notches.
await evalJS(`toggleFocus("aaaa1111")`);
await assenta();
await evalJS(`window.pontoSob = (id, cx, cy) => {
  const f = tiles.get(id).querySelector(".frame");
  const v = f.querySelector("video");
  const fr = f.getBoundingClientRect();
  const cs = getComputedStyle(v);
  // reads the RENDERED transform, not the zooms object: rereading what
  // applyZoom just stored validates the rule's arithmetic and nothing about
  // what reaches the screen. under the old version, deleting transform-origin
  // or swapping translate/scale order both passed green, and each destroys the
  // anchor outright.
  const m = new DOMMatrixReadOnly(cs.transform === "none" ? undefined : cs.transform);
  const o = cs.transformOrigin.split(" ").map(parseFloat);
  const ox = o[0] || 0, oy = o[1] || 0;
  // the effective CSS map is s = o + M·(p − o), so p = o + M⁻¹·(s − o).
  const q = m.inverse().transformPoint(new DOMPoint(cx - fr.left - ox, cy - fr.top - oy));
  return { px: q.x + ox, py: q.y + oy, k: m.a, tx: m.e, ty: m.f,
           origem: cs.transformOrigin, W: f.clientWidth, H: f.clientHeight };
}`);
// pixel coverage: the magnified video has to cover the whole frame. this is
// the one that catches the pan detaching, because it compares rendered boxes.
await evalJS(`window.cobre = (id) => {
  const f = tiles.get(id).querySelector(".frame");
  const fr = f.getBoundingClientRect(), vr = f.querySelector("video").getBoundingClientRect();
  return { ok: vr.left <= fr.left + 1 && vr.top <= fr.top + 1 &&
               vr.right >= fr.right - 1 && vr.bottom >= fr.bottom - 1,
           quadro: [fr.left, fr.top, fr.right, fr.bottom].map(Math.round),
           video: [vr.left, vr.top, vr.right, vr.bottom].map(Math.round) };
}`);
const cx = Math.round(await evalJS(`(() => { const r = tiles.get("aaaa1111").querySelector(".frame").getBoundingClientRect(); return r.left + r.width / 2; })()`));
const cy = Math.round(await evalJS(`(() => { const r = tiles.get("aaaa1111").querySelector(".frame").getBoundingClientRect(); return r.top + r.height / 2; })()`));

const p0 = await evalJS(`pontoSob("aaaa1111", ${cx}, ${cy})`);
await roda(cx, cy, -120);
const p1 = await evalJS(`pontoSob("aaaa1111", ${cx}, ${cy})`);
checa("the wheel magnifies", p1.k > 1.05, `k=${p1.k}`);
checa("anchored on the 1st notch", Math.abs(p1.px - p0.px) < 1 && Math.abs(p1.py - p0.py) < 1,
  `(${p0.px.toFixed(1)},${p0.py.toFixed(1)}) -> (${p1.px.toFixed(1)},${p1.py.toFixed(1)})`);

await roda(cx, cy, -120);
const p2 = await evalJS(`pontoSob("aaaa1111", ${cx}, ${cy})`);
checa("the wheel accumulates", p2.k > p1.k + 0.05, `${p1.k} -> ${p2.k}`);
checa("anchored on the 2nd notch (t is no longer zero)",
  Math.abs(p2.px - p0.px) < 1 && Math.abs(p2.py - p0.py) < 1,
  `expected (${p0.px.toFixed(1)},${p0.py.toFixed(1)}), got (${p2.px.toFixed(1)},${p2.py.toFixed(1)})`);

await roda(cx, cy, -120);
const p3 = await evalJS(`pontoSob("aaaa1111", ${cx}, ${cy})`);
checa("anchored on the 3rd notch", Math.abs(p3.px - p0.px) < 1 && Math.abs(p3.py - p0.py) < 1,
  `expected (${p0.px.toFixed(1)},${p0.py.toFixed(1)}), got (${p3.px.toFixed(1)},${p3.py.toFixed(1)})`);

// a fourth notch at ANOTHER point, after a pan. the three before it, all at
// one point, do not distinguish `t' = t + (k−k')c`, which is algebraically
// identical to the correct rule while every zoom starts from the same c: if
// t = c(1−k) then t + c(k−k') = c(1−k'). it only diverges once t stops equalling
// c(1−k), that is, after a pan or at a second anchor point. without this case
// that variant passes the whole suite.
await arrasta(cx, cy, cx - 60, cy - 40);
const cx3 = cx + 180, cy3 = cy + 90;
const q0 = await evalJS(`pontoSob("aaaa1111", ${cx3}, ${cy3})`);
await roda(cx3, cy3, -120);
const q1 = await evalJS(`pontoSob("aaaa1111", ${cx3}, ${cy3})`);
checa("anchored at a second point, after a pan",
  Math.abs(q1.px - q0.px) < 1 && Math.abs(q1.py - q0.py) < 1,
  `expected (${q0.px.toFixed(1)},${q0.py.toFixed(1)}), got (${q1.px.toFixed(1)},${q1.py.toFixed(1)})`);
checa("the transform origin is the corner", q1.origem === "0px 0px", q1.origem);

// ceiling: not even an endless wheel passes ZOOM_MAX.
for (let i = 0; i < 12; i++) await roda(cx, cy, -240);
checa("the zoom ceiling holds", (await evalJS(`zooms.get("aaaa1111").k`)) <= 4.0001,
  String(await evalJS(`zooms.get("aaaa1111").k`)));

// confinement: dragging far hits the edge and stops. this is the assertion
// with teeth: scrollHeight will not do, because .tile has overflow: hidden and
// absorbs any overflow from the transformed descendant.
await arrasta(cx, cy, cx + 5000, cy);
let z = await evalJS(`zooms.get("aaaa1111")`);
checa("the pan does not detach on the right", Math.abs(z.x) < 0.5, `x=${z.x}`);
await arrasta(cx, cy, cx - 5000, cy);
z = await evalJS(`zooms.get("aaaa1111")`);
const lim = await evalJS(`(() => { const f = tiles.get("aaaa1111").querySelector(".frame");
  return f.clientWidth * (1 - zooms.get("aaaa1111").k); })()`);
checa("the pan does not detach on the left", Math.abs(z.x - lim) < 1, `x=${z.x} limit=${lim}`);
await arrasta(cx, cy, cx, cy - 5000);
z = await evalJS(`zooms.get("aaaa1111")`);
const limY = await evalJS(`(() => { const f = tiles.get("aaaa1111").querySelector(".frame");
  return f.clientHeight * (1 - zooms.get("aaaa1111").k); })()`);
checa("the pan does not detach at the top", Math.abs(z.y - limY) < 1, `y=${z.y} limit=${limY}`);

// the clamp pass inside layout() exists for this case, and it used to fail by
// measuring the box IN FLIGHT: .tile transitions width/height over .16s, so
// reading clientWidth in the same tick as place() returns the interpolated
// width. this assertion reads pixels, not the zooms object, which is how it
// once passed green while the tile rendered black.
await evalJS(`(() => { zooms.set("aaaa1111", { k: 4, x: -1e6, y: -1e6 }); applyZoom("aaaa1111"); })()`);
let cob = await evalJS(`cobre("aaaa1111")`);
checa("at 4× against the edge the video covers the frame", cob.ok, JSON.stringify(cob));
await evalJS(`document.getElementById("gridBtn").click()`);
await assenta();
cob = await evalJS(`cobre("aaaa1111")`);
checa("and still covers it on leaving focus (the box shrinks)", cob.ok, JSON.stringify(cob));
await tela(1100, 720);
await assenta();
cob = await evalJS(`cobre("aaaa1111")`);
checa("and still covers it on a smaller stage", cob.ok, JSON.stringify(cob));
await tela(1440, 900);
await assenta();
await evalJS(`toggleFocus("aaaa1111")`);
await assenta();

// the frame has to clip by itself: in fullscreen .tile leaves the flow and its
// overflow no longer reaches the scaled video.
checa("the frame clips the magnified video",
  (await evalJS(`getComputedStyle(tiles.get("aaaa1111").querySelector(".frame")).overflow`)) === "hidden",
  await evalJS(`getComputedStyle(tiles.get("aaaa1111").querySelector(".frame")).overflow`));

// the indicator: zoom is a mode, and a mode has to be visible. outside .tel,
// which needs .vivo (a live PC) and disappears at .narrow.
const ind = await evalJS(`(() => {
  const t = tiles.get("aaaa1111"), e = t.querySelector(".zoom");
  if (!e) return null;
  const cs = getComputedStyle(e);
  return { txt: e.textContent, vis: cs.display !== "none", dentroDoTel: !!e.closest(".tel"),
           upscale: e.classList.contains("up") };
})()`);
checa("the indicator exists and shows", !!ind && ind.vis, JSON.stringify(ind));
checa("the indicator states the factor", !!ind && /[\d.,]+\s*×/.test(ind.txt), JSON.stringify(ind?.txt));
checa("the indicator sits outside .tel", !!ind && !ind.dentroDoTel, JSON.stringify(ind));
checa("at 4× on a 1440 tile the indicator marks upscale", !!ind && ind.upscale === true, JSON.stringify(ind));

// the boundary, which is what the indicator exists to state: up to native,
// magnifying recovers detail that arrived and was thrown away by the fit; above
// it, it interpolates. testing only the 4× extreme does not prove the threshold
// sits in the right place.
const fronteira = await evalJS(`(() => {
  const t = tiles.get("aaaa1111"), f = t.querySelector(".frame"), v = t.querySelector("video");
  const nativo = v.videoWidth / (f.clientWidth * devicePixelRatio);
  const leia = (k) => { zooms.set("aaaa1111", { k, x: 0, y: 0 }); applyZoom("aaaa1111");
    return t.querySelector(".zoom").classList.contains("up"); };
  // probing below native only makes sense if native is above 1: at dpr >= 2 it
  // falls below, applyZoom treats it as identity and the test would pass for
  // the wrong reason. the bench runs at deviceScaleFactor 1 on purpose.
  if (nativo <= 1.1) return { nativo, abaixo: null, acima: null };
  return { nativo, abaixo: leia(nativo * 0.95), acima: leia(nativo * 1.05) };
})()`);
checa("below native is not upscale", fronteira.abaixo === false, JSON.stringify(fronteira));
checa("above native is upscale", fronteira.acima === true, JSON.stringify(fronteira));
checa("native is greater than 1 (the fit shrinks the video)", fronteira.nativo > 1,
  `native=${fronteira.nativo}`);

// a click does not yank away somebody reading up close, and the click after a
// pan does not focus.
checa("a click does not leave focus while zoomed", (await evalJS("focusId")) === "aaaa1111");
await clica(cx, cy);
checa("a click while zoomed does not change focus", (await evalJS("focusId")) === "aaaa1111",
  String(await evalJS("focusId")));

// resetting returns to identity with no phantom state.
await evalJS(`(() => { zooms.delete("aaaa1111"); applyZoom("aaaa1111"); })()`);
const limpo = await evalJS(`(() => {
  const t = tiles.get("aaaa1111");
  const e = t.querySelector(".zoom");
  return { tr: t.querySelector("video").style.transform, cls: t.querySelector(".frame").className,
           ind: e ? getComputedStyle(e).display : "ausente" };
})()`);
checa("resetting clears transform, class and indicator",
  limpo.tr === "" && !limpo.cls.includes("zoomed") && limpo.ind === "none", JSON.stringify(limpo));

// a thumbnail carries no zoom: in a 150px rail, focusing gives more pixels
// than any magnification, and there is no gesture there.
await evalJS(`(() => { focusId = null; render(); })()`);
await assenta();
const cx2 = Math.round(await evalJS(`(() => { const r = tiles.get("bbbb2222").querySelector(".frame").getBoundingClientRect(); return r.left + r.width / 2; })()`));
const cy2 = Math.round(await evalJS(`(() => { const r = tiles.get("bbbb2222").querySelector(".frame").getBoundingClientRect(); return r.top + r.height / 2; })()`));
await roda(cx2, cy2, -240);
checa("zoom works on an unfocused tile", (await evalJS(`zooms.has("bbbb2222")`)) === true);
await evalJS(`toggleFocus("aaaa1111")`);
await assenta();
checa("becoming a thumbnail discards the zoom", (await evalJS(`zooms.has("bbbb2222")`)) === false);
// and the wheel must not reopen it: on a thumbnail the indicator is hidden,
// .ctl covers the whole frame (no pan) and the click would stop focusing, which
// is the rail's only use.
const rc = Math.round(await evalJS(`(() => { const r = tiles.get("bbbb2222").querySelector(".frame").getBoundingClientRect(); return r.left + r.width / 2; })()`));
const rl = Math.round(await evalJS(`(() => { const r = tiles.get("bbbb2222").querySelector(".frame").getBoundingClientRect(); return r.top + r.height / 2; })()`));
await roda(rc, rl, -120);
checa("the wheel does not magnify a thumbnail", (await evalJS(`zooms.has("bbbb2222")`)) === false);
await clica(rc, rl);
await assenta();
checa("and the thumbnail is still focusable by click", (await evalJS("focusId")) === "bbbb2222",
  String(await evalJS("focusId")));

// layout intact under zoom: the transform plays no part in the fit.
await roda(cx, cy, -240);
await assenta();
m = await medir();
checa("the page does not scroll while zoomed", !m.rola, `${m.scrollH} > ${m.innerH}`);
checa("nothing overlaps while zoomed", dentro(m), JSON.stringify(m.tiles));
await shot("5b-zoom");

// does not contaminate the rest of the bench.
await evalJS(`(() => { for (const id of [...zooms.keys()]) { zooms.delete(id); applyZoom(id); }
  focusId = null; render(); })()`);
await assenta();
checa("the bench leaves zoom clean", (await evalJS("zooms.size")) === 0 && (await evalJS("focusId")) === null);

console.log("\n--- 430px wide ---");
await tela(430, 780);
await assenta();
await assenta();
m = await medir();
checa("the page does not scroll", !m.rola, `${m.scrollH} > ${m.innerH}`);
checa("nothing overlaps: dock, pill, label", dentro(m), JSON.stringify(m.tiles));
checa("name and telemetry do not overlap", m.pilulas.every(Boolean), JSON.stringify(m.pilulas));
checa("the tape drops before the number",
  (await evalJS(`[...document.querySelectorAll(".tile:not(.peer)")].every((t) => t.classList.contains("tight"))`)));
await shot("6-narrow");

console.log("\n--- name from the dock ---");
await tela(1440, 900);
await evalJS(`document.getElementById("meBtn").click()`);
await Bun.sleep(200);
checa("the dock opens the gate unblocked", await evalJS(`!document.getElementById("gate").hidden && !gateTrava`));
await digita("Gabriel");
await evalJS(`document.getElementById("gateGo").click()`);
await Bun.sleep(500);
checa("the name reaches the server and comes back", (await evalJS(`names.get(myId)`)) === "Gabriel", await evalJS("myName"));
const minhaPilula = await evalJS(`(() => {
  const w = [...document.querySelectorAll(".tile")].find((t) => t.dataset.id === myId).querySelector(".who");
  const em = w.querySelector("em");
  return { nome: w.querySelector("b").textContent, marca: em.textContent, visivel: getComputedStyle(em).display !== "none" };
})()`);
checa("my tile's pill states the name", minhaPilula.nome === "Gabriel", JSON.stringify(minhaPilula));
checa("and the (you) marker beside it", minhaPilula.marca === "(you)" && minhaPilula.visivel);

console.log("\n--- switching rooms ---");
const idAntes = await evalJS("myId");
await evalJS(`switchRoom("trabalho")`);
await Bun.sleep(900);
m = await medir();
checa("a new id from the server", !!m.myId && m.myId !== idAntes, `${idAntes} -> ${m.myId}`);
checa("the stage is clear", m.tiles.length === 0, String(m.tiles.length));
checa("the hash follows", (await evalJS("location.hash")) === "#trabalho", await evalJS("location.hash"));
checa("the pill follows", (await evalJS(`document.getElementById("topRoom").textContent`)) === "#trabalho");
checa("the page does not scroll", !m.rola, `${m.scrollH} > ${m.innerH}`);
await shot("7-room-switch");

console.log(falhas.length ? `\n${falhas.length} FAILURE(S): ${falhas.join(", ")}` : "\nall green");
ws.close();
proc.kill();
process.exit(falhas.length ? 1 : 0);

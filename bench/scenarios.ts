import { capture, evalJS, setTouch, setViewport } from "./cdp.ts";
import { clickAt, drag, wheel } from "./input.ts";
import type { TileInfo } from "./measure.ts";
import { allInside, measure, settle } from "./measure.ts";

export type CheckFn = (name: string, cond: boolean, detail?: string) => void;

type PointUnder = {
	px: number;
	py: number;
	k: number;
	tx: number;
	ty: number;
	origin: string;
	W: number;
	H: number;
};

type Covers = {
	ok: boolean;
	quadro: number[];
	video: number[];
};

type ZoomState = { k: number; x: number; y: number };

type Indicator = {
	txt: string;
	vis: boolean;
	insideTel: boolean;
	upscale: boolean;
} | null;

type Boundary = {
	native: number;
	below: boolean | null;
	above: boolean | null;
};

type MyPill = { name: string; marker: string; visible: boolean };

type CleanState = { tr: string; cls: string; ind: string };

async function typeText(v: string): Promise<void> {
	await evalJS(`(() => {
    const n = document.getElementById("gateName");
    n.value = ${JSON.stringify(v)};
    n.dispatchEvent(new Event("input"));
  })()`);
}

export async function gateScenario(check: CheckFn): Promise<void> {
	console.log("\n--- gate: the name is mandatory and the modal is the door ---");
	let m = await measure();
	check("the gate opens by itself", m.gate === true);
	check("no room joined before a name", m.myId === null, String(m.myId));
	check("the enter button starts disabled", m.goOff === true);
	check("the page does not scroll", !m.scrolls, `${m.scrollH} > ${m.innerH}`);
	await capture("1-gate");

	await evalJS(`(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  document.getElementById("gateScrim").click();
})()`);
	await Bun.sleep(200);
	m = await measure();
	check("esc and an outside click do not close it unnamed", m.gate === true);

	await typeText("GM");
	check(
		"2 letters do not pass",
		(await evalJS<boolean>(`document.getElementById("gateGo").disabled`)) === true,
	);
	await typeText("GMG");
	check(
		"3 letters pass",
		(await evalJS<boolean>(`document.getElementById("gateGo").disabled`)) === false,
	);

	await evalJS(`document.getElementById("gateGo").click()`);
	for (let i = 0; i < 40 && !(await evalJS<boolean>("!!myId")); i++) await Bun.sleep(200);
	m = await measure();
	check("joined after answering", !!m.myId && m.gate === false, `${m.myId} gate=${m.gate}`);
}

// the one canvas stream the scenarios inject. it was defined twice with
// different framerates and different content, and a stream that draws once and
// a stream that animates are not interchangeable: an assertion that needs live
// frames passes under one and hangs under the other, for a reason that is
// nowhere in the assertion. installing it is idempotent, so a scenario can be
// run on its own without depending on which one ran before it.
const INSTALL_FAKE = `(() => {
  if (window.fake) return;
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
})()`;

export async function callScenario(check: CheckFn): Promise<void> {
	// a populated room: the call grid of everybody not transmitting.
	await evalJS(INSTALL_FAKE);
	await evalJS(`(() => {
  peers.add("aaaa1111"); peers.add("bbbb2222"); peers.add("cccc3333");
  names.set("aaaa1111", "GRO"); names.set("bbbb2222", "Malu"); names.set("cccc3333", "Ana");
  sharers = new Set();
  render();
})()`);
	await settle();
	let m = await measure();
	console.log("\n--- 4 in the room, nobody transmitting (the call) ---");
	check("the page does not scroll", !m.scrolls, `${m.scrollH} > ${m.innerH}`);
	check(
		"everybody has a tile",
		m.tiles.length === 4 && m.tiles.every((t: TileInfo) => t.peer),
		String(m.tiles.length),
	);
	check("nothing overlaps: dock, pill, label", allInside(m), JSON.stringify(m.tiles));
	check(
		"equal cells for everybody",
		new Set(m.tiles.map((t: TileInfo) => Math.round(t.h))).size === 1,
		JSON.stringify(m.tiles.map((t: TileInfo) => Math.round(t.h))),
	);
	check(
		"the pill counts the room",
		m.topBar.length === 4 &&
			m.topBar[0] === "#room" &&
			/^\d+:\d{2}(:\d{2})?$/.test(m.topBar[1] ?? "") &&
			m.topBar[2] === "0/3 on air" &&
			m.topBar[3] === "4 in the room",
		JSON.stringify(m.topBar),
	);
	await capture("2-call-no-video");

	console.log("\n--- 1 screen on air: video rules, presence drops to the rail ---");
	await evalJS(
		`(() => { sharers = new Set(["aaaa1111"]); render(); attachTile("aaaa1111", fake(1600, 900)); })()`,
	);
	await settle();
	m = await measure();
	const video = m.tiles.filter((t: TileInfo) => !t.peer);
	const placas = m.tiles.filter((t: TileInfo) => t.peer);
	check("the page does not scroll", !m.scrolls, `${m.scrollH} > ${m.innerH}`);
	check("nothing overlaps: dock, pill, label", allInside(m), JSON.stringify(m.tiles));
	check("1 video and 3 monograms", video.length === 1 && placas.length === 3);
	check(
		"the presence rail is capped",
		placas.every((p: TileInfo) => p.h <= 132),
		JSON.stringify(placas.map((p: TileInfo) => p.h)),
	);
	if (!video[0] || !placas[0]) throw new Error("missing video or placa tile");
	check(
		"the video is bigger than the rail",
		video[0].h > placas[0].h * 2,
		`${video[0].h} vs ${placas[0].h}`,
	);
	check(
		"aspect ratio preserved",
		Math.abs(video[0].vw / video[0].vh - 16 / 9) < 0.02,
		`${video[0].vw}×${video[0].vh}`,
	);
	await capture("3-one-video");

	console.log("\n--- 2 screens, different aspect ratios ---");
	await evalJS(
		`(() => { sharers = new Set(["aaaa1111","bbbb2222"]); render(); attachTile("bbbb2222", fake(1440, 900)); })()`,
	);
	await settle();
	m = await measure();
	const vids = m.tiles.filter((t: TileInfo) => !t.peer);
	check("the page does not scroll", !m.scrolls, `${m.scrollH} > ${m.innerH}`);
	check("nothing overlaps: dock, pill, label", allInside(m), JSON.stringify(m.tiles));
	check("two videos on stage", vids.length === 2, String(vids.length));
	if (!vids[0] || !vids[1]) throw new Error("missing vids");
	check(
		"justified row: same height",
		Math.abs(vids[0].h - vids[1].h) < 2,
		`${vids[0].h} vs ${vids[1].h}`,
	);
	await capture("4-two-videos");
}

export async function focusScenario(check: CheckFn): Promise<void> {
	console.log("\n--- focus ---");
	await evalJS(`toggleFocus("aaaa1111")`);
	await settle();
	const m = await measure();
	const foco = m.tiles.find((t: TileInfo) => t.id === "aaaa1111");
	const mini = m.tiles.find((t: TileInfo) => t.id === "bbbb2222");
	if (!foco || !mini)
		throw new Error(`missing foco/mini: ${JSON.stringify(m.tiles.map((t) => t.id))}`);
	check("the page does not scroll", !m.scrolls, `${m.scrollH} > ${m.innerH}`);
	check("nothing overlaps: dock, pill, label", allInside(m), JSON.stringify(m.tiles));
	check(
		"the focused one is bigger than the thumbnail",
		foco.w > mini.w * 2,
		`${foco.w} vs ${mini.w}`,
	);
	check(
		"the grid button lights up in focus",
		(await evalJS<boolean>(`document.getElementById("gridBtn").disabled`)) === false,
	);
	await capture("5-focus");

	await evalJS(`document.getElementById("gridBtn").click()`);
	await settle();
	check("the grid button leaves focus", (await evalJS<string | null>("focusId")) === null);
}

export async function zoomScenario(check: CheckFn): Promise<void> {
	console.log("\n--- receiver-side zoom ---");
	// anchoring: the point of video under the cursor must not move. in element
	// coordinates, with origin 0 0 and the map s = k·p + t, that point is
	// p = (c − t)/k. the wrong formula breaks it from the SECOND notch on, once t
	// stops being zero; the first passes in any version, hence two notches.
	await evalJS(`toggleFocus("aaaa1111")`);
	await settle();
	await evalJS(`window.pointUnder = (id, cx, cy) => {
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
           origin: cs.transformOrigin, W: f.clientWidth, H: f.clientHeight };
}`);
	// pixel coverage: the magnified video has to cover the whole frame. this is
	// the one that catches the pan detaching, because it compares rendered boxes.
	await evalJS(`window.coversFrame = (id) => {
  const f = tiles.get(id).querySelector(".frame");
  const fr = f.getBoundingClientRect(), vr = f.querySelector("video").getBoundingClientRect();
  return { ok: vr.left <= fr.left + 1 && vr.top <= fr.top + 1 &&
               vr.right >= fr.right - 1 && vr.bottom >= fr.bottom - 1,
           quadro: [fr.left, fr.top, fr.right, fr.bottom].map(Math.round),
           video: [vr.left, vr.top, vr.right, vr.bottom].map(Math.round) };
}`);
	const cx = Math.round(
		await evalJS<number>(
			`(() => { const r = tiles.get("aaaa1111").querySelector(".frame").getBoundingClientRect(); return r.left + r.width / 2; })()`,
		),
	);
	const cy = Math.round(
		await evalJS<number>(
			`(() => { const r = tiles.get("aaaa1111").querySelector(".frame").getBoundingClientRect(); return r.top + r.height / 2; })()`,
		),
	);

	const p0 = await evalJS<PointUnder>(`pointUnder("aaaa1111", ${cx}, ${cy})`);
	await wheel(cx, cy, -120);
	const p1 = await evalJS<PointUnder>(`pointUnder("aaaa1111", ${cx}, ${cy})`);
	check("the wheel magnifies", p1.k > 1.05, `k=${p1.k}`);
	check(
		"anchored on the 1st notch",
		Math.abs(p1.px - p0.px) < 1 && Math.abs(p1.py - p0.py) < 1,
		`(${p0.px.toFixed(1)},${p0.py.toFixed(1)}) -> (${p1.px.toFixed(1)},${p1.py.toFixed(1)})`,
	);

	await wheel(cx, cy, -120);
	const p2 = await evalJS<PointUnder>(`pointUnder("aaaa1111", ${cx}, ${cy})`);
	check("the wheel accumulates", p2.k > p1.k + 0.05, `${p1.k} -> ${p2.k}`);
	check(
		"anchored on the 2nd notch (t is no longer zero)",
		Math.abs(p2.px - p0.px) < 1 && Math.abs(p2.py - p0.py) < 1,
		`expected (${p0.px.toFixed(1)},${p0.py.toFixed(1)}), got (${p2.px.toFixed(1)},${p2.py.toFixed(1)})`,
	);

	await wheel(cx, cy, -120);
	const p3 = await evalJS<PointUnder>(`pointUnder("aaaa1111", ${cx}, ${cy})`);
	check(
		"anchored on the 3rd notch",
		Math.abs(p3.px - p0.px) < 1 && Math.abs(p3.py - p0.py) < 1,
		`expected (${p0.px.toFixed(1)},${p0.py.toFixed(1)}), got (${p3.px.toFixed(1)},${p3.py.toFixed(1)})`,
	);

	// a fourth notch at ANOTHER point, after a pan. the three before it, all at
	// one point, do not distinguish `t' = t + (k−k')c`, which is algebraically
	// identical to the correct rule while every zoom starts from the same c: if
	// t = c(1−k) then t + c(k−k') = c(1−k'). it only diverges once t stops equalling
	// c(1−k), that is, after a pan or at a second anchor point. without this case
	// that variant passes the whole suite.
	await drag(cx, cy, cx - 60, cy - 40);
	const cx3 = cx + 180,
		cy3 = cy + 90;
	const q0 = await evalJS<PointUnder>(`pointUnder("aaaa1111", ${cx3}, ${cy3})`);
	await wheel(cx3, cy3, -120);
	const q1 = await evalJS<PointUnder>(`pointUnder("aaaa1111", ${cx3}, ${cy3})`);
	check(
		"anchored at a second point, after a pan",
		Math.abs(q1.px - q0.px) < 1 && Math.abs(q1.py - q0.py) < 1,
		`expected (${q0.px.toFixed(1)},${q0.py.toFixed(1)}), got (${q1.px.toFixed(1)},${q1.py.toFixed(1)})`,
	);
	check("the transform origin is the corner", q1.origin === "0px 0px", q1.origin);

	// ceiling: not even an endless wheel passes ZOOM_MAX.
	for (let i = 0; i < 12; i++) await wheel(cx, cy, -240);
	check(
		"the zoom ceiling holds",
		(await evalJS<number>(`zooms.get("aaaa1111").k`)) <= 4.0001,
		String(await evalJS<number>(`zooms.get("aaaa1111").k`)),
	);

	// confinement: dragging far hits the edge and stops. this is the assertion
	// with teeth: scrollHeight will not do, because .tile has overflow: hidden and
	// absorbs any overflow from the transformed descendant.
	await drag(cx, cy, cx + 5000, cy);
	let z = await evalJS<ZoomState>(`zooms.get("aaaa1111")`);
	if (!z) throw new Error("missing zoom state after drag right");
	check("the pan does not detach on the right", Math.abs(z.x) < 0.5, `x=${z.x}`);
	await drag(cx, cy, cx - 5000, cy);
	z = await evalJS<ZoomState>(`zooms.get("aaaa1111")`);
	if (!z) throw new Error("missing zoom state after drag left");
	const lim = await evalJS<number>(
		`(() => { const f = tiles.get("aaaa1111").querySelector(".frame");
  return f.clientWidth * (1 - zooms.get("aaaa1111").k); })()`,
	);
	check("the pan does not detach on the left", Math.abs(z.x - lim) < 1, `x=${z.x} limit=${lim}`);
	await drag(cx, cy, cx, cy - 5000);
	z = await evalJS<ZoomState>(`zooms.get("aaaa1111")`);
	if (!z) throw new Error("missing zoom state after drag top");
	const limY = await evalJS<number>(
		`(() => { const f = tiles.get("aaaa1111").querySelector(".frame");
  return f.clientHeight * (1 - zooms.get("aaaa1111").k); })()`,
	);
	check("the pan does not detach at the top", Math.abs(z.y - limY) < 1, `y=${z.y} limit=${limY}`);

	// the clamp pass inside layout() exists for this case, and it used to fail by
	// measuring the box IN FLIGHT: .tile transitions width/height over .16s, so
	// reading clientWidth in the same tick as place() returns the interpolated
	// width. this assertion reads pixels, not the zooms object, which is how it
	// once passed green while the tile rendered black.
	await evalJS(
		`(() => { zooms.set("aaaa1111", { k: 4, x: -1e6, y: -1e6 }); applyZoom("aaaa1111"); })()`,
	);
	let cob = await evalJS<Covers>(`coversFrame("aaaa1111")`);
	check("at 4× against the edge the video covers the frame", cob.ok, JSON.stringify(cob));
	await evalJS(`document.getElementById("gridBtn").click()`);
	await settle();
	cob = await evalJS<Covers>(`coversFrame("aaaa1111")`);
	check("and still covers it on leaving focus (the box shrinks)", cob.ok, JSON.stringify(cob));
	await setViewport(1100, 720);
	await settle();
	cob = await evalJS<Covers>(`coversFrame("aaaa1111")`);
	check("and still covers it on a smaller stage", cob.ok, JSON.stringify(cob));
	await setViewport(1440, 900);
	await settle();
	await evalJS(`toggleFocus("aaaa1111")`);
	await settle();

	// the frame has to clip by itself: in fullscreen .tile leaves the flow and its
	// overflow no longer reaches the scaled video.
	check(
		"the frame clips the magnified video",
		(await evalJS<string>(
			`getComputedStyle(tiles.get("aaaa1111").querySelector(".frame")).overflow`,
		)) === "hidden",
		await evalJS<string>(
			`getComputedStyle(tiles.get("aaaa1111").querySelector(".frame")).overflow`,
		),
	);

	// the indicator: zoom is a mode, and a mode has to be visible. outside .tel,
	// which needs .vivo (a live PC) and disappears at .narrow.
	const ind = await evalJS<Indicator>(`(() => {
  const t = tiles.get("aaaa1111"), e = t.querySelector(".zoom");
  if (!e) return null;
  const cs = getComputedStyle(e);
  return { txt: e.textContent, vis: cs.display !== "none", insideTel: !!e.closest(".tel"),
           upscale: e.classList.contains("up") };
})()`);
	check("the indicator exists and shows", !!ind && ind.vis, JSON.stringify(ind));
	check(
		"the indicator states the factor",
		!!ind && /[\d.,]+\s*×/.test(ind.txt ?? ""),
		JSON.stringify(ind?.txt),
	);
	check("the indicator sits outside .tel", !!ind && !ind.insideTel, JSON.stringify(ind));
	check(
		"at 4× on a 1440 tile the indicator marks upscale",
		!!ind && ind.upscale === true,
		JSON.stringify(ind),
	);

	// the boundary, which is what the indicator exists to state: up to native,
	// magnifying recovers detail that arrived and was thrown away by the fit; above
	// it, it interpolates. testing only the 4× extreme does not prove the threshold
	// sits in the right place.
	const boundary = await evalJS<Boundary>(`(() => {
  const t = tiles.get("aaaa1111"), f = t.querySelector(".frame"), v = t.querySelector("video");
  const native = v.videoWidth / (f.clientWidth * devicePixelRatio);
  const leia = (k) => { zooms.set("aaaa1111", { k, x: 0, y: 0 }); applyZoom("aaaa1111");
    return t.querySelector(".zoom").classList.contains("up"); };
  // probing below native only makes sense if native is above 1: at dpr >= 2 it
  // falls below, applyZoom treats it as identity and the test would pass for
  // the wrong reason. the bench runs at deviceScaleFactor 1 on purpose.
  if (native <= 1.1) return { native, below: null, above: null };
  return { native, below: leia(native * 0.95), above: leia(native * 1.05) };
})()`);
	check("below native is not upscale", boundary.below === false, JSON.stringify(boundary));
	check("above native is upscale", boundary.above === true, JSON.stringify(boundary));
	check(
		"native is greater than 1 (the fit shrinks the video)",
		boundary.native > 1,
		`native=${boundary.native}`,
	);

	// a click does not yank away somebody reading up close, and the click after a
	// pan does not focus.
	check(
		"a click does not leave focus while zoomed",
		(await evalJS<string | null>("focusId")) === "aaaa1111",
	);
	await clickAt(cx, cy);
	check(
		"a click while zoomed does not change focus",
		(await evalJS<string | null>("focusId")) === "aaaa1111",
		String(await evalJS<string | null>("focusId")),
	);

	// resetting returns to identity with no phantom state.
	await evalJS(`(() => { zooms.delete("aaaa1111"); applyZoom("aaaa1111"); })()`);
	const cleanState = await evalJS<CleanState>(`(() => {
  const t = tiles.get("aaaa1111");
  const e = t.querySelector(".zoom");
  return { tr: t.querySelector("video").style.transform, cls: t.querySelector(".frame").className,
           ind: e ? getComputedStyle(e).display : "ausente" };
})()`);
	check(
		"resetting clears transform, class and indicator",
		cleanState.tr === "" && !cleanState.cls.includes("zoomed") && cleanState.ind === "none",
		JSON.stringify(cleanState),
	);

	// a thumbnail carries no zoom: in a 150px rail, focusing gives more pixels
	// than any magnification, and there is no gesture there.
	await evalJS(`(() => { focusId = null; render(); })()`);
	await settle();
	const cx2 = Math.round(
		await evalJS<number>(
			`(() => { const r = tiles.get("bbbb2222").querySelector(".frame").getBoundingClientRect(); return r.left + r.width / 2; })()`,
		),
	);
	const cy2 = Math.round(
		await evalJS<number>(
			`(() => { const r = tiles.get("bbbb2222").querySelector(".frame").getBoundingClientRect(); return r.top + r.height / 2; })()`,
		),
	);
	await wheel(cx2, cy2, -240);
	check(
		"zoom works on an unfocused tile",
		(await evalJS<boolean>(`zooms.has("bbbb2222")`)) === true,
	);
	await evalJS(`toggleFocus("aaaa1111")`);
	await settle();
	check(
		"becoming a thumbnail discards the zoom",
		(await evalJS<boolean>(`zooms.has("bbbb2222")`)) === false,
	);
	// and the wheel must not reopen it: on a thumbnail the indicator is hidden,
	// .ctl covers the whole frame (no pan) and the click would stop focusing, which
	// is the rail's only use.
	const rc = Math.round(
		await evalJS<number>(
			`(() => { const r = tiles.get("bbbb2222").querySelector(".frame").getBoundingClientRect(); return r.left + r.width / 2; })()`,
		),
	);
	const rl = Math.round(
		await evalJS<number>(
			`(() => { const r = tiles.get("bbbb2222").querySelector(".frame").getBoundingClientRect(); return r.top + r.height / 2; })()`,
		),
	);
	await wheel(rc, rl, -120);
	check(
		"the wheel does not magnify a thumbnail",
		(await evalJS<boolean>(`zooms.has("bbbb2222")`)) === false,
	);
	await clickAt(rc, rl);
	await settle();
	check(
		"and the thumbnail is still focusable by click",
		(await evalJS<string | null>("focusId")) === "bbbb2222",
		String(await evalJS<string | null>("focusId")),
	);

	// layout intact under zoom: the transform plays no part in the fit.
	await wheel(cx, cy, -240);
	await settle();
	const m = await measure();
	check("the page does not scroll while zoomed", !m.scrolls, `${m.scrollH} > ${m.innerH}`);
	check("nothing overlaps while zoomed", allInside(m), JSON.stringify(m.tiles));
	await capture("5b-zoom");

	// does not contaminate the rest of the bench.
	await evalJS(`(() => { for (const id of [...zooms.keys()]) { zooms.delete(id); applyZoom(id); }
  focusId = null; render(); })()`);
	await settle();
	check(
		"the bench leaves zoom clean",
		(await evalJS<number>("zooms.size")) === 0 && (await evalJS<string | null>("focusId")) === null,
	);
}

export async function narrowScenario(check: CheckFn): Promise<void> {
	console.log("\n--- 430px wide ---");
	await setViewport(430, 780);
	await settle();
	await settle();
	const m = await measure();
	check("the page does not scroll", !m.scrolls, `${m.scrollH} > ${m.innerH}`);
	check("nothing overlaps: dock, pill, label", allInside(m), JSON.stringify(m.tiles));
	check("name and telemetry do not overlap", m.pills.every(Boolean), JSON.stringify(m.pills));
	check(
		"the tape drops before the number",
		await evalJS<boolean>(
			`[...document.querySelectorAll(".tile:not(.peer)")].every((t) => t.classList.contains("tight"))`,
		),
	);
	await capture("6-narrow");
}

export async function roomScenario(check: CheckFn): Promise<void> {
	console.log("\n--- name from the dock ---");
	await setViewport(1440, 900);
	await evalJS(`document.getElementById("meBtn").click()`);
	await Bun.sleep(200);
	check(
		"the dock opens the gate unblocked",
		await evalJS<boolean>(`!document.getElementById("gate").hidden && !gateLocked`),
	);
	await typeText("Gabriel");
	await evalJS(`document.getElementById("gateGo").click()`);
	await Bun.sleep(500);
	check(
		"the name reaches the server and comes back",
		(await evalJS<string | undefined>(`names.get(myId)`)) === "Gabriel",
		await evalJS<string>("myName"),
	);
	const myPill = await evalJS<MyPill>(`(() => {
  const w = [...document.querySelectorAll(".tile")].find((t) => t.dataset.id === myId).querySelector(".who");
  const em = w.querySelector("em");
  return { name: w.querySelector("b").textContent, marker: em.textContent, visible: getComputedStyle(em).display !== "none" };
})()`);
	check("my tile's pill states the name", myPill.name === "Gabriel", JSON.stringify(myPill));
	check("and the (you) marker beside it", myPill.marker === "(you)" && myPill.visible === true);

	console.log("\n--- switching rooms ---");
	const idAntes = await evalJS<string | null>("myId");
	await evalJS(`switchRoom("trabalho")`);
	await Bun.sleep(900);
	const m = await measure();
	check("a new id from the server", !!m.myId && m.myId !== idAntes, `${idAntes} -> ${m.myId}`);
	check("the stage is clear", m.tiles.length === 0, String(m.tiles.length));
	check(
		"the hash follows",
		(await evalJS<string>("location.hash")) === "#trabalho",
		await evalJS<string>("location.hash"),
	);
	check(
		"the pill follows",
		(await evalJS<string>(`document.getElementById("topRoom").textContent`)) === "#trabalho",
	);
	check("the page does not scroll", !m.scrolls, `${m.scrollH} > ${m.innerH}`);
	await capture("7-room-switch");
}

type QualProbe = {
	emptyPolicy: string | null;
	emptyDeg: string | undefined;
	onePolicy: string | null;
	oneBitrate: number | undefined;
	oneFps: number | undefined;
};

type MenuBox = { left: number; top: number; right: number; bottom: number; items: number };

// the profile selector, and the regression under it.
//
// what cannot be checked here is the encoder: no remote peer, no real sender.
// what can, and is the whole point, is that an empty `encodings` no longer
// takes `degradationPreference` down with it. that ordering is what turned a
// 1600×900 capture into 640×360 on the machine that reported it, and a fake
// sender reproduces the shape exactly: getParameters() answering with an empty
// list is one object literal.
export async function qualityScenario(check: CheckFn): Promise<void> {
	console.log("\n--- capture quality ---");
	await setViewport(1440, 900);
	await settle();

	check(
		"the dock offers the selector, on the default profile",
		await evalJS<boolean>(`(() => {
  const b = document.getElementById("qualBtn");
  return !!b && !b.disabled && !b.classList.contains("on") && quality === QUALITY_DEFAULT;
})()`),
		await evalJS<string>(`quality`),
	);

	const qualBtnAt = await evalJS<{ x: number; y: number }>(`(() => {
  const r = document.getElementById("qualBtn").getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
	const menuShown = () =>
		evalJS<boolean>(`getComputedStyle(document.getElementById("qmenu")).display !== "none"`);
	const itemAt = (key: string) =>
		evalJS<{ x: number; y: number }>(`(() => {
  const r = document.querySelector('#qmenu [data-q="${key}"]').getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);

	await clickAt(qualBtnAt.x, qualBtnAt.y);
	await Bun.sleep(150);
	const box = await evalJS<MenuBox>(`(() => {
  const m = document.getElementById("qmenu").getBoundingClientRect();
  return { left: m.left, top: m.top, right: m.right, bottom: m.bottom,
           items: document.querySelectorAll("#qmenu [data-q]").length };
})()`);
	check("it opens with one item per profile", box.items === 3, JSON.stringify(box));
	check(
		"and lands inside the viewport, above the dock",
		box.left >= 0 && box.top >= 0 && box.right <= 1440 && box.bottom <= 900,
		JSON.stringify(box),
	);
	// `position: fixed` is what keeps it out of the stage the tiles are fitted
	// into. a menu in the flow would extend the document and scroll the page,
	// which is the one thing this whole layout exists to prevent.
	const m1 = await measure();
	check("the page does not scroll with it open", !m1.scrolls, `${m1.scrollH} > ${m1.innerH}`);
	await capture("7-quality");
	check(
		"the checked item is the active profile",
		(await evalJS<string | null>(
			`document.querySelector('#qmenu [aria-checked="true"]').dataset.q`,
		)) === (await evalJS<string>(`quality`)),
	);

	await evalJS(
		`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
	);
	await Bun.sleep(80);
	// the computed display, never the `hidden` attribute. `.qmenu { display:
	// flex }` outranks the browser's `[hidden]` rule, so the attribute was set
	// correctly while the menu stayed on screen taking clicks, and an assertion
	// reading the attribute passed through the whole defect.
	check("esc closes it", (await menuShown()) === false && !(await evalJS<boolean>(`qualOpen`)));
	check(
		"and the focus returns to the button",
		await evalJS<boolean>(`document.activeElement === document.getElementById("qualBtn")`),
	);

	// real clicks from here down: the menu is dismissed by pointerdown, and a
	// synthetic .click() never fires one.
	await clickAt(qualBtnAt.x, qualBtnAt.y);
	await Bun.sleep(150);
	const textItem = await itemAt("text");
	await clickAt(textItem.x, textItem.y);
	await Bun.sleep(250);
	// the mark used to be rewritten only by openQual(), so the menu closed still
	// showing the previous profile ticked and the click read as ignored.
	check(
		"choosing a profile marks it at once",
		(await evalJS<string>(
			`[...document.querySelectorAll("#qmenu [data-q]")].map((b) => b.dataset.q + ":" + b.getAttribute("aria-checked")).join(" ")`,
		)) === "text:true sharp:false motion:false",
		await evalJS<string>(`quality`),
	);
	check(
		"and colours the button, and stays open to compare",
		(await evalJS<boolean>(`(() => {
  const b = document.getElementById("qualBtn");
  return quality === "text" && b.classList.contains("on") && b.title.includes("Text");
})()`)) && (await menuShown()) === true,
		await evalJS<string>(`document.getElementById("qualBtn").title`),
	);
	check(
		"and it survives a reload",
		(await evalJS<string | null>(`localStorage.getItem(QUALITY_KEY)`)) === "text",
	);

	// clicking the stage is how the menu is dismissed in practice, and the
	// tiles answer pointerdown, so the close has to happen there and not on
	// click.
	await clickAt(720, 300);
	await Bun.sleep(150);
	check("a click outside closes it", (await menuShown()) === false);
	const under = await evalJS<{ inMenu: boolean; what: string }>(`(() => {
  const el = document.elementFromPoint(${textItem.x}, ${textItem.y});
  return {
    inMenu: !!el?.closest("#qmenu"),
    what: el ? el.tagName + " q=" + (el.closest("[data-q]")?.dataset.q ?? "-") : "nothing",
  };
})()`);
	check("and the closed menu takes no clicks", !under.inMenu, under.what);

	const probe = await evalJS<QualProbe>(`(async () => {
  const mk = (encodings) => {
    let seen = null;
    const sender = {
      track: { kind: "video" },
      getParameters: () => seen || { encodings: encodings.map((e) => ({ ...e })) },
      setParameters: async (p) => { seen = p; },
    };
    return { getSenders: () => [sender], read: () => seen };
  };
  // the throw is caught here rather than left to kill the run: the mutant
  // below throws OUTSIDE applyEncoding's own try, and a stack trace is a worse
  // answer than a red line naming the assertion.
  const run = async (pc) => {
    try { await applyEncoding(pc); } catch (e) { pc.policy = "threw: " + (e?.name || e); }
  };
  const empty = mk([]);
  await run(empty);
  const one = mk([{}]);
  await run(one);
  return {
    emptyPolicy: empty.policy ?? null,
    emptyDeg: empty.read()?.degradationPreference,
    onePolicy: one.policy ?? null,
    oneBitrate: one.read()?.encodings?.[0]?.maxBitrate,
    oneFps: one.read()?.encodings?.[0]?.maxFramerate,
  };
})()`);
	// the mutant: move `params.degradationPreference = ...` back under the
	// encodings assignment and this one goes red with "policy refused:
	// TypeError", which is the bug as it shipped.
	check(
		"an empty encodings list still gets the policy",
		probe.emptyDeg === "maintain-resolution",
		JSON.stringify(probe),
	);
	check(
		"and says so instead of reporting a refusal",
		probe.emptyPolicy === "no encodings",
		String(probe.emptyPolicy),
	);
	check(
		"a normal sender takes the profile's bitrate and framerate",
		probe.oneBitrate === 4_000_000 && probe.oneFps === 5 && probe.onePolicy === null,
		JSON.stringify(probe),
	);

	// a locked target is the difference between a stable stream and a negotiated
	// one, so it has to survive the server's budget rather than scale with it.
	const budgets = await evalJS<{ motion: number; sharp: number; cap: number }>(
		`({ motion: budgetOf(QUALITY.motion), sharp: budgetOf(QUALITY.sharp), cap: maxCapturePixels })`,
	);
	check(
		"Motion locks its target at 720p, under the server's budget",
		budgets.motion === 1280 * 720 && budgets.sharp === budgets.cap,
		`${budgets.motion} of ${budgets.cap}`,
	);
	await evalJS(`setQuality("motion")`);
	await Bun.sleep(250);
	const fCap = await evalJS<string>(`document.getElementById("fCap").textContent`);
	check("and the empty card announces that, not the budget", fCap === "up to 1280×720", fCap);

	// the general rule, not this menu's copy of it: every hideable element at
	// once, measured as pixels. `#installBtn` was on screen with `hidden` set in
	// every browser that never fires beforeinstallprompt, and nothing here would
	// have caught it, because each element carried its own override and this one
	// had none.
	// every element, not the five that happened to use `hidden` the day this was
	// written: nobody writes down the name of the element they forgot, which is
	// exactly how `#installBtn` spent a release on screen with `hidden` set. the
	// attribute is set with toggleAttribute so the source buttons' SVG icons are
	// covered too -- they have no `hidden` IDL property, which is its own trap.
	// one evaluation, because the second copy of a probe is where the list drifts
	// and the failure message stops describing the failure.
	const hid = await evalJS<string>(`(() => {
  const bad = [];
  for (const el of document.querySelectorAll("*")) {
    const was = el.hasAttribute("hidden");
    el.toggleAttribute("hidden", true);
    const d = getComputedStyle(el).display;
    if (d !== "none") bad.push((el.id || el.tagName.toLowerCase()) + "=" + d);
    el.toggleAttribute("hidden", was);
  }
  return bad.join(" ");
})()`);
	check("`hidden` actually hides, on every element in the page", hid === "", hid);

	await evalJS(`setQuality(QUALITY_DEFAULT)`);
	await Bun.sleep(150);
	check(
		"the bench leaves the default profile behind",
		await evalJS<boolean>(
			`quality === QUALITY_DEFAULT && !document.getElementById("qualBtn").classList.contains("on")`,
		),
	);

	// the cut, read back rather than assumed. reported from the field on a
	// 2560×1440 screen: the sharer's strip read `2560×1440 → 640×360 · 30fps
	// bandwidth`, and switching profile and back fixed it — the same call, the
	// same arguments, working seconds later. so the source is one that swallows
	// the first applyConstraints and honours the rest, which is what a screen
	// capture with no sink did, and the assertion is on what getSettings()
	// says afterwards, never on the call having resolved.
	const cut = await evalJS<{
		took: string;
		policy: string | null;
		refused: string;
		refusedPolicy: string | null;
	}>(
		`(async () => {
  const src = { width: 2560, height: 1440 };
  const make = (swallow) => {
    const c = document.createElement("canvas");
    c.width = src.width; c.height = src.height;
    const g = c.getContext("2d");
    const draw = () => { g.fillStyle = "#0b1416"; g.fillRect(0, 0, c.width, c.height); };
    setInterval(draw, 66); draw();
    const s = c.captureStream(30);
    const t = s.getVideoTracks()[0];
    const real = t.applyConstraints.bind(t);
    let left = swallow;
    t.applyConstraints = (x) => (left-- > 0 ? Promise.resolve() : real(x));
    return s;
  };
  const keep = local.get("screen");
  const run = async (swallow) => {
    const cap = { stream: make(swallow), geom: { ...src }, policy: null, gen: 0 };
    local.set("screen", cap);
    await applyCapture("screen");
    const g = cap.stream.getVideoTracks()[0].getSettings();
    cap.stream.getTracks().forEach((t) => t.stop());
    return { box: g.width + "x" + g.height, policy: cap.policy };
  };
  const a = await run(1);    // the field case: the first call is lost
  const b = await run(999);  // a source that will never take it
  if (keep) local.set("screen", keep); else local.delete("screen");
  return { took: a.box, policy: a.policy, refused: b.box, refusedPolicy: b.policy };
})()`,
	);
	check(
		"a swallowed applyConstraints is retried until the capture is inside the budget",
		cut.took === "1600x900" && cut.policy === null,
		JSON.stringify(cut),
	);
	check(
		"and a source that never takes it says so instead of encoding the whole screen quietly",
		cut.refused === "2560x1440" && cut.refusedPolicy === "cut refused",
		JSON.stringify(cut),
	);
}

type SourceState = {
	screenHidden: boolean;
	screenDisabled: boolean;
	screenTitle: string;
	camHidden: boolean;
	camDisabled: boolean;
	camTitle: string;
	flipHidden: boolean;
	icoScreen: boolean;
	icoStop: boolean;
	icoCam: boolean;
	icoCamStop: boolean;
};

// reads what is actually rendered, not the flags that were set: `hidden` on a
// dock button only means anything because of the [hidden] !important rule, and
// that rule is the thing most easily reverted.
async function sourceState(): Promise<SourceState> {
	return await evalJS<SourceState>(`(() => {
    const vis = (el) => getComputedStyle(el).display !== "none";
    const s = document.getElementById("shareBtn");
    const c = document.getElementById("camBtn");
    return {
      screenHidden: !vis(s),
      screenDisabled: s.disabled,
      screenTitle: s.title,
      camHidden: !vis(c),
      camDisabled: c.disabled,
      camTitle: c.title,
      flipHidden: !vis(document.getElementById("flipBtn")),
      icoScreen: vis(document.getElementById("icoScreen")),
      icoStop: vis(document.getElementById("icoStop")),
      icoCam: vis(document.getElementById("icoCam")),
      icoCamStop: vis(document.getElementById("icoCamStop")),
    };
  })()`);
}

export async function sourcesScenario(check: CheckFn): Promise<void> {
	console.log("\n--- capture sources ---");

	// the phone case: getDisplayMedia simply is not there. measured on an iPhone
	// 16 Pro, iOS 18.7, in a secure context, so this is the real shape and not a
	// hypothetical one.
	await evalJS(`(() => {
    window.__gdm = navigator.mediaDevices.getDisplayMedia;
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia",
      { value: undefined, configurable: true });
    render();
  })()`);
	let st = await sourceState();
	check("no getDisplayMedia leaves no screen button", st.screenHidden);
	check("and the camera button is what remains", !st.camHidden && !st.camDisabled);

	// hiding must follow the browser ANSWERING, never the origin: on an insecure
	// origin the capability exists and the fix belongs to the user, so erasing
	// the button would erase the only hint that screen sharing exists.
	await evalJS(`(() => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    render();
  })()`);
	st = await sourceState();
	check("an insecure origin keeps the button instead", !st.screenHidden);
	check("and puts the reason in its title", st.screenTitle.length > 20);
	await evalJS(`(() => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    render();
  })()`);

	// each button toggles its OWN source, because both can be on air together: a
	// single shared stop is what made stopping the camera stop the screen.
	await evalJS(INSTALL_FAKE);
	await evalJS(`(() => {
    local.set("camera", { stream: window.fake(640, 360), geom: null, policy: null, gen: 0 });
    camHasBoth = true;
    render();
  })()`);
	st = await sourceState();
	check("a camera on air offers its own stop", !st.camHidden && !st.camDisabled);
	check("and that button wears stop, not a lens", st.icoCamStop && !st.icoCam);
	check("the screen button stays gone where there is no screen API", st.screenHidden);
	check("and the flip appears only with a second camera", !st.flipHidden);

	// the flip is a third action, so it got a button of its own: cramming it
	// into the camera button is what cost the ability to stop the camera.
	await evalJS("camHasBoth = false; render();");
	st = await sourceState();
	check("one camera means no flip button", st.flipHidden);
	check("and the camera can still be stopped", !st.camDisabled);
	await evalJS("camHasBoth = true; render();");

	// both sources at once, which is the whole point of the composite key.
	await evalJS(`(() => {
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia",
      { value: window.__gdm, configurable: true });
    local.set("screen", { stream: window.fake(1280, 720), geom: null, policy: null, gen: 0 });
    render();
  })()`);
	st = await sourceState();
	check("screen and camera on air together", !st.screenHidden && st.icoStop && st.icoCamStop);
	check(
		"and each names the source it stops",
		/screen/i.test(st.screenTitle) && /camera/i.test(st.camTitle),
	);

	// the dock grew two buttons, and 430px is where it runs out of room first.
	// with both sources on air and the flip showing, this is its widest state.
	await setViewport(430, 780);
	await settle();
	const fit = await evalJS<{
		dock: number;
		inner: number;
		sw: number;
		sh: number;
		ih: number;
	}>(`(() => {
    const d = document.querySelector(".dock").getBoundingClientRect();
    return {
      dock: Math.round(d.width), inner: innerWidth,
      sw: document.documentElement.scrollWidth,
      sh: document.documentElement.scrollHeight, ih: innerHeight,
    };
  })()`);
	check(
		"the widest dock still fits 430px",
		fit.dock <= fit.inner,
		`dock=${fit.dock} inner=${fit.inner}`,
	);
	check("and the page does not scroll with it", fit.sw <= fit.inner && fit.sh === fit.ih);
	await setViewport(1440, 900);
	await settle();

	// stopping one must leave the other alone: everything is keyed per source.
	const after = await evalJS<{ screen: boolean; camera: boolean }>(`(() => {
    local.get("camera").stream.getTracks().forEach((t) => t.stop());
    local.delete("camera");
    render();
    return { screen: local.has("screen"), camera: local.has("camera") };
  })()`);
	check("stopping the camera leaves the screen up", after.screen && !after.camera);

	await evalJS(`(() => {
    for (const [s, cap] of [...local]) {
      cap.stream.getTracks().forEach((t) => t.stop());
      local.delete(s);
    }
    render();
  })()`);
	st = await sourceState();
	check("restoring the API brings the screen button back", !st.screenHidden && st.icoScreen);

	// existing is not working: a browser that defines getDisplayMedia and then
	// refuses the capability has answered, and the button has to retire.
	await evalJS("screenWorks = false; render();");
	st = await sourceState();
	check("an API that exists but refuses retires the button", st.screenHidden);
	await evalJS("screenWorks = true; render();");

	// and the mirror image: no camera on the machine, no camera button.
	await evalJS("camHasAny = false; render();");
	st = await sourceState();
	check("no camera device leaves no camera button", st.camHidden);
	await evalJS("camHasAny = true; render();");

	// the same error name means opposite things per source, and getting that
	// backwards is silent by construction: a refused camera permission that says
	// nothing looks exactly like a button that does not work.
	const msg = await evalJS<Record<string, string>>(`(() => ({
    camDenied: captureError("camera", { name: "NotAllowedError" }),
    screenCancel: captureError("screen", { name: "NotAllowedError" }),
    camBusy: captureError("camera", { name: "NotReadableError" }),
    camNone: captureError("camera", { name: "NotFoundError" }),
  }))()`);
	check("a cancelled screen picker stays silent", msg.screenCancel === "");
	check("a refused camera does not", msg.camDenied.length > 40);
	check("and says where to grant it", /settings/i.test(msg.camDenied));
	check("a busy camera says what is holding it", /busy|one capture/i.test(msg.camBusy));
	check("an absent camera says so plainly", /no camera/i.test(msg.camNone));

	// and the whole path, not just the string: a rejected getUserMedia has to
	// reach the stage.
	const shown = await evalJS<{ text: string; visible: boolean }>(`(async () => {
    const real = navigator.mediaDevices.getUserMedia;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })),
      configurable: true,
    });
    await startShare("camera");
    const n = document.getElementById("notice");
    const out = { text: n.textContent, visible: getComputedStyle(n).display !== "none" };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: real, configurable: true });
    notice("");
    return out;
  })()`);
	check("a denied camera reaches the stage", shown.visible && /refused/i.test(shown.text));

	// a camera rig: a stream whose track names a lens, the way a phone's does
	// and a webcam's does not, plus an enumeration that stays blind until a
	// permission is granted.
	await evalJS(`(() => {
    window.__mkCam = (facing) => {
      const s = window.fake(640, 360);
      const t = s.getVideoTracks()[0];
      const real = t.getSettings.bind(t);
      t.getSettings = () => Object.assign(real(), facing ? { facingMode: facing } : {});
      return s;
    };
    window.__rig = ({ cams, gives, onCall }) => {
      const realEnum = navigator.mediaDevices.enumerateDevices;
      const realGum = navigator.mediaDevices.getUserMedia;
      let granted = false;
      Object.defineProperty(navigator.mediaDevices, "enumerateDevices", {
        value: () => Promise.resolve(granted
          ? Array.from({ length: cams }, (_, i) => ({ kind: "videoinput", deviceId: "c" + i }))
          : []),
        configurable: true,
      });
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: (c) => { granted = true; return onCall(c) ?? Promise.resolve(gives()); },
        configurable: true,
      });
      return () => {
        Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { value: realEnum, configurable: true });
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: realGum, configurable: true });
      };
    };
  })()`);

	// the phone case, and the one the flip exists for: enumerateDevices does not
	// tell the truth until a permission has been granted. safari answers an
	// empty list before one and chrome a single generic entry whatever the
	// device holds, so the single probe at boot counted no second camera on any
	// phone and camHasBoth stayed false for the whole session. granting the
	// camera is the moment the count becomes real.
	//
	// the same run answers `user` to a request for `environment`, which a phone
	// is entitled to do: what the flip has to remember is the lens that came
	// back, or its first click asks for the camera already open.
	const grant = await evalJS<{ before: boolean; after: boolean; facing: string }>(`(async () => {
    const restore = window.__rig({ cams: 2, gives: () => window.__mkCam("user"), onCall: () => null });
    camHasBoth = false; camFacing = "environment"; camFacingKnown = false;
    await probeCameras();
    const before = camHasBoth;
    await startShare("camera");
    await new Promise((r) => setTimeout(r, 400));
    const out = { before, after: camHasBoth, facing: camFacing };
    stopShare("camera");
    restore();
    return out;
  })()`);
	check("no second camera is countable before the permission", grant.before === false);
	check("and granting the camera is what reveals the flip", grant.after === true);
	check("the lens that answered is the one remembered", grant.facing === "user", grant.facing);

	// counting devices is not counting lenses. a laptop with a webcam and a
	// phone offered as a Continuity camera enumerates two videoinputs and has
	// nothing to flip between, which is exactly where the button turned up.
	const desk = await evalJS<{ both: boolean }>(`(async () => {
    const restore = window.__rig({ cams: 2, gives: () => window.__mkCam(null), onCall: () => null });
    camHasBoth = false; camFacingKnown = false;
    await startShare("camera");
    await new Promise((r) => setTimeout(r, 400));
    const out = { both: camHasBoth };
    stopShare("camera");
    restore();
    return out;
  })()`);
	check("two cameras with no lens between them offer no flip", desk.both === false);

	// the box follows the DEVICE and not the monitor. a phone held upright asked
	// for a landscape box answers with a landscape frame, which is the field
	// report of the front camera coming out lying down, and applyCapture cannot
	// undo it: it fits what ARRIVED into the budget and only ever shrinks. what
	// is read back here is the constraint that reached getUserMedia, not
	// cameraBox()'s return value -- the swap only matters if it travels.
	await evalJS(`window.__askBox = async () => {
    let asked = null;
    const restore = window.__rig({
      cams: 1,
      gives: () => window.__mkCam("user"),
      onCall: (c) => { asked = c.video; return null; },
    });
    camFacingKnown = false;
    await startShare("camera");
    await new Promise((r) => setTimeout(r, 300));
    stopShare("camera");
    restore();
    const p = pickerBox();
    return { w: asked?.width?.ideal, h: asked?.height?.ideal, pw: p.w, ph: p.h };
  };`);

	await setViewport(430, 780);
	await setTouch(true);
	await settle();
	const upright = await evalJS<{ w: number; h: number; pw: number; ph: number }>(
		"window.__askBox()",
	);
	check(
		"a phone held upright asks the camera for a portrait box",
		upright.h > upright.w,
		`${upright.w}x${upright.h}`,
	);
	check(
		"and it is the same budget on its side",
		upright.w === upright.ph && upright.h === upright.pw,
	);
	check("while the screen picker stays landscape", upright.pw > upright.ph);

	// a tall desktop window is not a phone: its webcam has one orientation, and
	// ideal width/height is answered by cropping the native frame, so following
	// the window would carve a portrait strip out of a landscape camera.
	await setTouch(false);
	await settle();
	const tall = await evalJS<{ w: number; h: number }>("window.__askBox()");
	check("a tall desktop window keeps the landscape box", tall.w > tall.h, `${tall.w}x${tall.h}`);
	await setViewport(1440, 900);
	await settle();

	// the flip asks exactly, and it asks with the old lens already released:
	// ideal lets a device answer with the camera that is open, and macOS/iOS
	// allow one camera capture at a time, so overlapping the two is a second
	// capture rather than a flip.
	const flip = await evalJS<{ exact: string; oldLive: boolean; facing: string }>(`(async () => {
    const seen = [];
    const restore = window.__rig({
      cams: 2,
      gives: () => window.__mkCam(seen.length > 1 ? "environment" : "user"),
      onCall: (c) => { seen.push({ f: c.video.facingMode, live: window.__old?.readyState }); return null; },
    });
    camHasBoth = false; camFacing = "environment"; camFacingKnown = false;
    await startShare("camera");
    await new Promise((r) => setTimeout(r, 300));
    window.__old = local.get("camera").stream.getVideoTracks()[0];
    await flipCamera();
    await new Promise((r) => setTimeout(r, 300));
    const out = {
      exact: JSON.stringify(seen[1]?.f),
      oldLive: seen[1]?.live === "live",
      facing: camFacing,
    };
    stopShare("camera");
    restore();
    return out;
  })()`);
	check(
		"the flip asks for the other lens exactly",
		flip.exact === '{"exact":"environment"}',
		flip.exact,
	);
	check("and the old lens is released before it asks", flip.oldLive === false);
	check(
		"and the share ends up on the lens that answered",
		flip.facing === "environment",
		flip.facing,
	);

	// a device with one lens refuses the exact request. the share must not be
	// left black for it: the old lens comes back and the button retires.
	const only = await evalJS<{ live: boolean; both: boolean }>(`(async () => {
    let calls = 0;
    const restore = window.__rig({
      cams: 2,
      gives: () => window.__mkCam("user"),
      onCall: (c) => (calls++ === 1
        ? Promise.reject(Object.assign(new Error("x"), { name: "OverconstrainedError" }))
        : null),
    });
    camHasBoth = false; camFacing = "environment"; camFacingKnown = false;
    await startShare("camera");
    await new Promise((r) => setTimeout(r, 300));
    await flipCamera();
    await new Promise((r) => setTimeout(r, 300));
    const t = local.get("camera")?.stream.getVideoTracks()[0];
    const out = { live: t?.readyState === "live", both: camHasBoth };
    stopShare("camera");
    restore();
    return out;
  })()`);
	check("a refused flip puts the old lens back", only.live === true);
	check("and the flip button retires with it", only.both === false);

	st = await sourceState();
	check("the bench leaves both sources behind", !st.screenHidden && !st.camHidden);
}

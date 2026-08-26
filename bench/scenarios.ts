import { capture, evalJS, setViewport } from "./cdp.ts";
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

export async function callScenario(check: CheckFn): Promise<void> {
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

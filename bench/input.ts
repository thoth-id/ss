import { cdp } from "./cdp.ts";

// real wheel and drag, through CDP's Input. a synthetic event from Runtime does
// not work here: the pan calls setPointerCapture, which rejects an invented
// pointerId, and without capture the drag dies at the element edge, so the test
// would pass vacuously.
export async function wheel(x: number, y: number, dy: number): Promise<void> {
	await cdp("Input.dispatchMouseEvent", {
		type: "mouseWheel",
		x,
		y,
		deltaX: 0,
		deltaY: dy,
		pointerType: "mouse",
	});
	await Bun.sleep(60);
}

export async function drag(x0: number, y0: number, x1: number, y1: number): Promise<void> {
	await cdp("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: x0,
		y: y0,
		button: "left",
		buttons: 1,
		clickCount: 1,
		pointerType: "mouse",
	});
	const N = 8;
	for (let i = 1; i <= N; i++) {
		await cdp("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			button: "left",
			buttons: 1,
			x: Math.round(x0 + ((x1 - x0) * i) / N),
			y: Math.round(y0 + ((y1 - y0) * i) / N),
			pointerType: "mouse",
		});
	}
	await cdp("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: x1,
		y: y1,
		button: "left",
		buttons: 0,
		clickCount: 1,
		pointerType: "mouse",
	});
	await Bun.sleep(80);
}

export async function clickAt(x: number, y: number): Promise<void> {
	await cdp("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x,
		y,
		button: "left",
		buttons: 1,
		clickCount: 1,
		pointerType: "mouse",
	});
	await cdp("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x,
		y,
		button: "left",
		buttons: 0,
		clickCount: 1,
		pointerType: "mouse",
	});
	await Bun.sleep(80);
}

import { DBG, OUT } from "./chrome.ts";

export type CdpTarget = { type: string; webSocketDebuggerUrl: string };

export type CdpResponse = {
	result?: {
		result?: { value: unknown };
		exceptionDetails?: unknown;
		data?: string;
	};
};

let seq = 0;
const pending = new Map<number, (v: unknown) => void>();

let ws: WebSocket | null = null;

export function getWs(): WebSocket {
	if (!ws) throw new Error("CDP not connected: call connectCdp() first");
	return ws;
}

export async function getCdpTarget(): Promise<string> {
	for (let i = 0; i < 60; i++) {
		try {
			const list = (await fetch(`http://127.0.0.1:${DBG}/json/list`).then((r) =>
				r.json(),
			)) as CdpTarget[];
			const page = list.find((t) => t.type === "page");
			if (page) return page.webSocketDebuggerUrl;
		} catch {}
		await Bun.sleep(200);
	}
	throw new Error("chromium did not answer");
}

export async function connectCdp(): Promise<WebSocket> {
	const url = await getCdpTarget();
	ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		const w = ws as WebSocket;
		w.onopen = () => resolve();
		w.onerror = (e) => reject(e);
	});
	ws.onmessage = (e) => {
		const m = JSON.parse(String((e as MessageEvent).data)) as { id?: number };
		if (m.id !== undefined && pending.has(m.id)) pending.get(m.id)?.(m);
	};
	return ws;
}

export function cdp(method: string, params: Record<string, unknown> = {}): Promise<CdpResponse> {
	const id = ++seq;
	getWs().send(JSON.stringify({ id, method, params }));
	return new Promise<CdpResponse>((resolve) => {
		pending.set(id, resolve as (v: unknown) => void);
	});
}

export async function evalJS<T = unknown>(expr: string): Promise<T> {
	const r = await cdp("Runtime.evaluate", {
		expression: expr,
		awaitPromise: true,
		returnByValue: true,
	});
	if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
	return r.result?.result?.value as T;
}

export async function capture(name: string): Promise<void> {
	const r = await cdp("Page.captureScreenshot", { format: "png" });
	const data = r.result?.data;
	if (typeof data !== "string") throw new Error("captureScreenshot returned no data");
	await Bun.write(`${OUT}/cdp-${name}.png`, Buffer.from(data, "base64"));
}

export async function setViewport(w: number, h: number): Promise<void> {
	await cdp("Emulation.setDeviceMetricsOverride", {
		width: w,
		height: h,
		deviceScaleFactor: 1,
		mobile: false,
	});
}

// `(pointer: coarse)` is what separates a phone from a desktop window that
// merely happens to be tall, and touch emulation is what sets it: measured,
// the metrics override alone leaves it false at any viewport.
//
// `maxTouchPoints` goes only with `enabled`: 0 is out of the protocol's 1..16
// range, so passing it while disabling makes the call fail with "Touch points
// must be between 1 and 16" -- and cdp() RESOLVES protocol errors instead of
// throwing, so the emulation silently stayed on and the desktop case measured
// a phone.
export async function setTouch(on: boolean): Promise<void> {
	await cdp(
		"Emulation.setTouchEmulationEnabled",
		on ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
	);
}

export function closeCdp(): void {
	ws?.close();
	ws = null;
}

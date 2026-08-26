// headless suite. covers static files, signaling, STUN, the room cap (T1),
// sharer arbitration (T2), peer names and the server side of reconnect (T3).
//
// WebRTC is not covered here: that needs a browser and two machines (T0).
//
//   (bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); sleep 2; \
//     timeout 90 bun run test.ts; kill $(cat /tmp/p)

import dgram from "node:dgram";

// the same variables the server reads, so the suite can run on a free port
// without taking down a server already up on 3000.
const PORT = Number(process.env.PORT ?? 3000);
const STUN_PORT = Number(process.env.STUN_PORT ?? 3478);

const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

/* the caps come from /config, not from literals copied here. the server reads
   them from the environment, and a local copy would fail the suite in false
   just because MAX_PEERS is exported in the runner's shell, a failure that is
   not the product's. /config is the same source the client uses. */
const cfgResp = await fetch(`${HTTP}/config`).catch(() => null);
if (!cfgResp?.ok) {
	console.log(`could not read ${HTTP}/config. Is the server up on this port?`);
	process.exit(1);
}
const CFG = (await (cfgResp as Response).json()) as {
	maxPeers: number;
	maxSharers: number;
	stunPort: number;
	maxCapturePixels: number;
};
const MAX_PEERS: number = CFG.maxPeers;
const MAX_SHARERS: number = CFG.maxSharers;

// T2 builds a room of MAX_SHARERS+1 to watch arbitration deny the extra one,
// which only fits if the room cap is greater than the sharer cap. saying so
// here keeps an incompatible configuration from looking like a failing test.
if (!(MAX_PEERS > MAX_SHARERS)) {
	console.log(
		`incompatible configuration: T2 needs ${MAX_SHARERS + 1} peers in a room of ${MAX_PEERS}.`,
	);
	process.exit(1);
}

let pass = 0;
let fail = 0;

function ok(name: string, cond: unknown, detail?: unknown) {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.log(`  FAIL ${name}${detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
	}
}

function eq(name: string, got: unknown, want: unknown) {
	const same = JSON.stringify(got) === JSON.stringify(want);
	ok(name, same, same ? undefined : { got, want });
}

/** opens a socket that accumulates everything it receives in an array. */
async function peer(label: string) {
	const ws = new WebSocket(WS);
	const msgs: Record<string, unknown>[] = [];
	ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)) as Record<string, unknown>);
	await new Promise<void>((res, rej) => {
		ws.onopen = () => res();
		ws.onerror = () => rej(new Error(`${label}: failed to open`));
	});
	const send = (o: unknown) => ws.send(JSON.stringify(o));
	// name is optional in the protocol; only whoever passes one sends the field.
	const join = (room: string, name?: string) =>
		send(name === undefined ? { t: "join", room } : { t: "join", room, name });
	const of = (t: string) => msgs.filter((m) => m.t === t);
	const first = (t: string) => of(t)[0];
	const last = (t: string) => of(t).at(-1);
	return {
		label,
		ws,
		msgs,
		send,
		join,
		of,
		first,
		last,
		id: () => first("joined")?.id as string | undefined,
		close: () => ws.close(),
	};
}

const settle = () => Bun.sleep(300);

/** N peers in the same room, each already `joined`. */
async function room(name: string, n: number) {
	const ps = [];
	for (let i = 0; i < n; i++) {
		const p = await peer(`${name}-${i}`);
		p.join(name);
		await settle();
		ps.push(p);
	}
	return ps;
}

/* ---------- static ---------- */

async function testStatic() {
	console.log("\nstatic + /config");

	const root = await fetch(`${HTTP}/`);
	const body = await root.text();
	ok("GET / answers 200", root.status === 200, root.status);
	ok("GET / serves index.html", body.includes("<title>tailcast</title>"));
	ok("index has the share button", body.includes('id="shareBtn"'));

	const cfg = await fetch(`${HTTP}/config`);
	const json = (await cfg.json()) as {
		stunPort: number;
		maxPeers: number;
		maxSharers: number;
		maxCapturePixels: number;
		[key: string]: unknown;
	};
	eq("/config returns stunPort", json.stunPort, STUN_PORT);
	// shape, not value: the value is what the suite derived from here, so
	// comparing it against itself would assert nothing. all three are positive
	// integers by the same rule, since server.ts's int() returns nothing else.
	const positiveInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
	for (const field of ["maxPeers", "maxSharers", "maxCapturePixels"]) {
		ok(`/config returns ${field} as an integer > 0`, positiveInt(json[field]), json[field]);
	}

	const miss = await fetch(`${HTTP}/does-not-exist`);
	eq("unknown route gives 404", miss.status, 404);
}

/* ---------- signaling ---------- */

async function testJoin() {
	console.log("\njoin / joined");

	const a = await peer("a");
	a.join("r-join");
	await settle();

	const joined = a.first("joined");
	ok("first peer receives joined", !!joined);
	ok("joined carries an id", typeof joined?.id === "string" && joined.id.length > 0, joined?.id);
	eq("first peer sees an empty room", joined?.peers, []);
	eq("first peer receives an empty sharers snapshot", a.first("sharers")?.ids, []);
	eq("first peer receives an empty names snapshot", a.first("names")?.map, {});

	const b = await peer("b");
	b.join("r-join");
	await settle();

	eq("second peer sees the first in the list", b.first("joined")?.peers, [joined.id]);
	eq("first peer is told about the second", a.first("peer-joined")?.id, b.id());
	ok("whoever joins gets no peer-joined for themselves", b.of("peer-joined").length === 0);

	ok("joined carries the session clock", typeof joined?.startedAt === "number", joined?.startedAt);
	ok(
		"a late peer inherits the same session clock",
		b.first("joined")?.startedAt === joined.startedAt,
	);

	a.close();
	b.close();
	await settle();

	// empty room must delete its clock; next birth gets a fresh epoch
	const c = await peer("c");
	c.join("r-join");
	await settle();
	const fresh = c.first("joined");
	ok(
		"new room after empty gets a fresh session clock",
		typeof fresh?.startedAt === "number" && fresh.startedAt !== joined.startedAt,
		`old=${joined.startedAt} fresh=${fresh?.startedAt}`,
	);
	ok(
		"fresh clock is recent",
		Math.abs((fresh?.startedAt ?? 0) - Date.now()) < 5000,
		fresh?.startedAt,
	);
	c.close();
	await settle();
}

async function testLeave() {
	console.log("\npeer-left");

	const [a, b] = await room("r-left", 2);
	const bId = b.id();
	b.close();
	await settle();

	eq("close propagates peer-left with the right id", a.first("peer-left")?.id, bId);

	a.close();
	await settle();
}

async function testRoomIsolation() {
	console.log("\nisolation between rooms");

	const a = await peer("a");
	const b = await peer("b");
	a.join("room-1");
	await settle();
	b.join("room-2");
	await settle();

	eq("a peer from another room is not in the list", b.first("joined")?.peers, []);
	ok("a peer from another room generates no peer-joined", a.of("peer-joined").length === 0);

	b.send({ t: "signal", to: a.id(), data: { kind: "offer", sdp: "x" } });
	await settle();
	ok("signal does not cross rooms", a.of("signal").length === 0, a.of("signal"));

	a.send({ t: "share-start" });
	await settle();
	eq("sharers of room-1 has the peer", a.last("sharers")?.ids, [a.id()]);
	eq("sharers do not leak into room-2", b.last("sharers")?.ids, []);

	a.close();
	b.close();
	await settle();
}

async function testSignalRelay() {
	console.log("\nsignal relay");

	const [a, b, c] = await room("r-sig", 3);
	const aId = a.id();

	// arbitrarily shaped data: the server must neither inspect nor validate (I2)
	const payload = {
		kind: "offer",
		sdp: { type: "offer", sdp: "v=0\r\n" },
		nested: { x: [1, 2] },
	};
	a.send({ t: "signal", to: b.id(), data: payload });
	await settle();

	const got = b.first("signal");
	ok("the recipient receives the signal", !!got);
	eq("signal preserves from", got?.from, aId);
	eq("server relays data untouched (I2)", got?.data, payload);
	ok("the sender gets no echo", a.of("signal").length === 0);
	ok("a third peer does not receive the signal", c.of("signal").length === 0, c.of("signal"));

	a.send({ t: "signal", to: "ffffffff", data: { kind: "ice" } });
	await settle();
	ok("signal to an unknown id is ignored without breaking", a.ws.readyState === WebSocket.OPEN);

	a.ws.send("{this is not json");
	await settle();
	ok("invalid json does not drop the connection", a.ws.readyState === WebSocket.OPEN);

	a.close();
	b.close();
	c.close();
	await settle();
}

/* ---------- T1: room cap ---------- */

async function testMaxPeers() {
	console.log(`\nT1: cap of ${MAX_PEERS} peers`);

	const ps = await room("full", MAX_PEERS);
	ok(
		`the first ${MAX_PEERS} get in`,
		ps.every((p) => !!p.id()),
		ps.map((p) => p.id()),
	);

	const extra = await peer("sixth");
	extra.join("full");
	await settle();

	eq("the 6th peer receives denied", extra.first("denied")?.reason, "room-full");
	ok("the 6th peer receives no joined", !extra.first("joined"), extra.msgs);
	ok("the 6th peer receives no sharers snapshot", !extra.first("sharers"));
	ok("the 6th peer receives no names snapshot", !extra.first("names"));

	// nobody saw the sixth arrive: the first peer only saw the other 4.
	eq("the 6th appears in nobody's list", ps[0].of("peer-joined").length, MAX_PEERS - 1);
	ok(
		"the first 5 stay connected",
		ps.every((p) => p.ws.readyState === WebSocket.OPEN),
	);

	ps[0].close();
	await settle();
	const late = await peer("seventh");
	late.join("full");
	await settle();
	ok("a freed slot lets a new peer in", !!late.first("joined"), late.msgs);
	ok("whoever took the slot got no denied", !late.first("denied"));

	extra.close();
	late.close();
	for (const p of ps.slice(1)) {
		p.close();
	}
	await settle();
}

/* ---------- T2: sharer arbitration ---------- */

async function testSharerArbitration() {
	console.log(`\nT2: arbitration, at most ${MAX_SHARERS} sharers`);

	// one person more than the cap: the last is exactly the one that has to be
	// denied. everything derives from MAX_SHARERS so that changing the cap stays
	// a single number, here and in the server.
	const ps = await room("arb", MAX_SHARERS + 1);
	const ids = ps.map((p) => p.id() as string);
	const extra = ps[MAX_SHARERS]; // the one that does not fit
	const extraId = ids[MAX_SHARERS];

	for (let i = 0; i < MAX_SHARERS; i++) {
		ps[i].send({ t: "share-start" });
		await settle();
		eq(`sharer ${i + 1} enters the set`, ps[i].last("sharers")?.ids, ids.slice(0, i + 1));
	}
	eq("the broadcast reaches the whole room", extra.last("sharers")?.ids, ids.slice(0, MAX_SHARERS));

	const before = extra.of("sharers").length;
	extra.send({ t: "share-start" });
	await settle();
	eq(
		`attempt ${MAX_SHARERS + 1} receives share-denied`,
		extra.first("share-denied")?.reason,
		"limit",
	);
	eq("share-denied generates no broadcast", extra.of("sharers").length, before);
	ok("whoever was denied does not enter the set", !extra.last("sharers")?.ids.includes(extraId));
	ok("share-denied goes only to the sender", ps[0].of("share-denied").length === 0);

	const all = ps.flatMap((p) => p.of("sharers"));
	ok(
		`no broadcast ever passed ${MAX_SHARERS} ids`,
		all.every((m) => m.ids.length <= MAX_SHARERS),
		all.map((m) => m.ids.length),
	);

	const beforeRepeat = extra.of("sharers").length;
	ps[0].send({ t: "share-start" });
	await settle();
	eq("a repeated share-start does not re-broadcast", extra.of("sharers").length, beforeRepeat);

	ps[0].send({ t: "share-stop" });
	await settle();
	eq("share-stop removes from the set", extra.last("sharers")?.ids, ids.slice(1, MAX_SHARERS));

	const beforeStop = extra.of("sharers").length;
	ps[0].send({ t: "share-stop" });
	await settle();
	eq("a redundant share-stop is a no-op", extra.of("sharers").length, beforeStop);

	extra.send({ t: "share-start" });
	await settle();
	eq("a freed slot lets a new sharer in", extra.last("sharers")?.ids, [
		...ids.slice(1, MAX_SHARERS),
		extraId,
	]);

	for (const p of ps) {
		p.close();
	}
}

async function testSharerLeave() {
	console.log("\nT2: closing the tab frees the slot");

	const [a, b, c] = await room("leaving", 3);
	const [aId, bId] = [a.id(), b.id()];

	a.send({ t: "share-start" });
	b.send({ t: "share-start" });
	await settle();
	eq("two active sharers", c.last("sharers")?.ids, [aId, bId]);

	a.close();
	await settle();
	eq("the sharer's close frees the slot", c.last("sharers")?.ids, [bId]);
	eq("close also emits peer-left", c.first("peer-left")?.id, aId);

	// somebody who was not a sharer must generate no sharers broadcast on leaving
	const before = b.of("sharers").length;
	c.close();
	await settle();
	eq("a non-sharer leaving does not re-broadcast sharers", b.of("sharers").length, before);

	b.close();
	await settle();
}

async function testSharerSnapshot() {
	console.log("\nT2: snapshot for whoever arrives later");

	const [a] = await room("snap", 1);
	a.send({ t: "share-start" });
	await settle();

	const late = await peer("late");
	late.join("snap");
	await settle();

	eq("whoever arrives later receives the current set", late.first("sharers")?.ids, [a.id()]);

	a.close();
	late.close();
	await settle();
}

async function testShareBeforeJoin() {
	console.log("\nT2: sharing outside a room");

	const orphan = await peer("orphan");
	orphan.send({ t: "share-start" });
	orphan.send({ t: "share-stop" });
	orphan.send({ t: "signal", to: "abc", data: {} });
	await settle();

	ok("share-start without a join is ignored", orphan.of("sharers").length === 0, orphan.msgs);
	ok("the connection survives", orphan.ws.readyState === WebSocket.OPEN);

	orphan.close();
	await settle();
}

/* ---------- names ---------- */

/** compares name maps without depending on key order. */
function eqMap(name: string, got: unknown, want: Record<string, string>) {
	const norm = (o: unknown) =>
		Object.entries((o as Record<string, string> | null | undefined) ?? {}).sort(([x], [y]) =>
			x < y ? -1 : 1,
		);
	eq(name, norm(got), norm(want));
}

async function testNames() {
	console.log("\npeer names");

	const a = await peer("a");
	a.join("names", "gabriel");
	await settle();
	const aId = a.id() as string;

	eqMap("joining with a name puts you in the map", a.last("names")?.map, {
		[aId]: "gabriel",
	});

	const b = await peer("b");
	b.join("names");
	await settle();
	const bId = b.id() as string;

	eqMap("the snapshot carries the name of whoever was there", b.last("names")?.map, {
		[aId]: "gabriel",
	});
	ok("joining without a name stays out of the map", !(bId in (b.last("names")?.map ?? {})));

	const c = await peer("c");
	c.join("names", "ana");
	await settle();
	const cId = c.id() as string;
	eqMap("the name of whoever joins reaches the others", a.last("names")?.map, {
		[aId]: "gabriel",
		[cId]: "ana",
	});

	b.send({ t: "rename", name: "beatriz" });
	await settle();
	const expected = { [aId]: "gabriel", [bId]: "beatriz", [cId]: "ana" };
	eqMap("rename reaches whoever was already there", a.last("names")?.map, expected);
	eqMap("rename reaches whoever joined later", c.last("names")?.map, expected);
	eqMap("whoever renamed also receives the map", b.last("names")?.map, expected);

	const beforeSame = a.of("names").length;
	b.send({ t: "rename", name: "beatriz" });
	await settle();
	eq("renaming to the same name does not re-broadcast", a.of("names").length, beforeSame);

	b.send({ t: "rename", name: "z".repeat(40) });
	await settle();
	eq("a 40-char name arrives cut at 24", a.last("names")?.map[bId], "z".repeat(24));

	b.send({ t: "rename", name: "  ana   maria \n silva  " });
	await settle();
	eq("whitespace collapsed and trimmed", a.last("names")?.map[bId], "ana maria silva");

	// an empty name is how you erase your own
	b.send({ t: "rename", name: "   " });
	await settle();
	ok(
		"a whitespace-only name leaves the map",
		!(bId in ((a.last("names")?.map ?? {}) as Record<string, unknown>)),
		a.last("names")?.map,
	);
	eqMap("erasing a name does not touch the others", a.last("names")?.map, {
		[aId]: "gabriel",
		[cId]: "ana",
	});

	const d = await peer("d");
	d.join("names", `   ${"w".repeat(30)}`);
	await settle();
	eq("a name in the join is sanitized too", a.last("names")?.map[d.id() as string], "w".repeat(24));

	const e = await peer("e");
	e.join("other-room", "carla");
	await settle();
	eqMap("another room only sees its own name", e.last("names")?.map, {
		[e.id() as string]: "carla",
	});
	ok(
		"a name does not cross rooms",
		!Object.values(a.last("names")?.map ?? {}).includes("carla"),
		a.last("names")?.map,
	);

	// leaving the room takes the name out of the map: the name lives on the socket
	a.close();
	await settle();
	eqMap("leaving removes the name from the map", c.last("names")?.map, {
		[cId]: "ana",
		[d.id() as string]: "w".repeat(24),
	});

	const beforeLeave = c.of("names").length;
	b.close();
	await settle();
	eq("somebody unnamed leaving does not re-broadcast", c.of("names").length, beforeLeave);

	const orphan = await peer("orphan-name");
	orphan.send({ t: "rename", name: "nobody" });
	await settle();
	ok("rename without a join is ignored", orphan.of("names").length === 0, orphan.msgs);
	ok("the connection survives a rename outside a room", orphan.ws.readyState === WebSocket.OPEN);

	orphan.close();
	c.close();
	d.close();
	e.close();
	await settle();
}

/* ---------- T3: reconnect (server side) ---------- */

async function testReconnect() {
	console.log("\nT3: reconnect");

	const [a, b] = await room("recon", 2);
	const aId = a.id();
	const bId = b.id();

	a.send({ t: "share-start" });
	await settle();
	eq("sharer registered before the drop", b.last("sharers")?.ids, [aId]);

	a.close();
	await settle();
	eq("the drop frees the sharer slot", b.last("sharers")?.ids, []);
	eq("the drop emits peer-left", b.first("peer-left")?.id, aId);

	// comes back with a new id and asks for the slot again, as the client does
	const a2 = await peer("a-reconnected");
	a2.join("recon");
	await settle();

	const newId = a2.id();
	ok("the reconnect receives a new id", !!newId && newId !== aId, {
		aId,
		newId,
	});
	eq("the reconnect sees the peer that stayed", a2.first("joined")?.peers, [bId]);
	eq("the snapshot shows nobody sharing", a2.first("sharers")?.ids, []);

	a2.send({ t: "share-start" });
	await settle();
	eq("the reconnect recovers the slot under the new id", b.last("sharers")?.ids, [newId]);
	ok("the old id is not in the set", !b.last("sharers")?.ids.includes(aId));

	a2.close();
	b.close();
	await settle();
}

/* ---------- stun ---------- */

const MAGIC = 0x2112a442;

async function testStun() {
	console.log("\nSTUN");

	const sock = dgram.createSocket("udp4");
	const tid = crypto.getRandomValues(new Uint8Array(12));

	const req = Buffer.alloc(20);
	req.writeUInt16BE(0x0001, 0); // Binding Request
	req.writeUInt16BE(0, 2); // no attributes
	req.writeUInt32BE(MAGIC, 4);
	Buffer.from(tid).copy(req, 8);

	const answer = new Promise<{ buf: Buffer; localPort: number }>((res, rej) => {
		const timer = setTimeout(() => rej(new Error("STUN did not answer within 3s")), 3000);
		sock.on("message", (buf) => {
			clearTimeout(timer);
			res({ buf, localPort: sock.address().port });
		});
	});

	await new Promise<void>((res) => sock.bind(0, "127.0.0.1", res));
	sock.send(req, STUN_PORT, "127.0.0.1");

	let buf: Buffer, localPort: number;
	try {
		({ buf, localPort } = await answer);
	} catch (e) {
		ok("STUN answers a Binding Request", false, String(e));
		sock.close();
		return;
	}

	ok("STUN answers a Binding Request", true);
	eq("type is Binding Success Response", buf.readUInt16BE(0), 0x0101);
	eq("magic cookie echoed", buf.readUInt32BE(4), MAGIC);
	eq("transaction id mirrored", [...buf.subarray(8, 20)], [...tid]);
	eq("length covers the attribute", buf.readUInt16BE(2), 12);
	eq("the attribute is XOR-MAPPED-ADDRESS", buf.readUInt16BE(20), 0x0020);
	eq("attribute length", buf.readUInt16BE(22), 8);
	eq("family is IPv4", buf.readUInt8(25), 0x01);

	const port = buf.readUInt16BE(26) ^ (MAGIC >>> 16);
	const addr = (buf.readUInt32BE(28) ^ MAGIC) >>> 0;
	const ip = [addr >>> 24, (addr >>> 16) & 255, (addr >>> 8) & 255, addr & 255].join(".");

	eq("the decoded port matches the source", port, localPort);
	eq("the decoded IP matches the source", ip, "127.0.0.1");

	sock.send(Buffer.from([1, 2, 3]), STUN_PORT, "127.0.0.1");
	await Bun.sleep(200);
	ok("garbage over UDP does not kill STUN", true);

	sock.close();
}

/* ---------- run ---------- */

await testStatic();
await testJoin();
await testLeave();
await testRoomIsolation();
await testSignalRelay();
await testMaxPeers();
await testSharerArbitration();
await testSharerLeave();
await testSharerSnapshot();
await testShareBeforeJoin();
await testNames();
await testReconnect();
await testStun();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

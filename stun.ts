import dgram from "node:dgram";

// minimal STUN: answers Binding Request only, with XOR-MAPPED-ADDRESS.
//
// chrome hides private-IP host candidates behind mDNS (.local) names, and
// Tailscale's CGNAT range (100.64/10) counts as private. mDNS needs multicast,
// which does not cross the tailnet, so the remote peer never resolves the name
// and ICE fails silently. a STUN inside the tailnet hands back the peer's
// 100.x as an srflx candidate, which is not obfuscated.

const MAGIC = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const XOR_MAPPED_ADDRESS = 0x0020;

export function startStun(port = 3478) {
	const sock = dgram.createSocket("udp4");

	sock.on("message", (buf, rinfo) => {
		if (buf.length < 20) return;
		if (buf.readUInt16BE(0) !== BINDING_REQUEST) return;
		if (buf.readUInt32BE(4) !== MAGIC) return;

		const octets = rinfo.address.split(".");
		if (octets.length !== 4) return; // the tailnet is v4

		const res = Buffer.alloc(32);
		res.writeUInt16BE(BINDING_SUCCESS, 0);
		res.writeUInt16BE(12, 2); // attribute length
		res.writeUInt32BE(MAGIC, 4);
		buf.copy(res, 8, 8, 20); // mirrored transaction id

		res.writeUInt16BE(XOR_MAPPED_ADDRESS, 20);
		res.writeUInt16BE(8, 22);
		res.writeUInt8(0, 24);
		res.writeUInt8(0x01, 25); // IPv4 family
		res.writeUInt16BE(rinfo.port ^ (MAGIC >>> 16), 26);

		const addr =
			((+octets[0] << 24) |
				(+octets[1] << 16) |
				(+octets[2] << 8) |
				+octets[3]) >>>
			0;
		res.writeUInt32BE((addr ^ MAGIC) >>> 0, 28);

		// the callback turns a send failure into a handled 'error' instead of an
		// uncaught exception: a peer that vanished must not take the server down.
		sock.send(res, rinfo.port, rinfo.address, () => {});
	});

	// without this handler dgram emits 'error' with nobody listening and the
	// process dies with `bind EADDRINUSE 0.0.0.0`, no port number, which reads
	// like the HTTP port is the problem. the EADDRINUSE string stays in the
	// message because cli.ts greps the child log for it (--bg, layer 3).
	//
	// only a bind failure is fatal: an ICMP back from a peer that vanished
	// arrives here as EPERM or ENETUNREACH, and dropping the room over that
	// trades a lost packet for a lost meeting.
	let bindado = false;
	sock.on("error", (err: NodeJS.ErrnoException) => {
		if (bindado) {
			process.stderr.write(
				`stun: socket error (${err.code}): ${err.message}\n`,
			);
			return;
		}
		process.stderr.write(
			err.code === "EADDRINUSE"
				? `stun: EADDRINUSE on UDP port ${port}, already in use.\n` +
						`Another ss instance? Each one needs its own --stun-port.\n`
				: `stun: could not bind UDP port ${port} (${err.code}): ${err.message}\n`,
		);
		process.exit(1);
	});

	sock.bind(port, () => {
		bindado = true;
	});
	return sock;
}

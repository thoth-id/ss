import dgram from "node:dgram";

// STUN mínimo: responde só Binding Request, com XOR-MAPPED-ADDRESS.
//
// Existe por um motivo só: o Chrome esconde host candidates de IP privado
// atrás de nomes mDNS (.local), e IP de Tailscale cai na faixa CGNAT
// 100.64/10, que ele trata como privado. mDNS depende de multicast, e
// multicast não atravessa o tailnet, então o peer remoto nunca resolve o
// nome e o ICE falha em silêncio.
//
// Um STUN dentro do tailnet devolve o 100.x do peer como srflx candidate,
// que não sofre obfuscation. É o que faz a coisa toda conectar.

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
    if (octets.length !== 4) return; // tailnet v4 basta

    const res = Buffer.alloc(32);
    res.writeUInt16BE(BINDING_SUCCESS, 0);
    res.writeUInt16BE(12, 2); // tamanho dos atributos
    res.writeUInt32BE(MAGIC, 4);
    buf.copy(res, 8, 8, 20); // transaction id espelhado

    res.writeUInt16BE(XOR_MAPPED_ADDRESS, 20);
    res.writeUInt16BE(8, 22);
    res.writeUInt8(0, 24);
    res.writeUInt8(0x01, 25); // family IPv4
    res.writeUInt16BE(rinfo.port ^ (MAGIC >>> 16), 26);

    const addr =
      ((+octets[0] << 24) | (+octets[1] << 16) | (+octets[2] << 8) | +octets[3]) >>> 0;
    res.writeUInt32BE((addr ^ MAGIC) >>> 0, 28);

    sock.send(res, rinfo.port, rinfo.address);
  });

  // Sem este handler o dgram emite 'error' sem ouvinte, o processo morre com
  // `bind EADDRINUSE 0.0.0.0` — sem número de porta — e quem lê o log conclui
  // que o problema é a porta HTTP, que estava livre. Uma segunda instância
  // precisa de --stun-port próprio, e é isso que a mensagem tem que dizer.
  sock.on("error", (err: NodeJS.ErrnoException) => {
    process.stderr.write(
      err.code === "EADDRINUSE"
        ? `STUN: a porta UDP ${port} já está em uso.\n` +
          `Outra instância do screen-share? Cada uma precisa do seu --stun-port.\n`
        : `STUN: falha ao bindar a porta UDP ${port}: ${err.message}\n`,
    );
    process.exit(1);
  });

  sock.bind(port);
  return sock;
}

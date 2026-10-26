// @effect-diagnostics nodeBuiltinImport:off - a host-side end-to-end fixture.
// A loopback stand-in for OMP's collab relay (`collab.relayUrl`, `wss://my.omp.sh` by default),
// cut down from the fork's Bun-only `packages/collab-web/scripts/local-relay.ts` to what Share live
// needs: a host opens `GET /r/<roomId>?role=host` as a WebSocket and holds it open. The relay
// answers pings and closes, and never reads the sealed frames the host sends.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

const ROOM_PATH = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
/** RFC 6455 §1.3: the GUID the handshake's accept key is derived with. */
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

export interface CollabRelay {
  /** `ws://127.0.0.1:<port>`; OMP accepts plain `ws://` only for loopback. */
  readonly url: string;
  /** Rooms whose host is connected now. */
  readonly openRooms: () => ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

interface Frame {
  readonly opcode: number;
  readonly payload: Buffer;
  /** Bytes the frame takes in the stream. */
  readonly size: number;
}

/** The first complete client frame in `bytes` (RFC 6455 §5.2), or nothing yet. */
const readFrame = (bytes: Buffer): Frame | undefined => {
  if (bytes.length < 2) return undefined;
  const opcode = bytes[0]! & 0x0f;
  const masked = (bytes[1]! & 0x80) !== 0;
  let length = bytes[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (bytes.length < 4) return undefined;
    length = bytes.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (bytes.length < 10) return undefined;
    length = Number(bytes.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = masked ? bytes.subarray(offset, offset + 4) : undefined;
  if (mask !== undefined) offset += 4;
  const size = offset + length;
  if (bytes.length < size) return undefined;
  const payload = Buffer.from(bytes.subarray(offset, size));
  if (mask !== undefined) {
    for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index % 4]!;
  }
  return { opcode, payload, size };
};

/** A final, unmasked server control frame; control payloads are at most 125 bytes. */
const controlFrame = (opcode: number, payload: Buffer) =>
  Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);

export const startCollabRelay = async (): Promise<CollabRelay> => {
  const hosts = new Map<string, NodeNet.Socket>();
  const server = NodeHttp.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket: NodeNet.Socket) => {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    const room = ROOM_PATH.exec(url.pathname)?.[1];
    const key = request.headers["sec-websocket-key"];
    if (
      room === undefined ||
      url.searchParams.get("role") !== "host" ||
      typeof key !== "string" ||
      hosts.has(room)
    ) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = NodeCrypto.createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    hosts.set(room, socket);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (let frame = readFrame(pending); frame !== undefined; frame = readFrame(pending)) {
        pending = pending.subarray(frame.size);
        if (frame.opcode === OPCODE_PING) socket.write(controlFrame(OPCODE_PONG, frame.payload));
        if (frame.opcode === OPCODE_CLOSE) socket.end(controlFrame(OPCODE_CLOSE, frame.payload));
      }
    });
    socket.on("close", () => {
      if (hosts.get(room) === socket) hosts.delete(room);
    });
    socket.on("error", () => socket.destroy());
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address() as NodeNet.AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    openRooms: () => [...hosts.keys()],
    close: () => {
      for (const socket of hosts.values()) socket.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
};

/**
 * Byte-level framing for `omp --mode rpc-ui` stdout, mirroring the fork's
 * `modes/rpc/rpc-frame.ts`: newline-delimited JSON lines of at most 1 MiB, and under protocol v2
 * `rpc_chunk` sequences that carry one logical frame of up to 64 MiB.
 */

/** Largest physical line OMP writes, newline included (`MAX_RPC_FRAME_BYTES`). */
export const OMP_MAX_FRAME_BYTES = 1024 * 1024;
/** Largest logical frame protocol v2 reassembles (`MAX_RPC_REASSEMBLED_BYTES`). */
export const OMP_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
/** Decoded payload bytes per `rpc_chunk` frame (`RPC_CHUNK_PAYLOAD_BYTES`). */
export const OMP_CHUNK_PAYLOAD_BYTES = 256 * 1024;

const MAX_CHUNK_COUNT = Math.ceil(OMP_MAX_REASSEMBLED_BYTES / OMP_CHUNK_PAYLOAD_BYTES);
const MAX_CHUNK_ID_CHARS = 128;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/** Thrown for any stdout that breaks the framing rules; the connection cannot recover from it. */
export class OmpFramingError extends Error {
  readonly reason: "frame_too_large" | "invalid_frame" | "chunk";

  constructor(reason: OmpFramingError["reason"], message: string) {
    super(message);
    this.name = "OmpFramingError";
    this.reason = reason;
  }
}

/**
 * Splits stdout bytes into lines. A line longer than `maxLineBytes` (newline included) is a
 * protocol violation: OMP never writes one, and buffering it would let a broken sidecar grow
 * server memory without bound.
 */
export function makeOmpLineSplitter(maxLineBytes: number = OMP_MAX_FRAME_BYTES) {
  let pending: Array<Uint8Array> = [];
  let pendingBytes = 0;

  const take = (tail: Uint8Array): Uint8Array => {
    let line: Uint8Array;
    if (pending.length === 0) {
      line = tail;
    } else {
      line = new Uint8Array(pendingBytes + tail.byteLength);
      let offset = 0;
      for (const part of pending) {
        line.set(part, offset);
        offset += part.byteLength;
      }
      line.set(tail, offset);
    }
    pending = [];
    pendingBytes = 0;
    return line.byteLength > 0 && line[line.byteLength - 1] === CARRIAGE_RETURN
      ? line.subarray(0, line.byteLength - 1)
      : line;
  };

  return {
    /** Returns the complete lines in `chunk`; a partial trailing line stays buffered. */
    push(chunk: Uint8Array): Array<Uint8Array> {
      const lines: Array<Uint8Array> = [];
      let start = 0;
      while (start < chunk.byteLength) {
        const newline = chunk.indexOf(NEWLINE, start);
        const end = newline < 0 ? chunk.byteLength : newline;
        // The newline counts toward the limit, as it does in OMP's encoder.
        if (pendingBytes + (end - start) + 1 > maxLineBytes) {
          throw new OmpFramingError(
            "frame_too_large",
            `OMP wrote a line longer than ${maxLineBytes} bytes`,
          );
        }
        if (newline < 0) {
          pending.push(chunk.slice(start));
          pendingBytes += chunk.byteLength - start;
          break;
        }
        const line = take(chunk.subarray(start, newline));
        if (line.byteLength > 0) lines.push(line);
        start = newline + 1;
      }
      return lines;
    },
    /** The unterminated line left when stdout closes, if any. */
    flush(): Uint8Array | undefined {
      if (pendingBytes === 0) return undefined;
      const line = take(new Uint8Array(0));
      return line.byteLength > 0 ? line : undefined;
    },
  };
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Decodes one line into a JSON object frame. */
export function parseOmpFrameLine(line: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(utf8.decode(line));
  } catch {
    throw new OmpFramingError("invalid_frame", "OMP wrote a line that is not UTF-8 JSON");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>)["type"] !== "string"
  ) {
    throw new OmpFramingError("invalid_frame", "OMP wrote a frame without a string `type`");
  }
  return value as Record<string, unknown>;
}

interface PendingChunks {
  readonly chunkId: string;
  readonly count: number;
  readonly byteLength: number;
  readonly chunks: Array<Uint8Array>;
  nextIndex: number;
  receivedBytes: number;
}

const chunkError = (message: string) => new OmpFramingError("chunk", message);

function decodeChunkData(data: unknown): Uint8Array {
  if (typeof data !== "string" || data.length === 0 || !BASE64.test(data)) {
    throw chunkError("rpc_chunk data is not canonical base64");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) {
    throw chunkError("rpc_chunk data is not canonical base64");
  }
  return bytes;
}

/**
 * Reassembles protocol v2 `rpc_chunk` sequences into the logical frame they carry, with the same
 * rules as the fork's `RpcFrameDecoder`. Metadata is checked before any payload is decoded, so a
 * sequence that declares more than 64 MiB is refused without allocating it.
 */
export class OmpChunkReassembler {
  #pending: PendingChunks | undefined;

  /** Returns the frame to deliver, or `undefined` while a chunk sequence is incomplete. */
  push(frame: Record<string, unknown>): Record<string, unknown> | undefined {
    if (frame["type"] !== "rpc_chunk") {
      if (this.#pending !== undefined) throw chunkError("rpc_chunk sequence was interrupted");
      return frame;
    }
    const { chunkId, index, count, byteLength } = frame;
    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0 ||
      chunkId.length > MAX_CHUNK_ID_CHARS ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength)
    ) {
      throw chunkError("rpc_chunk metadata is invalid");
    }
    const declaredIndex = index as number;
    const declaredCount = count as number;
    const declaredBytes = byteLength as number;
    if (declaredBytes > OMP_MAX_REASSEMBLED_BYTES || declaredCount > MAX_CHUNK_COUNT) {
      throw chunkError(
        `rpc_chunk sequence declares ${declaredBytes} bytes, over the ${OMP_MAX_REASSEMBLED_BYTES}-byte limit`,
      );
    }
    if (
      declaredIndex < 0 ||
      declaredCount < 2 ||
      declaredIndex >= declaredCount ||
      declaredBytes < OMP_MAX_FRAME_BYTES
    ) {
      throw chunkError("rpc_chunk metadata is invalid");
    }
    const bytes = decodeChunkData(frame["data"]);
    if (bytes.byteLength > OMP_CHUNK_PAYLOAD_BYTES) {
      throw chunkError("rpc_chunk payload exceeds the chunk size");
    }

    if (this.#pending === undefined) {
      if (declaredIndex !== 0) throw chunkError("rpc_chunk sequence must start at index 0");
      this.#pending = {
        chunkId,
        count: declaredCount,
        byteLength: declaredBytes,
        chunks: [],
        nextIndex: 0,
        receivedBytes: 0,
      };
    }
    const pending = this.#pending;
    if (
      pending.chunkId !== chunkId ||
      pending.count !== declaredCount ||
      pending.byteLength !== declaredBytes ||
      pending.nextIndex !== declaredIndex
    ) {
      throw chunkError("rpc_chunk sequence is out of order");
    }
    pending.receivedBytes += bytes.byteLength;
    if (pending.receivedBytes > pending.byteLength) {
      throw chunkError("rpc_chunk sequence exceeds its declared length");
    }
    pending.chunks.push(bytes);
    pending.nextIndex += 1;
    if (pending.nextIndex < pending.count) return undefined;
    this.#pending = undefined;
    if (pending.receivedBytes !== pending.byteLength) {
      throw chunkError("rpc_chunk sequence is shorter than its declared length");
    }
    const whole = Buffer.concat(pending.chunks, pending.byteLength);
    const reassembled = parseOmpFrameLine(whole);
    if (reassembled["type"] === "rpc_chunk") throw chunkError("rpc_chunk sequences cannot nest");
    return reassembled;
  }
}

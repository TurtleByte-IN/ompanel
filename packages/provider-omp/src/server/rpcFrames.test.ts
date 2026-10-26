import { assert, describe, it } from "@effect/vitest";

import {
  makeOmpLineSplitter,
  OMP_CHUNK_PAYLOAD_BYTES,
  OMP_MAX_FRAME_BYTES,
  OMP_MAX_REASSEMBLED_BYTES,
  OmpChunkReassembler,
  OmpFramingError,
  parseOmpFrameLine,
} from "./rpcFrames.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const text = (lines: ReadonlyArray<Uint8Array>) => lines.map((line) => decoder.decode(line));

/** The `rpc_chunk` frames OMP's encoder writes for one logical frame. */
const chunkFrames = (frame: object, chunkId = "rpc-1") => {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const count = Math.ceil(bytes.byteLength / OMP_CHUNK_PAYLOAD_BYTES);
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId,
    index,
    count,
    byteLength: bytes.byteLength,
    data: bytes
      .subarray(index * OMP_CHUNK_PAYLOAD_BYTES, (index + 1) * OMP_CHUNK_PAYLOAD_BYTES)
      .toString("base64"),
  }));
};

const framingError = (run: () => unknown): OmpFramingError => {
  try {
    run();
  } catch (error) {
    assert.instanceOf(error, OmpFramingError);
    return error as OmpFramingError;
  }
  return assert.fail("expected a framing error");
};

describe("makeOmpLineSplitter", () => {
  it("splits lines across chunk boundaries and strips CR", () => {
    const splitter = makeOmpLineSplitter();
    assert.deepStrictEqual(text(splitter.push(encoder.encode('{"a":1}\r\n{"b"'))), ['{"a":1}']);
    assert.deepStrictEqual(text(splitter.push(encoder.encode(":2}\n\n"))), ['{"b":2}']);
    assert.strictEqual(splitter.flush(), undefined);
  });

  it("keeps U+2028 inside a line, unlike readline", () => {
    const splitter = makeOmpLineSplitter();
    const lines = splitter.push(encoder.encode('{"type":"a\u2028b"}\n'));
    assert.deepStrictEqual(parseOmpFrameLine(lines[0]!), { type: "a\u2028b" });
  });

  it("returns an unterminated last line on flush", () => {
    const splitter = makeOmpLineSplitter();
    assert.deepStrictEqual(splitter.push(encoder.encode('{"a":1}')), []);
    assert.strictEqual(decoder.decode(splitter.flush()), '{"a":1}');
  });

  it("refuses a line over the 1 MiB frame limit, newline included", () => {
    const splitter = makeOmpLineSplitter();
    // Exactly at the limit is fine.
    assert.strictEqual(
      splitter.push(encoder.encode(`${"a".repeat(OMP_MAX_FRAME_BYTES - 1)}\n`)).length,
      1,
    );
    const error = framingError(() => {
      splitter.push(encoder.encode("b".repeat(OMP_MAX_FRAME_BYTES / 2)));
      splitter.push(encoder.encode("b".repeat(OMP_MAX_FRAME_BYTES / 2)));
    });
    assert.strictEqual(error.reason, "frame_too_large");
  });
});

describe("parseOmpFrameLine", () => {
  it("refuses non-JSON, non-objects and frames without a type", () => {
    for (const line of ["nope", "[1]", '{"a":1}', '"ready"']) {
      assert.strictEqual(
        framingError(() => parseOmpFrameLine(encoder.encode(line))).reason,
        "invalid_frame",
      );
    }
  });
});

describe("OmpChunkReassembler", () => {
  it("passes ordinary frames through", () => {
    const reassembler = new OmpChunkReassembler();
    assert.deepStrictEqual(reassembler.push({ type: "notice" }), { type: "notice" });
  });

  it("reassembles a 3 MiB frame from its chunks", () => {
    const frame = { type: "message_end", text: "é".repeat(1_500_000) };
    const reassembler = new OmpChunkReassembler();
    const chunks = chunkFrames(frame);
    const results = chunks.map((chunk) => reassembler.push(chunk));
    assert.isTrue(results.slice(0, -1).every((result) => result === undefined));
    assert.deepStrictEqual(results.at(-1), frame);
  });

  it("refuses a sequence that declares more than 64 MiB before decoding it", () => {
    const reassembler = new OmpChunkReassembler();
    const error = framingError(() =>
      reassembler.push({
        type: "rpc_chunk",
        chunkId: "big",
        index: 0,
        count: 200,
        byteLength: OMP_MAX_REASSEMBLED_BYTES + 1,
        data: "not even base64",
      }),
    );
    assert.strictEqual(error.reason, "chunk");
    assert.include(error.message, "64");
  });

  it("refuses chunks whose payloads outgrow the declared length", () => {
    const reassembler = new OmpChunkReassembler();
    const data = Buffer.alloc(OMP_CHUNK_PAYLOAD_BYTES, 0x61).toString("base64");
    const chunk = (index: number) => ({
      type: "rpc_chunk",
      chunkId: "long",
      index,
      count: 5,
      byteLength: OMP_MAX_FRAME_BYTES + 10,
      data,
    });
    for (let index = 0; index < 4; index++) assert.isUndefined(reassembler.push(chunk(index)));
    const error = framingError(() => reassembler.push(chunk(4)));
    assert.include(error.message, "declared length");
  });

  it("refuses an interrupted, reordered or mismatched sequence", () => {
    const chunks = chunkFrames({ type: "notice", text: "x".repeat(2 * OMP_MAX_FRAME_BYTES) });
    const interrupted = new OmpChunkReassembler();
    interrupted.push(chunks[0]!);
    framingError(() => interrupted.push({ type: "notice" }));

    framingError(() => new OmpChunkReassembler().push(chunks[1]!));

    const mismatched = new OmpChunkReassembler();
    mismatched.push(chunks[0]!);
    framingError(() => mismatched.push({ ...chunks[1]!, chunkId: "other" }));
  });

  it("refuses non-canonical base64 and undersized sequences", () => {
    const [first] = chunkFrames({ type: "notice", text: "x".repeat(2 * OMP_MAX_FRAME_BYTES) });
    framingError(() => new OmpChunkReassembler().push({ ...first!, data: `${first!.data}=` }));
    framingError(() =>
      new OmpChunkReassembler().push({ ...first!, byteLength: OMP_MAX_FRAME_BYTES - 1 }),
    );
  });
});

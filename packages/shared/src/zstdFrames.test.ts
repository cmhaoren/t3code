// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { decompressZstdFrameChunks, decompressZstdFrames, splitZstdFrames } from "./zstdFrames.ts";

function makeSkippableFrame(payload: Uint8Array): Buffer {
  const frame = Buffer.alloc(8 + payload.byteLength);
  frame.writeUInt32LE(0x184d2a50, 0);
  frame.writeUInt32LE(payload.byteLength, 4);
  frame.set(payload, 8);
  return frame;
}

describe("zstdFrames", () => {
  it("returns empty output for empty buffer", () => {
    const empty = new Uint8Array(0);
    expect(splitZstdFrames(empty)).toEqual([]);
    expect([...decompressZstdFrameChunks(empty)]).toEqual([]);
    expect(decompressZstdFrames(empty).toString("utf8")).toBe("");
  });

  it("decompresses a single standard zstd frame", () => {
    const compressed = NodeZlib.zstdCompressSync(Buffer.from('{"a":1}\n'));
    expect(splitZstdFrames(compressed)).toHaveLength(1);
    expect(decompressZstdFrames(compressed).toString("utf8")).toBe('{"a":1}\n');
  });

  it("decompresses all concatenated zstd frames in order", () => {
    const line1 = '{"type":"session","id":"s1"}\n';
    const line2 = '{"type":"assistant/message","seq":2}\n';
    const line3 = '{"type":"compaction/summary","seq":3}\n';
    const combined = Buffer.concat([
      NodeZlib.zstdCompressSync(Buffer.from(line1)),
      NodeZlib.zstdCompressSync(Buffer.from(line2)),
      NodeZlib.zstdCompressSync(Buffer.from(line3)),
    ]);

    expect(splitZstdFrames(combined)).toHaveLength(3);
    const chunks = [...decompressZstdFrameChunks(combined)].map((c) => c.toString("utf8"));
    expect(chunks).toEqual([line1, line2, line3]);
    expect(decompressZstdFrames(combined).toString("utf8")).toBe(line1 + line2 + line3);
  });

  it("skips RFC 8878 skippable frames between data frames", () => {
    const frame1 = NodeZlib.zstdCompressSync(Buffer.from("one\n"));
    const skip = makeSkippableFrame(Buffer.from("metadata-skip"));
    const frame2 = NodeZlib.zstdCompressSync(Buffer.from("two\n"));
    const combined = Buffer.concat([frame1, skip, frame2]);

    expect(splitZstdFrames(combined)).toHaveLength(2);
    expect(decompressZstdFrames(combined).toString("utf8")).toBe("one\ntwo\n");
  });

  it("recovers all complete leading frames when the trailing frame is truncated", () => {
    const frame1 = NodeZlib.zstdCompressSync(Buffer.from("complete-1\n"));
    const frame2 = NodeZlib.zstdCompressSync(Buffer.from("complete-2\n"));
    const frame3 = NodeZlib.zstdCompressSync(Buffer.from("incomplete-3-trailing-payload\n"));
    const combined = Buffer.concat([frame1, frame2, frame3.subarray(0, frame3.length - 4)]);

    expect(splitZstdFrames(combined)).toHaveLength(2);
    expect(decompressZstdFrames(combined).toString("utf8")).toBe("complete-1\ncomplete-2\n");
  });
});

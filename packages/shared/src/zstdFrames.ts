// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";

const ZSTD_FRAME_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MAGIC_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_MAGIC_BASE = 0x184d2a50;

const DICT_ID_SIZES = [0, 1, 2, 4] as const;
const FCS_SIZES_WITH_SINGLE_SEGMENT = [1, 2, 4, 8] as const;
const FCS_SIZES_MULTI_SEGMENT = [0, 2, 4, 8] as const;

export interface ZstdFrameSlice {
  readonly skippable: boolean;
  readonly bytes: Uint8Array;
}

function readUInt32LE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset]! |
      (buffer[offset + 1]! << 8) |
      (buffer[offset + 2]! << 16) |
      (buffer[offset + 3]! << 24)) >>>
    0
  );
}

/**
 * Split a concatenated RFC 8878 Zstandard stream into individual frame slices.
 * Node's built-in zstd stream stops after the first frame, so DSH append-per-write logs must be split per frame.
 * Stops cleanly at a truncated trailing frame.
 */
export function splitZstdFrames(buffer: Uint8Array): ReadonlyArray<Uint8Array> {
  const frames: Uint8Array[] = [];
  let pos = 0;

  while (pos + 4 <= buffer.length) {
    const magic = readUInt32LE(buffer, pos);

    if ((magic & ZSTD_SKIPPABLE_MAGIC_MASK) === ZSTD_SKIPPABLE_MAGIC_BASE) {
      if (pos + 8 > buffer.length) break;
      const frameSize = readUInt32LE(buffer, pos + 4);
      const next = pos + 8 + frameSize;
      if (next > buffer.length) break;
      pos = next;
      continue;
    }

    if (magic !== ZSTD_FRAME_MAGIC) {
      break;
    }

    const frameStart = pos;
    pos += 4;
    if (pos >= buffer.length) break;

    const fhd = buffer[pos++]!;
    const fcsFlag = (fhd >> 6) & 0x03;
    const singleSegment = ((fhd >> 5) & 0x01) === 1;
    const contentChecksum = ((fhd >> 2) & 0x01) === 1;
    const dictIdFlag = fhd & 0x03;

    if (!singleSegment) pos += 1; // Window_Descriptor
    pos += DICT_ID_SIZES[dictIdFlag]!;
    pos += singleSegment
      ? FCS_SIZES_WITH_SINGLE_SEGMENT[fcsFlag]!
      : FCS_SIZES_MULTI_SEGMENT[fcsFlag]!;

    if (pos > buffer.length) break;

    let lastBlock = false;
    let truncated = false;
    while (!lastBlock) {
      if (pos + 3 > buffer.length) {
        truncated = true;
        break;
      }
      const bh = buffer[pos]! | (buffer[pos + 1]! << 8) | (buffer[pos + 2]! << 16);
      pos += 3;
      lastBlock = (bh & 1) === 1;
      const blockType = (bh >> 1) & 3;
      const blockSize = bh >> 3;
      if (blockType === 0 || blockType === 2) {
        pos += blockSize;
      } else if (blockType === 1) {
        // RLE block carries exactly 1 byte payload regardless of regenerated size.
        pos += 1;
      } else {
        truncated = true;
        break;
      }
      if (pos > buffer.length) {
        truncated = true;
        break;
      }
    }

    if (truncated) break;

    if (contentChecksum) {
      pos += 4;
      if (pos > buffer.length) break;
    }

    frames.push(buffer.subarray(frameStart, pos));
  }

  return frames;
}

/**
 * Yield decompressed buffers for each complete Zstandard frame in a potentially
 * concatenated stream. A trailing corrupt/incomplete frame stops iteration
 * without discarding earlier valid frames.
 */
export function* decompressZstdFrameChunks(buffer: Uint8Array): Iterable<Buffer> {
  if (buffer.byteLength === 0) return;
  const frames = splitZstdFrames(buffer);
  for (let i = 0; i < frames.length; i += 1) {
    try {
      yield NodeZlib.zstdDecompressSync(frames[i]!);
    } catch {
      // Stop if a trailing frame fails to decompress while preserving prior frames.
      if (i === frames.length - 1) return;
      throw new Error(`Failed to decompress zstd frame ${i}`);
    }
  }
}

/**
 * Decompress all complete Zstandard frames from a single-frame or concatenated
 * multi-frame buffer into one combined Buffer.
 */
export function decompressZstdFrames(buffer: Uint8Array): Buffer {
  const chunks: Buffer[] = [];
  for (const chunk of decompressZstdFrameChunks(buffer)) {
    chunks.push(chunk);
  }
  return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
}

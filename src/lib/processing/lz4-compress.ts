import lz4 from 'lz4js';

function writeU32LE(val: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = val & 255;
  b[1] = (val >>> 8) & 255;
  b[2] = (val >>> 16) & 255;
  b[3] = (val >>> 24) & 255;
  return b;
}

function writeU16LE(val: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = val & 255;
  b[1] = (val >>> 8) & 255;
  return b;
}

/**
 * Compresses an uncompressed XTC ArrayBuffer into the XTCZ (LZ4) format
 * compatible with the XTEink reader hardware.
 */
export function compressXtczLz4(uncompressedData: ArrayBuffer | Uint8Array): ArrayBuffer {
  const e = uncompressedData instanceof Uint8Array ? uncompressedData : new Uint8Array(uncompressedData);
  const t = e.length;
  const n = 4096; // XTZ4_BLOCK_SIZE
  const a: Uint8Array[] = [];

  // Magic 'XTZ4'
  a.push(new Uint8Array([88, 84, 90, 52])); 
  a.push(writeU32LE(t)); // Uncompressed size
  a.push(writeU32LE(n)); // Block size

  // Unknown header fields required by the reader
  const numChunks = Math.ceil(t / n);
  a.push(writeU32LE(numChunks));
  a.push(writeU16LE(1010)); 

  const r = 65536;
  const i = new Array(r);
  for (let o = 0; o < r; o++) i[o] = 0;
  
  for (let l = 0; l < t;) {
    const s = Math.min(n, t - l);
    const g = lz4.compressBound(s);
    const d = new Uint8Array(g);
    for (let u = 0; u < r; u++) i[u] = 0;
    
    const c = lz4.compressBlock(e, d, l, s, i);
    
    if (c > 0 && c < s) {
      a.push(writeU32LE(c));
      a.push(d.slice(0, c));
    } else {
      // High bit set indicates uncompressed chunk
      a.push(writeU32LE(2147483648 | s));
      a.push(e.slice(l, l + s));
    }
    l += s;
  }

  let totalLength = 0;
  for (const buf of a) totalLength += buf.length;
  
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of a) {
    result.set(buf, offset);
    offset += buf.length;
  }
  
  return result.buffer;
}

/**
 * Decompresses an XTCZ (LZ4) ArrayBuffer back into its original uncompressed XTC payload.
 */
export function decompressXtczLz4(compressedData: ArrayBuffer | Uint8Array): ArrayBuffer {
  const e = compressedData instanceof Uint8Array ? compressedData : new Uint8Array(compressedData);
  
  if (e.length < 18) throw new Error("Invalid XTCZ: file too small");
  
  // Verify magic 'XTZ4'
  if (e[0] !== 88 || e[1] !== 84 || e[2] !== 90 || e[3] !== 52) {
    throw new Error("Invalid XTCZ: bad magic number");
  }

  const view = new DataView(e.buffer, e.byteOffset, e.length);
  const uncompressedSize = view.getUint32(4, true);
  const numChunks = view.getUint32(12, true);

  const result = new Uint8Array(uncompressedSize);
  let readOffset = 18;
  let writeOffset = 0;

  for (let i = 0; i < numChunks; i++) {
    if (readOffset >= e.length) break;
    
    const descriptor = view.getUint32(readOffset, true);
    readOffset += 4;
    
    const isUncompressed = (descriptor & 0x80000000) !== 0;
    const size = descriptor & 0x7FFFFFFF;
    
    if (readOffset + size > e.length) {
      throw new Error("Invalid XTCZ: chunk data out of bounds");
    }

    const chunkData = e.subarray(readOffset, readOffset + size);
    readOffset += size;

    if (isUncompressed) {
      result.set(chunkData, writeOffset);
      writeOffset += size;
    } else {
      writeOffset = lz4.decompressBlock(chunkData, result, 0, size, writeOffset);
    }
  }

  return result.buffer;
}

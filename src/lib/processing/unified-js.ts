/**
 * Unified JavaScript Processing Pipeline
 * This combines filtering (grayscale, contrast, gamma, invert) and bit-packing 
 * into a single high-performance pass to minimize memory iterations and allocations.
 * 
 * OPTIMIZATION: Uses a fused 256-entry LUT that combines all filter operations
 * (invert → contrast stretch → gamma) into a single lookup per pixel.
 * The inner loop becomes: gray = LUT[(r*77 + g*150 + b*29) >>> 8]
 */

export interface UnifiedOptions {
  contrast: number;
  gamma: number;
  invert: boolean;
  is2bit: boolean;
}

/**
 * Build a fused LUT that maps input grayscale [0-255] → filtered grayscale [0-255].
 * Applies: invert → contrast stretch → gamma, all in one lookup.
 */
function buildFusedLut(
  contrast: number,
  gamma: number,
  invert: boolean,
  blackPoint: number,
  whitePoint: number
): Uint8Array {
  const lut = new Uint8Array(256);
  const range = whitePoint - blackPoint;
  const hasContrast = contrast > 0 && range > 0;

  for (let i = 0; i < 256; i++) {
    let v = i;

    // 1. Invert
    if (invert) v = 255 - v;

    // 2. Contrast stretch
    if (hasContrast) {
      v = ((v - blackPoint) * 255 / range) | 0;
      if (v < 0) v = 0; else if (v > 255) v = 255;
    }

    // 3. Gamma
    if (gamma !== 1.0) {
      v = Math.round(Math.pow(v / 255, gamma) * 255);
    }

    lut[i] = v;
  }

  return lut;
}

/**
 * Compute histogram on grayscale values and find contrast black/white points.
 */
function computeContrastPoints(
  data: Uint8ClampedArray | Uint8Array,
  contrast: number
): { blackPoint: number; whitePoint: number } {
  if (contrast <= 0) return { blackPoint: 0, whitePoint: 255 };

  const histogram = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const g = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >>> 8;
    histogram[g]++;
  }

  const totalPixels = data.length / 4;
  const blackThreshold = totalPixels * (3 * contrast) / 100;
  const whiteThreshold = totalPixels * (3 + 9 * contrast) / 100;

  let blackPoint = 0;
  let whitePoint = 255;
  let count = 0;
  for (let i = 0; i < 256; i++) {
    count += histogram[i];
    if (count >= blackThreshold) { blackPoint = i; break; }
  }
  count = 0;
  for (let i = 255; i >= 0; i--) {
    count += histogram[i];
    if (count >= whiteThreshold) { whitePoint = i; break; }
  }

  return { blackPoint, whitePoint };
}

/**
 * Single-pass Filter + Pack (1-bit XTG)
 * Uses fused LUT — one lookup per pixel, zero branches in the filter path.
 */
export function runUnifiedXtg(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: UnifiedOptions
): ArrayBuffer {
  const { contrast, gamma, invert } = options;
  const rowBytes = (width + 7) >>> 3;
  const pixelData = new Uint8Array(rowBytes * height);

  // Build fused LUT
  const { blackPoint, whitePoint } = computeContrastPoints(data, contrast);
  const lut = buildFusedLut(contrast, gamma, invert, blackPoint, whitePoint);

  const fullBytes = width >>> 3;
  const remainder = width & 7;

  // Combined Pass: Filter (via LUT) + 1-bit Pack
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowBytes;
    const dataOffset = y * width * 4;

    // Fast path: full 8-pixel groups
    for (let col = 0; col < fullBytes; col++) {
      const base = dataOffset + (col << 5);
      // Each pixel: grayscale → LUT → threshold at 128
      pixelData[rowOffset + col] =
        ((lut[(data[base]      * 77 + data[base + 1]  * 150 + data[base + 2]  * 29) >>> 8] & 0x80)) |
        ((lut[(data[base + 4]  * 77 + data[base + 5]  * 150 + data[base + 6]  * 29) >>> 8] & 0x80) >>> 1) |
        ((lut[(data[base + 8]  * 77 + data[base + 9]  * 150 + data[base + 10] * 29) >>> 8] & 0x80) >>> 2) |
        ((lut[(data[base + 12] * 77 + data[base + 13] * 150 + data[base + 14] * 29) >>> 8] & 0x80) >>> 3) |
        ((lut[(data[base + 16] * 77 + data[base + 17] * 150 + data[base + 18] * 29) >>> 8] & 0x80) >>> 4) |
        ((lut[(data[base + 20] * 77 + data[base + 21] * 150 + data[base + 22] * 29) >>> 8] & 0x80) >>> 5) |
        ((lut[(data[base + 24] * 77 + data[base + 25] * 150 + data[base + 26] * 29) >>> 8] & 0x80) >>> 6) |
        ((lut[(data[base + 28] * 77 + data[base + 29] * 150 + data[base + 30] * 29) >>> 8] & 0x80) >>> 7);
    }

    // Slow path: remaining pixels
    if (remainder > 0) {
      let packedByte = 0;
      const base = dataOffset + (fullBytes << 5);
      for (let bi = 0; bi < remainder; bi++) {
        const idx = base + (bi << 2);
        const gray = lut[(data[idx] * 77 + data[idx + 1] * 150 + data[idx + 2] * 29) >>> 8];
        if (gray >= 128) packedByte |= (0x80 >>> bi);
      }
      pixelData[rowOffset + fullBytes] = packedByte;
    }
  }

  return createXtgBuffer(pixelData, width, height);
}

/**
 * Single-pass Filter + Pack (2-bit Planar XTH)
 * Uses fused LUT for filtering. Vertical scan with fast/slow path split.
 */
export function runUnifiedXth(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: UnifiedOptions
): ArrayBuffer {
  const { contrast, gamma, invert } = options;
  const colBytes = (height + 7) >>> 3;
  const planeSize = colBytes * width;
  const p0 = new Uint8Array(planeSize);
  const p1 = new Uint8Array(planeSize);

  // Build fused LUT
  const { blackPoint, whitePoint } = computeContrastPoints(data, contrast);
  const lut = buildFusedLut(contrast, gamma, invert, blackPoint, whitePoint);

  const fullGroups = height >>> 3;
  const remainder = height & 7;
  const w4 = width << 2;

  // Combined Pass: Vertical Right-to-Left Scan (XTH Planar)
  for (let x = 0; x < width; x++) {
    const colOffset = (width - 1 - x) * colBytes;
    const xBase = x << 2;

    // Fast path: full 8-row groups
    for (let g = 0; g < fullGroups; g++) {
      const y = g << 3;
      let byte0 = 0, byte1 = 0;
      let ptr = y * w4 + xBase;

      for (let bi = 0; bi < 8; bi++) {
        const gray = lut[(data[ptr] * 77 + data[ptr + 1] * 150 + data[ptr + 2] * 29) >>> 8];
        if (gray < 212) {
          const mask = 0x80 >>> bi;
          if (gray < 42) { byte0 |= mask; byte1 |= mask; }
          else if (gray < 127) { byte1 |= mask; }
          else { byte0 |= mask; }
        }
        ptr += w4;
      }
      const byteIdx = colOffset + g;
      p0[byteIdx] = byte0;
      p1[byteIdx] = byte1;
    }

    // Slow path: remaining rows
    if (remainder > 0) {
      const y = fullGroups << 3;
      let byte0 = 0, byte1 = 0;
      let ptr = y * w4 + xBase;

      for (let bi = 0; bi < remainder; bi++) {
        const gray = lut[(data[ptr] * 77 + data[ptr + 1] * 150 + data[ptr + 2] * 29) >>> 8];
        if (gray < 212) {
          const mask = 0x80 >>> bi;
          if (gray < 42) { byte0 |= mask; byte1 |= mask; }
          else if (gray < 127) { byte1 |= mask; }
          else { byte0 |= mask; }
        }
        ptr += w4;
      }
      const byteIdx = colOffset + fullGroups;
      p0[byteIdx] = byte0;
      p1[byteIdx] = byte1;
    }
  }

  return createXthBuffer(p0, p1, width, height);
}

function createXtgBuffer(pixelData: Uint8Array, w: number, h: number): ArrayBuffer {
  const headerSize = 22;
  const buffer = new ArrayBuffer(headerSize + pixelData.length);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);
  uint8.set([0x58, 0x54, 0x47, 0x00]); // XTG
  view.setUint16(4, w, true);
  view.setUint16(6, h, true);
  view.setUint32(10, pixelData.length, true);
  uint8.set(pixelData.subarray(0, 8), 14); // Digest shim
  uint8.set(pixelData, headerSize);
  return buffer;
}

function createXthBuffer(p0: Uint8Array, p1: Uint8Array, w: number, h: number): ArrayBuffer {
  const headerSize = 22;
  const planeSize = p0.length;
  const buffer = new ArrayBuffer(headerSize + planeSize * 2);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);
  uint8.set([0x58, 0x54, 0x48, 0x00]); // XTH
  view.setUint16(4, w, true);
  view.setUint16(6, h, true);
  view.setUint32(10, planeSize * 2, true);
  for (let i = 0; i < 8; i++) uint8[14 + i] = p0[i] ^ p1[i];
  uint8.set(p0, headerSize);
  uint8.set(p1, headerSize + planeSize);
  return buffer;
}

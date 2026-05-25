/**
 * Unified JavaScript Processing Pipeline
 * This combines filtering (grayscale, contrast, gamma, invert), dithering, and bit-packing 
 * into a single high-performance pass to minimize memory iterations and allocations.
 * 
 * OPTIMIZATION: Uses a fused 256-entry LUT that combines all filter operations
 * (invert → contrast stretch → gamma) into a single lookup per pixel.
 * The inner loop becomes: gray = LUT[(r*77 + g*150 + b*29) >>> 8]
 * 
 * When dithering is enabled, uses rolling error buffers (2-3 rows) instead of
 * a full width×height Float32Array, reducing memory by ~95% for large images.
 */

export interface UnifiedOptions {
  contrast: number;
  gamma: number;
  invert: boolean;
  is2bit: boolean;
  dithering?: string;
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
 * Quantize a 1-bit value: threshold at 128
 */
function quantize1bit(val: number): number {
  return val < 128 ? 0 : 255;
}

/**
 * Quantize a 2-bit value: 4 levels (0, 85, 170, 255)
 */
function quantize2bit(val: number): number {
  if (val < 42) return 0;
  if (val < 127) return 85;
  if (val < 212) return 170;
  return 255;
}

/**
 * Single-pass Filter + Pack (1-bit XTG) — NO dithering
 * Uses fused LUT — one lookup per pixel, zero branches in the filter path.
 */
export function runUnifiedXtg(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: UnifiedOptions
): ArrayBuffer {
  const dithering = options.dithering || 'none';
  
  // Dispatch to dithered path if needed
  if (dithering !== 'none') {
    return runDitheredXtg(data, width, height, options, dithering);
  }
  
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
 * Fused Filter + Dither + Pack (1-bit XTG) 
 * Uses rolling error buffers (2-3 rows) to minimize memory allocations.
 * Eliminates the separate Float32Array(width*height) allocation used by standalone dithering.
 */
function runDitheredXtg(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: UnifiedOptions,
  algorithm: string
): ArrayBuffer {
  const { contrast, gamma, invert } = options;
  const rowBytes = (width + 7) >>> 3;
  const pixelData = new Uint8Array(rowBytes * height);

  // Build fused LUT  
  const { blackPoint, whitePoint } = computeContrastPoints(data, contrast);
  const lut = buildFusedLut(contrast, gamma, invert, blackPoint, whitePoint);

  // Rolling error buffer: only need current + next rows for most algorithms
  // For Stucki/ZhouFang we need 3 rows (current + next + next+1)
  const needsThreeRows = algorithm === 'stucki' || algorithm === 'zhoufang';
  const errRows = needsThreeRows ? 3 : 2;
  const errBufs: Float32Array[] = [];
  for (let i = 0; i < errRows; i++) errBufs.push(new Float32Array(width));

  for (let y = 0; y < height; y++) {
    const dataOffset = y * width * 4;
    const rowOffset = y * rowBytes;
    const curErr = errBufs[0];
    const nextErr = errBufs[1];
    const next2Err = needsThreeRows ? errBufs[2] : null;

    // Process row: apply LUT + accumulate dither error + pack bits
    let packedByte = 0;
    let bitPos = 0;
    let byteIdx = 0;

    for (let x = 0; x < width; x++) {
      const idx = dataOffset + (x << 2);
      const gray = lut[(data[idx] * 77 + data[idx + 1] * 150 + data[idx + 2] * 29) >>> 8];
      
      // Add accumulated error
      let val = gray + curErr[x];
      if (val < 0) val = 0; else if (val > 255) val = 255;

      // Quantize
      const newVal = val < 128 ? 0 : 255;
      const err = val - newVal;

      // Pack bit
      if (newVal >= 128) packedByte |= (0x80 >>> bitPos);
      bitPos++;
      if (bitPos === 8) {
        pixelData[rowOffset + byteIdx] = packedByte;
        packedByte = 0;
        bitPos = 0;
        byteIdx++;
      }

      // Distribute error based on algorithm
      if (err !== 0) {
        distributeError1bit(curErr, nextErr, next2Err, x, width, err, algorithm);
      }
    }

    // Pack remaining bits
    if (bitPos > 0) {
      pixelData[rowOffset + byteIdx] = packedByte;
    }

    // Rotate error buffers: current → discard, next → current, next2 → next, new zeroed → last
    errBufs[0] = errBufs[1];
    if (needsThreeRows) {
      errBufs[1] = errBufs[2];
      errBufs[2] = curErr;
    } else {
      errBufs[1] = curErr;
    }
    // Zero out the recycled buffer
    const recycled = errBufs[errRows - 1];
    recycled.fill(0);
  }

  return createXtgBuffer(pixelData, width, height);
}

/**
 * Distribute quantization error for 1-bit output.
 * Supports Floyd-Steinberg, Atkinson, Stucki, ZhouFang, and Ostromoukhov.
 */
function distributeError1bit(
  curErr: Float32Array, nextErr: Float32Array, next2Err: Float32Array | null,
  x: number, width: number, err: number, algorithm: string
): void {
  switch (algorithm) {
    case 'floyd': {
      const e7 = err * 7 / 16;
      const e3 = err * 3 / 16;
      const e5 = err * 5 / 16;
      const e1 = err / 16;
      if (x + 1 < width) curErr[x + 1] += e7;
      if (x > 0) nextErr[x - 1] += e3;
      nextErr[x] += e5;
      if (x + 1 < width) nextErr[x + 1] += e1;
      break;
    }
    case 'atkinson': {
      const e = err / 8;
      if (x + 1 < width) curErr[x + 1] += e;
      if (x + 2 < width) curErr[x + 2] += e;
      if (x > 0) nextErr[x - 1] += e;
      nextErr[x] += e;
      if (x + 1 < width) nextErr[x + 1] += e;
      if (next2Err) next2Err[x] += e;
      else nextErr[x] += e; // Fallback: fold row+2 into row+1
      break;
    }
    case 'stucki': {
      const e = err / 42;
      if (x + 1 < width) curErr[x + 1] += e * 8;
      if (x + 2 < width) curErr[x + 2] += e * 4;
      if (x - 2 >= 0) nextErr[x - 2] += e * 2;
      if (x - 1 >= 0) nextErr[x - 1] += e * 4;
      nextErr[x] += e * 8;
      if (x + 1 < width) nextErr[x + 1] += e * 4;
      if (x + 2 < width) nextErr[x + 2] += e * 2;
      if (next2Err) {
        if (x - 2 >= 0) next2Err[x - 2] += e;
        if (x - 1 >= 0) next2Err[x - 1] += e * 2;
        next2Err[x] += e * 4;
        if (x + 1 < width) next2Err[x + 1] += e * 2;
        if (x + 2 < width) next2Err[x + 2] += e;
      }
      break;
    }
    case 'zhoufang': {
      const e = err / 103;
      if (x + 1 < width) curErr[x + 1] += e * 16;
      if (x + 2 < width) curErr[x + 2] += e * 9;
      if (x - 2 >= 0) nextErr[x - 2] += e * 5;
      if (x - 1 >= 0) nextErr[x - 1] += e * 11;
      nextErr[x] += e * 16;
      if (x + 1 < width) nextErr[x + 1] += e * 11;
      if (x + 2 < width) nextErr[x + 2] += e * 5;
      if (next2Err) {
        if (x - 2 >= 0) next2Err[x - 2] += e * 3;
        if (x - 1 >= 0) next2Err[x - 1] += e * 5;
        next2Err[x] += e * 9;
        if (x + 1 < width) next2Err[x + 1] += e * 5;
        if (x + 2 < width) next2Err[x + 2] += e * 3;
      }
      break;
    }
    case 'ostromoukhov': {
      const v = Math.min(255, Math.max(0, err + 128));
      let d1: number, d2: number, d3: number;
      if (v <= 128) {
        const t = v / 128.0;
        d1 = 0.7 * (1 - t) + 0.3 * t;
        d2 = 0.2 * (1 - t) + 0.4 * t;
        d3 = 0.1 * (1 - t) + 0.3 * t;
      } else {
        const t = (v - 128) / 127.0;
        d1 = 0.3 * (1 - t) + 0.7 * t;
        d2 = 0.4 * (1 - t) + 0.2 * t;
        d3 = 0.3 * (1 - t) + 0.1 * t;
      }
      if (x + 1 < width) curErr[x + 1] += err * d1;
      if (x > 0) nextErr[x - 1] += err * d2;
      nextErr[x] += err * d3;
      break;
    }
    default: {
      // Default: Floyd-Steinberg
      if (x + 1 < width) curErr[x + 1] += err * 7 / 16;
      if (x > 0) nextErr[x - 1] += err * 3 / 16;
      nextErr[x] += err * 5 / 16;
      if (x + 1 < width) nextErr[x + 1] += err / 16;
      break;
    }
  }
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
  const dithering = options.dithering || 'none';
  
  // Dispatch to dithered path if needed
  if (dithering !== 'none') {
    return runDitheredXth(data, width, height, options, dithering);
  }
  
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

/**
 * Fused Filter + Dither + Pack (2-bit Planar XTH)
 * 
 * For XTH, dithering must happen in raster order (left-to-right, top-to-bottom)
 * because error diffusion is sequential. We first dither into a grayscale buffer, 
 * then pack using the XTH vertical R-to-L scan.
 * 
 * Optimization: We use the fused LUT to avoid separate filter passes, and
 * pack directly from the quantized grayscale values without creating intermediate ImageData.
 */
function runDitheredXth(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: UnifiedOptions,
  algorithm: string
): ArrayBuffer {
  const { contrast, gamma, invert } = options;
  
  // Build fused LUT
  const { blackPoint, whitePoint } = computeContrastPoints(data, contrast);
  const lut = buildFusedLut(contrast, gamma, invert, blackPoint, whitePoint);

  // Dither in raster order into a quantized grayscale buffer
  // Uses rolling error buffers to minimize memory
  const needsThreeRows = algorithm === 'stucki' || algorithm === 'zhoufang';
  const errRows = needsThreeRows ? 3 : 2;
  const errBufs: Float32Array[] = [];
  for (let i = 0; i < errRows; i++) errBufs.push(new Float32Array(width));

  // Quantized grayscale buffer (one byte per pixel, only need 4 levels: 0, 85, 170, 255)
  const quantized = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const dataOffset = y * width * 4;
    const qOffset = y * width;
    const curErr = errBufs[0];
    const nextErr = errBufs[1];
    const next2Err = needsThreeRows ? errBufs[2] : null;

    for (let x = 0; x < width; x++) {
      const idx = dataOffset + (x << 2);
      const gray = lut[(data[idx] * 77 + data[idx + 1] * 150 + data[idx + 2] * 29) >>> 8];
      
      let val = gray + curErr[x];
      if (val < 0) val = 0; else if (val > 255) val = 255;

      const newVal = quantize2bit(val);
      quantized[qOffset + x] = newVal;
      const err = val - newVal;

      if (err !== 0) {
        distributeError1bit(curErr, nextErr, next2Err, x, width, err, algorithm);
      }
    }

    // Rotate error buffers
    errBufs[0] = errBufs[1];
    if (needsThreeRows) {
      errBufs[1] = errBufs[2];
      errBufs[2] = curErr;
    } else {
      errBufs[1] = curErr;
    }
    errBufs[errRows - 1].fill(0);
  }

  // Pack quantized values into XTH planar format (vertical R-to-L scan)
  const colBytes = (height + 7) >>> 3;
  const planeSize = colBytes * width;
  const p0 = new Uint8Array(planeSize);
  const p1 = new Uint8Array(planeSize);

  const fullGroups = height >>> 3;
  const remainder = height & 7;

  for (let x = 0; x < width; x++) {
    const colOffset = (width - 1 - x) * colBytes;

    for (let g = 0; g < fullGroups; g++) {
      const y = g << 3;
      let byte0 = 0, byte1 = 0;

      for (let bi = 0; bi < 8; bi++) {
        const gray = quantized[(y + bi) * width + x];
        if (gray < 212) {
          const mask = 0x80 >>> bi;
          if (gray < 42) { byte0 |= mask; byte1 |= mask; }
          else if (gray < 127) { byte1 |= mask; }
          else { byte0 |= mask; }
        }
      }
      p0[colOffset + g] = byte0;
      p1[colOffset + g] = byte1;
    }

    if (remainder > 0) {
      const y = fullGroups << 3;
      let byte0 = 0, byte1 = 0;
      for (let bi = 0; bi < remainder; bi++) {
        const gray = quantized[(y + bi) * width + x];
        if (gray < 212) {
          const mask = 0x80 >>> bi;
          if (gray < 42) { byte0 |= mask; byte1 |= mask; }
          else if (gray < 127) { byte1 |= mask; }
          else { byte0 |= mask; }
        }
      }
      p0[colOffset + fullGroups] = byte0;
      p1[colOffset + fullGroups] = byte1;
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

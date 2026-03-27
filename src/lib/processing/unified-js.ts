/**
 * Unified JavaScript Processing Pipeline
 * This combines filtering (grayscale, contrast, gamma, invert) and bit-packing 
 * into a single high-performance pass to minimize memory iterations and allocations.
 */

export interface UnifiedOptions {
  contrast: number;
  gamma: number;
  invert: boolean;
  is2bit: boolean;
}

/**
 * Single-pass Filter + Pack (1-bit XTG)
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
  
  // Pre-calculate Gamma LUT
  const gammaLut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    gammaLut[i] = Math.round(Math.pow(i / 255, gamma) * 255);
  }

  // Pre-calculate Contrast Points
  let blackPoint = 0;
  let whitePoint = 255;
  let range = 255;

  if (contrast > 0) {
    const histogram = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) {
      const g = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
      histogram[g]++;
    }
    const totalPixels = data.length / 4;
    const blackThreshold = totalPixels * (3 * contrast) / 100;
    const whiteThreshold = totalPixels * (3 + 9 * contrast) / 100;
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
    range = whitePoint - blackPoint;
  }

  // Combined Pass: Filter + 1-bit Pack
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowBytes;
    const dataOffset = y * width * 4;
    
    for (let x = 0; x < width; x += 8) {
      let packedByte = 0;
      for (let bi = 0; bi < 8 && x + bi < width; bi++) {
        const idx = dataOffset + ((x + bi) << 2);
        let r = data[idx];
        let g = data[idx + 1];
        let b = data[idx + 2];

        if (invert) { r = 255 - r; g = 255 - g; b = 255 - b; }

        if (contrast > 0 && range > 0) {
          r = Math.max(0, Math.min(255, ((r - blackPoint) * 255 / range) | 0));
          g = Math.max(0, Math.min(255, ((g - blackPoint) * 255 / range) | 0));
          b = Math.max(0, Math.min(255, ((b - blackPoint) * 255 / range) | 0));
        }

        let gray = (r * 77 + g * 150 + b * 29) >>> 8;
        if (gamma !== 1.0) gray = gammaLut[gray];

        if (gray >= 128) {
          packedByte |= (0x80 >>> bi);
        }
      }
      pixelData[rowOffset + (x >>> 3)] = packedByte;
    }
  }

  return createXtgBuffer(pixelData, width, height);
}

/**
 * Single-pass Filter + Pack (2-bit Planar XTH)
 */
export function runUnifiedXth(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: UnifiedOptions
): ArrayBuffer {
  // Planar format requires vertical scan logic
  // Filtering is done per-pixel, then packed into two planes.
  const { contrast, gamma, invert } = options;
  const colBytes = (height + 7) >>> 3;
  const planeSize = colBytes * width;
  const p0 = new Uint8Array(planeSize);
  const p1 = new Uint8Array(planeSize);
  
  // Filter setup (Same as XTG)
  const gammaLut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) gammaLut[i] = Math.round(Math.pow(i / 255, gamma) * 255);

  let blackPoint = 0, whitePoint = 255, range = 255;
  if (contrast > 0) {
    const histogram = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) {
      histogram[Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])]++;
    }
    const totalPixels = data.length / 4;
    const bt = totalPixels * (3 * contrast) / 100, wt = totalPixels * (3 + 9 * contrast) / 100;
    let c = 0;
    for (let i = 0; i < 256; i++) { c += histogram[i]; if (c >= bt) { blackPoint = i; break; } }
    c = 0;
    for (let i = 255; i >= 0; i--) { c += histogram[i]; if (c >= wt) { whitePoint = i; break; } }
    range = whitePoint - blackPoint;
  }

  // Combined Pass: Vertical Right-to-Left Scan (XTH Planar)
  for (let x = 0; x < width; x++) {
    const colOffset = (width - 1 - x) * colBytes;
    for (let y = 0; y < height; y += 8) {
      let byte0 = 0, byte1 = 0;
      const maxBatch = Math.min(8, height - y);
      
      for (let bi = 0; bi < maxBatch; bi++) {
        const py = y + bi;
        const idx = (py * width + x) << 2;
        let r = data[idx], g = data[idx + 1], b = data[idx + 2];
        
        if (invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
        if (contrast > 0 && range > 0) {
          r = Math.max(0, Math.min(255, ((r - blackPoint) * 255 / range) | 0));
          g = Math.max(0, Math.min(255, ((g - blackPoint) * 255 / range) | 0));
          b = Math.max(0, Math.min(255, ((b - blackPoint) * 255 / range) | 0));
        }
        let gray = (r * 77 + g * 150 + b * 29) >>> 8;
        if (gamma !== 1.0) gray = gammaLut[gray];

        // 2-bit intensity mapping
        if (gray < 212) {
          if (gray < 42) { byte0 |= (1 << (7 - bi)); byte1 |= (1 << (7 - bi)); }
          else if (gray < 127) { byte1 |= (1 << (7 - bi)); }
          else { byte0 |= (1 << (7 - bi)); }
        }
      }
      const byteIdx = colOffset + (y >>> 3);
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

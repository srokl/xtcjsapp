// Dithering algorithms optimized for manga on e-ink displays
// Each algorithm has different characteristics for handling manga art

import { runWasmDither, isWasmLoaded } from './wasm'

/**
 * Applies the selected dithering algorithm to canvas
 */
export function applyDithering(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  algorithm: string,
  is2bit: boolean = false,
  useWasm: boolean = false
): void {
  const imageData = ctx.getImageData(0, 0, width, height);
  applyDitheringToData(imageData.data, width, height, algorithm, is2bit, useWasm);
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Applies the selected dithering algorithm to raw pixel data
 */
export function applyDitheringToData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  algorithm: string,
  is2bit: boolean = false,
  useWasm: boolean = false
): void {
  if (useWasm && isWasmLoaded() && (algorithm === 'stucki' || algorithm === 'atkinson')) {
    try {
      const tempImgData = new ImageData(data, width, height);
      runWasmDither(tempImgData, algorithm, is2bit);
      return;
    } catch (e) {
      console.warn("Wasm dither failed, fallback to CPU", e);
    }
  }

  switch (algorithm) {
    case 'none':
      applyThreshold(data, is2bit);
      break;
    case 'atkinson':
      applyAtkinson(data, width, height, is2bit);
      break;
    case 'floyd':
      applyFloydSteinberg(data, width, height, is2bit);
      break;
    case 'stucki':
      applyStucki(data, width, height, is2bit);
      break;
    case 'ostromoukhov':
      applyOstromoukhov(data, width, height, is2bit);
      break;
    case 'zhoufang':
      applyZhouFang(data, width, height, is2bit);
      break;
    case 'ordered':
      applyOrdered(data, width, height);
      break;
    case 'stochastic':
      applyStochastic(data, width, height, is2bit);
      break;
    default:
      applyFloydSteinberg(data, width, height, is2bit);
  }
}

/**
 * Space-Filling Curve Dithering (Velho/Hilbert)
 */
function applyStochastic(data: Uint8ClampedArray, width: number, height: number, is2bit: boolean): void {
  const maxDim = Math.max(width, height);
  let n = 1; while (n < maxDim) n *= 2;
  let error = 0;
  const totalPoints = n * n;
  
  for (let i = 0; i < totalPoints; i++) {
    let t = i; let x = 0; let y = 0;
    for (let s = 1; s < n; s *= 2) {
      const rx = 1 & (t / 2);
      const ry = 1 & (t ^ rx);
      if (ry === 0) {
        if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
        const tmp = x; x = y; y = tmp;
      }
      x += s * rx; y += s * ry; t = Math.floor(t / 4);
    }

    if (x < width && y < height) {
      const idx = (y * width + x) << 2;
      const currentVal = data[idx] + error;
      let newVal;

      if (is2bit) {
        if (currentVal < 42) newVal = 0;
        else if (currentVal < 127) newVal = 85;
        else if (currentVal < 212) newVal = 170;
        else newVal = 255;
      } else {
        newVal = currentVal < 128 ? 0 : 255;
      }

      data[idx] = data[idx + 1] = data[idx + 2] = newVal;
      error = currentVal - newVal;
    }
  }
}

function applyThreshold(data: Uint8ClampedArray, is2bit: boolean): void {
  const len = data.length;
  if (is2bit) {
    for (let i = 0; i < len; i += 4) {
      const val = data[i];
      let newVal;
      if (val < 42) newVal = 0;
      else if (val < 127) newVal = 85;
      else if (val < 212) newVal = 170;
      else newVal = 255;
      data[i] = data[i + 1] = data[i + 2] = newVal;
    }
  } else {
    for (let i = 0; i < len; i += 4) {
      const val = data[i] < 128 ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = val;
    }
  }
}

/**
 * Optimized Floyd-Steinberg
 */
function applyFloydSteinberg(pixels: Uint8ClampedArray, width: number, height: number, is2bit: boolean): void {
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = pixels[i << 2];

  const stride = width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * stride + x;
      const oldVal = data[idx];
      let newVal;

      if (is2bit) {
        if (oldVal < 42) newVal = 0;
        else if (oldVal < 127) newVal = 85;
        else if (oldVal < 212) newVal = 170;
        else newVal = 255;
      } else {
        newVal = oldVal < 128 ? 0 : 255;
      }

      data[idx] = newVal;
      const err = oldVal - newVal;

      if (x + 1 < width) data[idx + 1] += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) data[idx + stride - 1] += (err * 3) / 16;
        data[idx + stride] += (err * 5) / 16;
        if (x + 1 < width) data[idx + stride + 1] += (err * 1) / 16;
      }
    }
  }

  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    pixels[i << 2] = pixels[(i << 2) + 1] = pixels[(i << 2) + 2] = val < 0 ? 0 : (val > 255 ? 255 : val);
  }
}

/**
 * Optimized Atkinson
 */
function applyAtkinson(pixels: Uint8ClampedArray, width: number, height: number, is2bit: boolean): void {
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = pixels[i << 2];
  
  const stride = width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * stride + x;
      const oldVal = data[idx];
      let newVal;

      if (is2bit) {
        if (oldVal < 42) newVal = 0;
        else if (oldVal < 127) newVal = 85;
        else if (oldVal < 212) newVal = 170;
        else newVal = 255;
      } else {
        newVal = oldVal < 128 ? 0 : 255;
      }

      data[idx] = newVal;
      const err = (oldVal - newVal) / 8;

      if (err !== 0) {
        if (x + 1 < width) data[idx + 1] += err;
        if (x + 2 < width) data[idx + 2] += err;
        if (y + 1 < height) {
          if (x > 0) data[idx + stride - 1] += err;
          data[idx + stride] += err;
          if (x + 1 < width) data[idx + stride + 1] += err;
        }
        if (y + 2 < height) data[idx + stride * 2] += err;
      }
    }
  }

  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    pixels[i << 2] = pixels[(i << 2) + 1] = pixels[(i << 2) + 2] = val < 0 ? 0 : (val > 255 ? 255 : val);
  }
}

function applyStucki(pixels: Uint8ClampedArray, width: number, height: number, is2bit: boolean): void {
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = pixels[i << 2];

  const stride = width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * stride + x;
      const oldVal = data[idx];
      let newVal;
      if (is2bit) {
        if (oldVal < 42) newVal = 0; else if (oldVal < 127) newVal = 85; else if (oldVal < 212) newVal = 170; else newVal = 255;
      } else {
        newVal = oldVal < 128 ? 0 : 255;
      }
      data[idx] = newVal;
      const err = oldVal - newVal;
      if (err !== 0) {
        const e = err / 42;
        if (x + 1 < width) data[idx + 1] += e * 8;
        if (x + 2 < width) data[idx + 2] += e * 4;
        if (y + 1 < height) {
          if (x - 2 >= 0) data[idx + stride - 2] += e * 2;
          if (x - 1 >= 0) data[idx + stride - 1] += e * 4;
          data[idx + stride] += e * 8;
          if (x + 1 < width) data[idx + stride + 1] += e * 4;
          if (x + 2 < width) data[idx + stride + 2] += e * 2;
        }
        if (y + 2 < height) {
          if (x - 2 >= 0) data[idx + (stride * 2) - 2] += e * 1;
          if (x - 1 >= 0) data[idx + (stride * 2) - 1] += e * 2;
          data[idx + (stride * 2)] += e * 4;
          if (x + 1 < width) data[idx + (stride * 2) + 1] += e * 2;
          if (x + 2 < width) data[idx + (stride * 2) + 2] += e * 1;
        }
      }
    }
  }
  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    pixels[i << 2] = pixels[(i << 2) + 1] = pixels[(i << 2) + 2] = val < 0 ? 0 : (val > 255 ? 255 : val);
  }
}

function applyZhouFang(pixels: Uint8ClampedArray, width: number, height: number, is2bit: boolean): void {
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = pixels[i << 2];
  const stride = width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * stride + x;
      const oldVal = data[idx];
      let newVal;
      if (is2bit) {
        if (oldVal < 42) newVal = 0; else if (oldVal < 127) newVal = 85; else if (oldVal < 212) newVal = 170; else newVal = 255;
      } else {
        newVal = oldVal < 128 ? 0 : 255;
      }
      data[idx] = newVal;
      const err = oldVal - newVal;
      if (err !== 0) {
        const e = err / 103;
        if (x + 1 < width) data[idx + 1] += e * 16;
        if (x + 2 < width) data[idx + 2] += e * 9;
        if (y + 1 < height) {
          if (x - 2 >= 0) data[idx + stride - 2] += e * 5;
          if (x - 1 >= 0) data[idx + stride - 1] += e * 11;
          data[idx + stride] += e * 16;
          if (x + 1 < width) data[idx + stride + 1] += e * 11;
          if (x + 2 < width) data[idx + stride + 2] += e * 5;
        }
        if (y + 2 < height) {
          if (x - 2 >= 0) data[idx + (stride * 2) - 2] += e * 3;
          if (x - 1 >= 0) data[idx + (stride * 2) - 1] += e * 5;
          data[idx + (stride * 2)] += e * 9;
          if (x + 1 < width) data[idx + (stride * 2) + 1] += e * 5;
          if (x + 2 < width) data[idx + (stride * 2) + 2] += e * 3;
        }
      }
    }
  }
  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    pixels[i << 2] = pixels[(i << 2) + 1] = pixels[(i << 2) + 2] = val < 0 ? 0 : (val > 255 ? 255 : val);
  }
}

function applyOstromoukhov(pixels: Uint8ClampedArray, width: number, height: number, is2bit: boolean): void {
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = pixels[i << 2];
  const stride = width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * stride + x;
      const oldVal = data[idx];
      let newVal;
      if (is2bit) {
        if (oldVal < 42) newVal = 0; else if (oldVal < 127) newVal = 85; else if (oldVal < 212) newVal = 170; else newVal = 255;
      } else {
        newVal = oldVal < 128 ? 0 : 255;
      }
      data[idx] = newVal;
      const err = oldVal - newVal;
      if (err !== 0) {
        let v = Math.min(255, Math.max(0, oldVal));
        let d1, d2, d3;
        if (v <= 128) {
          const t = v / 128.0;
          d1 = 0.7 * (1 - t) + 0.3 * t; d2 = 0.2 * (1 - t) + 0.4 * t; d3 = 0.1 * (1 - t) + 0.3 * t;
        } else {
          const t = (v - 128) / 127.0;
          d1 = 0.3 * (1 - t) + 0.7 * t; d2 = 0.4 * (1 - t) + 0.2 * t; d3 = 0.3 * (1 - t) + 0.1 * t;
        }
        if (x + 1 < width) data[idx + 1] += err * d1;
        if (y + 1 < height) {
          if (x > 0) data[idx + stride - 1] += err * d2;
          data[idx + stride] += err * d3;
        }
      }
    }
  }
  for (let i = 0; i < data.length; i++) {
    const val = data[i];
    pixels[i << 2] = pixels[(i << 2) + 1] = pixels[(i << 2) + 2] = val < 0 ? 0 : (val > 255 ? 255 : val);
  }
}

function applyOrdered(data: Uint8ClampedArray, width: number, height: number): void {
  const bayer = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;
      const val = data[idx] > (bayer[y % 4][x % 4] * 16) ? 255 : 0;
      data[idx] = data[idx + 1] = data[idx + 2] = val;
    }
  }
}

// Dithering algorithms optimized for manga on e-ink displays
// Each algorithm has different characteristics for handling manga art

/**
 * Applies the selected dithering algorithm to canvas
 */
export function applyDithering(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  algorithm: string,
  is2bit: boolean = false
): void {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

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
    case 'ordered':
      applyOrdered(data, width, height);
      break;
    default:
      applyFloydSteinberg(data, width, height, is2bit);
  }

  ctx.putImageData(imageData, 0, 0);
}

/**
 * Simple threshold - no dithering
 */
function applyThreshold(data: Uint8ClampedArray, is2bit: boolean): void {
  for (let i = 0; i < data.length; i += 4) {
    let val = data[i];
    if (is2bit) {
      if (val < 42) val = 0;
      else if (val < 127) val = 85;
      else if (val < 212) val = 170;
      else val = 255;
    } else {
      val = val < 128 ? 0 : 255;
    }
    data[i] = data[i + 1] = data[i + 2] = val;
  }
}

/**
 * Stucki dithering (High quality experimental)
 * 8   4
 * 2   4   8   4
 * 1   2   4   2
 * Divisor: 42
 */
function applyStucki(pixels: Uint8ClampedArray, width: number, height: number, is2bit: boolean): void {
  const data = new Int16Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = pixels[i * 4];

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

      if (err !== 0) {
        // Row 1
        if (x + 1 < width) data[idx + 1] += (err * 8) / 42;
        if (x + 2 < width) data[idx + 2] += (err * 4) / 42;
        
        // Row 2
        if (y + 1 < height) {
          if (x - 2 >= 0) data[idx + stride - 2] += (err * 2) / 42;
          if (x - 1 >= 0) data[idx + stride - 1] += (err * 4) / 42;
          data[idx + stride] += (err * 8) / 42;
          if (x + 1 < width) data[idx + stride + 1] += (err * 4) / 42;
          if (x + 2 < width) data[idx + stride + 2] += (err * 2) / 42;
        }

        // Row 3
        if (y + 2 < height) {
          if (x - 2 >= 0) data[idx + (stride * 2) - 2] += (err * 1) / 42;
          if (x - 1 >= 0) data[idx + (stride * 2) - 1] += (err * 2) / 42;
          data[idx + (stride * 2)] += (err * 4) / 42;
          if (x + 1 < width) data[idx + (stride * 2) + 1] += (err * 2) / 42;
          if (x + 2 < width) data[idx + (stride * 2) + 2] += (err * 1) / 42;
        }
      }
    }
  }

  for (let i = 0; i < data.length; i++) {
    const val = Math.max(0, Math.min(255, data[i]));
    pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = val;
  }
}

/**
 * Atkinson dithering
 * Optimized single-pass implementation using TypedArrays.
 */
function applyAtkinson(pixels: Uint8ClampedArray, width: number, height: number, is2bit: boolean): void {
  const data = new Int16Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = pixels[i * 4];
  
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
      const err = (oldVal - newVal) >> 3;

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
    const val = Math.max(0, Math.min(255, data[i]));
    pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = val;
  }
}

/**
 * Floyd-Steinberg dithering
 */
function applyFloydSteinberg(pixels: Uint8ClampedArray, width: number, height: number, is2bit: boolean): void {
  const data = new Int16Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = pixels[i * 4];

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

      if (x + 1 < width) data[idx + 1] += (err * 7) >> 4;
      if (y + 1 < height) {
        if (x > 0) data[idx + stride - 1] += (err * 3) >> 4;
        data[idx + stride] += (err * 5) >> 4;
        if (x + 1 < width) data[idx + stride + 1] += (err * 1) >> 4;
      }
    }
  }

  for (let i = 0; i < data.length; i++) {
    const val = Math.max(0, Math.min(255, data[i]));
    pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = val;
  }
}

/**
 * Ordered/Bayer dithering
 * Creates regular patterns
 */
function applyOrdered(data: Uint8ClampedArray, width: number, height: number): void {
  const bayer = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5]
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const threshold = (bayer[y % 4][x % 4] / 16) * 255;
      const val = data[idx] > threshold ? 255 : 0;
      data[idx] = data[idx + 1] = data[idx + 2] = val;
    }
  }
}

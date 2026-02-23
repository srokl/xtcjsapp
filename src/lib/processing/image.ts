// Image processing functions for manga optimization

/**
 * Convert image to grayscale using luminosity method
 */
export function toGrayscale(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    // Luminosity method - preserves perceived brightness
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = data[i + 1] = data[i + 2] = gray;
  }

  ctx.putImageData(imageData, 0, 0);
}

/**
 * Apply contrast boost to improve manga readability
 */
export function applyContrast(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  level: number
): void {
  const blackCutoff = 3 * level;
  const whiteCutoff = 3 + 9 * level;

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  // Build histogram
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    histogram[gray]++;
  }

  // Find cutoff points
  const totalPixels = width * height;
  const blackThreshold = totalPixels * blackCutoff / 100;
  const whiteThreshold = totalPixels * whiteCutoff / 100;

  let blackPoint = 0;
  let whitePoint = 255;
  let count = 0;

  for (let i = 0; i < 256; i++) {
    count += histogram[i];
    if (count >= blackThreshold) {
      blackPoint = i;
      break;
    }
  }

  count = 0;
  for (let i = 255; i >= 0; i--) {
    count += histogram[i];
    if (count >= whiteThreshold) {
      whitePoint = i;
      break;
    }
  }

  // Apply contrast stretch
  const range = whitePoint - blackPoint;
  if (range > 0) {
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        let val = data[i + c];
        val = Math.max(0, Math.min(255, ((val - blackPoint) / range) * 255));
        data[i + c] = val;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

/**
 * Invert image colors
 */
export function applyInvert(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i];
    data[i + 1] = 255 - data[i + 1];
    data[i + 2] = 255 - data[i + 2];
  }

  ctx.putImageData(imageData, 0, 0);
}

/**
 * Calculate overlapping segments for tall manga pages
 */
export function calculateOverlapSegments(
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number
): Array<{ x: number; y: number; w: number; h: number }> {
  // In landscape mode, we fit 'width' to 'targetHeight' (800 or 792)
  // and 'segmentHeight' to 'targetWidth' (480 or 528)
  const scale = targetHeight / width;
  const segmentHeight = Math.floor(targetWidth / scale);

  let numSegments = 3;
  let shift = 0;

  if (numSegments > 1) {
    shift = Math.floor(segmentHeight - (segmentHeight * numSegments - height) / (numSegments - 1));
  }

  // Check if we need more segments (minimum 5% overlap)
  while (shift / segmentHeight > 0.95 && numSegments < 10) {
    numSegments++;
    shift = Math.floor(segmentHeight - (segmentHeight * numSegments - height) / (numSegments - 1));
  }

  const segments = [];
  for (let i = 0; i < numSegments; i++) {
    segments.push({
      x: 0,
      y: shift * i,
      w: width,
      h: i === numSegments - 1 ? height - shift * i : segmentHeight
    });
  }

  return segments;
}

/**
 * Check if an image region is effectively a solid color (low standard deviation).
 * Used for optimizing scroll speed on blank/filler pages.
 */
export function isSolidColor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;
  
  let sum = 0;
  let count = 0;
  
  // Calculate mean (grayscale only needs one channel check usually, but let's check R)
  for (let i = 0; i < data.length; i += 4) {
    sum += data[i];
    count++;
  }
  const mean = sum / count;
  
  // Calculate variance
  let sumSqDiff = 0;
  for (let i = 0; i < data.length; i += 4) {
    const diff = data[i] - mean;
    sumSqDiff += diff * diff;
  }
  
  const variance = sumSqDiff / count;
  const stdDev = Math.sqrt(variance);
  
  // Python script uses < 5.0
  return stdDev < 5.0;
}

/**
 * Apply gamma correction to the canvas
 */
export function applyGamma(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  gamma: number
): void {
  if (gamma === 1.0) return;

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  // Pre-calculate LUT
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.round(Math.pow(i / 255, gamma) * 255);
  }

  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }

  ctx.putImageData(imageData, 0, 0);
}

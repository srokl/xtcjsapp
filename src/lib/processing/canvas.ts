// Canvas utility functions for rotation and resizing

// Target dimensions for XTEink X4 (Default)
export const TARGET_WIDTH = 480;
export const TARGET_HEIGHT = 800;

export const DEVICE_DIMENSIONS = {
  X4: { width: 480, height: 800 },
  X3: { width: 528, height: 792 }
} as const;

class CanvasPool {
  private pool: HTMLCanvasElement[] = [];

  acquire(width: number, height: number): HTMLCanvasElement {
    const canvas = this.pool.pop() || document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) ctx.clearRect(0, 0, width, height);
    return canvas;
  }

  release(canvas: HTMLCanvasElement) {
    if (this.pool.length < 5) {
      this.pool.push(canvas);
    }
  }
}

export const sharedCanvasPool = new CanvasPool();

/**
 * Rotate canvas by specified degrees
 */
export function rotateCanvas(canvas: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  let rotatedWidth = canvas.width;
  let rotatedHeight = canvas.height;
  if (degrees === -90 || degrees === 90) {
    rotatedWidth = canvas.height;
    rotatedHeight = canvas.width;
  }
  const rotated = sharedCanvasPool.acquire(rotatedWidth, rotatedHeight);

  const ctx = rotated.getContext('2d', { willReadFrequently: true })!;
  ctx.translate(rotatedWidth / 2, rotatedHeight / 2);
  ctx.rotate(degrees * Math.PI / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);

  return rotated;
}

/**
 * Extract a region from canvas and rotate it
 */
export function extractAndRotate(
  srcCanvas: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  angle: number = 90
): HTMLCanvasElement {
  const extractCanvas = sharedCanvasPool.acquire(w, h);
  const ctx = extractCanvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(srcCanvas, x, y, w, h, 0, 0, w, h);

  const rotated = rotateCanvas(extractCanvas, angle);
  sharedCanvasPool.release(extractCanvas);
  return rotated;
}

/**
 * Extract a region from canvas without rotation (for portrait mode)
 */
export function extractRegion(
  srcCanvas: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number
): HTMLCanvasElement {
  const extractCanvas = sharedCanvasPool.acquire(w, h);
  const ctx = extractCanvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(srcCanvas, x, y, w, h, 0, 0, w, h);

  return extractCanvas;
}

/**
 * Resize canvas with padding to fit target dimensions
 */
export function resizeWithPadding(
  canvas: HTMLCanvasElement, 
  padColor = 255,
  targetWidth = TARGET_WIDTH,
  targetHeight = TARGET_HEIGHT
): HTMLCanvasElement {
  const result = sharedCanvasPool.acquire(targetWidth, targetHeight);
  const ctx = result.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Fill with padding color (white by default)
  ctx.fillStyle = `rgb(${padColor}, ${padColor}, ${padColor})`;
  ctx.fillRect(0, 0, targetWidth, targetHeight);

  // Calculate scale to fit
  const scale = Math.min(targetWidth / canvas.width, targetHeight / canvas.height);
  const newWidth = Math.floor(canvas.width * scale);
  const newHeight = Math.floor(canvas.height * scale);

  // Center the image
  const x = Math.floor((targetWidth - newWidth) / 2);
  const y = Math.floor((targetHeight - newHeight) / 2);

  ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, x, y, newWidth, newHeight);

  return result;
}

/**
 * Resize canvas by stretching to fill target dimensions
 */
export function resizeFill(
  canvas: HTMLCanvasElement,
  targetWidth = TARGET_WIDTH,
  targetHeight = TARGET_HEIGHT
): HTMLCanvasElement {
  const result = sharedCanvasPool.acquire(targetWidth, targetHeight);
  const ctx = result.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, targetWidth, targetHeight);
  return result;
}

/**
 * Resize canvas by scaling to fill and cropping overflow
 */
export function resizeCover(
  canvas: HTMLCanvasElement,
  targetWidth = TARGET_WIDTH,
  targetHeight = TARGET_HEIGHT
): HTMLCanvasElement {
  const result = sharedCanvasPool.acquire(targetWidth, targetHeight);
  const ctx = result.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const scale = Math.max(targetWidth / canvas.width, targetHeight / canvas.height);
  const newWidth = Math.floor(canvas.width * scale);
  const newHeight = Math.floor(canvas.height * scale);

  const x = Math.floor((targetWidth - newWidth) / 2);
  const y = Math.floor((targetHeight - newHeight) / 2);

  ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, x, y, newWidth, newHeight);
  return result;
}

/**
 * Resize canvas by center cropping target dimensions without scaling
 */
export function resizeCrop(
  canvas: HTMLCanvasElement,
  targetWidth = TARGET_WIDTH,
  targetHeight = TARGET_HEIGHT
): HTMLCanvasElement {
  const result = sharedCanvasPool.acquire(targetWidth, targetHeight);
  const ctx = result.getContext('2d', { willReadFrequently: true })!;

  const x = Math.floor((targetWidth - canvas.width) / 2);
  const y = Math.floor((targetHeight - canvas.height) / 2);

  ctx.drawImage(canvas, x, y);
  return result;
}

// Canvas utility functions for rotation and resizing
import { createResizer } from '@squoosh-kit/resize';

let rawSquooshResizer = createResizer('worker', { assetPath: '/assets' });

let resizerCallCount = 0;
const MAX_RESIZES_BEFORE_RESTART = 25; // Lower limit for safer memory management

async function restartSquoosh(reason = "critical error") {
  console.warn(`[Canvas] Restarting Squoosh worker due to ${reason}...`);
  resizerCallCount = 0;
  try {
    await rawSquooshResizer.terminate();
  } catch (e) {}
  rawSquooshResizer = createResizer('worker', { assetPath: '/assets' });
}

// Squoosh workers (WASM) often share a single memory instance and can't handle 
// concurrent requests without "offset out of bounds" errors. We queue them.
// NOTE: Squoosh-kit v0.2.x has a memory leak where input buffers are not freed 
// in the WASM instance. We periodically restart the worker to clear memory.
let resizerQueue: Promise<any> = Promise.resolve();
async function squooshResizer(payload: { data: Uint8Array | Uint8ClampedArray, width: number, height: number }, options: any) {
  const previous = resizerQueue;
  let resolveNext: () => void;
  resizerQueue = new Promise((resolve) => { resolveNext = resolve; });
  
  await previous;
  try {
    resizerCallCount++;
    if (resizerCallCount > MAX_RESIZES_BEFORE_RESTART) {
      await restartSquoosh("periodic maintenance (leak prevention)");
    }
    
    return await rawSquooshResizer(payload, options);
  } catch (err: any) {
    // If we hit an out of bounds error, the WASM memory state is likely corrupted.
    // Restarting the worker is the only way to recover.
    if (err?.message?.includes("offset is out of bounds")) {
      await restartSquoosh("memory exhaustion");
    }
    throw err;
  } finally {
    resolveNext!();
  }
}

/**
 * Downsample an image to a safe intermediate size (2.5x target) using native canvas
 * if it's significantly larger than the target. This reduces WASM memory pressure
 * and prevents "offset is out of bounds" errors for high-res images.
 */
function getSafeResizerInput(source: HTMLCanvasElement, targetW: number, targetH: number) {
  // If the source is more than 2.5x the target, downsample to 2.5x first using native high-quality scaling
  // This drastically reduces memory usage while still providing a high-quality source for Lanczos3
  const limitW = Math.floor(targetW * 2.5);
  const limitH = Math.floor(targetH * 2.5);
  
  if (source.width > limitW || source.height > limitH) {
    const temp = document.createElement('canvas');
    temp.width = limitW;
    temp.height = limitH;
    const tctx = temp.getContext('2d', { willReadFrequently: true })!;
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, limitW, limitH);
    
    const id = tctx.getImageData(0, 0, limitW, limitH);
    return { data: new Uint8Array(id.data.buffer), width: limitW, height: limitH };
  }
  
  const sctx = source.getContext('2d', { willReadFrequently: true })!;
  const id = sctx.getImageData(0, 0, source.width, source.height);
  return { data: new Uint8Array(id.data.buffer), width: source.width, height: source.height };
}

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
export async function resizeWithPadding(
  canvas: HTMLCanvasElement, 
  padColor = 255,
  targetWidth = TARGET_WIDTH,
  targetHeight = TARGET_HEIGHT,
  useLanczos = true
): Promise<HTMLCanvasElement> {
  const result = sharedCanvasPool.acquire(targetWidth, targetHeight);
  const ctx = result.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Fill with padding color (white by default)
  ctx.fillStyle = `rgb(${padColor}, ${padColor}, ${padColor})`;
  ctx.fillRect(0, 0, targetWidth, targetHeight);

  // Calculate scale to fit
  const scale = Math.min(targetWidth / canvas.width, targetHeight / canvas.height);
  const newWidth = Math.max(1, Math.floor(canvas.width * scale));
  const newHeight = Math.max(1, Math.floor(canvas.height * scale));

  // Center the image
  const x = Math.floor((targetWidth - newWidth) / 2);
  const y = Math.floor((targetHeight - newHeight) / 2);

  if (useLanczos && canvas.width <= 8192 && canvas.height <= 8192) {
    try {
      const input = getSafeResizerInput(canvas, newWidth, newHeight);
      const resizedData = await squooshResizer(input, { width: newWidth, height: newHeight, method: 'lanczos3' });
      
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = newWidth;
      tempCanvas.height = newHeight;
      tempCanvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(resizedData.data), newWidth, newHeight), 0, 0);
      ctx.drawImage(tempCanvas, x, y);
    } catch (e) {
      console.warn(`Lanczos3 resize failed (${canvas.width}x${canvas.height} -> ${newWidth}x${newHeight}), falling back to native drawImage`, e);
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, x, y, newWidth, newHeight);
    }
  } else {
    ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, x, y, newWidth, newHeight);
  }

  return result;
}

/**
 * Resize canvas by stretching to fill target dimensions
 */
export async function resizeFill(
  canvas: HTMLCanvasElement,
  targetWidth = TARGET_WIDTH,
  targetHeight = TARGET_HEIGHT,
  useLanczos = true
): Promise<HTMLCanvasElement> {
  const result = sharedCanvasPool.acquire(targetWidth, targetHeight);
  const ctx = result.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  
  if (useLanczos && canvas.width <= 8192 && canvas.height <= 8192) {
    try {
      const input = getSafeResizerInput(canvas, targetWidth, targetHeight);
      const resizedData = await squooshResizer(input, { width: targetWidth, height: targetHeight, method: 'lanczos3' });
      
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = targetWidth;
      tempCanvas.height = targetHeight;
      tempCanvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(resizedData.data), targetWidth, targetHeight), 0, 0);
      ctx.drawImage(tempCanvas, 0, 0);
    } catch (e) {
      console.warn(`Lanczos3 fill-resize failed (${canvas.width}x${canvas.height} -> ${targetWidth}x${targetHeight}), falling back to native drawImage`, e);
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, targetWidth, targetHeight);
    }
  } else {
    ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, targetWidth, targetHeight);
  }
  
  return result;
}

/**
 * Resize canvas by scaling to fill and cropping overflow
 */
export async function resizeCover(
  canvas: HTMLCanvasElement,
  targetWidth = TARGET_WIDTH,
  targetHeight = TARGET_HEIGHT,
  useLanczos = true
): Promise<HTMLCanvasElement> {
  const result = sharedCanvasPool.acquire(targetWidth, targetHeight);
  const ctx = result.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const scale = Math.max(targetWidth / canvas.width, targetHeight / canvas.height);
  const newWidth = Math.max(1, Math.floor(canvas.width * scale));
  const newHeight = Math.max(1, Math.floor(canvas.height * scale));

  const x = Math.floor((targetWidth - newWidth) / 2);
  const y = Math.floor((targetHeight - newHeight) / 2);

  if (useLanczos && canvas.width <= 8192 && canvas.height <= 8192) {
    try {
      const input = getSafeResizerInput(canvas, newWidth, newHeight);
      const resizedData = await squooshResizer(input, { width: newWidth, height: newHeight, method: 'lanczos3' });
      
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = newWidth;
      tempCanvas.height = newHeight;
      tempCanvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(resizedData.data), newWidth, newHeight), 0, 0);
      ctx.drawImage(tempCanvas, x, y);
    } catch (e) {
      console.warn(`Lanczos3 cover-resize failed (${canvas.width}x${canvas.height} -> ${newWidth}x${newHeight}), falling back to native drawImage`, e);
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, x, y, newWidth, newHeight);
    }
  } else {
    ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, x, y, newWidth, newHeight);
  }
  
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

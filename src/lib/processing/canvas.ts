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
  } catch (e) { }
  rawSquooshResizer = createResizer('worker', { assetPath: '/assets' });
}

// Squoosh workers (WASM) often share a single memory instance and can't handle 
// concurrent requests without "offset out of bounds" errors. We queue them.
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
    if (err?.message?.includes("offset is out of bounds")) {
      await restartSquoosh("memory exhaustion");
    }
    throw err;
  } finally {
    resolveNext!();
  }
}


function downscaleStepped(source: HTMLCanvasElement, targetW: number, targetH: number): { canvas: HTMLCanvasElement, isTemp: boolean, steps: number } {
  let currentWidth = source.width;
  let currentHeight = source.height;
  let currentCanvas: HTMLCanvasElement = source;
  let steps = 0;
  const tempCanvases: HTMLCanvasElement[] = [];

  while (currentWidth > targetW * 2 || currentHeight > targetH * 2) {
    const nextWidth = Math.max(targetW, Math.floor(currentWidth / 2));
    const nextHeight = Math.max(targetH, Math.floor(currentHeight / 2));

    const nextCanvas = sharedCanvasPool.acquire(nextWidth, nextHeight);
    const nctx = nextCanvas.getContext('2d', { willReadFrequently: true })!;
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = 'high';
    nctx.drawImage(currentCanvas, 0, 0, currentWidth, currentHeight, 0, 0, nextWidth, nextHeight);

    if (tempCanvases.length > 0) {
      sharedCanvasPool.release(tempCanvases[tempCanvases.length - 1]);
    }

    tempCanvases.push(nextCanvas);
    currentCanvas = nextCanvas;
    currentWidth = nextWidth;
    currentHeight = nextHeight;
    steps++;
  }

  if (steps > 0) {
    console.log(`[Resizer] Stepped Downscale: ${source.width}x${source.height} -> ${currentWidth}x${currentHeight} (${steps} steps)`);
  }

  return {
    canvas: currentCanvas,
    isTemp: steps > 0,
    steps
  };
}


function getSafeResizerInput(source: HTMLCanvasElement, targetW: number, targetH: number) {
  const { canvas: intermediate, isTemp, steps } = downscaleStepped(source, targetW, targetH);

  const finalCtx = intermediate.getContext('2d', { willReadFrequently: true })!;
  const id = finalCtx.getImageData(0, 0, intermediate.width, intermediate.height);
  const result = { data: new Uint8Array(id.data.buffer), width: intermediate.width, height: intermediate.height };

  if (isTemp) {
    sharedCanvasPool.release(intermediate);
  }

  return result;
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
    if (this.pool.length < 10) {
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

  ctx.fillStyle = `rgb(${padColor}, ${padColor}, ${padColor})`;
  ctx.fillRect(0, 0, targetWidth, targetHeight);

  const scale = Math.min(targetWidth / canvas.width, targetHeight / canvas.height);
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
      console.warn(`Lanczos3 resize failed, falling back to native stepped downscale`, e);
      const { canvas: stepped, isTemp } = downscaleStepped(canvas, newWidth, newHeight);
      ctx.drawImage(stepped, 0, 0, stepped.width, stepped.height, x, y, newWidth, newHeight);
      if (isTemp) sharedCanvasPool.release(stepped);
    }
  } else {
    const { canvas: stepped, isTemp } = downscaleStepped(canvas, newWidth, newHeight);
    ctx.drawImage(stepped, 0, 0, stepped.width, stepped.height, x, y, newWidth, newHeight);
    if (isTemp) sharedCanvasPool.release(stepped);
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
      console.warn(`Lanczos3 fill failed, falling back to native stepped downscale`, e);
      const { canvas: stepped, isTemp } = downscaleStepped(canvas, targetWidth, targetHeight);
      ctx.drawImage(stepped, 0, 0, stepped.width, stepped.height, 0, 0, targetWidth, targetHeight);
      if (isTemp) sharedCanvasPool.release(stepped);
    }
  } else {
    const { canvas: stepped, isTemp } = downscaleStepped(canvas, targetWidth, targetHeight);
    ctx.drawImage(stepped, 0, 0, stepped.width, stepped.height, 0, 0, targetWidth, targetHeight);
    if (isTemp) sharedCanvasPool.release(stepped);
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
      console.warn(`Lanczos3 cover failed, falling back to native stepped downscale`, e);
      const { canvas: stepped, isTemp } = downscaleStepped(canvas, newWidth, newHeight);
      ctx.drawImage(stepped, 0, 0, stepped.width, stepped.height, x, y, newWidth, newHeight);
      if (isTemp) sharedCanvasPool.release(stepped);
    }
  } else {
    const { canvas: stepped, isTemp } = downscaleStepped(canvas, newWidth, newHeight);
    ctx.drawImage(stepped, 0, 0, stepped.width, stepped.height, x, y, newWidth, newHeight);
    if (isTemp) sharedCanvasPool.release(stepped);
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

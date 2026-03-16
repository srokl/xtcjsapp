export interface FontGenerationOptions {
  fontFamily: string;
  fontSize: number; // in Pt
  fontWeight: string;
  fontStyle: string;
  vertical: boolean;
  verticalSymbols: boolean;
  verticalEnglishUpright: boolean;
  charSpacing: number;
  lineSpacing: number;
  threshold: number;
  yOffset: number;
  xOffset: number;
  smoothing: boolean;
  hinting: boolean;
}

const VERTICAL_SYMBOLS = new Set([
  '(', ')', '[', ']', '{', '}', '<', '>',
  '（', '）', '【', '】', '《', '》', '〈', '〉', '「', '」', '『', '』', '［', '］', '｛', '｝',
  '-', '—', '–', '…', '⋯', '‥', '_', '~', '～', 'ー', '｜'
]);

// Characters that need to be shifted to the top-right in vertical layout
const VERTICAL_PUNCTUATION_SHIFT = new Set(['、', '。', '，', '．', ',', '.']);

function getVerticalPunctuationOffset(char: string, fontSizePx: number): { x: number, y: number } {
  if (VERTICAL_PUNCTUATION_SHIFT.has(char)) {
    // Both preview (unrotated) and generator (post-rotation) spaces align such that:
    // +X is Visual Right
    // -Y is Visual Up
    // A standard comma sits at the bottom-left. We want it at the top-right.
    // So we shift it Right (+0.5) and Up (-0.5).
    return { x: fontSizePx * 0.5, y: -fontSizePx * 0.5 };
  }
  return { x: 0, y: 0 };
}

function isVerticalSymbol(char: string): boolean {
  return VERTICAL_SYMBOLS.has(char);
}

function isEnglishOrNumber(char: string): boolean {
  // ASCII characters (letters, numbers, and basic punctuation not in vertical symbols)
  return /^[\x20-\x7E]+$/.test(char) && !isVerticalSymbol(char);
}

const DEVICE_PPI = 220;
const PT_TO_PX = DEVICE_PPI / 72;

export function measureCharSize(options: FontGenerationOptions): { width: number, height: number } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  
  const fontSizePx = options.fontSize * PT_TO_PX;

  // Use 'px' to match generation, avoiding CSS vs Device pixel ratio scaling issues
  const fontString = `${options.fontStyle} ${options.fontWeight} ${fontSizePx}px "${options.fontFamily}", sans-serif`;
  ctx.font = fontString;
  
  const metrics = ctx.measureText("坐");
  
  let w = Math.round(metrics.width);
  let h = Math.round(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
  
  if (isNaN(h) || h === 0) {
    h = Math.round(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);
  }
  if (h === 0) h = fontSizePx;
  if (w === 0) w = fontSizePx;

  // Add spacing
  let finalW = w + options.charSpacing;
  let finalH = h + options.lineSpacing;
  
  if (finalW < 5) finalW = 5;
  if (finalH < 5) finalH = 5;

  return { width: finalW, height: finalH };
}

export class XTEinkFontBinary {
  width: number;
  height: number;
  widthByte: number;
  charByte: number;
  fontbin: Uint8Array;
  totalChar = 0x10000;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.widthByte = Math.ceil(width / 8);
    this.charByte = this.widthByte * height;
    this.fontbin = new Uint8Array(this.charByte * this.totalChar);
  }

  getSuggestedFileName(title: string, pt: number) {
    return `${title}.${pt}pt.${this.width}x${this.height}.bin`;
  }

  setPixel(charCode: number, x: number, y: number, value: boolean) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    
    let fb = charCode * this.charByte;
    fb += y * this.widthByte;
    fb += Math.floor(x / 8);
    
    const bitPos = x % 8;
    const mask = 0x80 >>> bitPos;
    
    if (value) {
      this.fontbin[fb] |= mask;
    } else {
      this.fontbin[fb] &= ~mask;
    }
  }
}

export async function generateFontBinary(
  options: FontGenerationOptions,
  onProgress: (progress: number) => void
): Promise<{ buffer: ArrayBuffer, name: string }> {
  const box = measureCharSize(options);
  const binary = new XTEinkFontBinary(box.width, box.height);
  
  const canvas = document.createElement('canvas');
  canvas.width = box.width;
  canvas.height = box.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  
  // Apply smoothing option
  ctx.imageSmoothingEnabled = options.smoothing;

  const fontSizePx = options.fontSize * PT_TO_PX;
  const fontString = `${options.fontStyle} ${options.fontWeight} ${fontSizePx}px "${options.fontFamily}", sans-serif`;
  
  // We process chunks to avoid freezing the UI completely
  const CHUNK_SIZE = 1024;
  
  for (let i = 0; i < binary.totalChar; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, binary.totalChar);
    
    for (let charCode = i; charCode < end; charCode++) {
      // Clear canvas (black background)
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, box.width, box.height);
      
      const charStr = String.fromCharCode(charCode);
      
      ctx.font = fontString;
      ctx.fillStyle = 'white';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      
      ctx.save();
      
      ctx.translate(box.width / 2 + options.xOffset, box.height / 2 + options.yOffset);
      
      if (options.vertical) {
        if (options.verticalSymbols && isVerticalSymbol(charStr)) {
          ctx.rotate(0);
        } else if (!options.verticalEnglishUpright && isEnglishOrNumber(charStr)) {
          ctx.rotate(0);
        } else {
          ctx.rotate(-Math.PI / 2); // Rotate -90 degrees for vertical layout (Upright on e-reader)
          
          // Apply punctuation shift AFTER rotation so we are working in the visual space
          const offset = getVerticalPunctuationOffset(charStr, fontSizePx);
          if (offset.x !== 0 || offset.y !== 0) {
            ctx.translate(offset.x, offset.y);
          }
        }
      }
      
      ctx.fillText(charStr, 0, 0);
      ctx.restore();
      
      const imageData = ctx.getImageData(0, 0, box.width, box.height);
      const data = imageData.data;
      
      for (let y = 0; y < box.height; y++) {
        for (let x = 0; x < box.width; x++) {
          const idx = (y * box.width + x) * 4;
          // Use red channel as luminosity approximation since it's white on black
          const r = data[idx];
          
          if (r >= options.threshold) {
            binary.setPixel(charCode, x, y, true);
          }
        }
      }
    }
    
    // Yield to event loop and report progress
    await new Promise(resolve => setTimeout(resolve, 0));
    onProgress(end / binary.totalChar);
  }
  
  const name = binary.getSuggestedFileName(options.fontFamily, options.fontSize);
  return { buffer: binary.fontbin.buffer, name };
}

export function previewFontCharacter(canvas: HTMLCanvasElement, text: string, options: FontGenerationOptions, showBoundary: boolean = false) {
  // Always set fixed screen preview dimensions to 480x800 for the XTEink X4
  const SCREEN_W = 480;
  const SCREEN_H = 800;

  // We must set BOTH the internal canvas resolution and the CSS styling resolution.
  // The caller handles CSS styling, we only handle internal buffer resolution here.
  canvas.width = SCREEN_W;
  canvas.height = SCREEN_H;

  const box = measureCharSize(options);
  const charBoxW = box.width;
  const charBoxH = box.height;

  const ctx = canvas.getContext('2d')!;
  
  // Clear canvas (white background for full screen simulation)
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  ctx.imageSmoothingEnabled = options.smoothing;
  
  // Font string uses 'px' not 'pt' to ensure 1:1 mapping on the canvas buffer without OS scaling interference
  const fontSizePx = options.fontSize * PT_TO_PX;
  const fontString = `${options.fontStyle} ${options.fontWeight} ${fontSizePx}px "${options.fontFamily}", sans-serif`;
  ctx.font = fontString;
  ctx.fillStyle = 'black'; // Draw text in black on white for e-ink preview
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  // Start rendering near the top left, with a small margin
  // For vertical text, it usually starts Top-Right
  const startX = options.vertical ? SCREEN_W - charBoxW - 20 : 20;
  const startY = 20;

  const lines = text.split('\n');
  let currentX = startX;
  let currentY = startY;

  const drawnBoxes: {x: number, y: number, w: number, h: number}[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    
    // Reset starting position for new line based on orientation
    if (options.vertical) {
      currentY = startY;
      if (lineIdx > 0) currentX -= charBoxW;
    } else {
      currentX = startX;
      if (lineIdx > 0) currentY += charBoxH;
    }

    if (!options.vertical && currentY + charBoxH > SCREEN_H) break;
    if (options.vertical && currentX < 0) break;

    for (let i = 0; i < line.length; i++) {
      const charStr = line[i];

      // Auto word wrap
      if (options.vertical) {
        if (currentY + charBoxH > SCREEN_H) {
          currentY = startY;
          currentX -= charBoxW;
          if (currentX < 0) break;
        }
      } else {
        if (currentX + charBoxW > SCREEN_W) {
          currentX = startX;
          currentY += charBoxH;
          if (currentY + charBoxH > SCREEN_H) break;
        }
      }

      ctx.save();

      // We must translate to the CENTER of the character box to use textBaseline='middle' and textAlign='center'
      ctx.translate(currentX + charBoxW / 2 + options.xOffset, currentY + charBoxH / 2 + options.yOffset);

      // The original toolkit rotates the *binary* output by -90 degrees, but the visual preview
      // displays the text upright (Standard CJK vertical reading style).
      // Therefore, we DO NOT rotate the context here in the preview, UNLESS it's a vertical symbol.
      if (options.vertical) {
        if (options.verticalSymbols && isVerticalSymbol(charStr)) {
          // If the binary output has rotation 0 instead of -90 for symbols,
          // then the visual preview should be rotated +90 relative to the upright text.
          ctx.rotate(Math.PI / 2);
        } else if (!options.verticalEnglishUpright && isEnglishOrNumber(charStr)) {
          // If English is not set to remain upright, it reads sideways.
          ctx.rotate(Math.PI / 2);
        } else {
          // For upright characters, we still need to shift punctuation correctly.
          const offset = getVerticalPunctuationOffset(charStr, fontSizePx);
          if (offset.x !== 0 || offset.y !== 0) {
            ctx.translate(offset.x, offset.y);
          }
        }
      }
      
      ctx.fillText(charStr, 0, 0);
      ctx.restore();

      drawnBoxes.push({ x: currentX, y: currentY, w: charBoxW, h: charBoxH });

      // Advance cursor
      if (options.vertical) {
        currentY += charBoxH;
      } else {
        currentX += charBoxW;
      }
    }
  }

  // Apply thresholding effect for accurate 1-bit preview
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]; // black text on white background -> r is luminosity
    const val = (255 - r) >= options.threshold ? 0 : 255;
    data[i] = val;
    data[i+1] = val;
    data[i+2] = val;
    data[i+3] = 255;
  }
  
  ctx.putImageData(imageData, 0, 0);

  // Draw boundary boxes exactly where characters were rendered
  if (showBoundary) {
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 1;
    for (const box of drawnBoxes) {
      // Draw inner border to not leak into adjacent characters
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
    }
  }
}

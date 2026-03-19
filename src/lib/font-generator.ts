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
  '（', '）', '【', '】', '《', '》', '〈', '〉', '「', '」', '『', '』', '［', '］', '｛', '｝', '〔', '〕', '〖', '〗', '〘', '〙', '〚', '〛',
  '-', '—', '–', '…', '⋯', '‥', '_', '~', '～', '〜', 'ー', '｜'
]);

// Characters that need to be shifted to the top-right in vertical layout
const VERTICAL_PUNCTUATION_SHIFT = new Set(['、', '。', '，', '．', ',', '.']);

const VERTICAL_SUTEGANA = new Set([
  'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'っ', 'ゃ', 'ゅ', 'ょ', 'ゎ', 'ゕ', 'ゖ',
  'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ッ', 'ャ', 'ュ', 'ョ', 'ヮ', 'ヵ', 'ヶ'
]);

function getVerticalCharOffset(char: string, fontSizePx: number, isPreview: boolean): { x: number, y: number } {
  if (VERTICAL_PUNCTUATION_SHIFT.has(char)) {
    // The user empirically confirmed that { x: 0, y: -0.55 } places punctuation perfectly in the Top-Right 
    // on the actual device. We will use this exact value for the generator, and a mapped value for the preview.
    if (isPreview) {
      // In unrotated preview, to match the device's top-right, we shift Right and Up.
      return { x: fontSizePx * 0.55, y: -fontSizePx * 0.55 };
    } else {
      // In the rotated generator space, this isolated value works perfectly.
      return { x: 0, y: -fontSizePx * 0.55 };
    }
  }
  
  if (VERTICAL_SUTEGANA.has(char)) {
    // Sutegana (small kana) require an independent, smaller shift to reach the top-right quadrant
    // without getting completely pushed out of bounds.
    if (isPreview) {
      return { x: fontSizePx * 0.25, y: -fontSizePx * 0.25 };
    } else {
      return { x: fontSizePx * 0.25, y: -fontSizePx * 0.25 }; // Let's apply a symmetrical shift for sutegana in both spaces for now
    }
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

/**
 * Checks if a character's glyph will be cutoff by the bounding box.
 */
function isCharCutoff(ctx: CanvasRenderingContext2D, char: string, box: { width: number, height: number }, options: FontGenerationOptions): boolean {
  const metrics = ctx.measureText(char);
  const halfW = box.width / 2;
  const halfH = box.height / 2;

  // Visual boundaries relative to the center anchor
  let left = -metrics.actualBoundingBoxLeft;
  let right = metrics.actualBoundingBoxRight;
  let top = -metrics.actualBoundingBoxAscent;
  let bottom = metrics.actualBoundingBoxDescent;

  const fontSizePx = options.fontSize * (220 / 72);
  let vOffset = { x: 0, y: 0 };

  if (options.vertical && !isVerticalSymbol(char) && !(!options.verticalEnglishUpright && isEnglishOrNumber(char))) {
    // For rotated characters (-90 deg), the axes swap
    const vLeft = -metrics.actualBoundingBoxAscent;
    const vRight = metrics.actualBoundingBoxDescent;
    const vTop = -metrics.actualBoundingBoxRight;
    const vBottom = metrics.actualBoundingBoxLeft;
    
    left = vLeft;
    right = vRight;
    top = vTop;
    bottom = vBottom;

    vOffset = getVerticalCharOffset(char, fontSizePx, false);
  }

  // Check if any edge + options offset + punctuation offset exceeds half-box dimensions
  return (
    left + options.xOffset + vOffset.x < -halfW ||
    right + options.xOffset + vOffset.x > halfW ||
    top + options.yOffset + vOffset.y < -halfH ||
    bottom + options.yOffset + vOffset.y > halfH
  );
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
  
  if (options.vertical) {
    // When vertical is enabled, the characters are rotated -90 degrees.
    // This means the visual height becomes the binary box width, and visual width becomes binary box height.
    // To prevent cutoff (especially for English descenders), we swap the dimensions.
    const temp = finalW;
    finalW = finalH;
    finalH = temp;
  }
  
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
): Promise<{ buffer: ArrayBuffer, name: string, cutoffCount: number, cutoffChars: string[] }> {
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
  
  const cutoffChars: string[] = [];

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
      
      if (isCharCutoff(ctx, charStr, box, options)) {
        cutoffChars.push(charStr);
      }

      ctx.save();
      
      ctx.translate(box.width / 2 + options.xOffset, box.height / 2 + options.yOffset);
      
      if (options.vertical) {
        if (options.verticalSymbols && isVerticalSymbol(charStr)) {
          ctx.rotate(0);
        } else if (!options.verticalEnglishUpright && isEnglishOrNumber(charStr)) {
          ctx.rotate(0);
        } else {
          ctx.rotate(-Math.PI / 2); // Rotate -90 degrees for vertical layout (Upright on e-reader)
          
          // Apply punctuation/sutegana shift AFTER rotation so we are working in the visual space
          const offset = getVerticalCharOffset(charStr, fontSizePx, false);
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
  return { buffer: binary.fontbin.buffer, name, cutoffCount: cutoffChars.length, cutoffChars };
}

export function previewFontCharacter(canvas: HTMLCanvasElement, text: string, options: FontGenerationOptions, showBoundary: boolean = false): { count: number, chars: string[] } {
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
  const startX = options.vertical ? SCREEN_W - charBoxH - 20 : 20;
  const startY = 20;

  const lines = text.split('\n');
  let currentX = startX;
  let currentY = startY;

  const drawnBoxes: {x: number, y: number, w: number, h: number, isCutoff: boolean}[] = [];
  const cutoffChars = new Set<string>();

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    
    // Reset starting position for new line based on orientation
    if (options.vertical) {
      currentY = startY;
      if (lineIdx > 0) currentX -= charBoxH;
    } else {
      currentX = startX;
      if (lineIdx > 0) currentY += charBoxH;
    }

    if (!options.vertical && currentY + charBoxH > SCREEN_H) break;
    if (options.vertical && currentX - charBoxH < 0) break;

    for (let i = 0; i < line.length; i++) {
      const charStr = line[i];

      // Auto word wrap
      if (options.vertical) {
        if (currentY + charBoxW > SCREEN_H) {
          currentY = startY;
          currentX -= charBoxH;
          if (currentX - charBoxH < 0) break;
        }
      } else {
        if (currentX + charBoxW > SCREEN_W) {
          currentX = startX;
          currentY += charBoxH;
          if (currentY + charBoxH > SCREEN_H) break;
        }
      }

      const isCutoff = isCharCutoff(ctx, charStr, box, options);
      if (isCutoff) cutoffChars.add(charStr);

      ctx.save();

      // We must translate to the CENTER of the character box to use textBaseline='middle' and textAlign='center'
      ctx.translate(currentX + (options.vertical ? charBoxH : charBoxW) / 2 + options.xOffset, currentY + (options.vertical ? charBoxW : charBoxH) / 2 + options.yOffset);

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
          const offset = getVerticalCharOffset(charStr, fontSizePx, true);
          if (offset.x !== 0 || offset.y !== 0) {
            ctx.translate(offset.x, offset.y);
          }
        }
      }
      
      ctx.fillText(charStr, 0, 0);
      ctx.restore();

      if (options.vertical) {
        drawnBoxes.push({ x: currentX, y: currentY, w: charBoxH, h: charBoxW, isCutoff });
      } else {
        drawnBoxes.push({ x: currentX, y: currentY, w: charBoxW, h: charBoxH, isCutoff });
      }

      // Advance cursor
      if (options.vertical) {
        currentY += charBoxW;
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

  // Draw boundary boxes and warnings
  drawnBoxes.forEach(b => {
    if (b.isCutoff) {
      ctx.fillStyle = 'rgba(255, 0, 0, 0.15)';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    } else if (showBoundary) {
      ctx.strokeStyle = 'rgba(0, 0, 255, 0.15)';
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    }
  });

  return { count: cutoffChars.size, chars: Array.from(cutoffChars) };
}

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
  '（', '）', '【', '】', '《', '》', '〈', '〉', '「', '」', '『', '』',
  '-', '—', '–', '…', '⋯', '_', '~', '～', 'ー'
]);

function isVerticalSymbol(char: string): boolean {
  return VERTICAL_SYMBOLS.has(char);
}

function isEnglishOrNumber(char: string): boolean {
  // ASCII characters (letters, numbers, and basic punctuation not in vertical symbols)
  return /^[\x20-\x7E]+$/.test(char) && !isVerticalSymbol(char);
}

export function measureCharSize(options: FontGenerationOptions): { width: number, height: number } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  
  // Use 'px' to match generation, avoiding CSS vs Device pixel ratio scaling issues
  const fontString = `${options.fontStyle} ${options.fontWeight} ${options.fontSize}px "${options.fontFamily}", sans-serif`;
  ctx.font = fontString;
  
  const metrics = ctx.measureText("坐");
  
  let w = Math.round(metrics.width);
  let h = Math.round(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
  
  if (isNaN(h) || h === 0) {
    h = Math.round(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);
  }
  if (h === 0) h = options.fontSize;
  if (w === 0) w = options.fontSize;

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

  getSuggestedFileName(title: string) {
    return `${title} ${this.width}×${this.height}.bin`;
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

  const fontString = `${options.fontStyle} ${options.fontWeight} ${options.fontSize}px "${options.fontFamily}", sans-serif`;
  
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
          // If vertical symbols option is checked, rotate specific punctuation
          // CJK vertical punctuation is rotated 90 degrees clockwise relative to upright characters
          // Wait, the original toolkit rotates the whole context by -90 for vertical fonts, 
          // meaning the e-reader expects the binary image to be rotated -90 degrees.
          // Let's think about this:
          // In standard vertical mode without the flag, the glyph is rotated -90.
          // If it's a vertical symbol, it needs to be rotated an ADDITIONAL 90 degrees?
          // Let's assume standard rotation is -Math.PI / 2.
          // To make a dash '-' vertical, it should be rotated by +90 relative to the standard upright text.
          // Since the whole binary is rotated -90, to make it vertical on screen we don't rotate it,
          // so the net rotation is 0 instead of -90? Or we rotate it 90 degrees more?
          // Actually, if the entire string is drawn rotated -90, a horizontal '-' becomes vertical on the reader.
          // If a character shouldn't be rotated (it should stay upright on the reader), it needs -90.
          // CJK characters are upright on the reader, so they are drawn rotated -90 in the file.
          // If a symbol like '-' should ALSO be upright? No, '-' should be vertical '|'.
          // If it's drawn rotated -90, it will be '|' on the reader!
          // So if we *don't* want it to be upright, but rather "sideways", we should rotate it differently.
          // Wait! Let's check what the user wants. The user says "some japanese '-', '...', and '()' and other japanese parenthesis kanjis is still landscape viewing I want it to view vertically add render option for vertical symbols".
          // If they are "landscape viewing", it means they are currently drawn rotated -90 (making them upright on the e-reader, thus looking "landscape" because the text flows vertically).
          // We need to rotate them by an extra +90 (or -90) so they flow inline with the vertical text.
          // The CJK glyphs are rotated -90. We should rotate symbols by 0 (or -180).
          // Let's just use 0 (don't rotate).
          ctx.rotate(0);
        } else if (!options.verticalEnglishUpright && isEnglishOrNumber(charStr)) {
          // English and numbers are typically rotated 90 degrees clockwise in vertical text (so they read sideways).
          // If verticalEnglishUpright is false, they should NOT be drawn upright.
          // Rotation 0 means they will appear sideways on the e-reader.
          ctx.rotate(0);
        } else {
          ctx.rotate(-Math.PI / 2); // Rotate -90 degrees for vertical layout (Upright on e-reader)
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
  
  const name = binary.getSuggestedFileName(options.fontFamily);
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
  const fontString = `${options.fontStyle} ${options.fontWeight} ${options.fontSize}px "${options.fontFamily}", sans-serif`;
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

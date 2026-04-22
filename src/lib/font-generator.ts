import InitFreetype, { FreetypeModule, FT_FaceRec, FT_GlyphSlotRec } from 'freetype-wasm/dist/freetype.js';
import opentype from 'opentype.js';

/**
 * Subsets a font buffer to only include the specified characters.
 * This is used to reduce the memory footprint for large CJK fonts before passing them to FreeType.
 */
export function subsetFontBuffer(buffer: ArrayBuffer, characters: string, nameSuffix: string = ''): ArrayBuffer {
  try {
    const font = opentype.parse(buffer);
    const glyphs: opentype.Glyph[] = [];
    
    // Always include the .notdef glyph (index 0)
    glyphs.push(font.glyphs.get(0));
    
    // Create a unique set of characters to subset
    const uniqueChars = Array.from(new Set(characters));
    
    for (const char of uniqueChars) {
      const glyph = font.charToGlyph(char);
      // Only add if it's not the .notdef glyph (to avoid duplicates)
      if (glyph && glyph.index !== 0) {
        glyphs.push(glyph);
      }
    }
    
    const baseName = font.names.fontFamily?.en || 'SubsetFont';
    const subsetFont = new opentype.Font({
      familyName: nameSuffix ? `${baseName}_${nameSuffix}` : baseName,
      styleName: font.names.fontSubfamily?.en || 'Regular',
      unitsPerEm: font.unitsPerEm,
      ascender: font.ascender,
      descender: font.descender,
      glyphs: glyphs
    });
    
    return subsetFont.toArrayBuffer();
  } catch (err) {
    console.error('Failed to subset font:', err);
    return buffer; // Fallback to original buffer if subsetting fails
  }
}

let ftModule: FreetypeModule | null = null;

/**
 * Display Specifications for 4.26 inch e-ink (800x480)
 * Pixel Pitch: 0.116mm x 0.116mm
 * DPI = 25.4 / 0.116 = 218.9655
 */
export const DISPLAY_DPI = 218.9655;
export const PX_PER_PT = DISPLAY_DPI / 72;

export async function initFreeTypeInstance() {
  if (!ftModule) {
    ftModule = await InitFreetype({
      locateFile: (path: string) => `/freetype.wasm`,
      // 512MB to handle exceptionally large Japanese fonts and complex glyph parsing
      INITIAL_MEMORY: 512 * 1024 * 1024,
      printStatus: true
    } as any);
  }
  return ftModule;
}

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
  threshold: number; // Now maps to 100-900 scale
  yOffset: number;
  xOffset: number;
  autoFit: boolean;
  oversample: number; // 1 = native, 2 = 2x supersample, 4 = 4x supersample
  freetypeFace?: FT_FaceRec;
  renderer?: 'freetype' | 'canvas-fallback';
  hinting?: 'None' | 'Slight' | 'Medium' | 'Full';
  forceAutohint?: boolean;
  characters: string;
  customFontBuffer?: ArrayBuffer;
}

const VERTICAL_SYMBOLS = new Set([
  '(', ')', '[', ']', '{', '}', '<', '>',
  '（', '）', '【', '】', '《', '》', '〈', '〉', '「', '」', '『', '』', '［', '］', '｛', '｝', '〔', '〕', '〖', '〗', '〘', '〙', '〚', '〛',
  '-', '—', '–', '…', '⋯', '‥', '_', '~', '～', '〜', 'ー', '｜',
  '：', '；', '=', '＝', '‰'
]);

// Characters that need to be shifted to the top-right in vertical layout
// We only include Japanese/CJK full-width punctuation here. Standard English punctuation stays on the baseline.
const VERTICAL_PUNCTUATION_SHIFT = new Set(['、', '。', '，', '．']);

const VERTICAL_SUTEGANA = new Set([
  'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'っ', 'ゃ', 'ゅ', 'ょ', 'ゎ', 'ゕ', 'ゖ',
  'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ッ', 'ャ', 'ュ', 'ョ', 'ヮ', 'ヵ', 'ヶ'
]);

function getVerticalCharOffset(char: string, fontSizePx: number): { x: number, y: number } {
  if (VERTICAL_PUNCTUATION_SHIFT.has(char)) {
    // Both preview (unrotated) and generator (post-rotation) visually share the same translation vector
    // because the e-reader's physical +90 rotation perfectly cancels out the generator's -90 rotation.
    // To move from bottom-left to top-right, we shift Right (+X) and Up (-Y).
    return { x: fontSizePx * 0.55, y: -fontSizePx * 0.55 };
  }
  
  if (VERTICAL_SUTEGANA.has(char)) {
    // Sutegana (small kana) require an independent, smaller shift.
    // Shift slightly Right (+X) and Up (-Y)
    return { x: fontSizePx * 0.15, y: -fontSizePx * 0.15 };
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

function getCharMetrics(ctx: CanvasRenderingContext2D, char: string, box: { width: number, height: number }, options: FontGenerationOptions, preloadedGlyph?: FT_GlyphSlotRec | null) {
  let left = 0, right = 0, top = 0, bottom = 0;
  const fontSizePx = Math.round(options.fontSize * PX_PER_PT);

  if (options.renderer === 'freetype' && options.freetypeFace && ftModule) {
    ftModule.SetFont(options.freetypeFace.family_name, options.freetypeFace.style_name);
    const m = ftModule.SetPixelSize(0, fontSizePx);
    
    let glyph = preloadedGlyph;
    if (glyph === undefined) {
      let loadFlags = ftModule.FT_LOAD_DEFAULT;
      if (options.hinting === 'None') loadFlags |= ftModule.FT_LOAD_NO_HINTING;
      else if (options.hinting === 'Slight') loadFlags |= ftModule.FT_LOAD_TARGET_LIGHT;
      else if (options.hinting === 'Medium') loadFlags |= ftModule.FT_LOAD_TARGET_NORMAL;
      else loadFlags |= ftModule.FT_LOAD_TARGET_MONO; // Full / Default for 1-bit

      if (options.forceAutohint) loadFlags |= ftModule.FT_LOAD_FORCE_AUTOHINT;

      const glyphs = ftModule.LoadGlyphs([char.charCodeAt(0)], loadFlags);
      glyph = glyphs.get(char.charCodeAt(0));
    }
    
    const adv = glyph ? (glyph.advance.x >> 6) : 0;
    const dyOffset = (m.ascender + m.descender) >> 7; // ( (A+D)/64 ) / 2

    if (!glyph || glyph.glyph_index === 0) {
      left = 0; right = 0; top = 0; bottom = 0;
    } else {
      // Use bitmap boundaries relative to the centered pen
      left = (glyph.bitmap_left - adv / 2);
      right = left + glyph.bitmap.width;
      top = -(glyph.bitmap_top - dyOffset);
      bottom = top + glyph.bitmap.rows;
    }
  } else {
    const metrics = ctx.measureText(char);
    left = -metrics.actualBoundingBoxLeft;
    right = metrics.actualBoundingBoxRight;
    top = -metrics.actualBoundingBoxAscent;
    bottom = metrics.actualBoundingBoxDescent;
  }

  // 2. Apply any punctuation/sutegana shifts in the visual space
  // Round to integer pixel boundaries to force Native OS font rasterizer onto integer grid, 
  // preventing destructive fractional subpixel dropouts.
  let vOffset = { x: 0, y: 0 };
  
  // Determine if this character will be rotated -90 in the generator
  let isRotatedMinus90 = false;
  if (options.vertical) {
    if (options.verticalSymbols && isVerticalSymbol(char)) {
      isRotatedMinus90 = false; // Category 1: rotate(0)
    } else if (!options.verticalEnglishUpright && isEnglishOrNumber(char)) {
      isRotatedMinus90 = false; // Category 3: rotate(0)
    } else {
      isRotatedMinus90 = true;  // Category 2 & 4: rotate(-90)
    }
  }

  if (isRotatedMinus90) {
     vOffset = getVerticalCharOffset(char, fontSizePx);
  }
  
  left += vOffset.x;
  right += vOffset.x;
  top += vOffset.y;
  bottom += vOffset.y;

  let finalLeft, finalRight, finalTop, finalBottom;

  if (isRotatedMinus90) {
    finalLeft = top;          
    finalRight = bottom;      
    finalTop = -right;        
    finalBottom = -left;      
  } else {
    finalLeft = left;
    finalRight = right;
    finalTop = top;
    finalBottom = bottom;
  }

  finalLeft += options.xOffset;
  finalRight += options.xOffset;
  finalTop += options.yOffset;
  finalBottom += options.yOffset;

  return { left: finalLeft, right: finalRight, top: finalTop, bottom: finalBottom, isRotatedMinus90, vOffset };
}

/**
 * Checks if a character's glyph will be cutoff by the bounding box.
 */
function isCharCutoff(ctx: CanvasRenderingContext2D, char: string, box: { width: number, height: number }, options: FontGenerationOptions, preloadedGlyph?: FT_GlyphSlotRec | null): boolean {
  const m = getCharMetrics(ctx, char, box, options, preloadedGlyph);
  
  if (options.autoFit) {
    const charW = m.right - m.left;
    const charH = m.bottom - m.top;
    return charW > box.width || charH > box.height;
  }
  
  const halfW = box.width / 2;
  const halfH = box.height / 2;

  return (
    m.left < -halfW ||
    m.right > halfW ||
    m.top < -halfH ||
    m.bottom > halfH
  );
}


export function measureCharSize(options: FontGenerationOptions): { width: number, height: number } {
  const fontSizePx = Math.round(options.fontSize * PX_PER_PT);
  let w = 0, h = 0;

  if (options.renderer === 'freetype' && options.freetypeFace && ftModule) {
    const face = options.freetypeFace;
    ftModule.SetFont(face.family_name, face.style_name);
    const m = ftModule.SetPixelSize(0, fontSizePx);
    
    // For "坐" or any character, we can load it to get its advance
    const charCode = "坐".charCodeAt(0);
    const glyphs = ftModule.LoadGlyphs([charCode], ftModule.FT_LOAD_DEFAULT);
    const glyph = glyphs.get(charCode);
    
    if (glyph) {
      w = Math.round(glyph.advance.x >> 6);
    }
    
    // Scale vertical metrics from 26.6 to pixels
    if (m) {
      h = Math.round((m.ascender - m.descender) >> 6);
    } else {
      // Fallback if font is not set correctly
      h = fontSizePx;
    }
  } else {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    
    // Use 'px' to match generation, avoiding CSS vs Device pixel ratio scaling issues
    const fontString = `${options.fontStyle} ${options.fontWeight} ${fontSizePx}px "${options.fontFamily}", sans-serif`;
    ctx.font = fontString;
    
    const metrics = ctx.measureText("坐");
    
    w = Math.round(metrics.width);
    h = Math.round(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
    
    if (isNaN(h) || h === 0) {
      h = Math.round(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);
    }
  }

  if (h === 0) h = fontSizePx;
  if (w === 0) w = fontSizePx;

  // Add spacing
  let finalW = w + options.charSpacing;
  let finalH = h + options.lineSpacing;
  
  if (options.vertical) {
    // In vertical mode, some characters are drawn sideways (rotated -90), and some are drawn upright (rotate 0).
    // Because the .bin format requires a single globally fixed width/height for ALL characters,
    // a rectangular box will inevitably cut off one group or the other.
    // The only mathematically safe solution is to force a square box based on the largest dimension.
    const maxDim = Math.max(finalW, finalH);
    finalW = maxDim;
    finalH = maxDim;
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
  onProgress: (current: number, total: number) => void
): Promise<{ buffer: ArrayBuffer, name: string, cutoffCount: number, cutoffChars: string[] }> {
  const box = measureCharSize(options);
  const binary = new XTEinkFontBinary(box.width, box.height);
  
  const S = options.oversample || 1; // Supersample factor
  const sW = box.width * S;
  const sH = box.height * S;
  
  // Use the supersampled font size for rendering
  const fontSizePx = Math.round(options.fontSize * PX_PER_PT * S);
  const fontString = `${options.fontStyle} ${options.fontWeight} ${fontSizePx}px "${options.fontFamily}", sans-serif`;
  
  const alphaThreshold = 255 - (options.threshold / 1000 * 255);
  
  const cutoffChars: string[] = [];

  // Fix 4: preallocate tempCanvas
  const tempCanvas = document.createElement('canvas');
  const tempSize = Math.max(100, fontSizePx * 3);
  tempCanvas.width = tempSize;
  tempCanvas.height = tempSize;
  const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true })!;
  
  let ftMetrics: any = null;
  let baseLoadFlags = 0;
  if (options.renderer === 'freetype' && options.freetypeFace && ftModule) {
    ftModule.SetFont(options.freetypeFace.family_name, options.freetypeFace.style_name);
    ftMetrics = ftModule.SetPixelSize(0, fontSizePx);
    
    baseLoadFlags = ftModule.FT_LOAD_RENDER |
      (options.hinting === 'None' ? ftModule.FT_LOAD_NO_HINTING :
       options.hinting === 'Slight' ? ftModule.FT_LOAD_TARGET_LIGHT :
       options.hinting === 'Medium' ? ftModule.FT_LOAD_TARGET_NORMAL :
       ftModule.FT_LOAD_TARGET_MONO) |
      (options.forceAutohint ? ftModule.FT_LOAD_FORCE_AUTOHINT : 0);
  }

  // Fix 1: Batch architecture - 1024 glyphs in one canvas
  const CHUNK_SIZE = 1024;
  const maxCanvasSize = 4096;
  const TILE_COLS = Math.max(1, Math.floor(maxCanvasSize / sW));
  const batchCols = Math.min(TILE_COLS, CHUNK_SIZE);
  const batchRows = Math.ceil(CHUNK_SIZE / batchCols);
  
  const batchCanvas = document.createElement('canvas');
  batchCanvas.width = batchCols * sW;
  batchCanvas.height = batchRows * sH;
  const ctx = batchCanvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.font = fontString;
  ctx.fillStyle = 'white';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  for (let i = 0; i < binary.totalChar; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, binary.totalChar);
    const count = end - i;
    
    // Chunked FreeType Subsetting to avoid OOM
    let activeFace = options.freetypeFace;
    let tempSubsetBuffer: ArrayBuffer | null = null;
    let tempSubsetFace: FT_FaceRec | null = null;

    if (options.renderer === 'freetype' && options.customFontBuffer && ftModule) {
      let chunkChars = "";
      for (let c = i; c < end; c++) chunkChars += String.fromCharCode(c);
      
      // Use a unique suffix for each chunk to avoid name collisions and accidental unloads of the main font
      tempSubsetBuffer = subsetFontBuffer(options.customFontBuffer, chunkChars, `chunk_${i}`);
      const faces = ftModule.LoadFontFromBytes(new Uint8Array(tempSubsetBuffer));
      if (faces.length > 0) {
        tempSubsetFace = faces[0];
        activeFace = tempSubsetFace;
        ftModule.SetFont(activeFace.family_name, activeFace.style_name);
        ftMetrics = ftModule.SetPixelSize(0, fontSizePx);
      }
    }

    const chunkCodes: number[] = [];
    for (let c = i; c < end; c++) chunkCodes.push(c);
    const chunkGlyphs = (options.renderer === 'freetype' && activeFace && ftModule) ? ftModule.LoadGlyphs(chunkCodes, baseLoadFlags) : null;

    ctx.clearRect(0, 0, batchCanvas.width, batchCanvas.height);

    for (let j = 0; j < count; j++) {
      const charCode = i + j;
      const charStr = String.fromCharCode(charCode);
      const glyph = chunkGlyphs ? chunkGlyphs.get(charCode) : null;

      // Restored Canvas fallback support!

      // Fix 2: Passes loaded glyph to isCharCutoff
      const exceedsBounds = isCharCutoff(ctx, charStr, box, options, glyph);
      if (exceedsBounds) {
        cutoffChars.push(charStr);
      }

      const col = j % batchCols;
      const row = Math.floor(j / batchCols);
      const baseX = col * sW;
      const baseY = row * sH;

      ctx.save();
      
      let tx = Math.round(baseX + sW / 2 + options.xOffset * S);
      let ty = Math.round(baseY + sH / 2 + options.yOffset * S);

      if (options.autoFit) {
        const m = getCharMetrics(ctx, charStr, box, options, glyph);
        const halfW = box.width / 2;
        const halfH = box.height / 2;
        const charW = m.right - m.left;
        const charH = m.bottom - m.top;
        
        let shiftX = 0;
        let shiftY = 0;

        if (charW > box.width) {
          shiftX = -(m.left + m.right) / 2;
        } else {
          if (m.left < -halfW) shiftX = -halfW - m.left;
          if (m.right > halfW) shiftX = halfW - m.right;
        }

        if (charH > box.height) {
          shiftY = -(m.top + m.bottom) / 2;
        } else {
          if (m.top < -halfH) shiftY = -halfH - m.top;
          if (m.bottom > halfH) shiftY = halfH - m.bottom;
        }
        
        tx += Math.round(shiftX * S);
        ty += Math.round(shiftY * S);
      }

      ctx.translate(tx, ty);
      
      if (options.vertical) {
        if (options.verticalSymbols && isVerticalSymbol(charStr)) {
          ctx.rotate(0);
        } else if (!options.verticalEnglishUpright && isEnglishOrNumber(charStr)) {
          ctx.rotate(0);
        } else {
          ctx.rotate(-Math.PI / 2);
          const offset = getVerticalCharOffset(charStr, fontSizePx);
          if (offset.x !== 0 || offset.y !== 0) ctx.translate(offset.x, offset.y);
        }
      }
      
      if (glyph && glyph.glyph_index !== 0) {
        const bitmap = glyph.bitmap;
        if (bitmap.imagedata) {
          const adv = (glyph.advance.x >> 6);
          const dyOffset = (ftMetrics.ascender + ftMetrics.descender) >> 7;

          tempCtx.putImageData(bitmap.imagedata, 0, 0);
          
          const dx = Math.round(glyph.bitmap_left - adv / 2);
          const dy = Math.round(-(glyph.bitmap_top - dyOffset));
          ctx.drawImage(tempCanvas, 0, 0, bitmap.width, bitmap.rows, dx, dy, bitmap.width, bitmap.rows);
        }
      } else {
        ctx.lineWidth = 0.5;
        ctx.strokeStyle = 'white';
        ctx.fillText(charStr, 0, 0);
        ctx.strokeText(charStr, 0, 0);
      }
      
      ctx.restore();
    }
    
    // Batch getImageData
    const batchData = ctx.getImageData(0, 0, batchCols * sW, batchRows * sH).data;
    const stride = batchCols * sW * 4;

    // Fix 3: Direct byte writes
    for (let j = 0; j < count; j++) {
      const charCode = i + j;
      const glyph = chunkGlyphs ? chunkGlyphs.get(charCode) : null;
      // Removed the early skip so it extracts Canvas fallback text!
      
      const col = j % batchCols;
      const row = Math.floor(j / batchCols);
      const baseX = col * sW;
      const baseY = row * sH;
      const baseByteOffset = charCode * binary.charByte;

      for (let y = 0; y < box.height; y++) {
        const outRowOffset = baseByteOffset + y * binary.widthByte;
        for (let x8 = 0; x8 < binary.widthByte; x8++) {
          let byteVal = 0;
          for (let bit = 0; bit < 8; bit++) {
            const x = x8 * 8 + bit;
            if (x >= box.width) break;

            let isSolid = false;
            if (S === 1) {
              const bY = baseY + y;
              const bX = baseX + x;
              const idx = bY * stride + bX * 4;
              if (batchData[idx + 3] >= alphaThreshold) isSolid = true;
            } else {
              let alphaSum = 0;
              for (let sy = 0; sy < S; sy++) {
                for (let sx = 0; sx < S; sx++) {
                  const bY = baseY + y * S + sy;
                  const bX = baseX + x * S + sx;
                  const idx = bY * stride + bX * 4;
                  alphaSum += batchData[idx + 3];
                }
              }
              if (alphaSum / (S * S) >= alphaThreshold) isSolid = true;
            }

            if (isSolid) {
              byteVal |= (0x80 >>> bit);
            }
          }
          binary.fontbin[outRowOffset + x8] = byteVal;
        }
      }
    }
    
    // Cleanup chunked FreeType memory
    if (tempSubsetFace && ftModule) {
      try {
        ftModule.UnloadFont(tempSubsetFace.family_name);
      } catch (e) {
        console.warn("Failed to unload temp subset font:", e);
      }
    }

    // Yield to event loop and report progress
    await new Promise(resolve => setTimeout(resolve, 0));
    onProgress(end, binary.totalChar);
  }
  
  const name = binary.getSuggestedFileName(options.fontFamily, options.fontSize);
  return { buffer: binary.fontbin.buffer as ArrayBuffer, name, cutoffCount: cutoffChars.length, cutoffChars };
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

  const finalCtx = canvas.getContext('2d')!;

  const S = options.oversample || 1;
  const osCanvas = document.createElement('canvas');
  osCanvas.width = SCREEN_W * S;
  osCanvas.height = SCREEN_H * S;
  const ctx = osCanvas.getContext('2d', { willReadFrequently: true })!;
  
  // Disable smoothing entirely for clean 1-bit output
  ctx.imageSmoothingEnabled = false;
  ctx.scale(S, S);
  
  // Font string uses 'px' not 'pt' to ensure 1:1 mapping on the canvas buffer without OS scaling interference
  const fontSizePx = Math.round(options.fontSize * PX_PER_PT);
  const fontString = `${options.fontStyle} ${options.fontWeight} ${fontSizePx}px "${options.fontFamily}", sans-serif`;
  ctx.font = fontString;
  ctx.fillStyle = 'black'; // text opacity will be mapped cleanly to alpha array
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

      const exceedsBounds = isCharCutoff(ctx, charStr, box, options);
      if (exceedsBounds) {
        cutoffChars.add(charStr);
      }

      ctx.save();

      let scale = 1;
      let tx, ty;
      if (options.vertical) {
        tx = Math.round(currentX + charBoxH / 2 - options.yOffset);
        ty = Math.round(currentY + charBoxW / 2 + options.xOffset);
      } else {
        tx = Math.round(currentX + charBoxW / 2 + options.xOffset);
        ty = Math.round(currentY + charBoxH / 2 + options.yOffset);
      }

      if (options.autoFit) {
        const m = getCharMetrics(ctx, charStr, box, options);
        const halfW = box.width / 2;
        const halfH = box.height / 2;
        const charW = m.right - m.left;
        const charH = m.bottom - m.top;
        
        let shiftX = 0;
        let shiftY = 0;

        if (charW > box.width) {
          shiftX = -(m.left + m.right) / 2;
        } else {
          if (m.left < -halfW) shiftX = -halfW - m.left;
          if (m.right > halfW) shiftX = halfW - m.right;
        }

        if (charH > box.height) {
          shiftY = -(m.top + m.bottom) / 2;
        } else {
          if (m.top < -halfH) shiftY = -halfH - m.top;
          if (m.bottom > halfH) shiftY = halfH - m.bottom;
        }
        
        if (options.vertical) {
          tx += Math.round(-shiftY);
          ty += Math.round(shiftX);
        } else {
          tx += Math.round(shiftX);
          ty += Math.round(shiftY);
        }
      }

      ctx.translate(tx, ty);

      if (options.vertical) {
        if (options.verticalSymbols && isVerticalSymbol(charStr)) {
          ctx.rotate(Math.PI / 2);
        } else if (!options.verticalEnglishUpright && isEnglishOrNumber(charStr)) {
          ctx.rotate(Math.PI / 2);
        } else {
          const offset = getVerticalCharOffset(charStr, fontSizePx);
          if (offset.x !== 0 || offset.y !== 0) {
            ctx.translate(offset.x, offset.y);
          }
        }
      }
      
      if (options.renderer === 'freetype' && options.freetypeFace && ftModule) {
        ftModule.SetFont(options.freetypeFace.family_name, options.freetypeFace.style_name);
        const m = ftModule.SetPixelSize(0, fontSizePx);
        
        const previewLoadFlags = ftModule.FT_LOAD_RENDER |
          (options.hinting === 'None' ? ftModule.FT_LOAD_NO_HINTING :
           options.hinting === 'Slight' ? ftModule.FT_LOAD_TARGET_LIGHT :
           options.hinting === 'Medium' ? ftModule.FT_LOAD_TARGET_NORMAL :
           ftModule.FT_LOAD_TARGET_MONO) |
          (options.forceAutohint ? ftModule.FT_LOAD_FORCE_AUTOHINT : 0);

        const charCode = charStr.charCodeAt(0);
        const glyphs = ftModule.LoadGlyphs([charCode], previewLoadFlags);
        const glyph = glyphs.get(charCode);

        if (glyph && glyph.glyph_index !== 0) {
          const bitmap = glyph.bitmap;
          if (bitmap.imagedata) {
            const adv = (glyph.advance.x >> 6);
            const dyOffset = (m.ascender + m.descender) >> 7;

            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = bitmap.width;
            tempCanvas.height = bitmap.rows;
            const tempCtx = tempCanvas.getContext('2d')!;
            tempCtx.putImageData(bitmap.imagedata, 0, 0);
            
            const dx = Math.round(glyph.bitmap_left - adv / 2);
            const dy = Math.round(-(glyph.bitmap_top - dyOffset));
            ctx.drawImage(tempCanvas, dx, dy);
          }
        } else {
          // Fallback
          ctx.lineWidth = 0.5;
          ctx.strokeStyle = 'black';
          ctx.fillText(charStr, 0, 0);
          ctx.strokeText(charStr, 0, 0);
        }
      } else {
        // Fallback
        ctx.lineWidth = 0.5;
        ctx.strokeStyle = 'black';
        ctx.fillText(charStr, 0, 0);
        ctx.strokeText(charStr, 0, 0);
      }
      
      ctx.restore();

      if (options.vertical) {
        drawnBoxes.push({ x: currentX, y: currentY, w: charBoxH, h: charBoxW, isCutoff: exceedsBounds });
      } else {
        drawnBoxes.push({ x: currentX, y: currentY, w: charBoxW, h: charBoxH, isCutoff: exceedsBounds });
      }

      // Advance cursor
      if (options.vertical) {
        currentY += charBoxW;
      } else {
        currentX += charBoxW;
      }
    }
  }

  // Apply thresholding effect for accurate 1-bit preview with supersampling
  const osImageData = ctx.getImageData(0, 0, osCanvas.width, osCanvas.height);
  const data = osImageData.data;
  
  const alphaThreshold = 255 - (options.threshold / 1000 * 255);
  
  const finalImageData = finalCtx.createImageData(SCREEN_W, SCREEN_H);
  const outData = finalImageData.data;
  
  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      let alphaSum = 0;
      if (S === 1) {
        const idx = (y * SCREEN_W + x) * 4;
        alphaSum = data[idx + 3];
      } else {
        // Average the S x S block
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            const idx = ((y * S + sy) * osCanvas.width + (x * S + sx)) * 4;
            alphaSum += data[idx + 3];
          }
        }
        alphaSum = alphaSum / (S * S);
      }
      
      const outIdx = (y * SCREEN_W + x) * 4;
      const isSolid = alphaSum >= alphaThreshold;
      if (isSolid) {
        outData[outIdx] = 0; outData[outIdx+1] = 0; outData[outIdx+2] = 0; outData[outIdx+3] = 255;
      } else {
        outData[outIdx] = 255; outData[outIdx+1] = 255; outData[outIdx+2] = 255; outData[outIdx+3] = 255;
      }
    }
  }
  
  finalCtx.putImageData(finalImageData, 0, 0);

  // Draw boundary boxes and warnings
  drawnBoxes.forEach(b => {
    if (b.isCutoff) {
      finalCtx.fillStyle = 'rgba(255, 0, 0, 0.15)';
      finalCtx.fillRect(b.x, b.y, b.w, b.h);
      finalCtx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
      finalCtx.lineWidth = 1;
      finalCtx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    } else if (showBoundary) {
      finalCtx.strokeStyle = 'rgba(0, 0, 255, 0.15)';
      finalCtx.lineWidth = 1;
      finalCtx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    }
  });

  return { count: cutoffChars.size, chars: Array.from(cutoffChars) };
}

export function calculateMinimumPadding(text: string, options: FontGenerationOptions): { charSpacing: number, lineSpacing: number } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  
  const fontSizePx = options.fontSize * (220 / 72);
  const fontString = `${options.fontStyle || 'normal'} ${options.fontWeight || 'normal'} ${fontSizePx}px "${options.fontFamily}", sans-serif`;
  ctx.font = fontString;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // To find the raw required padding, we evaluate metrics assuming 0 padding
  // The un-padded box size is just `measureCharSize` with 0 padding variables.
  const baseOptions = { ...options, charSpacing: 0, lineSpacing: 0 };
  const baseBox = measureCharSize(baseOptions);
  
  let requiredWidth = 5; // Absolute minimum
  let requiredHeight = 5;

  // We test all unique characters visually to find the absolute max needed size boundaries
  const uniqueChars = Array.from(new Set(text.replace(/\n|\r/g, '')));
  
  for (const charStr of uniqueChars) {
     const m = getCharMetrics(ctx, charStr, baseBox, baseOptions);
     let reqW = 0;
     let reqH = 0;

     if (options.autoFit) {
       // Auto-fit correctly centers the raw ink outline, so box only needs to match width/height
       reqW = m.right - m.left;
       reqH = m.bottom - m.top;
     } else {
       // Rigid bounds require the bounding container to stretch far enough to cover both extremes from center
       reqW = 2 * Math.max(Math.abs(m.left), Math.abs(m.right));
       reqH = 2 * Math.max(Math.abs(m.top), Math.abs(m.bottom));
     }

     if (reqW > requiredWidth) requiredWidth = reqW;
     if (reqH > requiredHeight) requiredHeight = reqH;
  }

  // Calculate the delta difference needed against the baseline font metrics
  let charSpacing = Math.ceil(requiredWidth - baseBox.width);
  let lineSpacing = Math.ceil(requiredHeight - baseBox.height);

  if (options.vertical) {
    // In vertical layout, Square Box Padding uses uniform constraints
    const maxPad = Math.max(charSpacing, lineSpacing);
    return { charSpacing: maxPad, lineSpacing: maxPad };
  }

  return { charSpacing, lineSpacing };
}

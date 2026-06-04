import InitFreetype, { FreetypeModule, FT_FaceRec, FT_GlyphSlotRec } from 'freetype-wasm/dist/freetype.js';
import * as opentype from 'opentype.js';
import { fontSubsetPool } from './font-subset-pool';

/**
 * Subsets a font buffer to only include the specified characters.
 * This runs on a Web Worker pool for parallel processing.
 */
export async function subsetFontBuffer(buffer: ArrayBuffer, characters: string, nameSuffix: string = ''): Promise<ArrayBuffer> {
  try {
    return await fontSubsetPool.subset(buffer, characters, nameSuffix);
  } catch (err) {
    console.error('Worker subset failed, falling back to sync:', err);
    return subsetFontBufferSync(buffer, characters, nameSuffix);
  }
}

/**
 * Synchronous fallback for font subsetting (main thread).
 * Used during font upload where FreeType needs immediate access to the subset buffer.
 */
export function subsetFontBufferSync(buffer: ArrayBuffer, characters: string, nameSuffix: string = '', parsedFont?: opentype.Font): ArrayBuffer {
  try {
    const font = parsedFont || opentype.parse(buffer);
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
  fontSize: number; // in px
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
  format?: 'bin' | 'xtf';
  xtfFontOnly?: boolean;  // XTF only: render only glyphs present in the uploaded font
  xtfAsciiOffset?: number; // XTF only: px offset to add to ASCII proportional advance widths
}

const VERTICAL_SYMBOLS = new Set([
  '(', ')', '[', ']', '{', '}', '<', '>',
  '（', '）', '【', '】', '《', '》', '〈', '〉', '「', '」', '『', '』', '［', '］', '｛', '｝', '〔', '〕', '〖', '〗', '〘', '〙', '〚', '〛',
  '-', '—', '–', '…', '⋯', '‥', '_', '~', '～', '〜', 'ー', '｜',
  '：', '；', '=', '＝', '‰', '―'
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
    // The -2px X adjustment corrects for the visual leftward drift on the device.
    return { x: fontSizePx * 0.55 - 2, y: -fontSizePx * 0.55 };
  }

  if (VERTICAL_SUTEGANA.has(char)) {
    // Sutegana (small kana) require an independent, smaller shift.
    // Shift slightly Right (+X) and Up (-Y)
    return { x: fontSizePx * 0.15 - 2, y: -fontSizePx * 0.15 };
  }

  if (isEnglishOrNumber(char)) {
    // Rotated Latin/English characters (when verticalEnglishUpright is checked)
    // need a small upward shift to center properly in the cell after -90° rotation.
    // On device (rotated +90°), this becomes a leftward shift.
    return { x: -2, y: 0 };
  }

  return { x: 0, y: 0 };
}

function isVerticalSymbol(char: string): boolean {
  return VERTICAL_SYMBOLS.has(char);
}

// Extended punctuation that should be left-aligned proportional in XTF (same as ASCII),
// matching the Bookerly reference. These are non-ASCII chars commonly found in e-book text.
const XTF_PROPORTIONAL_EXTENDED = new Set([
  0x2013, 0x2014,             // en dash, em dash
  0x2018, 0x2019, 0x201A,     // single quotes
  0x201C, 0x201D, 0x201E,     // double quotes
  0x2026,                     // ellipsis
  0x2010, 0x2011, 0x2012,     // hyphens
  0x2015,                     // horizontal bar
  0x2020, 0x2021,             // daggers
  0x2022,                     // bullet
  0x2039, 0x203A,             // single guillemets
  0x00AB, 0x00BB,             // double guillemets
  0x00A0,                     // non-breaking space
  0x00AD,                     // soft hyphen
]);

function isEnglishOrNumber(char: string): boolean {
  // ASCII characters (letters, numbers, and basic punctuation not in vertical symbols)
  // + Extended Latin ranges so accented chars (é, ñ, ü, etc.) follow the same rotation rules
  if (isVerticalSymbol(char)) return false;
  const code = char.charCodeAt(0);
  return (code >= 0x20 && code <= 0x7E)                   // ASCII
    || (code >= 0x00A0 && code <= 0x024F)                  // Latin-1 Supplement + Latin Extended-A/B
    || (code >= 0x1E00 && code <= 0x1EFF)                  // Latin Extended Additional (Vietnamese)
    || XTF_PROPORTIONAL_EXTENDED.has(code);                // Smart quotes, dashes, etc.
}

function checkIsLeftSided(charCode: number, charStr: string, options: FontGenerationOptions): boolean {
  if (options.format !== 'xtf') return false;
  // Left-aligned proportional: ASCII + Latin Extended ranges + specific extended punctuation
  const isProportional = charCode <= 0x7E                                 // ASCII
    || (charCode >= 0x00A0 && charCode <= 0x024F)                         // Latin-1 Supplement + Latin Extended-A/B
    || (charCode >= 0x0300 && charCode <= 0x036F)                         // Combining Diacritical Marks
    || (charCode >= 0x1E00 && charCode <= 0x1EFF)                         // Latin Extended Additional (Vietnamese)
    || XTF_PROPORTIONAL_EXTENDED.has(charCode);                           // Smart quotes, dashes, etc.
  if (!isProportional) return false;
  let isRotatedMinus90 = false;
  if (options.vertical) {
    if (options.verticalSymbols && isVerticalSymbol(charStr)) {
      isRotatedMinus90 = false;
    } else if (!options.verticalEnglishUpright && isEnglishOrNumber(charStr)) {
      isRotatedMinus90 = false;
    } else {
      isRotatedMinus90 = true;
    }
  }
  return !isRotatedMinus90;
}

function getCharMetrics(ctx: CanvasRenderingContext2D, char: string, box: { width: number, height: number }, options: FontGenerationOptions, preloadedGlyph?: FT_GlyphSlotRec | null) {
  let left = 0, right = 0, top = 0, bottom = 0;
  const fontSizePx = Math.round(options.fontSize);

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
      const isLeftSided = checkIsLeftSided(char.charCodeAt(0), char, options);
      if (isLeftSided) {
        // Pen is at the left edge of the bounding box
        left = -(box.width / 2) + glyph.bitmap_left;
        right = left + glyph.bitmap.width;
      } else {
        // Use bitmap boundaries relative to the centered pen
        left = (glyph.bitmap_left - adv / 2);
        right = left + glyph.bitmap.width;
      }
      top = -(glyph.bitmap_top - dyOffset);
      bottom = top + glyph.bitmap.rows;
    }
  } else {
    const metrics = ctx.measureText(char);
    const isLeftSided = checkIsLeftSided(char.charCodeAt(0), char, options);
    if (isLeftSided) {
      left = -(box.width / 2);
      right = left + metrics.actualBoundingBoxRight + metrics.actualBoundingBoxLeft;
    } else {
      left = -metrics.actualBoundingBoxLeft;
      right = metrics.actualBoundingBoxRight;
    }
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
  const fontSizePx = Math.round(options.fontSize);
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

    if (options.format === 'xtf') {
      // XTF: use fontSize directly as height.
      // Reference files confirm: H = fontSize (e.g., 28px → H=28, 36px → H=36).
      // ascender-descender produces a much larger value (~38 at 28px) causing
      // excessive padding compared to stock XTF files.
      h = fontSizePx;
    } else {
      // .bin: use ascender-descender for full line height
      if (m) {
        h = Math.round((m.ascender - m.descender) >> 6);
      } else {
        h = fontSizePx;
      }
    }
  } else {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    // Use 'px' to match generation, avoiding CSS vs Device pixel ratio scaling issues
    const fontString = `${options.fontStyle} ${options.fontWeight} ${fontSizePx}px "${options.fontFamily}", sans-serif`;
    ctx.font = fontString;

    const metrics = ctx.measureText("坐");

    w = Math.round(metrics.width);

    if (options.format === 'xtf') {
      h = fontSizePx;
    } else {
      h = Math.round(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent);
      if (isNaN(h) || h === 0) {
        h = Math.round(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);
      }
    }
  }

  if (h === 0) h = fontSizePx;
  if (w === 0) w = fontSizePx;

  // Add spacing
  let finalW = w + options.charSpacing;
  let finalH = h + options.lineSpacing;

  if (options.vertical && options.format !== 'xtf') {
    // In vertical mode for .bin format, some characters are drawn sideways (rotated -90),
    // and some are drawn upright (rotate 0).
    // Because the .bin format requires a single globally fixed width/height for ALL characters,
    // a rectangular box will inevitably cut off one group or the other.
    // The only mathematically safe solution is to force a square box based on the largest dimension.
    const maxDim = Math.max(finalW, finalH);
    finalW = maxDim;
    finalH = maxDim;
  }
  // XTF: no square enforcement. Stock reference files show non-square cells
  // (e.g., ShipporiMincho 29×28). Width and height are independent.

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

  constructor(width: number, height: number, widthPadding: number = 0, heightPadding: number = 0) {
    this.width = Math.max(1, width + widthPadding);
    this.height = Math.max(1, height + heightPadding);
    this.widthByte = Math.ceil(this.width / 8);
    this.charByte = this.widthByte * this.height;
    this.fontbin = new Uint8Array(this.charByte * this.totalChar);
  }

  getSuggestedFileName(title: string, px: number) {
    return `${title}.${px}px.${this.width}x${this.height}.bin`;
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

// CRC32 for XTF integrity checksums (standard polynomial 0xEDB88320)
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(data: Uint8Array, start: number, end: number): number {
  let crc = 0xFFFFFFFF;
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export class XTEinkFontXTF {
  width: number;
  height: number;
  stride: number;
  glyphSize: number;  // pixel data only (stride * height)
  metrics: Map<number, { width: number }> = new Map();       // bitmap width per glyph (glyph prefix byte 0)
  fontAdvWidths: Map<number, number> = new Map();             // font-metric advance width (for fast-path table)
  usedChars: Map<number, Uint8Array> = new Map();
  totalChar = 0x10000;

  fontSize: number;
  // Font-specific metrics from FreeType (set externally after construction)
  fontAscent: number = 0;
  fontDescender: number = 0;
  cellWidth: number = 0;  // default advance width (e.g., digit '0'), NOT max width
  asciiAdvanceOffset: number = 0;  // px offset applied to ASCII proportional advance widths

  constructor(width: number, height: number, fontSize: number, widthPadding: number = 0, heightPadding: number = 0) {
    // Apply user-defined padding first (widthPadding can be NEGATIVE to shrink cell)
    const rawWidth = width + widthPadding;
    const rawHeight = height + heightPadding;
    // Pad width to multiple of 4 so stride = width/4 is exact (no ceil ambiguity).
    // The device computes stride as integer division (width/4), so any remainder
    // causes row drift and "smeared" rendering.
    this.width = Math.ceil(Math.max(4, rawWidth) / 4) * 4;
    this.height = Math.max(4, rawHeight);
    this.fontSize = fontSize;
    // 2-bit interleaved packing: 4 pixels per byte, MSB-first
    this.stride = this.width / 4;
    this.glyphSize = this.stride * this.height;
  }

  getSuggestedFileName(title: string, px: number) {
    return `${px}_${title.replace(/\s+/g, '_')}.xtf`;
  }

  setPixel2Bit(charCode: number, x: number, y: number, grayValue: number, advWidth?: number) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;

    if (advWidth !== undefined && !this.metrics.has(charCode)) {
      this.metrics.set(charCode, { width: advWidth });
    }

    let glyph = this.usedChars.get(charCode);
    if (!glyph) {
      glyph = new Uint8Array(this.glyphSize);
      this.usedChars.set(charCode, glyph);
    }

    // MSB-first interleaved packing: [p0 p1 p2 p3] per byte
    // p0 occupies bits 7-6, p1 bits 5-4, p2 bits 3-2, p3 bits 1-0
    const byteIdx = y * this.stride + (x >> 2);
    const shift = 6 - (x % 4) * 2;
    const mask = 0x03 << shift;

    glyph[byteIdx] = (glyph[byteIdx] & ~mask) | ((grayValue & 0x03) << shift);
  }

  generateBuffer(): ArrayBuffer {
    // Ensure Space (U+0020) is always present
    if (!this.usedChars.has(32)) {
      this.usedChars.set(32, new Uint8Array(this.glyphSize));
    }

    // Add fallback whitespace/invisible chars that are commonly used in
    // Japanese LN / CJK content but absent from Latin fonts.
    // Without these, the device shows boxes.
    const spaceAdvW = this.metrics.get(32)?.width || Math.round(this.width / 4);
    const fallbackSpaces: [number, number][] = [
      [0x00A0, spaceAdvW],     // Non-breaking space
      [0x2002, spaceAdvW],     // En space
      [0x2003, spaceAdvW * 2], // Em space
      [0x2007, spaceAdvW],     // Figure space
      [0x2009, Math.round(spaceAdvW * 0.6)], // Thin space
      [0x200A, Math.round(spaceAdvW * 0.3)], // Hair space
      [0x200B, 0],             // Zero-width space
      [0x200C, 0],             // Zero-width non-joiner
      [0x200D, 0],             // Zero-width joiner
      [0x202F, Math.round(spaceAdvW * 0.6)], // Narrow NBSP
      [0x205F, Math.round(spaceAdvW * 0.6)], // Medium math space
      [0x3000, spaceAdvW * 2], // Ideographic space (CJK paragraph indent)
      [0xFEFF, 0],             // BOM / zero-width no-break space
    ];
    for (const [code, aw] of fallbackSpaces) {
      if (!this.usedChars.has(code)) {
        this.usedChars.set(code, new Uint8Array(this.glyphSize));
        this.metrics.set(code, { width: aw });
      }
    }

    const sortedChars = Array.from(this.usedChars.keys())
      .filter(c => c >= 32)
      .sort((a, b) => a - b);

    // Build contiguous Unicode ranges
    const ranges: { start: number; count: number; glyphIndex: number }[] = [];
    if (sortedChars.length > 0) {
      let cur = { start: sortedChars[0], count: 1, glyphIndex: 0 };
      for (let i = 1; i < sortedChars.length; i++) {
        if (sortedChars[i] === cur.start + cur.count) {
          cur.count++;
        } else {
          ranges.push(cur);
          cur = { start: sortedChars[i], count: 1, glyphIndex: i };
        }
      }
      ranges.push(cur);
    }

    const numEntries = ranges.length;
    const totalGlyphs = sortedChars.length;
    const blockSize = 2 + this.glyphSize; // 2-byte PREFIX + pixel data
    const tableOffset = 0x40;

    // Calculate data start: table end + 224 bytes for fast-path table, then align
    // to the next power-of-2 boundary for DMA-safe alignment.
    const tableEnd = tableOffset + numEntries * 16;
    const minDataStart = tableEnd + 224; // fast-path table occupies 224 bytes after mapping table
    let dataStartOffset = 0x0800; // minimum alignment (2KB)
    while (dataStartOffset < minDataStart) {
      dataStartOffset *= 2;
    }

    const dataSize = totalGlyphs * blockSize;
    const totalFileSize = dataStartOffset + dataSize;

    const buffer = new ArrayBuffer(totalFileSize);
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);

    // === HEADER (0x00 - 0x3F) ===
    // 0x00: Magic "XTF0"
    view.setUint32(0x00, 0x30465458, true);
    // 0x04: Flags (fixed)
    view.setUint32(0x04, 0x02400501, true);
    // 0x08: SubType
    view.setUint16(0x08, 0x0003, true);
    // 0x0A: WIDTH (device reads this as width!)
    view.setUint8(0x0A, this.width);
    // 0x0B: HEIGHT (device reads this as height!)
    view.setUint8(0x0B, this.height);
    // 0x0C: Ascent — font-specific metric from FreeType, fallback to height * 0.85
    view.setUint8(0x0C, this.fontAscent > 0 ? this.fontAscent : Math.round(this.height * 0.85));
    // 0x0D: Cell Width — default advance width (e.g., digit '0'), NOT Max Width
    view.setUint8(0x0D, this.cellWidth > 0 ? this.cellWidth : this.width);
    // 0x0E: Scaling Factor — ceil(height/2)
    view.setUint8(0x0E, Math.ceil(this.height / 2));
    view.setUint8(0x0F, 0);
    // 0x10: First Unicode character — includes Space (U+0020)
    const firstChar = sortedChars.length > 0 ? sortedChars[0] : 0x20;
    view.setUint16(0x10, firstChar, true);
    // 0x12: Descender — font-specific signed metric from FreeType
    view.setInt16(0x12, this.fontDescender !== 0 ? this.fontDescender : -9, true);
    // 0x14: Number of mapping table entries  *** FIXED: was totalGlyphs ***
    view.setUint32(0x14, numEntries, true);
    // 0x18: Total glyph count  *** FIXED: was numEntries ***
    view.setUint32(0x18, totalGlyphs, true);
    // 0x1C: Table offset (always 0x40)
    view.setUint32(0x1C, tableOffset, true);
    // 0x20: Reserved
    view.setUint32(0x20, 0, true);
    // 0x24: Data start offset  *** FIXED: was set to tableOffset ***
    view.setUint32(0x24, dataStartOffset, true);
    // 0x28: Block size (2 prefix + pixel data)
    view.setUint32(0x28, blockSize, true);
    // 0x2C: Data section size (totalGlyphs * blockSize)
    view.setUint32(0x2C, dataSize, true);
    // 0x30-0x37: CRC32 checksums (computed AFTER data is written)
    // 0x38: Table end offset (0x40 + numEntries * 16)
    view.setUint32(0x38, tableEnd, true);
    // 0x3C: First range count
    if (ranges.length > 0) {
      view.setUint32(0x3C, ranges[0].count, true);
    }

    // === MAPPING TABLE (16 bytes per entry at 0x40) ===
    for (let i = 0; i < numEntries; i++) {
      const r = ranges[i];
      const entryPos = tableOffset + i * 16;
      // +0: Start Unicode (LE u32)
      view.setUint32(entryPos, r.start, true);
      // +4: Count (LE u32)
      view.setUint32(entryPos + 4, r.count, true);
      // +8: Glyph index (LE u32)
      view.setUint32(entryPos + 8, r.glyphIndex, true);
      // +12: Count in upper 16 bits  *** FIXED encoding ***
      view.setUint32(entryPos + 12, r.count << 16, true);
    }

    // === GLYPH DATA (2-byte PREFIX + pixel data per block) ===
    for (let i = 0; i < totalGlyphs; i++) {
      const charCode = sortedChars[i];
      const glyph = this.usedChars.get(charCode)!;
      const offset = dataStartOffset + i * blockSize;

      // PREFIX: Byte 0 = Bitmap Width (rendered pixel extent), Byte 1 = Flags (0)
      // This is distinct from the font-metric advance in the fast-path table.
      const m = this.metrics.get(charCode) || { width: this.width };
      u8[offset] = Math.min(255, m.width);
      u8[offset + 1] = 0;

      // Pixel data follows the prefix
      u8.set(glyph, offset + 2);
    }

    // === ASCII FAST-PATH ADVANCE WIDTH TABLE (224 bytes) ===
    // The device reads a 224-byte font-metric advance width lookup table
    // for U+0020-U+00FF, stored in the gap between the mapping table end
    // and the data start. These are the TRUE typographic advance widths
    // (including sidebearings), which may differ from the bitmap widths
    // in the glyph prefix bytes.
    for (let cp = 0x20; cp <= 0xFF; cp++) {
      const fontAdv = this.fontAdvWidths.get(cp);
      if (fontAdv !== undefined) {
        // Use the font-metric advance (includes sidebearings) for text layout
        // Apply ASCII offset if configured (XTF only)
        const offset = this.asciiAdvanceOffset || 0;
        u8[tableEnd + (cp - 0x20)] = Math.min(255, Math.max(0, fontAdv + offset));
      } else {
        // Fallback: use the bitmap width from the glyph prefix
        const charToGlyphIdx = sortedChars.indexOf(cp);
        if (charToGlyphIdx >= 0) {
          u8[tableEnd + (cp - 0x20)] = u8[dataStartOffset + charToGlyphIdx * blockSize];
        }
      }
    }

    // === CRC32 CHECKSUMS ===
    // 0x30: CRC32 of entire data section (all glyph blocks)
    const dataCrc = crc32(u8, dataStartOffset, dataStartOffset + dataSize);
    view.setUint32(0x30, dataCrc, true);
    // 0x34: CRC32 of header bytes 0x00-0x33 (after 0x30 is set)
    const headerCrc = crc32(u8, 0x00, 0x34);
    view.setUint32(0x34, headerCrc, true);

    console.log(`[XTF] Generated ${totalGlyphs} glyphs in ${numEntries} ranges. Data at 0x${dataStartOffset.toString(16)}. Block=${blockSize}. Total: ${(totalFileSize / 1024).toFixed(1)} KB`);
    return buffer;
  }
}

export async function generateFontBinary(
  options: FontGenerationOptions,
  onProgress: (current: number, total: number) => void
): Promise<{ buffer: ArrayBuffer, name: string, cutoffCount: number, cutoffChars: string[] }> {
  const box = measureCharSize(options);
  const isXtf = options.format === 'xtf';
  const binary = isXtf
    ? new XTEinkFontXTF(box.width, box.height, Math.round(options.fontSize), options.widthPadding, options.heightPadding)
    : new XTEinkFontBinary(box.width, box.height, options.widthPadding, options.heightPadding);


  const S = options.oversample || 1; // Supersample factor
  const sW = box.width * S;
  const sH = box.height * S;

  // Use the supersampled font size for rendering
  const fontSizePx = Math.round(options.fontSize * S);
  const fontString = `${options.fontStyle} ${options.fontWeight} ${fontSizePx}px "${options.fontFamily}", sans-serif`;

  // Boldness: 400 = neutral, <400 = thinner (erode), >400 = bolder (dilate)
  // For .bin: morphological dilation/erosion on alpha, then threshold at 128
  // For .xtf: same morphological operation, then map to 2-bit greyscale levels
  const boldness = (options.threshold - 400) / 500; // -0.6 to +1.0 range
  const alphaThreshold = 128; // Fixed threshold for 1-bit after boldness
  const S2 = S * S;
  const scaledThreshold = alphaThreshold * S2;

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
    // SetFont/SetPixelSize deferred to per-chunk (each chunk loads a subset face)
    baseLoadFlags = ftModule.FT_LOAD_RENDER |
      (isXtf ? ftModule.FT_LOAD_TARGET_NORMAL :
        options.hinting === 'None' ? ftModule.FT_LOAD_NO_HINTING :
          options.hinting === 'Slight' ? ftModule.FT_LOAD_TARGET_LIGHT :
            options.hinting === 'Medium' ? ftModule.FT_LOAD_TARGET_NORMAL :
              ftModule.FT_LOAD_TARGET_MONO) |
      (options.forceAutohint ? ftModule.FT_LOAD_FORCE_AUTOHINT : 0);
  }

  // Track actual FreeType advance widths per charCode for XTF prefix
  const glyphAdvWidths = new Map<number, number>();

  // Extract real font metrics from FreeType for XTF header fields
  if (isXtf && options.renderer === 'freetype' && options.freetypeFace && ftModule) {
    const xtfBin = binary as XTEinkFontXTF;
    ftModule.SetFont(options.freetypeFace.family_name, options.freetypeFace.style_name);
    const rawFontSizePx = Math.round(options.fontSize);
    const metrics = ftModule.SetPixelSize(0, rawFontSizePx);
    if (metrics) {
      // Real font ascent/descender from FreeType's scaled metrics (26.6 fixed point)
      xtfBin.fontAscent = Math.round(metrics.ascender >> 6);
      xtfBin.fontDescender = Math.round(metrics.descender >> 6); // negative value
    }
    // Cell Width = Max Width (block width). The reference XTF file confirms
    // Cell Width always equals Max Width. The device uses this for CJK fixed-grid spacing.
    xtfBin.cellWidth = xtfBin.width;
    // Pass ASCII advance offset to the binary for fast-path table generation
    xtfBin.asciiAdvanceOffset = options.xtfAsciiOffset || 0;
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

  // Pre-parse the font on a worker to avoid blocking the main thread.
  // For CJK fonts (10-20MB), opentype.parse can take 200-500ms.
  let preScannedFont: opentype.Font | null = null;
  let preParsedUnicodes: number[] | null = null;
  if (options.renderer === 'freetype' && options.customFontBuffer) {
    try {
      // Use worker pool for pre-parsing to get unicode coverage without blocking main thread
      const preParsed = await fontSubsetPool.preparse(options.customFontBuffer);
      preParsedUnicodes = preParsed.unicodes;
      console.log(`[FontSubsetPool] Pre-parsed font: ${preParsed.glyphCount} glyphs, ${preParsed.unicodes.length} unicodes`);
      // We still need a main-thread parse for the glyph-existence check in the chunk loop
      // when NOT using fontOnlyCharCodes (i.e., .bin mode full 64K iteration).
      // For XTF font-only mode, we can skip this entirely since we have the unicode list.
      if (!(isXtf && options.xtfFontOnly !== false)) {
        preScannedFont = opentype.parse(options.customFontBuffer);
      }
    } catch (e) {
      console.warn("Failed to pre-parse font for optimization:", e);
      // Fallback to main-thread parsing
      try {
        preScannedFont = opentype.parse(options.customFontBuffer);
      } catch (e2) {
        console.warn("Main-thread parse also failed:", e2);
      }
    }
  }

  // XTF Font-Only mode: build a set of char codes that exist in the font,
  // then only iterate those instead of the full 0-0xFFFF range.
  // This dramatically speeds up generation for Latin-only fonts (e.g., ~2000 vs 65536).
  let fontOnlyCharCodes: number[] | null = null;
  if (isXtf && options.xtfFontOnly !== false && (preParsedUnicodes || preScannedFont)) {
    if (preParsedUnicodes) {
      // Use the worker-parsed unicodes directly (no main-thread opentype.parse needed!)
      const validCodes = new Set<number>(preParsedUnicodes);
      validCodes.add(0x20);
      fontOnlyCharCodes = Array.from(validCodes).sort((a, b) => a - b);
    } else if (preScannedFont) {
      const validCodes = new Set<number>();
      const glyphSet = preScannedFont.glyphs;
      for (let gi = 0; gi < glyphSet.length; gi++) {
        const g = glyphSet.get(gi);
        if (g && g.unicodes) {
          for (const u of g.unicodes) {
            if (u >= 0 && u < 0x10000) validCodes.add(u);
          }
        }
      }
      validCodes.add(0x20);
      fontOnlyCharCodes = Array.from(validCodes).sort((a, b) => a - b);
    }
    if (fontOnlyCharCodes) {
      // Override totalChar so progress reporting is accurate
      binary.totalChar = fontOnlyCharCodes.length;
      console.log(`[XTF] Font-Only mode: ${fontOnlyCharCodes.length} glyphs found in font`);
    }
  }

  // Determine iteration range
  const totalIterations = fontOnlyCharCodes ? fontOnlyCharCodes.length : binary.totalChar;

  for (let i = 0; i < totalIterations; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, totalIterations);
    const count = end - i;

    // Chunked FreeType Subsetting to avoid OOM
    let activeFace = options.freetypeFace;
    let tempSubsetBuffer: ArrayBuffer | null = null;
    let tempSubsetFace: FT_FaceRec | null = null;

    if (options.renderer === 'freetype' && options.customFontBuffer && ftModule) {
      let chunkChars = "";
      if (fontOnlyCharCodes) {
        // In font-only mode, i..end are indices into fontOnlyCharCodes
        for (let c = i; c < end; c++) {
          chunkChars += String.fromCharCode(fontOnlyCharCodes[c]);
        }
      } else if (preScannedFont) {
        for (let c = i; c < end; c++) {
          const char = String.fromCharCode(c);
          const glyph = preScannedFont.charToGlyph(char);
          if (glyph && glyph.index !== 0) {
            chunkChars += char;
          }
        }
      } else if (preParsedUnicodes) {
        // We have unicode list from worker but no preScannedFont — use the unicode set for filtering
        const unicodeSet = new Set(preParsedUnicodes);
        for (let c = i; c < end; c++) {
          if (unicodeSet.has(c)) {
            chunkChars += String.fromCharCode(c);
          }
        }
      } else {
        chunkChars = Array.from({ length: end - i }, (_, k) => String.fromCharCode(i + k)).join('');
      }

      if (chunkChars.length > 0) {
        // Use worker pool for parallel subsetting — this is the main performance win.
        // Each chunk's subset runs on a Web Worker, avoiding main-thread blocking.
        tempSubsetBuffer = await fontSubsetPool.subset(options.customFontBuffer, chunkChars, `chunk_${i}`);
        const faces = ftModule.LoadFontFromBytes(new Uint8Array(tempSubsetBuffer));
        if (faces.length > 0) {
          tempSubsetFace = faces[0];
          activeFace = tempSubsetFace;
          ftModule.SetFont(activeFace.family_name, activeFace.style_name);
          ftMetrics = ftModule.SetPixelSize(0, fontSizePx);
        }
      }
    }

    const chunkCodes: number[] = [];
    for (let c = i; c < end; c++) {
      chunkCodes.push(fontOnlyCharCodes ? fontOnlyCharCodes[c] : c);
    }
    const chunkGlyphs = (options.renderer === 'freetype' && activeFace && ftModule) ? ftModule.LoadGlyphs(chunkCodes, baseLoadFlags) : null;

    ctx.clearRect(0, 0, batchCanvas.width, batchCanvas.height);

    for (let j = 0; j < count; j++) {
      const charCode = fontOnlyCharCodes ? fontOnlyCharCodes[i + j] : (i + j);
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

      // Add clipping to prevent bleeding between tiles
      ctx.beginPath();
      ctx.rect(baseX, baseY, sW, sH);
      ctx.clip();

      const isLeftSided = checkIsLeftSided(charCode, charStr, options);

      // XTF ASCII: left-align (device advances by per-glyph width from left edge)
      // bin and XTF non-ASCII: center in cell
      let tx = isLeftSided
        ? Math.round(baseX + options.xOffset * S)
        : Math.round(baseX + sW / 2 + options.xOffset * S);
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
        const adv = (glyph.advance.x >> 6);
        const baseAdvPx = Math.round(adv / S);

        // For XTF: store font-metric advance width in fontAdvWidths for the fast-path table
        // This includes sidebearings and represents the true typographic advance.
        // Covers full extended ASCII range U+0020-U+00FF per XTF spec Section 4.
        if (isXtf && charCode >= 0x20 && charCode <= 0xFF) {
          (binary as XTEinkFontXTF).fontAdvWidths.set(charCode, baseAdvPx);
        }

        // Store advance width for XTF glyph prefix byte.
        // For ASCII/proportional (left-sided) chars, apply the user's ASCII advance offset.
        const asciiOff = (isXtf && options.xtfAsciiOffset && isLeftSided) ? options.xtfAsciiOffset : 0;
        glyphAdvWidths.set(charCode, baseAdvPx + asciiOff);
        const bitmap = glyph.bitmap;
        if (bitmap.imagedata) {
          const dyOffset = (ftMetrics.ascender + ftMetrics.descender) >> 7;

          tempCtx.putImageData(bitmap.imagedata, 0, 0);

          // For XTF ASCII: left-align glyphs (device advances by per-glyph width from left edge)
          // For bin and XTF non-ASCII: center glyphs in the fixed-width cell
          const dx = isLeftSided
            ? Math.round(glyph.bitmap_left)
            : Math.round(glyph.bitmap_left - adv / 2);
          const dy = Math.round(-(glyph.bitmap_top - dyOffset));
          ctx.drawImage(tempCanvas, 0, 0, bitmap.width, bitmap.rows, dx, dy, bitmap.width, bitmap.rows);
        } else if (isXtf) {
          // Glyph exists but has no bitmap (e.g., Space) — ensure it gets an entry
          (binary as XTEinkFontXTF).metrics.set(charCode, { width: Math.round(adv / S) });
          if (!binary.usedChars.has(charCode)) {
            binary.usedChars.set(charCode, new Uint8Array((binary as XTEinkFontXTF).glyphSize));
          }
        }
      } else {
        // Canvas fallback for glyphs not in FreeType (works for both XTF and bin)
        ctx.lineWidth = 0.5;
        ctx.strokeStyle = 'white';
        ctx.textAlign = isLeftSided ? 'left' : 'center';
        ctx.fillText(charStr, 0, 0);
        ctx.strokeText(charStr, 0, 0);
        if (isLeftSided) ctx.textAlign = 'center';
      }

      ctx.restore();
    }

    // Extract alpha channel and apply boldness morphological operation
    const batchImageData = ctx.getImageData(0, 0, batchCols * sW, batchRows * sH).data;
    const fullBytes = Math.floor(box.width / 8);
    const remainderBits = box.width & 7;
    const batchWidth = batchCols * sW;
    const batchHeight = batchRows * sH;
    const alphaBuffer = new Float32Array(batchWidth * batchHeight);
    for (let p = 0; p < alphaBuffer.length; p++) {
      alphaBuffer[p] = batchImageData[p * 4 + 3];
    }

    if (boldness !== 0) {
      // Morphological dilation (boldness > 0) or erosion (boldness < 0)
      // Uses a 3x3 kernel with fractional strength for smooth control
      const radius = 1;
      const strength = Math.abs(boldness);
      const isDilate = boldness > 0;
      const temp = new Float32Array(alphaBuffer.length);

      for (let py = 0; py < batchHeight; py++) {
        for (let px = 0; px < batchWidth; px++) {
          const idx = py * batchWidth + px;
          let extremeVal = isDilate ? 0 : 255;

          for (let dy = -radius; dy <= radius; dy++) {
            const ny = py + dy;
            if (ny < 0 || ny >= batchHeight) continue;
            for (let dx = -radius; dx <= radius; dx++) {
              const nx = px + dx;
              if (nx < 0 || nx >= batchWidth) continue;
              const nVal = alphaBuffer[ny * batchWidth + nx];
              if (isDilate) {
                if (nVal > extremeVal) extremeVal = nVal;
              } else {
                if (nVal < extremeVal) extremeVal = nVal;
              }
            }
          }

          // Blend between original and dilated/eroded based on strength
          temp[idx] = alphaBuffer[idx] + (extremeVal - alphaBuffer[idx]) * strength;
        }
      }

      // Copy back
      for (let p = 0; p < alphaBuffer.length; p++) {
        alphaBuffer[p] = temp[p];
      }
    }

    // Optimized extraction: byte-at-a-time packing with hoisted S branch
    if (S === 1) {
      // === Native resolution fast path (no supersampling) ===
      for (let j = 0; j < count; j++) {
        const charCode = fontOnlyCharCodes ? fontOnlyCharCodes[i + j] : (i + j);
        const col = j % batchCols;
        const row = Math.floor(j / batchCols);
        const baseX = col * sW;
        const baseY = row * sH;
        for (let y = 0; y < box.height; y++) {
          const rowIdx = (baseY + y) * batchWidth + baseX;

          if (isXtf) {
            const charStr = String.fromCharCode(charCode);
            const isLeftSided = checkIsLeftSided(charCode, charStr, options);
            for (let x = 0; x < box.width; x++) {
              const alpha = alphaBuffer[rowIdx + x];
              if (alpha > 10) {
                const v2bit = Math.min(3, Math.round(alpha / 85));
                const aw = isLeftSided ? (glyphAdvWidths.get(charCode) || box.width) : box.width;
                (binary as XTEinkFontXTF).setPixel2Bit(charCode, x, y, v2bit, aw);
              }
            }
          } else {
            const outRowOffset = (binary as XTEinkFontBinary).charByte * charCode + y * (binary as XTEinkFontBinary).widthByte;
            // Full 8-pixel bytes (no bounds check)
            for (let x8 = 0; x8 < fullBytes; x8++) {
              const base = rowIdx + x8 * 8;
              (binary as XTEinkFontBinary).fontbin[outRowOffset + x8] =
                ((alphaBuffer[base] >= alphaThreshold ? 0x80 : 0)) |
                ((alphaBuffer[base + 1] >= alphaThreshold ? 0x40 : 0)) |
                ((alphaBuffer[base + 2] >= alphaThreshold ? 0x20 : 0)) |
                ((alphaBuffer[base + 3] >= alphaThreshold ? 0x10 : 0)) |
                ((alphaBuffer[base + 4] >= alphaThreshold ? 0x08 : 0)) |
                ((alphaBuffer[base + 5] >= alphaThreshold ? 0x04 : 0)) |
                ((alphaBuffer[base + 6] >= alphaThreshold ? 0x02 : 0)) |
                ((alphaBuffer[base + 7] >= alphaThreshold ? 0x01 : 0));
            }

            // Remaining bits
            if (remainderBits > 0) {
              let byteVal = 0;
              const base = rowIdx + fullBytes * 8;
              for (let bit = 0; bit < remainderBits; bit++) {
                if (alphaBuffer[base + bit] >= alphaThreshold) {
                  byteVal |= (0x80 >>> bit);
                }
              }
              (binary as XTEinkFontBinary).fontbin[outRowOffset + fullBytes] = byteVal;
            }
          }
        }
      }
    } else {
      // === Supersampled path (S > 1) with boldness ===
      for (let j = 0; j < count; j++) {
        const charCode = fontOnlyCharCodes ? fontOnlyCharCodes[i + j] : (i + j);
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
              const x = (x8 << 3) + bit;
              if (x >= box.width) break;

              let alphaSum = 0;
              const syBase = baseY + y * S;
              const sxBase = baseX + x * S;
              for (let sy = 0; sy < S; sy++) {
                const rowStart = (syBase + sy) * batchWidth + sxBase;
                for (let sx = 0; sx < S; sx++) {
                  alphaSum += alphaBuffer[rowStart + sx];
                }
              }

              if (isXtf) {
                const avgAlpha = alphaSum / S2;
                if (avgAlpha > 10) {
                  const v2bit = Math.min(3, Math.round(avgAlpha / 85));
                  const charStr = String.fromCharCode(charCode);
                  const isLeftSided = checkIsLeftSided(charCode, charStr, options);
                  const aw = isLeftSided ? (glyphAdvWidths.get(charCode) || box.width) : box.width;
                  (binary as XTEinkFontXTF).setPixel2Bit(charCode, x, y, v2bit, aw);
                }
              } else if (alphaSum >= scaledThreshold) {
                (binary as XTEinkFontBinary).setPixel(charCode, x, y, true);
              }
            }
            if (!isXtf) {
              (binary as XTEinkFontBinary).fontbin[outRowOffset + x8] = byteVal;
            }
          }
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
  const buffer = isXtf ? (binary as XTEinkFontXTF).generateBuffer() : (binary as XTEinkFontBinary).fontbin.buffer as ArrayBuffer;
  return { buffer, name, cutoffCount: cutoffChars.length, cutoffChars };
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
  const fontSizePx = Math.round(options.fontSize);
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

  const drawnBoxes: { x: number, y: number, w: number, h: number, isCutoff: boolean }[] = [];
  const cutoffChars = new Set<string>();

  // Pre-allocate reusable temp canvas for FreeType bitmap blitting (avoids DOM allocation per char)
  const previewTempCanvas = document.createElement('canvas');
  const previewTempSize = Math.max(100, fontSizePx * 3);
  previewTempCanvas.width = previewTempSize;
  previewTempCanvas.height = previewTempSize;
  const previewTempCtx = previewTempCanvas.getContext('2d', { willReadFrequently: true })!;

  // Batch-preload all preview glyphs from FreeType to avoid double LoadGlyphs per character
  let previewGlyphMap: Map<number, any> | null = null;
  if (options.renderer === 'freetype' && options.freetypeFace && ftModule) {
    ftModule.SetFont(options.freetypeFace.family_name, options.freetypeFace.style_name);
    ftModule.SetPixelSize(0, fontSizePx);

    const previewLoadFlags = ftModule.FT_LOAD_RENDER |
      (options.format === 'xtf' ? ftModule.FT_LOAD_TARGET_NORMAL :
        options.hinting === 'None' ? ftModule.FT_LOAD_NO_HINTING :
          options.hinting === 'Slight' ? ftModule.FT_LOAD_TARGET_LIGHT :
            options.hinting === 'Medium' ? ftModule.FT_LOAD_TARGET_NORMAL :
              ftModule.FT_LOAD_TARGET_MONO) |
      (options.forceAutohint ? ftModule.FT_LOAD_FORCE_AUTOHINT : 0);

    const allCodes: number[] = [];
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        allCodes.push(line.charCodeAt(i));
      }
    }
    // Deduplicate
    const uniqueCodes = Array.from(new Set(allCodes));
    previewGlyphMap = ftModule.LoadGlyphs(uniqueCodes, previewLoadFlags);
  }

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

      const preloadedGlyph = previewGlyphMap ? previewGlyphMap.get(charStr.charCodeAt(0)) : null;
      const exceedsBounds = isCharCutoff(ctx, charStr, box, options, preloadedGlyph);
      if (exceedsBounds) {
        cutoffChars.add(charStr);
      }

      ctx.save();

      let tx, ty;
      const isLeftSided = checkIsLeftSided(charStr.charCodeAt(0), charStr, options);
      if (options.vertical) {
        tx = Math.round(currentX + charBoxH / 2 - options.yOffset);
        ty = isLeftSided
          ? Math.round(currentY + options.xOffset)
          : Math.round(currentY + charBoxW / 2 + options.xOffset);
      } else {
        tx = isLeftSided
          ? Math.round(currentX + options.xOffset)
          : Math.round(currentX + charBoxW / 2 + options.xOffset);
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

      if (previewGlyphMap && options.freetypeFace && ftModule) {
        ftModule.SetFont(options.freetypeFace.family_name, options.freetypeFace.style_name);
        const m = ftModule.SetPixelSize(0, fontSizePx);

        const glyph = previewGlyphMap.get(charStr.charCodeAt(0));

        if (glyph && glyph.glyph_index !== 0) {
          const bitmap = glyph.bitmap;
          if (bitmap.imagedata) {
            const adv = (glyph.advance.x >> 6);
            const dyOffset = (m.ascender + m.descender) >> 7;

            // Reuse pre-allocated temp canvas (resize only if needed)
            if (previewTempCanvas.width < bitmap.width || previewTempCanvas.height < bitmap.rows) {
              previewTempCanvas.width = bitmap.width;
              previewTempCanvas.height = bitmap.rows;
            }
            previewTempCtx.putImageData(bitmap.imagedata, 0, 0);

            const dx = isLeftSided
              ? Math.round(glyph.bitmap_left)
              : Math.round(glyph.bitmap_left - adv / 2);
            const dy = Math.round(-(glyph.bitmap_top - dyOffset));
            ctx.drawImage(previewTempCanvas, 0, 0, bitmap.width, bitmap.rows, dx, dy, bitmap.width, bitmap.rows);
          }
        } else {
          // Fallback
          ctx.lineWidth = 0.5;
          ctx.strokeStyle = 'black';
          if (isLeftSided) ctx.textAlign = 'left';
          ctx.fillText(charStr, 0, 0);
          ctx.strokeText(charStr, 0, 0);
          if (isLeftSided) ctx.textAlign = 'center';
        }
      } else {
        // Fallback
        ctx.lineWidth = 0.5;
        ctx.strokeStyle = 'black';
        if (isLeftSided) ctx.textAlign = 'left';
        ctx.fillText(charStr, 0, 0);
        ctx.strokeText(charStr, 0, 0);
        if (isLeftSided) ctx.textAlign = 'center';
      }

      ctx.restore();

      if (options.vertical) {
        drawnBoxes.push({ x: currentX, y: currentY, w: charBoxH, h: charBoxW, isCutoff: exceedsBounds });
      } else {
        drawnBoxes.push({ x: currentX, y: currentY, w: charBoxW, h: charBoxH, isCutoff: exceedsBounds });
      }

      // Advance cursor
      let aw = charBoxW;
      if (isLeftSided) {
        if (preloadedGlyph && preloadedGlyph.glyph_index !== 0) {
          aw = (preloadedGlyph.advance.x >> 6);
        } else {
          const metrics = ctx.measureText(charStr);
          aw = Math.round(metrics.width);
        }
        // Apply ASCII advance offset for preview consistency
        if (options.format === 'xtf' && options.xtfAsciiOffset) {
          aw += options.xtfAsciiOffset;
        }
      }

      if (options.vertical) {
        currentY += aw;
      } else {
        currentX += aw;
      }
    }
  }

  // Apply boldness morphological operation on the preview alpha channel
  const osImageData = ctx.getImageData(0, 0, osCanvas.width, osCanvas.height);
  const data = osImageData.data;

  const prevBoldness = (options.threshold - 400) / 500;
  const prevS2 = S * S;
  const prevAlphaThreshold = 128; // Fixed after boldness

  // Extract alpha into float buffer for morphological processing
  const osW = osCanvas.width;
  const osH = osCanvas.height;
  const prevAlpha = new Float32Array(osW * osH);
  for (let p = 0; p < prevAlpha.length; p++) {
    prevAlpha[p] = data[p * 4 + 3];
  }

  if (prevBoldness !== 0) {
    const radius = 1;
    const strength = Math.abs(prevBoldness);
    const isDilate = prevBoldness > 0;
    const temp = new Float32Array(prevAlpha.length);

    for (let py = 0; py < osH; py++) {
      for (let px = 0; px < osW; px++) {
        const idx = py * osW + px;
        let extremeVal = isDilate ? 0 : 255;

        for (let dy = -radius; dy <= radius; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= osH) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = px + dx;
            if (nx < 0 || nx >= osW) continue;
            const nVal = prevAlpha[ny * osW + nx];
            if (isDilate) {
              if (nVal > extremeVal) extremeVal = nVal;
            } else {
              if (nVal < extremeVal) extremeVal = nVal;
            }
          }
        }

        temp[idx] = prevAlpha[idx] + (extremeVal - prevAlpha[idx]) * strength;
      }
    }

    for (let p = 0; p < prevAlpha.length; p++) {
      prevAlpha[p] = temp[p];
    }
  }

  const finalImageData = finalCtx.createImageData(SCREEN_W, SCREEN_H);
  const outData = finalImageData.data;

  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      let alphaSum = 0;
      if (S === 1) {
        alphaSum = prevAlpha[y * SCREEN_W + x];
      } else {
        for (let sy = 0; sy < S; sy++) {
          const rowStart = (y * S + sy) * osW + x * S;
          for (let sx = 0; sx < S; sx++) {
            alphaSum += prevAlpha[rowStart + sx];
          }
        }
      }

      const outIdx = (y * SCREEN_W + x) * 4;
      if (options.format === 'xtf') {
        const avgAlpha = alphaSum / prevS2;
        if (avgAlpha > 10) {
          const v2bit = Math.min(3, Math.round(avgAlpha / 85));
          const color = Math.max(0, 255 - (v2bit * 85));
          outData[outIdx] = color;
          outData[outIdx + 1] = color;
          outData[outIdx + 2] = color;
          outData[outIdx + 3] = 255;
        } else {
          outData[outIdx] = 255;
          outData[outIdx + 1] = 255;
          outData[outIdx + 2] = 255;
          outData[outIdx + 3] = 255;
        }
      } else {
        const scaledThresholdPrev = prevAlphaThreshold * prevS2;
        if (alphaSum >= scaledThresholdPrev) {
          outData[outIdx] = 0;
          outData[outIdx + 1] = 0;
          outData[outIdx + 2] = 0;
          outData[outIdx + 3] = 255;
        } else {
          outData[outIdx] = 255;
          outData[outIdx + 1] = 255;
          outData[outIdx + 2] = 255;
          outData[outIdx + 3] = 255;
        }
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

  const fontSizePx = options.fontSize;
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

  if (options.vertical && options.format !== 'xtf') {
    // .bin vertical mode: Square Box Padding uses uniform constraints
    const maxPad = Math.max(charSpacing, lineSpacing);
    return { charSpacing: maxPad, lineSpacing: maxPad };
  }

  return { charSpacing, lineSpacing };
}

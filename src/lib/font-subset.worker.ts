/**
 * Web Worker for font subsetting using opentype.js.
 * 
 * Offloads the CPU-intensive font parsing and glyph extraction from the main thread.
 * Each worker receives the full font buffer once (cached), then processes subset
 * requests for different character chunks. For CJK fonts (10-20MB), this prevents
 * main-thread jank during the ~64 chunk iterations.
 */
import * as opentype from 'opentype.js';

interface SubsetRequest {
  type: 'subset';
  id: number;
  fontBuffer: ArrayBuffer;
  characters: string;
  nameSuffix: string;
  // If true, the worker should cache the parsed font for reuse
  cacheFont: boolean;
}

interface SubsetResponse {
  type: 'subset-result';
  id: number;
  buffer: ArrayBuffer | null;
  error?: string;
}

interface PreparseRequest {
  type: 'preparse';
  id: number;
  fontBuffer: ArrayBuffer;
}

interface PreparseResponse {
  type: 'preparse-result';
  id: number;
  glyphCount: number;
  // Array of all unicode codepoints present in the font
  unicodes: number[];
  error?: string;
}

let cachedFont: opentype.Font | null = null;
let cachedBufferHash: number = 0;

// Simple hash for buffer identity check
function bufferHash(buf: ArrayBuffer): number {
  const view = new Uint8Array(buf);
  let hash = 0;
  // Sample first 1024 bytes + length for fast identity
  const len = Math.min(view.length, 1024);
  for (let i = 0; i < len; i++) {
    hash = ((hash << 5) - hash + view[i]) | 0;
  }
  return hash ^ view.length;
}

function getParsedFont(buffer: ArrayBuffer): opentype.Font {
  const hash = bufferHash(buffer);
  if (cachedFont && cachedBufferHash === hash) {
    return cachedFont;
  }
  cachedFont = opentype.parse(buffer);
  cachedBufferHash = hash;
  return cachedFont;
}

function subsetFont(buffer: ArrayBuffer, characters: string, nameSuffix: string, parsedFont: opentype.Font): ArrayBuffer {
  const font = parsedFont;
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
}

self.onmessage = (e: MessageEvent<SubsetRequest | PreparseRequest>) => {
  const msg = e.data;

  if (msg.type === 'preparse') {
    try {
      const font = getParsedFont(msg.fontBuffer);
      const unicodes: number[] = [];
      for (let gi = 0; gi < font.glyphs.length; gi++) {
        const g = font.glyphs.get(gi);
        if (g && g.unicodes) {
          for (const u of g.unicodes) {
            if (u >= 0 && u < 0x10000) unicodes.push(u);
          }
        }
      }
      const resp: PreparseResponse = {
        type: 'preparse-result',
        id: msg.id,
        glyphCount: font.glyphs.length,
        unicodes
      };
      self.postMessage(resp);
    } catch (err: any) {
      const resp: PreparseResponse = {
        type: 'preparse-result',
        id: msg.id,
        glyphCount: 0,
        unicodes: [],
        error: err?.message || String(err)
      };
      self.postMessage(resp);
    }
    return;
  }

  if (msg.type === 'subset') {
    try {
      const font = getParsedFont(msg.fontBuffer);
      const result = subsetFont(msg.fontBuffer, msg.characters, msg.nameSuffix, font);
      const resp: SubsetResponse = {
        type: 'subset-result',
        id: msg.id,
        buffer: result
      };
      // Transfer the buffer to avoid copy overhead
      self.postMessage(resp, [result]);
    } catch (err: any) {
      const resp: SubsetResponse = {
        type: 'subset-result',
        id: msg.id,
        buffer: null,
        error: err?.message || String(err)
      };
      self.postMessage(resp);
    }
    return;
  }
};

// XTC format generation for XTEink X4 e-reader

import type { BookMetadata, TocEntry } from './metadata/types';
import { runWasmPack, isWasmLoaded } from './processing/wasm';

interface ProcessedPage {
  name: string;
  canvas: HTMLCanvasElement;
  is2bit?: boolean;
}

interface XtcBuildOptions {
  metadata?: BookMetadata;
  is2bit?: boolean;
  useWasm?: boolean;
}

// XTC format constants (based on reference file analysis)
// Header: 48 bytes base + 8 bytes TOC offset pointer = 56 bytes total
const HEADER_BASE_SIZE = 48;
const TOC_OFFSET_PTR_SIZE = 8;
const HEADER_WITH_METADATA_SIZE = HEADER_BASE_SIZE + TOC_OFFSET_PTR_SIZE;  // 56 bytes
const INDEX_ENTRY_SIZE = 16;
const TITLE_SIZE = 128;
const AUTHOR_SIZE = 64;
const PUBLISHER_SIZE = 32;
const LANGUAGE_SIZE = 16;
const TOC_HEADER_SIZE = 16;
const TOC_ENTRY_SIZE = 96;
const TOC_TITLE_SIZE = 80;

// Flags for metadata presence: 0x01000100 with extra byte at 0x0C = 0x01
const FLAG_HAS_METADATA_LOW = 0x01000100;
const FLAG_HAS_METADATA_HIGH = 0x00000001;

export interface StreamPageInfo {
  width: number;
  height: number;
}

export function buildXtcHeaderAndIndex(
  pages: StreamPageInfo[],
  options: XtcBuildOptions = {}
): Uint8Array {
  const is2bit = options.is2bit || false;
  const pageCount = pages.length;
  const hasMetadata = options.metadata && (
    options.metadata.title ||
    options.metadata.author ||
    options.metadata.publisher ||
    options.metadata.language ||
    (options.metadata.toc && options.metadata.toc.length > 0)
  );

  let metadataSize = 0;
  let tocEntriesOffset = 0;

  if (hasMetadata) {
    metadataSize = TITLE_SIZE + AUTHOR_SIZE + PUBLISHER_SIZE + LANGUAGE_SIZE + TOC_HEADER_SIZE;
    if (options.metadata!.toc.length > 0) {
      metadataSize += options.metadata!.toc.length * TOC_ENTRY_SIZE;
    }
    tocEntriesOffset = HEADER_WITH_METADATA_SIZE + TITLE_SIZE + AUTHOR_SIZE + PUBLISHER_SIZE + LANGUAGE_SIZE + TOC_HEADER_SIZE;
  }

  const headerSize = hasMetadata ? HEADER_WITH_METADATA_SIZE : HEADER_BASE_SIZE;
  const metadataOffset = hasMetadata ? HEADER_WITH_METADATA_SIZE : 0;
  const indexOffset = headerSize + metadataSize;
  const dataOffset = indexOffset + (pageCount * INDEX_ENTRY_SIZE);

  const headerAndIndexBuffer = new ArrayBuffer(dataOffset);
  const view = new DataView(headerAndIndexBuffer);
  const uint8 = new Uint8Array(headerAndIndexBuffer);

  if (is2bit) {
    uint8[0] = 0x58; uint8[1] = 0x54; uint8[2] = 0x43; uint8[3] = 0x48; // XTCH
  } else {
    uint8[0] = 0x58; uint8[1] = 0x54; uint8[2] = 0x43; uint8[3] = 0x00; // XTC\0
  }
  view.setUint16(4, 1, true);
  view.setUint16(6, pageCount, true);

  if (hasMetadata) {
    view.setUint32(8, FLAG_HAS_METADATA_LOW, true);
    view.setUint32(12, FLAG_HAS_METADATA_HIGH, true);
  } else {
    view.setUint32(8, 0, true);
    view.setUint32(12, 0, true);
  }

  setBigUint64(view, 16, BigInt(metadataOffset));
  setBigUint64(view, 24, BigInt(indexOffset));
  setBigUint64(view, 32, BigInt(dataOffset));
  setBigUint64(view, 40, 0n);

  if (hasMetadata) {
    setBigUint64(view, 48, BigInt(tocEntriesOffset));
  }

  if (hasMetadata && options.metadata) {
    writeMetadata(uint8, view, HEADER_WITH_METADATA_SIZE, options.metadata);
  }

  let relOffset = dataOffset;
  for (let i = 0; i < pageCount; i++) {
    const page = pages[i];
    const entryOffset = indexOffset + i * INDEX_ENTRY_SIZE;
    const pageSize = getXtcPageSize(page.width, page.height, is2bit);

    setBigUint64(view, entryOffset, BigInt(relOffset));
    view.setUint32(entryOffset + 8, pageSize, true);
    view.setUint16(entryOffset + 12, page.width, true);
    view.setUint16(entryOffset + 14, page.height, true);

    relOffset += pageSize;
  }

  return uint8;
}

export function getXtcPageSize(width: number, height: number, is2bit: boolean): number {
  if (is2bit) {
    const colBytes = Math.ceil(height / 8);
    const planeSize = colBytes * width;
    return 22 + (planeSize * 2);
  } else {
    const rowBytes = Math.ceil(width / 8);
    return 22 + (rowBytes * height);
  }
}

export async function buildXtcFromBuffers(
  xtgBlobs: ArrayBuffer[],
  options: XtcBuildOptions = {}
): Promise<ArrayBuffer> {
  const is2bit = options.is2bit || false;
  const pageCount = xtgBlobs.length;
  const hasMetadata = options.metadata && (
    options.metadata.title ||
    options.metadata.author ||
    options.metadata.publisher ||
    options.metadata.language ||
    (options.metadata.toc && options.metadata.toc.length > 0)
  );

  let metadataSize = 0;
  let tocEntriesOffset = 0;

  if (hasMetadata) {
    metadataSize = TITLE_SIZE + AUTHOR_SIZE + PUBLISHER_SIZE + LANGUAGE_SIZE + TOC_HEADER_SIZE;
    if (options.metadata!.toc.length > 0) {
      metadataSize += options.metadata!.toc.length * TOC_ENTRY_SIZE;
    }
    tocEntriesOffset = HEADER_WITH_METADATA_SIZE + TITLE_SIZE + AUTHOR_SIZE + PUBLISHER_SIZE + LANGUAGE_SIZE + TOC_HEADER_SIZE;
  }

  const headerSize = hasMetadata ? HEADER_WITH_METADATA_SIZE : HEADER_BASE_SIZE;
  const metadataOffset = hasMetadata ? HEADER_WITH_METADATA_SIZE : 0;
  const indexOffset = headerSize + metadataSize;
  const dataOffset = indexOffset + (pageCount * INDEX_ENTRY_SIZE);

  let totalSize = dataOffset;
  for (const blob of xtgBlobs) {
    totalSize += blob.byteLength;
  }

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  if (is2bit) {
    uint8[0] = 0x58; uint8[1] = 0x54; uint8[2] = 0x43; uint8[3] = 0x48; // XTCH
  } else {
    uint8[0] = 0x58; uint8[1] = 0x54; uint8[2] = 0x43; uint8[3] = 0x00; // XTC\0
  }
  view.setUint16(4, 1, true);
  view.setUint16(6, pageCount, true);

  if (hasMetadata) {
    view.setUint32(8, FLAG_HAS_METADATA_LOW, true);
    view.setUint32(12, FLAG_HAS_METADATA_HIGH, true);
  } else {
    view.setUint32(8, 0, true);
    view.setUint32(12, 0, true);
  }

  setBigUint64(view, 16, BigInt(metadataOffset));
  setBigUint64(view, 24, BigInt(indexOffset));
  setBigUint64(view, 32, BigInt(dataOffset));
  setBigUint64(view, 40, 0n);

  if (hasMetadata) {
    setBigUint64(view, 48, BigInt(tocEntriesOffset));
  }

  if (hasMetadata && options.metadata) {
    writeMetadata(uint8, view, HEADER_WITH_METADATA_SIZE, options.metadata);
  }

  let relOffset = dataOffset;
  for (let i = 0; i < pageCount; i++) {
    const blob = xtgBlobs[i];
    const blobView = new DataView(blob);
    // XTG/XTH header is 22 bytes. Width is at 4, Height is at 6.
    const w = blobView.getUint16(4, true);
    const h = blobView.getUint16(6, true);

    const entryOffset = indexOffset + i * INDEX_ENTRY_SIZE;

    setBigUint64(view, entryOffset, BigInt(relOffset));
    view.setUint32(entryOffset + 8, blob.byteLength, true);
    view.setUint16(entryOffset + 12, w, true);
    view.setUint16(entryOffset + 14, h, true);

    relOffset += blob.byteLength;
  }

  let writeOffset = dataOffset;
  for (const blob of xtgBlobs) {
    uint8.set(new Uint8Array(blob), writeOffset);
    writeOffset += blob.byteLength;
  }

  return buffer;
}

/**
 * Build XTC file from processed pages
 */
export async function buildXtc(
  pages: ProcessedPage[],
  options: XtcBuildOptions = {}
): Promise<ArrayBuffer> {
  const is2bit = options.is2bit || false;
  const useWasm = options.useWasm && isWasmLoaded();
  
  const xtgBlobs = pages.map(page => {
    const imageData = page.canvas.getContext('2d')!.getImageData(0, 0, page.canvas.width, page.canvas.height);
    if (useWasm) {
      const rawData = runWasmPack(imageData, is2bit);
      return wrapWasmData(rawData, page.canvas.width, page.canvas.height, is2bit);
    }
    return is2bit ? imageDataToXth(imageData) : imageDataToXtg(imageData);
  });

  const pageCount = xtgBlobs.length;
  const hasMetadata = options.metadata && (
    options.metadata.title ||
    options.metadata.author ||
    options.metadata.publisher ||
    options.metadata.language ||
    options.metadata.toc.length > 0
  );

  // Calculate metadata section size
  let metadataSize = 0;
  let tocEntriesOffset = 0;

  if (hasMetadata) {
    // Structure: Header(56) + Title(128) + Author(64) + Publisher(32) + Language(16) + TOC Header(16) + TOC Entries(N*96)
    metadataSize = TITLE_SIZE + AUTHOR_SIZE + PUBLISHER_SIZE + LANGUAGE_SIZE + TOC_HEADER_SIZE;
    if (options.metadata!.toc.length > 0) {
      metadataSize += options.metadata!.toc.length * TOC_ENTRY_SIZE;
    }
    // TOC entries start after header + title + author + publisher + language + toc header
    tocEntriesOffset = HEADER_WITH_METADATA_SIZE + TITLE_SIZE + AUTHOR_SIZE + PUBLISHER_SIZE + LANGUAGE_SIZE + TOC_HEADER_SIZE;
  }

  // Calculate offsets
  const headerSize = hasMetadata ? HEADER_WITH_METADATA_SIZE : HEADER_BASE_SIZE;
  const metadataOffset = hasMetadata ? HEADER_WITH_METADATA_SIZE : 0;  // Points to title start
  const indexOffset = headerSize + metadataSize;
  const dataOffset = indexOffset + (pageCount * INDEX_ENTRY_SIZE);

  let totalSize = dataOffset;
  for (const blob of xtgBlobs) {
    totalSize += blob.byteLength;
  }

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  // Header: XTC magic number
  if (is2bit) {
    uint8[0] = 0x58; uint8[1] = 0x54; uint8[2] = 0x43; uint8[3] = 0x48; // XTCH
  } else {
    uint8[0] = 0x58; uint8[1] = 0x54; uint8[2] = 0x43; uint8[3] = 0x00; // XTC\0
  }
  view.setUint16(4, 1, true); // version
  view.setUint16(6, pageCount, true);

  // Flags
  if (hasMetadata) {
    view.setUint32(8, FLAG_HAS_METADATA_LOW, true);
    view.setUint32(12, FLAG_HAS_METADATA_HIGH, true);
  } else {
    view.setUint32(8, 0, true);
    view.setUint32(12, 0, true);
  }

  // Offsets (8 bytes each, little-endian)
  setBigUint64(view, 16, BigInt(metadataOffset));  // 0x10: Metadata offset (title start)
  setBigUint64(view, 24, BigInt(indexOffset));     // 0x18: Index offset
  setBigUint64(view, 32, BigInt(dataOffset));      // 0x20: Data offset
  setBigUint64(view, 40, 0n);                      // 0x28: Reserved

  // Write TOC entries offset at 0x30 (only when metadata present)
  if (hasMetadata) {
    setBigUint64(view, 48, BigInt(tocEntriesOffset));  // 0x30: TOC entries offset
  }

  // Write metadata section if present
  if (hasMetadata && options.metadata) {
    writeMetadata(uint8, view, HEADER_WITH_METADATA_SIZE, options.metadata);
  }

  // Write index entries
  let relOffset = dataOffset;
  for (let i = 0; i < pageCount; i++) {
    const blob = xtgBlobs[i];
    const page = pages[i];
    const entryOffset = indexOffset + i * INDEX_ENTRY_SIZE;

    setBigUint64(view, entryOffset, BigInt(relOffset));
    view.setUint32(entryOffset + 8, blob.byteLength, true);
    view.setUint16(entryOffset + 12, page.canvas.width, true);
    view.setUint16(entryOffset + 14, page.canvas.height, true);

    relOffset += blob.byteLength;
  }

  // Write page data
  let writeOffset = dataOffset
  for (const blob of xtgBlobs) {
    uint8.set(new Uint8Array(blob), writeOffset);
    writeOffset += blob.byteLength;
  }

  return buffer;
}

/**
 * Write metadata section (title, author, TOC header, TOC entries)
 */
function writeMetadata(
  uint8: Uint8Array,
  view: DataView,
  offset: number,
  metadata: BookMetadata
): void {
  const encoder = new TextEncoder();
  let currentOffset = offset;

  // Write title (128 bytes, null-terminated)
  if (metadata.title) {
    const titleBytes = encoder.encode(metadata.title);
    const titleLen = Math.min(titleBytes.length, TITLE_SIZE - 1);
    uint8.set(titleBytes.subarray(0, titleLen), currentOffset);
  }
  currentOffset += TITLE_SIZE;

  // Write author (64 bytes, null-terminated)
  if (metadata.author) {
    const authorBytes = encoder.encode(metadata.author);
    const authorLen = Math.min(authorBytes.length, AUTHOR_SIZE - 1);
    uint8.set(authorBytes.subarray(0, authorLen), currentOffset);
  }
  currentOffset += AUTHOR_SIZE;

  // Write publisher (32 bytes, null-terminated)
  if (metadata.publisher) {
    const pubBytes = encoder.encode(metadata.publisher);
    const pubLen = Math.min(pubBytes.length, PUBLISHER_SIZE - 1);
    uint8.set(pubBytes.subarray(0, pubLen), currentOffset);
  }
  currentOffset += PUBLISHER_SIZE;

  // Write language (16 bytes, null-terminated)
  if (metadata.language) {
    const langBytes = encoder.encode(metadata.language);
    const langLen = Math.min(langBytes.length, LANGUAGE_SIZE - 1);
    uint8.set(langBytes.subarray(0, langLen), currentOffset);
  }
  currentOffset += LANGUAGE_SIZE;

  // Write TOC header (16 bytes)
  writeTocHeader(view, currentOffset, metadata.toc.length, metadata.coverPage, metadata.createTime);
  currentOffset += TOC_HEADER_SIZE;

  // Write TOC entries
  if (metadata.toc.length > 0) {
    writeTocEntries(uint8, view, currentOffset, metadata.toc);
  }
}

/**
 * Write TOC header (16 bytes)
 */
function writeTocHeader(view: DataView, offset: number, chapterCount: number, coverPage?: number, createTime?: number): void {
  // Structure (based on user request):
  // - 0x00 (4 bytes): createTime (Unix timestamp)
  // - 0x04 (2 bytes): coverPage (0-based, 0xFFFF=none)
  // - 0x06 (2 bytes): chapterCount
  // - 0x08 (8 bytes): padding/reserved
  const timestamp = createTime || Math.floor(Date.now() / 1000);
  view.setUint32(offset, timestamp, true);
  view.setUint16(offset + 4, coverPage !== undefined ? coverPage : 0xFFFF, true);
  view.setUint16(offset + 6, chapterCount, true);
}

/**
 * Write TOC entries (96 bytes each)
 */
function writeTocEntries(
  uint8: Uint8Array,
  view: DataView,
  offset: number,
  toc: TocEntry[]
): void {
  const encoder = new TextEncoder();
  let entryOffset = offset;

  for (const entry of toc) {
    // Title (80 bytes, null-terminated)
    const titleBytes = encoder.encode(entry.title);
    const titleLen = Math.min(titleBytes.length, TOC_TITLE_SIZE - 1);
    uint8.set(titleBytes.subarray(0, titleLen), entryOffset);

    // Start page (2 bytes, 1-indexed)
    view.setUint16(entryOffset + TOC_TITLE_SIZE, entry.startPage, true);

    // End page (2 bytes)
    view.setUint16(entryOffset + TOC_TITLE_SIZE + 2, entry.endPage, true);

    // Rest is padding (12 bytes, already zero)

    entryOffset += TOC_ENTRY_SIZE;
  }
}

/**
 * Convert ImageData to XTG format (XTEink Graphics)
 */
export function imageDataToXtg(imageData: ImageData): ArrayBuffer {
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;

  const rowBytes = Math.ceil(w / 8);
  const pixelData = new Uint8Array(rowBytes * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const bit = data[idx] >= 128 ? 1 : 0;
      const byteIndex = y * rowBytes + Math.floor(x / 8);
      const bitIndex = 7 - (x % 8);
      if (bit) {
        pixelData[byteIndex] |= 1 << bitIndex;
      }
    }
  }

  // Create MD5-like digest (simplified)
  const md5digest = new Uint8Array(8);
  for (let i = 0; i < Math.min(8, pixelData.length); i++) {
    md5digest[i] = pixelData[i];
  }

  const headerSize = 22;
  const totalSize = headerSize + pixelData.length;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  // XTG header
  uint8[0] = 0x58; uint8[1] = 0x54; uint8[2] = 0x47; uint8[3] = 0x00;
  view.setUint16(4, w, true);
  view.setUint16(6, h, true);
  view.setUint8(8, 0);
  view.setUint8(9, 0);
  view.setUint32(10, pixelData.length, true);
  uint8.set(md5digest, 14);

  uint8.set(pixelData, headerSize);

  return buffer;
}

/**
 * Helper to set 64-bit unsigned integer (little-endian)
 */
function setBigUint64(view: DataView, offset: number, value: bigint): void {
  const low = Number(value & 0xFFFFFFFFn);
  const high = Number(value >> 32n);
  view.setUint32(offset, low, true);
  view.setUint32(offset + 4, high, true);
}

/**
 * Convert ImageData to XTH format (2-bit Planar, Vertical Scan, R-to-L)
 */
export function imageDataToXth(imageData: ImageData): ArrayBuffer {
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;

  const colBytes = Math.ceil(h / 8);
  const planeSize = colBytes * w;
  const p0 = new Uint8Array(planeSize);
  const p1 = new Uint8Array(planeSize);

  for (let x = 0; x < w; x++) {
    const targetCol = w - 1 - x; // Right to Left
    const colOffset = targetCol * colBytes;
    for (let y = 0; y < h; y++) {
      const idx = (y * w + x) * 4;
      const gray = data[idx]; // ImageData is already grayscale if pre-processed
      
      let val;
      if (gray >= 212) val = 0;      // White (00)
      else if (gray >= 127) val = 1; // Light Gray (01)
      else if (gray >= 42) val = 2;  // Dark Gray (10)
      else val = 3;               // Black (11)

      const byteIdx = colOffset + (y >> 3);
      const bitIdx = 7 - (y % 8);
      
      if (val & 1) p0[byteIdx] |= (1 << bitIdx);
      if (val & 2) p1[byteIdx] |= (1 << bitIdx);
    }
  }

  const headerSize = 22;
  const totalSize = headerSize + (planeSize * 2);
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  // XTH header
  uint8[0] = 0x58; uint8[1] = 0x54; uint8[2] = 0x48; uint8[3] = 0x00;
  view.setUint16(4, w, true);
  view.setUint16(6, h, true);
  view.setUint8(8, 0);
  view.setUint8(9, 0);
  view.setUint32(10, planeSize * 2, true);
  
  // Simple digest
  for (let i = 0; i < 8; i++) uint8[14 + i] = p0[i] ^ p1[i];

  uint8.set(p0, headerSize);
  uint8.set(p1, headerSize + planeSize);

  return buffer;
}

/**
 * Wrap raw Wasm packed data with XTC chunk header
 */
export function wrapWasmData(pixelData: Uint8Array, w: number, h: number, is2bit: boolean): ArrayBuffer {
  // Create MD5-like digest
  const md5digest = new Uint8Array(8);
  for (let i = 0; i < Math.min(8, pixelData.length); i++) {
    md5digest[i] = pixelData[i];
  }

  const headerSize = 22;
  const totalSize = headerSize + pixelData.length;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  // Header
  if (is2bit) {
    uint8[0] = 0x58; uint8[1] = 0x54; uint8[2] = 0x48; uint8[3] = 0x00; // XTH
  } else {
    uint8[0] = 0x58; uint8[1] = 0x54; uint8[2] = 0x47; uint8[3] = 0x00; // XTG
  }
  
  view.setUint16(4, w, true);
  view.setUint16(6, h, true);
  view.setUint8(8, 0);
  view.setUint8(9, 0);
  view.setUint32(10, pixelData.length, true);
  uint8.set(md5digest, 14);

  uint8.set(pixelData, headerSize);

  return buffer;
}

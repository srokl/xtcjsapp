#!/usr/bin/env node

/**
 * XTC/XTCH High-Performance Converter for XTEink X4
 * Optimized for performance using TypedArrays and minimal allocations.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Constants
const DEVICE_DIMENSIONS = {
  X4: { width: 480, height: 800 },
  X3: { width: 528, height: 792 }
};

let targetWidth = DEVICE_DIMENSIONS.X4.width;
let targetHeight = DEVICE_DIMENSIONS.X4.height;

/**
 * Atkinson Dithering
 * Optimized single-pass implementation using TypedArrays.
 * @param {Uint8ClampedArray} pixels - Grayscale pixels (L)
 * @param {number} width 
 * @param {number} height 
 * @param {boolean} is2bit - If true, dither to 4 levels (0, 85, 170, 255)
 */
function ditherAtkinson(pixels, width, height, is2bit = false) {
  // Use Float32Array to preserve fractional error precision
  const data = new Float32Array(pixels);
  const stride = width;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * stride + x;
      const oldVal = data[idx];
      let newVal;

      if (is2bit) {
        if (oldVal < 42) newVal = 0;
        else if (oldVal < 127) newVal = 85;
        else if (oldVal < 212) newVal = 170;
        else newVal = 255;
      } else {
        newVal = oldVal < 128 ? 0 : 255;
      }

      data[idx] = newVal;
      const err = (oldVal - newVal) >> 3; // Atkinson uses 1/8 error distribution

      if (err === 0) continue;

      // Atkinson Kernel
      if (x + 1 < width) data[idx + 1] += err;
      if (x + 2 < width) data[idx + 2] += err;
      if (y + 1 < height) {
        if (x > 0) data[idx + stride - 1] += err;
        data[idx + stride] += err;
        if (x + 1 < width) data[idx + stride + 1] += err;
      }
      if (y + 2 < height) {
        data[idx + (stride << 1)] += err;
      }
    }
  }

  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.max(0, Math.min(255, data[i]));
  }
}

/**
 * Floyd-Steinberg Dithering
 */
function ditherFloydSteinberg(pixels, width, height, is2bit = false) {
  // Use Float32Array to preserve fractional error precision
  const data = new Float32Array(pixels);
  const stride = width;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * stride + x;
      const oldVal = data[idx];
      let newVal;

      if (is2bit) {
        if (oldVal < 42) newVal = 0;
        else if (oldVal < 127) newVal = 85;
        else if (oldVal < 212) newVal = 170;
        else newVal = 255;
      } else {
        newVal = oldVal < 128 ? 0 : 255;
      }

      data[idx] = newVal;
      const err = oldVal - newVal;

      if (x + 1 < width) data[idx + 1] += (err * 7) >> 4;
      if (y + 1 < height) {
        if (x > 0) data[idx + stride - 1] += (err * 3) >> 4;
        data[idx + stride] += (err * 5) >> 4;
        if (x + 1 < width) data[idx + stride + 1] += (err * 1) >> 4;
      }
    }
  }

  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.max(0, Math.min(255, data[i]));
  }
}

/**
 * Stucki Dithering (High Quality)
 */
function ditherStucki(pixels, width, height, is2bit = false) {
  // Use Float32Array to preserve fractional error precision
  const data = new Float32Array(pixels);
  const stride = width;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * stride + x;
      const oldVal = data[idx];
      let newVal;

      if (is2bit) {
        if (oldVal < 42) newVal = 0;
        else if (oldVal < 127) newVal = 85;
        else if (oldVal < 212) newVal = 170;
        else newVal = 255;
      } else {
        newVal = oldVal < 128 ? 0 : 255;
      }

      data[idx] = newVal;
      const err = oldVal - newVal;

      if (err !== 0) {
        // Row 1
        if (x + 1 < width) data[idx + 1] += (err * 8) / 42;
        if (x + 2 < width) data[idx + 2] += (err * 4) / 42;
        
        // Row 2
        if (y + 1 < height) {
          if (x - 2 >= 0) data[idx + stride - 2] += (err * 2) / 42;
          if (x - 1 >= 0) data[idx + stride - 1] += (err * 4) / 42;
          data[idx + stride] += (err * 8) / 42;
          if (x + 1 < width) data[idx + stride + 1] += (err * 4) / 42;
          if (x + 2 < width) data[idx + stride + 2] += (err * 2) / 42;
        }

        // Row 3
        if (y + 2 < height) {
          if (x - 2 >= 0) data[idx + (stride * 2) - 2] += (err * 1) / 42;
          if (x - 1 >= 0) data[idx + (stride * 2) - 1] += (err * 2) / 42;
          data[idx + (stride * 2)] += (err * 4) / 42;
          if (x + 1 < width) data[idx + (stride * 2) + 1] += (err * 2) / 42;
          if (x + 2 < width) data[idx + (stride * 2) + 2] += (err * 1) / 42;
        }
      }
    }
  }

  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.max(0, Math.min(255, data[i]));
  }
}

/**
 * Ostromoukhov Variable-Coefficient Dithering
 */
function ditherOstromoukhov(pixels, width, height, is2bit = false) {
  const data = new Float32Array(pixels);
  const stride = width;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * stride + x;
      const oldVal = data[idx];
      let newVal;

      if (is2bit) {
        if (oldVal < 42) newVal = 0;
        else if (oldVal < 127) newVal = 85;
        else if (oldVal < 212) newVal = 170;
        else newVal = 255;
      } else {
        newVal = oldVal < 128 ? 0 : 255;
      }

      data[idx] = newVal;
      const err = oldVal - newVal;

      if (err !== 0) {
        let v = Math.min(255, Math.max(0, oldVal));
        let d1, d2, d3;
        
        if (v <= 128) {
          const t = v / 128.0;
          d1 = 0.7 * (1 - t) + 0.3 * t;
          d2 = 0.2 * (1 - t) + 0.4 * t;
          d3 = 0.1 * (1 - t) + 0.3 * t;
        } else {
          const t = (v - 128) / 127.0;
          d1 = 0.3 * (1 - t) + 0.7 * t;
          d2 = 0.4 * (1 - t) + 0.2 * t;
          d3 = 0.3 * (1 - t) + 0.1 * t;
        }

        if (x + 1 < width) data[idx + 1] += err * d1;
        if (y + 1 < height) {
          if (x > 0) data[idx + stride - 1] += err * d2;
          data[idx + stride] += err * d3;
        }
      }
    }
  }

  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.max(0, Math.min(255, data[i]));
  }
}

/**
 * Zhou-Fang Variable-Coefficient Dithering
 */
function ditherZhouFang(pixels, width, height, is2bit = false) {
  const data = new Float32Array(pixels);
  const stride = width;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * stride + x;
      const oldVal = data[idx];
      let newVal;

      if (is2bit) {
        if (oldVal < 42) newVal = 0;
        else if (oldVal < 127) newVal = 85;
        else if (oldVal < 212) newVal = 170;
        else newVal = 255;
      } else {
        newVal = oldVal < 128 ? 0 : 255;
      }

      data[idx] = newVal;
      const err = oldVal - newVal;

      if (err !== 0) {
        const e = err / 103;
        
        if (x + 1 < width) data[idx + 1] += e * 16;
        if (x + 2 < width) data[idx + 2] += e * 9;
        
        if (y + 1 < height) {
          if (x - 2 >= 0) data[idx + stride - 2] += e * 5;
          if (x - 1 >= 0) data[idx + stride - 1] += e * 11;
          data[idx + stride] += e * 16;
          if (x + 1 < width) data[idx + stride + 1] += e * 11;
          if (x + 2 < width) data[idx + stride + 2] += e * 5;
        }

        if (y + 2 < height) {
          if (x - 2 >= 0) data[idx + (stride * 2) - 2] += e * 3;
          if (x - 1 >= 0) data[idx + (stride * 2) - 1] += e * 5;
          data[idx + (stride * 2)] += e * 9;
          if (x + 1 < width) data[idx + (stride * 2) + 1] += e * 5;
          if (x + 2 < width) data[idx + (stride * 2) + 2] += e * 3;
        }
      }
    }
  }

  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.max(0, Math.min(255, data[i]));
  }
}

/**
 * Stochastic (Random) Dithering
 */
function ditherStochastic(pixels, width, height, is2bit = false) {
  const data = new Float32Array(pixels);
  
  for (let i = 0; i < pixels.length; i++) {
    const val = data[i];
    let newVal;

    if (is2bit) {
      const norm = val / 85;
      let level = Math.floor(norm);
      const rem = norm - level;
      if (Math.random() < rem) level++;
      if (level > 3) level = 3;
      newVal = level * 85;
    } else {
      newVal = val > (Math.random() * 255) ? 255 : 0;
    }
    pixels[i] = newVal;
  }
}

/**
 * Packs 1-bit grayscale pixels into XTG data (Horizontal scan, Row-major)
 */
function packXtg(pixels, width, height) {
  const rowBytes = Math.ceil(width / 8);
  const data = new Uint8Array(rowBytes * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowBytes;
    const pixelOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (pixels[pixelOffset + x] >= 128) {
        data[rowOffset + (x >> 3)] |= (0x80 >> (x & 7));
      }
    }
  }

  const hash = crypto.createHash('md5').update(data).digest().subarray(0, 8);
  const header = Buffer.alloc(22);
  header.write("XTG\x00", 0);
  header.writeUInt16LE(width, 4);
  header.writeUInt16LE(height, 6);
  header.writeUInt8(0, 8); // colorMode
  header.writeUInt8(0, 9); // compression
  header.writeUInt32LE(data.length, 10);
  hash.copy(header, 14);

  return Buffer.concat([header, data]);
}

/**
 * Packs 2-bit grayscale pixels into XTH data (Vertical scan, Planar, R-to-L)
 * Following the Python implementation logic: Vertical scan, Columns Right to Left.
 */
function packXth(pixels, width, height) {
  // LUT: White=0(00), Light=1(01), Dark=2(10), Black=3(11)
  const colBytes = Math.ceil(height / 8);
  const planeSize = colBytes * width;
  const p0 = new Uint8Array(planeSize);
  const p1 = new Uint8Array(planeSize);

  for (let x = 0; x < width; x++) {
    const targetCol = width - 1 - x; // Right to Left
    const colOffset = targetCol * colBytes;
    for (let y = 0; y < height; y++) {
      const p = pixels[y * width + x];
      let val;
      if (p >= 212) val = 0;      // White
      else if (p >= 127) val = 1; // Light Gray
      else if (p >= 42) val = 2;  // Dark Gray
      else val = 3;               // Black

      const byteIdx = colOffset + (y >> 3);
      const bitIdx = 7 - (y & 7);
      
      if (val & 1) p0[byteIdx] |= (1 << bitIdx);
      if (val & 2) p1[byteIdx] |= (1 << bitIdx);
    }
  }

  const data = Buffer.concat([Buffer.from(p0), Buffer.from(p1)]);
  const hash = crypto.createHash('md5').update(data).digest().subarray(0, 8);
  const header = Buffer.alloc(22);
  header.write("XTH\x00", 0);
  header.writeUInt16LE(width, 4);
  header.writeUInt16LE(height, 6);
  header.writeUInt8(0, 8); // colorMode
  header.writeUInt8(0, 9); // compression
  header.writeUInt32LE(data.length, 10);
  hash.copy(header, 14);

  return Buffer.concat([header, data]);
}

/**
 * Full XTC file builder
 */
function buildXtcFile(blobs, is2bit = false, metadata = {}) {
  const pageCount = blobs.length;
  const magic = is2bit ? "XTCH" : "XTC\x00";
  
  const headerSize = 56;
  const metadataSize = 256;
  const indexEntrySize = 16;
  const indexSize = pageCount * indexEntrySize;
  
  const metadataOffset = headerSize;
  const indexOffset = metadataOffset + metadataSize;
  const dataOffset = indexOffset + indexSize;

  const bufferSize = dataOffset + blobs.reduce((acc, b) => acc + b.length, 0);
  const buffer = Buffer.alloc(bufferSize);
  
  // Header
  buffer.write(magic, 0);
  buffer.writeUInt16LE(1, 4); // version
  buffer.writeUInt16LE(pageCount, 6);
  buffer.writeUInt32LE(0x01000100, 8); // flags
  buffer.writeUInt32LE(1, 12); // flags high
  
  buffer.writeBigUInt64LE(BigInt(metadataOffset), 16);
  buffer.writeBigUInt64LE(BigInt(indexOffset), 24);
  buffer.writeBigUInt64LE(BigInt(dataOffset), 32);
  buffer.writeBigUInt64LE(0n, 40); // Reserved
  buffer.writeBigUInt64LE(0n, 48); // TOC offset (simplified)

  // Metadata (minimal implementation)
  const metaBuf = buffer.subarray(metadataOffset, metadataOffset + metadataSize);
  if (metadata.title) Buffer.from(metadata.title).copy(metaBuf, 0, 0, 127);
  if (metadata.author) Buffer.from(metadata.author).copy(metaBuf, 128, 0, 63);

  // Index and Data
  let currentDataOffset = dataOffset;
  for (let i = 0; i < pageCount; i++) {
    const blob = blobs[i];
    const entryOffset = indexOffset + i * indexEntrySize;
    
    buffer.writeBigUInt64LE(BigInt(currentDataOffset), entryOffset);
    buffer.writeUInt32LE(blob.length, entryOffset + 8);
    // Write actual dimensions from header? No, assume consistency with target.
    // XTH header starts at 4, 2 UInt16LE.
    const w = blob.readUInt16LE(4);
    const h = blob.readUInt16LE(6);
    buffer.writeUInt16LE(w, entryOffset + 12);
    buffer.writeUInt16LE(h, entryOffset + 14);
    
    blob.copy(buffer, currentDataOffset);
    currentDataOffset += blob.length;
  }

  return buffer;
}

// Export functions for library use
export {
  ditherAtkinson,
  ditherFloydSteinberg,
  packXtg,
  packXth,
  buildXtcFile,
  targetWidth,
  targetHeight
};

// --- CLI Section ---

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('xtc_converter.js');

if (isMain) {
  (async () => {
    try {
      const { default: sharp } = await import('sharp');
      const { default: JSZip } = await import('jszip');

      const args = process.argv.slice(2);
      if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log(`
XTC High-Performance JS Converter
Usage: node xtc_converter.js [input_file_or_dir] [options]

Options:
  --2bit           Use 2-bit (XTCH) format (default: 1-bit XTC)
  --dither [algo]  Dithering: stucki (default), atkinson, ostromoukhov, zhoufang, floyd, none
  --gamma [val]    Gamma correction (default: 1.0)
  --out [file]     Output filename
  --clean          Delete temporary files (not applicable for single file conversion)
  
  --manhwa         Enable Manhwa mode (seamless vertical stitching)
  --overlap [pct]  Manhwa overlap percentage (30, 50, 75). Default: 50
  --sideways       Include sideways overview pages
  --pad-black      Pad with black instead of white
  --mode [mode]    Scaling mode: cover (default), letterbox, fill, crop
  --invert         Invert colors
  --device [X4|X3]  Target device: X4 (480x800, default) or X3 (528x792)

Example:
  node xtc_converter.js manga.cbz --2bit --dither floyd --manhwa --overlap 75
        `);
        process.exit(0);
      }

      const inputPath = args.find(a => !a.startsWith('--'));
      const is2bit = args.includes('--2bit');
      const ditherAlgo = args.includes('--dither') ? args[args.indexOf('--dither') + 1] : 'stucki';
      const gamma = args.includes('--gamma') ? parseFloat(args[args.indexOf('--gamma') + 1]) : 1.0;
      const mode = args.includes('--manhwa') ? 'manhwa' : (args.includes('--split') ? 'split' : 'simple');
      const sideways = args.includes('--sideways');
      const padBlack = args.includes('--pad-black');
      const invert = args.includes('--invert');
      const imageMode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'cover';
      
      const deviceArg = args.includes('--device') ? args[args.indexOf('--device') + 1].toUpperCase() : 'X4';
      const dims = DEVICE_DIMENSIONS[deviceArg] || DEVICE_DIMENSIONS.X4;
      targetWidth = dims.width;
      targetHeight = dims.height;

      let overlapPct = 50;
      if (args.includes('--overlap')) {
          overlapPct = parseInt(args[args.indexOf('--overlap') + 1]);
      }
      
      let outputPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;

      if (!inputPath || !fs.existsSync(inputPath)) {
        console.error("Error: Input path does not exist.");
        process.exit(1);
      }

      const stats = fs.statSync(inputPath);
      let blobs = [];
      let chapterInfo = []; // TOC

      // --- Helper: Manhwa Stitcher ---
      class Stitcher {
        constructor() {
          this.buffer = null; // Buffer of raw grayscale pixels
          this.width = targetWidth;
          this.height = 0;
          this.pageCount = 0;
        }

        async append(buffer) {
          const image = sharp(buffer);
          const meta = await image.metadata();
          const scale = targetWidth / meta.width;
          const newH = Math.floor(meta.height * scale);
          
          let pipeline = image.resize(targetWidth, newH, { kernel: 'cubic' }).grayscale();
          if (gamma !== 1.0 && is2bit) pipeline = pipeline.gamma(gamma);
          
          const { data } = await pipeline.raw().toBuffer({ resolveWithObject: true });
          
          // Append to buffer
          if (!this.buffer) {
            this.buffer = data;
            this.height = newH;
          } else {
            this.buffer = Buffer.concat([this.buffer, data]);
            this.height += newH;
          }
          
          const results = [];
          
          while (this.height >= targetHeight) {
            // Check solid color logic could go here (stddev check on slice)
            // For now, assume standard overlap logic
            
            const sliceSize = targetWidth * targetHeight;
            const slice = new Uint8ClampedArray(this.buffer.subarray(0, sliceSize));
            
            // Dither in place (on the copy)
            if (ditherAlgo === 'atkinson') ditherAtkinson(slice, targetWidth, targetHeight, is2bit);
            else if (ditherAlgo === 'stucki') ditherStucki(slice, targetWidth, targetHeight, is2bit);
            else if (ditherAlgo === 'ostromoukhov') ditherOstromoukhov(slice, targetWidth, targetHeight, is2bit);
            else if (ditherAlgo === 'zhoufang') ditherZhouFang(slice, targetWidth, targetHeight, is2bit);
            else if (ditherAlgo === 'stochastic') ditherStochastic(slice, targetWidth, targetHeight, is2bit);
            else if (ditherAlgo === 'floyd') ditherFloydSteinberg(slice, targetWidth, targetHeight, is2bit);
            
            results.push(is2bit ? packXth(slice, targetWidth, targetHeight) : packXtg(slice, targetWidth, targetHeight));
            this.pageCount++;
            
            // Advance
            const overlapPx = Math.floor(targetHeight * (overlapPct / 100));
            const step = targetHeight - overlapPx;
            const stepBytes = step * targetWidth;
            
            this.buffer = this.buffer.subarray(stepBytes);
            this.height -= step;
          }
          return results;
        }
        
        finish() {
          const results = [];
          if (this.height > 0) {
             // Pad last page (align top)
             const final = new Uint8ClampedArray(targetWidth * targetHeight).fill(padBlack ? 0 : 255);
             const h = Math.min(this.height, targetHeight);
             // Copy buffer to final
             const src = new Uint8Array(this.buffer.subarray(0, h * targetWidth));
             final.set(src, 0); // Align top
             
             if (ditherAlgo === 'atkinson') ditherAtkinson(final, targetWidth, targetHeight, is2bit);
             else if (ditherAlgo === 'stucki') ditherStucki(final, targetWidth, targetHeight, is2bit);
             else if (ditherAlgo === 'ostromoukhov') ditherOstromoukhov(final, targetWidth, targetHeight, is2bit);
             else if (ditherAlgo === 'zhoufang') ditherZhouFang(final, targetWidth, targetHeight, is2bit);
             else if (ditherAlgo === 'stochastic') ditherStochastic(final, targetWidth, targetHeight, is2bit);
             else if (ditherAlgo === 'floyd') ditherFloydSteinberg(final, targetWidth, targetHeight, is2bit);
             
             results.push(is2bit ? packXth(final, targetWidth, targetHeight) : packXtg(final, targetWidth, targetHeight));
          }
          return results;
        }
      }
      
      let stitcher = mode === 'manhwa' ? new Stitcher() : null;

      async function addImage(buffer) {
        if (stitcher) {
          const pages = await stitcher.append(buffer);
          blobs.push(...pages);
        } else if (mode === 'split') {
          const processed = await processSplit(sharp, buffer, is2bit, ditherAlgo, gamma, padBlack, invert);
          blobs.push(...processed);
        } else {
          // Standard processing
          const blob = await processImage(sharp, buffer, is2bit, ditherAlgo, gamma, padBlack, sideways, imageMode, invert);
          if (Array.isArray(blob)) blobs.push(...blob); // Handle sideways overview returning array
          else blobs.push(blob);
        }
      }

      if (stats.isFile() && inputPath.toLowerCase().endsWith('.cbz')) {
        console.log(`Processing CBZ: ${inputPath} [Mode: ${mode}]`);
        const zipData = fs.readFileSync(inputPath);
        const zip = await JSZip.loadAsync(zipData);
        const imageFiles = Object.keys(zip.files)
          .filter(name => /\.(jpg|jpeg|png|webp|bmp)$/i.test(name) && !name.includes('__MACOSX'))
          .sort();

        console.log(`Found ${imageFiles.length} images.`);
        
        // Chapter Extraction (Folder based)
        const folderMap = new Map();
        imageFiles.forEach((f, idx) => {
           const parts = f.split('/');
           if (parts.length > 1) {
             const folder = parts[parts.length - 2];
             if (!folderMap.has(folder)) folderMap.set(folder, idx + 1);
           }
        });
        
        if (folderMap.size > 1) {
           let lastStart = 1;
           let lastTitle = "Start";
           for (const [title, start] of folderMap) {
              if (lastStart < start) {
                 chapterInfo.push({ title: lastTitle, startPage: lastStart, endPage: start - 1 });
              }
              lastStart = start;
              lastTitle = title;
           }
           chapterInfo.push({ title: lastTitle, startPage: lastStart, endPage: imageFiles.length });
        } else {
           // Page-level TOC
           imageFiles.forEach((f, i) => chapterInfo.push({ title: `Page ${i+1}`, startPage: i+1, endPage: i+1 }));
        }
        
        for (let i = 0; i < imageFiles.length; i++) {
          process.stdout.write(`\rProcessing page ${i + 1}/${imageFiles.length}... `);
          const buffer = await zip.files[imageFiles[i]].async('nodebuffer');
          await addImage(buffer);
        }
        process.stdout.write("Done.\n");

        if (!outputPath) outputPath = inputPath.replace(/\.[^.]+$/, is2bit ? '.xtch' : '.xtc');

      } else if (stats.isDirectory()) {
        console.log(`Processing directory: ${inputPath}`);
        const files = fs.readdirSync(inputPath)
          .filter(name => /\.(jpg|jpeg|png|webp|bmp)$/i.test(name))
          .sort();

        files.forEach((f, i) => chapterInfo.push({ title: `Page ${i+1}`, startPage: i+1, endPage: i+1 }));

        for (let i = 0; i < files.length; i++) {
          process.stdout.write(`\rEncoding image ${i + 1}/${files.length}... `);
          const buffer = fs.readFileSync(path.join(inputPath, files[i]));
          await addImage(buffer);
        }
        process.stdout.write("Done.\n");

        if (!outputPath) outputPath = path.join(inputPath, (is2bit ? 'output.xtch' : 'output.xtc'));
      } else {
        // Single image
        console.log(`Processing image: ${inputPath}`);
        const buffer = fs.readFileSync(inputPath);
        await addImage(buffer);
        if (!outputPath) outputPath = inputPath.replace(/\.[^.]+$/, is2bit ? '.xtch' : '.xtc');
      }
      
      if (stitcher) {
         blobs.push(...stitcher.finish());
      }

      const finalFile = buildXtcFile(blobs, is2bit, { title: path.basename(inputPath), toc: chapterInfo });
      fs.writeFileSync(outputPath, finalFile);
      console.log(`Saved to ${outputPath} (${(finalFile.length / 1024).toFixed(1)} KB)`);

    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND' || e.message.includes('Cannot find module')) {
        console.error(`
Error: Missing dependencies.
Please install them using:
  npm install sharp jszip
        `);
      } else {
        console.error(e);
      }
      process.exit(1);
    }
  })();
}

// Updated helper functions with new options support

async function processImage(sharp, buffer, is2bit, ditherAlgo, gamma, padBlack, sideways, imageMode = 'cover', invert = false) {
  const blobs = [];
  const bg = padBlack ? { r:0, g:0, b:0, alpha:1 } : { r:255, g:255, b:255, alpha:1 };
  
  if (sideways) {
     // Create sideways overview
     let ovPipeline = sharp(buffer)
       .rotate(90)
       .resize(targetWidth, targetHeight, { fit: 'contain', background: bg, kernel: 'cubic' })
       .grayscale();
     if (gamma !== 1.0 && is2bit) ovPipeline = ovPipeline.gamma(gamma);
     if (invert) ovPipeline = ovPipeline.negate();
     const { data: ovData } = await ovPipeline.raw().toBuffer({ resolveWithObject: true });
     const ovPixels = new Uint8ClampedArray(ovData);
     if (ditherAlgo === 'atkinson') ditherAtkinson(ovPixels, targetWidth, targetHeight, is2bit);
     else if (ditherAlgo === 'stucki') ditherStucki(ovPixels, targetWidth, targetHeight, is2bit);
     else if (ditherAlgo === 'ostromoukhov') ditherOstromoukhov(ovPixels, targetWidth, targetHeight, is2bit);
     else if (ditherAlgo === 'zhoufang') ditherZhouFang(ovPixels, targetWidth, targetHeight, is2bit);
     else if (ditherAlgo === 'stochastic') ditherStochastic(ovPixels, targetWidth, targetHeight, is2bit);
     else if (ditherAlgo === 'floyd') ditherFloydSteinberg(ovPixels, targetWidth, targetHeight, is2bit);
     blobs.push(is2bit ? packXth(ovPixels, targetWidth, targetHeight) : packXtg(ovPixels, targetWidth, targetHeight));
  }

  let resizeOptions = {
    fit: 'contain',
    background: bg,
    kernel: 'cubic'
  };

  if (imageMode === 'fill') resizeOptions.fit = 'fill';
  else if (imageMode === 'cover') resizeOptions.fit = 'cover';
  
  let pipeline = sharp(buffer);

  if (imageMode === 'crop') {
    // Center crop without scaling
    pipeline = pipeline.resize(targetWidth, targetHeight, { fit: 'cover', position: 'center', kernel: 'cubic' });
    // Note: This still scales if smaller. True crop without scale:
    // const meta = await pipeline.metadata();
    // pipeline = pipeline.extract({ 
    //   left: Math.max(0, Math.floor((meta.width - targetWidth)/2)),
    //   top: Math.max(0, Math.floor((meta.height - targetHeight)/2)),
    //   width: Math.min(meta.width, targetWidth),
    //   height: Math.min(meta.height, targetHeight)
    // }).extend({
    //   top: Math.max(0, Math.floor((targetHeight - meta.height)/2)),
    //   bottom: Math.max(0, Math.ceil((targetHeight - meta.height)/2)),
    //   left: Math.max(0, Math.floor((targetWidth - meta.width)/2)),
    //   right: Math.max(0, Math.ceil((targetWidth - meta.width)/2)),
    //   background: bg
    // });
  } else {
    pipeline = pipeline.resize(targetWidth, targetHeight, resizeOptions);
  }

  pipeline = pipeline.grayscale();

  if (gamma !== 1.0 && is2bit) pipeline = pipeline.gamma(gamma);
  if (invert) pipeline = pipeline.negate();

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8ClampedArray(data);

  if (ditherAlgo === 'atkinson') ditherAtkinson(pixels, info.width, info.height, is2bit);
  else if (ditherAlgo === 'stucki') ditherStucki(pixels, info.width, info.height, is2bit);
  else if (ditherAlgo === 'ostromoukhov') ditherOstromoukhov(pixels, info.width, info.height, is2bit);
  else if (ditherAlgo === 'zhoufang') ditherZhouFang(pixels, info.width, info.height, is2bit);
  else if (ditherAlgo === 'stochastic') ditherStochastic(pixels, info.width, info.height, is2bit);
  else if (ditherAlgo === 'floyd') ditherFloydSteinberg(pixels, info.width, info.height, is2bit);

  blobs.push(is2bit ? packXth(pixels, info.width, info.height) : packXtg(pixels, info.width, info.height));
  
  return blobs;
}

async function processSplit(sharp, buffer, is2bit, ditherAlgo, gamma, padBlack, invert = false) {
  const metadata = await sharp(buffer).metadata();
  
  if (metadata.width < metadata.height) {
    return await processImage(sharp, buffer, is2bit, ditherAlgo, gamma, padBlack, false, 'cover', invert);
  }

  const results = [];
  const overlap = 40;
  const halfWidth = Math.floor(metadata.width / 2) + overlap;
  const regions = [
    { left: 0, top: 0, width: halfWidth, height: metadata.height },
    { left: metadata.width - halfWidth, top: 0, width: halfWidth, height: metadata.height }
  ];

  for (const region of regions) {
    const partBuffer = await sharp(buffer).extract(region).toBuffer();
    // Recursive call to processImage for each part
    const parts = await processImage(sharp, partBuffer, is2bit, ditherAlgo, gamma, padBlack, false, 'cover', invert);
    results.push(...parts);
  }
  return results;
}

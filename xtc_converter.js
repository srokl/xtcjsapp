#!/usr/bin/env node

/**
 * XTC/XTCH High-Performance Converter for XTEink X4
 * Optimized for performance using TypedArrays and minimal allocations.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Constants
const TARGET_WIDTH = 480;
const TARGET_HEIGHT = 800;

/**
 * Atkinson Dithering
 * Optimized single-pass implementation using TypedArrays.
 * @param {Uint8ClampedArray} pixels - Grayscale pixels (L)
 * @param {number} width 
 * @param {number} height 
 * @param {boolean} is2bit - If true, dither to 4 levels (0, 85, 170, 255)
 */
function ditherAtkinson(pixels, width, height, is2bit = false) {
  const data = new Int16Array(pixels);
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
  const data = new Int16Array(pixels);
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
    buffer.writeUInt16LE(TARGET_WIDTH, entryOffset + 12);
    buffer.writeUInt16LE(TARGET_HEIGHT, entryOffset + 14);
    
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
  TARGET_WIDTH,
  TARGET_HEIGHT
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
  --dither [algo]  Dithering: atkinson (default), floyd, none
  --gamma [val]    Gamma correction (default: 1.0)
  --out [file]     Output filename
  --clean          Delete temporary files (not applicable for single file conversion)

Example:
  node xtc_converter.js manga.cbz --2bit --dither floyd
        `);
        process.exit(0);
      }

      const inputPath = args.find(a => !a.startsWith('--'));
      const is2bit = args.includes('--2bit');
      const ditherAlgo = args.includes('--dither') ? args[args.indexOf('--dither') + 1] : 'atkinson';
      const gamma = args.includes('--gamma') ? parseFloat(args[args.indexOf('--gamma') + 1]) : 1.0;
      const mode = args.includes('--manhwa') ? 'manhwa' : (args.includes('--split') ? 'split' : 'simple');
      const rtl = args.includes('--rtl');
      let outputPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;

      if (!inputPath || !fs.existsSync(inputPath)) {
        console.error("Error: Input path does not exist.");
        process.exit(1);
      }

      const stats = fs.statSync(inputPath);
      let blobs = [];

      async function addImage(buffer) {
        if (mode === 'manhwa') {
          const processed = await processManhwa(sharp, buffer, is2bit, ditherAlgo, gamma);
          blobs.push(...processed);
        } else if (mode === 'split') {
          const processed = await processSplit(sharp, buffer, is2bit, ditherAlgo, gamma, rtl);
          blobs.push(...processed);
        } else {
          const blob = await processImage(sharp, buffer, is2bit, ditherAlgo, gamma);
          blobs.push(blob);
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
        
        for (let i = 0; i < imageFiles.length; i++) {
          process.stdout.write(`\rProcessing page ${i + 1}/${imageFiles.length}... `);
          const buffer = await zip.files[imageFiles[i]].async('nodebuffer');
          await addImage(buffer);
        }
        process.stdout.write("Done.\n");

        if (!outputPath) outputPath = inputPath.replace(/\.cbz$/i, is2bit ? '.xtch' : '.xtc');

      } else if (stats.isDirectory()) {
        console.log(`Processing directory: ${inputPath}`);
        const files = fs.readdirSync(inputPath)
          .filter(name => /\.(jpg|jpeg|png|webp|bmp)$/i.test(name))
          .sort();

        for (let i = 0; i < files.length; i++) {
          process.stdout.write(`\rEncoding image ${i + 1}/${files.length}... `);
          const buffer = fs.readFileSync(path.join(inputPath, files[i]));
          const blob = await processImage(sharp, buffer, is2bit, ditherAlgo, gamma);
          blobs.push(blob);
        }
        process.stdout.write("Done.\n");

        if (!outputPath) outputPath = path.join(inputPath, (is2bit ? 'output.xtch' : 'output.xtc'));
      } else {
        // Single image
        console.log(`Processing image: ${inputPath}`);
        const buffer = fs.readFileSync(inputPath);
        const blob = await processImage(sharp, buffer, is2bit, ditherAlgo, gamma);
        blobs.push(blob);
        if (!outputPath) outputPath = inputPath.replace(/\.[^.]+$/, is2bit ? '.xtch' : '.xtc');
      }

      const finalFile = buildXtcFile(blobs, is2bit, { title: path.basename(inputPath) });
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

/**
 * Processes a single image buffer using sharp and the XTC encoders.
 */
async function processImage(sharp, buffer, is2bit, ditherAlgo, gamma) {
  let pipeline = sharp(buffer)
    .resize(TARGET_WIDTH, TARGET_HEIGHT, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    })
    .grayscale();

  if (gamma !== 1.0) pipeline = pipeline.gamma(gamma);

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8ClampedArray(data);

  if (ditherAlgo === 'atkinson') ditherAtkinson(pixels, info.width, info.height, is2bit);
  else if (ditherAlgo === 'floyd') ditherFloydSteinberg(pixels, info.width, info.height, is2bit);

  return is2bit ? packXth(pixels, info.width, info.height) : packXtg(pixels, info.width, info.height);
}

/**
 * Processes a wide image by splitting it into parts.
 */
async function processSplit(sharp, buffer, is2bit, ditherAlgo, gamma, rtl = false) {
  const metadata = await sharp(buffer).metadata();
  if (metadata.width < metadata.height) {
    // Already portrait, don't split
    return [await processImage(sharp, buffer, is2bit, ditherAlgo, gamma)];
  }

  // Split into 2 halves with overlap (typical manga spread)
  const results = [];
  const overlap = 40; // Overlap in pixels
  const halfWidth = Math.floor(metadata.width / 2) + overlap;
  
  const regions = rtl 
    ? [{ left: metadata.width - halfWidth, top: 0, width: halfWidth, height: metadata.height },
       { left: 0, top: 0, width: halfWidth, height: metadata.height }]
    : [{ left: 0, top: 0, width: halfWidth, height: metadata.height },
       { left: metadata.width - halfWidth, top: 0, width: halfWidth, height: metadata.height }];

  for (const region of regions) {
    const partBuffer = await sharp(buffer).extract(region).toBuffer();
    results.push(await processImage(sharp, partBuffer, is2bit, ditherAlgo, gamma));
  }
  return results;
}

/**
 * Processes a long strip (manhwa) by slicing it.
 */
async function processManhwa(sharp, buffer, is2bit, ditherAlgo, gamma) {
  const metadata = await sharp(buffer).metadata();
  const scale = TARGET_WIDTH / metadata.width;
  const newHeight = Math.floor(metadata.height * scale);

  const resizedBuffer = await sharp(buffer)
    .resize(TARGET_WIDTH, newHeight)
    .grayscale()
    .toBuffer();

  const results = [];
  const sliceHeight = TARGET_HEIGHT;
  const overlap = 100; // Overlap for continuous scrolling feel
  
  for (let y = 0; y < newHeight; y += (sliceHeight - overlap)) {
    if (y + sliceHeight > newHeight && results.length > 0) {
      // Last slice, align to bottom
      const region = { left: 0, top: newHeight - sliceHeight, width: TARGET_WIDTH, height: sliceHeight };
      const sliceBuffer = await sharp(resizedBuffer).extract(region).toBuffer();
      results.push(await processImage(sharp, sliceBuffer, is2bit, ditherAlgo, gamma));
      break;
    }
    const region = { left: 0, top: y, width: TARGET_WIDTH, height: Math.min(sliceHeight, newHeight - y) };
    let slicePipeline = sharp(resizedBuffer).extract(region);
    
    if (region.height < sliceHeight) {
      slicePipeline = slicePipeline.extend({
        bottom: sliceHeight - region.height,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      });
    }

    const sliceBuffer = await slicePipeline.toBuffer();
    results.push(await processImage(sharp, sliceBuffer, is2bit, ditherAlgo, gamma));
    
    if (y + sliceHeight >= newHeight) break;
  }
  return results;
}

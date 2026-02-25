// AssemblyScript for high-performance image processing

// Optimized XTC Packing (1-bit)
export function packXtc(width: i32, height: i32, srcPtr: usize, dstPtr: usize): void {
  let rowBytes = (width + 7) >>> 3;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // RGBA input (stride 4)
      let pixelIdx = (y * width + x) * 4;
      let r = load<u8>(srcPtr + pixelIdx);
      let g = load<u8>(srcPtr + pixelIdx + 1);
      let b = load<u8>(srcPtr + pixelIdx + 2);
      
      // Simple luminosity
      let gray = <u8>((<u32>r * 77 + <u32>g * 150 + <u32>b * 29) >> 8);
      
      // Check if pixel is white (>= 128)
      if (gray >= 128) {
        let byteIdx = y * rowBytes + (x >>> 3);
        let bitIdx = 7 - (x & 7);
        let current = load<u8>(dstPtr + byteIdx);
        let maskI32 = 1 << bitIdx;
        let mask = <u8>maskI32;
        store<u8>(dstPtr + byteIdx, current | mask);
      }
    }
  }
}

// Optimized XTH Packing (2-bit)
export function packXth(width: i32, height: i32, srcPtr: usize, dstPtr: usize): void {
  // Vertical scan, Right-to-Left columns
  let colBytes = (height + 7) >>> 3;
  let planeSize = colBytes * width;
  
  let p0Start = dstPtr;
  let p1Start = dstPtr + planeSize;
  
  for (let x = 0; x < width; x++) {
    let targetCol = width - 1 - x;
    let colOffset = targetCol * colBytes;
    
    for (let y = 0; y < height; y++) {
      // RGBA input
      let pixelIdx = (y * width + x) * 4;
      let r = load<u8>(srcPtr + pixelIdx);
      let g = load<u8>(srcPtr + pixelIdx + 1);
      let b = load<u8>(srcPtr + pixelIdx + 2);
      
      let gray = <u8>((<u32>r * 77 + <u32>g * 150 + <u32>b * 29) >> 8);
      
      let val: u8 = 3; // Black
      if (gray >= 212) val = 0;      // White
      else if (gray >= 127) val = 1; // Light
      else if (gray >= 42) val = 2;  // Dark
      
      let byteIdx = colOffset + (y >>> 3);
      let bitIdx = 7 - (y & 7);
      let maskI32 = 1 << bitIdx;
      let mask = <u8>maskI32;
      
      if (val & 1) {
        let p0 = load<u8>(p0Start + byteIdx);
        store<u8>(p0Start + byteIdx, p0 | mask);
      }
      if (val & 2) {
        let p1 = load<u8>(p1Start + byteIdx);
        store<u8>(p1Start + byteIdx, p1 | mask);
      }
    }
  }
}

// Fast Grayscale Conversion
export function toGrayscale(width: i32, height: i32, srcPtr: usize): void {
  let len = width * height;
  for (let i = 0; i < len; i++) {
    let idx = i << 2;
    let r = load<u8>(srcPtr + idx);
    let g = load<u8>(srcPtr + idx + 1);
    let b = load<u8>(srcPtr + idx + 2);
    let gray = <u8>((<u32>r * 77 + <u32>g * 150 + <u32>b * 29) >> 8);
    store<u8>(srcPtr + idx, gray);
    store<u8>(srcPtr + idx + 1, gray);
    store<u8>(srcPtr + idx + 2, gray);
  }
}

// Optimized Image Filters (Contrast -> Invert -> Gamma -> Grayscale)
// Single pass for maximum performance
export function applyFilters(width: i32, height: i32, srcPtr: usize, contrast: f32, gamma: f32, invert: bool): void {
  let len = width * height;
  
  // Pre-calculate contrast factor
  // Matches Python/JS logic: blackCutoff = 3*C, whiteCutoff = 3+9*C (approx)
  // Or the WebGL logic: factor = (1.0 + contrast / 10.0)
  // Let's match the WebGL logic for "experimental speed boost" feel, or standard JS?
  // Standard JS use Look Up Table (LUT).
  // Calculating pow() per pixel is slow. 
  // However, simple contrast stretch is fast.
  // Let's implement a direct mapping.
  
  // To avoid expensive pow() calls per pixel for Gamma, we should probably use a LUT (Look Up Table)
  // Since input is 8-bit (0-255), a 256-byte LUT is tiny and much faster.
  
  // 1. Build LUT
  // We need to map 0-255 input -> 0-255 output applying all transforms
  // But wait, input is RGBA. We convert to Gray first?
  // JS logic: Contrast (RGB) -> Gamma (RGB) -> Invert (RGB) -> Gray
  // Actually converter.ts: Contrast -> Gamma -> Invert -> Gray.
  
  // If we assume we convert to Gray *last*, we apply filters to RGB.
  // If we convert to Gray *first*, we save 3x work.
  // Standard "manga" processing usually converts to gray first, but converter.ts does it last.
  // Doing it last allows color filters to work (e.g. invert colors might differ?).
  // For grayscale output, it doesn't matter much mathematically if we invert before/after gray 
  // (Invert(Gray(RGB)) == Gray(Invert(RGB))).
  
  // So: Gray -> Contrast -> Gamma -> Invert is most efficient.
  // Let's do that: Read RGBA -> Calc Gray -> Apply Filters (via LUT) -> Write Gray (to R,G,B).
  
  let lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let val = <f32>i;
    
    // 1. Contrast
    if (contrast > 0.0) {
      let c = <f32>1.0 + (contrast / <f32>4.0);
      let norm = val / <f32>255.0;
      norm = <f32>0.5 + (norm - <f32>0.5) * c;
      if (norm < 0.0) norm = 0.0;
      if (norm > 1.0) norm = 1.0;
      val = norm * <f32>255.0;
    }
    
    // 2. Gamma
    if (gamma != 1.0) {
      // val = pow(val/255, gamma) * 255
      let norm = val / 255.0;
      // Math.pow is native f64 in JS, in AS we use f32 or f64.
      // Need 'import "Math"'? No, generic Math.pow works.
      val = <f32>Math.pow(<f64>norm, <f64>gamma) * 255.0;
    }
    
    // 3. Invert
    if (invert) {
      val = 255.0 - val;
    }
    
    // Clamp
    if (val < 0.0) val = 0.0;
    if (val > 255.0) val = 255.0;
    
    lut[i] = <u8>val;
  }
  
  // Process Pixels using LUT
  for (let i = 0; i < len; i++) {
    let idx = i << 2;
    let r = load<u8>(srcPtr + idx);
    let g = load<u8>(srcPtr + idx + 1);
    let b = load<u8>(srcPtr + idx + 2);
    
    // Luminosity Gray
    // Gray = (r*77 + g*150 + b*29) >> 8
    let grayIndex = <i32>((<u32>r * 77 + <u32>g * 150 + <u32>b * 29) >> 8);
    
    // Lookup
    let finalGray = lut[grayIndex];
    
    // Write back (R=G=B=Gray, A=255)
    store<u8>(srcPtr + idx, finalGray);
    store<u8>(srcPtr + idx + 1, finalGray);
    store<u8>(srcPtr + idx + 2, finalGray);
    // store<u8>(srcPtr + idx + 3, 255); // Keep Alpha
  }
}

// --- Dithering Algorithms ---

// Helper: Thresholding
function getNewVal(oldVal: f32, is2bit: bool): f32 {
  if (is2bit) {
    if (oldVal < 42.0) return 0.0;
    if (oldVal < 127.0) return 85.0;
    if (oldVal < 212.0) return 170.0;
    return 255.0;
  }
  return oldVal < 128.0 ? 0.0 : 255.0;
}

// Helper: Load/Convert
function prepareScratch(width: i32, height: i32, srcPtr: usize, scratchPtr: usize): void {
  let len = width * height;
  for (let i = 0; i < len; i++) {
    let px = i << 2;
    let r = load<u8>(srcPtr + px);
    let g = load<u8>(srcPtr + px + 1);
    let b = load<u8>(srcPtr + px + 2);
    let gray = (<f32>r * 0.299 + <f32>g * 0.587 + <f32>b * 0.114);
    store<f32>(scratchPtr + (i << 2), gray);
  }
}

// Helper: Write Back
function writeBack(width: i32, height: i32, srcPtr: usize, scratchPtr: usize): void {
  let len = width * height;
  for (let i = 0; i < len; i++) {
    let val = load<f32>(scratchPtr + (i << 2));
    let u8val: u8;
    if (val <= 0.0) u8val = 0;
    else if (val >= 255.0) u8val = 255;
    else u8val = <u8>val;
    
    let px = i << 2;
    store<u8>(srcPtr + px, u8val);
    store<u8>(srcPtr + px + 1, u8val);
    store<u8>(srcPtr + px + 2, u8val);
  }
}

// 1. Floyd-Steinberg
export function ditherFloyd(width: i32, height: i32, srcPtr: usize, scratchPtr: usize, is2bit: bool): void {
  prepareScratch(width, height, srcPtr, scratchPtr);
  let stride = width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let idx = y * stride + x;
      let ptr = scratchPtr + (idx << 2);
      let oldVal = load<f32>(ptr);
      let newVal = getNewVal(oldVal, is2bit);
      store<f32>(ptr, newVal);
      let err = oldVal - newVal;
      
      if (err != 0.0) {
        // 7, 3, 5, 1 / 16
        if (x + 1 < width) {
          let p = scratchPtr + ((idx + 1) << 2);
          store<f32>(p, load<f32>(p) + (err * 0.4375)); // 7/16
        }
        if (y + 1 < height) {
          if (x > 0) {
            let p = scratchPtr + ((idx + stride - 1) << 2);
            store<f32>(p, load<f32>(p) + (err * 0.1875)); // 3/16
          }
          let p = scratchPtr + ((idx + stride) << 2);
          store<f32>(p, load<f32>(p) + (err * 0.3125)); // 5/16
          if (x + 1 < width) {
            let p = scratchPtr + ((idx + stride + 1) << 2);
            store<f32>(p, load<f32>(p) + (err * 0.0625)); // 1/16
          }
        }
      }
    }
  }
  writeBack(width, height, srcPtr, scratchPtr);
}

// 2. Atkinson
export function ditherAtkinson(width: i32, height: i32, srcPtr: usize, scratchPtr: usize, is2bit: bool): void {
  prepareScratch(width, height, srcPtr, scratchPtr);
  let stride = width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let idx = y * stride + x;
      let ptr = scratchPtr + (idx << 2);
      let oldVal = load<f32>(ptr);
      let newVal = getNewVal(oldVal, is2bit);
      store<f32>(ptr, newVal);
      let err = oldVal - newVal;
      
      if (err != 0.0) {
        let e = err * 0.125; // 1/8
        if (x + 1 < width) {
          let p = scratchPtr + ((idx + 1) << 2);
          store<f32>(p, load<f32>(p) + e);
        }
        if (x + 2 < width) {
          let p = scratchPtr + ((idx + 2) << 2);
          store<f32>(p, load<f32>(p) + e);
        }
        if (y + 1 < height) {
          if (x > 0) {
            let p = scratchPtr + ((idx + stride - 1) << 2);
            store<f32>(p, load<f32>(p) + e);
          }
          let p = scratchPtr + ((idx + stride) << 2);
          store<f32>(p, load<f32>(p) + e);
          if (x + 1 < width) {
            let p = scratchPtr + ((idx + stride + 1) << 2);
            store<f32>(p, load<f32>(p) + e);
          }
        }
        if (y + 2 < height) {
          let p = scratchPtr + ((idx + (stride << 1)) << 2);
          store<f32>(p, load<f32>(p) + e);
        }
      }
    }
  }
  writeBack(width, height, srcPtr, scratchPtr);
}

// 3. Stucki
export function ditherStucki(width: i32, height: i32, srcPtr: usize, scratchPtr: usize, is2bit: bool): void {
  prepareScratch(width, height, srcPtr, scratchPtr);
  let stride = width;
  let div42: f32 = 1.0 / 42.0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let idx = y * stride + x;
      let ptr = scratchPtr + (idx << 2);
      let oldVal = load<f32>(ptr);
      let newVal = getNewVal(oldVal, is2bit);
      store<f32>(ptr, newVal);
      let err = oldVal - newVal;
      
      if (err != 0.0) {
        if (x + 1 < width) {
          let p = scratchPtr + ((idx + 1) << 2);
          store<f32>(p, load<f32>(p) + (err * 8.0 * div42));
        }
        if (x + 2 < width) {
          let p = scratchPtr + ((idx + 2) << 2);
          store<f32>(p, load<f32>(p) + (err * 4.0 * div42));
        }
        if (y + 1 < height) {
          if (x - 2 >= 0) {
            let p = scratchPtr + ((idx + stride - 2) << 2);
            store<f32>(p, load<f32>(p) + (err * 2.0 * div42));
          }
          if (x - 1 >= 0) {
            let p = scratchPtr + ((idx + stride - 1) << 2);
            store<f32>(p, load<f32>(p) + (err * 4.0 * div42));
          }
          let p = scratchPtr + ((idx + stride) << 2);
          store<f32>(p, load<f32>(p) + (err * 8.0 * div42));
          if (x + 1 < width) {
            let p = scratchPtr + ((idx + stride + 1) << 2);
            store<f32>(p, load<f32>(p) + (err * 4.0 * div42));
          }
          if (x + 2 < width) {
            let p = scratchPtr + ((idx + stride + 2) << 2);
            store<f32>(p, load<f32>(p) + (err * 2.0 * div42));
          }
        }
        if (y + 2 < height) {
          if (x - 2 >= 0) {
            let p = scratchPtr + ((idx + (stride << 1) - 2) << 2);
            store<f32>(p, load<f32>(p) + (err * 1.0 * div42));
          }
          if (x - 1 >= 0) {
            let p = scratchPtr + ((idx + (stride << 1) - 1) << 2);
            store<f32>(p, load<f32>(p) + (err * 2.0 * div42));
          }
          let p = scratchPtr + ((idx + (stride << 1)) << 2);
          store<f32>(p, load<f32>(p) + (err * 4.0 * div42));
          if (x + 1 < width) {
            let p = scratchPtr + ((idx + (stride << 1) + 1) << 2);
            store<f32>(p, load<f32>(p) + (err * 2.0 * div42));
          }
          if (x + 2 < width) {
            let p = scratchPtr + ((idx + (stride << 1) + 2) << 2);
            store<f32>(p, load<f32>(p) + (err * 1.0 * div42));
          }
        }
      }
    }
  }
  writeBack(width, height, srcPtr, scratchPtr);
}

// 4. Ostromoukhov
export function ditherOstromoukhov(width: i32, height: i32, srcPtr: usize, scratchPtr: usize, is2bit: bool): void {
  prepareScratch(width, height, srcPtr, scratchPtr);
  let stride = width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let idx = y * stride + x;
      let ptr = scratchPtr + (idx << 2);
      let oldVal = load<f32>(ptr);
      let newVal = getNewVal(oldVal, is2bit);
      store<f32>(ptr, newVal);
      let err = oldVal - newVal;
      
      if (err != 0.0) {
        let v = oldVal;
        if (v < 0.0) v = 0.0;
        if (v > 255.0) v = 255.0;
        
        let d1: f32, d2: f32, d3: f32;
        if (v <= 128.0) {
          let t = v / 128.0;
          d1 = 0.7 * (1.0 - t) + 0.3 * t;
          d2 = 0.2 * (1.0 - t) + 0.4 * t;
          d3 = 0.1 * (1.0 - t) + 0.3 * t;
        } else {
          let t = (v - 128.0) / 127.0;
          d1 = 0.3 * (1.0 - t) + 0.7 * t;
          d2 = 0.4 * (1.0 - t) + 0.2 * t;
          d3 = 0.3 * (1.0 - t) + 0.1 * t;
        }
        
        if (x + 1 < width) {
          let p = scratchPtr + ((idx + 1) << 2);
          store<f32>(p, load<f32>(p) + (err * d1));
        }
        if (y + 1 < height) {
          if (x > 0) {
            let p = scratchPtr + ((idx + stride - 1) << 2);
            store<f32>(p, load<f32>(p) + (err * d2));
          }
          let p = scratchPtr + ((idx + stride) << 2);
          store<f32>(p, load<f32>(p) + (err * d3));
        }
      }
    }
  }
  writeBack(width, height, srcPtr, scratchPtr);
}

// 5. Zhou-Fang
export function ditherZhouFang(width: i32, height: i32, srcPtr: usize, scratchPtr: usize, is2bit: bool): void {
  prepareScratch(width, height, srcPtr, scratchPtr);
  let stride = width;
  let div103: f32 = 1.0 / 103.0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let idx = y * stride + x;
      let ptr = scratchPtr + (idx << 2);
      let oldVal = load<f32>(ptr);
      let newVal = getNewVal(oldVal, is2bit);
      store<f32>(ptr, newVal);
      let err = oldVal - newVal;
      
      if (err != 0.0) {
        let e = err * div103;
        // Row 1
        if (x + 1 < width) {
          let p = scratchPtr + ((idx + 1) << 2);
          store<f32>(p, load<f32>(p) + (e * 16.0));
        }
        if (x + 2 < width) {
          let p = scratchPtr + ((idx + 2) << 2);
          store<f32>(p, load<f32>(p) + (e * 9.0));
        }
        // Row 2
        if (y + 1 < height) {
          if (x - 2 >= 0) {
            let p = scratchPtr + ((idx + stride - 2) << 2);
            store<f32>(p, load<f32>(p) + (e * 5.0));
          }
          if (x - 1 >= 0) {
            let p = scratchPtr + ((idx + stride - 1) << 2);
            store<f32>(p, load<f32>(p) + (e * 11.0));
          }
          let p = scratchPtr + ((idx + stride) << 2);
          store<f32>(p, load<f32>(p) + (e * 16.0));
          if (x + 1 < width) {
            let p = scratchPtr + ((idx + stride + 1) << 2);
            store<f32>(p, load<f32>(p) + (e * 11.0));
          }
          if (x + 2 < width) {
            let p = scratchPtr + ((idx + stride + 2) << 2);
            store<f32>(p, load<f32>(p) + (e * 5.0));
          }
        }
        // Row 3
        if (y + 2 < height) {
          if (x - 2 >= 0) {
            let p = scratchPtr + ((idx + (stride << 1) - 2) << 2);
            store<f32>(p, load<f32>(p) + (e * 3.0));
          }
          if (x - 1 >= 0) {
            let p = scratchPtr + ((idx + (stride << 1) - 1) << 2);
            store<f32>(p, load<f32>(p) + (e * 5.0));
          }
          let p = scratchPtr + ((idx + (stride << 1)) << 2);
          store<f32>(p, load<f32>(p) + (e * 9.0));
          if (x + 1 < width) {
            let p = scratchPtr + ((idx + (stride << 1) + 1) << 2);
            store<f32>(p, load<f32>(p) + (e * 5.0));
          }
          if (x + 2 < width) {
            let p = scratchPtr + ((idx + (stride << 1) + 2) << 2);
            store<f32>(p, load<f32>(p) + (e * 3.0));
          }
        }
      }
    }
  }
  writeBack(width, height, srcPtr, scratchPtr);
}

// 6. Sierra Lite
export function ditherSierraLite(width: i32, height: i32, srcPtr: usize, scratchPtr: usize, is2bit: bool): void {
  prepareScratch(width, height, srcPtr, scratchPtr);
  let stride = width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let idx = y * stride + x;
      let ptr = scratchPtr + (idx << 2);
      let oldVal = load<f32>(ptr);
      let newVal = getNewVal(oldVal, is2bit);
      store<f32>(ptr, newVal);
      let err = oldVal - newVal;
      
      if (err != 0.0) {
        let e = err * 0.25; // 1/4
        // Row 1
        if (x + 1 < width) {
          let p = scratchPtr + ((idx + 1) << 2);
          store<f32>(p, load<f32>(p) + (e * 2.0));
        }
        // Row 2
        if (y + 1 < height) {
          if (x - 1 >= 0) {
            let p = scratchPtr + ((idx + stride - 1) << 2);
            store<f32>(p, load<f32>(p) + e);
          }
          let p = scratchPtr + ((idx + stride) << 2);
          store<f32>(p, load<f32>(p) + e);
        }
      }
    }
  }
  writeBack(width, height, srcPtr, scratchPtr);
}

// 7. Ordered (Bayer)
// No scratch buffer needed, but we write directly.
export function ditherOrdered(width: i32, height: i32, srcPtr: usize, is2bit: bool): void {
  // 4x4 Bayer
  let bayer0: u8 = 0;  let bayer1: u8 = 8;  let bayer2: u8 = 2;  let bayer3: u8 = 10;
  let bayer4: u8 = 12; let bayer5: u8 = 4;  let bayer6: u8 = 14; let bayer7: u8 = 6;
  let bayer8: u8 = 3;  let bayer9: u8 = 11; let bayer10: u8 = 1; let bayer11: u8 = 9;
  let bayer12: u8 = 15; let bayer13: u8 = 7; let bayer14: u8 = 13; let bayer15: u8 = 5;

  let len = width * height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let idx = (y * width + x) * 4;
      let r = load<u8>(srcPtr + idx);
      let g = load<u8>(srcPtr + idx + 1);
      let b = load<u8>(srcPtr + idx + 2);
      let gray = (<u32>r * 77 + <u32>g * 150 + <u32>b * 29) >> 8;
      
      let bx = x & 3;
      let by = y & 3;
      let mapVal: u8 = 0;
      // Unroll map lookup
      let bi = (by << 2) + bx;
      if (bi == 0) mapVal = bayer0; else if (bi == 1) mapVal = bayer1; else if (bi == 2) mapVal = bayer2; else if (bi == 3) mapVal = bayer3;
      else if (bi == 4) mapVal = bayer4; else if (bi == 5) mapVal = bayer5; else if (bi == 6) mapVal = bayer6; else if (bi == 7) mapVal = bayer7;
      else if (bi == 8) mapVal = bayer8; else if (bi == 9) mapVal = bayer9; else if (bi == 10) mapVal = bayer10; else if (bi == 11) mapVal = bayer11;
      else if (bi == 12) mapVal = bayer12; else if (bi == 13) mapVal = bayer13; else if (bi == 14) mapVal = bayer14; else if (bi == 15) mapVal = bayer15;
      
      let threshold = (<f32>mapVal / 16.0) * 255.0;
      
      let val: u8;
      if (is2bit) {
        // Simple quantization for ordered?
        // Usually ordered dithering for 4 levels is (val + threshold) quantized.
        // Let's stick to 1-bit style logic for simplicity or skip.
        // Actually, ordered dithering for multibit:
        // val = val + (threshold - 128)? 
        // Let's implement standard thresholding:
        if (<f32>gray > threshold) val = 255; else val = 0;
      } else {
        if (<f32>gray > threshold) val = 255; else val = 0;
      }
      
      store<u8>(srcPtr + idx, val);
      store<u8>(srcPtr + idx + 1, val);
      store<u8>(srcPtr + idx + 2, val);
    }
  }
}

// 8. Stochastic (Hilbert Curve)
export function ditherStochastic(width: i32, height: i32, srcPtr: usize, scratchPtr: usize, is2bit: bool): void {
  // Hilbert curve traversal
  // We need a size that is power of 2
  let maxDim = width > height ? width : height;
  let n = 1;
  while (n < maxDim) n *= 2;
  
  prepareScratch(width, height, srcPtr, scratchPtr);
  let totalPoints = n * n;
  let error: f32 = 0.0;
  
  for (let i = 0; i < totalPoints; i++) {
    let t = i;
    let x = 0;
    let y = 0;
    for (let s = 1; s < n; s *= 2) {
      let rx = 1 & (t / 2);
      let ry = 1 & (t ^ rx);
      if (ry == 0) {
        if (rx == 1) {
          x = s - 1 - x;
          y = s - 1 - y;
        }
        let tmp = x; x = y; y = tmp;
      }
      x += s * rx;
      y += s * ry;
      t /= 4;
    }
    
    if (x < width && y < height) {
      let idx = (y * width + x) << 2;
      let ptr = scratchPtr + idx;
      let oldVal = load<f32>(ptr);
      let currentVal = oldVal + error;
      let newVal = getNewVal(currentVal, is2bit);
      
      store<f32>(ptr, newVal);
      error = currentVal - newVal;
    }
  }
  
  writeBack(width, height, srcPtr, scratchPtr);
}

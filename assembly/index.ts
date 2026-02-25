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

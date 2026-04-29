/**
 * Minimal 1-component grayscale JPEG encoder.
 * Produces a standard JFIF baseline JPEG with components=1
 * that the XTEink X4 firmware accepts for cover images.
 * 
 * Implements: DCT-based JPEG with 8x8 blocks, Huffman coding,
 * single quantization table, single component.
 */

// Standard luminance quantization table (quality ~85)
const LUMA_QT = new Uint8Array([
   3,  2,  2,  3,  2,  2,  3,  3,
   3,  3,  4,  3,  3,  4,  5,  8,
   5,  5,  4,  4,  5, 10,  7,  7,
   6,  8, 12, 10, 12, 12, 11, 10,
  11, 11, 13, 14, 18, 16, 13, 14,
  17, 14, 11, 11, 16, 22, 16, 17,
  19, 20, 21, 21, 21, 12, 15, 23,
  24, 22, 20, 24, 18, 20, 21, 20
])

// Zigzag order
const ZIGZAG = new Uint8Array([
   0,  1,  8, 16,  9,  2,  3, 10,
  17, 24, 32, 25, 18, 11,  4,  5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13,  6,  7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63
])

// Standard DC Huffman table (luminance)
const DC_BITS = new Uint8Array([0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0])
const DC_VALS = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

// Standard AC Huffman table (luminance)
const AC_BITS = new Uint8Array([0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7D])
const AC_VALS = new Uint8Array([
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12,
  0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16,
  0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
  0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
  0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
  0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
  0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa
])

interface HuffTable {
  code: Uint16Array
  size: Uint8Array
}

function buildHuffTable(bits: Uint8Array, vals: Uint8Array): HuffTable {
  const code = new Uint16Array(256)
  const size = new Uint8Array(256)
  
  let k = 0
  let codeVal = 0
  for (let i = 1; i <= 16; i++) {
    for (let j = 0; j < bits[i]; j++) {
      code[vals[k]] = codeVal
      size[vals[k]] = i
      k++
      codeVal++
    }
    codeVal <<= 1
  }
  
  return { code, size }
}

// Precomputed cosine table for DCT
const COS_TABLE = new Float64Array(64)
for (let i = 0; i < 8; i++) {
  for (let j = 0; j < 8; j++) {
    COS_TABLE[i * 8 + j] = Math.cos(((2 * i + 1) * j * Math.PI) / 16)
  }
}

function fdct(block: Float64Array): void {
  const tmp = new Float64Array(64)
  
  // Rows
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      let sum = 0
      for (let k = 0; k < 8; k++) {
        sum += block[i * 8 + k] * COS_TABLE[k * 8 + j]
      }
      tmp[i * 8 + j] = sum
    }
  }
  
  // Columns
  for (let j = 0; j < 8; j++) {
    for (let i = 0; i < 8; i++) {
      let sum = 0
      for (let k = 0; k < 8; k++) {
        sum += tmp[k * 8 + j] * COS_TABLE[k * 8 + i]
      }
      const ci = i === 0 ? 1 / Math.SQRT2 : 1
      const cj = j === 0 ? 1 / Math.SQRT2 : 1
      block[i * 8 + j] = 0.25 * ci * cj * sum
    }
  }
}

class BitWriter {
  private buffer: Uint8Array
  private pos: number
  private bitBuf: number
  private bitCount: number
  
  constructor(initialSize: number) {
    this.buffer = new Uint8Array(initialSize)
    this.pos = 0
    this.bitBuf = 0
    this.bitCount = 0
  }
  
  private ensureCapacity(needed: number): void {
    if (this.pos + needed >= this.buffer.length) {
      const newBuf = new Uint8Array(this.buffer.length * 2)
      newBuf.set(this.buffer)
      this.buffer = newBuf
    }
  }
  
  writeByte(b: number): void {
    this.ensureCapacity(1)
    this.buffer[this.pos++] = b
  }
  
  writeBytes(bytes: Uint8Array): void {
    this.ensureCapacity(bytes.length)
    this.buffer.set(bytes, this.pos)
    this.pos += bytes.length
  }
  
  writeU16BE(v: number): void {
    this.ensureCapacity(2)
    this.buffer[this.pos++] = (v >> 8) & 0xFF
    this.buffer[this.pos++] = v & 0xFF
  }
  
  writeBits(value: number, numBits: number): void {
    this.bitBuf = (this.bitBuf << numBits) | value
    this.bitCount += numBits
    
    while (this.bitCount >= 8) {
      this.bitCount -= 8
      const b = (this.bitBuf >> this.bitCount) & 0xFF
      this.ensureCapacity(2)
      this.buffer[this.pos++] = b
      if (b === 0xFF) {
        this.buffer[this.pos++] = 0x00 // Byte stuffing
      }
    }
  }
  
  flushBits(): void {
    if (this.bitCount > 0) {
      this.writeBits(0x7F, 7 - this.bitCount + 1) // Pad with 1s
    }
  }
  
  getResult(): Uint8Array {
    return this.buffer.subarray(0, this.pos)
  }
}

function categoryAndBits(value: number): [number, number] {
  if (value === 0) return [0, 0]
  const abs = Math.abs(value)
  let cat = 0
  let tmp = abs
  while (tmp > 0) {
    cat++
    tmp >>= 1
  }
  const bits = value > 0 ? value : value + (1 << cat) - 1
  return [cat, bits]
}

/**
 * Encode grayscale pixel data as a true 1-component baseline JPEG.
 * @param pixels - Uint8Array of grayscale pixel values (1 byte per pixel)
 * @param width - Image width
 * @param height - Image height
 * @param quality - JPEG quality from 1 to 100 (default: 85)
 * @returns Uint8Array containing the complete JPEG file
 */
export function encodeGrayscaleJpeg(pixels: Uint8Array, width: number, height: number, quality: number = 85): Uint8Array {
  // Clamp quality
  quality = Math.max(1, Math.min(100, quality))
  
  // Calculate scaled quantization table
  let scale = 0
  if (quality < 50) {
    scale = Math.floor(5000 / quality)
  } else {
    scale = Math.floor(200 - quality * 2)
  }
  
  const scaledQt = new Uint8Array(64)
  for (let i = 0; i < 64; i++) {
    let val = Math.floor((LUMA_QT[i] * scale + 50) / 100)
    if (val < 1) val = 1
    if (val > 255) val = 255
    scaledQt[i] = val
  }

  const dcTable = buildHuffTable(DC_BITS, DC_VALS)
  const acTable = buildHuffTable(AC_BITS, AC_VALS)
  
  const w = new BitWriter(width * height + 1024)
  
  // SOI
  w.writeU16BE(0xFFD8)
  
  // APP0 (JFIF)
  w.writeU16BE(0xFFE0)
  w.writeU16BE(16) // length
  w.writeByte(0x4A); w.writeByte(0x46); w.writeByte(0x49); w.writeByte(0x46); w.writeByte(0x00) // "JFIF\0"
  w.writeByte(1); w.writeByte(1) // version 1.1
  w.writeByte(0) // aspect ratio units (0 = no units)
  w.writeU16BE(1) // X density
  w.writeU16BE(1) // Y density
  w.writeByte(0); w.writeByte(0) // no thumbnail
  
  // DQT
  w.writeU16BE(0xFFDB)
  w.writeU16BE(67) // length
  w.writeByte(0) // 8-bit precision, table 0
  for (let i = 0; i < 64; i++) {
    w.writeByte(scaledQt[ZIGZAG[i]])
  }
  
  // SOF0 (Baseline, 1 component)
  w.writeU16BE(0xFFC0)
  w.writeU16BE(11) // length
  w.writeByte(8) // precision
  w.writeU16BE(height)
  w.writeU16BE(width)
  w.writeByte(1) // 1 component
  w.writeByte(1) // component ID
  w.writeByte(0x11) // sampling 1x1
  w.writeByte(0) // quant table 0
  
  // DHT (DC table)
  w.writeU16BE(0xFFC4)
  w.writeU16BE(2 + 1 + 16 + DC_VALS.length) // length
  w.writeByte(0x00) // DC, table 0
  for (let i = 1; i <= 16; i++) w.writeByte(DC_BITS[i])
  w.writeBytes(DC_VALS)
  
  // DHT (AC table)
  w.writeU16BE(0xFFC4)
  w.writeU16BE(2 + 1 + 16 + AC_VALS.length) // length
  w.writeByte(0x10) // AC, table 0
  for (let i = 1; i <= 16; i++) w.writeByte(AC_BITS[i])
  w.writeBytes(AC_VALS)
  
  // SOS
  w.writeU16BE(0xFFDA)
  w.writeU16BE(8) // length
  w.writeByte(1) // 1 component
  w.writeByte(1) // component ID
  w.writeByte(0x00) // DC table 0, AC table 0
  w.writeByte(0) // Ss
  w.writeByte(63) // Se
  w.writeByte(0) // Ah/Al
  
  // Encode scan data
  const blocksX = Math.ceil(width / 8)
  const blocksY = Math.ceil(height / 8)
  const block = new Float64Array(64)
  let prevDC = 0
  
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      // Extract 8x8 block
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const px = Math.min(bx * 8 + x, width - 1)
          const py = Math.min(by * 8 + y, height - 1)
          block[y * 8 + x] = pixels[py * width + px] - 128
        }
      }
      
      // Forward DCT
      fdct(block)
      
      // Quantize
      const quantized = new Int16Array(64)
      for (let i = 0; i < 64; i++) {
        quantized[ZIGZAG[i]] = Math.round(block[i] / scaledQt[i])
      }
      
      // Encode DC coefficient
      const dc = quantized[0]
      const dcDiff = dc - prevDC
      prevDC = dc
      const [dcCat, dcBits] = categoryAndBits(dcDiff)
      w.writeBits(dcTable.code[dcCat], dcTable.size[dcCat])
      if (dcCat > 0) {
        w.writeBits(dcBits, dcCat)
      }
      
      // Encode AC coefficients
      let zeroRun = 0
      for (let i = 1; i < 64; i++) {
        if (quantized[i] === 0) {
          zeroRun++
        } else {
          while (zeroRun >= 16) {
            w.writeBits(acTable.code[0xF0], acTable.size[0xF0]) // ZRL
            zeroRun -= 16
          }
          const [acCat, acBits] = categoryAndBits(quantized[i])
          const sym = (zeroRun << 4) | acCat
          w.writeBits(acTable.code[sym], acTable.size[sym])
          w.writeBits(acBits, acCat)
          zeroRun = 0
        }
      }
      if (zeroRun > 0) {
        w.writeBits(acTable.code[0x00], acTable.size[0x00]) // EOB
      }
    }
  }
  
  w.flushBits()
  
  // EOI
  w.writeU16BE(0xFFD9)
  
  return w.getResult()
}

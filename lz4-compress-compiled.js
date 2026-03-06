"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compressXtczLz4 = compressXtczLz4;
exports.decompressXtczLz4 = decompressXtczLz4;
var lz4js_1 = require("lz4js");
function writeU32LE(val) {
    var b = new Uint8Array(4);
    b[0] = val & 255;
    b[1] = (val >>> 8) & 255;
    b[2] = (val >>> 16) & 255;
    b[3] = (val >>> 24) & 255;
    return b;
}
function writeU16LE(val) {
    var b = new Uint8Array(2);
    b[0] = val & 255;
    b[1] = (val >>> 8) & 255;
    return b;
}
/**
 * Compresses an uncompressed XTC ArrayBuffer into the XTCZ (LZ4) format
 * compatible with the XTEink reader hardware.
 */
function compressXtczLz4(uncompressedData) {
    var e = uncompressedData instanceof Uint8Array ? uncompressedData : new Uint8Array(uncompressedData);
    var t = e.length;
    var n = 4096; // XTZ4_BLOCK_SIZE
    var a = [];
    // Magic 'XTZ4'
    a.push(new Uint8Array([88, 84, 90, 52]));
    a.push(writeU32LE(t)); // Uncompressed size
    a.push(writeU32LE(n)); // Block size
    // Unknown header fields required by the reader
    var numChunks = Math.ceil(t / n);
    a.push(writeU32LE(numChunks));
    a.push(writeU16LE(1010));
    var r = 65536;
    var i = new Array(r);
    for (var o = 0; o < r; o++)
        i[o] = 0;
    for (var l = 0; l < t;) {
        var s = Math.min(n, t - l);
        var g = lz4js_1.default.compressBound(s);
        var d = new Uint8Array(g);
        for (var u = 0; u < r; u++)
            i[u] = 0;
        var c = lz4js_1.default.compressBlock(e, d, l, s, i);
        if (c > 0 && c < s) {
            a.push(writeU32LE(c));
            a.push(d.slice(0, c));
        }
        else {
            // High bit set indicates uncompressed chunk
            a.push(writeU32LE(2147483648 | s));
            a.push(e.slice(l, l + s));
        }
        l += s;
    }
    var totalLength = 0;
    for (var _i = 0, a_1 = a; _i < a_1.length; _i++) {
        var buf = a_1[_i];
        totalLength += buf.length;
    }
    var result = new Uint8Array(totalLength);
    var offset = 0;
    for (var _a = 0, a_2 = a; _a < a_2.length; _a++) {
        var buf = a_2[_a];
        result.set(buf, offset);
        offset += buf.length;
    }
    return result.buffer;
}
/**
 * Decompresses an XTCZ (LZ4) ArrayBuffer back into its original uncompressed XTC payload.
 */
function decompressXtczLz4(compressedData) {
    var e = compressedData instanceof Uint8Array ? compressedData : new Uint8Array(compressedData);
    if (e.length < 18)
        throw new Error("Invalid XTCZ: file too small");
    // Verify magic 'XTZ4'
    if (e[0] !== 88 || e[1] !== 84 || e[2] !== 90 || e[3] !== 52) {
        throw new Error("Invalid XTCZ: bad magic number");
    }
    var view = new DataView(e.buffer, e.byteOffset, e.length);
    var uncompressedSize = view.getUint32(4, true);
    var numChunks = view.getUint32(12, true);
    var result = new Uint8Array(uncompressedSize);
    var readOffset = 18;
    var writeOffset = 0;
    for (var i = 0; i < numChunks; i++) {
        if (readOffset >= e.length)
            break;
        var descriptor = view.getUint32(readOffset, true);
        readOffset += 4;
        // JS bitwise operators work on 32-bit signed integers. 
        // We use unsigned right shift to safely check the highest bit.
        var isUncompressed = (descriptor >>> 31) !== 0;
        var size = descriptor & 0x7FFFFFFF;
        if (readOffset + size > e.length) {
            throw new Error("Invalid XTCZ: chunk data out of bounds at chunk ".concat(i));
        }
        var chunkData = e.subarray(readOffset, readOffset + size);
        readOffset += size;
        if (isUncompressed) {
            result.set(chunkData, writeOffset);
            writeOffset += size;
        }
        else {
            writeOffset = lz4js_1.default.decompressBlock(chunkData, result, 0, size, writeOffset);
        }
    }
    return result.buffer;
}

"use strict";
// XTC format reader/parser for XTEink X4 e-reader
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseXtcFile = parseXtcFile;
exports.getXtcPageCount = getXtcPageCount;
exports.decodeXtcPageToCanvas = decodeXtcPageToCanvas;
exports.extractXtcPages = extractXtcPages;
exports.extractXtcRawPages = extractXtcRawPages;
var decompressXtczLz4 = require('./lz4-compress-compiled.cjs').decompressXtczLz4;
/**
 * Helper to check if a buffer is XTCZ and decompress if necessary
 */
function getDecompressedBuffer(buffer) {
    if (buffer.byteLength >= 4) {
        var uint8 = new Uint8Array(buffer, 0, 4);
        if (uint8[0] === 88 && uint8[1] === 84 && uint8[2] === 90 && uint8[3] === 52) { // XTZ4
            return { buffer: decompressXtczLz4(buffer), isXtcz: true };
        }
    }
    return { buffer: buffer, isXtcz: false };
}
/**
 * Parse XTC file header (48-56 bytes)
 */
function parseXtcHeader(view) {
    var uint8 = new Uint8Array(view.buffer, view.byteOffset, 4);
    var magic = String.fromCharCode(uint8[0], uint8[1], uint8[2]);
    var is2bit = uint8[3] === 0x48 || uint8[3] === 0x68; // 'H' or 'h'
    if (magic !== 'XTC') {
        throw new Error('Invalid XTC file: bad magic number');
    }
    var flagsLow = view.getUint32(8, true);
    var hasMetadata = flagsLow !== 0;
    return {
        magic: magic,
        is2bit: is2bit,
        version: view.getUint16(4, true),
        pageCount: view.getUint16(6, true),
        hasMetadata: hasMetadata,
        metadataOffset: getBigUint64(view, 16),
        indexOffset: getBigUint64(view, 24),
        dataOffset: getBigUint64(view, 32),
        tocOffset: hasMetadata && view.byteLength >= 56 ? getBigUint64(view, 48) : 0n,
    };
}
/**
 * Parse null-terminated string from ArrayBuffer
 */
function readNullTerminatedString(view, offset, maxLength) {
    var bytes = new Uint8Array(view.buffer, view.byteOffset + offset, maxLength);
    var len = 0;
    while (len < maxLength && bytes[len] !== 0) {
        len++;
    }
    return new TextDecoder('utf-8').decode(bytes.subarray(0, len));
}
/**
 * Parse XTC metadata
 */
function parseMetadata(view, header) {
    var metadata = { toc: [] };
    if (!header.hasMetadata || header.metadataOffset === 0n)
        return metadata;
    var metaOffset = Number(header.metadataOffset);
    metadata.title = readNullTerminatedString(view, metaOffset, 128);
    metadata.author = readNullTerminatedString(view, metaOffset + 128, 64);
    metadata.publisher = readNullTerminatedString(view, metaOffset + 192, 32);
    metadata.language = readNullTerminatedString(view, metaOffset + 224, 16);
    var tocHeaderOffset = metaOffset + 240;
    metadata.createTime = view.getUint32(tocHeaderOffset, true);
    metadata.coverPage = view.getUint16(tocHeaderOffset + 4, true);
    var chapterCount = view.getUint16(tocHeaderOffset + 6, true);
    var tocOffset = header.tocOffset !== 0n ? Number(header.tocOffset) : tocHeaderOffset + 16;
    for (var i = 0; i < chapterCount; i++) {
        var entryOffset = tocOffset + i * 96;
        var title = readNullTerminatedString(view, entryOffset, 80);
        var startPage = view.getUint16(entryOffset + 80, true);
        var endPage = view.getUint16(entryOffset + 82, true);
        metadata.toc.push({ title: title, startPage: startPage, endPage: endPage });
    }
    return metadata;
}
/**
 * Parse XTC index entry (16 bytes each)
 */
function parseIndexEntry(view, offset) {
    return {
        offset: getBigUint64(view, offset),
        size: view.getUint32(offset + 8, true),
        width: view.getUint16(offset + 12, true),
        height: view.getUint16(offset + 14, true),
    };
}
/**
 * Parse an XTC file and extract all page data
 */
function parseXtcFile(inputBuffer) {
    return __awaiter(this, void 0, Promise, function () {
        var _a, buffer, isXtcz, view, header, metadata, entries, indexOffset, i, entryOffset, pageData, _i, entries_1, entry, offset, data;
        return __generator(this, function (_b) {
            _a = getDecompressedBuffer(inputBuffer), buffer = _a.buffer, isXtcz = _a.isXtcz;
            view = new DataView(buffer);
            header = parseXtcHeader(view);
            header.isXtcz = isXtcz;
            metadata = parseMetadata(view, header);
            entries = [];
            indexOffset = Number(header.indexOffset);
            for (i = 0; i < header.pageCount; i++) {
                entryOffset = indexOffset + i * 16;
                entries.push(parseIndexEntry(view, entryOffset));
            }
            pageData = [];
            for (_i = 0, entries_1 = entries; _i < entries_1.length; _i++) {
                entry = entries_1[_i];
                offset = Number(entry.offset);
                data = buffer.slice(offset, offset + entry.size);
                pageData.push(data);
            }
            return [2 /*return*/, { header: header, metadata: metadata, entries: entries, pageData: pageData, rawBuffer: buffer }];
        });
    });
}
/**
 * Get page count from XTC file without parsing all data
 */
function getXtcPageCount(inputBuffer) {
    return __awaiter(this, void 0, Promise, function () {
        var buffer, view, header;
        return __generator(this, function (_a) {
            buffer = getDecompressedBuffer(inputBuffer).buffer;
            view = new DataView(buffer);
            header = parseXtcHeader(view);
            return [2 /*return*/, header.pageCount];
        });
    });
}
/**
 * Decode XTG or XTH page data to canvas
 */
function decodeXtcPageToCanvas(pageBuffer) {
    var view = new DataView(pageBuffer);
    var uint8 = new Uint8Array(pageBuffer);
    // Verify magic
    var magic = String.fromCharCode(uint8[0], uint8[1], uint8[2]);
    var is2bit = magic === 'XTH';
    if (magic !== 'XTG' && magic !== 'XTH') {
        throw new Error('Invalid page data: bad magic number ' + magic);
    }
    var width = view.getUint16(4, true);
    var height = view.getUint16(6, true);
    var headerSize = 22;
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    var imageData = ctx.createImageData(width, height);
    var data = imageData.data;
    if (is2bit) {
        var colBytes = Math.ceil(height / 8);
        var planeSize = colBytes * width;
        var p0 = new Uint8Array(pageBuffer, headerSize, planeSize);
        var p1 = new Uint8Array(pageBuffer, headerSize + planeSize, planeSize);
        for (var x = 0; x < width; x++) {
            var targetCol = width - 1 - x;
            var colOffset = targetCol * colBytes;
            for (var y = 0; y < height; y++) {
                var byteIdx = colOffset + (y >> 3);
                var bitIdx = 7 - (y % 8);
                var bit0 = (p0[byteIdx] >> bitIdx) & 1;
                var bit1 = (p1[byteIdx] >> bitIdx) & 1;
                var val = bit0 | (bit1 << 1);
                var color = 255;
                if (val === 0)
                    color = 255;
                else if (val === 1)
                    color = 170;
                else if (val === 2)
                    color = 85;
                else
                    color = 0;
                var idx = (y * width + x) * 4;
                data[idx] = color;
                data[idx + 1] = color;
                data[idx + 2] = color;
                data[idx + 3] = 255;
            }
        }
    }
    else {
        var pixelDataSize = view.getUint32(10, true);
        var pixelData = new Uint8Array(pageBuffer, headerSize, pixelDataSize);
        var rowBytes = Math.ceil(width / 8);
        for (var y = 0; y < height; y++) {
            for (var x = 0; x < width; x++) {
                var byteIndex = y * rowBytes + Math.floor(x / 8);
                var bitIndex = 7 - (x % 8);
                var bit = (pixelData[byteIndex] >> bitIndex) & 1;
                var idx = (y * width + x) * 4;
                var color = bit ? 255 : 0;
                data[idx] = color;
                data[idx + 1] = color;
                data[idx + 2] = color;
                data[idx + 3] = 255;
            }
        }
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
}
/**
 * Extract all pages from XTC as canvases
 */
function extractXtcPages(buffer) {
    return __awaiter(this, void 0, Promise, function () {
        var parsed;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, parseXtcFile(buffer)];
                case 1:
                    parsed = _a.sent();
                    return [2 /*return*/, parsed.pageData.map(function (data) { return decodeXtcPageToCanvas(data); })];
            }
        });
    });
}
/**
 * Extract raw XTG page data from XTC (for direct copy during merge)
 */
function extractXtcRawPages(buffer) {
    return __awaiter(this, void 0, Promise, function () {
        var parsed;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, parseXtcFile(buffer)];
                case 1:
                    parsed = _a.sent();
                    return [2 /*return*/, parsed.pageData];
            }
        });
    });
}
/**
 * Helper to read 64-bit unsigned integer (little-endian)
 */
function getBigUint64(view, offset) {
    var low = view.getUint32(offset, true);
    var high = view.getUint32(offset + 4, true);
    return BigInt(low) + (BigInt(high) << 32n);
}

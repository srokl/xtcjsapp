const lz4 = require('lz4js');

// Test decompressBlock return value.
const uncomp = new Uint8Array([88, 84, 67, 0]);
const comp = new Uint8Array(lz4.compressBound(4));
const size = lz4.compressBlock(uncomp, comp, 0, 4, new Array(65536).fill(0));

const dest = new Uint8Array(10);
const res = lz4.decompressBlock(comp, dest, 0, size, 0);
console.log("Returned:", res);
console.log("Dest:", dest.slice(0, res));

const lz4 = require('lz4js');

// Testing decompressBlock to see if it correctly writes starting at dIndex and returns the final dIndex.
const uncomp = new Uint8Array(100).fill(2);
const comp = new Uint8Array(200);
const csize = lz4.compressBlock(uncomp, comp, 0, uncomp.length, new Array(65536).fill(0));

const dest = new Uint8Array(200);
const finalDestIndex = lz4.decompressBlock(comp, dest, 0, csize, 50); // Start writing at index 50
console.log('finalDestIndex (expected 150):', finalDestIndex);

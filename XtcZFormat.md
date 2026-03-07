# XTCZ Format Specification

## Overview

The XTCZ format is an experimental, compressed extension of the XTC (eXtreme Tiny Comic) and XTCH formats, designed for e-ink devices like the XTEink series. It uses the fast LZ4 block compression algorithm to significantly reduce file sizes while maintaining rapid decoding speeds suitable for low-power hardware.

An XTCZ file acts as a compressed wrapper around a fully formed, uncompressed XTC or XTCH payload.

## File Structure

An XTCZ file consists of a fixed-size header followed by a sequence of LZ4-compressed chunks.

### 1. XTZ4 Header

The file begins with a 12-byte header, all multi-byte integers are in Little-Endian format:

| Offset | Size (Bytes) | Type   | Description                                                                                             |
| :----: | :----------: | :----- | :------------------------------------------------------------------------------------------------------ |
| `0x00` |      4       | `char` | Magic string: `XTZ4` (0x58 0x54 0x5a 0x34)                                                              |
| `0x04` |      4       | `uint32`| **Uncompressed Size**: The total size of the underlying XTC payload in bytes.                           |
| `0x08` |      4       | `uint32`| **Block Size**: The maximum uncompressed size of each chunk. Typically `4096` (4 KB).                   |

### 2. Compressed Chunk Stream

Immediately following the header (starting at offset `0x0C` / 12 bytes), the file contains the LZ4 chunk stream.

The uncompressed payload is divided into logical blocks of `Block Size` (e.g., 4096 bytes). Each block is then compressed independently using the standard LZ4 block algorithm and written sequentially to the file.

Each chunk is preceded by a 4-byte header indicating its compressed size and compression status:

| Offset   | Size (Bytes) | Type   | Description                                                                                                                                                                                                                                                                                         |
| :------: | :----------: | :----- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x00`   |      4       | `uint32`| **Chunk Descriptor**: The highest bit (Bit 31) acts as an uncompressed flag. The remaining 31 bits represent the size of the payload following this descriptor.<br><br>• If Bit 31 is `0`: The chunk is LZ4 compressed, and the size indicates the compressed byte length.<br>• If Bit 31 is `1`: The chunk could not be compressed efficiently. The payload is stored raw (uncompressed), and the size indicates the uncompressed byte length. |
| `0x04`   |   Variable   | `byte[]`| **Chunk Data**: The LZ4-compressed block, or raw uncompressed data.                                                                                                                                                                                                                                  |

This chunk pattern (`[Chunk Descriptor] [Chunk Data]`) repeats until the end of the file.

## Decompression Logic

To decode an XTCZ file:

1. Read the 12-byte header and verify the `XTZ4` magic string.
2. Extract the `Uncompressed Size` and `Block Size`.
3. Allocate a destination buffer of `Uncompressed Size`.
4. Loop through the chunks until the destination buffer is full:
   - Read the 4-byte `Chunk Descriptor`.
   - Determine if the chunk is compressed (MSB == 0).
   - Extract the length (Descriptor & `0x7FFFFFFF`).
   - Read `length` bytes of `Chunk Data`.
   - If compressed, apply standard LZ4 block decompression and append to the destination buffer.
   - If uncompressed, copy the raw bytes directly to the destination buffer.
5. The resulting buffer is a valid, raw XTC or XTCH file, which can then be parsed according to the standard XTC format specification.

## Compatibility

- Requires device firmware versions **5.1.6 or higher**.
- Files utilizing 2-bit grayscale (`.xtch`) can also be compressed using this wrapper, although the resulting file extension remains `.xtcz` to denote compression.

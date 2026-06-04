# XTF v0 Font Format Specification

The XTF (XTEink Font) format is a proprietary binary font format designed for high-performance rendering on e-ink hardware. It supports 2-bit grayscale antialiasing, proportional character spacing, and memory-mapped glyph access.

## 1. File Structure Overview

An XTF file consists of four primary sections:
1. **Header (64 bytes)**: Global font metrics, offsets, and checksums.
2. **Mapping Table**: A list of Unicode ranges and their corresponding glyph indices.
3. **ASCII Fast-Path Table**: An 8219-byte lookup table for U+0020–U+203A font-metric advance widths.
4. **Glyph Data Section**: Fixed-size blocks containing per-glyph metadata and pixel data.

---

## 2. Header Specification (0x00 - 0x3F)

All multi-byte values are **Little-Endian**.

| Offset | Size | Field Name | Description |
| :--- | :--- | :--- | :--- |
| 0x00 | 4 | Magic | Always `58 54 46 30` ("XTF0"). |
| 0x04 | 4 | Flags | System flags. Default: `0x02400501`. |
| 0x08 | 2 | SubType | Encoding/Bit-depth. `0x0003` for 2-bit grayscale. |
| 0x0A | 1 | Max Width | Maximum character cell width (px). Determines stride and block size. |
| 0x0B | 1 | Max Height | Maximum character cell height (px). |
| 0x0C | 1 | Ascent | Distance from baseline to top. Font-specific metric from the font's OS/2 or hhea table, scaled to pixel size. |
| 0x0D | 1 | Cell Width | Default advance width for CJK fixed-grid spacing. Always equals Max Width (0x0A). The device uses this value for non-ASCII character advancement. |
| 0x0E | 1 | Scaling Factor | Internal font scaling. Typically `ceil(Height / 2)`. |
| 0x0F | 1 | Reserved | Always `0x00`. |
| 0x10 | 2 | First Unicode | The first character with glyph data (e.g., `0x0020` for Space). |
| 0x12 | 2 | Descender | Signed value for distance below baseline. Font-specific metric (e.g., `-8`). |
| 0x14 | 4 | Num Entries | Number of ranges in the Mapping Table. |
| 0x18 | 4 | Total Glyphs | Total number of glyphs stored in the data section. |
| 0x1C | 4 | Table Offset | Offset to the Mapping Table. Always `0x00000040`. |
| 0x20 | 4 | Reserved | Always `0x00000000`. |
| 0x24 | 4 | Data Offset | Alignment-safe offset to Glyph Data. Aligned to the next power-of-2 boundary that fits the mapping table and fast-path data (e.g., `0x00000800` or `0x00004000`). |
| 0x28 | 4 | Block Size | Total size of one glyph block (`2 + stride * height`). |
| 0x2C | 4 | Data size | Total size of the Glyph Data section. |
| 0x30 | 4 | Data CRC32 | CRC32 of the entire Glyph Data section. |
| 0x34 | 4 | Header CRC32 | CRC32 of header bytes `0x00` through `0x33`. |
| 0x38 | 4 | Table End | Offset where the Mapping Table ends (`0x40 + NumEntries * 16`). |
| 0x3C | 4 | Range 0 Count | Character count of the first Unicode range. |

---

## 3. Mapping Table (Starts at 0x40)

Each entry is 16 bytes. It allows the hardware to find a glyph index for a given Unicode codepoint via binary search.

| Offset | Size | Description |
| :--- | :--- | :--- |
| +0 | 4 | **Start Unicode**: The beginning of the character range. |
| +4 | 4 | **Count**: Number of characters in this range. |
| +8 | 4 | **Base Index**: Glyph data index for the first char in range. |
| +12 | 4 | **Flags**: Lower 16 bits reserved; upper 16 bits contain `Count`. |

---

## 4. ASCII Fast-Path Table

Located in the "gap" immediately following the Mapping Table (at the offset specified in `0x38`).
- **Size**: 8219 bytes.
- **Content**: **Font-metric advance widths** for `U+0020` (Space) through `U+203A` (›). These values represent the true typographic advance (including sidebearings) and may differ from the rendered bitmap width stored in each glyph block's prefix byte.
- **Coverage**: All 8219 entries (`U+0020`–`U+203A`) are populated when glyphs exist. This covers Basic Latin, Latin-1 Supplement (é, ñ, ü), Latin Extended-A/B (Ĉ, ƒ, ȳ), and General Punctuation (smart quotes ' ' " ", em/en dashes — –, ellipsis …, bullet •, guillemets ‹ ›).
- **Purpose**: The device reads this table for instant Latin character **text layout spacing** without parsing individual glyph headers.

---

## 5. Glyph Data Section

The data section is composed of concatenated **fixed-size blocks**. Even if a glyph is narrow, its storage occupies the full `Block Size`.

### Glyph Block Structure
| Offset | Size | Description |
| :--- | :--- | :--- |
| +0 | 1 | **Bitmap Width**: The rendered pixel width of the actual glyph bitmap. For ASCII characters, this may be smaller than the font-metric advance width stored in the fast-path table (which includes sidebearings). For non-ASCII proportional glyphs, this is also the advance width. |
| +1 | 1 | **Flags**: Typically `0x00`. |
| +2 | Var | **Pixel Data**: 2-bit grayscale bitmaps. |

### Pixel Packing (2-bit MSB-first)
Pixels are packed 4 per byte. `0x00` is transparent/white, `0x03` is solid black.
- **Byte Bit Structure**: `[P0_high P0_low P1_high P1_low P2_high P2_low P3_high P3_low]`
- **Stride**: `Width / 4` (rounded up to nearest integer). Each row must start on a new byte boundary.

---

## 6. Implementation Notes

- **Dual Advance Width Model**:
  - The XTF format uses **two separate advance width values** for ASCII characters:
    1. **Fast-path table advance** (Section 4): The true font-metric advance width including left and right sidebearings. Used by the device for **text layout** (pen cursor advancement).
    2. **Glyph block prefix byte** (Section 5): The rendered bitmap pixel width. Used for **bitmap rendering** (how many pixels to draw from the left edge of the cell).
  - For most punctuation and digits, these values are identical. For letters, the fast-path advance is typically 1–3px larger than the bitmap width.
  - For non-ASCII characters (CJK, etc.), only the glyph block prefix byte is used.

- **Alignment & Advance Strategies**:
  - **Proportional Glyphs (ASCII / Sideways Vertical)**: These must be **left-aligned** within their fixed-size block. The `Bitmap Width` is set to the rendered pixel width. The device uses the fast-path advance for layout and draws from the left edge of the cell.
  - **Fixed-Width Glyphs (CJK / Upright Vertical)**: These must be **centered** horizontally and vertically within the block. The `Bitmap Width` MUST equal the `Cell Width` (maximum cell size) to ensure proper fixed grid spacing.
- **Vertical Reading Mode**: The XTF hardware does not have a native "vertical flow" rendering instruction. It always renders text horizontally left-to-right. Vertical mode is achieved by the user physically rotating the e-reader 90 degrees clockwise. 
  - Therefore, proportional ASCII characters generated for a vertical font will have their left-aligned edge become the "top" edge on the screen, and their horizontal advance width perfectly translates into vertical spacing down the column.
- **Data Offset Alignment**: The `Data Offset` (0x24) should be padded to the next power-of-2 boundary that fits the mapping table and fast-path data (e.g., `0x0800` for small tables, `0x4000` for larger ones) to facilitate fast hardware DMA transfers.
- **Checksums**: Standard CRC32 polynomial `0xEDB88320`. The header CRC (0x34) must be calculated *after* the data CRC (0x30) is written into the buffer.
- **Stride Padding**: Ensure `Width` is a multiple of 4. Stride is calculated as `Width / 4`. Any remainder will cause pixel row-drift (smearing).

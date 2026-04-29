/**
 * EPUB Image Optimizer for XTEink X4
 * 
 * Reads an EPUB file, converts images to 1-bit XTG format at their
 * original dimensions, and repacks the EPUB with the proper structure
 * required by the XTEink firmware:
 * 
 * 1. `mimetype` must be first entry, STORED (uncompressed)
 * 2. All `.xtg` files must be STORED (uncompressed)
 * 3. `META-INF/xtg-companion.flag` with content "xtg=1" must exist
 * 4. Cover image must be kept as original JPEG
 * 5. XHTML/OPF references kept as-is (firmware auto-resolves .xtg)
 */

import { ZipReader, BlobReader, BlobWriter, ZipWriter, Uint8ArrayWriter, TextReader, Uint8ArrayReader } from '@zip.js/zip.js'
import { imageDataToXtg } from './xtc-format'
import { encodeGrayscaleJpeg } from './grayscale-jpeg'
import { toGrayscale, applyContrast, applyGamma, applyInvert } from './processing/image'
import { applyDitheringToData } from './processing/dithering'
import { sharedCanvasPool } from './processing/canvas'

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|bmp|webp|tiff?)$/i

export interface EpubOptimizeOptions {
  dithering: string
  contrast: number
  gamma: number
  invert: boolean
}

export interface EpubOptimizeResult {
  name: string
  data?: ArrayBuffer
  size?: number
  imageCount: number
  convertedCount: number
  skippedCover: boolean
  error?: string
}

/**
 * Parse the OPF manifest to find the cover image filename.
 */
function findCoverImage(opfContent: string, opfPath: string): string | null {
  const opfDir = opfPath.replace(/[^/]*$/, '')

  // Method 1: <item ... properties="cover-image" ... href="..."/>
  const coverPropMatch = opfContent.match(/<item[^>]+properties\s*=\s*"[^"]*cover-image[^"]*"[^>]*href\s*=\s*"([^"]+)"/i)
    || opfContent.match(/<item[^>]+href\s*=\s*"([^"]+)"[^>]*properties\s*=\s*"[^"]*cover-image[^"]*"/i)
  if (coverPropMatch) {
    return opfDir + coverPropMatch[1]
  }

  // Method 2: <meta name="cover" content="ID"/> → <item id="ID" href="..."/>
  const metaCoverMatch = opfContent.match(/<meta\s+name\s*=\s*"cover"\s+content\s*=\s*"([^"]+)"/i)
  if (metaCoverMatch) {
    const coverId = metaCoverMatch[1]
    const idPattern = new RegExp(`<item[^>]+id\\s*=\\s*"${coverId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]+href\\s*=\\s*"([^"]+)"`, 'i')
    const itemMatch = opfContent.match(idPattern)
    if (itemMatch) {
      return opfDir + itemMatch[1]
    }
  }

  return null
}

/**
 * Ensures the OPF <metadata> section contains a <meta name="cover" content="COVER_ID"/> tag.
 * Required by some older XTEink firmware that ignores properties="cover-image".
 */
function ensureCoverMeta(opfContent: string): string {
  let coverIdMatch = opfContent.match(/<item[^>]+id="([^"]+)"[^>]+properties="[^"]*cover-image[^"]*"/i)
  if (!coverIdMatch) {
    coverIdMatch = opfContent.match(/<item[^>]*id="([^"]+)"[^>]*href="[^"]*cover[^"]*"[^>]*media-type="image\//i)
  }
  const coverId = coverIdMatch ? coverIdMatch[1] : null

  if (!coverId) return opfContent
  if (opfContent.includes('name="cover"')) return opfContent
  
  const idx = opfContent.indexOf('</metadata>')
  if (idx === -1) return opfContent
  
  return opfContent.substring(0, idx) + `    <meta name="cover" content="${coverId}"/>\n  </metadata>` + opfContent.substring(idx + 11)
}

/**
 * Convert a single image to 1-bit XTG.
 * Images wider than the X4 content width (440px) are scaled down to fit.
 * Small inline images (icons, dashes) are kept at original dimensions.
 */
const X4_CONTENT_WIDTH = 440

async function convertImageToXtg(
  imageData: Uint8Array,
  options: EpubOptimizeOptions
): Promise<ArrayBuffer> {
  const blob = new Blob([imageData])
  const bitmap = await createImageBitmap(blob)
  const srcW = bitmap.width
  const srcH = bitmap.height

  // Scale down to X4 content width if image is wider
  let targetW = srcW
  let targetH = srcH
  if (srcW > X4_CONTENT_WIDTH) {
    const scale = X4_CONTENT_WIDTH / srcW
    targetW = X4_CONTENT_WIDTH
    targetH = Math.round(srcH * scale)
  }

  const canvas = sharedCanvasPool.acquire(targetW, targetH)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0, targetW, targetH)
  bitmap.close()

  // Apply filters using ctx-based API
  toGrayscale(ctx, targetW, targetH)
  if (options.contrast > 0) applyContrast(ctx, targetW, targetH, options.contrast)
  if (options.gamma !== 1.0) applyGamma(ctx, targetW, targetH, options.gamma)
  if (options.invert) applyInvert(ctx, targetW, targetH)

  // Apply dithering if requested
  if (options.dithering !== 'none') {
    const imgData = ctx.getImageData(0, 0, targetW, targetH)
    applyDitheringToData(imgData.data, targetW, targetH, options.dithering, false, false)
    ctx.putImageData(imgData, 0, 0)
  }

  // Get final image data and pack to XTG
  const imgData = ctx.getImageData(0, 0, targetW, targetH)
  const xtgBuffer = imageDataToXtg(imgData)
  sharedCanvasPool.release(canvas)
  return xtgBuffer
}

/**
 * Convert cover image to true 1-component grayscale JPEG.
 * The XTEink firmware requires components=1 baseline JPEG.
 * Cover is also resized to half dimensions (matching reference behavior).
 */
async function convertCoverToGrayscaleJpeg(
  imageData: Uint8Array
): Promise<Uint8Array> {
  const blob = new Blob([imageData])
  const bitmap = await createImageBitmap(blob)

  // Cover size
  const targetW = 800
  const targetH = Math.round(bitmap.height * (800 / bitmap.width))

  const canvas = sharedCanvasPool.acquire(targetW, targetH)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0, targetW, targetH)
  bitmap.close()

  // Extract grayscale pixel data (1 byte per pixel)
  const imgData = ctx.getImageData(0, 0, targetW, targetH)
  const rgba = imgData.data
  const grayPixels = new Uint8Array(targetW * targetH)
  for (let i = 0; i < grayPixels.length; i++) {
    const r = rgba[i * 4]
    const g = rgba[i * 4 + 1]
    const b = rgba[i * 4 + 2]
    grayPixels[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  }

  sharedCanvasPool.release(canvas)

  // Encode as true 1-component grayscale JPEG with 30% quality
  return encodeGrayscaleJpeg(grayPixels, targetW, targetH, 30)
}

/**
 * Process an EPUB file: convert images to XTG with proper EPUB+XTG structure.
 */
export async function optimizeEpubImages(
  file: File,
  options: EpubOptimizeOptions,
  onProgress: (progress: number, status: string) => void
): Promise<EpubOptimizeResult> {
  const baseName = file.name.replace(/\.epub$/i, '')

  try {
    onProgress(0, 'Reading EPUB...')
    const zipReader = new ZipReader(new BlobReader(file))
    const entries = await zipReader.getEntries()

    // --- Detect cover image via OPF ---
    let coverImagePath: string | null = null
    const containerEntry = entries.find(e => e.filename === 'META-INF/container.xml')
    if (containerEntry && containerEntry.getData) {
      const containerData = await containerEntry.getData(new Uint8ArrayWriter())
      const containerText = new TextDecoder().decode(containerData)
      const opfMatch = containerText.match(/full-path\s*=\s*"([^"]+\.opf)"/i)
      if (opfMatch) {
        const opfPath = opfMatch[1]
        const opfEntry = entries.find(e => e.filename === opfPath)
        if (opfEntry && opfEntry.getData) {
          const opfData = await opfEntry.getData(new Uint8ArrayWriter())
          const opfText = new TextDecoder().decode(opfData)
          coverImagePath = findCoverImage(opfText, opfPath)
          if (coverImagePath) {
            console.log(`[EPUB] Cover image detected: ${coverImagePath}`)
          }
        }
      }
    }

    // --- Categorize entries ---
    const imageEntries: typeof entries = []
    const otherEntries: typeof entries = []
    let coverEntry: typeof entries[0] | null = null
    let skippedCover = false

    for (const entry of entries) {
      // Skip mimetype — we'll write it first manually
      if (entry.filename === 'mimetype') continue
      // Skip any existing xtg-companion.flag — we'll add our own
      if (entry.filename === 'META-INF/xtg-companion.flag') continue

      if (!entry.directory && entry.filename && IMAGE_EXTENSIONS.test(entry.filename)) {
        if (coverImagePath && entry.filename === coverImagePath) {
          coverEntry = entry // Track cover separately
          skippedCover = true
          console.log(`[EPUB] Cover detected: ${entry.filename} — will convert to grayscale JPEG`)
        } else {
          imageEntries.push(entry)
        }
      } else {
        otherEntries.push(entry)
      }
    }

    onProgress(0.05, `Found ${imageEntries.length} images to convert${skippedCover ? ' (cover → grayscale JPEG)' : ''}`)

    // --- Build output ZIP with proper structure ---
    const blobWriter = new BlobWriter('application/epub+zip')
    // Set zip64: false to ensure strict EPUB standard compliance (no Zip64 extra fields)
    const zipWriter = new ZipWriter(blobWriter, { zip64: false })

    // 1. Write mimetype FIRST, STORED (uncompressed), no extra field
    // Using TextReader so the size is known immediately, preventing data descriptors
    await zipWriter.add('mimetype', new TextReader('application/epub+zip'), {
      level: 0,       // STORED — no compression
      extendedTimestamp: false,
    })

    // 2. Write META-INF/xtg-companion.flag — STORED
    await zipWriter.add('META-INF/xtg-companion.flag', new TextReader('xtg=1'), {
      level: 0,
      extendedTimestamp: false,
    })

    // 3. Copy all non-image files (XHTML, CSS, OPF, NCX)
    for (let i = 0; i < otherEntries.length; i++) {
      const entry = otherEntries[i]
      if (entry.getData) {
        let data = await entry.getData(new Uint8ArrayWriter())
        
        // If this is the OPF file, ensure it has the cover meta tag
        if (entry.filename.endsWith('.opf')) {
          let opfText = new TextDecoder().decode(data)
          opfText = ensureCoverMeta(opfText)
          data = new TextEncoder().encode(opfText)
        }

        await zipWriter.add(entry.filename, new Uint8ArrayReader(data), {
          extendedTimestamp: false,
        })
      }
    }

    // 4. Convert cover to grayscale JPEG and write it (keeping original filename)
    if (coverEntry && coverEntry.getData) {
      onProgress(0.15, 'Converting cover to grayscale JPEG...')
      try {
        const rawCover = await coverEntry.getData(new Uint8ArrayWriter())
        const grayscaleCover = await convertCoverToGrayscaleJpeg(rawCover)
        await zipWriter.add(coverEntry.filename, new Uint8ArrayReader(grayscaleCover), {
          extendedTimestamp: false,
        })
        console.log(`[EPUB] Cover converted to grayscale: ${coverEntry.filename} (${grayscaleCover.length} bytes)`)
      } catch (err) {
        console.warn(`[EPUB] Failed to convert cover, keeping original:`, err)
        const rawCover = await coverEntry.getData(new Uint8ArrayWriter())
        await zipWriter.add(coverEntry.filename, new Uint8ArrayReader(rawCover), {
          extendedTimestamp: false,
        })
      }
    }

    onProgress(0.2, 'Converting images to XTG...')

    // 4. Convert images to XTG — STORED (uncompressed, firmware reads raw)
    let convertedCount = 0
    for (let i = 0; i < imageEntries.length; i++) {
      const entry = imageEntries[i]
      const progress = 0.2 + (0.75 * i / imageEntries.length)
      const shortName = entry.filename.split('/').pop() || entry.filename
      onProgress(progress, `Converting ${i + 1}/${imageEntries.length}: ${shortName}`)

      try {
        if (entry.getData) {
          const rawData = await entry.getData(new Uint8ArrayWriter())
          const xtgBuffer = await convertImageToXtg(rawData, options)

          // Replace extension with .xtg, write STORED (level: 0)
          const newFilename = entry.filename.replace(/\.[^/.]+$/, '.xtg')
          await zipWriter.add(newFilename, new Uint8ArrayReader(new Uint8Array(xtgBuffer)), {
            level: 0,  // STORED — firmware requires uncompressed XTG
            extendedTimestamp: false,
          })
          convertedCount++
        }
      } catch (err) {
        console.warn(`[EPUB] Failed to convert image: ${entry.filename}`, err)
        // Keep original on failure
        if (entry.getData) {
          const data = await entry.getData(new Uint8ArrayWriter())
          await zipWriter.add(entry.filename, new Uint8ArrayReader(data), {
            extendedTimestamp: false,
          })
        }
      }
    }

    onProgress(0.95, 'Finalizing EPUB...')

    await zipWriter.close()
    await zipReader.close()

    const outputBlob = await blobWriter.getData()
    const outputBuffer = await outputBlob.arrayBuffer()
    const outputName = `${baseName}_XT.epub`

    onProgress(1, 'Complete')

    return {
      name: outputName,
      data: outputBuffer,
      size: outputBuffer.byteLength,
      imageCount: imageEntries.length,
      convertedCount,
      skippedCover,
    }
  } catch (err) {
    console.error('[EPUB] Optimization failed:', err)
    return {
      name: `${baseName}_XT.epub`,
      imageCount: 0,
      convertedCount: 0,
      skippedCover: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}

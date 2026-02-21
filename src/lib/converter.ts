// CBZ/CBR/PDF to XTC conversion logic

import JSZip from 'jszip'
import { createExtractorFromData } from 'node-unrar-js'
import unrarWasm from 'node-unrar-js/esm/js/unrar.wasm?url'
import * as pdfjsLib from 'pdfjs-dist'
import { applyDithering } from './processing/dithering'
import { toGrayscale, applyContrast, calculateOverlapSegments, isSolidColor, applyGamma } from './processing/image'
import { rotateCanvas, extractAndRotate, extractRegion, resizeWithPadding, TARGET_WIDTH, TARGET_HEIGHT } from './processing/canvas'
import { buildXtc } from './xtc-format'
import { extractPdfMetadata } from './metadata/pdf-outline'
import { parseComicInfo } from './metadata/comicinfo'
import type { BookMetadata } from './metadata/types'

// Set up PDF.js worker from CDN to avoid build asset path issues
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@5.4.624/build/pdf.worker.min.mjs'

import { ManhwaStitcher } from './processing/manhwa-stitcher'
import { getAxisCropRect } from './processing/geometry'
import type { ConversionOptions, ConversionResult, ProcessedPage, CropRect } from './types'
export type { ConversionOptions, ConversionResult }

// Inline PageMappingContext to avoid potential circular dependency/initialization issues
export class PageMappingContext {
  private mappings: Array<{ originalPage: number; xtcStartPage: number; xtcPageCount: number }> = []
  private currentXtcPage = 1

  addOriginalPage(originalPage: number, xtcPageCount: number): void {
    this.mappings.push({
      originalPage,
      xtcStartPage: this.currentXtcPage,
      xtcPageCount
    })
    this.currentXtcPage += xtcPageCount
  }

  getXtcPage(originalPage: number): number {
    const mapping = this.mappings.find(m => m.originalPage === originalPage)
    return mapping ? mapping.xtcStartPage : originalPage
  }

  getTotalXtcPages(): number {
    return this.currentXtcPage - 1
  }
}

import { adjustTocForMapping as adjustTocImport } from './page-mapping' // Keep helper import? Or inline it too?
// Let's inline adjustTocForMapping too to be safe.
import type { TocEntry } from './metadata/types'

function adjustTocForMapping(toc: TocEntry[], mappingCtx: PageMappingContext): TocEntry[] {
  if (toc.length === 0) return []
  const totalXtcPages = mappingCtx.getTotalXtcPages()
  return toc.map((entry, index) => {
    const adjustedStartPage = mappingCtx.getXtcPage(entry.startPage)
    let adjustedEndPage: number
    if (index < toc.length - 1) {
      const nextChapterStart = mappingCtx.getXtcPage(toc[index + 1].startPage)
      adjustedEndPage = nextChapterStart - 1
    } else {
      adjustedEndPage = totalXtcPages
    }
    return {
      title: entry.title,
      startPage: adjustedStartPage,
      endPage: adjustedEndPage
    }
  })
}

/**
 * Convert a file to XTC format (supports CBZ, CBR and PDF)
 */
export async function convertToXtc(
  file: File,
  fileType: 'cbz' | 'cbr' | 'pdf',
  options: ConversionOptions,
  onProgress: (progress: number, previewUrl: string | null) => void
): Promise<ConversionResult> {
  if (fileType === 'pdf') {
    return convertPdfToXtc(file, options, onProgress)
  }
  if (fileType === 'cbr') {
    return convertCbrToXtc(file, options, onProgress)
  }
  return convertCbzToXtc(file, options, onProgress)
}

/**
 * Convert a CBZ file to XTC format
 */
export async function convertCbzToXtc(
  file: File,
  options: ConversionOptions,
  onProgress: (progress: number, previewUrl: string | null) => void
): Promise<ConversionResult> {
  const zip = await JSZip.loadAsync(file)

  const imageFiles: Array<{ path: string; entry: any }> = []
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']
  let comicInfoEntry: any = null

  zip.forEach((relativePath: string, zipEntry: any) => {
    if (zipEntry.dir) return
    if (relativePath.toLowerCase().startsWith('__macos')) return

    const ext = relativePath.toLowerCase().substring(relativePath.lastIndexOf('.'))
    if (imageExtensions.includes(ext)) {
      imageFiles.push({ path: relativePath, entry: zipEntry })
    }

    // Look for ComicInfo.xml
    if (relativePath.toLowerCase() === 'comicinfo.xml' ||
        relativePath.toLowerCase().endsWith('/comicinfo.xml')) {
      comicInfoEntry = zipEntry
    }
  })

  imageFiles.sort((a, b) => a.path.localeCompare(b.path))

  if (imageFiles.length === 0) {
    throw new Error('No images found in CBZ')
  }

  // Extract metadata and generate TOC entries for every page (Python style)
  const pageTitles = new Map<number, string>()
  let metadata: BookMetadata = { toc: [] }
  
  if (comicInfoEntry) {
    try {
      const xmlContent = await comicInfoEntry.async('string')
      const cmMeta = parseComicInfo(xmlContent)
      cmMeta.toc.forEach(entry => pageTitles.set(entry.startPage, entry.title))
      if (cmMeta.title) metadata.title = cmMeta.title
      if (cmMeta.author) metadata.author = cmMeta.author
    } catch { }
  }

  // Also extract titles from folders if not already present
  imageFiles.forEach((file, index) => {
    const parts = file.path.split('/')
    if (parts.length > 1) {
      const folderName = parts[parts.length - 2]
      if (!pageTitles.has(index + 1)) {
        pageTitles.set(index + 1, folderName)
      }
    }
  })

  // Create TOC entry for every original page to match Python logic
  metadata.toc = imageFiles.map((_, index) => {
    const pg = index + 1
    let title = `Page ${pg}`
    if (pageTitles.has(pg)) {
      title = `${title} - ${pageTitles.get(pg)}`
    }
    return { title, startPage: pg, endPage: pg }
  })

  const processedPages: ProcessedPage[] = []
  const mappingCtx = new PageMappingContext()
  
  // Manhwa Stitcher
  let stitcher: ManhwaStitcher | null = null
  if (options.manhwa) {
    stitcher = new ManhwaStitcher(options)
  }

  for (let i = 0; i < imageFiles.length; i++) {
    const imgFile = imageFiles[i]
    const imgBlob = await imgFile.entry.async('blob')

    let pages: ProcessedPage[] = []
    
    if (stitcher) {
      // For Manhwa, we need to load the image first
      // processImage returns pages, but we need the raw image for stitching.
      // We can refactor processImage or just load it here.
      // Let's load it here to pass to stitcher.
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image()
          const url = URL.createObjectURL(imgBlob)
          img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Load failed')) }
          img.src = url
      }).catch(() => null)
      
      if (img) {
          pages = await stitcher.append(img)
      }
    } else {
      pages = await processImage(imgBlob, i + 1, options)
    }
    
    processedPages.push(...pages)

    // Track page mapping for TOC adjustment (approximate for Manhwa)
    mappingCtx.addOriginalPage(i + 1, pages.length)

    if (pages.length > 0 && pages[0].canvas) {
      const previewUrl = pages[0].canvas.toDataURL('image/png')
      onProgress((i + 1) / imageFiles.length, previewUrl)
    } else {
      onProgress((i + 1) / imageFiles.length, null)
    }
  }
  
  if (stitcher) {
      const finalPages = stitcher.finish()
      processedPages.push(...finalPages)
  }

  processedPages.sort((a, b) => a.name.localeCompare(b.name))

  // Adjust TOC page numbers based on mapping
  if (metadata.toc.length > 0) {
    metadata.toc = adjustTocForMapping(metadata.toc, mappingCtx)
  }

  const pageImages = processedPages.map(page => page.canvas.toDataURL('image/png'))
  const xtcData = await buildXtc(processedPages, { metadata, is2bit: options.is2bit })

  return {
    name: file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xtch' : '.xtc'),
    data: xtcData,
    size: xtcData.byteLength,
    pageCount: processedPages.length,
    pageImages
  }
}

// Cache for loaded wasm binary
let wasmBinaryCache: ArrayBuffer | null = null

async function loadUnrarWasm(): Promise<ArrayBuffer> {
  if (wasmBinaryCache) {
    return wasmBinaryCache
  }
  const response = await fetch(unrarWasm)
  wasmBinaryCache = await response.arrayBuffer()
  return wasmBinaryCache
}

/**
 * Convert a CBR file to XTC format
 */
export async function convertCbrToXtc(
  file: File,
  options: ConversionOptions,
  onProgress: (progress: number, previewUrl: string | null) => void
): Promise<ConversionResult> {
  const wasmBinary = await loadUnrarWasm()
  const arrayBuffer = await file.arrayBuffer()
  const extractor = await createExtractorFromData({ data: arrayBuffer, wasmBinary })

  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']
  const imageFiles: Array<{ path: string; data: Uint8Array }> = []
  let comicInfoContent: string | null = null

  // Extract all files from the RAR archive
  const { files } = extractor.extract()
  for (const extractedFile of files) {
    if (extractedFile.fileHeader.flags.directory) continue

    const path = extractedFile.fileHeader.name
    if (path.toLowerCase().startsWith('__macos')) continue

    const ext = path.toLowerCase().substring(path.lastIndexOf('.'))
    if (imageExtensions.includes(ext) && extractedFile.extraction) {
      imageFiles.push({ path, data: extractedFile.extraction })
    }

    // Look for ComicInfo.xml
    if ((path.toLowerCase() === 'comicinfo.xml' ||
         path.toLowerCase().endsWith('/comicinfo.xml')) &&
        extractedFile.extraction) {
      const decoder = new TextDecoder('utf-8')
      comicInfoContent = decoder.decode(extractedFile.extraction)
    }
  }

  imageFiles.sort((a, b) => a.path.localeCompare(b.path))

  if (imageFiles.length === 0) {
    throw new Error('No images found in CBR')
  }

  // Extract metadata and generate TOC entries for every page (Python style)
  const pageTitles = new Map<number, string>()
  let metadata: BookMetadata = { toc: [] }
  
  if (comicInfoContent) {
    try {
      const cmMeta = parseComicInfo(comicInfoContent)
      cmMeta.toc.forEach(entry => pageTitles.set(entry.startPage, entry.title))
      if (cmMeta.title) metadata.title = cmMeta.title
      if (cmMeta.author) metadata.author = cmMeta.author
    } catch { }
  }

  // Also extract titles from folders if not already present
  imageFiles.forEach((file, index) => {
    const parts = file.path.split(/[\\/]/)
    if (parts.length > 1) {
      const folderName = parts[parts.length - 2]
      if (!pageTitles.has(index + 1)) {
        pageTitles.set(index + 1, folderName)
      }
    }
  })

  // Create TOC entry for every original page to match Python logic
  metadata.toc = imageFiles.map((_, index) => {
    const pg = index + 1
    let title = `Page ${pg}`
    if (pageTitles.has(pg)) {
      title = `${title} - ${pageTitles.get(pg)}`
    }
    return { title, startPage: pg, endPage: pg }
  })

  const processedPages: ProcessedPage[] = []
  const mappingCtx = new PageMappingContext()
  
  let stitcher: ManhwaStitcher | null = null
  if (options.manhwa) {
    stitcher = new ManhwaStitcher(options)
  }

  for (let i = 0; i < imageFiles.length; i++) {
    const imgFile = imageFiles[i]
    // Create a copy of the data with a regular ArrayBuffer for Blob compatibility
    const imgBlob = new Blob([new Uint8Array(imgFile.data)])

    let pages: ProcessedPage[] = []
    
    if (stitcher) {
      const img = await new Promise<HTMLImageElement>((resolve) => {
          const img = new Image()
          const url = URL.createObjectURL(imgBlob)
          img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
          img.onerror = () => { URL.revokeObjectURL(url); resolve(null as any) }
          img.src = url
      })
      if (img) pages = await stitcher.append(img)
    } else {
      pages = await processImage(imgBlob, i + 1, options)
    }
    
    processedPages.push(...pages)

    // Track page mapping for TOC adjustment
    mappingCtx.addOriginalPage(i + 1, pages.length)

    if (pages.length > 0 && pages[0].canvas) {
      const previewUrl = pages[0].canvas.toDataURL('image/png')
      onProgress((i + 1) / imageFiles.length, previewUrl)
    } else {
      onProgress((i + 1) / imageFiles.length, null)
    }
  }
  
  if (stitcher) {
      processedPages.push(...stitcher.finish())
  }

  processedPages.sort((a, b) => a.name.localeCompare(b.name))

  // Adjust TOC page numbers based on mapping
  if (metadata.toc.length > 0) {
    metadata.toc = adjustTocForMapping(metadata.toc, mappingCtx)
  }

  const pageImages = processedPages.map(page => page.canvas.toDataURL('image/png'))
  const xtcData = await buildXtc(processedPages, { metadata, is2bit: options.is2bit })

  return {
    name: file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xtch' : '.xtc'),
    data: xtcData,
    size: xtcData.byteLength,
    pageCount: processedPages.length,
    pageImages
  }
}

/**
 * Convert a PDF file to XTC format
 */
async function convertPdfToXtc(
  file: File,
  options: ConversionOptions,
  onProgress: (progress: number, previewUrl: string | null) => void
): Promise<ConversionResult> {
  console.log('[PDF] convertPdfToXtc started', { options })
  const arrayBuffer = await file.arrayBuffer()
  console.log('[PDF] Loading document...')
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  console.log('[PDF] Document loaded, pages:', pdf.numPages)

  // Extract metadata (title, author, TOC) from PDF
  let metadata: BookMetadata = { toc: [] }
  try {
    metadata = await extractPdfMetadata(pdf)
    console.log('[PDF] Metadata extracted')
  } catch (e) {
    console.warn('[PDF] Metadata extraction failed', e)
  }

  // Generate TOC entries for every page to match Python logic
  console.log('[PDF] Generating page titles map')
  const pageTitles = new Map<number, string>()
  metadata.toc.forEach(entry => pageTitles.set(entry.startPage, entry.title))

  console.log('[PDF] Rebuilding TOC')
  const numPages = pdf.numPages
  metadata.toc = []
  for (let i = 1; i <= numPages; i++) {
    let title = `Page ${i}`
    if (pageTitles.has(i)) {
      title = `${title} - ${pageTitles.get(i)}`
    }
    metadata.toc.push({ title, startPage: i, endPage: i })
  }

  console.log('[PDF] Init processedPages')
  const processedPages: ProcessedPage[] = []
  console.log('[PDF] Init mappingCtx')
  const mappingCtx = new PageMappingContext()
  
  let stitcher: ManhwaStitcher | null = null
  if (options.manhwa) {
    stitcher = new ManhwaStitcher(options)
  }

  for (let i = 1; i <= numPages; i++) {
    console.log(`[PDF] Processing page ${i}/${numPages}`)
    const page = await pdf.getPage(i)
    const scale = 2.0 // Render at 2x for better quality
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height

    await page.render({
      canvas,
      viewport,
      background: 'rgb(255,255,255)'
    }).promise

    let pages: ProcessedPage[] = []
    
    if (stitcher) {
        console.log('[PDF] Stitching...')
        pages = await stitcher.append(canvas)
    } else {
        console.log('[PDF] Processing as image...')
        try {
          pages = processCanvasAsImage(canvas, i, options)
        } catch (e) {
          console.error(`[PDF] processCanvasAsImage failed for page ${i}`, e)
          throw e
        }
    }
    console.log(`[PDF] Page ${i} processed, generated ${pages.length} XTC pages`)
    
    processedPages.push(...pages)

    // Track page mapping for TOC adjustment
    mappingCtx.addOriginalPage(i, pages.length)

    if (pages.length > 0 && pages[0].canvas) {
      const previewUrl = pages[0].canvas.toDataURL('image/png')
      onProgress(i / numPages, previewUrl)
    } else {
      onProgress(i / numPages, null)
    }
  }
  
  if (stitcher) {
      processedPages.push(...stitcher.finish())
  }

  processedPages.sort((a, b) => a.name.localeCompare(b.name))

  // Adjust TOC page numbers based on mapping
  if (metadata.toc.length > 0) {
    metadata.toc = adjustTocForMapping(metadata.toc, mappingCtx)
  }

  const pageImages = processedPages.map(page => page.canvas.toDataURL('image/png'))
  const xtcData = await buildXtc(processedPages, { metadata, is2bit: options.is2bit })

  return {
    name: file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xtch' : '.xtc'),
    data: xtcData,
    size: xtcData.byteLength,
    pageCount: processedPages.length,
    pageImages
  }
}

/**
 * Process a canvas (from PDF rendering) through the same pipeline as images
 */
function processCanvasAsImage(
  sourceCanvas: HTMLCanvasElement,
  pageNum: number,
  options: ConversionOptions
): ProcessedPage[] {
  console.log('[Image] processCanvasAsImage', { pageNum, options })
  const results: ProcessedPage[] = []
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const padColor = options.padBlack ? 0 : 255

  console.log('[Image] Calculating crop')
  const crop = getAxisCropRect(sourceCanvas.width, sourceCanvas.height, options)
  canvas.width = crop.width
  canvas.height = crop.height
  ctx.drawImage(
    sourceCanvas,
    crop.x, crop.y,
    crop.width, crop.height,
    0, 0,
    crop.width, crop.height
  )

  let width = crop.width
  let height = crop.height

  if (options.contrast > 0) {
    applyContrast(ctx, width, height, options.contrast)
  }

  if (options.gamma !== 1.0 && options.is2bit) {
    applyGamma(ctx, width, height, options.gamma)
  }

  toGrayscale(ctx, width, height)

  // Add sideways overview if requested
  if (options.sidewaysOverviews && !options.manhwa) {
    const rotatedOverview = rotateCanvas(canvas, 90)
    const finalOverview = resizeWithPadding(rotatedOverview, padColor)
    applyDithering(finalOverview.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)
    results.push({
      name: `${String(pageNum).padStart(4, '0')}_0_overview_s.png`,
      canvas: finalOverview
    })
  }

  // Add upright overview if requested
  if (options.includeOverviews && !options.manhwa) {
    const finalOverview = resizeWithPadding(canvas, padColor)
    applyDithering(finalOverview.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)
    results.push({
      name: `${String(pageNum).padStart(4, '0')}_0_overview_u.png`,
      canvas: finalOverview
    })
  }

  // Manhwa Mode
  if (options.manhwa) {
    const scale = TARGET_WIDTH / width
    const newHeight = Math.floor(height * scale)
    const resizedCanvas = document.createElement('canvas')
    resizedCanvas.width = TARGET_WIDTH
    resizedCanvas.height = newHeight
    resizedCanvas.getContext('2d')!.drawImage(canvas, 0, 0, width, height, 0, 0, TARGET_WIDTH, newHeight)
    
    // Dither the entire strip first to ensure seamless pixel continuity across page boundaries
    applyDithering(resizedCanvas.getContext('2d')!, TARGET_WIDTH, newHeight, options.dithering, options.is2bit)

    const sliceHeight = TARGET_HEIGHT
    const overlapPercent = options.manhwaOverlap || 50
    const overlapPixels = Math.floor(TARGET_HEIGHT * (overlapPercent / 100))
    const sliceStep = TARGET_HEIGHT - overlapPixels

    for (let y = 0; y < newHeight; ) {
      let h = Math.min(sliceHeight, newHeight - y)
      
      // If we're at the end and have a partial slice (but the image is tall enough),
      // align to the bottom to show a full page with more overlap.
      if (h < sliceHeight && newHeight > sliceHeight) {
        y = newHeight - sliceHeight
        h = sliceHeight
      }

      const sliceCanvas = extractRegion(resizedCanvas, 0, y, TARGET_WIDTH, h)
      const finalCanvas = resizeWithPadding(sliceCanvas, padColor)
      // Dithering already applied
      
      results.push({
        name: `${String(pageNum).padStart(4, '0')}_m_${y}.png`,
        canvas: finalCanvas
      })
      
      if (y + h >= newHeight) break
      y += sliceStep
    }
    return results
  }

  // Portrait mode: no rotation, 1 page = 1 page on e-reader
  if (options.orientation === 'portrait') {
    const finalCanvas = resizeWithPadding(canvas, padColor)
    applyDithering(finalCanvas.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)

    results.push({
      name: `${String(pageNum).padStart(4, '0')}_0_page.png`,
      canvas: finalCanvas
    })
    return results
  }

  // Landscape mode: rotate and optionally split
  const shouldSplit = width < height && options.splitMode !== 'nosplit'

  if (shouldSplit) {
    if (options.splitMode === 'overlap') {
      const segments = calculateOverlapSegments(width, height)
      
      if (options.landscapeRtl) {
        segments.reverse()
      }

      segments.forEach((seg, idx) => {
        const letter = String.fromCharCode(97 + idx)
        const pageCanvas = extractAndRotate(canvas, seg.x, seg.y, seg.w, seg.h)
        const finalCanvas = resizeWithPadding(pageCanvas, padColor)
        applyDithering(finalCanvas.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)

        results.push({
          name: `${String(pageNum).padStart(4, '0')}_3_${letter}.png`,
          canvas: finalCanvas
        })
      })
    } else {
      const halfHeight = Math.floor(height / 2)

      const topCanvas = extractAndRotate(canvas, 0, 0, width, halfHeight)
      const topFinal = resizeWithPadding(topCanvas, padColor)
      applyDithering(topFinal.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)

      const bottomCanvas = extractAndRotate(canvas, 0, halfHeight, width, halfHeight)
      const bottomFinal = resizeWithPadding(bottomCanvas, padColor)
      applyDithering(bottomFinal.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)

      if (options.landscapeRtl) {
        results.push({
          name: `${String(pageNum).padStart(4, '0')}_2_a.png`,
          canvas: bottomFinal
        })
        results.push({
          name: `${String(pageNum).padStart(4, '0')}_2_b.png`,
          canvas: topFinal
        })
      } else {
        results.push({
          name: `${String(pageNum).padStart(4, '0')}_2_a.png`,
          canvas: topFinal
        })
        results.push({
          name: `${String(pageNum).padStart(4, '0')}_2_b.png`,
          canvas: bottomFinal
        })
      }
    }
  } else {
    const rotatedCanvas = rotateCanvas(canvas, 90)
    const finalCanvas = resizeWithPadding(rotatedCanvas, padColor)
    applyDithering(finalCanvas.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)

    results.push({
      name: `${String(pageNum).padStart(4, '0')}_0_spread.png`,
      canvas: finalCanvas
    })
  }

  return results
}

/**
 * Process a single image
 */
async function processImage(
  imgBlob: Blob,
  pageNum: number,
  options: ConversionOptions
): Promise<ProcessedPage[]> {
  return new Promise((resolve) => {
    const img = new Image()
    const objectUrl = URL.createObjectURL(imgBlob)

    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const pages = processLoadedImage(img, pageNum, options)
      resolve(pages)
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      console.error(`Failed to load image for page ${pageNum}`)
      resolve([])
    }
    img.src = objectUrl
  })
}

/**
 * Process a loaded image element
 */
function processLoadedImage(
  img: HTMLImageElement,
  pageNum: number,
  options: ConversionOptions
): ProcessedPage[] {
  const results: ProcessedPage[] = []
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const padColor = options.padBlack ? 0 : 255

  const crop = getAxisCropRect(img.width, img.height, options)
  canvas.width = crop.width
  canvas.height = crop.height
  ctx.drawImage(
    img,
    crop.x, crop.y,
    crop.width, crop.height,
    0, 0,
    crop.width, crop.height
  )

  let width = crop.width
  let height = crop.height

  // Apply contrast enhancement
  if (options.contrast > 0) {
    applyContrast(ctx, width, height, options.contrast)
  }

  if (options.gamma !== 1.0 && options.is2bit) {
    applyGamma(ctx, width, height, options.gamma)
  }

  // Convert to grayscale
  toGrayscale(ctx, width, height)

  // Add sideways overview if requested
  if (options.sidewaysOverviews && !options.manhwa) {
    const rotatedOverview = rotateCanvas(canvas, 90)
    const finalOverview = resizeWithPadding(rotatedOverview, padColor)
    applyDithering(finalOverview.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)
    results.push({
      name: `${String(pageNum).padStart(4, '0')}_0_overview_s.png`,
      canvas: finalOverview
    })
  }

  // Add upright overview if requested
  if (options.includeOverviews && !options.manhwa) {
    const finalOverview = resizeWithPadding(canvas, padColor)
    applyDithering(finalOverview.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)
    results.push({
      name: `${String(pageNum).padStart(4, '0')}_0_overview_u.png`,
      canvas: finalOverview
    })
  }

  // Manhwa Mode
  if (options.manhwa) {
    const scale = TARGET_WIDTH / width
    const newHeight = Math.floor(height * scale)
    const resizedCanvas = document.createElement('canvas')
    resizedCanvas.width = TARGET_WIDTH
    resizedCanvas.height = newHeight
    resizedCanvas.getContext('2d')!.drawImage(canvas, 0, 0, width, height, 0, 0, TARGET_WIDTH, newHeight)
    
    // Dither the entire strip first to ensure seamless pixel continuity across page boundaries
    applyDithering(resizedCanvas.getContext('2d')!, TARGET_WIDTH, newHeight, options.dithering, options.is2bit)

    const sliceHeight = TARGET_HEIGHT
    const overlapPercent = options.manhwaOverlap || 50
    const overlapPixels = Math.floor(TARGET_HEIGHT * (overlapPercent / 100))
    const sliceStep = TARGET_HEIGHT - overlapPixels

    for (let y = 0; y < newHeight; ) {
      let h = Math.min(sliceHeight, newHeight - y)
      
      // If we're at the end and have a partial slice (but the image is tall enough),
      // align to the bottom to show a full page with more overlap.
      if (h < sliceHeight && newHeight > sliceHeight) {
        y = newHeight - sliceHeight
        h = sliceHeight
      }

      const sliceCanvas = extractRegion(resizedCanvas, 0, y, TARGET_WIDTH, h)
      const finalCanvas = resizeWithPadding(sliceCanvas, padColor)
      // Dithering already applied
      
      results.push({
        name: `${String(pageNum).padStart(4, '0')}_m_${y}.png`,
        canvas: finalCanvas
      })
      
      if (y + h >= newHeight) break
      y += sliceStep
    }
    return results
  }

  // Portrait mode: no rotation, 1 page = 1 page on e-reader
  if (options.orientation === 'portrait') {
    const finalCanvas = resizeWithPadding(canvas, padColor)
    applyDithering(finalCanvas.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)

    results.push({
      name: `${String(pageNum).padStart(4, '0')}_0_page.png`,
      canvas: finalCanvas
    })
    return results
  }

  // Landscape mode: rotate and optionally split
  const shouldSplit = width < height && options.splitMode !== 'nosplit'

  if (shouldSplit) {
    if (options.splitMode === 'overlap') {
      const segments = calculateOverlapSegments(width, height)
      
      if (options.landscapeRtl) {
        segments.reverse()
      }

      segments.forEach((seg, idx) => {
        const letter = String.fromCharCode(97 + idx)
        const pageCanvas = extractAndRotate(canvas, seg.x, seg.y, seg.w, seg.h)
        const finalCanvas = resizeWithPadding(pageCanvas, padColor)
        applyDithering(finalCanvas.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)

        results.push({
          name: `${String(pageNum).padStart(4, '0')}_3_${letter}.png`,
          canvas: finalCanvas
        })
      })
    } else {
      const halfHeight = Math.floor(height / 2)

      const topCanvas = extractAndRotate(canvas, 0, 0, width, halfHeight)
      const topFinal = resizeWithPadding(topCanvas, padColor)
      applyDithering(topFinal.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)

      const bottomCanvas = extractAndRotate(canvas, 0, halfHeight, width, halfHeight)
      const bottomFinal = resizeWithPadding(bottomCanvas, padColor)
      applyDithering(bottomFinal.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)

      if (options.landscapeRtl) {
        results.push({
          name: `${String(pageNum).padStart(4, '0')}_2_a.png`,
          canvas: bottomFinal
        })
        results.push({
          name: `${String(pageNum).padStart(4, '0')}_2_b.png`,
          canvas: topFinal
        })
      } else {
        results.push({
          name: `${String(pageNum).padStart(4, '0')}_2_a.png`,
          canvas: topFinal
        })
        results.push({
          name: `${String(pageNum).padStart(4, '0')}_2_b.png`,
          canvas: bottomFinal
        })
      }
    }
  } else {
    const rotatedCanvas = rotateCanvas(canvas, 90)
    const finalCanvas = resizeWithPadding(rotatedCanvas, padColor)
    applyDithering(finalCanvas.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)

    results.push({
      name: `${String(pageNum).padStart(4, '0')}_0_spread.png`,
      canvas: finalCanvas
    })
  }

  return results
}

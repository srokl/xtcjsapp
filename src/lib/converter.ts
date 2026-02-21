// CBZ/CBR/PDF to XTC conversion logic

import JSZip from 'jszip'
import { createExtractorFromData } from 'node-unrar-js'
import unrarWasm from 'node-unrar-js/esm/js/unrar.wasm?url'
import * as pdfjsLib from 'pdfjs-dist'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { applyDithering } from './processing/dithering'
import { toGrayscale, applyContrast, calculateOverlapSegments, isSolidColor } from './processing/image'
import { rotateCanvas, extractAndRotate, extractRegion, resizeWithPadding, TARGET_WIDTH, TARGET_HEIGHT } from './processing/canvas'
import { buildXtc } from './xtc-format'
import { extractPdfMetadata } from './metadata/pdf-outline'
import { parseComicInfo } from './metadata/comicinfo'
import { PageMappingContext, adjustTocForMapping } from './page-mapping'
import type { BookMetadata } from './metadata/types'

// Set up PDF.js worker from bundled asset
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker

export interface ConversionOptions {
  splitMode: string
  dithering: string
  contrast: number
  horizontalMargin: number
  verticalMargin: number
  orientation: 'landscape' | 'portrait'
  is2bit: boolean
  manhwa: boolean
  manhwaOverlap: number
}

export interface ConversionResult {
  name: string
  data?: ArrayBuffer
  size?: number
  pageCount?: number
  pageImages?: string[]
  error?: string
}

interface ProcessedPage {
  name: string
  canvas: HTMLCanvasElement
}

interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

class ManhwaStitcher {
  private buffer: HTMLCanvasElement | null = null
  private pageCount = 0

  constructor(private options: ConversionOptions) {}

  async append(source: HTMLImageElement | HTMLCanvasElement): Promise<ProcessedPage[]> {
    const pages: ProcessedPage[] = []
    
    // 1. Resize source to TARGET_WIDTH
    const scale = TARGET_WIDTH / source.width
    const newHeight = Math.floor(source.height * scale)
    const tempCanvas = document.createElement('canvas')
    tempCanvas.width = TARGET_WIDTH
    tempCanvas.height = newHeight
    const tempCtx = tempCanvas.getContext('2d')!
    
    // Draw and apply pre-processing
    tempCtx.drawImage(source, 0, 0, source.width, source.height, 0, 0, TARGET_WIDTH, newHeight)
    
    if (this.options.contrast > 0) {
       applyContrast(tempCtx, TARGET_WIDTH, newHeight, this.options.contrast)
    }
    toGrayscale(tempCtx, TARGET_WIDTH, newHeight)

    // 2. Stitch into buffer
    if (!this.buffer) {
      this.buffer = tempCanvas
    } else {
      const combinedHeight = this.buffer.height + newHeight
      const combinedCanvas = document.createElement('canvas')
      combinedCanvas.width = TARGET_WIDTH
      combinedCanvas.height = combinedHeight
      const combinedCtx = combinedCanvas.getContext('2d')!
      
      combinedCtx.drawImage(this.buffer, 0, 0)
      combinedCtx.drawImage(tempCanvas, 0, this.buffer.height)
      
      this.buffer = combinedCanvas
    }

    // 3. Slice ready pages
    while (this.buffer && this.buffer.height >= TARGET_HEIGHT) {
       // Extract top page
       const slice = extractRegion(this.buffer, 0, 0, TARGET_WIDTH, TARGET_HEIGHT)
       const sliceCtx = slice.getContext('2d')!
       
       // Check if solid color (blank/filler)
       const isSolid = isSolidColor(sliceCtx, 0, 0, TARGET_WIDTH, TARGET_HEIGHT)
       
       // Calculate step:
       // Solid -> Skip full page (800px)
       // Detailed -> User-selected overlap
       const overlapPercent = this.options.manhwaOverlap || 50
       const overlapPixels = Math.floor(TARGET_HEIGHT * (overlapPercent / 100))
       const step = isSolid ? TARGET_HEIGHT : (TARGET_HEIGHT - overlapPixels)
       
       // Dither
       applyDithering(sliceCtx, TARGET_WIDTH, TARGET_HEIGHT, this.options.dithering, this.options.is2bit)
       
       this.pageCount++
       pages.push({
         name: `${String(this.pageCount).padStart(5, '0')}.png`,
         canvas: slice
       })
       
       // Advance buffer
       const remainingHeight = this.buffer.height - step
       
       if (remainingHeight <= 0) {
         this.buffer = null
         break
       }
       
       const newBuffer = document.createElement('canvas')
       newBuffer.width = TARGET_WIDTH
       newBuffer.height = remainingHeight
       newBuffer.getContext('2d')!.drawImage(this.buffer, 0, step, TARGET_WIDTH, remainingHeight, 0, 0, TARGET_WIDTH, remainingHeight)
       
       this.buffer = newBuffer
    }
    
    return pages
  }
  
  finish(): ProcessedPage[] {
    const pages: ProcessedPage[] = []
    if (this.buffer && this.buffer.height > 0) {
        // Last chunk
        // Align to top (content at top, white at bottom)
        const final = document.createElement('canvas')
        final.width = TARGET_WIDTH
        final.height = TARGET_HEIGHT
        const ctx = final.getContext('2d')!
        
        // Fill white
        ctx.fillStyle = 'white'
        ctx.fillRect(0, 0, TARGET_WIDTH, TARGET_HEIGHT)
        
        // Draw content at top
        ctx.drawImage(this.buffer, 0, 0)
        
        applyDithering(ctx, TARGET_WIDTH, TARGET_HEIGHT, this.options.dithering, this.options.is2bit)
        
        this.pageCount++
        pages.push({
             name: `${String(this.pageCount).padStart(5, '0')}.png`,
             canvas: final
        })
    }
    return pages
  }
}

function clampMarginPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(20, value))
}

function getAxisCropRect(
  sourceWidth: number,
  sourceHeight: number,
  options: ConversionOptions
): CropRect {
  // Force 0 vertical margin in Manhwa mode to prevent cutting content between files
  const verticalMarginRaw = options.manhwa ? 0 : options.verticalMargin
  
  const horizontalMargin = clampMarginPercent(options.horizontalMargin)
  const verticalMargin = clampMarginPercent(verticalMarginRaw)

  const maxCropX = Math.floor((sourceWidth - 1) / 2)
  const maxCropY = Math.floor((sourceHeight - 1) / 2)

  const cropX = Math.min(Math.floor(sourceWidth * horizontalMargin / 100), maxCropX)
  const cropY = Math.min(Math.floor(sourceHeight * verticalMargin / 100), maxCropY)

  return {
    x: cropX,
    y: cropY,
    width: Math.max(1, sourceWidth - cropX * 2),
    height: Math.max(1, sourceHeight - cropY * 2)
  }
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
  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

  // Extract metadata (title, author, TOC) from PDF
  let metadata: BookMetadata = { toc: [] }
  try {
    metadata = await extractPdfMetadata(pdf)
  } catch {
    // Metadata extraction failed, continue without it
  }

  // Generate TOC entries for every page to match Python logic
  const pageTitles = new Map<number, string>()
  metadata.toc.forEach(entry => pageTitles.set(entry.startPage, entry.title))

  metadata.toc = []
  for (let i = 1; i <= numPages; i++) {
    let title = `Page ${i}`
    if (pageTitles.has(i)) {
      title = `${title} - ${pageTitles.get(i)}`
    }
    metadata.toc.push({ title, startPage: i, endPage: i })
  }

  const processedPages: ProcessedPage[] = []
  const mappingCtx = new PageMappingContext()
  const numPages = pdf.numPages
  
  let stitcher: ManhwaStitcher | null = null
  if (options.manhwa) {
    stitcher = new ManhwaStitcher(options)
  }

  for (let i = 1; i <= numPages; i++) {
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
        pages = await stitcher.append(canvas)
    } else {
        pages = processCanvasAsImage(canvas, i, options)
    }
    
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
  const results: ProcessedPage[] = []
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!

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

  toGrayscale(ctx, width, height)

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
    const overlap = 200 // 25% overlap for seamless context
    for (let y = 0; y < newHeight; ) {
      let h = Math.min(sliceHeight, newHeight - y)
      
      // If we're at the end and have a partial slice (but the image is tall enough),
      // align to the bottom to show a full page with more overlap.
      if (h < sliceHeight && newHeight > sliceHeight) {
        y = newHeight - sliceHeight
        h = sliceHeight
      }

      const sliceCanvas = extractRegion(resizedCanvas, 0, y, TARGET_WIDTH, h)
      const finalCanvas = resizeWithPadding(sliceCanvas)
      // Dithering already applied
      
      results.push({
        name: `${String(pageNum).padStart(4, '0')}_m_${y}.png`,
        canvas: finalCanvas
      })
      
      if (y + h >= newHeight) break
      y += (sliceHeight - overlap)
    }
    return results
  }

  // Portrait mode: no rotation, 1 page = 1 page on e-reader
  if (options.orientation === 'portrait') {
    const finalCanvas = resizeWithPadding(canvas)
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
      segments.forEach((seg, idx) => {
        const letter = String.fromCharCode(97 + idx)
        const pageCanvas = extractAndRotate(canvas, seg.x, seg.y, seg.w, seg.h)
        const finalCanvas = resizeWithPadding(pageCanvas)
        applyDithering(finalCanvas.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)

        results.push({
          name: `${String(pageNum).padStart(4, '0')}_3_${letter}.png`,
          canvas: finalCanvas
        })
      })
    } else {
      const halfHeight = Math.floor(height / 2)

      const topCanvas = extractAndRotate(canvas, 0, 0, width, halfHeight)
      const topFinal = resizeWithPadding(topCanvas)
      applyDithering(topFinal.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)
      results.push({
        name: `${String(pageNum).padStart(4, '0')}_2_a.png`,
        canvas: topFinal
      })

      const bottomCanvas = extractAndRotate(canvas, 0, halfHeight, width, halfHeight)
      const bottomFinal = resizeWithPadding(bottomCanvas)
      applyDithering(bottomFinal.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)
      results.push({
        name: `${String(pageNum).padStart(4, '0')}_2_b.png`,
        canvas: bottomFinal
      })
    }
  } else {
    const rotatedCanvas = rotateCanvas(canvas, 90)
    const finalCanvas = resizeWithPadding(rotatedCanvas)
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

  // Convert to grayscale
  toGrayscale(ctx, width, height)

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
    const overlap = 200 // 25% overlap for seamless context
    for (let y = 0; y < newHeight; ) {
      let h = Math.min(sliceHeight, newHeight - y)
      
      // If we're at the end and have a partial slice (but the image is tall enough),
      // align to the bottom to show a full page with more overlap.
      if (h < sliceHeight && newHeight > sliceHeight) {
        y = newHeight - sliceHeight
        h = sliceHeight
      }

      const sliceCanvas = extractRegion(resizedCanvas, 0, y, TARGET_WIDTH, h)
      const finalCanvas = resizeWithPadding(sliceCanvas)
      // Dithering already applied
      
      results.push({
        name: `${String(pageNum).padStart(4, '0')}_m_${y}.png`,
        canvas: finalCanvas
      })
      
      if (y + h >= newHeight) break
      y += (sliceHeight - overlap)
    }
    return results
  }

  // Portrait mode: no rotation, 1 page = 1 page on e-reader
  if (options.orientation === 'portrait') {
    const finalCanvas = resizeWithPadding(canvas)
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
      segments.forEach((seg, idx) => {
        const letter = String.fromCharCode(97 + idx)
        const pageCanvas = extractAndRotate(canvas, seg.x, seg.y, seg.w, seg.h)
        const finalCanvas = resizeWithPadding(pageCanvas)
        applyDithering(finalCanvas.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)

        results.push({
          name: `${String(pageNum).padStart(4, '0')}_3_${letter}.png`,
          canvas: finalCanvas
        })
      })
    } else {
      const halfHeight = Math.floor(height / 2)

      const topCanvas = extractAndRotate(canvas, 0, 0, width, halfHeight)
      const topFinal = resizeWithPadding(topCanvas)
      applyDithering(topFinal.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)
      results.push({
        name: `${String(pageNum).padStart(4, '0')}_2_a.png`,
        canvas: topFinal
      })

      const bottomCanvas = extractAndRotate(canvas, 0, halfHeight, width, halfHeight)
      const bottomFinal = resizeWithPadding(bottomCanvas)
      applyDithering(bottomFinal.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)
      results.push({
        name: `${String(pageNum).padStart(4, '0')}_2_b.png`,
        canvas: bottomFinal
      })
    }
  } else {
    const rotatedCanvas = rotateCanvas(canvas, 90)
    const finalCanvas = resizeWithPadding(rotatedCanvas)
    applyDithering(finalCanvas.getContext('2d')!, TARGET_WIDTH, TARGET_HEIGHT, options.dithering, options.is2bit)

    results.push({
      name: `${String(pageNum).padStart(4, '0')}_0_spread.png`,
      canvas: finalCanvas
    })
  }

  return results
}

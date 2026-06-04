// CBZ/CBR/PDF to XTC conversion logic

import { ZipReader, BlobReader, BlobWriter, TextWriter, Uint8ArrayWriter } from '@zip.js/zip.js'
import streamSaver from 'streamsaver'
import { createExtractorFromData } from 'node-unrar-js'
import unrarWasm from 'node-unrar-js/esm/js/unrar.wasm?url'
import * as pdfjsLib from 'pdfjs-dist'
import { applyDithering, applyDitheringToData } from './processing/dithering'
import { toGrayscale, applyContrast, calculateOverlapSegments, calculateHorizontalOverlapSegments, isSolidColor, applyGamma, applyInvert, applyUnifiedFilters } from './processing/image'
import { rotateCanvas, extractAndRotate, extractRegion, resizeWithPadding, resizeFill, resizeCover, resizeCrop, TARGET_WIDTH, TARGET_HEIGHT, DEVICE_DIMENSIONS, sharedCanvasPool } from './processing/canvas'
import { buildXtc, buildXtcFromBuffers, imageDataToXth, imageDataToXtg, wrapWasmData, buildXtcHeaderAndIndex, getXtcPageSize, type StreamPageInfo } from './xtc-format'
import { compressXtczAsync } from './lz4-worker-manager'
import { initWasm, runWasmFilters, isWasmLoaded, runWasmPack, runWasmResize, runWasmPipeline } from './processing/wasm'
import { runUnifiedXtg, runUnifiedXth } from './processing/unified-js'

function getTargetDimensions(options: ConversionOptions) {
  return DEVICE_DIMENSIONS[options.device] || DEVICE_DIMENSIONS.X4;
}

function getOrientationAngle(orientation: string): number {
  return orientation === 'landscape' ? 90 : 0
}

/**
 * Returns true for dithering algorithms that use raster-order error diffusion
 * and can be fused into the unified filter+dither+pack pipeline.
 * Ordered, stochastic, and matt-parker use non-standard scan patterns
 * and must fall through to the separate 3-pass pipeline.
 */
function isErrorDiffusionAlgorithm(algo: string): boolean {
  return algo === 'floyd' || algo === 'atkinson' || algo === 'stucki' 
    || algo === 'zhoufang' || algo === 'ostromoukhov'
}

/**
 * Get dimensions of an image blob using high-performance ImageBitmap
 */
async function getImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(blob);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dims;
  } catch (e) {
    // Fallback for very old browsers if needed, though most mobile browsers support this now
    return new Promise((resolve, reject) => {
      const img = new Image()
      const url = URL.createObjectURL(blob)
      img.onload = () => {
        const dims = { width: img.width, height: img.height }
        URL.revokeObjectURL(url)
        resolve(dims)
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('Failed to get image dimensions'))
      }
      img.src = url
    })
  }
}

/**
 * Resize a canvas with high-quality Box Filter
 */
export async function resizeHq(
  canvas: HTMLCanvasElement, 
  targetWidth: number, 
  targetHeight: number, 
  options: ConversionOptions
): Promise<HTMLCanvasElement> {
  if (options.useWasm && isWasmLoaded() && !options.is2bit && (canvas.width !== targetWidth || canvas.height !== targetHeight)) {
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      const srcData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const resizedData = runWasmResize(srcData, targetWidth, targetHeight)
      const outCanvas = sharedCanvasPool.acquire(targetWidth, targetHeight)
      outCanvas.getContext('2d', { willReadFrequently: true })!.putImageData(resizedData, 0, 0)
      return outCanvas
    } catch (e) {
      console.warn("Wasm resize failed, fallback to Canvas", e)
    }
  }
  return await resizeFill(canvas, targetWidth, targetHeight, !options.useWasm)
}


/**
 * Efficient preview generation: uses toBlob + createObjectURL instead of toDataURL
 * to avoid expensive base64 encoding and ~2MB string allocation per preview.
 */
function generateCanvasPreview(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png')
}

/**
 * Process a canvas (filter, dither) and encode it to binary
 * Highly optimized synchronous pipeline to maximize CPU throughput.
 */
function processAndEncode(canvas: HTMLCanvasElement, options: ConversionOptions, generatePreview: boolean = true): { buffer: ArrayBuffer, preview: string } {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const width = canvas.width
  const height = canvas.height
  const imageData = ctx.getImageData(0, 0, width, height)

  let buffer: ArrayBuffer
  let preview = ''

  if (options.useWasm && isWasmLoaded()) {
    const packed = runWasmPipeline(imageData, {
      contrast: options.contrast,
      gamma: options.gamma,
      invert: options.invert,
      algorithm: options.dithering,
      is2bit: options.is2bit
    })
    buffer = wrapWasmData(packed, width, height, options.is2bit)
    
    if (generatePreview) {
      runWasmFilters(imageData, options.contrast, options.gamma, options.invert)
      ctx.putImageData(imageData, 0, 0)
      applyDithering(ctx, width, height, options.dithering, options.is2bit, true)
      preview = generateCanvasPreview(canvas)
    }
  } else if (!options.manhwa && (options.dithering === 'none' || isErrorDiffusionAlgorithm(options.dithering))) {
    // Unified High-Performance JS Pipeline (Fused filter + dither + pack)
    // Supports: none, floyd, atkinson, stucki, zhoufang, ostromoukhov
    // Uses rolling error buffers instead of full Float32Array, saving ~95% memory
    const unifiedOpts = { ...options, dithering: options.dithering }
    buffer = options.is2bit 
      ? runUnifiedXth(imageData.data, width, height, unifiedOpts)
      : runUnifiedXtg(imageData.data, width, height, unifiedOpts)
    
    if (generatePreview) {
      applyUnifiedFilters(imageData.data, options)
      if (options.dithering !== 'none') {
        applyDitheringToData(imageData.data, width, height, options.dithering, options.is2bit, false)
      }
      ctx.putImageData(imageData, 0, 0)
      preview = generateCanvasPreview(canvas)
    }
  } else {
    // Standard JS Pipeline (ordered, stochastic, matt-parker, manhwa)
    applyUnifiedFilters(imageData.data, {
      contrast: options.contrast,
      gamma: options.gamma,
      invert: options.invert
    })
    
    applyDitheringToData(imageData.data, width, height, options.dithering, options.is2bit, false)
    
    if (generatePreview) {
      ctx.putImageData(imageData, 0, 0)
      preview = generateCanvasPreview(canvas)
    }
    
    buffer = options.is2bit ? imageDataToXth(imageData) : imageDataToXtg(imageData)
  }
  
  return { buffer, preview }
}

import { extractPdfMetadata } from './metadata/pdf-outline'
import { parseComicInfo } from './metadata/comicinfo'
import type { BookMetadata } from './metadata/types'

// Set up PDF.js worker locally for offline support
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

import { ManhwaStitcher } from './processing/manhwa-stitcher'
import { getAxisCropRect } from './processing/geometry'
import type { ConversionOptions, ConversionResult, ProcessedPage, CropRect } from './types'
export type { ConversionOptions, ConversionResult }

// Inline PageMappingContext
export class PageMappingContext {
  private mappings: Array<{ originalPage: number; xtcStartPage: number; xtcPageCount: number }> = []
  private currentXtcPage = 1

  addOriginalPage(originalPage: number, xtcPageCount: number): void {
    this.mappings.push({ originalPage, xtcStartPage: this.currentXtcPage, xtcPageCount })
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

/**
 * Convert a file to XTC format
 */
export async function convertToXtc(
  file: File,
  fileType: 'cbz' | 'cbr' | 'pdf' | 'image' | 'video',
  options: ConversionOptions,
  onProgress: (progress: number, previewUrl: string | null) => void,
  tocPageOffset: number = 0
): Promise<ConversionResult> {
  if (options.useWasm) try { await initWasm() } catch (e) { console.error("Wasm init failed", e) }

  if (fileType === 'pdf') return convertPdfToXtc(file, options, onProgress, tocPageOffset)
  if (fileType === 'cbr') return convertCbrToXtc(file, options, onProgress, tocPageOffset)
  if (fileType === 'image') return convertImageToXtc(file, options, onProgress)
  if (fileType === 'video') return convertVideoToXtc(file, options, onProgress)
  return convertCbzToXtc(file, options, onProgress, tocPageOffset)
}

function calculateOutputPageCount(width: number, height: number, options: ConversionOptions): number {
  if (options.manhwa) return 0
  let count = 0
  if (options.sidewaysOverviews) count++
  if (options.includeOverviews) count++
  if (options.orientation === 'portrait') count++
  else {
    const isWide = width >= height
    if (isWide && options.landscapeSplit && options.landscapeSplit !== 'none') {
      // Landscape split: method follows splitMode
      if (options.splitMode === 'nosplit') {
        count += 1 // No split, just rotate and letterbox
      } else if (options.splitMode === 'overlap') {
        const dims = DEVICE_DIMENSIONS[options.device] || DEVICE_DIMENSIONS.X4
        const segs = calculateHorizontalOverlapSegments(width, height, dims.width, dims.height)
        count += segs.length
      } else {
        count += 2 // Split in half
      }
    } else {
      const shouldSplit = width < height && options.splitMode !== 'nosplit'
      count += shouldSplit ? (options.splitMode === 'overlap' ? 3 : 2) : 1
    }
  }
  return count
}

/**
 * Convert a CBZ file to XTC format
 */
export async function convertCbzToXtc(
  file: File,
  options: ConversionOptions,
  onProgress: (progress: number, previewUrl: string | null) => void,
  tocPageOffset: number = 0
): Promise<ConversionResult> {
  const zipReader = new ZipReader(new BlobReader(file))
  try {
    const entries = await zipReader.getEntries()
    const imageFiles: Array<{ path: string; entry: any }> = []
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']
    let comicInfoEntry: any = null

    for (const entry of entries) {
      if (entry.directory) continue
      const path = entry.filename
      if (path.toLowerCase().startsWith('__macos')) continue
      const ext = path.toLowerCase().substring(path.lastIndexOf('.'))
      if (imageExtensions.includes(ext)) imageFiles.push({ path, entry })
      if (path.toLowerCase().endsWith('comicinfo.xml')) comicInfoEntry = entry
    }

    imageFiles.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }))
    if (imageFiles.length === 0) throw new Error('No images found in CBZ')

    const pageTitles = new Map<number, string>()
    let metadata: BookMetadata = { toc: [] }
    if (comicInfoEntry) {
      try {
        const xmlContent = await comicInfoEntry.getData(new TextWriter())
        const cmMeta = parseComicInfo(xmlContent)
        cmMeta.toc.forEach(entry => pageTitles.set(entry.startPage, entry.title))
        if (cmMeta.title) metadata.title = cmMeta.title
        if (cmMeta.author) metadata.author = cmMeta.author
      } catch { }
    }

    imageFiles.forEach((file, index) => {
      const parts = file.path.split('/')
      if (parts.length > 1) {
        const folderName = parts[parts.length - 2]
        if (!pageTitles.has(index + 1)) pageTitles.set(index + 1, folderName)
      }
    })

    metadata.toc = imageFiles.map((_, index) => {
      const pg = index + 1
      let title = `Page ${pg + tocPageOffset}`
      if (pageTitles.has(pg)) title = `${title} - ${pageTitles.get(pg)}`
      return { title, startPage: pg, endPage: pg }
    })

    const mappingCtx = new PageMappingContext()
    const dims = getTargetDimensions(options)
    const outputFileName = file.name.replace(/\.[^/.]+$/, options.compressXtcz ? '.xtcz' : (options.is2bit ? '.xtch' : '.xtc'))
    const pageImages: string[] = []

    if (options.streamedDownload && !options.manhwa) {
      const pageInfos: StreamPageInfo[] = []
      
      // Optimization: If no splitting or overviews, we know each file is 1 page.
      const isSimple1to1 = options.splitMode === 'nosplit' && !options.sidewaysOverviews && !options.includeOverviews && (!options.landscapeSplit || options.landscapeSplit === 'none');

      if (isSimple1to1) {
        for (let i = 0; i < imageFiles.length; i++) {
          pageInfos.push({ width: dims.width, height: dims.height })
          mappingCtx.addOriginalPage(i + 1, 1)
        }
      } else {
        // Pass 1: Analysis
        for (let i = 0; i < imageFiles.length; i++) {
          onProgress(i / imageFiles.length * 0.05, null)
          const imgBlob = await imageFiles[i].entry.getData(new BlobWriter())
          const imgDims = await getImageDimensions(imgBlob)
          const crop = getAxisCropRect(imgDims.width, imgDims.height, options)
          const count = calculateOutputPageCount(crop.width, crop.height, options)
          for (let j = 0; j < count; j++) pageInfos.push({ width: dims.width, height: dims.height })
          mappingCtx.addOriginalPage(i + 1, count)
        }
      }

      if (metadata.toc.length > 0) {
        const totalXtcPages = mappingCtx.getTotalXtcPages()
        metadata.toc = metadata.toc.map((entry, index) => {
          const adjustedStartPage = mappingCtx.getXtcPage(entry.startPage)
          let adjustedEndPage = index < metadata.toc.length - 1 ? mappingCtx.getXtcPage(metadata.toc[index+1].startPage) - 1 : totalXtcPages
          return { title: entry.title, startPage: adjustedStartPage, endPage: adjustedEndPage }
        })
      }
      
      const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { metadata, is2bit: options.is2bit })
      let totalSize = headerAndIndex.byteLength
      for (const info of pageInfos) totalSize += getXtcPageSize(info.width, info.height, options.is2bit)

      onProgress(0.05, null)

      let writer: WritableStreamDefaultWriter<any> | null = null
      try {
        const fileStream = streamSaver.createWriteStream(outputFileName, { size: totalSize })
        writer = fileStream.getWriter()
        await writer.write(headerAndIndex)
      } catch (err) {
        throw new Error('Failed to initiate streamed download.')
      }

      // Pass 2: Pipelined Processing — extract and process in parallel batches, write in order
      const STREAM_CONCURRENCY = 4;
      for (let i = 0; i < imageFiles.length; i += STREAM_CONCURRENCY) {
        const batch = imageFiles.slice(i, i + STREAM_CONCURRENCY);
        const tasks = batch.map(async (file, batchIdx) => {
          const globalIdx = i + batchIdx;
          const data = await file.entry.getData(new Uint8ArrayWriter());
          const result = await processImageAsBinary(data, globalIdx + 1, options, pageImages.length < 50);
          return { globalIdx, result };
        });

        const batchResults = await Promise.all(tasks);
        batchResults.sort((a, b) => a.globalIdx - b.globalIdx);

        for (const item of batchResults) {
          for (const res of item.result.results) {
            await writer!.write(new Uint8Array(res.buffer))
            if (pageImages.length < 50) pageImages.push(res.preview)
          }
        }
        onProgress(0.05 + Math.min(1, (i + STREAM_CONCURRENCY) / imageFiles.length) * 0.95, null)
      }
      
      await writer.close()
      await zipReader.close()
      return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
    } else {
      // High-Performance Parallel Path
      const pageBuffers: ArrayBuffer[] = []; const pageInfos: StreamPageInfo[] = []
      let stitcher: ManhwaStitcher | null = options.manhwa ? new ManhwaStitcher(options) : null
      
      if (stitcher) {
        // Manhwa mode must be sequential due to stitching logic
        let nextData = imageFiles[0].entry.getData(new Uint8ArrayWriter());
        for (let i = 0; i < imageFiles.length; i++) {
          const imgData = await nextData;
          if (i + 1 < imageFiles.length) {
            nextData = imageFiles[i + 1].entry.getData(new Uint8ArrayWriter());
          }
          const blob = new Blob([imgData]);
          const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
          const slices = await stitcher.append(bitmap)
          bitmap.close()
          for (const slice of slices) {
            const res = processAndEncode(slice.canvas, options, pageImages.length < 50)
            pageBuffers.push(res.buffer); pageInfos.push({ width: dims.width, height: dims.height })
            if (pageImages.length < 50) pageImages.push(res.preview)
          }
          mappingCtx.addOriginalPage(i + 1, slices.length)
          if (i % 5 === 0) onProgress((i + 1) / imageFiles.length, null)
        }
      } else {
        // Standard Manga/Comic: Process in parallel batches
        const CONCURRENCY = 6; // Increased for modern phones
        for (let i = 0; i < imageFiles.length; i += CONCURRENCY) {
          const batch = imageFiles.slice(i, i + CONCURRENCY);
          const tasks = batch.map(async (file, batchIdx) => {
            const globalIdx = i + batchIdx;
            const data = await file.entry.getData(new Uint8ArrayWriter());
            const result = await processImageAsBinary(data, globalIdx + 1, options, pageImages.length < 50);
            return { globalIdx, result };
          });

          const batchResults = await Promise.all(tasks);
          batchResults.sort((a, b) => a.globalIdx - b.globalIdx);

          for (const item of batchResults) {
            for (const res of item.result.results) {
              pageBuffers.push(res.buffer); pageInfos.push({ width: dims.width, height: dims.height })
              if (pageImages.length < 50) pageImages.push(res.preview)
            }
            mappingCtx.addOriginalPage(item.globalIdx + 1, item.result.results.length)
          }
          onProgress(Math.min(1, (i + CONCURRENCY) / imageFiles.length), null)
        }
      }
      
      if (stitcher) {
        for (const p of stitcher.finish()) {
          const res = await processAndEncode(p.canvas, options, pageImages.length < 50)
          pageBuffers.push(res.buffer); pageInfos.push({ width: p.canvas.width, height: p.canvas.height })
          if (pageImages.length < 50) pageImages.push(res.preview)
        }
      }
      
      if (metadata.toc.length > 0) {
        const totalXtcPages = mappingCtx.getTotalXtcPages()
        metadata.toc = metadata.toc.map((entry, index) => {
          const adjustedStartPage = mappingCtx.getXtcPage(entry.startPage)
          let adjustedEndPage = index < metadata.toc.length - 1 ? mappingCtx.getXtcPage(metadata.toc[index+1].startPage) - 1 : totalXtcPages
          return { title: entry.title, startPage: adjustedStartPage, endPage: adjustedEndPage }
        })
      }
      
      await zipReader.close()
      
      if (options.streamedDownload) {
        const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { metadata, is2bit: options.is2bit })
        let totalSize = headerAndIndex.byteLength
        for (const info of pageInfos) totalSize += getXtcPageSize(info.width, info.height, options.is2bit)
        const fileStream = streamSaver.createWriteStream(outputFileName, { size: totalSize })
        const writer = fileStream.getWriter()
        await writer.write(headerAndIndex)
        for (const buf of pageBuffers) await writer.write(new Uint8Array(buf))
        await writer.close()
        return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
      } else {
        let xtcData = await buildXtcFromBuffers(pageBuffers, { metadata, is2bit: options.is2bit })
        if (options.compressXtcz) xtcData = await compressXtczAsync(xtcData)
        return { name: outputFileName, data: xtcData, size: xtcData.byteLength, pageCount: pageInfos.length, pageImages }
      }
    }
  } catch (e) {
    await zipReader.close()
    throw e
  }
}

let wasmBinaryCache: ArrayBuffer | null = null
async function loadUnrarWasm(): Promise<ArrayBuffer> {
  if (wasmBinaryCache) return wasmBinaryCache
  const response = await fetch(unrarWasm); wasmBinaryCache = await response.arrayBuffer(); return wasmBinaryCache
}

export async function convertCbrToXtc(
  file: File,
  options: ConversionOptions,
  onProgress: (progress: number, previewUrl: string | null) => void,
  tocPageOffset: number = 0
): Promise<ConversionResult> {
  const wasmBinary = await loadUnrarWasm()
  const arrayBuffer = await file.arrayBuffer()
  const extractor = await createExtractorFromData({ data: arrayBuffer, wasmBinary })
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']
  const imageFiles: Array<{ path: string; data: Uint8Array }> = []
  let comicInfoContent: string | null = null

  const { files } = extractor.extract()
  for (const extractedFile of files) {
    if (extractedFile.fileHeader.flags.directory) continue
    const path = extractedFile.fileHeader.name
    if (imageExtensions.includes(path.toLowerCase().substring(path.lastIndexOf('.'))) && extractedFile.extraction) imageFiles.push({ path, data: extractedFile.extraction })
    if (path.toLowerCase().endsWith('comicinfo.xml') && extractedFile.extraction) comicInfoContent = new TextDecoder().decode(extractedFile.extraction)
  }

  imageFiles.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }))
  if (imageFiles.length === 0) throw new Error('No images found in CBR')

  const pageTitles = new Map<number, string>()
  let metadata: BookMetadata = { toc: [] }
  if (comicInfoContent) {
    try { const cmMeta = parseComicInfo(comicInfoContent); if (cmMeta.title) metadata.title = cmMeta.title; if (cmMeta.author) metadata.author = cmMeta.author } catch { }
  }
  metadata.toc = imageFiles.map((_, index) => ({ title: `Page ${index + 1 + tocPageOffset}`, startPage: index + 1, endPage: index + 1 }))

  const mappingCtx = new PageMappingContext(); const dims = getTargetDimensions(options); const outputFileName = file.name.replace(/\.[^/.]+$/, options.compressXtcz ? '.xtcz' : (options.is2bit ? '.xtch' : '.xtc')); 
  const pageImages: string[] = []

  if (options.streamedDownload && !options.manhwa) {
    const pageInfos: StreamPageInfo[] = []

    // Optimization: If no splitting or overviews, we know each file is 1 page.
    const isSimple1to1 = options.splitMode === 'nosplit' && !options.sidewaysOverviews && !options.includeOverviews && (!options.landscapeSplit || options.landscapeSplit === 'none');

    if (isSimple1to1) {
      for (let i = 0; i < imageFiles.length; i++) {
        pageInfos.push({ width: dims.width, height: dims.height })
        mappingCtx.addOriginalPage(i + 1, 1)
      }
    } else {
      for (let i = 0; i < imageFiles.length; i++) {
        onProgress(i / imageFiles.length * 0.05, null)
        const imgBlob = new Blob([new Uint8Array(imageFiles[i].data)])
        const imgDims = await getImageDimensions(imgBlob)
        const crop = getAxisCropRect(imgDims.width, imgDims.height, options)
        const count = calculateOutputPageCount(crop.width, crop.height, options)
        for (let j = 0; j < count; j++) pageInfos.push({ width: dims.width, height: dims.height })
        mappingCtx.addOriginalPage(i + 1, count)
      }
    }

    if (metadata.toc.length > 0) {
      const totalXtcPages = mappingCtx.getTotalXtcPages()
      metadata.toc = metadata.toc.map((entry, index) => {
        const adjustedStartPage = mappingCtx.getXtcPage(entry.startPage)
        let adjustedEndPage = index < metadata.toc.length - 1 ? mappingCtx.getXtcPage(metadata.toc[index+1].startPage) - 1 : totalXtcPages
        return { title: entry.title, startPage: adjustedStartPage, endPage: adjustedEndPage }
      })
    }
    const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { metadata, is2bit: options.is2bit })
    let totalSize = headerAndIndex.byteLength
    for (const info of pageInfos) totalSize += getXtcPageSize(info.width, info.height, options.is2bit)

    const fileStream = streamSaver.createWriteStream(outputFileName, { size: totalSize })
    const writer = fileStream.getWriter()
    await writer.write(headerAndIndex)

    const CONCURRENCY = 6;
    for (let i = 0; i < imageFiles.length; i += CONCURRENCY) {
      const batch = imageFiles.slice(i, i + CONCURRENCY);
      const tasks = batch.map(async (file, batchIdx) => {
        const globalIdx = i + batchIdx;
        const result = await processImageAsBinary(file.data, globalIdx + 1, options, pageImages.length < 50);
        return { globalIdx, result };
      });

      const batchResults = await Promise.all(tasks);
      batchResults.sort((a, b) => a.globalIdx - b.globalIdx);

      for (const item of batchResults) {
        for (const res of item.result.results) {
          await writer.write(new Uint8Array(res.buffer))
          if (pageImages.length < 50) pageImages.push(res.preview)
        }
      }
      onProgress(0.05 + Math.min(1, (i + CONCURRENCY) / imageFiles.length) * 0.95, null)
    }
    await writer.close()
    return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
    } else {
      // High-Performance Parallel Path
      const pageBuffers: ArrayBuffer[] = []; const pageInfos: StreamPageInfo[] = []
      let stitcher = options.manhwa ? new ManhwaStitcher(options) : null

      if (stitcher) {
        for (let i = 0; i < imageFiles.length; i++) {
          const imgBlob = new Blob([new Uint8Array(imageFiles[i].data)])
          const bitmap = await createImageBitmap(imgBlob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
          const slices = await stitcher.append(bitmap)
          bitmap.close()
          for (const slice of slices) {
            const res = processAndEncode(slice.canvas, options, pageImages.length < 50)
            pageBuffers.push(res.buffer); pageInfos.push({ width: dims.width, height: dims.height })
            if (pageImages.length < 50) pageImages.push(res.preview)
          }
          mappingCtx.addOriginalPage(i + 1, slices.length)
          if (i % 5 === 0) onProgress((i + 1) / imageFiles.length, null)
        }
      } else {
        const CONCURRENCY = 6;
        for (let i = 0; i < imageFiles.length; i += CONCURRENCY) {
          const batch = imageFiles.slice(i, i + CONCURRENCY);
          const tasks = batch.map(async (file, batchIdx) => {
            const globalIdx = i + batchIdx;
            const result = await processImageAsBinary(file.data, globalIdx + 1, options, pageImages.length < 50);
            return { globalIdx, result };
          });

          const batchResults = await Promise.all(tasks);
          batchResults.sort((a, b) => a.globalIdx - b.globalIdx);

          for (const item of batchResults) {
            for (const res of item.result.results) {
              pageBuffers.push(res.buffer); pageInfos.push({ width: dims.width, height: dims.height })
              if (pageImages.length < 50) pageImages.push(res.preview)
            }
            mappingCtx.addOriginalPage(item.globalIdx + 1, item.result.results.length)
          }
          onProgress(Math.min(1, (i + CONCURRENCY) / imageFiles.length), null)
        }
      }    if (stitcher) {
      for (const p of stitcher.finish()) {
        const res = await processAndEncode(p.canvas, options, pageImages.length < 50)
        pageBuffers.push(res.buffer); pageInfos.push({ width: p.canvas.width, height: p.canvas.height })
        if (pageImages.length < 50) pageImages.push(res.preview)
      }
    }
    if (metadata.toc.length > 0) {
      const totalXtcPages = mappingCtx.getTotalXtcPages()
      metadata.toc = metadata.toc.map((entry, index) => {
        const adjustedStartPage = mappingCtx.getXtcPage(entry.startPage)
        let adjustedEndPage = index < metadata.toc.length - 1 ? mappingCtx.getXtcPage(metadata.toc[index+1].startPage) - 1 : totalXtcPages
        return { title: entry.title, startPage: adjustedStartPage, endPage: adjustedEndPage }
      })
    }
    if (options.streamedDownload) {
      const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { metadata, is2bit: options.is2bit })
      let totalSize = headerAndIndex.byteLength
      for (const info of pageInfos) totalSize += getXtcPageSize(info.width, info.height, options.is2bit)
      const fileStream = streamSaver.createWriteStream(outputFileName, { size: totalSize }); const writer = fileStream.getWriter()
      await writer.write(headerAndIndex)
      for (const buf of pageBuffers) await writer.write(new Uint8Array(buf))
      await writer.close()
      return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
    } else {
      let xtcData = await buildXtcFromBuffers(pageBuffers, { metadata, is2bit: options.is2bit })
      if (options.compressXtcz) xtcData = await compressXtczAsync(xtcData)
      return { name: outputFileName, data: xtcData, size: xtcData.byteLength, pageCount: pageInfos.length, pageImages }
    }
  }
}

async function convertPdfToXtc(
  file: File,
  options: ConversionOptions,
  onProgress: (progress: number, previewUrl: string | null) => void,
  tocPageOffset: number = 0
): Promise<ConversionResult> {
  const url = URL.createObjectURL(file)
  const pdf = await pdfjsLib.getDocument(url).promise
  let metadata: BookMetadata = { toc: [] }
  try { metadata = await extractPdfMetadata(pdf) } catch (e) { }
  const numPages = pdf.numPages
  metadata.toc = []
  for (let i = 1; i <= numPages; i++) {
    let title = `Page ${i + tocPageOffset}`
    metadata.toc.push({ title, startPage: i, endPage: i })
  }

  const mappingCtx = new PageMappingContext(); const dims = getTargetDimensions(options); const outputFileName = file.name.replace(/\.[^/.]+$/, options.compressXtcz ? '.xtcz' : (options.is2bit ? '.xtch' : '.xtc'))
  const pageImages: string[] = []

  if (options.streamedDownload && !options.manhwa) {
    const pageInfos: StreamPageInfo[] = []

    // Optimization: If no splitting or overviews, we know each file is 1 page.
    const isSimple1to1 = options.splitMode === 'nosplit' && !options.sidewaysOverviews && !options.includeOverviews && (!options.landscapeSplit || options.landscapeSplit === 'none');

    if (isSimple1to1) {
      for (let i = 1; i <= numPages; i++) {
        pageInfos.push({ width: dims.width, height: dims.height })
        mappingCtx.addOriginalPage(i, 1)
      }
    } else {
      for (let i = 1; i <= numPages; i++) {
        onProgress(i / numPages * 0.05, null)
        const page = await pdf.getPage(i); const viewport = page.getViewport({ scale: 1 })
        const count = calculateOutputPageCount(viewport.width, viewport.height, options)
        for (let j = 0; j < count; j++) pageInfos.push({ width: dims.width, height: dims.height })
        mappingCtx.addOriginalPage(i, count)
      }
    }
    if (metadata.toc.length > 0) {
      const totalXtcPages = mappingCtx.getTotalXtcPages()
      metadata.toc = metadata.toc.map((entry, index) => {
        const adjustedStartPage = mappingCtx.getXtcPage(entry.startPage)
        let adjustedEndPage = index < metadata.toc.length - 1 ? mappingCtx.getXtcPage(metadata.toc[index+1].startPage) - 1 : totalXtcPages
        return { title: entry.title, startPage: adjustedStartPage, endPage: adjustedEndPage }
      })
    }
    const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { metadata, is2bit: options.is2bit })
    let totalSize = headerAndIndex.byteLength
    for (const info of pageInfos) totalSize += getXtcPageSize(info.width, info.height, options.is2bit)
    
    const fileStream = streamSaver.createWriteStream(outputFileName, { size: totalSize }); const writer = fileStream.getWriter()
    await writer.write(headerAndIndex)
    
    const CONCURRENCY = 4;
    for (let i = 1; i <= numPages; i += CONCURRENCY) {
      const tasks = [];
      for (let j = 0; j < CONCURRENCY && (i + j) <= numPages; j++) {
        const pageNum = i + j;
        tasks.push((async () => {
          const page = await pdf.getPage(pageNum);
          const scale = 2.0;
          const viewport = page.getViewport({ scale });
          const canvas = sharedCanvasPool.acquire(viewport.width, viewport.height);
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport, background: 'rgb(255,255,255)', canvas: canvas as any }).promise;
          const results = await processCanvasAsImage(canvas, pageNum, options, pageImages.length < 50);
          sharedCanvasPool.release(canvas);
          return { pageNum, results };
        })());
      }

      const batchResults = await Promise.all(tasks);
      batchResults.sort((a, b) => a.pageNum - b.pageNum);

      for (const item of batchResults) {
        for (const res of item.results) {
          await writer.write(new Uint8Array(res.buffer))
          if (pageImages.length < 50) pageImages.push(res.preview)
        }
      }
      onProgress(0.05 + Math.min(1, (i + CONCURRENCY - 1) / numPages) * 0.95, null)
    }
    await writer.close(); URL.revokeObjectURL(url)
    return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
  } else {
    const pageBuffers: ArrayBuffer[] = []; const pageInfos: StreamPageInfo[] = []
    let stitcher = options.manhwa ? new ManhwaStitcher(options) : null
    
    if (stitcher) {
      for (let i = 1; i <= numPages; i++) {
        const page = await pdf.getPage(i); const scale = 2.0; const viewport = page.getViewport({ scale })
        const canvas = sharedCanvasPool.acquire(viewport.width, viewport.height)
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport, background: 'rgb(255,255,255)', canvas: canvas as any }).promise
        const slices = await stitcher.append(canvas)
        sharedCanvasPool.release(canvas)
        for (const slice of slices) {
          const res = processAndEncode(slice.canvas, options, pageImages.length < 50)
          pageBuffers.push(res.buffer); pageInfos.push({ width: dims.width, height: dims.height })
          if (pageImages.length < 50) pageImages.push(res.preview)
        }
        mappingCtx.addOriginalPage(i, slices.length)
        onProgress(i / numPages, null)
      }
    } else {
      const CONCURRENCY = 4; // PDF rendering is memory heavy, keep concurrency lower than images
      for (let i = 1; i <= numPages; i += CONCURRENCY) {
        const tasks = [];
        for (let j = 0; j < CONCURRENCY && (i + j) <= numPages; j++) {
          const pageNum = i + j;
          tasks.push((async () => {
            const page = await pdf.getPage(pageNum);
            const scale = 2.0;
            const viewport = page.getViewport({ scale });
            const canvas = sharedCanvasPool.acquire(viewport.width, viewport.height);
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport, background: 'rgb(255,255,255)', canvas: canvas as any }).promise;
            const results = await processCanvasAsImage(canvas, pageNum, options, pageImages.length < 50);
            sharedCanvasPool.release(canvas);
            return { pageNum, results };
          })());
        }

        const batchResults = await Promise.all(tasks);
        batchResults.sort((a, b) => a.pageNum - b.pageNum);

        for (const item of batchResults) {
          for (const res of item.results) {
            pageBuffers.push(res.buffer); pageInfos.push({ width: dims.width, height: dims.height })
            if (pageImages.length < 50) pageImages.push(res.preview)
          }
          mappingCtx.addOriginalPage(item.pageNum, item.results.length)
        }
        onProgress(Math.min(1, (i + CONCURRENCY - 1) / numPages), null)
      }
    }
    if (stitcher) {
      for (const p of stitcher.finish()) {
        const res = await processAndEncode(p.canvas, options, pageImages.length < 50)
        pageBuffers.push(res.buffer); pageInfos.push({ width: p.canvas.width, height: p.canvas.height })
        if (pageImages.length < 50) pageImages.push(res.preview)
      }
    }
    if (metadata.toc.length > 0) {
      const totalXtcPages = mappingCtx.getTotalXtcPages()
      metadata.toc = metadata.toc.map((entry, index) => {
        const adjustedStartPage = mappingCtx.getXtcPage(entry.startPage)
        let adjustedEndPage = index < metadata.toc.length - 1 ? mappingCtx.getXtcPage(metadata.toc[index+1].startPage) - 1 : totalXtcPages
        return { title: entry.title, startPage: adjustedStartPage, endPage: adjustedEndPage }
      })
    }
    if (options.streamedDownload) {
      const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { metadata, is2bit: options.is2bit })
      let totalSize = headerAndIndex.byteLength
      for (const info of pageInfos) totalSize += getXtcPageSize(info.width, info.height, options.is2bit)
      const fileStream = streamSaver.createWriteStream(outputFileName, { size: totalSize }); const writer = fileStream.getWriter()
      await writer.write(headerAndIndex); for (const buf of pageBuffers) await writer.write(new Uint8Array(buf))
      await writer.close(); URL.revokeObjectURL(url)
      return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
    } else {
      let xtcData = await buildXtcFromBuffers(pageBuffers, { metadata, is2bit: options.is2bit })
      if (options.compressXtcz) xtcData = await compressXtczAsync(xtcData)
      URL.revokeObjectURL(url)
      return { name: outputFileName, data: xtcData, size: xtcData.byteLength, pageCount: pageInfos.length, pageImages }
    }
  }
}

async function convertImageToXtc(file: File, options: ConversionOptions, onProgress: (p: number, pr: string | null) => void): Promise<ConversionResult> {
  const result = await processImageAsBinary(new Uint8Array(await file.arrayBuffer()), 1, options)
  if (result.results.length === 0) throw new Error('Failed')
  return { name: file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xth' : '.xtg'), data: result.results[0].buffer, size: result.results[0].buffer.byteLength, pageCount: 1, pageImages: [result.results[0].preview] }
}

/**
 * Pack multiple image files into a single XTC/XTCH container.
 * Each image becomes one page in the output file.
 */
export async function convertImagesToXtcPack(
  files: File[],
  options: ConversionOptions,
  onProgress: (progress: number, previewUrl: string | null) => void
): Promise<ConversionResult> {
  if (options.useWasm) try { await initWasm() } catch (e) { console.error("Wasm init failed", e) }

  const pageBuffers: ArrayBuffer[] = []
  const pageInfos: StreamPageInfo[] = []
  const pageImages: string[] = []
  const dims = getTargetDimensions(options)

  // Track which page index each file starts at (for TOC)
  const fileTocEntries: { name: string, startPage: number }[] = []
  let currentPage = 1

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    onProgress(i / files.length, null)

    fileTocEntries.push({ name: file.name.replace(/\.[^/.]+$/, ''), startPage: currentPage })

    const result = await processImageAsBinary(new Uint8Array(await file.arrayBuffer()), i + 1, options, pageImages.length < 50)
    for (const res of result.results) {
      pageBuffers.push(res.buffer)
      pageInfos.push({ width: dims.width, height: dims.height })
      if (pageImages.length < 50) pageImages.push(res.preview)
      currentPage++
    }
  }

  onProgress(1, null)

  // Build metadata with TOC entries from filenames
  const metadata: BookMetadata = {
    title: files[0].name.replace(/\.[^/.]+$/, ''),
    toc: fileTocEntries.map((entry, idx) => ({
      title: entry.name,
      startPage: entry.startPage,
      endPage: idx < fileTocEntries.length - 1 ? fileTocEntries[idx + 1].startPage - 1 : pageBuffers.length,
    })),
  }

  // Determine output filename from first file
  const baseName = files[0].name.replace(/\.[^/.]+$/, '')
  const suffix = files.length > 1 ? `_${files.length}pages` : ''
  const ext = options.compressXtcz ? '.xtcz' : (options.is2bit ? '.xtch' : '.xtc')
  const outputFileName = `${baseName}${suffix}${ext}`

  if (options.streamedDownload) {
    const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { is2bit: options.is2bit, metadata })
    let totalSize = headerAndIndex.byteLength
    for (const info of pageInfos) totalSize += getXtcPageSize(info.width, info.height, options.is2bit)
    const fileStream = streamSaver.createWriteStream(outputFileName, { size: totalSize })
    const writer = fileStream.getWriter()
    await writer.write(headerAndIndex)
    for (const buf of pageBuffers) await writer.write(new Uint8Array(buf))
    await writer.close()
    return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
  } else {
    let xtcData = await buildXtcFromBuffers(pageBuffers, { is2bit: options.is2bit, metadata })
    if (options.compressXtcz) xtcData = await compressXtczAsync(xtcData)
    return { name: outputFileName, data: xtcData, size: xtcData.byteLength, pageCount: pageBuffers.length, pageImages }
  }
}


async function convertVideoToXtc(file: File, options: ConversionOptions, onProgress: (p: number, pr: string | null) => void): Promise<ConversionResult> {
  const frames = await extractFramesFromVideo(file, options.videoFps || 1.0)
  const pageBuffers: ArrayBuffer[] = []; const pageInfos: StreamPageInfo[] = []; const pageImages: string[] = []
  const dims = getTargetDimensions(options)
  
  const CONCURRENCY = 6;
  for (let i = 0; i < frames.length; i += CONCURRENCY) {
    const batch = frames.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (frameCanvas, batchIdx) => {
      let canvas = frameCanvas; const angle = getOrientationAngle(options.orientation)
      if (angle !== 0 && (angle === 180 || canvas.width >= canvas.height)) canvas = rotateCanvas(canvas, angle)
      const finalCanvas = await resizeWithPadding(canvas, 0, dims.width, dims.height, !options.useWasm)
      const res = processAndEncode(finalCanvas, options, pageImages.length < 50)
      
      // Cleanup intermediate frames if they are copies
      if (canvas !== frameCanvas) sharedCanvasPool.release(canvas)
      sharedCanvasPool.release(finalCanvas)
      return res;
    }));

    for (const res of results) {
      pageBuffers.push(res.buffer); pageInfos.push({ width: dims.width, height: dims.height })
      if (pageImages.length < 50) pageImages.push(res.preview)
    }
    onProgress(Math.min(1, (i + CONCURRENCY) / frames.length), null)
  }
  const outputFileName = file.name.replace(/\.[^/.]+$/, options.compressXtcz ? '.xtcz' : (options.is2bit ? '.xtch' : '.xtc'))
  if (options.streamedDownload) {
    const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { is2bit: options.is2bit })
    let totalSize = headerAndIndex.byteLength
    for (const info of pageInfos) totalSize += getXtcPageSize(info.width, info.height, options.is2bit)
    const fileStream = streamSaver.createWriteStream(outputFileName, { size: totalSize }); const writer = fileStream.getWriter()
    await writer.write(headerAndIndex); for (const buf of pageBuffers) await writer.write(new Uint8Array(buf))
    await writer.close(); return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
  } else {
    let xtcData = await buildXtcFromBuffers(pageBuffers, { is2bit: options.is2bit })
    if (options.compressXtcz) xtcData = await compressXtczAsync(xtcData)
    return { name: outputFileName, data: xtcData, size: xtcData.byteLength, pageCount: pageBuffers.length, pageImages }
  }
}

async function extractFramesFromVideo(file: File, fps: number): Promise<HTMLCanvasElement[]> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video'); video.preload = 'auto'; video.muted = true; video.playsInline = true
    const url = URL.createObjectURL(file); video.src = url
    video.onloadedmetadata = async () => {
      const duration = video.duration; const frameCount = Math.max(1, Math.floor(duration * fps)); const frames: HTMLCanvasElement[] = []
      const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight; const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      for (let i = 0; i < frameCount; i++) {
        video.currentTime = i / fps; await new Promise((r) => { video.onseeked = () => {
          ctx.drawImage(video, 0, 0); const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height
          copy.getContext('2d')!.drawImage(canvas, 0, 0); frames.push(copy); r(null)
        } })
      }
      URL.revokeObjectURL(url); resolve(frames)
    }
    video.onerror = () => reject(new Error('Video failed'))
  })
}

async function processCanvasAsImage(sourceCanvas: HTMLCanvasElement, pageNum: number, options: ConversionOptions, generatePreview: boolean = true): Promise<{ buffer: ArrayBuffer, preview: string }[]> {
  const dims = getTargetDimensions(options); const results: { buffer: ArrayBuffer, preview: string }[] = []; const padColor = options.padBlack ? 0 : 255
  const crop = getAxisCropRect(sourceCanvas.width, sourceCanvas.height, options)
  const croppedCanvas = sharedCanvasPool.acquire(crop.width, crop.height)
  croppedCanvas.getContext('2d')!.drawImage(sourceCanvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)

  if (options.sidewaysOverviews) {
    const rotated = rotateCanvas(croppedCanvas, 90)
    const resized = await resizeWithPadding(rotated, padColor, dims.width, dims.height, !options.useWasm)
    results.push(processAndEncode(resized, options, generatePreview))
    sharedCanvasPool.release(rotated); sharedCanvasPool.release(resized)
  }
  if (options.includeOverviews) {
    const resized = await resizeWithPadding(croppedCanvas, padColor, dims.width, dims.height, !options.useWasm)
    results.push(processAndEncode(resized, options, generatePreview))
    sharedCanvasPool.release(resized)
  }
  
  const isSingleImage = options.sourceType === 'image' && !options.manhwa && options.splitMode === 'nosplit'
  if (isSingleImage) {
    let proc = croppedCanvas; 
    let rotated: HTMLCanvasElement | null = null;
    const angle = getOrientationAngle(options.orientation); 
    if (angle !== 0) {
      rotated = rotateCanvas(croppedCanvas, angle)
      proc = rotated
    }
    
    let final: HTMLCanvasElement
    if (options.imageMode === 'fill') final = await resizeHq(proc, dims.width, dims.height, options)
    else if (options.imageMode === 'cover') final = await resizeCover(proc, dims.width, dims.height, !options.useWasm)
    else if (options.imageMode === 'crop') final = resizeCrop(proc, dims.width, dims.height) // resizeCrop is synchronous
    else final = await resizeWithPadding(proc, padColor, dims.width, dims.height, !options.useWasm)
    
    results.push(processAndEncode(final, options, generatePreview))
    if (rotated) sharedCanvasPool.release(rotated)
    sharedCanvasPool.release(final)
    sharedCanvasPool.release(croppedCanvas)
    return results
  }

  if (options.manhwa) {
    const scale = dims.width / crop.width; const newHeight = Math.floor(crop.height * scale)
    const resized = await resizeHq(croppedCanvas, dims.width, newHeight, options)
    const sliceStep = dims.height - Math.floor(dims.height * (options.manhwaOverlap / 100))
    for (let y = 0; y < newHeight; ) {
      let h = Math.min(dims.height, newHeight - y); if (h < dims.height && newHeight > dims.height) { y = newHeight - dims.height; h = dims.height }
      const region = extractRegion(resized, 0, y, dims.width, h)
      const padded = await resizeWithPadding(region, padColor, dims.width, dims.height, !options.useWasm)
      results.push(processAndEncode(padded, options, generatePreview))
      sharedCanvasPool.release(region); sharedCanvasPool.release(padded)
      if (y + h >= newHeight) break; y += sliceStep
    }
    sharedCanvasPool.release(resized)
    sharedCanvasPool.release(croppedCanvas)
    return results
  }

  if (options.orientation === 'portrait') { 
    const padded = await resizeWithPadding(croppedCanvas, padColor, dims.width, dims.height, !options.useWasm)
    results.push(processAndEncode(padded, options, generatePreview))
    sharedCanvasPool.release(padded)
    sharedCanvasPool.release(croppedCanvas)
    return results 
  }
  
  const isWide = crop.width >= crop.height

  // Landscape splitting: split wide images based on splitMode, ordered by landscapeSplit direction
  if (isWide && options.landscapeSplit && options.landscapeSplit !== 'none' && options.splitMode !== 'nosplit') {
    const isRtl = options.landscapeSplit === 'rtl'

    if (options.splitMode === 'overlap') {
      // Overlapping horizontal segments
      const segs = calculateHorizontalOverlapSegments(crop.width, crop.height, dims.width, dims.height)
      const orderedSegs = isRtl ? [...segs].reverse() : segs
      for (const seg of orderedSegs) {
        const extracted = extractRegion(croppedCanvas, seg.x, seg.y, seg.w, seg.h)
        const padded = await resizeWithPadding(extracted, padColor, dims.width, dims.height, !options.useWasm)
        results.push(processAndEncode(padded, options, generatePreview))
        sharedCanvasPool.release(extracted); sharedCanvasPool.release(padded)
      }
    } else {
      // Split in half
      const halfWidth = Math.floor(crop.width / 2)
      const leftHalf = extractRegion(croppedCanvas, 0, 0, halfWidth, crop.height)
      const rightHalf = extractRegion(croppedCanvas, halfWidth, 0, crop.width - halfWidth, crop.height)

      const firstHalf = isRtl ? rightHalf : leftHalf
      const secondHalf = isRtl ? leftHalf : rightHalf

      const pad1 = await resizeWithPadding(firstHalf, padColor, dims.width, dims.height, !options.useWasm)
      results.push(processAndEncode(pad1, options, generatePreview))

      const pad2 = await resizeWithPadding(secondHalf, padColor, dims.width, dims.height, !options.useWasm)
      results.push(processAndEncode(pad2, options, generatePreview))

      sharedCanvasPool.release(leftHalf); sharedCanvasPool.release(rightHalf)
      sharedCanvasPool.release(pad1); sharedCanvasPool.release(pad2)
    }
  } else if (crop.width < crop.height && options.splitMode !== 'nosplit') {
    if (options.splitMode === 'overlap') {
      const segs = calculateOverlapSegments(crop.width, crop.height, dims.width, dims.height)
      for (const seg of segs) {
        const extracted = extractAndRotate(croppedCanvas, seg.x, seg.y, seg.w, seg.h)
        const padded = await resizeWithPadding(extracted, padColor, dims.width, dims.height, !options.useWasm)
        results.push(processAndEncode(padded, options, generatePreview))
        sharedCanvasPool.release(extracted); sharedCanvasPool.release(padded)
      }
    } else {
      const half = Math.floor(crop.height / 2)
      const ex1 = extractAndRotate(croppedCanvas, 0, 0, crop.width, half)
      const pad1 = await resizeWithPadding(ex1, padColor, dims.width, dims.height, !options.useWasm)
      results.push(processAndEncode(pad1, options, generatePreview))
      
      const ex2 = extractAndRotate(croppedCanvas, 0, half, crop.width, crop.height - half)
      const pad2 = await resizeWithPadding(ex2, padColor, dims.width, dims.height, !options.useWasm)
      results.push(processAndEncode(pad2, options, generatePreview))
      
      sharedCanvasPool.release(ex1); sharedCanvasPool.release(pad1)
      sharedCanvasPool.release(ex2); sharedCanvasPool.release(pad2)
    }
  } else {
    const rotated = rotateCanvas(croppedCanvas, 90)
    const padded = await resizeWithPadding(rotated, padColor, dims.width, dims.height, !options.useWasm)
    results.push(processAndEncode(padded, options, generatePreview))
    sharedCanvasPool.release(rotated); sharedCanvasPool.release(padded)
  }
  
  sharedCanvasPool.release(croppedCanvas)
  return results
}

async function processImageAsBinary(imgData: Uint8Array, pageNum: number, options: ConversionOptions, generatePreview: boolean = true): Promise<{ results: { buffer: ArrayBuffer, preview: string }[] }> {
  try {
    const blob = new Blob([imgData as any]);
    const bitmap = await createImageBitmap(blob, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none'
    });
    const canvas = sharedCanvasPool.acquire(bitmap.width, bitmap.height)
    canvas.getContext('2d', { willReadFrequently: true })!.drawImage(bitmap, 0, 0)
    bitmap.close()
    
    const results = await processCanvasAsImage(canvas, pageNum, options, generatePreview)
    sharedCanvasPool.release(canvas)
    return { results }
  } catch (e) {
    console.error('Image processing failed:', e)
    return { results: [] }
  }
}

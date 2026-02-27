// CBZ/CBR/PDF to XTC conversion logic

import { ZipReader, BlobReader, BlobWriter, TextWriter } from '@zip.js/zip.js'
import streamSaver from 'streamsaver'
import { createExtractorFromData } from 'node-unrar-js'
import unrarWasm from 'node-unrar-js/esm/js/unrar.wasm?url'
import * as pdfjsLib from 'pdfjs-dist'
import { applyDithering } from './processing/dithering'
import { toGrayscale, applyContrast, calculateOverlapSegments, isSolidColor, applyGamma, applyInvert } from './processing/image'
import { rotateCanvas, extractAndRotate, extractRegion, resizeWithPadding, resizeFill, resizeCover, resizeCrop, TARGET_WIDTH, TARGET_HEIGHT, DEVICE_DIMENSIONS } from './processing/canvas'
import { buildXtc, buildXtcFromBuffers, imageDataToXth, imageDataToXtg, wrapWasmData, buildXtcHeaderAndIndex, getXtcPageSize, type StreamPageInfo } from './xtc-format'
import { initWasm, runWasmFilters, isWasmLoaded, runWasmPack, runWasmResize } from './processing/wasm'

function getTargetDimensions(options: ConversionOptions) {
  return DEVICE_DIMENSIONS[options.device] || DEVICE_DIMENSIONS.X4;
}

function getOrientationAngle(orientation: string): number {
  return orientation === 'landscape' ? 90 : 0
}

/**
 * Get dimensions of an image blob without fully decoding it (browser still decodes header)
 */
async function getImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
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

/**
 * Resize a canvas with high-quality Box Filter if 1-bit and Wasm enabled
 */
function resizeHq(
  canvas: HTMLCanvasElement, 
  targetWidth: number, 
  targetHeight: number, 
  options: ConversionOptions
): HTMLCanvasElement {
  if (options.useWasm && isWasmLoaded() && !options.is2bit && (canvas.width !== targetWidth || canvas.height !== targetHeight)) {
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      const srcData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const resizedData = runWasmResize(srcData, targetWidth, targetHeight)
      const outCanvas = document.createElement('canvas')
      outCanvas.width = targetWidth
      outCanvas.height = targetHeight
      outCanvas.getContext('2d')!.putImageData(resizedData, 0, 0)
      return outCanvas
    } catch (e) {
      console.warn("Wasm resize failed, fallback to Canvas", e)
    }
  }
  return resizeFill(canvas, targetWidth, targetHeight)
}

/**
 * Encode a processed page to its final binary format (XTG/XTH)
 */
function encodePage(page: ProcessedPage, is2bit: boolean, useWasm: boolean): ArrayBuffer {
  const ctx = page.canvas.getContext('2d', { willReadFrequently: true })!
  const imageData = ctx.getImageData(0, 0, page.canvas.width, page.canvas.height)
  
  if (useWasm && isWasmLoaded()) {
    const packed = runWasmPack(imageData, is2bit)
    return wrapWasmData(packed, page.canvas.width, page.canvas.height, is2bit)
  }
  
  return is2bit ? imageDataToXth(imageData) : imageDataToXtg(imageData)
}

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
  fileType: 'cbz' | 'cbr' | 'pdf' | 'image' | 'video',
  options: ConversionOptions,
  onProgress: (progress: number, previewUrl: string | null) => void,
  tocPageOffset: number = 0
): Promise<ConversionResult> {
  if (options.useWasm) {
    try {
      await initWasm()
    } catch (e) {
      console.error("Wasm init failed", e)
    }
  }

  if (fileType === 'pdf') {
    return convertPdfToXtc(file, options, onProgress, tocPageOffset)
  }
  if (fileType === 'cbr') {
    return convertCbrToXtc(file, options, onProgress, tocPageOffset)
  }
  if (fileType === 'image') {
    return convertImageToXtc(file, options, onProgress)
  }
  if (fileType === 'video') {
    return convertVideoToXtc(file, options, onProgress)
  }
  return convertCbzToXtc(file, options, onProgress, tocPageOffset)
}

function calculateOutputPageCount(width: number, height: number, options: ConversionOptions): number {
  if (options.manhwa) return 0 // Manhwa is dynamic
  
  let count = 0
  if (options.sidewaysOverviews && !options.manhwa) count++
  if (options.includeOverviews && !options.manhwa) count++
  
  if (options.orientation === 'portrait') {
    count++
  } else {
    const shouldSplit = width < height && options.splitMode !== 'nosplit'
    if (shouldSplit) {
      count += (options.splitMode === 'overlap' ? 3 : 2)
    } else {
      count++
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
  const entries = await zipReader.getEntries()

  const imageFiles: Array<{ path: string; entry: any }> = []
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']
  let comicInfoEntry: any = null

  for (const entry of entries) {
    if (entry.directory) continue
    const path = entry.filename
    if (path.toLowerCase().startsWith('__macos')) continue

    const ext = path.toLowerCase().substring(path.lastIndexOf('.'))
    if (imageExtensions.includes(ext)) {
      imageFiles.push({ path, entry })
    }

    if (path.toLowerCase() === 'comicinfo.xml' || path.toLowerCase().endsWith('/comicinfo.xml')) {
      comicInfoEntry = entry
    }
  }

  imageFiles.sort((a, b) => a.path.localeCompare(b.path))

  if (imageFiles.length === 0) {
    await zipReader.close()
    throw new Error('No images found in CBZ')
  }

  // Extract metadata and generate TOC entries for every page
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
      if (!pageTitles.has(index + 1)) {
        pageTitles.set(index + 1, folderName)
      }
    }
  })

  metadata.toc = imageFiles.map((_, index) => {
    const pg = index + 1
    let title = `Page ${pg + tocPageOffset}`
    if (pageTitles.has(pg)) {
      title = `${title} - ${pageTitles.get(pg)}`
    }
    return { title, startPage: pg, endPage: pg }
  })

  const mappingCtx = new PageMappingContext()
  const dims = getTargetDimensions(options)
  const outputFileName = file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xtch' : '.xtc')
  const pageImages: string[] = []

  // Immediate Streaming Path (Non-Manhwa only)
  if (options.streamedDownload && !options.manhwa) {
    const pageInfos: StreamPageInfo[] = []
    
    // Pass 1: Dimensions & Layout
    for (let i = 0; i < imageFiles.length; i++) {
      onProgress(i / imageFiles.length * 0.05, null)
      const imgBlob = await imageFiles[i].entry.getData(new BlobWriter())
      const imgDims = await getImageDimensions(imgBlob)
      const crop = getAxisCropRect(imgDims.width, imgDims.height, options)
      const count = calculateOutputPageCount(crop.width, crop.height, options)
      
      for (let j = 0; j < count; j++) {
        pageInfos.push({ width: dims.width, height: dims.height })
      }
      mappingCtx.addOriginalPage(i + 1, count)
    }

    if (metadata.toc.length > 0) {
      metadata.toc = adjustTocForMapping(metadata.toc, mappingCtx)
    }
    const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { metadata, is2bit: options.is2bit })
    
    let totalSize = headerAndIndex.byteLength
    for (const info of pageInfos) {
      totalSize += getXtcPageSize(info.width, info.height, options.is2bit)
    }

    const fileStream = streamSaver.createWriteStream(outputFileName, { size: totalSize })
    const writer = fileStream.getWriter()
    await writer.write(headerAndIndex)

    // Pass 3: Process & Stream
    for (let i = 0; i < imageFiles.length; i++) {
      const imgBlob = await imageFiles[i].entry.getData(new BlobWriter())
      const pages = await processImage(imgBlob, i + 1, options)
      
      for (const page of pages) {
        const encoded = encodePage(page, options.is2bit, options.useWasm)
        await writer.write(new Uint8Array(encoded))
        if (pageImages.length < 10) {
          pageImages.push(page.canvas.toDataURL('image/png'))
        }
      }
      
      if (pages.length > 0) {
        onProgress(0.05 + (i + 1) / imageFiles.length * 0.95, pages[0].canvas.toDataURL('image/png'))
      }
    }
    
    await writer.close()
    return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages }
  } else {
    // Memory-Optimized Buffered Path
    const pageBlobs: Blob[] = []
    const pageInfos: StreamPageInfo[] = []
    
    let stitcher: ManhwaStitcher | null = null
    if (options.manhwa) {
      stitcher = new ManhwaStitcher(options)
    }

    for (let i = 0; i < imageFiles.length; i++) {
      const imgFile = imageFiles[i]
      const imgBlob = await imgFile.entry.getData(new BlobWriter())

      let pages: ProcessedPage[] = []
      
      if (stitcher) {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image()
            const url = URL.createObjectURL(imgBlob)
            img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
            img.onerror = () => { URL.revokeObjectURL(url); resolve(null as any) }
            img.src = url
        }).catch(() => null)
        
        if (img) {
            pages = await stitcher.append(img)
        }
      } else {
        pages = await processImage(imgBlob, i + 1, options)
      }
      
      for (const page of pages) {
        const encoded = encodePage(page, options.is2bit, options.useWasm)
        pageBlobs.push(new Blob([encoded]))
        pageInfos.push({ width: page.canvas.width, height: page.canvas.height })
        if (pageImages.length < 10) {
          pageImages.push(page.canvas.toDataURL('image/png'))
        }
      }

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
        for (const page of finalPages) {
          const encoded = encodePage(page, options.is2bit, options.useWasm)
          pageBlobs.push(new Blob([encoded]))
          pageInfos.push({ width: page.canvas.width, height: page.canvas.height })
          if (pageImages.length < 10) {
            pageImages.push(page.canvas.toDataURL('image/png'))
          }
        }
    }

    if (metadata.toc.length > 0) {
      metadata.toc = adjustTocForMapping(metadata.toc, mappingCtx)
    }

    if (options.streamedDownload) {
      const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { metadata, is2bit: options.is2bit })
      const fileStream = streamSaver.createWriteStream(outputFileName)
      const writer = fileStream.getWriter()
      await writer.write(headerAndIndex)
      for (const blob of pageBlobs) {
        const arrayBuffer = await blob.arrayBuffer()
        await writer.write(new Uint8Array(arrayBuffer))
      }
      await writer.close()
      URL.revokeObjectURL(url)
      return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages }
    } else {
      const allBuffers: ArrayBuffer[] = []
      for (const blob of pageBlobs) {
        allBuffers.push(await blob.arrayBuffer())
      }
      const xtcData = await buildXtcFromBuffers(allBuffers, { metadata, is2bit: options.is2bit })
      URL.revokeObjectURL(url)
      return { name: outputFileName, data: xtcData, size: xtcData.byteLength, pageCount: pageInfos.length, pageImages }
    }
  }
}

let wasmBinaryCache: ArrayBuffer | null = null

async function loadUnrarWasm(): Promise<ArrayBuffer> {
  if (wasmBinaryCache) return wasmBinaryCache
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
    if (path.toLowerCase().startsWith('__macos')) continue
    const ext = path.toLowerCase().substring(path.lastIndexOf('.'))
    if (imageExtensions.includes(ext) && extractedFile.extraction) {
      imageFiles.push({ path, data: extractedFile.extraction })
    }
    if ((path.toLowerCase() === 'comicinfo.xml' || path.toLowerCase().endsWith('/comicinfo.xml')) && extractedFile.extraction) {
      const decoder = new TextDecoder('utf-8')
      comicInfoContent = decoder.decode(extractedFile.extraction)
    }
  }

  imageFiles.sort((a, b) => a.path.localeCompare(b.path))
  if (imageFiles.length === 0) throw new Error('No images found in CBR')

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

  imageFiles.forEach((file, index) => {
    const parts = file.path.split(/[\\/]/)
    if (parts.length > 1) {
      const folderName = parts[parts.length - 2]
      if (!pageTitles.has(index + 1)) {
        pageTitles.set(index + 1, folderName)
      }
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
  const outputFileName = file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xtch' : '.xtc')
  const pageImages: string[] = []

  if (options.streamedDownload && !options.manhwa) {
    const pageInfos: StreamPageInfo[] = []
    for (let i = 0; i < imageFiles.length; i++) {
      onProgress(i / imageFiles.length * 0.05, null)
      const imgBlob = new Blob([new Uint8Array(imageFiles[i].data)])
      const imgDims = await getImageDimensions(imgBlob)
      const crop = getAxisCropRect(imgDims.width, imgDims.height, options)
      const count = calculateOutputPageCount(crop.width, crop.height, options)
      for (let j = 0; j < count; j++) pageInfos.push({ width: dims.width, height: dims.height })
      mappingCtx.addOriginalPage(i + 1, count)
    }

    if (metadata.toc.length > 0) metadata.toc = adjustTocForMapping(metadata.toc, mappingCtx)
    const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { metadata, is2bit: options.is2bit })
    let totalSize = headerAndIndex.byteLength
    for (const info of pageInfos) totalSize += getXtcPageSize(info.width, info.height, options.is2bit)

    const fileStream = streamSaver.createWriteStream(outputFileName, { size: totalSize })
    const writer = fileStream.getWriter()
    await writer.write(headerAndIndex)

    for (let i = 0; i < imageFiles.length; i++) {
      const imgBlob = new Blob([new Uint8Array(imageFiles[i].data)])
      const pages = await processImage(imgBlob, i + 1, options)
      for (const p of pages) {
        const encoded = encodePage(p, options.is2bit, options.useWasm)
        await writer.write(new Uint8Array(encoded))
        if (pageImages.length < 10) pageImages.push(p.canvas.toDataURL('image/png'))
      }
      if (pages.length > 0) onProgress(0.05 + (i + 1) / imageFiles.length * 0.95, pages[0].canvas.toDataURL('image/png'))
    }
    await writer.close()
    return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages }
  } else {
    const pageBlobs: Blob[] = []
    const pageInfos: StreamPageInfo[] = []
    let stitcher: ManhwaStitcher | null = null
    if (options.manhwa) stitcher = new ManhwaStitcher(options)

    for (let i = 0; i < imageFiles.length; i++) {
      const imgBlob = new Blob([new Uint8Array(imageFiles[i].data)])
      let pages: ProcessedPage[] = []
      if (stitcher) {
        const img = await new Promise<HTMLImageElement>((resolve) => {
          const img = new Image(); const url = URL.createObjectURL(imgBlob)
          img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
          img.onerror = () => { URL.revokeObjectURL(url); resolve(null as any) }
          img.src = url
        })
        if (img) pages = await stitcher.append(img)
      } else {
        pages = await processImage(imgBlob, i + 1, options)
      }
      for (const p of pages) {
        const encoded = encodePage(p, options.is2bit, options.useWasm)
        pageBlobs.push(new Blob([encoded])); pageInfos.push({ width: p.canvas.width, height: p.canvas.height })
        if (pageImages.length < 10) pageImages.push(p.canvas.toDataURL('image/png'))
      }
      mappingCtx.addOriginalPage(i + 1, pages.length)
      if (pages.length > 0 && pages[0].canvas) onProgress((i + 1) / imageFiles.length, pages[0].canvas.toDataURL('image/png'))
      else onProgress((i + 1) / imageFiles.length, null)
    }
    if (stitcher) {
      for (const p of stitcher.finish()) {
        const encoded = encodePage(p, options.is2bit, options.useWasm)
        pageBlobs.push(new Blob([encoded])); pageInfos.push({ width: p.canvas.width, height: p.canvas.height })
        if (pageImages.length < 10) pageImages.push(p.canvas.toDataURL('image/png'))
      }
    }
    if (metadata.toc.length > 0) metadata.toc = adjustTocForMapping(metadata.toc, mappingCtx)
    if (options.streamedDownload) {
      const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { metadata, is2bit: options.is2bit })
      const fileStream = streamSaver.createWriteStream(outputFileName); const writer = fileStream.getWriter()
      await writer.write(headerAndIndex)
      for (const blob of pageBlobs) await writer.write(new Uint8Array(await blob.arrayBuffer()))
      await writer.close()
      return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages }
    } else {
      const allBuffers: ArrayBuffer[] = []
      for (const blob of pageBlobs) allBuffers.push(await blob.arrayBuffer())
      const xtcData = await buildXtcFromBuffers(allBuffers, { metadata, is2bit: options.is2bit })
      return { name: outputFileName, data: xtcData, size: xtcData.byteLength, pageCount: pageInfos.length, pageImages }
    }
  }
}

/**
 * Convert a PDF file to XTC format
 */
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

  const pageTitles = new Map<number, string>()
  metadata.toc.forEach(entry => pageTitles.set(entry.startPage, entry.title))
  const numPages = pdf.numPages
  metadata.toc = []
  for (let i = 1; i <= numPages; i++) {
    let title = `Page ${i + tocPageOffset}`
    if (pageTitles.has(i)) title = `${title} - ${pageTitles.get(i)}`
    metadata.toc.push({ title, startPage: i, endPage: i })
  }

  const mappingCtx = new PageMappingContext()
  const dims = getTargetDimensions(options)
  const outputFileName = file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xtch' : '.xtc')
  const pageImages: string[] = []

  if (options.streamedDownload && !options.manhwa) {
    const pageInfos: StreamPageInfo[] = []
    for (let i = 1; i <= numPages; i++) {
      onProgress(i / numPages * 0.05, null)
      const page = await pdf.getPage(i); const viewport = page.getViewport({ scale: 1 })
      const count = calculateOutputPageCount(viewport.width, viewport.height, options)
      for (let j = 0; j < count; j++) pageInfos.push({ width: dims.width, height: dims.height })
      mappingCtx.addOriginalPage(i, count)
    }
    if (metadata.toc.length > 0) metadata.toc = adjustTocForMapping(metadata.toc, mappingCtx)
    const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { metadata, is2bit: options.is2bit })
    let totalSize = headerAndIndex.byteLength
    for (const info of pageInfos) totalSize += getXtcPageSize(info.width, info.height, options.is2bit)
    const fileStream = streamSaver.createWriteStream(outputFileName, { size: totalSize }); const writer = fileStream.getWriter()
    await writer.write(headerAndIndex)
    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i); const scale = 2.0; const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height
      await page.render({ canvas, viewport, background: 'rgb(255,255,255)' }).promise
      const xtcPages = processCanvasAsImage(canvas, i, options)
      for (const p of xtcPages) {
        const encoded = encodePage(p, options.is2bit, options.useWasm)
        await writer.write(new Uint8Array(encoded))
        if (pageImages.length < 10) pageImages.push(p.canvas.toDataURL('image/png'))
      }
      if (xtcPages.length > 0) onProgress(0.05 + i / numPages * 0.95, xtcPages[0].canvas.toDataURL('image/png'))
    }
    await writer.close()
    URL.revokeObjectURL(url)
    return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages }
  } else {
    const pageBlobs: Blob[] = []; const pageInfos: StreamPageInfo[] = []
    let stitcher: ManhwaStitcher | null = null
    if (options.manhwa) stitcher = new ManhwaStitcher(options)
    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i); const scale = 2.0; const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height
      await page.render({ canvas, viewport, background: 'rgb(255,255,255)' }).promise
      let pages: ProcessedPage[] = []
      if (stitcher) pages = await stitcher.append(canvas)
      else pages = processCanvasAsImage(canvas, i, options)
      for (const p of pages) {
        const encoded = encodePage(p, options.is2bit, options.useWasm)
        pageBlobs.push(new Blob([encoded])); pageInfos.push({ width: p.canvas.width, height: p.canvas.height })
        if (pageImages.length < 10) pageImages.push(p.canvas.toDataURL('image/png'))
      }
      mappingCtx.addOriginalPage(i, pages.length)
      if (pages.length > 0 && pages[0].canvas) onProgress(i / numPages, pages[0].canvas.toDataURL('image/png'))
      else onProgress(i / numPages, null)
    }
    if (stitcher) {
      for (const p of stitcher.finish()) {
        const encoded = encodePage(p, options.is2bit, options.useWasm)
        pageBlobs.push(new Blob([encoded])); pageInfos.push({ width: p.canvas.width, height: p.canvas.height })
        if (pageImages.length < 10) pageImages.push(p.canvas.toDataURL('image/png'))
      }
    }
    if (metadata.toc.length > 0) metadata.toc = adjustTocForMapping(metadata.toc, mappingCtx)
    if (options.streamedDownload) {
      const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { metadata, is2bit: options.is2bit })
      const fileStream = streamSaver.createWriteStream(outputFileName); const writer = fileStream.getWriter()
      await writer.write(headerAndIndex); for (const blob of pageBlobs) await writer.write(new Uint8Array(await blob.arrayBuffer()))
      await writer.close()
      return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages }
    } else {
      const allBuffers: ArrayBuffer[] = []
      for (const blob of pageBlobs) allBuffers.push(await blob.arrayBuffer())
      const xtcData = await buildXtcFromBuffers(allBuffers, { metadata, is2bit: options.is2bit })
      return { name: outputFileName, data: xtcData, size: xtcData.byteLength, pageCount: pageInfos.length, pageImages }
    }
  }
}

/**
 * Convert a single image file to XTC format
 */
async function convertImageToXtc(
  file: File,
  options: ConversionOptions,
  onProgress: (progress: number, previewUrl: string | null) => void
): Promise<ConversionResult> {
  const pages = await processImage(file, 1, options)
  if (pages.length === 0) throw new Error('Failed to process image')
  const page = pages[0]
  const dims = getTargetDimensions(options)
  const imageData = page.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, dims.width, dims.height)
  const xtcData = options.is2bit ? imageDataToXth(imageData) : imageDataToXtg(imageData)
  if (page.canvas) onProgress(1, page.canvas.toDataURL('image/png'))
  return {
    name: file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xth' : '.xtg'),
    data: xtcData,
    size: xtcData.byteLength,
    pageCount: 1,
    pageImages: [page.canvas.toDataURL('image/png')]
  }
}

/**
 * Convert a video file to XTC format
 */
async function convertVideoToXtc(
  file: File,
  options: ConversionOptions,
  onProgress: (progress: number, previewUrl: string | null) => void
): Promise<ConversionResult> {
  const fps = options.videoFps || 1.0
  const frames = await extractFramesFromVideo(file, fps)
  const processedPages: ProcessedPage[] = []
  const pageImages: string[] = []

  for (let i = 0; i < frames.length; i++) {
    const frameCanvas = frames[i]
    let width = frameCanvas.width; let height = frameCanvas.height; let canvas = frameCanvas
    const angle = getOrientationAngle(options.orientation)
    if (angle !== 0 && (angle === 180 || width >= height)) {
      canvas = rotateCanvas(frameCanvas, angle)
      width = canvas.width; height = canvas.height
    }
    const dims = getTargetDimensions(options)
    const finalCanvas = resizeWithPadding(canvas, 0, dims.width, dims.height)
    const ctx = finalCanvas.getContext('2d', { willReadFrequently: true })!
    if (options.useWasm && isWasmLoaded()) {
      try {
        const imageData = ctx.getImageData(0, 0, dims.width, dims.height)
        runWasmFilters(imageData, options.contrast, (options.is2bit) ? options.gamma : 1.0, options.invert)
        ctx.putImageData(imageData, 0, 0)
      } catch (e) {
        if (options.contrast > 0) applyContrast(ctx, dims.width, dims.height, options.contrast)
        if (options.gamma !== 1.0 && options.is2bit) applyGamma(ctx, dims.width, dims.height, options.gamma)
        if (options.invert) applyInvert(ctx, dims.width, dims.height)
        toGrayscale(ctx, dims.width, dims.height)
      }
    } else {
      if (options.contrast > 0) applyContrast(ctx, dims.width, dims.height, options.contrast)
      if (options.gamma !== 1.0 && options.is2bit) applyGamma(ctx, dims.width, dims.height, options.gamma)
      if (options.invert) applyInvert(ctx, width, height)
      toGrayscale(ctx, dims.width, dims.height)
    }
    applyDithering(ctx, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
    processedPages.push({ name: `${String(i + 1).padStart(5, '0')}.png`, canvas: finalCanvas })
    if (i % 5 === 0 || i === frames.length - 1) onProgress((i + 1) / frames.length, finalCanvas.toDataURL('image/png'))
  }

  const pageBlobs: Blob[] = []; const pageInfos: StreamPageInfo[] = []
  for (const p of processedPages) {
    const encoded = encodePage(p, options.is2bit, options.useWasm)
    pageBlobs.push(new Blob([encoded])); pageInfos.push({ width: p.canvas.width, height: p.canvas.height })
    if (pageImages.length < 10) pageImages.push(p.canvas.toDataURL('image/png'))
  }

  const outputFileName = file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xtch' : '.xtc')
  if (options.streamedDownload) {
    const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { is2bit: options.is2bit })
    const fileStream = streamSaver.createWriteStream(outputFileName); const writer = fileStream.getWriter()
    await writer.write(headerAndIndex)
    for (const blob of pageBlobs) await writer.write(new Uint8Array(await blob.arrayBuffer()))
    await writer.close()
    return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages }
  } else {
    const allBuffers: ArrayBuffer[] = []
    for (const blob of pageBlobs) allBuffers.push(await blob.arrayBuffer())
    const xtcData = await buildXtcFromBuffers(allBuffers, { is2bit: options.is2bit })
    return { name: outputFileName, data: xtcData, size: xtcData.byteLength, pageCount: processedPages.length, pageImages }
  }
}

async function extractFramesFromVideo(file: File, fps: number): Promise<HTMLCanvasElement[]> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video'); video.preload = 'auto'; video.muted = true; video.playsInline = true
    const url = URL.createObjectURL(file); video.src = url
    video.onloadedmetadata = async () => {
      const duration = video.duration; const frameCount = Math.max(1, Math.floor(duration * fps)); const frames: HTMLCanvasElement[] = []
      const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      for (let i = 0; i < frameCount; i++) {
        const time = i / fps; video.currentTime = time
        await new Promise((r) => { video.onseeked = () => {
          ctx.drawImage(video, 0, 0); const frameCopy = document.createElement('canvas'); frameCopy.width = canvas.width; frameCopy.height = canvas.height
          frameCopy.getContext('2d', { willReadFrequently: true })!.drawImage(canvas, 0, 0); frames.push(frameCopy); r(null)
        } })
      }
      URL.revokeObjectURL(url); resolve(frames)
    }
    video.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error('Failed to load video.')) }
  })
}

function processCanvasAsImage(
  sourceCanvas: HTMLCanvasElement,
  pageNum: number,
  options: ConversionOptions
): ProcessedPage[] {
  const dims = getTargetDimensions(options)
  const results: ProcessedPage[] = []
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const padColor = options.padBlack ? 0 : 255
  const crop = getAxisCropRect(sourceCanvas.width, sourceCanvas.height, options)
  canvas.width = crop.width; canvas.height = crop.height
  ctx.drawImage(sourceCanvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)
  
  // High quality resize if needed
  let resizedCanvas = resizeHq(canvas, dims.width, dims.height, options);
  
  let width = crop.width; let height = crop.height
  if (options.useWasm && isWasmLoaded()) {
    try {
      const imageData = ctx.getImageData(0, 0, width, height)
      runWasmFilters(imageData, options.contrast, (options.is2bit) ? options.gamma : 1.0, options.invert)
      ctx.putImageData(imageData, 0, 0)
    } catch (e) {
      if (options.contrast > 0) applyContrast(ctx, width, height, options.contrast)
      if (options.gamma !== 1.0 && options.is2bit) applyGamma(ctx, width, height, options.gamma)
      if (options.invert) applyInvert(ctx, width, height)
      toGrayscale(ctx, width, height)
    }
  } else {
    if (options.contrast > 0) applyContrast(ctx, width, height, options.contrast)
    if (options.gamma !== 1.0 && options.is2bit) applyGamma(ctx, width, height, options.gamma)
    if (options.invert) applyInvert(ctx, width, height)
    toGrayscale(ctx, width, height)
  }
  if (options.sidewaysOverviews && !options.manhwa) {
    const rotatedOverview = rotateCanvas(canvas, 90); const finalOverview = resizeWithPadding(rotatedOverview, padColor, dims.width, dims.height)
    applyDithering(finalOverview.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
    results.push({ name: `${String(pageNum).padStart(4, '0')}_0_overview_s.png`, canvas: finalOverview })
  }
  if (options.includeOverviews && !options.manhwa) {
    const finalOverview = resizeWithPadding(canvas, padColor, dims.width, dims.height)
    applyDithering(finalOverview.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
    results.push({ name: `${String(pageNum).padStart(4, '0')}_0_overview_u.png`, canvas: finalOverview })
  }
  const isSingleImage = options.sourceType === 'image' && !options.manhwa && options.splitMode === 'nosplit'
  if (isSingleImage) {
    let processingCanvas = canvas; const angle = getOrientationAngle(options.orientation)
    if (angle !== 0) processingCanvas = rotateCanvas(canvas, angle)
    let finalCanvas: HTMLCanvasElement
    switch (options.imageMode) {
      case 'fill': finalCanvas = resizeHq(processingCanvas, dims.width, dims.height, options); break
      case 'cover': finalCanvas = resizeCover(processingCanvas, dims.width, dims.height); break
      case 'crop': finalCanvas = resizeCrop(processingCanvas, dims.width, dims.height); break
      case 'letterbox': default: finalCanvas = resizeWithPadding(processingCanvas, padColor, dims.width, dims.height); break
    }
    applyDithering(finalCanvas.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
    results.push({ name: `${String(pageNum).padStart(4, '0')}_image.png`, canvas: finalCanvas }); return results
  }
  if (options.manhwa) {
    const scale = dims.width / width; const newHeight = Math.floor(height * scale)
    const resizedCanvas = resizeHq(canvas, dims.width, newHeight, options)
    applyDithering(resizedCanvas.getContext('2d', { willReadFrequently: true })!, dims.width, newHeight, options.dithering, options.is2bit, options.useWasm)
    const sliceHeight = dims.height; const overlapPercent = options.manhwaOverlap || 50; const overlapPixels = Math.floor(dims.height * (overlapPercent / 100)); const sliceStep = dims.height - overlapPixels
    for (let y = 0; y < newHeight; ) {
      let h = Math.min(sliceHeight, newHeight - y)
      if (h < sliceHeight && newHeight > sliceHeight) { y = newHeight - sliceHeight; h = sliceHeight }
      const sliceCanvas = extractRegion(resizedCanvas, 0, y, dims.width, h); const finalCanvas = resizeWithPadding(sliceCanvas, padColor, dims.width, dims.height)
      results.push({ name: `${String(pageNum).padStart(4, '0')}_m_${y}.png`, canvas: finalCanvas })
      if (y + h >= newHeight) break; y += sliceStep
    }
    return results
  }
  if (options.orientation === 'portrait') {
    const finalCanvas = resizeWithPadding(canvas, padColor, dims.width, dims.height)
    applyDithering(finalCanvas.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
    results.push({ name: `${String(pageNum).padStart(4, '0')}_0_page.png`, canvas: finalCanvas }); return results
  }
  const shouldSplit = width < height && options.splitMode !== 'nosplit'
  if (shouldSplit) {
    if (options.splitMode === 'overlap') {
      const segments = calculateOverlapSegments(width, height, dims.width, dims.height)
      segments.forEach((seg, idx) => {
        const letter = String.fromCharCode(97 + idx); const pageCanvas = extractAndRotate(canvas, seg.x, seg.y, seg.w, seg.h)
        const finalCanvas = resizeWithPadding(pageCanvas, padColor, dims.width, dims.height)
        applyDithering(finalCanvas.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
        results.push({ name: `${String(pageNum).padStart(4, '0')}_3_${letter}.png`, canvas: finalCanvas })
      })
    } else {
      const halfHeight = Math.floor(height / 2)
      const topCanvas = extractAndRotate(canvas, 0, 0, width, halfHeight); const topFinal = resizeWithPadding(topCanvas, padColor, dims.width, dims.height)
      applyDithering(topFinal.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
      results.push({ name: `${String(pageNum).padStart(4, '0')}_2_a.png`, canvas: topFinal })
      const bottomCanvas = extractAndRotate(canvas, 0, halfHeight, width, height - halfHeight); const bottomFinal = resizeWithPadding(bottomCanvas, padColor, dims.width, dims.height)
      applyDithering(bottomFinal.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
      results.push({ name: `${String(pageNum).padStart(4, '0')}_2_b.png`, canvas: bottomFinal })
    }
  } else {
    const rotatedCanvas = rotateCanvas(canvas, 90); const finalCanvas = resizeWithPadding(rotatedCanvas, padColor, dims.width, dims.height)
    applyDithering(finalCanvas.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
    results.push({ name: `${String(pageNum).padStart(4, '0')}_0_spread.png`, canvas: finalCanvas })
  }
  return results
}

async function processImage(imgBlob: Blob, pageNum: number, options: ConversionOptions): Promise<ProcessedPage[]> {
  return new Promise((resolve) => {
    const img = new Image(); const objectUrl = URL.createObjectURL(imgBlob)
    img.onload = () => { URL.revokeObjectURL(objectUrl); resolve(processLoadedImage(img, pageNum, options)) }
    img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve([]) }
    img.src = objectUrl
  })
}

function processLoadedImage(img: HTMLImageElement, pageNum: number, options: ConversionOptions): ProcessedPage[] {
  const dims = getTargetDimensions(options); const results: ProcessedPage[] = []; const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true })!; const padColor = options.padBlack ? 0 : 255
  const crop = getAxisCropRect(img.width, img.height, options); canvas.width = crop.width; canvas.height = crop.height
  ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)
  let width = crop.width; let height = crop.height
  if (options.useWasm && isWasmLoaded()) {
    try {
      const imageData = ctx.getImageData(0, 0, width, height)
      runWasmFilters(imageData, options.contrast, (options.is2bit) ? options.gamma : 1.0, options.invert)
      ctx.putImageData(imageData, 0, 0)
    } catch (e) {
      if (options.contrast > 0) applyContrast(ctx, width, height, options.contrast)
      if (options.gamma !== 1.0 && options.is2bit) applyGamma(ctx, width, height, options.gamma)
      if (options.invert) applyInvert(ctx, width, height)
      toGrayscale(ctx, width, height)
    }
  } else {
    if (options.contrast > 0) applyContrast(ctx, width, height, options.contrast)
    if (options.gamma !== 1.0 && options.is2bit) applyGamma(ctx, width, height, options.gamma)
    if (options.invert) applyInvert(ctx, width, height)
    toGrayscale(ctx, width, height)
  }
  if (options.sidewaysOverviews && !options.manhwa) {
    const rotatedOverview = rotateCanvas(canvas, 90); const finalOverview = resizeWithPadding(rotatedOverview, padColor, dims.width, dims.height)
    applyDithering(finalOverview.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
    results.push({ name: `${String(pageNum).padStart(4, '0')}_0_overview_s.png`, canvas: finalOverview })
  }
  if (options.includeOverviews && !options.manhwa) {
    const finalOverview = resizeWithPadding(canvas, padColor, dims.width, dims.height)
    applyDithering(finalOverview.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
    results.push({ name: `${String(pageNum).padStart(4, '0')}_0_overview_u.png`, canvas: finalOverview })
  }
  const isSingleImage = options.sourceType === 'image' && !options.manhwa && options.splitMode === 'nosplit'
  if (isSingleImage) {
    let processingCanvas = canvas; const angle = getOrientationAngle(options.orientation)
    if (angle !== 0) processingCanvas = rotateCanvas(canvas, angle)
    let finalCanvas: HTMLCanvasElement
    switch (options.imageMode) {
      case 'fill': finalCanvas = resizeHq(processingCanvas, dims.width, dims.height, options); break
      case 'cover': finalCanvas = resizeCover(processingCanvas, dims.width, dims.height); break
      case 'crop': finalCanvas = resizeCrop(processingCanvas, dims.width, dims.height); break
      case 'letterbox': default: finalCanvas = resizeWithPadding(processingCanvas, padColor, dims.width, dims.height); break
    }
    applyDithering(finalCanvas.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
    results.push({ name: `${String(pageNum).padStart(4, '0')}_image.png`, canvas: finalCanvas }); return results
  }
  if (options.manhwa) {
    const scale = dims.width / width; const newHeight = Math.floor(height * scale)
    const resizedCanvas = resizeHq(canvas, dims.width, newHeight, options)
    applyDithering(resizedCanvas.getContext('2d', { willReadFrequently: true })!, dims.width, newHeight, options.dithering, options.is2bit, options.useWasm)
    const sliceHeight = dims.height; const overlapPercent = options.manhwaOverlap || 50; const overlapPixels = Math.floor(dims.height * (overlapPercent / 100)); const sliceStep = dims.height - overlapPixels
    for (let y = 0; y < newHeight; ) {
      let h = Math.min(sliceHeight, newHeight - y)
      if (h < sliceHeight && newHeight > sliceHeight) { y = newHeight - sliceHeight; h = sliceHeight }
      const sliceCanvas = extractRegion(resizedCanvas, 0, y, dims.width, h); const finalCanvas = resizeWithPadding(sliceCanvas, padColor, dims.width, dims.height)
      results.push({ name: `${String(pageNum).padStart(4, '0')}_m_${y}.png`, canvas: finalCanvas })
      if (y + h >= newHeight) break; y += sliceStep
    }
    return results
  }
  if (options.orientation === 'portrait') {
    const finalCanvas = resizeWithPadding(canvas, padColor, dims.width, dims.height)
    applyDithering(finalCanvas.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
    results.push({ name: `${String(pageNum).padStart(4, '0')}_0_page.png`, canvas: finalCanvas }); return results
  }
  const shouldSplit = width < height && options.splitMode !== 'nosplit'
  if (shouldSplit) {
    if (options.splitMode === 'overlap') {
      const segments = calculateOverlapSegments(width, height, dims.width, dims.height)
      segments.forEach((seg, idx) => {
        const letter = String.fromCharCode(97 + idx); const pageCanvas = extractAndRotate(canvas, seg.x, seg.y, seg.w, seg.h)
        const finalCanvas = resizeWithPadding(pageCanvas, padColor, dims.width, dims.height)
        applyDithering(finalCanvas.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
        results.push({ name: `${String(pageNum).padStart(4, '0')}_3_${letter}.png`, canvas: finalCanvas })
      })
    } else {
      const halfHeight = Math.floor(height / 2)
      const topCanvas = extractAndRotate(canvas, 0, 0, width, halfHeight); const topFinal = resizeWithPadding(topCanvas, padColor, dims.width, dims.height)
      applyDithering(topFinal.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
      results.push({ name: `${String(pageNum).padStart(4, '0')}_2_a.png`, canvas: topFinal })
      const bottomCanvas = extractAndRotate(canvas, 0, halfHeight, width, height - halfHeight); const bottomFinal = resizeWithPadding(bottomCanvas, padColor, dims.width, dims.height)
      applyDithering(bottomFinal.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
      results.push({ name: `${String(pageNum).padStart(4, '0')}_2_b.png`, canvas: bottomFinal })
    }
  } else {
    const rotatedCanvas = rotateCanvas(canvas, 90); const finalCanvas = resizeWithPadding(rotatedCanvas, padColor, dims.width, dims.height)
    applyDithering(finalCanvas.getContext('2d', { willReadFrequently: true })!, dims.width, dims.height, options.dithering, options.is2bit, options.useWasm)
    results.push({ name: `${String(pageNum).padStart(4, '0')}_0_spread.png`, canvas: finalCanvas })
  }
  return results
}

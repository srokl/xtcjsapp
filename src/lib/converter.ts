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
 * Get dimensions of an image blob
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
 * Resize a canvas with high-quality Box Filter
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
 * Process a canvas (filter, dither) and encode it to binary
 */
async function processAndEncode(canvas: HTMLCanvasElement, options: ConversionOptions): Promise<ArrayBuffer> {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const width = canvas.width
  const height = canvas.height

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

  applyDithering(ctx, width, height, options.dithering, options.is2bit, options.useWasm)
  
  const imageData = ctx.getImageData(0, 0, width, height)
  if (options.useWasm && isWasmLoaded()) {
    const packed = runWasmPack(imageData, options.is2bit)
    return wrapWasmData(packed, width, height, options.is2bit)
  }
  
  return options.is2bit ? imageDataToXth(imageData) : imageDataToXtg(imageData)
}

/**
 * Legacy encodePage for compatibility
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
    const shouldSplit = width < height && options.splitMode !== 'nosplit'
    count += shouldSplit ? (options.splitMode === 'overlap' ? 3 : 2) : 1
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

    imageFiles.sort((a, b) => a.path.localeCompare(b.path))
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
    const outputFileName = file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xtch' : '.xtc')
    const pageImages: string[] = []

    if (options.streamedDownload && !options.manhwa) {
      const pageInfos: StreamPageInfo[] = []
      // Pass 1: Info
      for (let i = 0; i < imageFiles.length; i++) {
        onProgress(i / imageFiles.length * 0.05, null)
        const imgBlob = await imageFiles[i].entry.getData(new BlobWriter())
        const imgDims = await getImageDimensions(imgBlob)
        const crop = getAxisCropRect(imgDims.width, imgDims.height, options)
        const count = calculateOutputPageCount(crop.width, crop.height, options)
        for (let j = 0; j < count; j++) pageInfos.push({ width: dims.width, height: dims.height })
        mappingCtx.addOriginalPage(i + 1, count)
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

      // Pass 2: Data
      for (let i = 0; i < imageFiles.length; i++) {
        const imgBlob = await imageFiles[i].entry.getData(new BlobWriter())
        const result = await processImageAsBinary(imgBlob, i + 1, options)
        for (const encoded of result.buffers) await writer.write(new Uint8Array(encoded))
        if (pageImages.length < 10 && result.previews[0]) pageImages.push(result.previews[0])
        if (result.previews.length > 0) onProgress(0.05 + (i + 1) / imageFiles.length * 0.95, result.previews[0])
      }
      await writer.close()
      await zipReader.close()
      return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
    } else {
      // Standard path
      const pageBlobs: Blob[] = []; const pageInfos: StreamPageInfo[] = []
      let stitcher: ManhwaStitcher | null = options.manhwa ? new ManhwaStitcher(options) : null

      for (let i = 0; i < imageFiles.length; i++) {
        const imgBlob = await imageFiles[i].entry.getData(new BlobWriter())
        let currentEncoded: ArrayBuffer[] = []; let currentPreviews: string[] = []
        if (stitcher) {
          const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image(); const url = URL.createObjectURL(imgBlob)
            img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Img load fail')) }
            img.src = url
          })
          const slices = await stitcher.append(img)
          for (const slice of slices) {
            currentEncoded.push(await processAndEncode(slice.canvas, options))
            currentPreviews.push(slice.canvas.toDataURL('image/png'))
          }
        } else {
          const result = await processImageAsBinary(imgBlob, i + 1, options)
          currentEncoded = result.buffers; currentPreviews = result.previews
        }
        for (let j = 0; j < currentEncoded.length; j++) {
          pageBlobs.push(new Blob([currentEncoded[j]])); pageInfos.push({ width: dims.width, height: dims.height })
          if (pageImages.length < 10 && currentPreviews[j]) pageImages.push(currentPreviews[j])
        }
        mappingCtx.addOriginalPage(i + 1, currentEncoded.length)
        if (currentPreviews.length > 0) onProgress((i + 1) / imageFiles.length, currentPreviews[0])
      }
      if (stitcher) {
        for (const p of stitcher.finish()) {
          const encoded = await processAndEncode(p.canvas, options)
          pageBlobs.push(new Blob([encoded])); pageInfos.push({ width: p.canvas.width, height: p.canvas.height })
          if (pageImages.length < 10) pageImages.push(p.canvas.toDataURL('image/png'))
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
        for (const blob of pageBlobs) await writer.write(new Uint8Array(await blob.arrayBuffer()))
        await writer.close()
        return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
      } else {
        const allBuffers: ArrayBuffer[] = []
        for (const blob of pageBlobs) allBuffers.push(await blob.arrayBuffer())
        const xtcData = await buildXtcFromBuffers(allBuffers, { metadata, is2bit: options.is2bit })
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

  imageFiles.sort((a, b) => a.path.localeCompare(b.path))
  if (imageFiles.length === 0) throw new Error('No images found in CBR')

  const pageTitles = new Map<number, string>()
  let metadata: BookMetadata = { toc: [] }
  if (comicInfoContent) {
    try { const cmMeta = parseComicInfo(comicInfoContent); if (cmMeta.title) metadata.title = cmMeta.title; if (cmMeta.author) metadata.author = cmMeta.author } catch { }
  }
  metadata.toc = imageFiles.map((_, index) => ({ title: `Page ${index + 1 + tocPageOffset}`, startPage: index + 1, endPage: index + 1 }))

  const mappingCtx = new PageMappingContext(); const dims = getTargetDimensions(options); const outputFileName = file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xtch' : '.xtc'); const pageImages: string[] = []

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

    for (let i = 0; i < imageFiles.length; i++) {
      const imgBlob = new Blob([new Uint8Array(imageFiles[i].data)])
      const result = await processImageAsBinary(imgBlob, i + 1, options)
      for (const encoded of result.buffers) await writer.write(new Uint8Array(encoded))
      if (pageImages.length < 10 && result.previews[0]) pageImages.push(result.previews[0])
      if (result.previews.length > 0) onProgress(0.05 + (i + 1) / imageFiles.length * 0.95, result.previews[0])
    }
    await writer.close()
    return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
  } else {
    const pageBlobs: Blob[] = []; const pageInfos: StreamPageInfo[] = []
    let stitcher = options.manhwa ? new ManhwaStitcher(options) : null

    for (let i = 0; i < imageFiles.length; i++) {
      const imgBlob = new Blob([new Uint8Array(imageFiles[i].data)])
      let currentEncoded: ArrayBuffer[] = []; let currentPreviews: string[] = []
      if (stitcher) {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image(); const url = URL.createObjectURL(imgBlob)
          img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Img fail')) }
          img.src = url
        })
        const slices = await stitcher.append(img)
        for (const slice of slices) {
          currentEncoded.push(await processAndEncode(slice.canvas, options))
          currentPreviews.push(slice.canvas.toDataURL('image/png'))
        }
      } else {
        const result = await processImageAsBinary(imgBlob, i + 1, options)
        currentEncoded = result.buffers; currentPreviews = result.previews
      }
      for (let j = 0; j < currentEncoded.length; j++) {
        pageBlobs.push(new Blob([currentEncoded[j]])); pageInfos.push({ width: dims.width, height: dims.height })
        if (pageImages.length < 10 && currentPreviews[j]) pageImages.push(currentPreviews[j])
      }
      mappingCtx.addOriginalPage(i + 1, currentEncoded.length)
      if (currentPreviews.length > 0) onProgress((i + 1) / imageFiles.length, currentPreviews[0])
    }
    if (stitcher) {
      for (const p of stitcher.finish()) {
        const encoded = await processAndEncode(p.canvas, options)
        pageBlobs.push(new Blob([encoded])); pageInfos.push({ width: p.canvas.width, height: p.canvas.height })
        if (pageImages.length < 10) pageImages.push(p.canvas.toDataURL('image/png'))
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
      for (const blob of pageBlobs) await writer.write(new Uint8Array(await blob.arrayBuffer()))
      await writer.close()
      return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
    } else {
      const allBuffers: ArrayBuffer[] = []
      for (const blob of pageBlobs) allBuffers.push(await blob.arrayBuffer())
      const xtcData = await buildXtcFromBuffers(allBuffers, { metadata, is2bit: options.is2bit })
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

  const mappingCtx = new PageMappingContext(); const dims = getTargetDimensions(options); const outputFileName = file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xtch' : '.xtc'); const pageImages: string[] = []

  if (options.streamedDownload && !options.manhwa) {
    const pageInfos: StreamPageInfo[] = []
    for (let i = 1; i <= numPages; i++) {
      onProgress(i / numPages * 0.05, null)
      const page = await pdf.getPage(i); const viewport = page.getViewport({ scale: 1 })
      const count = calculateOutputPageCount(viewport.width, viewport.height, options)
      for (let j = 0; j < count; j++) pageInfos.push({ width: dims.width, height: dims.height })
      mappingCtx.addOriginalPage(i, count)
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
    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i); const scale = 2.0; const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height
      await page.render({ canvas, viewport, background: 'rgb(255,255,255)' }).promise
      const xtcPages = await processCanvasAsImage(canvas, i, options)
      for (const buf of xtcPages) {
        await writer.write(new Uint8Array(buf)); if (pageImages.length < 10) pageImages.push(canvas.toDataURL('image/png'))
      }
      onProgress(0.05 + i / numPages * 0.95, canvas.toDataURL('image/png'))
    }
    await writer.close(); URL.revokeObjectURL(url)
    return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
  } else {
    const pageBlobs: Blob[] = []; const pageInfos: StreamPageInfo[] = []
    let stitcher = options.manhwa ? new ManhwaStitcher(options) : null
    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i); const scale = 2.0; const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height
      await page.render({ canvas, viewport, background: 'rgb(255,255,255)' }).promise
      let currentEncoded: ArrayBuffer[] = []
      if (stitcher) {
        const slices = await stitcher.append(canvas)
        for (const slice of slices) {
          const buf = await processAndEncode(slice.canvas, options)
          currentEncoded.push(buf); if (pageImages.length < 10) pageImages.push(slice.canvas.toDataURL('image/png'))
        }
      } else {
        const bufs = await processCanvasAsImage(canvas, i, options)
        currentEncoded = bufs; if (pageImages.length < 10) pageImages.push(canvas.toDataURL('image/png'))
      }
      for (const buf of currentEncoded) {
        pageBlobs.push(new Blob([buf])); pageInfos.push({ width: dims.width, height: dims.height })
      }
      mappingCtx.addOriginalPage(i, currentEncoded.length)
      onProgress(i / numPages, canvas.toDataURL('image/png'))
    }
    if (stitcher) {
      for (const p of stitcher.finish()) {
        const encoded = await processAndEncode(p.canvas, options)
        pageBlobs.push(new Blob([encoded])); pageInfos.push({ width: p.canvas.width, height: p.canvas.height })
        if (pageImages.length < 10) pageImages.push(p.canvas.toDataURL('image/png'))
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
      await writer.write(headerAndIndex); for (const blob of pageBlobs) await writer.write(new Uint8Array(await blob.arrayBuffer()))
      await writer.close(); URL.revokeObjectURL(url)
      return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
    } else {
      const allBuffers: ArrayBuffer[] = []
      for (const blob of pageBlobs) allBuffers.push(await blob.arrayBuffer())
      const xtcData = await buildXtcFromBuffers(allBuffers, { metadata, is2bit: options.is2bit })
      URL.revokeObjectURL(url)
      return { name: outputFileName, data: xtcData, size: xtcData.byteLength, pageCount: pageInfos.length, pageImages }
    }
  }
}

async function convertImageToXtc(file: File, options: ConversionOptions, onProgress: (p: number, pr: string | null) => void): Promise<ConversionResult> {
  const result = await processImageAsBinary(file, 1, options)
  if (result.buffers.length === 0) throw new Error('Failed')
  return { name: file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xth' : '.xtg'), data: result.buffers[0], size: result.buffers[0].byteLength, pageCount: 1, pageImages: result.previews }
}

async function convertVideoToXtc(file: File, options: ConversionOptions, onProgress: (p: number, pr: string | null) => void): Promise<ConversionResult> {
  const frames = await extractFramesFromVideo(file, options.videoFps || 1.0)
  const pageBuffers: ArrayBuffer[] = []; const pageInfos: StreamPageInfo[] = []; const pageImages: string[] = []
  const dims = getTargetDimensions(options)
  for (let i = 0; i < frames.length; i++) {
    let canvas = frames[i]; const angle = getOrientationAngle(options.orientation)
    if (angle !== 0 && (angle === 180 || canvas.width >= canvas.height)) canvas = rotateCanvas(canvas, angle)
    const finalCanvas = resizeWithPadding(canvas, 0, dims.width, dims.height)
    const buf = await processAndEncode(finalCanvas, options)
    pageBuffers.push(buf); pageInfos.push({ width: dims.width, height: dims.height })
    if (pageImages.length < 10) pageImages.push(finalCanvas.toDataURL('image/png'))
    if (i % 5 === 0) onProgress((i + 1) / frames.length, finalCanvas.toDataURL('image/png'))
  }
  const outputFileName = file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xtch' : '.xtc')
  if (options.streamedDownload) {
    const headerAndIndex = buildXtcHeaderAndIndex(pageInfos, { is2bit: options.is2bit })
    let totalSize = headerAndIndex.byteLength
    for (const info of pageInfos) totalSize += getXtcPageSize(info.width, info.height, options.is2bit)
    const fileStream = streamSaver.createWriteStream(outputFileName, { size: totalSize }); const writer = fileStream.getWriter()
    await writer.write(headerAndIndex); for (const buf of pageBuffers) await writer.write(new Uint8Array(buf))
    await writer.close(); return { name: outputFileName, pageCount: pageInfos.length, isStreamed: true, pageImages, size: totalSize }
  } else {
    const xtcData = await buildXtcFromBuffers(pageBuffers, { is2bit: options.is2bit })
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

async function processCanvasAsImage(sourceCanvas: HTMLCanvasElement, pageNum: number, options: ConversionOptions): Promise<ArrayBuffer[]> {
  const dims = getTargetDimensions(options); const results: ArrayBuffer[] = []; const padColor = options.padBlack ? 0 : 255
  const crop = getAxisCropRect(sourceCanvas.width, sourceCanvas.height, options)
  const croppedCanvas = document.createElement('canvas'); croppedCanvas.width = crop.width; croppedCanvas.height = crop.height
  croppedCanvas.getContext('2d')!.drawImage(sourceCanvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)

  if (options.sidewaysOverviews) results.push(await processAndEncode(resizeWithPadding(rotateCanvas(croppedCanvas, 90), padColor, dims.width, dims.height), options))
  if (options.includeOverviews) results.push(await processAndEncode(resizeWithPadding(croppedCanvas, padColor, dims.width, dims.height), options))
  
  const isSingleImage = options.sourceType === 'image' && !options.manhwa && options.splitMode === 'nosplit'
  if (isSingleImage) {
    let proc = croppedCanvas; const angle = getOrientationAngle(options.orientation); if (angle !== 0) proc = rotateCanvas(croppedCanvas, angle)
    let final: HTMLCanvasElement
    if (options.imageMode === 'fill') final = resizeHq(proc, dims.width, dims.height, options)
    else if (options.imageMode === 'cover') final = resizeCover(proc, dims.width, dims.height)
    else if (options.imageMode === 'crop') final = resizeCrop(proc, dims.width, dims.height)
    else final = resizeWithPadding(proc, padColor, dims.width, dims.height)
    results.push(await processAndEncode(final, options)); return results
  }

  if (options.manhwa) {
    const scale = dims.width / crop.width; const newHeight = Math.floor(crop.height * scale)
    const resized = resizeHq(croppedCanvas, dims.width, newHeight, options)
    const sliceStep = dims.height - Math.floor(dims.height * (options.manhwaOverlap / 100))
    for (let y = 0; y < newHeight; ) {
      let h = Math.min(dims.height, newHeight - y); if (h < dims.height && newHeight > dims.height) { y = newHeight - dims.height; h = dims.height }
      results.push(await processAndEncode(resizeWithPadding(extractRegion(resized, 0, y, dims.width, h), padColor, dims.width, dims.height), options))
      if (y + h >= newHeight) break; y += sliceStep
    }
    return results
  }

  if (options.orientation === 'portrait') { results.push(await processAndEncode(resizeWithPadding(croppedCanvas, padColor, dims.width, dims.height), options)); return results }
  
  if (crop.width < crop.height && options.splitMode !== 'nosplit') {
    if (options.splitMode === 'overlap') {
      for (const seg of calculateOverlapSegments(crop.width, crop.height, dims.width, dims.height)) results.push(await processAndEncode(resizeWithPadding(extractAndRotate(croppedCanvas, seg.x, seg.y, seg.w, seg.h), padColor, dims.width, dims.height), options))
    } else {
      const half = Math.floor(crop.height / 2)
      results.push(await processAndEncode(resizeWithPadding(extractAndRotate(croppedCanvas, 0, 0, crop.width, half), padColor, dims.width, dims.height), options))
      results.push(await processAndEncode(resizeWithPadding(extractAndRotate(croppedCanvas, 0, half, crop.width, crop.height - half), padColor, dims.width, dims.height), options))
    }
  } else {
    results.push(await processAndEncode(resizeWithPadding(rotateCanvas(croppedCanvas, 90), padColor, dims.width, dims.height), options))
  }
  return results
}

async function processImageAsBinary(imgBlob: Blob, pageNum: number, options: ConversionOptions): Promise<{ buffers: ArrayBuffer[], previews: string[] }> {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(imgBlob)
    img.onload = async () => {
      try {
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height
        canvas.getContext('2d')!.drawImage(img, 0, 0)
        URL.revokeObjectURL(url)
        const buffers = await processCanvasAsImage(canvas, pageNum, options)
        resolve({ buffers, previews: [canvas.toDataURL('image/png')] })
      } catch (e) { reject(e) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ buffers: [], previews: [] }) }
    img.src = url
  })
}

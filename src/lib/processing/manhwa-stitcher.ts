import { applyDithering } from './dithering'
import { toGrayscale, applyContrast, isSolidColor, applyGamma, applyInvert } from './image'
import { extractRegion, TARGET_WIDTH, TARGET_HEIGHT, DEVICE_DIMENSIONS } from './canvas'
import type { ConversionOptions, ProcessedPage } from '../types'

export class ManhwaStitcher {
  private buffer: HTMLCanvasElement | null = null
  private pageCount = 0
  private targetWidth: number
  private targetHeight: number

  constructor(private options: ConversionOptions) {
    const dims = DEVICE_DIMENSIONS[options.device] || DEVICE_DIMENSIONS.X4
    this.targetWidth = dims.width
    this.targetHeight = dims.height
  }

  async append(source: HTMLImageElement | HTMLCanvasElement): Promise<ProcessedPage[]> {
    const pages: ProcessedPage[] = []
    
    // 1. Resize source to targetWidth
    const scale = this.targetWidth / source.width
    const newHeight = Math.floor(source.height * scale)
    const tempCanvas = document.createElement('canvas')
    tempCanvas.width = this.targetWidth
    tempCanvas.height = newHeight
    const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true })!
    
    // Draw and apply pre-processing
    tempCtx.drawImage(source, 0, 0, source.width, source.height, 0, 0, this.targetWidth, newHeight)
    
    if (this.options.contrast > 0) {
       applyContrast(tempCtx, this.targetWidth, newHeight, this.options.contrast)
    }
    if (this.options.gamma !== 1.0 && this.options.is2bit) {
       applyGamma(tempCtx, this.targetWidth, newHeight, this.options.gamma)
    }
    if (this.options.invert) {
       applyInvert(tempCtx, this.targetWidth, newHeight)
    }
    toGrayscale(tempCtx, this.targetWidth, newHeight)

    // 2. Stitch into buffer
    if (!this.buffer) {
      this.buffer = tempCanvas
    } else {
      const combinedHeight = this.buffer.height + newHeight
      const combinedCanvas = document.createElement('canvas')
      combinedCanvas.width = this.targetWidth
      combinedCanvas.height = combinedHeight
      const combinedCtx = combinedCanvas.getContext('2d', { willReadFrequently: true })!
      
      combinedCtx.drawImage(this.buffer, 0, 0)
      combinedCtx.drawImage(tempCanvas, 0, this.buffer.height)
      
      this.buffer = combinedCanvas
    }

    // 3. Slice ready pages
    while (this.buffer && this.buffer.height >= this.targetHeight) {
       // Extract top page
       const slice = extractRegion(this.buffer, 0, 0, this.targetWidth, this.targetHeight)
       const sliceCtx = slice.getContext('2d', { willReadFrequently: true })!
       
       // Check if solid color (blank/filler)
       const isSolid = isSolidColor(sliceCtx, 0, 0, this.targetWidth, this.targetHeight)
       
       // Calculate step:
       // Solid -> Skip full page (e.g. 800px)
       // Detailed -> User-selected overlap
       const overlapPercent = this.options.manhwaOverlap || 50
       const overlapPixels = Math.floor(this.targetHeight * (overlapPercent / 100))
       const step = isSolid ? this.targetHeight : (this.targetHeight - overlapPixels)
       
       // Dither
       applyDithering(sliceCtx, this.targetWidth, this.targetHeight, this.options.dithering, this.options.is2bit, this.options.useWasm)
       
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
       newBuffer.width = this.targetWidth
       newBuffer.height = remainingHeight
       newBuffer.getContext('2d', { willReadFrequently: true })!.drawImage(this.buffer, 0, step, this.targetWidth, remainingHeight, 0, 0, this.targetWidth, remainingHeight)
       
       this.buffer = newBuffer
    }
    
    return pages
  }
  
  finish(): ProcessedPage[] {
    const pages: ProcessedPage[] = []
    if (this.buffer && this.buffer.height > 0) {
        // Last chunk
        // Align to top (content at top, padding at bottom)
        const final = document.createElement('canvas')
        final.width = this.targetWidth
        final.height = this.targetHeight
        const ctx = final.getContext('2d', { willReadFrequently: true })!
        
        // Fill with padding color
        const padColor = this.options.padBlack ? 'black' : 'white'
        ctx.fillStyle = padColor
        ctx.fillRect(0, 0, this.targetWidth, this.targetHeight)
        
        // Draw content at top
        ctx.drawImage(this.buffer, 0, 0)
        
        applyDithering(ctx, this.targetWidth, this.targetHeight, this.options.dithering, this.options.is2bit, this.options.useWasm)
        
        this.pageCount++
        pages.push({
             name: `${String(this.pageCount).padStart(5, '0')}.png`,
             canvas: final
        })
    }
    return pages
  }
}

import { applyDithering } from './dithering'
import { toGrayscale, applyContrast, isSolidColor, applyGamma } from './image'
import { extractRegion, TARGET_WIDTH, TARGET_HEIGHT } from './canvas'
import type { ConversionOptions, ProcessedPage } from '../types'

export class ManhwaStitcher {
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
    if (this.options.gamma !== 1.0 && this.options.is2bit) {
       applyGamma(tempCtx, TARGET_WIDTH, newHeight, this.options.gamma)
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
        // Align to top (content at top, padding at bottom)
        const final = document.createElement('canvas')
        final.width = TARGET_WIDTH
        final.height = TARGET_HEIGHT
        const ctx = final.getContext('2d')!
        
        // Fill with padding color
        const padColor = this.options.padBlack ? 'black' : 'white'
        ctx.fillStyle = padColor
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

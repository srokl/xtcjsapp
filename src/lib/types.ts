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
  sidewaysOverviews: boolean
  includeOverviews: boolean
  padBlack: boolean
  gamma: number
  imageMode: 'cover' | 'letterbox' | 'fill' | 'crop'
  invert: boolean
  videoFps: number
  device: 'X4' | 'X3'
  sourceType: 'cbz' | 'pdf' | 'image' | 'video'
}

export interface ConversionResult {
  name: string
  data?: ArrayBuffer
  size?: number
  pageCount?: number
  pageImages?: string[]
  error?: string
}

export interface ProcessedPage {
  name: string
  canvas: HTMLCanvasElement
}

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

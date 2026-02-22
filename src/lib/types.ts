export interface ConversionOptions {
  splitMode: string
  dithering: string
  contrast: number
  horizontalMargin: number
  verticalMargin: number
  orientation: 'landscape' | 'portrait' | 'landscape-flipped' | 'portrait-flipped'
  is2bit: boolean
  manhwa: boolean
  manhwaOverlap: number
  sidewaysOverviews: boolean
  includeOverviews: boolean
  landscapeRtl: boolean
  padBlack: boolean
  gamma: number
  imageMode: 'cover' | 'letterbox' | 'fill' | 'crop'
  invert: boolean
  videoFps: number
  hSplitCount: number
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

// Metadata types for XTC format

export interface TocEntry {
  title: string
  startPage: number  // 1-indexed original page
  endPage: number    // 1-indexed original page
}

export interface BookMetadata {
  title?: string
  author?: string
  publisher?: string
  language?: string
  createTime?: number
  coverPage?: number // 0-based index, 0xFFFF for none
  toc: TocEntry[]
}

export interface XtcMetadataOptions {
  metadata?: BookMetadata
}

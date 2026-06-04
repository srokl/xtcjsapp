import { useState, useEffect, useCallback, useRef } from 'react'
import { ZipReader, BlobReader, Uint8ArrayWriter } from '@zip.js/zip.js'
import { processImageAsBinary, type ConversionOptions } from '../lib/converter'
import { initWasm } from '../lib/processing/wasm'

interface LivePreviewProps {
  file: File | null
  fileType: 'cbz' | 'pdf' | 'image' | 'video'
  options: ConversionOptions
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']

/**
 * Extract the list of image filenames from a CBZ file (sorted naturally)
 */
async function getCbzPageList(file: File): Promise<string[]> {
  const zipReader = new ZipReader(new BlobReader(file))
  try {
    const entries = await zipReader.getEntries()
    const imageFiles: string[] = []
    for (const entry of entries) {
      if (entry.directory) continue
      const path = entry.filename
      if (path.toLowerCase().startsWith('__macos')) continue
      const ext = path.toLowerCase().substring(path.lastIndexOf('.'))
      if (IMAGE_EXTENSIONS.includes(ext)) imageFiles.push(path)
    }
    imageFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    await zipReader.close()
    return imageFiles
  } catch {
    await zipReader.close()
    return []
  }
}

/**
 * Extract a single page from a CBZ as Uint8Array
 */
async function extractCbzPage(file: File, pageIndex: number): Promise<Uint8Array | null> {
  const zipReader = new ZipReader(new BlobReader(file))
  try {
    const entries = await zipReader.getEntries()
    const imageFiles: Array<{ path: string; entry: any }> = []
    for (const entry of entries) {
      if (entry.directory) continue
      const path = entry.filename
      if (path.toLowerCase().startsWith('__macos')) continue
      const ext = path.toLowerCase().substring(path.lastIndexOf('.'))
      if (IMAGE_EXTENSIONS.includes(ext)) imageFiles.push({ path, entry })
    }
    imageFiles.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }))
    
    if (pageIndex < 0 || pageIndex >= imageFiles.length) {
      await zipReader.close()
      return null
    }
    
    const data = await imageFiles[pageIndex].entry.getData(new Uint8ArrayWriter())
    await zipReader.close()
    return data
  } catch {
    await zipReader.close()
    return null
  }
}

export function LivePreview({ file, fileType, options }: LivePreviewProps) {
  const [pageCount, setPageCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [convertedUrls, setConvertedUrls] = useState<string[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const prevUrlRef = useRef<string | null>(null)
  const abortRef = useRef(0)

  // Get page count when file changes
  useEffect(() => {
    if (!file) {
      setPageCount(0)
      setCurrentPage(1)
      setOriginalUrl(null)
      setConvertedUrls([])
      setIsExpanded(false)
      return
    }

    if (fileType === 'cbz') {
      getCbzPageList(file).then(pages => {
        setPageCount(pages.length)
        setCurrentPage(1)
      })
    } else if (fileType === 'image') {
      setPageCount(1)
      setCurrentPage(1)
    }
  }, [file, fileType])

  // Extract and show the original page
  useEffect(() => {
    if (!file || !isExpanded || pageCount === 0) return

    const token = ++abortRef.current

    if (prevUrlRef.current) {
      URL.revokeObjectURL(prevUrlRef.current)
      prevUrlRef.current = null
    }
    setOriginalUrl(null)
    setConvertedUrls([])

    const extract = async () => {
      let blob: Blob | null = null

      if (fileType === 'cbz') {
        const data = await extractCbzPage(file, currentPage - 1)
        if (!data || token !== abortRef.current) return
        blob = new Blob([data as any])
      } else if (fileType === 'image') {
        blob = file
      }

      if (!blob || token !== abortRef.current) return
      const url = URL.createObjectURL(blob)
      prevUrlRef.current = url
      setOriginalUrl(url)
    }

    extract()
  }, [file, fileType, currentPage, pageCount, isExpanded])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current)
    }
  }, [])

  const handleConvertPreview = useCallback(async () => {
    if (!file || isProcessing) return

    const token = ++abortRef.current
    setIsProcessing(true)
    setConvertedUrls([])

    try {
      if (options.useWasm) {
        try { await initWasm() } catch {}
      }

      let imgData: Uint8Array | null = null

      if (fileType === 'cbz') {
        imgData = await extractCbzPage(file, currentPage - 1)
      } else if (fileType === 'image') {
        imgData = new Uint8Array(await file.arrayBuffer())
      }

      if (!imgData || token !== abortRef.current) {
        setIsProcessing(false)
        return
      }

      const result = await processImageAsBinary(imgData, currentPage, options, true)

      if (token !== abortRef.current) {
        setIsProcessing(false)
        return
      }

      // Collect ALL output page previews
      const urls = result.results
        .filter(r => r.preview)
        .map(r => r.preview)

      setConvertedUrls(urls)
    } catch (err) {
      console.error('Live preview failed:', err)
    }

    setIsProcessing(false)
  }, [file, fileType, currentPage, options, isProcessing])

  if (!file || pageCount === 0) return null
  if (fileType !== 'cbz' && fileType !== 'image') return null

  return (
    <section className="live-preview-section">
      <div className="section-header">
        <h2>Live Preview</h2>
        <button
          className="btn-toggle-preview"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          {isExpanded ? 'Hide' : 'Show'}
        </button>
      </div>

      {isExpanded && (
        <>
          {pageCount > 1 && (
            <div className="preview-page-nav">
              <button
                className="preview-nav-btn"
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
              >
                ‹
              </button>
              <div className="input-with-unit">
                <input
                  type="number"
                  min={1}
                  max={pageCount}
                  value={currentPage}
                  onChange={(e) => {
                    const v = parseInt(e.target.value)
                    if (v >= 1 && v <= pageCount) setCurrentPage(v)
                  }}
                />
                <span className="unit">/ {pageCount}</span>
              </div>
              <button
                className="preview-nav-btn"
                onClick={() => setCurrentPage(p => Math.min(pageCount, p + 1))}
                disabled={currentPage >= pageCount}
              >
                ›
              </button>
            </div>
          )}

          <div className="preview-comparison">
            {/* Original panel */}
            <div className="preview-panel">
              <span className="preview-label">Original</span>
              {originalUrl ? (
                <img src={originalUrl} alt={`Original page ${currentPage}`} />
              ) : (
                <div className="preview-placeholder">Loading...</div>
              )}
            </div>

            {/* Converted panel(s) — shows all output pages */}
            {convertedUrls.length > 0 ? (
              <div className="preview-panel">
                <span className="preview-label">
                  Converted ({convertedUrls.length} page{convertedUrls.length !== 1 ? 's' : ''})
                </span>
                <div className="preview-converted-pages">
                  {convertedUrls.map((url, i) => (
                    <div key={i} className="preview-converted-item">
                      <img src={url} alt={`Converted ${i + 1}`} className="converted" />
                      {convertedUrls.length > 1 && (
                        <span className="preview-page-badge">{i + 1}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="preview-panel">
                <span className="preview-label">Converted</span>
                <div className="preview-placeholder">
                  <button
                    className="btn-generate-preview"
                    onClick={handleConvertPreview}
                    disabled={isProcessing}
                  >
                    {isProcessing ? 'Processing...' : 'Generate Preview'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {convertedUrls.length > 0 && (
            <div className="preview-actions">
              <button
                className="btn-generate-preview"
                onClick={handleConvertPreview}
                disabled={isProcessing}
              >
                {isProcessing ? 'Processing...' : 'Regenerate'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

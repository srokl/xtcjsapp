import { createFileRoute } from '@tanstack/react-router'
import { useState, useCallback } from 'react'
import streamSaver from 'streamsaver'
import { optimizeEpubImages, type EpubOptimizeOptions } from '../lib/epub-optimizer'

export const Route = createFileRoute('/epub')({
  component: EpubPage,
})

function EpubPage() {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressText, setProgressText] = useState('')
  const [results, setResults] = useState<Array<{
    name: string
    size?: number
    imageCount: number
    convertedCount: number
    skippedCover: boolean
    data?: ArrayBuffer
    error?: string
  }>>([])

  const [options, setOptions] = useState<EpubOptimizeOptions>({
    dithering: 'zhoufang',
    contrast: 0,
    gamma: 1.0,
    invert: false,
  })

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.epub'))
    if (files.length > 0) setSelectedFiles(prev => [...prev, ...files])
  }, [])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(f => f.name.toLowerCase().endsWith('.epub'))
    if (files.length > 0) setSelectedFiles(prev => [...prev, ...files])
  }, [])

  const handleRemove = useCallback((index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index))
  }, [])

  const handleProcess = useCallback(async () => {
    if (selectedFiles.length === 0) return
    setIsProcessing(true)
    setResults([])
    setProgress(0)

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i]
      setProgressText(file.name)

      const result = await optimizeEpubImages(file, options, (p, status) => {
        setProgress((i + p) / selectedFiles.length)
        setProgressText(status)
      })

      setResults(prev => [...prev, result])
    }

    setProgress(1)
    setProgressText('Complete')
    setIsProcessing(false)
  }, [selectedFiles, options])

  const handleDownload = useCallback(async (result: typeof results[0]) => {
    if (!result.data) return
    const fileStream = streamSaver.createWriteStream(result.name, { size: result.size })
    const writer = fileStream.getWriter()
    await writer.write(new Uint8Array(result.data))
    await writer.close()
  }, [])

  return (
    <div className="content-section" style={{ gridColumn: '1 / -1' }}>
      <div className="section-header" style={{ marginBottom: 'var(--space-lg)' }}>
        <h2>EPUB Image Optimizer (X4)</h2>
      </div>

      <div className="converter-notice">
        <p>
          Converts all images inside EPUB files to <strong>1-bit XTG</strong> format for the XTEink X4 EPUB reader.
          Images are converted at their original dimensions.
          XHTML/CSS/OPF files are preserved as-is — the firmware auto-resolves .xtg files.
        </p>
      </div>

      {/* Drop Zone */}
      <div
        className="dropzone"
        onDrop={handleDrop}
        onDragOver={e => e.preventDefault()}
        onClick={() => document.getElementById('epub-file-input')?.click()}
        style={{ cursor: 'pointer' }}
      >
        <input
          id="epub-file-input"
          type="file"
          accept=".epub"
          multiple
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
        <p style={{ fontSize: '1.1rem', fontWeight: 'bold' }}>Drop EPUB files here or click to browse</p>
        <p style={{ fontSize: '0.85rem', color: 'var(--ink-light)', marginTop: 'var(--space-xs)' }}>
          Accepts .epub files
        </p>
      </div>

      {/* File List */}
      {selectedFiles.length > 0 && (
        <div className="content-section" style={{ marginTop: 'var(--space-lg)' }}>
          <div className="section-header">
            <h2>{selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''} selected</h2>
          </div>
          {selectedFiles.map((file, idx) => (
            <div key={idx} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: 'var(--space-sm) var(--space-md)',
              background: 'var(--paper-dark)', border: 'var(--border)',
              marginBottom: 'var(--space-xs)'
            }}>
              <div>
                <span style={{ fontWeight: 'bold' }}>{file.name}</span>
                <span style={{ marginLeft: 'var(--space-sm)', fontSize: '0.8rem', color: 'var(--ink-light)' }}>
                  ({(file.size / 1024 / 1024).toFixed(2)} MB)
                </span>
              </div>
              <button
                onClick={() => handleRemove(idx)}
                style={{
                  background: 'none', border: 'none', color: 'var(--danger, #c00)',
                  cursor: 'pointer', fontSize: '1.2rem', padding: '0 var(--space-sm)'
                }}
              >
                ×
              </button>
            </div>
          ))}

          <button
            onClick={handleProcess}
            disabled={isProcessing}
            className="btn-download"
            style={{ width: '100%', marginTop: 'var(--space-md)', padding: 'var(--space-md)' }}
          >
            {isProcessing ? 'Processing...' : `Optimize ${selectedFiles.length} EPUB${selectedFiles.length > 1 ? 's' : ''}`}
          </button>
        </div>
      )}

      {/* Options */}
      <aside className="options-panel" style={{ marginTop: 'var(--space-lg)' }}>
        <div className="section-header">
          <h2>Processing Options</h2>
        </div>

        <div className="option">
          <label htmlFor="epub-dithering">Dithering</label>
          <select
            id="epub-dithering"
            value={options.dithering}
            onChange={e => setOptions({ ...options, dithering: e.target.value })}
          >
            <option value="floyd">Floyd-Steinberg</option>
            <option value="stucki">Stucki</option>
            <option value="ostromoukhov">Ostromoukhov</option>
            <option value="zhoufang">Zhou-Fang (Default)</option>
            <option value="atkinson">Atkinson</option>
            <option value="sierra-lite">Sierra Lite</option>
            <option value="ordered">Ordered</option>
            <option value="stochastic">Stochastic</option>
            <option value="none">None</option>
          </select>
        </div>

        <div className="option">
          <label htmlFor="epub-contrast">Contrast</label>
          <select
            id="epub-contrast"
            value={options.contrast}
            onChange={e => setOptions({ ...options, contrast: parseInt(e.target.value) })}
          >
            <option value="0">None</option>
            <option value="2">Light</option>
            <option value="4">Medium</option>
            <option value="6">Strong</option>
            <option value="8">Maximum</option>
          </select>
        </div>

        <div className="option">
          <label htmlFor="epub-gamma">Gamma Correction</label>
          <div className="input-with-unit">
            <input
              type="number"
              id="epub-gamma"
              min="0.1"
              max="3.0"
              step="0.1"
              value={options.gamma}
              onChange={e => setOptions({ ...options, gamma: parseFloat(e.target.value) || 1.0 })}
            />
          </div>
        </div>

        <div className="option checkbox-option">
          <label htmlFor="epub-invert">
            <input
              type="checkbox"
              id="epub-invert"
              checked={options.invert}
              onChange={e => setOptions({ ...options, invert: e.target.checked })}
            />
            Invert Colors
          </label>
        </div>
      </aside>

      {/* Progress */}
      {isProcessing && (
        <div className="content-section" style={{ marginTop: 'var(--space-lg)' }}>
          <div style={{ fontWeight: 'bold', marginBottom: 'var(--space-xs)' }}>{progressText}</div>
          <div style={{
            width: '100%', height: '8px', background: 'var(--paper)',
            borderRadius: '4px', overflow: 'hidden'
          }}>
            <div style={{
              width: `${progress * 100}%`, height: '100%',
              background: 'var(--accent)', transition: 'width 0.2s'
            }} />
          </div>
          <div style={{ fontSize: '0.8rem', marginTop: 'var(--space-xs)', color: 'var(--ink-light)' }}>
            {Math.round(progress * 100)}%
          </div>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="content-section" style={{ marginTop: 'var(--space-lg)' }}>
          <div className="section-header">
            <h2>Results</h2>
          </div>
          {results.map((result, idx) => (
            <div key={idx} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: 'var(--space-md)',
              background: result.error ? 'rgba(255,0,0,0.05)' : 'var(--paper-dark)',
              border: result.error ? '1px solid rgba(255,0,0,0.3)' : 'var(--border)',
              marginBottom: 'var(--space-sm)',
              borderRadius: '4px'
            }}>
              <div>
                <div style={{ fontWeight: 'bold' }}>{result.name}</div>
                {result.error ? (
                  <div style={{ color: '#c00', fontSize: '0.85rem' }}>Error: {result.error}</div>
                ) : (
                  <div style={{ fontSize: '0.85rem', color: 'var(--ink-light)' }}>
                    {result.convertedCount}/{result.imageCount} images converted to XTG
                    {result.skippedCover && ' · cover → grayscale JPEG'}
                    {result.size && ` · ${(result.size / 1024 / 1024).toFixed(2)} MB`}
                  </div>
                )}
              </div>
              {result.data && (
                <button
                  onClick={() => handleDownload(result)}
                  className="btn-download"
                  style={{ padding: 'var(--space-sm) var(--space-lg)', margin: 0 }}
                >
                  Download
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

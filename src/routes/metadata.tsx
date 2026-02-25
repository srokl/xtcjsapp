import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { Dropzone } from '../components/Dropzone'
import { Viewer } from '../components/Viewer'
import { parseXtcFile, type ParsedXtc, extractXtcPages } from '../lib/xtc-reader'
import { buildXtcFromBuffers } from '../lib/xtc-format'
import type { BookMetadata, TocEntry } from '../lib/metadata/types'

export const Route = createFileRoute('/metadata')({
  component: MetadataEditor,
})

function MetadataEditor() {
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<ParsedXtc | null>(null)
  const [metadata, setMetadata] = useState<BookMetadata>({ toc: [] })
  
  const [previewPages, setPreviewPages] = useState<string[]>([])
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)

  const handleFileDrop = async (files: File[]) => {
    if (files.length === 0) return
    const selected = files[0]
    setFile(selected)
    setIsProcessing(true)
    
    try {
      const buffer = await selected.arrayBuffer()
      const parsedData = await parseXtcFile(buffer)
      setParsed(parsedData)
      setMetadata(parsedData.metadata || { toc: [] })
    } catch (e) {
      alert("Failed to parse XTC/XTCH file. Ensure it's a valid format.")
      setFile(null)
    } finally {
      setIsProcessing(false)
    }
  }

  const handlePreview = async () => {
    if (!parsed || !file) return
    setIsProcessing(true)
    try {
      // Decode all pages for preview. This may take a few seconds for large files.
      const canvases = await extractXtcPages(await file.arrayBuffer())
      const urls = canvases.map(c => c.toDataURL('image/png'))
      setPreviewPages(urls)
      setIsPreviewOpen(true)
    } catch (e) {
      alert("Failed to generate preview.")
    } finally {
      setIsProcessing(false)
    }
  }

  const handleSave = async () => {
    if (!parsed || !file) return
    setIsProcessing(true)
    
    try {
      const is2bit = parsed.header.is2bit
      const newBuffer = await buildXtcFromBuffers(parsed.pageData, { metadata, is2bit })
      
      const blob = new Blob([newBuffer], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      
      const a = document.createElement('a')
      a.href = url
      const ext = is2bit ? '.xtch' : '.xtc'
      const baseName = file.name.replace(/\.[^/.]+$/, '')
      a.download = `${baseName}_edited${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error(e)
      alert("Failed to repack XTC file.")
    } finally {
      setIsProcessing(false)
    }
  }

  const handleAddChapter = () => {
    setMetadata(prev => ({
      ...prev,
      toc: [...prev.toc, { title: 'New Chapter', startPage: 1, endPage: parsed?.header.pageCount || 1 }]
    }))
  }

  const handleRemoveChapter = (index: number) => {
    setMetadata(prev => {
      const newToc = [...prev.toc]
      newToc.splice(index, 1)
      return { ...prev, toc: newToc }
    })
  }

  const handleChapterChange = (index: number, field: keyof TocEntry, value: any) => {
    setMetadata(prev => {
      const newToc = [...prev.toc]
      newToc[index] = { ...newToc[index], [field]: value }
      return { ...prev, toc: newToc }
    })
  }

  return (
    <div className="content-section" style={{ gridColumn: '1 / -1' }}>
      <div className="section-header" style={{ marginBottom: 'var(--space-xl)' }}>
        <h2>Metadata Editor (XTC/XTCH)</h2>
      </div>

      {!file && (
        <div className="dropzone-wrapper" style={{ minHeight: '300px' }}>
          <Dropzone onDrop={handleFileDrop} accept=".xtc,.xtch" multiple={false} />
        </div>
      )}

      {isProcessing && <div style={{ margin: 'var(--space-md) 0', fontStyle: 'italic', color: 'var(--ink-faded)' }}>Processing... please wait.</div>}

      {file && parsed && !isProcessing && (
        <div className="metadata-editor" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
          <div style={{ background: 'var(--paper-dark)', padding: 'var(--space-lg)', border: 'var(--border)' }}>
            <h3 style={{ marginBottom: 'var(--space-sm)' }}>File Info</h3>
            <p><strong>Name:</strong> {file.name}</p>
            <p><strong>Pages:</strong> {parsed.header.pageCount}</p>
            <p><strong>Type:</strong> {parsed.header.is2bit ? 'XTCH (2-bit)' : 'XTC (1-bit)'}</p>
            
            <div style={{ marginTop: 'var(--space-md)', display: 'flex', gap: 'var(--space-sm)' }}>
              <button className="btn-preview" onClick={handlePreview}>Preview</button>
              <button className="btn-download" onClick={handleSave}>Save & Download</button>
              <button className="btn-clear-results" onClick={() => { setFile(null); setParsed(null); }}>Close File</button>
            </div>
          </div>

          <div style={{ background: 'var(--paper-dark)', padding: 'var(--space-lg)', border: 'var(--border)' }}>
            <h3 style={{ marginBottom: 'var(--space-sm)' }}>Book Metadata</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
              <label>
                <strong style={{ fontSize: '0.85rem' }}>Title:</strong><br/>
                <input 
                  type="text" 
                  value={metadata.title || ''} 
                  onChange={e => setMetadata(m => ({ ...m, title: e.target.value }))}
                  style={{ width: '100%', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}
                  maxLength={127}
                  placeholder="e.g. My Awesome Manga"
                />
              </label>
              <label>
                <strong style={{ fontSize: '0.85rem' }}>Author:</strong><br/>
                <input 
                  type="text" 
                  value={metadata.author || ''} 
                  onChange={e => setMetadata(m => ({ ...m, author: e.target.value }))}
                  style={{ width: '100%', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}
                  maxLength={111}
                  placeholder="e.g. John Doe"
                />
              </label>
            </div>
          </div>

          <div style={{ background: 'var(--paper-dark)', padding: 'var(--space-lg)', border: 'var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-md)' }}>
              <h3>Chapters (TOC)</h3>
              <button className="btn-preview" onClick={handleAddChapter} style={{ padding: 'var(--space-xs) var(--space-sm)' }}>+ Add Chapter</button>
            </div>
            
            {metadata.toc.length === 0 ? (
              <p style={{ color: 'var(--ink-faded)', fontStyle: 'italic' }}>No chapters defined.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                {metadata.toc.map((entry, idx) => (
                  <div key={idx} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)', alignItems: 'flex-start', background: 'var(--paper)', padding: 'var(--space-md)', border: 'var(--border-light)' }}>
                    <div style={{ flex: '1 1 200px' }}>
                      <label style={{ fontSize: '0.75rem', fontWeight: 600 }}>Chapter Title (max 79 chars)</label>
                      <input 
                        type="text" 
                        value={entry.title} 
                        onChange={e => handleChapterChange(idx, 'title', e.target.value)}
                        style={{ width: '100%', padding: 'var(--space-xs) var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border-light)', color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}
                        maxLength={79}
                      />
                    </div>
                    <div style={{ width: '80px', flex: '0 0 auto' }}>
                      <label style={{ fontSize: '0.75rem', fontWeight: 600 }}>Start Pg</label>
                      <input 
                        type="number" 
                        min={1} 
                        max={parsed.header.pageCount}
                        value={entry.startPage} 
                        onChange={e => handleChapterChange(idx, 'startPage', parseInt(e.target.value) || 1)}
                        style={{ width: '100%', padding: 'var(--space-xs) var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border-light)', color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}
                      />
                    </div>
                    <div style={{ width: '80px', flex: '0 0 auto' }}>
                      <label style={{ fontSize: '0.75rem', fontWeight: 600 }}>End Pg</label>
                      <input 
                        type="number" 
                        min={1} 
                        max={parsed.header.pageCount}
                        value={entry.endPage} 
                        onChange={e => handleChapterChange(idx, 'endPage', parseInt(e.target.value) || 1)}
                        style={{ width: '100%', padding: 'var(--space-xs) var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border-light)', color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}
                      />
                    </div>
                    <button 
                      onClick={() => handleRemoveChapter(idx)}
                      style={{ marginTop: '22px', padding: 'var(--space-xs) var(--space-sm)', background: 'var(--accent)', color: 'white', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.8rem', fontWeight: 500 }}
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {isPreviewOpen && previewPages.length > 0 && (
        <Viewer pages={previewPages} onClose={() => setIsPreviewOpen(false)} />
      )}
    </div>
  )
}

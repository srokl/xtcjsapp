import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import streamSaver from 'streamsaver'
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Dropzone } from '../components/Dropzone'
import { Viewer } from '../components/Viewer'
import { parseXtcFile, type ParsedXtc, extractXtcPages, decodeXtcPageToCanvas } from '../lib/xtc-reader'
import { buildXtcFromBuffers } from '../lib/xtc-format'
import type { BookMetadata, TocEntry } from '../lib/metadata/types'

export const Route = createFileRoute('/metadata')({
  component: MetadataEditor,
})

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'zh-CN', name: 'Chinese (Simplified)' },
  { code: 'zh-TW', name: 'Chinese (Traditional)' },
  { code: 'jp', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'ru', name: 'Russian' },
  { code: 'pt', name: 'Portuguese' },
]

function SortableChapterItem({ 
  id, entry, idx, parsed, metadata, 
  handleChapterChange, handleMoveChapter, handleRemoveChapter, 
  animClass 
}: any) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(transform ? { zIndex: 10, position: 'relative' as const, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' } : {})
  };

  return (
    <div 
      ref={setNodeRef} 
      style={style} 
      className={animClass}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)', alignItems: 'flex-start', background: 'var(--paper)', padding: 'var(--space-md)', border: 'var(--border-light)' }}>
        <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '30px', marginTop: '22px', fontFamily: 'var(--font-mono)', fontSize: '0.85rem', fontWeight: 600, color: 'var(--ink-faded)' }}>
          #{idx + 1}
        </div>
        <div style={{ flex: '1 1 160px' }}>
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
        <div style={{ display: 'flex', gap: 'var(--space-xs)', marginTop: '22px' }}>
          <button 
            onClick={() => handleMoveChapter(idx, 'up')}
            disabled={idx === 0}
            style={{ padding: 'var(--space-xs)', background: 'var(--paper-dark)', color: 'var(--ink)', border: 'var(--border-light)', cursor: idx === 0 ? 'not-allowed' : 'pointer', opacity: idx === 0 ? 0.5 : 1 }}
            aria-label="Move Up"
            title="Move Up"
          >
            ↑
          </button>
          <button 
            onClick={() => handleMoveChapter(idx, 'down')}
            disabled={idx === metadata.toc.length - 1}
            style={{ padding: 'var(--space-xs)', background: 'var(--paper-dark)', color: 'var(--ink)', border: 'var(--border-light)', cursor: idx === metadata.toc.length - 1 ? 'not-allowed' : 'pointer', opacity: idx === metadata.toc.length - 1 ? 0.5 : 1 }}
            aria-label="Move Down"
            title="Move Down"
          >
            ↓
          </button>
          <button 
            onClick={() => handleRemoveChapter(idx)}
            style={{ padding: 'var(--space-xs) var(--space-sm)', background: 'var(--accent)', color: 'white', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: '0.8rem', fontWeight: 500 }}
          >
            Delete
          </button>
          <div 
            {...attributes} 
            {...listeners} 
            style={{ padding: 'var(--space-xs) var(--space-sm)', background: 'var(--paper-dark)', color: 'var(--ink)', border: 'var(--border-light)', cursor: 'grab', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title="Drag to reorder"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6"></line>
              <line x1="8" y1="12" x2="21" y2="12"></line>
              <line x1="8" y1="18" x2="21" y2="18"></line>
              <line x1="3" y1="6" x2="3.01" y2="6"></line>
              <line x1="3" y1="12" x2="3.01" y2="12"></line>
              <line x1="3" y1="18" x2="3.01" y2="18"></line>
            </svg>
          </div>
        </div>
      </div>
    </div>
  )
}

function MetadataEditor() {
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<ParsedXtc | null>(null)
  const [metadata, setMetadata] = useState<BookMetadata>({ toc: [] })
  const [isRawPage, setIsRawPage] = useState(false)
  
  const [previewPages, setPreviewPages] = useState<string[]>([])
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)

  // Pagination and animation state
  const [currentPage, setCurrentPage] = useState(1)
  const [animatingIndex, setAnimatingIndex] = useState<{ idx: number, dir: 'up' | 'down' } | null>(null)
  const itemsPerPage = 10
  
  // Safe calculated pagination
  const totalPages = Math.max(1, Math.ceil(metadata.toc.length / itemsPerPage))
  const safeCurrentPage = Math.min(currentPage, totalPages)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  const handleDragEnd = (event: any) => {
    const { active, over } = event
    if (over && active.id !== over.id) {
      setMetadata((prev) => {
        const oldIndex = parseInt(active.id.split('-')[1], 10)
        const newIndex = parseInt(over.id.split('-')[1], 10)
        if (!isNaN(oldIndex) && !isNaN(newIndex)) {
          return { ...prev, toc: arrayMove(prev.toc, oldIndex, newIndex) }
        }
        return prev
      })
    }
  }

  const handleFileDrop = async (files: File[]) => {
    if (files.length === 0) return
    const selected = files[0]
    setFile(selected)
    setIsProcessing(true)
    
    const ext = selected.name.toLowerCase().split('.').pop()
    const isRaw = ext === 'xtg' || ext === 'xth'
    setIsRawPage(isRaw)

    try {
      const buffer = await selected.arrayBuffer()
      if (isRaw) {
        const canvas = decodeXtcPageToCanvas(buffer)
        setPreviewPages([canvas.toDataURL('image/png')])
        setParsed({
          header: { pageCount: 1, is2bit: ext === 'xth' } as any,
          pageData: [buffer],
          entries: []
        })
      } else {
        const parsedData = await parseXtcFile(buffer)
        setParsed(parsedData)
        setMetadata(parsedData.metadata || { toc: [] })
      }
    } catch (e) {
      alert("Failed to parse file. Ensure it's a valid XTC/XTCH/XTG/XTH format.")
      setFile(null)
    } finally {
      setIsProcessing(false)
    }
  }

  const handlePreview = async () => {
    if (!parsed || !file) return
    if (isRawPage) {
      setIsPreviewOpen(true)
      return
    }
    setIsProcessing(true)
    try {
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
    if (!parsed || !file || isRawPage) return

    // Validate chapters
    for (let i = 0; i < metadata.toc.length; i++) {
      const a = metadata.toc[i]
      if (a.startPage > a.endPage) {
        alert(`Chapter "${a.title}" has an invalid page range (start ${a.startPage} > end ${a.endPage}).`)
        return
      }
      for (let j = i + 1; j < metadata.toc.length; j++) {
        const b = metadata.toc[j]
        if (a.startPage <= b.endPage && a.endPage >= b.startPage) {
          alert(`Chapter overlap detected:\n"${a.title}" (Pages ${a.startPage}-${a.endPage})\noverlaps with\n"${b.title}" (Pages ${b.startPage}-${b.endPage}).\nPlease fix overlapping pages before saving.`)
          return
        }
      }
    }

    setIsProcessing(true)
    
    try {
      const is2bit = parsed.header.is2bit
      const finalMetadata = {
        ...metadata,
        createTime: Math.floor(Date.now() / 1000)
      }
      const newBuffer = await buildXtcFromBuffers(parsed.pageData, { metadata: finalMetadata, is2bit })
      const ext = is2bit ? '.xtch' : '.xtc'
      const baseName = file.name.replace(/\.[^/.]+$/, '')
      const fileName = `${baseName}_edited${ext}`

      try {
        const fileStream = streamSaver.createWriteStream(fileName, {
          size: newBuffer.byteLength,
        })
        const writer = fileStream.getWriter()
        await writer.write(new Uint8Array(newBuffer))
        await writer.close()
        return
      } catch (e) {
        console.warn('StreamSaver failed, falling back to simple download', e)
      }

      const blob = new Blob([newBuffer], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      setTimeout(() => {
          document.body.removeChild(a)
          URL.revokeObjectURL(url)
      }, 100)
      
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
    // Jump to last page when adding
    const newTotalPages = Math.max(1, Math.ceil((metadata.toc.length + 1) / itemsPerPage))
    setCurrentPage(newTotalPages)
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

  const handleMoveChapter = (index: number, direction: 'up' | 'down') => {
    if (direction === 'up' && index === 0) return;
    if (direction === 'down' && index === metadata.toc.length - 1) return;

    const targetIndex = direction === 'up' ? index - 1 : index + 1;

    setMetadata(prev => {
      const newToc = [...prev.toc];
      const temp = newToc[index];
      newToc[index] = newToc[targetIndex];
      newToc[targetIndex] = temp;
      return { ...prev, toc: newToc };
    });

    setAnimatingIndex({ idx: targetIndex, dir: direction });

    const newPage = Math.floor(targetIndex / itemsPerPage) + 1;
    if (newPage !== safeCurrentPage) {
      setCurrentPage(newPage);
    }

    setTimeout(() => setAnimatingIndex(null), 350);
  }

  return (
    <div className="content-section" style={{ gridColumn: '1 / -1' }}>
      <div className="section-header" style={{ marginBottom: 'var(--space-xl)' }}>
        <h2>Metadata Editor (XTC/XTCH)</h2>
      </div>

      {!file && (
        <div className="dropzone-wrapper" style={{ minHeight: '300px' }}>
          <Dropzone onFiles={handleFileDrop} fileType="xtc" multiple={false} />
        </div>
      )}

      {isProcessing && <div style={{ margin: 'var(--space-md) 0', fontStyle: 'italic', color: 'var(--ink-faded)' }}>Processing... please wait.</div>}

      {file && parsed && !isProcessing && (
        <div className="metadata-editor" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
          <div style={{ background: 'var(--paper-dark)', padding: 'var(--space-lg)', border: 'var(--border)' }}>
            <h3 style={{ marginBottom: 'var(--space-sm)' }}>File Info</h3>
            <p><strong>Name:</strong> {file.name}</p>
            {!isRawPage && <p><strong>Pages:</strong> {parsed.header.pageCount}</p>}
            <p><strong>Type:</strong> {isRawPage ? (file.name.toLowerCase().endsWith('.xth') ? 'XTH (2-bit Page)' : 'XTG (1-bit Page)') : (parsed.header.is2bit ? 'XTCH (2-bit)' : 'XTC (1-bit)')}</p>
            {isRawPage && <p style={{ color: 'var(--accent)', fontWeight: 'bold', marginTop: 'var(--space-sm)' }}>XTG/XTH preview only</p>}
            
            <div style={{ marginTop: 'var(--space-md)', display: 'flex', gap: 'var(--space-sm)' }}>
              <button className="btn-preview" onClick={handlePreview}>Preview</button>
              {!isRawPage && <button className="btn-download" onClick={handleSave}>Save & Download</button>}
              <button className="btn-clear-results" onClick={() => { setFile(null); setParsed(null); setPreviewPages([]); setIsRawPage(false); }}>Close File</button>
            </div>
          </div>

          {!isRawPage && (
            <>
              <div style={{ background: 'var(--paper-dark)', padding: 'var(--space-lg)', border: 'var(--border)' }}>
                <h3 style={{ marginBottom: 'var(--space-sm)' }}>Book Metadata</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-md)' }}>
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
                      maxLength={63}
                      placeholder="e.g. John Doe"
                    />
                  </label>
                  <label>
                    <strong style={{ fontSize: '0.85rem' }}>Publisher:</strong><br/>
                    <input 
                      type="text" 
                      value={metadata.publisher || ''} 
                      onChange={e => setMetadata(m => ({ ...m, publisher: e.target.value }))}
                      style={{ width: '100%', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}
                      maxLength={31}
                      placeholder="e.g. Weekly Shonen"
                    />
                  </label>
                  <label>
                    <strong style={{ fontSize: '0.85rem' }}>Language:</strong><br/>
                    <select 
                      value={metadata.language || ''} 
                      onChange={e => setMetadata(m => ({ ...m, language: e.target.value }))}
                      style={{ width: '100%', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}
                    >
                      <option value="">Unknown</option>
                      {LANGUAGES.map(lang => (
                        <option key={lang.code} value={lang.code}>{lang.name} ({lang.code})</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <strong style={{ fontSize: '0.85rem' }}>Cover Page:</strong><br/>
                    <select 
                      value={metadata.coverPage === undefined || metadata.coverPage === 0xFFFF ? 'none' : metadata.coverPage} 
                      onChange={e => setMetadata(m => ({ ...m, coverPage: e.target.value === 'none' ? 0xFFFF : parseInt(e.target.value) }))}
                      style={{ width: '100%', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)', fontFamily: 'var(--font-mono)' }}
                    >
                      <option value="none">None (0xFFFF)</option>
                      {Array.from({ length: parsed.header.pageCount }, (_, i) => (
                        <option key={i} value={i}>Page {i + 1}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <div style={{ background: 'var(--paper-dark)', padding: 'var(--space-lg)', border: 'var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-md)' }}>
                  <h3>Chapters (TOC)</h3>
                  <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
                    {totalPages > 1 && (
                      <div style={{ display: 'flex', gap: 'var(--space-xs)', alignItems: 'center', marginRight: 'var(--space-md)' }}>
                        <button 
                          onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                          disabled={safeCurrentPage === 1}
                          style={{ padding: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border-light)', cursor: safeCurrentPage === 1 ? 'not-allowed' : 'pointer', opacity: safeCurrentPage === 1 ? 0.5 : 1 }}
                        >
                          &lt;
                        </button>
                        <span style={{ fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>{safeCurrentPage} / {totalPages}</span>
                        <button 
                          onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                          disabled={safeCurrentPage === totalPages}
                          style={{ padding: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border-light)', cursor: safeCurrentPage === totalPages ? 'not-allowed' : 'pointer', opacity: safeCurrentPage === totalPages ? 0.5 : 1 }}
                        >
                          &gt;
                        </button>
                      </div>
                    )}
                    <button className="btn-preview" onClick={handleAddChapter} style={{ padding: 'var(--space-xs) var(--space-sm)' }}>+ Add Chapter</button>
                  </div>
                </div>
                
                {metadata.toc.length === 0 ? (
                  <p style={{ color: 'var(--ink-faded)', fontStyle: 'italic' }}>No chapters defined.</p>
                ) : (
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
                      <SortableContext items={metadata.toc.map((_, i) => `chapter-${i}`)} strategy={verticalListSortingStrategy}>
                        {metadata.toc.slice((safeCurrentPage - 1) * itemsPerPage, safeCurrentPage * itemsPerPage).map((entry, sliceIdx) => {
                          const idx = (safeCurrentPage - 1) * itemsPerPage + sliceIdx;
                          const isAnimating = animatingIndex?.idx === idx;
                          const animClass = isAnimating ? (animatingIndex.dir === 'up' ? 'animate-move-up' : 'animate-move-down') : '';
                          const id = `chapter-${idx}`;
                          return (
                            <SortableChapterItem 
                              key={id}
                              id={id}
                              entry={entry}
                              idx={idx}
                              parsed={parsed}
                              metadata={metadata}
                              handleChapterChange={handleChapterChange}
                              handleMoveChapter={handleMoveChapter}
                              handleRemoveChapter={handleRemoveChapter}
                              animClass={animClass}
                            />
                          )
                        })}
                      </SortableContext>
                      
                      <div style={{ marginTop: 'var(--space-md)', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 'var(--space-md)' }}>
                      {totalPages > 1 && (
                        <div style={{ display: 'flex', gap: 'var(--space-xs)' }}>
                          <button 
                            onClick={() => setCurrentPage(1)}
                            disabled={safeCurrentPage === 1}
                            style={{ padding: 'var(--space-xs) var(--space-sm)', background: 'var(--paper)', border: 'var(--border-light)', cursor: safeCurrentPage === 1 ? 'not-allowed' : 'pointer', opacity: safeCurrentPage === 1 ? 0.5 : 1 }}
                          >
                            &lt;&lt;
                          </button>
                          <button 
                            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                            disabled={safeCurrentPage === 1}
                            style={{ padding: 'var(--space-xs) var(--space-sm)', background: 'var(--paper)', border: 'var(--border-light)', cursor: safeCurrentPage === 1 ? 'not-allowed' : 'pointer', opacity: safeCurrentPage === 1 ? 0.5 : 1 }}
                          >
                            &lt;
                          </button>
                          <span style={{ padding: 'var(--space-xs) var(--space-sm)', fontFamily: 'var(--font-mono)' }}>Page {safeCurrentPage} of {totalPages}</span>
                          <button 
                            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                            disabled={safeCurrentPage === totalPages}
                            style={{ padding: 'var(--space-xs) var(--space-sm)', background: 'var(--paper)', border: 'var(--border-light)', cursor: safeCurrentPage === totalPages ? 'not-allowed' : 'pointer', opacity: safeCurrentPage === totalPages ? 0.5 : 1 }}
                          >
                            &gt;
                          </button>
                          <button 
                            onClick={() => setCurrentPage(totalPages)}
                            disabled={safeCurrentPage === totalPages}
                            style={{ padding: 'var(--space-xs) var(--space-sm)', background: 'var(--paper)', border: 'var(--border-light)', cursor: safeCurrentPage === totalPages ? 'not-allowed' : 'pointer', opacity: safeCurrentPage === totalPages ? 0.5 : 1 }}
                          >
                            &gt;&gt;
                          </button>
                        </div>
                      )}
                      </div>
                    </div>
                  </DndContext>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {isPreviewOpen && previewPages.length > 0 && (
        <Viewer pages={previewPages} onClose={() => setIsPreviewOpen(false)} />
      )}
    </div>
  )
}

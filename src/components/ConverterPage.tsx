import { useState, useCallback, useEffect } from 'react'
import { Dropzone } from './Dropzone'
import { FileList } from './FileList'
import { Options } from './Options'
import { Progress } from './Progress'
import { Results } from './Results'
import { Viewer } from './Viewer'
import { convertToXtc, type ConversionOptions } from '../lib/converter'
import { recordConversion } from '../lib/api'
import { consumePendingFiles } from '../lib/file-transfer'
import { useStoredResults, type StoredResult } from '../hooks/useStoredResults'

interface ConverterPageProps {
  fileType: 'cbz' | 'pdf' | 'image' | 'video'
  notice?: string
}

export function ConverterPage({ fileType, notice }: ConverterPageProps) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [transferNotice, setTransferNotice] = useState<string | null>(null)

  // Use IndexedDB-backed storage for results
  const {
    results,
    recoveredResults,
    recoveredCount,
    addResult,
    clearSession,
    clearAll,
    dismissRecovered,
    downloadResult,
    getPreviewImages,
  } = useStoredResults()

  // Check for transferred files on mount
  useEffect(() => {
    const pending = consumePendingFiles()
    if (pending.length > 0) {
      // Filter files matching this converter's type
      const matchingFiles = pending.filter(f => {
        const name = f.name.toLowerCase()
        if (fileType === 'pdf') {
          return name.endsWith('.pdf')
        }
        if (fileType === 'image') {
          return /\.(jpg|jpeg|png|webp|bmp|gif)$/i.test(name)
        }
        if (fileType === 'video') {
          return /\.(mp4|webm|mkv|avi|mov)$/i.test(name)
        }
        // Accept both .cbz and .cbr for comic book type
        return name.endsWith('.cbz') || name.endsWith('.cbr')
      })
      if (matchingFiles.length > 0) {
        setSelectedFiles(matchingFiles)
        setTransferNotice(
          `${matchingFiles.length} file${matchingFiles.length > 1 ? 's' : ''} received from merge/split`
        )
        // Clear notice after 5 seconds
        setTimeout(() => setTransferNotice(null), 5000)
      }
    }
  }, [fileType])

  const [isConverting, setIsConverting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressText, setProgressText] = useState('Processing...')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [viewerPages, setViewerPages] = useState<string[]>([])
  const [options, setOptions] = useState<ConversionOptions>({
    splitMode: (fileType === 'image' || fileType === 'video') ? 'nosplit' : 'overlap',
    dithering: 'stucki',
    contrast: fileType === 'pdf' ? 8 : 0, // Default 0 (None) for Manga/Image/Video
    horizontalMargin: 0,
    verticalMargin: 0,
    orientation: (fileType === 'image' || fileType === 'video') ? 'portrait' : 'landscape',
    is2bit: (fileType === 'image' || fileType === 'video'),
    manhwa: false,
    manhwaOverlap: 50,
    sidewaysOverviews: false,
    includeOverviews: fileType === 'cbz', // Enable for Manga
    padBlack: fileType === 'video', // Video usually looks better with black bars
    gamma: 1.0,
    imageMode: 'cover',
    invert: false,
    videoFps: 1.0,
    device: 'X4',
    sourceType: fileType,
    useWebgl: false,
  })

  const handleFiles = useCallback((files: File[]) => {
    setSelectedFiles(prev => [...prev, ...files])
  }, [])

  const handleRemove = useCallback((index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index))
  }, [])

  const handleConvert = useCallback(async () => {
    if (selectedFiles.length === 0) return

    console.log('[Converter] Starting conversion batch', { files: selectedFiles.length, options })
    setIsConverting(true)
    await clearSession() // Clear previous session results
    setProgress(0)
    setProgressText('Processing...')
    setPreviewUrl(null)

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i]
      console.log(`[Converter] Processing file ${i + 1}/${selectedFiles.length}:`, file.name)
      setProgressText(file.name)
      setProgress(i / selectedFiles.length)

      try {
        // Determine actual file type (cbz vs cbr vs image vs video)
        let actualFileType: 'cbz' | 'cbr' | 'pdf' | 'image' | 'video' = fileType
        if (file.name.toLowerCase().endsWith('.cbr')) actualFileType = 'cbr'
        else if (fileType === 'image') actualFileType = 'image'
        else if (fileType === 'video') actualFileType = 'video'

        console.log(`[Converter] Calling convertToXtc for ${file.name} as ${actualFileType}`)
        const result = await convertToXtc(file, actualFileType, options, (pageProgress, preview) => {
          // console.log(`[Converter] Progress for ${file.name}: ${pageProgress}`) // Verbose
          setProgress((i + pageProgress) / selectedFiles.length)
          if (preview) setPreviewUrl(preview)
        })
        console.log(`[Converter] Result for ${file.name}:`, result)

        // Store result immediately - progressive display
        await addResult(result)

        recordConversion(fileType === 'image' || fileType === 'video' ? 'cbz' : fileType).catch(() => {})
      } catch (err) {
        console.error(`[Converter] Error converting ${file.name}:`, err)
        // Store error result
        await addResult({
          name: file.name.replace(/\.[^/.]+$/, options.is2bit ? '.xtch' : '.xtc'),
          error: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    setProgress(1)
    setProgressText('Complete')
    setPreviewUrl(null)
    setIsConverting(false)
  }, [selectedFiles, fileType, options, addResult, clearSession])

  const handlePreview = useCallback(async (result: StoredResult) => {
    const images = await getPreviewImages(result)
    if (images.length > 0) {
      setViewerPages(images)
    }
  }, [getPreviewImages])

  const handleCloseViewer = useCallback(() => {
    setViewerPages([])
  }, [])

  const handleDownload = useCallback(async (result: StoredResult) => {
    try {
      await downloadResult(result)
    } catch (err) {
      console.error('Download failed:', err)
    }
  }, [downloadResult])

  const handleClearResults = useCallback(async () => {
    await clearSession()
  }, [clearSession])

  // Combine current and recovered results for display
  const allResults = [...recoveredResults, ...results]

  return (
    <>
      {notice && (
        <div className="converter-notice">
          <p>{notice}</p>
        </div>
      )}

      {transferNotice && (
        <div className="transfer-notice">
          <p>{transferNotice}</p>
        </div>
      )}

      {recoveredCount > 0 && (
        <div className="recovered-notice">
          <p>
            Recovered {recoveredCount} file{recoveredCount > 1 ? 's' : ''} from previous session
          </p>
          <div className="recovered-actions">
            <button onClick={dismissRecovered} className="btn-dismiss">
              Dismiss
            </button>
            <button onClick={clearAll} className="btn-clear-all">
              Clear All
            </button>
          </div>
        </div>
      )}

      <Dropzone onFiles={handleFiles} fileType={fileType} />

      <FileList
        files={selectedFiles}
        onRemove={handleRemove}
        onConvert={handleConvert}
        isConverting={isConverting}
      />

      <Options options={options} onChange={setOptions} fileType={fileType} />

      <Progress
        visible={isConverting}
        progress={progress}
        text={progressText}
        previewUrl={previewUrl}
      />

      <Results
        results={allResults}
        onDownload={handleDownload}
        onPreview={handlePreview}
        onClear={results.length > 0 ? handleClearResults : undefined}
      />

      <Viewer pages={viewerPages} onClose={handleCloseViewer} />
    </>
  )
}

import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import streamSaver from 'streamsaver'
import { generateFontBinary, previewFontCharacter, initFreeTypeInstance, measureCharSize, calculateMinimumPadding, type FontGenerationOptions, subsetFontBuffer } from '../lib/font-generator'
import type { FreetypeModule } from 'freetype-wasm/dist/freetype.js'

export const Route = createFileRoute('/font')({
  component: FontPage,
})

const SYSTEM_FONTS = [
  'Arial', 'Helvetica', 'Times New Roman', 'Courier New', 'Georgia',
  'Verdana', 'Comic Sans MS', 'Trebuchet MS', 'Impact', 'system-ui', 'serif', 'sans-serif', 'monospace'
]

function FontPage() {
  const [options, setOptions] = useState<FontGenerationOptions>({
    fontFamily: 'serif',
    fontSize: 10,
    fontWeight: 'normal',
    fontStyle: 'normal',
    vertical: false,
    verticalSymbols: true,
    verticalEnglishUpright: true,
    charSpacing: 0,
    lineSpacing: 0,
    threshold: 400,
    yOffset: 0,
    xOffset: 0,
    autoFit: false,
    oversample: 1,
    hinting: 'Full',
    forceAutohint: true,
    characters: 'abcdefghijklmnopqrstuvwxyz\nABCDEFGHIJKLMNOPQRSTUVWXYZ\n0123456789\n`~!@#$%^&*()-_=+[{]}\\|;:\'",<.>/?\n永不妥协'
  })

  const [previewText, setPreviewText] = useState('abcdefghijklmnopqrstuvwxyz\nABCDEFGHIJKLMNOPQRSTUVWXYZ\n0123456789\n`~!@#$%^&*()-_=+[{]}\\|;:\'",<.>/?\n永不妥协')
  const [isGenerating, setIsGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressInfo, setProgressInfo] = useState<{ current: number, total: number } | null>(null)
  const [showBoundary, setShowBoundary] = useState(false)
  const [customFontName, setCustomFontName] = useState<string | null>(null)
  const [zoomScale, setZoomScale] = useState(1)
  const [previewCutoffCount, setPreviewCutoffCount] = useState(0)
  const [cutoffChars, setCutoffChars] = useState<string[]>([])
  const [generatedCutoffChars, setGeneratedCutoffChars] = useState<string[]>([])
  const [displayLimit, setDisplayLimit] = useState(500)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ftModule, setFtModule] = useState<FreetypeModule | null>(null)

  useEffect(() => {
    initFreeTypeInstance().then(module => {
      setFtModule(module);
      if (module && (module as any).HEAPU8) {
        console.log(`[FreeType] Initialized. WASM Heap Size: ${(module as any).HEAPU8.buffer.byteLength / 1024 / 1024} MB`);
      }
    })
  }, [])

  const handleFontUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const fontName = file.name.replace(/\.[^/.]+$/, "")
      let buffer = await file.arrayBuffer()
      
      if (!ftModule) {
        alert("FreeType not initialized yet. Please wait.")
        return
      }

      const originalBuffer = buffer;

      // If the font is large, subset it to avoid WASM OOM.
      // 5MB is a safe threshold; Japanese fonts are often 10-20MB.
      if (buffer.byteLength > 5 * 1024 * 1024) {
        console.log(`[Font] Large font detected (${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB). Subsetting...`);
        // We subset to the characters user wants to generate + common English chars + current preview
        const subsetChars = options.characters + previewText + "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%^&*()_+-=[]{}|;':\",./<>? ";
        buffer = subsetFontBuffer(buffer, subsetChars);
        console.log(`[Font] Subset complete. New size: ${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB`);
      }

      if (customFontName) {
        try {
          ftModule.UnloadFont(customFontName);
        } catch (e) {
          console.warn("Failed to unload previous font:", e);
        }
      }

      const faces = ftModule.LoadFontFromBytes(new Uint8Array(buffer))
      if (faces.length === 0) {
        throw new Error("No faces found in font file")
      }
      const face = faces[0]
      
      const font = new FontFace(fontName, originalBuffer)
      await font.load()
      document.fonts.add(font)
      setCustomFontName(fontName)
      
      setOptions({ ...options, fontFamily: fontName, freetypeFace: face, renderer: 'canvas-fallback', customFontBuffer: originalBuffer })
    } catch (err) {
      console.error(err)
      alert("Failed to load font file. Please try another TTF/OTF/WOFF file.")
    }
  }

  useEffect(() => {
    if (canvasRef.current) {
      const result = previewFontCharacter(canvasRef.current, previewText, options, showBoundary)
      setPreviewCutoffCount(result.count)
      setCutoffChars(result.chars)
    }
  }, [options, previewText, showBoundary])

  const handleGenerate = async () => {
    setIsGenerating(true)
    setProgress(0)
    setGeneratedCutoffChars([])

    try {
      const { buffer, name, cutoffCount, cutoffChars: chars } = await generateFontBinary(options, (current, total) => {
        setProgress(current / total)
        setProgressInfo({ current, total })
      })

      if (cutoffCount > 0) {
        setGeneratedCutoffChars(chars)
        alert(`Warning: ${cutoffCount} characters were cutoff because they exceeded the character bounding box. Check the bottom of the page for the list.`)
      }

      const fileStream = streamSaver.createWriteStream(name, {
        size: buffer.byteLength,
      })
      const writer = fileStream.getWriter()
      await writer.write(new Uint8Array(buffer))
      await writer.close()
    } catch (e) {
      console.error(e)
      alert("Font generation failed.")
    } finally {
      setIsGenerating(false)
      setProgress(0)
    }
  }

  return (
    <div className="content-section" style={{ gridColumn: '1 / -1' }}>
      <div className="section-header" style={{ marginBottom: 'var(--space-xl)' }}>
        <h2>Font Generator (.bin)</h2>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 'var(--space-xl)' }}>
        <div style={{ background: 'var(--paper-dark)', padding: 'var(--space-lg)', border: 'var(--border)' }}>
          <h3 style={{ marginBottom: 'var(--space-md)' }}>Font Settings</h3>
          {options.freetypeFace ? (
            <div style={{ marginBottom: 'var(--space-sm)', fontSize: '0.8rem', color: 'var(--success)' }}>
              ✓ Native FreeType 1-Bit Hinting Active
            </div>
          ) : (
            <div style={{ marginBottom: 'var(--space-sm)', fontSize: '0.8rem', color: 'var(--ink-light)' }}>
              Using OS Browser Fallback Rendering (Upload a font file for native monochrome hinting)
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
            <div style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'flex-end' }}>
              <label style={{ flex: 1 }}>
                <strong style={{ fontSize: '0.85rem' }}>Font Family</strong><br />
                <input
                  type="text"
                  value={options.fontFamily}
                  onChange={e => {
                    const newFamily = e.target.value;
                    const isCustom = customFontName && newFamily === customFontName;
                    setOptions({ 
                      ...options, 
                      fontFamily: newFamily,
                      freetypeFace: isCustom ? options.freetypeFace : undefined
                    });
                  }}
                  list="fonts"
                  style={{ width: '100%', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)' }}
                />
                <datalist id="fonts">
                  {customFontName && <option value={customFontName} />}
                  {SYSTEM_FONTS.map(f => <option key={f} value={f} />)}
                </datalist>
              </label>

              <div style={{ flex: '0 0 auto' }}>
                <label className="btn-preview" style={{ display: 'inline-block', padding: 'var(--space-sm)', cursor: 'pointer', margin: 0 }}>
                  Upload Font File
                  <input type="file" accept=".ttf,.otf,.woff,.woff2" onChange={handleFontUpload} style={{ display: 'none' }} />
                </label>
              </div>
            </div>

            <label>
              <strong style={{ fontSize: '0.85rem' }}>Preview Text</strong><br />
              <textarea
                value={previewText}
                onChange={e => setPreviewText(e.target.value)}
                style={{ width: '100%', minHeight: '80px', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)', resize: 'vertical' }}
                placeholder="Type text to preview..."
              />
            </label>



            <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
              <label style={{ flex: 1 }}>
                <strong style={{ fontSize: '0.85rem' }}>Font Size (Pt)</strong><br />
                <input
                  type="number" min="8" max="128" step="0.25"
                  value={options.fontSize}
                  onChange={e => setOptions({ ...options, fontSize: e.target.value === '' ? '' as any : parseFloat(e.target.value) })}
                  style={{ width: '100%', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)' }}
                />
              </label>
              <label style={{ flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '2px' }}>
                  <strong style={{ fontSize: '0.85rem' }}>Font Brightness/Weight</strong>
                  <input
                    type="number"
                    min="100" max="900" step="100"
                    value={options.threshold}
                    onChange={e => setOptions({ ...options, threshold: e.target.value === '' ? '' as any : parseInt(e.target.value) })}
                    style={{ width: '60px', padding: '2px 4px', fontSize: '0.8rem', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)' }}
                  />
                </div>
                <input
                  type="range" min="100" max="900" step="100"
                  value={options.threshold}
                  onChange={e => setOptions({ ...options, threshold: parseInt(e.target.value) })}
                  style={{ width: '100%', marginTop: 'var(--space-xs)' }}
                />
              </label>
            </div>

            <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
              {options.vertical ? (
                <label style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: '0.85rem' }}>Square Box Padding (px)</strong>
                    <button
                      type="button"
                      onClick={() => setOptions({ ...options, ...calculateMinimumPadding(previewText, options) })}
                      style={{ fontSize: '0.7rem', padding: '2px 6px', background: 'var(--paper-depth)', border: 'var(--border)', cursor: 'pointer' }}
                    >
                      Auto Min Padding
                    </button>
                  </div>
                  <input
                    type="number"
                    value={options.lineSpacing === options.charSpacing ? options.lineSpacing : ''}
                    onChange={e => setOptions({ ...options, lineSpacing: e.target.value === '' ? '' as any : parseInt(e.target.value), charSpacing: e.target.value === '' ? '' as any : parseInt(e.target.value) })}
                    style={{ width: '100%', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)' }}
                  />
                  <div style={{ fontSize: '0.7rem', color: 'var(--ink-light)', marginTop: '4px' }}>Expands the square grid equally.</div>
                </label>
              ) : (
                <>
                  <label style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong style={{ fontSize: '0.85rem' }}>Height Padding (px)</strong>
                      <button
                        type="button"
                        onClick={() => setOptions({ ...options, ...calculateMinimumPadding(previewText, options) })}
                        style={{ fontSize: '0.7rem', padding: '2px 6px', background: 'var(--paper-depth)', border: 'var(--border)', cursor: 'pointer' }}
                      >
                        Auto Min
                      </button>
                    </div>
                    <input
                      type="number"
                      value={options.lineSpacing}
                      onChange={e => setOptions({ ...options, lineSpacing: e.target.value === '' ? '' as any : parseInt(e.target.value) })}
                      style={{ width: '100%', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)' }}
                    />
                  </label>
                  <label style={{ flex: 1 }}>
                    <strong style={{ fontSize: '0.85rem' }}>Width Padding (px)</strong><br />
                    <input
                      type="number"
                      value={options.charSpacing}
                      onChange={e => setOptions({ ...options, charSpacing: e.target.value === '' ? '' as any : parseInt(e.target.value) })}
                      style={{ width: '100%', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)' }}
                    />
                  </label>
                </>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', marginTop: 'var(--space-sm)' }}>
              <strong style={{ fontSize: '0.85rem' }}>Render Mode</strong>
              <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                  <input
                    type="checkbox"
                    checked={options.autoFit}
                    onChange={e => setOptions({ ...options, autoFit: e.target.checked })}
                  />
                  Auto Fit
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                  <span style={{ fontSize: '0.85rem' }}>Oversample:</span>
                  <select
                    value={options.oversample}
                    onChange={e => setOptions({ ...options, oversample: parseInt(e.target.value) })}
                    style={{ padding: '2px 4px', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)' }}
                  >
                    <option value={1}>1× (Fast)</option>
                    <option value={2}>2× (Better)</option>
                    <option value={4}>4× (Best)</option>
                    <option value={8}>8× (Extreme)</option>
                    <option value={16}>16× (Insane, Slow)</option>
                  </select>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                  <input
                    type="checkbox"
                    checked={options.vertical}
                    onChange={e => setOptions({ ...options, vertical: e.target.checked })}
                  />
                  Vertical Font
                </label>
                {options.vertical && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                    <input
                      type="checkbox"
                      checked={options.verticalSymbols}
                      onChange={e => setOptions({ ...options, verticalSymbols: e.target.checked })}
                    />
                    Rotate Punctuation (-, (), ...)
                  </label>
                )}
                {options.vertical && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                    <input
                      type="checkbox"
                      checked={options.verticalEnglishUpright}
                      onChange={e => setOptions({ ...options, verticalEnglishUpright: e.target.checked })}
                    />
                    Upright English
                  </label>
                )}
              </div>
            </div>

            {options.freetypeFace && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', marginTop: 'var(--space-sm)', padding: 'var(--space-sm)', background: 'var(--paper-depth)', border: 'var(--border)' }}>
                <strong style={{ fontSize: '0.85rem' }}>Renderer Options</strong>
                <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                    <span style={{ fontSize: '0.85rem' }}>Engine:</span>
                    <select
                      value={options.renderer || 'canvas-fallback'}
                      onChange={e => setOptions({ ...options, renderer: e.target.value as any })}
                      style={{ padding: '2px 4px', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)' }}
                    >
                      {ftModule && <option value="freetype">FreeType WASM</option>}
                      <option value="canvas-fallback">Browser Canvas fallback</option>
                    </select>
                  </label>
                  
                  {options.renderer === 'freetype' && (
                    <>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                    <span style={{ fontSize: '0.85rem' }}>Hinting:</span>
                    <select
                      value={options.hinting}
                      onChange={e => setOptions({ ...options, hinting: e.target.value as any })}
                      style={{ padding: '2px 4px', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)' }}
                    >
                      <option value="Full">Full (Mono)</option>
                      <option value="Medium">Medium (Normal)</option>
                      <option value="Slight">Slight (Light)</option>
                      <option value="None">None (Raw Outline)</option>
                    </select>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                    <input
                      type="checkbox"
                      checked={options.forceAutohint}
                      onChange={e => setOptions({ ...options, forceAutohint: e.target.checked })}
                    />
                    Force Auto-hint
                  </label>
                  </>
                  )}
                </div>
                {options.renderer === 'freetype' && (
                  <div style={{ fontSize: '0.7rem', color: 'var(--ink-light)' }}>
                    Mono hinting is best for e-ink. Auto-hint can improve fonts missing internal hints.
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', marginTop: 'var(--space-sm)' }}>
              <strong style={{ fontSize: '0.85rem' }}>Text Paragraph</strong>
              <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                  <input
                    type="radio"
                    name="textPreset"
                    onChange={() => setPreviewText('月落乌啼霜满天，江枫渔火对愁眠。\n姑苏城外寒山寺，夜半钟声到客船。')}
                  />
                  Simplified Chinese
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                  <input
                    type="radio"
                    name="textPreset"
                    onChange={() => setPreviewText('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん\nアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン\nぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ\n吾輩は猫である。名前はまだ無い。ー〜｜‥「」『』［］（）｛｝')}
                  />
                  Japanese (Full Kana + Symbols)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                  <input
                    type="radio"
                    name="textPreset"
                    onChange={() => setPreviewText('、。，．・：；？！ー〜｜‥：「」『』［］（）｛｝〈〉《》【】〔〕〖〗〘〙〚〙\n+-*/=≠≈<>≤≥%‰&@#$£€¢¥^©®™')}
                  />
                  CJK & Math Symbols
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                  <input
                    type="radio"
                    name="textPreset"
                    onChange={() => setPreviewText('月落烏啼霜滿天，江楓漁火對愁眠。\n天地玄黃，宇宙洪荒。日月盈昃，辰宿列張。\n寒來暑往，秋收冬藏。閏餘成歲，律呂調陽。')}
                  />
                  Traditional Chinese
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                  <input
                    type="radio"
                    name="textPreset"
                    onChange={() => setPreviewText('El veloz murciélago hindú comía feliz cardillo y escabeche.\n¿Qué extraña aventura nos aguarda hoy?\n¡Mañana será otro día mejor! (1234567890)')}
                  />
                  Spanish / Latin
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                  <input
                    type="radio"
                    name="textPreset"
                    defaultChecked
                    onChange={() => setPreviewText('abcdefghijklmnopqrstuvwxyz\nABCDEFGHIJKLMNOPQRSTUVWXYZ\n0123456789\n`~!@#$%^&*()-_=+[{]}\\|;:\'",<.>/?\nQuick brown fox jumps over the lazy dog.')}
                  />
                  English (Full Alpha-Numeric)
                </label>
              </div>
            </div>
          </div>
        </div>

        <div style={{ background: 'var(--paper-dark)', padding: 'var(--space-lg)', border: 'var(--border)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-md)', flexWrap: 'wrap', gap: 'var(--space-sm)' }}>
            <h3 style={{ margin: 0 }}>XTEink X4 Preview (480x800)</h3>
            <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', fontSize: '0.85rem' }}>
                <input
                  type="checkbox"
                  checked={showBoundary}
                  onChange={e => setShowBoundary(e.target.checked)}
                />
                Letter Boundaries
              </label>
            </div>
          </div>

          <div style={{ marginBottom: 'var(--space-md)', display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', flex: 1 }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 'bold', minWidth: '80px' }}>Zoom: {zoomScale.toFixed(2)}x</span>
                <input
                  type="range"
                  min="0.1"
                  max="3"
                  step="0.01"
                  value={zoomScale}
                  onChange={(e) => setZoomScale(parseFloat(e.target.value))}
                  style={{ flex: 1 }}
                />
              </label>
              <button
                className="btn-preview"
                style={{ padding: 'var(--space-xs) var(--space-sm)', fontSize: '0.75rem', margin: 0 }}
                onClick={() => setZoomScale(1)}
              >
                1x
              </button>
              <button
                className="btn-preview"
                style={{ padding: 'var(--space-xs) var(--space-sm)', fontSize: '0.75rem', margin: 0 }}
                onClick={() => {
                  const container = document.getElementById('preview-container');
                  if (container) {
                    const availableHeight = container.clientHeight - 32; // minus padding
                    setZoomScale(availableHeight / 800);
                  } else {
                    setZoomScale(0.7); // fallback
                  }
                }}
              >
                Fit to Screen
              </button>
            </div>

            {previewCutoffCount > 0 && (
              <div style={{ color: '#ff4444', fontSize: '0.75rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', background: 'rgba(255, 68, 68, 0.1)', padding: 'var(--space-xs) var(--space-sm)', borderRadius: '4px' }}>
                <span>⚠️ {previewCutoffCount} characters cutoff in preview (highlighted in red)</span>
              </div>
            )}
          </div>

          <div id="preview-container" style={{
            flex: '1 1 auto',
            width: '100%',
            height: '600px',
            maxHeight: '70vh',
            overflow: 'auto',
            background: 'var(--ink)',
            borderRadius: '4px',
            padding: 'var(--space-md)',
            position: 'relative'
          }}>
            <div style={{
              width: `${480 * zoomScale}px`,
              height: `${800 * zoomScale}px`,
              minHeight: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: 'auto'
            }}>
              <div style={{
                border: '2px solid var(--accent)',
                background: 'white',
                width: '480px',
                height: '800px',
                transform: `scale(${zoomScale})`,
                imageRendering: 'pixelated',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                flexShrink: 0
              }}>
                <canvas ref={canvasRef} width={480} height={800} style={{ display: 'block', width: '100%', height: '100%' }}></canvas>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 'var(--space-xl)', fontSize: '0.85rem', color: 'var(--ink-light)', lineHeight: '1.6' }}>
            <div style={{ fontWeight: 'bold', marginBottom: 'var(--space-xs)', color: 'var(--ink)' }}>Estimated display parameters (220 PPI):</div>
            {(() => {
              const box = measureCharSize(options);
              const totalW = box.width;
              const totalH = box.height;
              return (
                <>
                  <div>Single char size (with spacing): ~{totalW}x{totalH}px</div>
                  <div>Screen capacity: {Math.floor(800 / totalH)} lines, {Math.floor(480 / totalW)} chars per line</div>
                  <div>Max chars on screen: {Math.floor(800 / totalH) * Math.floor(480 / totalW)} characters</div>
                </>
              );
            })()}
            <div style={{ fontStyle: 'italic', marginTop: 'var(--space-xs)' }}>Preview styles and data are for reference only, please refer to the actual device.</div>
          </div>

          <div style={{ marginTop: 'var(--space-xl)' }}>
            {isGenerating ? (
              <div style={{ textAlign: 'center' }}>
                <div style={{ marginBottom: 'var(--space-xs)', fontWeight: 'bold' }}>Generating Font...</div>
                <div style={{ width: '100%', height: '8px', background: 'var(--paper)', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{ width: `${progress * 100}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.1s' }}></div>
                </div>
                <div style={{ fontSize: '0.8rem', marginTop: 'var(--space-xs)' }}>
                  {progressInfo ? `${progressInfo.current} of ${progressInfo.total} (${Math.round(progress * 100)}%)` : `${Math.round(progress * 100)}%`}
                </div>
              </div>
            ) : (
              <button
                onClick={handleGenerate}
                className="btn-download"
                style={{ width: '100%', padding: 'var(--space-md)' }}
              >
                Generate .bin Font File
              </button>
            )}
          </div>
        </div>
      </div>

      {cutoffChars.length > 0 && (
        <div style={{ marginTop: 'var(--space-xl)', background: 'rgba(255, 68, 68, 0.05)', border: '1px solid rgba(255, 68, 68, 0.3)', borderRadius: '8px', padding: 'var(--space-lg)' }}>
          <h3 style={{ color: '#ff4444', marginBottom: 'var(--space-sm)', fontSize: '1rem' }}>⚠️ Cutoff Characters in Preview</h3>
          <p style={{ fontSize: '0.85rem', marginBottom: 'var(--space-md)', color: 'var(--ink)' }}>
            The following {cutoffChars.length} characters in your <strong>preview text</strong> exceed the character bounding box and will be clipped.
            Try <strong>increasing line/char spacing</strong>.
          </p>
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-xs)',
            fontFamily: options.fontFamily,
            fontSize: '1.5rem',
            background: 'white',
            padding: 'var(--space-md)',
            borderRadius: '4px',
            border: '1px solid var(--border)',
            color: 'black'
          }}>
            {cutoffChars.map((char, idx) => (
              <div key={idx} style={{ width: '40px', height: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #eee', position: 'relative' }}>
                {char}
                <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(255, 0, 0, 0.1)' }}></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {generatedCutoffChars.length > 0 && (
        <div style={{ marginTop: 'var(--space-xl)', background: 'rgba(255, 68, 68, 0.05)', border: '1px solid rgba(255, 68, 68, 0.3)', borderRadius: '8px', padding: 'var(--space-lg)' }}>
          <h3 style={{ color: '#ff4444', marginBottom: 'var(--space-sm)', fontSize: '1rem' }}>⚠️ Full Font Cutoff Report</h3>
          <p style={{ fontSize: '0.85rem', marginBottom: 'var(--space-md)', color: 'var(--ink)' }}>
            During full font generation, <strong>{generatedCutoffChars.length}</strong> characters were found to exceed the {Math.round(options.fontSize * (220 / 72) + options.charSpacing)}x{Math.round(options.fontSize * (220 / 72) + options.lineSpacing)}px bounding box.
            Showing first 500 symbols:
          </p>
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-xs)',
            fontFamily: options.fontFamily,
            fontSize: '1.2rem',
            maxHeight: '400px',
            overflowY: 'auto',
            background: 'white',
            padding: 'var(--space-md)',
            borderRadius: '4px',
            border: '1px solid var(--border)',
            color: 'black'
          }}>
            {generatedCutoffChars.slice(0, displayLimit).map((char, idx) => (
              <div key={idx} title={`U+${char.charCodeAt(0).toString(16).toUpperCase()}`} style={{ width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #eee', position: 'relative' }}>
                {char}
                <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(255, 0, 0, 0.1)' }}></div>
              </div>
            ))}
          </div>
          {generatedCutoffChars.length > displayLimit && (
            <div style={{ marginTop: 'var(--space-md)', textAlign: 'center' }}>
              <button
                onClick={() => setDisplayLimit(prev => prev + 500)}
                className="btn-preview"
                style={{ padding: 'var(--space-sm) var(--space-lg)' }}
              >
                Load More (+500) — {generatedCutoffChars.length - displayLimit} remaining
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

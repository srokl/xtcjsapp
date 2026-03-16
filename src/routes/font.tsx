import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import streamSaver from 'streamsaver'
import { generateFontBinary, previewFontCharacter, type FontGenerationOptions } from '../lib/font-generator'

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
    threshold: 128,
    yOffset: 0,
    xOffset: 0,
    smoothing: true,
    hinting: true
  })

  const [previewText, setPreviewText] = useState('abcdefghijklmnopqrstuvwxyz\nABCDEFGHIJKLMNOPQRSTUVWXYZ\n0123456789\n`~!@#$%^&*()-_=+[{]}\\|;:\'",<.>/?\n永不妥协')
  const [isGenerating, setIsGenerating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [showBoundary, setShowBoundary] = useState(false)
  const [customFontName, setCustomFontName] = useState<string | null>(null)
  const [zoomScale, setZoomScale] = useState(1)
  const [monitorPpi, setMonitorPpi] = useState(126)
  const [calibrating, setCalibrating] = useState(false)
  const [calibWidth, setCalibWidth] = useState(250) // pixels that should match 5cm
  const [previewCutoffCount, setPreviewCutoffCount] = useState(0)
  
  // 5cm = 1.9685 inches. PPI = pixels / 1.9685
  const updatePpiFromCalib = (px: number) => {
    setCalibWidth(px)
    setMonitorPpi(Math.round(px / 1.9685039))
  }

  const canvasRef = useRef<HTMLCanvasElement>(null)

  const handleFontUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const fontName = file.name.replace(/\.[^/.]+$/, "")
      const buffer = await file.arrayBuffer()
      const font = new FontFace(fontName, buffer)
      await font.load()
      document.fonts.add(font)
      setCustomFontName(fontName)
      setOptions({ ...options, fontFamily: fontName })
    } catch (err) {
      alert("Failed to load font file. Please try another TTF/OTF/WOFF file.")
    }
  }

  useEffect(() => {
    if (canvasRef.current) {
      const count = previewFontCharacter(canvasRef.current, previewText, options, showBoundary)
      setPreviewCutoffCount(count)
    }
  }, [options, previewText, showBoundary])

  const handleGenerate = async () => {
    setIsGenerating(true)
    setProgress(0)

    try {
      const { buffer, name, cutoffCount } = await generateFontBinary(options, (p) => {
        setProgress(p)
      })
      
      if (cutoffCount > 0) {
        alert(`Warning: ${cutoffCount} characters were cutoff because they exceeded the character bounding box. Consider reducing font size or increasing spacing.`)
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
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
            <div style={{ display: 'flex', gap: 'var(--space-md)', alignItems: 'flex-end' }}>
              <label style={{ flex: 1 }}>
                <strong style={{ fontSize: '0.85rem' }}>Font Family</strong><br/>
                <input 
                  type="text" 
                  value={options.fontFamily} 
                  onChange={e => setOptions({ ...options, fontFamily: e.target.value })}
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
              <strong style={{ fontSize: '0.85rem' }}>Preview Text</strong><br/>
              <textarea 
                value={previewText}
                onChange={e => setPreviewText(e.target.value)}
                style={{ width: '100%', minHeight: '80px', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)', resize: 'vertical' }}
                placeholder="Type text to preview..."
              />
            </label>

            <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
              <label style={{ flex: 1 }}>
                <strong style={{ fontSize: '0.85rem' }}>Font Size (Pt)</strong><br/>
                <input 
                  type="number" min="8" max="128" step="0.25"
                  value={options.fontSize} 
                  onChange={e => setOptions({ ...options, fontSize: parseFloat(e.target.value) || 24 })}
                  style={{ width: '100%', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)' }}
                />
              </label>
              <label style={{ flex: 1 }}>
                <strong style={{ fontSize: '0.85rem' }}>Font Brightness/Weight</strong><br/>
                <input 
                  type="range" min="1" max="254" 
                  value={options.threshold} 
                  onChange={e => setOptions({ ...options, threshold: parseInt(e.target.value) || 128 })}
                  style={{ width: '100%', marginTop: 'var(--space-xs)' }}
                />
              </label>
            </div>

            <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
              <label style={{ flex: 1 }}>
                <strong style={{ fontSize: '0.85rem' }}>Line Spacing (px)</strong><br/>
                <input 
                  type="number" 
                  value={options.lineSpacing} 
                  onChange={e => setOptions({ ...options, lineSpacing: parseInt(e.target.value) || 0 })}
                  style={{ width: '100%', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)' }}
                />
              </label>
              <label style={{ flex: 1 }}>
                <strong style={{ fontSize: '0.85rem' }}>Char Spacing (px)</strong><br/>
                <input 
                  type="number" 
                  value={options.charSpacing} 
                  onChange={e => setOptions({ ...options, charSpacing: parseInt(e.target.value) || 0 })}
                  style={{ width: '100%', padding: 'var(--space-sm)', marginTop: 'var(--space-xs)', background: 'var(--paper)', border: 'var(--border)', color: 'var(--ink)' }}
                />
              </label>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)', marginTop: 'var(--space-sm)' }}>
              <strong style={{ fontSize: '0.85rem' }}>Render Mode</strong>
              <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                  <input 
                    type="checkbox" 
                    checked={options.smoothing} 
                    onChange={e => setOptions({ ...options, smoothing: e.target.checked })}
                  />
                  Font Smoothing
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                  <input 
                    type="checkbox" 
                    checked={options.hinting} 
                    onChange={e => setOptions({ ...options, hinting: e.target.checked })}
                  />
                  Stem Hinting
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
                    onChange={() => setPreviewText('月落烏啼霜滿天，江楓漁火對愁眠。\n姑蘇城外寒山寺，夜半鐘聲到客船。')}
                  />
                  Traditional Chinese
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)' }}>
                  <input 
                    type="radio" 
                    name="textPreset"
                    onChange={() => setPreviewText('吾輩は猫である。名前はまだ無い。\nどこで生れたかとんと見当がつかぬ。ー〜｜\n「坊っちゃん」‥‥［（｛｝）］')}
                  />
                  Japanese (Tategaki)
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
                    onChange={() => setPreviewText('abcdefghijklmnopqrstuvwxyz\nABCDEFGHIJKLMNOPQRSTUVWXYZ\n0123456789\n`~!@#$%^&*()-_=+[{]}\\|;:\'",<.>/?\n永不妥协')}
                  />
                  English Characters
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
                onClick={() => setZoomScale(monitorPpi / 220)}
              >
                Real Size (4.3")
              </button>
            </div>

            {previewCutoffCount > 0 && (
              <div style={{ color: '#ff4444', fontSize: '0.75rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', background: 'rgba(255, 68, 68, 0.1)', padding: 'var(--space-xs) var(--space-sm)', borderRadius: '4px' }}>
                <span>⚠️ {previewCutoffCount} characters cutoff in preview (highlighted in red)</span>
              </div>
            )}
            
            <div style={{ padding: 'var(--space-sm)', background: 'var(--paper)', borderRadius: '4px', border: 'var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-xs)' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 'bold' }}>Monitor PPI: {monitorPpi}</span>
                <button 
                  onClick={() => setCalibrating(!calibrating)}
                  style={{ padding: '2px 8px', fontSize: '0.7rem', cursor: 'pointer', background: calibrating ? 'var(--accent)' : 'var(--paper-dark)', border: 'var(--border)', color: 'white', borderRadius: '4px' }}
                >
                  {calibrating ? 'Close Calibration' : 'Calibrate with Ruler'}
                </button>
              </div>
              
              {calibrating ? (
                <div style={{ padding: 'var(--space-sm)', border: '1px dashed var(--accent)', borderRadius: '4px', marginTop: 'var(--space-xs)' }}>
                  <p style={{ fontSize: '0.7rem', margin: '0 0 var(--space-xs) 0' }}>Adjust slider until the red line below is exactly <strong>5 cm (50 mm)</strong> on your screen:</p>
                  <input 
                    type="range" min="50" max="600" step="1" 
                    value={calibWidth} 
                    onChange={e => updatePpiFromCalib(parseInt(e.target.value))}
                    style={{ width: '100%', marginBottom: 'var(--space-sm)' }}
                  />
                  <div style={{ width: `${calibWidth}px`, height: '4px', background: '#ff4444', margin: '0 auto', borderRadius: '2px' }}></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', width: `${calibWidth}px`, margin: '4px auto 0 auto', fontSize: '0.65rem' }}>
                    <span>0</span>
                    <span>5cm</span>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 'var(--space-sm)', fontSize: '0.7rem', color: 'var(--ink-light)' }}>
                  <span>Current representation: <strong>{((480 * zoomScale) / monitorPpi).toFixed(2)}"</strong> ({( ((480 * zoomScale) / monitorPpi) * 2.54 ).toFixed(1)} cm) width</span>
                </div>
              )}
            </div>
          </div>
          
          <div style={{ 
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
              const fontSizePx = options.fontSize * (220 / 72);
              const totalW = fontSizePx + options.charSpacing;
              const totalH = fontSizePx + options.lineSpacing;
              return (
                <>
                  <div>Single char size (with spacing): ~{Math.round(totalW)}x{Math.round(totalH)}px</div>
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
                <div style={{ fontSize: '0.8rem', marginTop: 'var(--space-xs)' }}>{Math.round(progress * 100)}%</div>
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
    </div>
  )
}

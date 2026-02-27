import type { ConversionOptions } from '../lib/converter'

interface OptionsProps {
  options: ConversionOptions
  onChange: (options: ConversionOptions) => void
  fileType?: 'cbz' | 'pdf' | 'image' | 'video'
}

export function Options({ options, onChange, fileType }: OptionsProps) {
  const isImageMode = fileType === 'image'
  const isVideoMode = fileType === 'video'

  return (
    <aside className="options-panel">
      <div className="section-header">
        <h2>Device & Quality</h2>
      </div>

      <div className="option">
        <label htmlFor="device">Target Device</label>
        <select
          id="device"
          value={options.device}
          onChange={(e) => onChange({ ...options, device: e.target.value as any })}
        >
          <option value="X4">XTEink X4 (480x800)</option>
          <option value="X3">XTEink X3 (528x792)</option>
        </select>
      </div>

      {isImageMode ? (
        <>
          <div className="section-header">
            <h2>Image Options</h2>
          </div>
          
          <div className="option">
            <label htmlFor="imageMode">Scaling Mode</label>
            <select
              id="imageMode"
              value={options.imageMode}
              onChange={(e) => onChange({ ...options, imageMode: e.target.value as any })}
            >
              <option value="cover">Cover (Fill & Crop)</option>
              <option value="letterbox">Letterbox (Fit & Pad)</option>
              <option value="fill">Fill (Stretch)</option>
              <option value="crop">Crop (Center 480x800)</option>
            </select>
          </div>

          <div className="option checkbox-option">
            <label htmlFor="is2bit">
              <input
                type="checkbox"
                id="is2bit"
                checked={options.is2bit}
                onChange={(e) => onChange({ ...options, is2bit: e.target.checked })}
              />
              2-bit (High Quality XTCH)
            </label>
          </div>
        </>
      ) : isVideoMode ? (
        <>
          <div className="section-header">
            <h2>Video Options</h2>
          </div>

          <div className="option">
            <label htmlFor="videoFps">Frames per second</label>
            <div className="input-with-unit">
              <input
                type="number"
                id="videoFps"
                min="0.1"
                max="10"
                step="0.1"
                value={options.videoFps}
                onChange={(e) => onChange({ ...options, videoFps: parseFloat(e.target.value) || 1.0 })}
              />
              <span className="unit">FPS</span>
            </div>
          </div>

          <div className="option checkbox-option">
            <label htmlFor="is2bit">
              <input
                type="checkbox"
                id="is2bit"
                checked={options.is2bit}
                onChange={(e) => onChange({ ...options, is2bit: e.target.checked })}
              />
              2-bit (High Quality XTCH) (not recommended)
            </label>
          </div>
        </>
      ) : (
        <>
          <div className="option checkbox-option">
            <label htmlFor="is2bit">
              <input
                type="checkbox"
                id="is2bit"
                checked={options.is2bit}
                onChange={(e) => onChange({ ...options, is2bit: e.target.checked })}
              />
              2-bit (High Quality XTCH)
            </label>
          </div>

          <div className="option">
            <label htmlFor="readingMode">Reading Mode</label>
            <select
              id="readingMode"
              value={options.manhwa ? "manhwa" : "manga"}
              onChange={(e) => onChange({ ...options, manhwa: e.target.value === 'manhwa' })}
            >
              <option value="manga">Manga/Comic</option>
              <option value="manhwa">Manhwa</option>
            </select>
          </div>

          {!isImageMode && !isVideoMode && options.manhwa && (
            <div className="option">
              <label htmlFor="manhwaOverlap">Manhwa Overlap</label>
              <select
                id="manhwaOverlap"
                value={options.manhwaOverlap}
                onChange={(e) => onChange({ ...options, manhwaOverlap: parseInt(e.target.value) })}
              >
                <option value="30">30% Overlap</option>
                <option value="50">50% Overlap</option>
                <option value="75">75% Overlap</option>
              </select>
            </div>
          )}

          {!options.manhwa && (
            <div className="option">
              <label htmlFor="overviews">Overviews</label>
              <select
                id="overviews"
                value={options.sidewaysOverviews ? "sideways" : options.includeOverviews ? "upright" : "none"}
                onChange={(e) => {
                  const val = e.target.value;
                  onChange({
                    ...options,
                    sidewaysOverviews: val === 'sideways',
                    includeOverviews: val === 'upright'
                  });
                }}
              >
                <option value="none">None</option>
                <option value="sideways">Sideways Overviews</option>
                <option value="upright">Upright Overviews</option>
              </select>
            </div>
          )}

          {!isImageMode && !isVideoMode && options.orientation === 'landscape' && !options.manhwa && (
            <div className="option">
              <label htmlFor="splitMode">Page Split</label>
              <select
                id="splitMode"
                value={options.splitMode}
                onChange={(e) => onChange({ ...options, splitMode: e.target.value })}
              >
                <option value="overlap">Overlapping thirds</option>
                <option value="split">Split in half</option>
                <option value="nosplit">No split</option>
              </select>
            </div>
          )}
        </>
      )}

      <div className="option checkbox-option">
        <label htmlFor="padBlack">
          <input
            type="checkbox"
            id="padBlack"
            checked={options.padBlack}
            onChange={(e) => onChange({ ...options, padBlack: e.target.checked })}
          />
          Pad with Black (instead of white)
        </label>
      </div>

      <div className="option checkbox-option">
        <label htmlFor="invert">
          <input
            type="checkbox"
            id="invert"
            checked={options.invert}
            onChange={(e) => onChange({ ...options, invert: e.target.checked })}
          />
          Invert Colors
        </label>
      </div>

      <div className="option checkbox-option">
        <label htmlFor="useWasm">
          <input
            type="checkbox"
            id="useWasm"
            checked={options.useWasm}
            onChange={(e) => onChange({ ...options, useWasm: e.target.checked })}
          />
          Use WebAssembly (Faster Encoding)
        </label>
      </div>

      {options.useWasm && (
        <div style={{ fontSize: '0.7rem', color: 'var(--ink-faded)', marginTop: '-0.5rem', marginBottom: 'var(--space-sm)', fontStyle: 'italic', paddingLeft: '2.5rem' }}>
          Note: If encoding fails, you may need to enable "Experimental WebAssembly" in <code>chrome://flags</code>
        </div>
      )}

      <div className="option checkbox-option">
        <label htmlFor="streamedDownload">
          <input
            type="checkbox"
            id="streamedDownload"
            checked={options.streamedDownload}
            onChange={(e) => onChange({ ...options, streamedDownload: e.target.checked })}
          />
          Streamed Downloading (Memory Constrained)
        </label>
      </div>

      {options.streamedDownload && (
        <div style={{ fontSize: '0.7rem', color: 'var(--ink-faded)', marginTop: '-0.5rem', marginBottom: 'var(--space-sm)', fontStyle: 'italic', paddingLeft: '2.5rem' }}>
          Writes directly to disk. Use for very large files if the browser crashes.
        </div>
      )}

      {options.is2bit && (
        <div className="option">
          <label htmlFor="gamma">Gamma Correction</label>
          <div className="input-with-unit">
            <input
              type="number"
              id="gamma"
              min="0.1"
              max="3.0"
              step="0.1"
              value={options.gamma}
              onChange={(e) => onChange({ ...options, gamma: parseFloat(e.target.value) || 1.0 })}
            />
          </div>
        </div>
      )}

      <div className={`option${options.manhwa ? ' disabled' : ''}`}>
        <label htmlFor="orientation">Orientation</label>
        <select
          id="orientation"
          value={options.orientation}
          onChange={(e) => onChange({ ...options, orientation: e.target.value as any })}
          disabled={options.manhwa}
        >
          <option value="landscape">Landscape</option>
          <option value="portrait">Portrait</option>
        </select>
      </div>

      <div className="option">
        <label htmlFor="dithering">Dithering</label>
        <select
          id="dithering"
          value={options.dithering}
          onChange={(e) => onChange({ ...options, dithering: e.target.value })}
        >
          <option value="floyd">Floyd-Steinberg</option>
          <option value="stucki">Stucki (Experimental)</option>
          <option value="ostromoukhov">Ostromoukhov (Experimental)</option>
          <option value="zhoufang">Zhou-Fang (Experimental)</option>
          <option value="atkinson">Atkinson</option>
          <option value="sierra-lite">Sierra Lite</option>
          <option value="ordered">Ordered</option>
          <option value="stochastic">Stochastic</option>
          <option value="none">None</option>
        </select>
      </div>

      <div className="option">
        <label htmlFor="contrast">Contrast</label>
        <select
          id="contrast"
          value={options.contrast}
          onChange={(e) => onChange({ ...options, contrast: parseInt(e.target.value) })}
        >
          <option value="0">None</option>
          <option value="2">Light</option>
          <option value="4">Medium</option>
          <option value="6">Strong</option>
          <option value="8">Maximum</option>
        </select>
      </div>

      {!isImageMode && !isVideoMode && (
        <div className={`option${options.manhwa ? ' disabled' : ''}`}>
          <label htmlFor="horizontalMargin">Horizontal margin crop</label>
          <div className="input-with-unit">
            <input
              type="number"
              id="horizontalMargin"
              min="0"
              max="20"
              step="0.5"
              value={options.horizontalMargin}
              onChange={(e) => onChange({ ...options, horizontalMargin: parseFloat(e.target.value) || 0 })}
              disabled={options.manhwa}
            />
            <span className="unit">%</span>
          </div>
        </div>
      )}

      {!isImageMode && !isVideoMode && (
        <div className={`option${options.manhwa ? ' disabled' : ''}`}>
          <label htmlFor="verticalMargin">Vertical margin crop</label>
          <div className="input-with-unit">
            <input
              type="number"
              id="verticalMargin"
              min="0"
              max="20"
              step="0.5"
              value={options.verticalMargin}
              onChange={(e) => onChange({ ...options, verticalMargin: parseFloat(e.target.value) || 0 })}
              disabled={options.manhwa}
            />
            <span className="unit">%</span>
          </div>
        </div>
      )}
    </aside>
  )
}

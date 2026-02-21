import type { ConversionOptions } from '../lib/converter'

interface OptionsProps {
  options: ConversionOptions
  onChange: (options: ConversionOptions) => void
}

export function Options({ options, onChange }: OptionsProps) {
  return (
    <aside className="options-panel">
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

      <div className="option checkbox-option">
        <label htmlFor="manhwa">
          <input
            type="checkbox"
            id="manhwa"
            checked={options.manhwa}
            onChange={(e) => onChange({ ...options, manhwa: e.target.checked })}
          />
          Manhwa Mode (Long strips)
        </label>
      </div>

      <div className="option checkbox-option">
        <label htmlFor="sidewaysOverviews" className={options.manhwa ? 'disabled' : ''}>
          <input
            type="checkbox"
            id="sidewaysOverviews"
            checked={options.sidewaysOverviews}
            onChange={(e) => onChange({ ...options, sidewaysOverviews: e.target.checked })}
            disabled={options.manhwa}
          />
          Include Sideways Overviews
        </label>
      </div>

      <div className="option checkbox-option">
        <label htmlFor="includeOverviews" className={options.manhwa ? 'disabled' : ''}>
          <input
            type="checkbox"
            id="includeOverviews"
            checked={options.includeOverviews}
            onChange={(e) => onChange({ ...options, includeOverviews: e.target.checked })}
            disabled={options.manhwa}
          />
          Include Upright Overviews
        </label>
      </div>

      <div className="option checkbox-option">
        <label htmlFor="landscapeRtl" className={options.manhwa ? 'disabled' : ''}>
          <input
            type="checkbox"
            id="landscapeRtl"
            checked={options.landscapeRtl}
            onChange={(e) => onChange({ ...options, landscapeRtl: e.target.checked })}
            disabled={options.manhwa}
          />
          Landscape RTL
        </label>
      </div>

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

      {options.manhwa && (
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

      <div className="option">
        <label htmlFor="orientation">Orientation</label>
        <select
          id="orientation"
          value={options.orientation}
          onChange={(e) => onChange({ ...options, orientation: e.target.value as 'landscape' | 'portrait' })}
          disabled={options.manhwa}
        >
          <option value="landscape">Landscape</option>
          <option value="portrait">Portrait</option>
        </select>
      </div>

      {options.orientation === 'landscape' && !options.manhwa && (
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

      <div className="option">
        <label htmlFor="dithering">Dithering</label>
        <select
          id="dithering"
          value={options.dithering}
          onChange={(e) => onChange({ ...options, dithering: e.target.value })}
        >
          <option value="floyd">Floyd-Steinberg</option>
          <option value="atkinson">Atkinson</option>
          <option value="sierra-lite">Sierra Lite</option>
          <option value="ordered">Ordered</option>
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

      <div className="option">
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

      <div className="option">
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
    </aside>
  )
}

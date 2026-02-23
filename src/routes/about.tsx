import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({
  component: AboutPage,
})

function AboutPage() {
  return (
    <div className="about-page">
      <section className="content-section">
        <h1>About XTC.js</h1>
        <p>
          XTC.js is a free, browser-based converter that transforms your CBZ comic archives and PDF documents
          into XTC format, optimized for the <strong>XTEink X4 e-reader</strong>. 
          It runs entirely in your browser — your files never leave your device, ensuring complete privacy.
        </p>
      </section>

      <section className="content-section">
        <h2>Features</h2>
        <ul className="feature-list">
          <li><strong>Privacy-first:</strong> All processing happens locally in your browser. No uploads, no servers, no tracking.</li>
          <li><strong>Multiple formats:</strong> Convert CBZ (manga/comics), PDF documents, single images, and video files to XTC.</li>
          <li><strong>2-bit Support:</strong> Support for the enhanced 4-level grayscale XTCH format for superior image quality.</li>
          <li><strong>Advanced Dithering:</strong> Choose from <strong>Stucki</strong> (Default), Atkinson, Floyd-Steinberg, or experimental <strong>Zhou-Fang</strong> and <strong>Ostromoukhov</strong> variable-coefficient algorithms.</li>
          <li><strong>Manhwa Mode:</strong> Continuous vertical stitching for webtoons with customizable overlap (30/50/75%).</li>
          <li><strong>Smart Splitting:</strong> Automatically split landscape pages into portrait segments with custom horizontal split counts.</li>
          <li><strong>Video to XTC:</strong> Extract and convert video frames at customizable FPS.</li>
          <li><strong>Orientation Control:</strong> Explicitly set portrait, landscape, or flipped orientations.</li>
          <li><strong>Image Wallpapers:</strong> Dedicated image mode with Cover, Letterbox, Fill, and Center-Crop scaling.</li>
        </ul>
      </section>

      <section className="content-section">
        <h2>How It Works</h2>
        <ol className="steps-list">
          <li><strong>Select files:</strong> Drag and drop your files (CBZ, PDF, Images, or Video).</li>
          <li><strong>Adjust settings:</strong> Choose your dithering, contrast, scaling mode, and orientation.</li>
          <li><strong>Convert:</strong> Watch the real-time preview as the app processes your content.</li>
          <li><strong>Download:</strong> Save your .xtc or .xtch files and transfer them to your XTEink X4.</li>
        </ol>
      </section>

      <section className="content-section">
        <h2>About the XTC/XTCH Format</h2>
        <p>
          XTC is the native format for the XTEink X4 e-reader. 
          <strong>XTC</strong> (1-bit) uses high-contrast black and white pixels, while <strong>XTCH</strong> (2-bit) 
          supports 4 levels of gray using a planar bit-mapping technique. 
          Both formats are optimized for 480×800 e-ink displays to provide paper-like readability with minimal ghosting.
        </p>
      </section>

      <section className="content-section">
        <h2>Frequently Asked Questions</h2>
        <details className="faq-item">
          <summary>Is my data safe?</summary>
          <p>Yes. XTC.js processes everything in your browser using JavaScript and TypedArrays. Your files are never uploaded to any server. You can even use this tool offline once the page is loaded.</p>
        </details>
        <details className="faq-item">
          <summary>What dithering algorithm should I use?</summary>
          <p><strong>Stucki</strong> is now the default and provides the best balance of sharpness and detail. For a smoother "blue noise" look, try <strong>Zhou-Fang</strong> or <strong>Ostromoukhov</strong>. For crisp text, use <strong>Atkinson</strong> or <strong>None</strong>.</p>
        </details>
        <details className="faq-item">
          <summary>Why are my pages split?</summary>
          <p>The XTEink X4 has a portrait display (480×800). Landscape spreads are split into pieces to fill the screen. Use <strong>Horizontal Split Count</strong> to control the number of segments for wide panoramas.</p>
        </details>
      </section>

      <section className="content-section">
        <h2>Credits & Source</h2>
        <p>
          This web application is a fork maintained by <a href="https://github.com/srokl" target="_blank" rel="noopener">srokl</a>. 
          The source code for this app is available on <a href="https://github.com/srokl/xtcjsapp" target="_blank" rel="noopener">GitHub</a>.
        </p>
        <p>
          Original webapp by <a href="https://github.com/varo6" target="_blank" rel="noopener">varo6</a>.
          Core logic based on the Python tools by <a href="https://github.com/srokl/cbz2xtc" target="_blank" rel="noopener">srokl/cbz2xtc</a> (fork of <a href="https://github.com/tazua/cbz2xtc" target="_blank" rel="noopener">tazua/cbz2xtc</a>).
        </p>
      </section>

      <section className="content-section">
        <h2>Privacy Policy</h2>
        <p>
          XTC.js does not collect, store, or transmit any personal data. All file processing occurs locally
          in your browser. No cookies are used for tracking. Google AdSense may use cookies for ad
          personalization — see Google's privacy policy for details.
        </p>
      </section>
    </div>
  )
}

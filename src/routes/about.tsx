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
          <li><strong>Multiple formats:</strong> Convert CBZ/CBR (manga/comics), PDF documents, single images, and video files to XTC.</li>
          <li><strong>WebAssembly Acceleration:</strong> Optional high-performance Wasm pipeline for ultra-fast filtering, dithering, and packing.</li>
          <li><strong>2-bit Support:</strong> Full support for the enhanced 4-level grayscale XTCH format for superior image quality.</li>
          <li><strong>Advanced Dithering:</strong> Choose from <strong>Stucki</strong> (Default), Atkinson, Floyd-Steinberg, or experimental <strong>Zhou-Fang</strong>, <strong>Ostromoukhov</strong>, and <strong>Stochastic</strong> (Hilbert Curve) algorithms.</li>
          <li><strong>High-Quality Scaling:</strong> Uses Box Filter/Area Averaging for sharp, detailed downscaling before 1-bit dithering.</li>
          <li><strong>Manhwa Mode:</strong> Continuous vertical stitching for webtoons with customizable overlap.</li>
          <li><strong>Memory Optimized:</strong> "Streamed Downloading" option writes massive files (like 2GB CBZs) directly to disk, bypassing browser memory limits.</li>
          <li><strong>Metadata & TOC Editor:</strong> View, add, delete, and reorder chapters, and edit title/author information directly inside XTC/XTCH files.</li>
          <li><strong>Merge & Split:</strong> Easily split huge archives into smaller volumes or merge multiple volumes together while preserving chapters.</li>
        </ul>
      </section>

      <section className="content-section">
        <h2>How It Works</h2>
        <ol className="steps-list">
          <li><strong>Select files:</strong> Drag and drop your files (CBZ, CBR, PDF, Images, Video, or existing XTC/XTCH).</li>
          <li><strong>Adjust settings:</strong> Choose your reading mode, dithering, contrast, and scaling mode.</li>
          <li><strong>Convert:</strong> Watch the real-time preview as the app processes your content.</li>
          <li><strong>Download:</strong> Save your optimized .xtc or .xtch files and transfer them to your e-reader.</li>
        </ol>
      </section>

      <section className="content-section">
        <h2>About the XTC/XTCH Format</h2>
        <p>
          XTC is the native format for the XTEink X4 and X3 e-readers. 
          <strong>XTC</strong> (1-bit) uses high-contrast black and white pixels, while <strong>XTCH</strong> (2-bit) 
          supports 4 levels of gray using a planar bit-mapping technique. 
          Both formats are optimized for e-ink displays to provide paper-like readability with minimal ghosting.
        </p>
      </section>

      <section className="content-section">
        <h2>Frequently Asked Questions</h2>
        <details className="faq-item">
          <summary>Is my data safe?</summary>
          <p>Yes. XTC.js processes everything in your browser using JavaScript and WebAssembly. Your files are never uploaded to any server. You can even use this tool offline once the page is loaded.</p>
        </details>
        <details className="faq-item">
          <summary>My browser crashes on large files!</summary>
          <p>If you are converting very large files (like a 1GB+ CBZ), check the <strong>Streamed Downloading</strong> option. This writes the converted data directly to your hard drive page-by-page, preventing the browser from running out of memory. Alternatively, use the <strong>Merge / Split</strong> tab to break the file into smaller volumes first.</p>
        </details>
        <details className="faq-item">
          <summary>What dithering algorithm should I use?</summary>
          <p><strong>Stucki</strong> is the default and provides the best balance of sharpness and detail for manga. For a smoother look, try <strong>Zhou-Fang</strong> or <strong>Ostromoukhov</strong>. For crisp text with less noise, use <strong>Atkinson</strong>.</p>
        </details>
        <details className="faq-item">
          <summary>Why are my landscape pages split?</summary>
          <p>The e-reader has a portrait display. By default, wide landscape spreads are split into overlapping pieces to fill the screen naturally. You can change this behavior in the <strong>Page Split</strong> option under settings.</p>
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

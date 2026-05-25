// LZ4 Compression Web Worker
// Offloads CPU-intensive LZ4 block compression from the main thread

import { compressXtczLz4 } from './processing/lz4-compress'

self.onmessage = (e: MessageEvent) => {
  const { data } = e
  try {
    const compressed = compressXtczLz4(data)
    // Transfer the ArrayBuffer back to main thread (zero-copy)
    ;(self as any).postMessage(compressed, [compressed])
  } catch (err: any) {
    ;(self as any).postMessage({ error: err.message })
  }
}

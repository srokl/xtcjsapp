// LZ4 Worker Manager
// Provides an async interface to offload LZ4 compression to a Web Worker

import Lz4CompressWorker from './lz4-compress.worker?worker'
import { compressXtczLz4 as compressSync } from './processing/lz4-compress'

let worker: Worker | null = null

function getWorker(): Worker {
  if (!worker) {
    worker = new Lz4CompressWorker()
  }
  return worker
}

/**
 * Compress XTC data using LZ4 in a Web Worker (async, non-blocking).
 * Falls back to synchronous compression if Worker creation fails.
 */
export async function compressXtczAsync(data: ArrayBuffer): Promise<ArrayBuffer> {
  try {
    const w = getWorker()
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        w.removeEventListener('message', handler)
        w.removeEventListener('error', errHandler)
        if (e.data?.error) {
          reject(new Error(e.data.error))
        } else {
          resolve(e.data)
        }
      }
      const errHandler = (e: ErrorEvent) => {
        w.removeEventListener('message', handler)
        w.removeEventListener('error', errHandler)
        reject(new Error(e.message))
      }
      w.addEventListener('message', handler)
      w.addEventListener('error', errHandler)
      
      // Transfer the buffer to the worker (zero-copy)
      w.postMessage(data, [data])
    })
  } catch (e) {
    console.warn('[LZ4] Worker failed, falling back to sync compression', e)
    return compressSync(data)
  }
}

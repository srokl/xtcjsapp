/**
 * Font Subset Worker Pool
 * 
 * Manages a pool of Web Workers for parallel font subsetting.
 * The pool dispatches subset requests to idle workers, queuing
 * excess requests until a worker becomes available.
 * 
 * For CJK fonts with ~64 chunks of 1024 characters each, this
 * achieves near-linear speedup on multi-core machines by running
 * multiple opentype.js subset operations concurrently.
 */

import SubsetWorker from './font-subset.worker.ts?worker';

interface PendingRequest {
  resolve: (buffer: ArrayBuffer) => void;
  reject: (err: Error) => void;
}

interface WorkerNode {
  worker: Worker;
  busy: boolean;
  id: number;
}

class FontSubsetPool {
  private workers: WorkerNode[] = [];
  private pendingById: Map<number, PendingRequest> = new Map();
  private queue: Array<{ fontBuffer: ArrayBuffer; characters: string; nameSuffix: string; resolve: (buf: ArrayBuffer) => void; reject: (err: Error) => void }> = [];
  private nextId = 0;
  private poolSize: number;

  constructor() {
    // Use hardware concurrency, capped at 4 to avoid excessive memory usage
    // (each worker loads opentype.js + font buffer copy)
    this.poolSize = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? Math.min(Math.max(1, navigator.hardwareConcurrency - 1), 4)
      : 2;
  }

  private ensurePool() {
    if (this.workers.length > 0) return;
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new SubsetWorker();
      const node: WorkerNode = { worker, busy: false, id: i };

      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (msg.type === 'subset-result' || msg.type === 'preparse-result') {
          const pending = this.pendingById.get(msg.id);
          if (pending) {
            this.pendingById.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else if (msg.type === 'subset-result') {
              pending.resolve(msg.buffer);
            } else {
              // preparse result — resolve with the unicodes array packed in an object
              pending.resolve(msg as any);
            }
          }
          node.busy = false;
          this.dispatchNext(node);
        }
      };

      worker.onerror = (err) => {
        console.error(`[FontSubsetPool] Worker #${node.id} error:`, err);
        node.busy = false;
        this.dispatchNext(node);
      };

      this.workers.push(node);
    }
    console.log(`[FontSubsetPool] Initialized ${this.poolSize} workers`);
  }

  private dispatchNext(node: WorkerNode) {
    if (this.queue.length === 0) return;
    const task = this.queue.shift()!;
    this.dispatchToWorker(node, task.fontBuffer, task.characters, task.nameSuffix, task.resolve, task.reject);
  }

  private dispatchToWorker(
    node: WorkerNode,
    fontBuffer: ArrayBuffer,
    characters: string,
    nameSuffix: string,
    resolve: (buf: ArrayBuffer) => void,
    reject: (err: Error) => void
  ) {
    const id = this.nextId++;
    node.busy = true;
    this.pendingById.set(id, { resolve, reject });
    node.worker.postMessage({
      type: 'subset',
      id,
      fontBuffer,
      characters,
      nameSuffix,
      cacheFont: true
    });
  }

  /**
   * Submit a font subsetting task. Returns a promise that resolves
   * with the subset font ArrayBuffer.
   */
  subset(fontBuffer: ArrayBuffer, characters: string, nameSuffix: string): Promise<ArrayBuffer> {
    this.ensurePool();

    return new Promise<ArrayBuffer>((resolve, reject) => {
      // Find an idle worker
      const idle = this.workers.find(w => !w.busy);
      if (idle) {
        this.dispatchToWorker(idle, fontBuffer, characters, nameSuffix, resolve, reject);
      } else {
        // All workers busy — queue the request
        this.queue.push({ fontBuffer, characters, nameSuffix, resolve, reject });
      }
    });
  }

  /**
   * Pre-parse font and return all unicode codepoints present.
   * This runs on a single worker and returns the glyph count + unicodes array.
   */
  preparse(fontBuffer: ArrayBuffer): Promise<{ glyphCount: number; unicodes: number[] }> {
    this.ensurePool();

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const idle = this.workers.find(w => !w.busy);
      const node = idle || this.workers[0]; // fallback to first worker

      if (!idle) {
        // Queue not supported for preparse — just wait for first worker
        const waitForIdle = () => {
          const freeNode = this.workers.find(w => !w.busy);
          if (freeNode) {
            freeNode.busy = true;
            this.pendingById.set(id, {
              resolve: (result: any) => resolve({ glyphCount: result.glyphCount, unicodes: result.unicodes }),
              reject
            });
            freeNode.worker.postMessage({ type: 'preparse', id, fontBuffer });
          } else {
            setTimeout(waitForIdle, 10);
          }
        };
        waitForIdle();
        return;
      }

      node.busy = true;
      this.pendingById.set(id, {
        resolve: (result: any) => resolve({ glyphCount: result.glyphCount, unicodes: result.unicodes }),
        reject
      });
      node.worker.postMessage({ type: 'preparse', id, fontBuffer });
    });
  }

  /**
   * Terminate all workers and clean up resources.
   */
  destroy() {
    for (const node of this.workers) {
      node.worker.terminate();
    }
    this.workers = [];
    this.pendingById.clear();
    this.queue = [];
  }
}

// Singleton pool — lazily initialized on first use
export const fontSubsetPool = new FontSubsetPool();

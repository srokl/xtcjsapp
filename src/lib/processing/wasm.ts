let wasmInstance: WebAssembly.Instance | null = null;
let wasmMemory: WebAssembly.Memory | null = null;

export async function initWasm(): Promise<void> {
  if (wasmInstance) return;

  try {
    const response = await fetch('/xtc.wasm');
    if (!response.ok) throw new Error(`Failed to load Wasm: ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    
    const module = await WebAssembly.instantiate(buffer, {
      env: {
        abort: (msg: number, file: number, line: number, col: number) => {
          console.error(`Wasm abort at ${line}:${col}`);
        },
        seed: () => Math.random()
      }
    });

    wasmInstance = module.instance;
    wasmMemory = wasmInstance.exports.memory as WebAssembly.Memory;
  } catch (err) {
    console.error('Wasm init failed:', err);
    throw err;
  }
}

export function isWasmLoaded(): boolean {
  return !!wasmInstance;
}

// Memory Layout:
// [Input RGBA] [Scratch F32] [Output Packed]
// HeapBase -> Input -> Scratch -> Output

function ensureMemory(size: number) {
  if (!wasmMemory) throw new Error('Wasm not initialized');
  const neededPages = Math.ceil(size / 65536);
  const currentPages = wasmMemory.buffer.byteLength / 65536;
  if (currentPages < neededPages) {
    wasmMemory.grow(neededPages - currentPages);
  }
}

export function runWasmFilters(imageData: ImageData, contrast: number, gamma: number, invert: boolean): void {
  if (!wasmInstance) throw new Error('Wasm not initialized');
  
  const { width, height, data } = imageData;
  const inputSize = width * height * 4; // RGBA
  
  const heapBase = (wasmInstance.exports.__heap_base as WebAssembly.Global)?.value ?? 65536;
  const inputPtr = heapBase;
  
  ensureMemory(inputPtr + inputSize);
  
  // Copy input
  const memArray = new Uint8Array(wasmMemory.buffer);
  memArray.set(data, inputPtr);
  
  // Call applyFilters (f32, f32, bool)
  // Note: AssemblyScript bool is i32 (0 or 1) in Wasm interface usually
  (wasmInstance.exports.applyFilters as CallableFunction)(width, height, inputPtr, contrast, gamma, invert ? 1 : 0);
  
  // Copy back result
  data.set(memArray.subarray(inputPtr, inputPtr + inputSize));
}

export function runWasmDither(imageData: ImageData, algorithm: string, is2bit: boolean): void {
  if (!wasmInstance) throw new Error('Wasm not initialized');
  
  const { width, height, data } = imageData;
  const inputSize = width * height * 4; // RGBA
  const scratchSize = width * height * 4; // F32
  
  const heapBase = (wasmInstance.exports.__heap_base as WebAssembly.Global)?.value ?? 65536;
  const inputPtr = heapBase;
  const scratchPtr = inputPtr + inputSize;
  
  ensureMemory(scratchPtr + scratchSize);
  
  // Copy input
  const memArray = new Uint8Array(wasmMemory.buffer);
  memArray.set(data, inputPtr);
  
  // Call Dither
  const exports = wasmInstance.exports as any;
  
  switch (algorithm) {
    case 'floyd':
      exports.ditherFloyd(width, height, inputPtr, scratchPtr, is2bit);
      break;
    case 'atkinson':
      exports.ditherAtkinson(width, height, inputPtr, scratchPtr, is2bit);
      break;
    case 'ostromoukhov':
      exports.ditherOstromoukhov(width, height, inputPtr, scratchPtr, is2bit);
      break;
    case 'zhoufang':
      exports.ditherZhouFang(width, height, inputPtr, scratchPtr, is2bit);
      break;
    case 'sierra-lite':
      exports.ditherSierraLite(width, height, inputPtr, scratchPtr, is2bit);
      break;
    case 'ordered':
      exports.ditherOrdered(width, height, inputPtr, is2bit);
      break;
    case 'stochastic':
      exports.ditherStochastic(width, height, inputPtr, scratchPtr, is2bit);
      break;
    case 'stucki':
    default:
      exports.ditherStucki(width, height, inputPtr, scratchPtr, is2bit);
      break;
  }
  
  // Copy back result
  data.set(memArray.subarray(inputPtr, inputPtr + inputSize));
}

export function runWasmPack(imageData: ImageData, is2bit: boolean): Uint8Array {
  if (!wasmInstance) throw new Error('Wasm not initialized');

  const { width, height, data } = imageData;
  const inputSize = width * height * 4; // RGBA
  
  let outputSize = 0;
  if (is2bit) {
    const colBytes = (height + 7) >>> 3;
    outputSize = colBytes * width * 2;
  } else {
    const rowBytes = (width + 7) >>> 3;
    outputSize = rowBytes * height;
  }

  const heapBase = (wasmInstance.exports.__heap_base as WebAssembly.Global)?.value ?? 65536;
  const inputPtr = heapBase;
  const outputPtr = inputPtr + inputSize;
  
  ensureMemory(outputPtr + outputSize);

  // Copy input
  const memArray = new Uint8Array(wasmMemory.buffer);
  memArray.set(data, inputPtr);
  
  // Zero out output buffer
  memArray.fill(0, outputPtr, outputPtr + outputSize);

  // Call Pack
  if (is2bit) {
    (wasmInstance.exports.packXth as CallableFunction)(width, height, inputPtr, outputPtr);
  } else {
    (wasmInstance.exports.packXtc as CallableFunction)(width, height, inputPtr, outputPtr);
  }

  // Return copy of output
  return memArray.slice(outputPtr, outputPtr + outputSize);
}

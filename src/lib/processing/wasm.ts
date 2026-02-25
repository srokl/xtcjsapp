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

export function runWasmPack(imageData: ImageData, is2bit: boolean): Uint8Array {
  if (!wasmInstance || !wasmMemory) throw new Error('Wasm not initialized');

  const { width, height, data } = imageData;
  const inputSize = width * height * 4; // RGBA
  
  // Calculate output size
  // 1-bit: 1 bit per pixel -> width/8 * height
  // 2-bit: 2 planes * (width/8 * height) -> width/8 * height * 2
  // We use ceil for row bytes (1-bit) or col bytes (2-bit)
  
  let outputSize = 0;
  let dstPtrOffset = 0;
  
  if (is2bit) {
    // packXth: colBytes = (height + 7) >>> 3; planeSize = colBytes * width; total = 2 * planeSize
    const colBytes = (height + 7) >>> 3;
    outputSize = colBytes * width * 2;
  } else {
    // packXtc: rowBytes = (width + 7) >>> 3; total = rowBytes * height
    const rowBytes = (width + 7) >>> 3;
    outputSize = rowBytes * height;
  }

  // Minimal memory management: Place input at heap base, output after input.
  // We read __heap_base from exports if available, otherwise assume start of dynamic memory.
  // For a simple module, we can just use offset 0 or a safe offset if we don't care about preserving state between calls.
  // BUT: The module might have static data at 0.
  // We'll try to read the exported global `__heap_base` if it exists, else assume 64KB safe offset.
  
  const heapBase = (wasmInstance.exports.__heap_base as WebAssembly.Global)?.value ?? 65536;
  const inputPtr = heapBase;
  const outputPtr = inputPtr + inputSize;
  const requiredPages = Math.ceil((outputPtr + outputSize) / 65536);
  
  if (wasmMemory.buffer.byteLength < requiredPages * 65536) {
    wasmMemory.grow(requiredPages - (wasmMemory.buffer.byteLength / 65536));
  }

  // Copy input
  const memArray = new Uint8Array(wasmMemory.buffer);
  memArray.set(data, inputPtr);

  // Call Wasm
  if (is2bit) {
    (wasmInstance.exports.packXth as CallableFunction)(width, height, inputPtr, outputPtr);
  } else {
    (wasmInstance.exports.packXtc as CallableFunction)(width, height, inputPtr, outputPtr);
  }

  // Copy output
  // We slice to return a copy
  return memArray.slice(outputPtr, outputPtr + outputSize);
}

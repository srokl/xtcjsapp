var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// ../runtime/src/env.ts
function isBun() {
  return typeof Bun !== "undefined";
}

// ../runtime/src/worker-call.ts
async function callWorker(worker, type, payload, signal, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const handleMessage = (event) => {
      const response = event.data;
      if (response.id !== id)
        return;
      cleanup();
      if (response.ok && response.data !== undefined) {
        resolve(response.data);
      } else {
        reject(new Error(response.error || "Unknown worker error"));
      }
    };
    const handleError = (error) => {
      cleanup();
      reject(new Error(`Worker error: ${error.message}`));
    };
    const handleAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      signal?.removeEventListener("abort", handleAbort);
    };
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    signal?.addEventListener("abort", handleAbort);
    const request = { type, id, payload };
    if (transfer && transfer.length > 0) {
      worker.postMessage(request, transfer);
    } else {
      worker.postMessage(request);
    }
  });
}
var requestId = 0;

// ../runtime/src/worker-helper.ts
function createCodecWorker(workerFilename, options) {
  const normalizedName = workerFilename.endsWith(".js") ? workerFilename : `${workerFilename}.js`;
  const workerMap = {
    "resize.worker.js": {
      package: "@squoosh-kit/resize",
      specifier: "resize.worker.js"
    },
    "webp.worker.js": {
      package: "@squoosh-kit/webp",
      specifier: "webp.worker.js"
    },
    "avif.worker.js": {
      package: "@squoosh-kit/avif",
      specifier: "avif.worker.js"
    },
    "mozjpeg.worker.js": {
      package: "@squoosh-kit/mozjpeg",
      specifier: "mozjpeg.worker.js"
    },
    "jxl.worker.js": {
      package: "@squoosh-kit/jxl",
      specifier: "jxl.worker.js"
    },
    "oxipng.worker.js": {
      package: "@squoosh-kit/oxipng",
      specifier: "oxipng.worker.js"
    },
    "png.worker.js": {
      package: "@squoosh-kit/png",
      specifier: "png.worker.js"
    },
    "imagequant.worker.js": {
      package: "@squoosh-kit/imagequant",
      specifier: "imagequant.worker.js"
    },
    "qoi.worker.js": {
      package: "@squoosh-kit/qoi",
      specifier: "qoi.worker.js"
    },
    "wp2.worker.js": {
      package: "@squoosh-kit/wp2",
      specifier: "wp2.worker.js"
    },
    "hqx.worker.js": {
      package: "@squoosh-kit/hqx",
      specifier: "hqx.worker.js"
    },
    "rotate.worker.js": {
      package: "@squoosh-kit/rotate",
      specifier: "rotate.worker.js"
    },
    "visdif.worker.js": {
      package: "@squoosh-kit/visdif",
      specifier: "visdif.worker.js"
    }
  };
  const workerConfig = workerMap[normalizedName];
  if (!workerConfig) {
    throw new Error(`Unknown worker: ${normalizedName}. ` + `Supported workers: ${Object.keys(workerMap).join(", ")}`);
  }
  try {
    if (typeof window !== "undefined") {
      const packageName = workerConfig.package.split("/")[1];
      const workerFile = normalizedName.replace(".js", ".browser.mjs");
      console.log(`[worker-helper] In browser environment. Trying to create worker:`);
      console.log(`[worker-helper]   - Package Name: ${packageName}`);
      console.log(`[worker-helper]   - Worker File: ${workerFile}`);
      if (options?.assetPath) {
        let normalizedAssetPath = options.assetPath;
        if (!normalizedAssetPath.startsWith("/")) {
          normalizedAssetPath = "/" + normalizedAssetPath;
        }
        if (normalizedAssetPath.endsWith("/")) {
          normalizedAssetPath = normalizedAssetPath.slice(0, -1);
        }
        const workerPath = `${normalizedAssetPath}/${packageName}/${workerFile}`;
        const workerUrl = new URL(workerPath, window.location.origin).href;
        console.log(`[worker-helper] Using provided assetPath. Full Worker URL: ${workerUrl}`);
        try {
          const worker = new Worker(workerUrl, { type: "module" });
          console.log(`[worker-helper] Successfully created worker with assetPath: ${workerUrl}`);
          return worker;
        } catch (e) {
          console.error(`[worker-helper] Failed to load worker from assetPath URL: ${workerUrl}`, e);
          throw new Error(`Worker failed to load from ${workerUrl}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
        }
      }
      const pathStrategies = [
        `../../${packageName}/dist/${workerFile}`,
        `../../../node_modules/@squoosh-kit/${packageName}/dist/${workerFile}`,
        `../../../${packageName}/dist/${workerFile}`
      ];
      let lastError = null;
      for (const relPath of pathStrategies) {
        console.log("relPath:", relPath);
        console.log("import.meta.url:", import.meta.url);
        try {
          const workerUrl = new URL(relPath, import.meta.url);
          console.log(`[worker-helper] Trying path strategy. Full Worker URL: ${workerUrl.href}`);
          const worker = new Worker(workerUrl, {
            type: "module"
          });
          console.log(`[worker-helper] Successfully created worker with URL: ${workerUrl.href}`);
          return worker;
        } catch (error) {
          console.warn(`[worker-helper] Path strategy failed for ${relPath}:`, error);
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (lastError) {
        console.error("[worker-helper] All path strategies failed.", lastError);
        throw lastError;
      }
      throw new Error(`Could not resolve worker ${normalizedName} using any available path strategy`);
    }
    const platformExt = isBun() ? ".bun.js" : ".node.mjs";
    const baseName = normalizedName.replace(".js", "");
    const pkgName = workerConfig.package.split("/")[1];
    const srcRelPath = `../../${pkgName}/src/${baseName}.ts`;
    console.log("srcRelPath:", srcRelPath);
    console.log("import.meta.url:", import.meta.url);
    try {
      return new Worker(new URL(srcRelPath, import.meta.url), {
        type: "module"
      });
    } catch {
      const distRelPath = `../../${pkgName}/dist/${baseName}.${platformExt.slice(1)}`;
      console.log("distRelPath:", distRelPath);
      console.log("import.meta.url:", import.meta.url);
      try {
        return new Worker(new URL(distRelPath, import.meta.url), {
          type: "module"
        });
      } catch {
        if (typeof import.meta.resolve === "function") {
          try {
            const resolved = import.meta.resolve(`${workerConfig.package}/${workerConfig.specifier}`);
            console.log("resolved:", resolved);
            return new Worker(resolved, { type: "module" });
          } catch {}
        }
      }
    }
    throw new Error(`Failed to create worker from ${normalizedName}. ` + `Tried TypeScript source, dist output, and import.meta.resolve. ` + `Ensure the @squoosh-kit/resize and @squoosh-kit/webp packages are installed.`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create worker from ${normalizedName}: ${errorMessage}. ` + `Ensure the @squoosh-kit/resize and @squoosh-kit/webp packages are installed. ` + `If you're using Vite, ensure the worker files are not being optimized as dependencies.`, { cause: error });
  }
}
function createReadyWorker(workerFilename, options, timeoutMs = 1e4) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Worker initialization timeout after ${timeoutMs}ms. Worker file: ${workerFilename}`));
    }, timeoutMs);
    let worker;
    try {
      worker = createCodecWorker(workerFilename, options);
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
      return;
    }
    const handleMessage = (event) => {
      if (event.data?.type === "worker:ready") {
        clearTimeout(timeout);
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
        worker.removeEventListener("messageerror", handleMessageError);
        resolve(worker);
      }
    };
    const handleError = (event) => {
      clearTimeout(timeout);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      worker.removeEventListener("messageerror", handleMessageError);
      reject(new Error(`Worker failed to start: ${event?.message || "Unknown error"}. Worker file: ${workerFilename}`));
    };
    const handleMessageError = () => {
      clearTimeout(timeout);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      worker.removeEventListener("messageerror", handleMessageError);
      reject(new Error(`Worker message error during initialization. Worker file: ${workerFilename}`));
    };
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.addEventListener("messageerror", handleMessageError);
    worker.postMessage({ type: "worker:ping" });
  });
}
var init_worker_helper = () => {};

// ../runtime/src/wasm-loader.ts
async function loadWasmBinary(relativePath, baseUrlOverride) {
  const baseUrl = baseUrlOverride ? typeof baseUrlOverride === "string" ? new URL(".", baseUrlOverride) : new URL(".", baseUrlOverride.href) : new URL(".", import.meta.url);
  const fullUrl = new URL(relativePath, baseUrl);
  console.log(`[WasmLoader] Loading WASM from relative path: ${relativePath}`);
  console.log(`[WasmLoader] Base URL (import.meta.url): ${baseUrl.href}`);
  console.log(`[WasmLoader] Constructed full URL: ${fullUrl.href}`);
  try {
    const response = await fetch(fullUrl.href);
    console.log(`[WasmLoader] Fetch response status for ${fullUrl.href}: ${response.status}`);
    if (!response.ok) {
      const responseText = await response.text();
      console.error(`[WasmLoader] Fetch response text (first 500 chars):`, responseText.substring(0, 500));
      throw new Error(`Failed to fetch WASM module at ${fullUrl.href}: ${response.status} ${response.statusText}`);
    }
    const contentType = response.headers.get("content-type");
    console.log(`[WasmLoader] Response Content-Type: ${contentType}`);
    if (!contentType || !contentType.includes("application/wasm")) {
      console.warn(`[WasmLoader] Warning: WASM module at ${fullUrl.href} served with incorrect MIME type: "${contentType}". Should be "application/wasm".`);
    }
    return await response.arrayBuffer();
  } catch (error) {
    console.error(`[WasmLoader] CRITICAL: Fetching WASM binary from ${fullUrl.href} failed.`, error);
    throw error;
  }
}

// ../runtime/src/validators.ts
function validateImageInput(image) {
  if (!image || typeof image !== "object") {
    throw new TypeError("image must be an object");
  }
  const imageObj = image;
  if (!("data" in imageObj)) {
    throw new TypeError("image.data is required");
  }
  const { data } = imageObj;
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) {
    throw new TypeError("image.data must be Uint8Array or Uint8ClampedArray");
  }
  if (!("width" in imageObj) || !("height" in imageObj)) {
    throw new TypeError("image.width and image.height are required");
  }
  const { width, height } = imageObj;
  if (typeof width !== "number" || !Number.isInteger(width) || width <= 0) {
    throw new RangeError(`image.width must be a positive integer, got ${width}`);
  }
  if (typeof height !== "number" || !Number.isInteger(height) || height <= 0) {
    throw new RangeError(`image.height must be a positive integer, got ${height}`);
  }
  const expectedSize = width * height * 4;
  if (data.length < expectedSize) {
    throw new RangeError(`image.data too small: ${data.length} bytes, expected at least ${expectedSize} bytes for ${width}x${height} RGBA image`);
  }
}
// ../runtime/src/simd-detector.ts
var init_simd_detector = () => {};

// ../runtime/src/index.ts
var init_src = __esm(() => {
  init_worker_helper();
  init_simd_detector();
});

// src/validators.ts
function validateResizeOptions(options) {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("options must be an object");
  }
  const opts = options;
  if (opts.width !== undefined) {
    if (typeof opts.width !== "number" || !Number.isFinite(opts.width) || !Number.isInteger(opts.width) || opts.width <= 0) {
      throw new RangeError(`options.width must be a positive integer, got ${opts.width}`);
    }
  }
  if (opts.height !== undefined) {
    if (typeof opts.height !== "number" || !Number.isFinite(opts.height) || !Number.isInteger(opts.height) || opts.height <= 0) {
      throw new RangeError(`options.height must be a positive integer, got ${opts.height}`);
    }
  }
  if (opts.method !== undefined) {
    const validMethods = ["triangular", "catrom", "mitchell", "lanczos3"];
    if (!validMethods.includes(opts.method)) {
      throw new TypeError(`options.method must be one of: ${validMethods.join(", ")}, got ${opts.method}`);
    }
  }
  if (opts.premultiply !== undefined && typeof opts.premultiply !== "boolean") {
    throw new TypeError(`options.premultiply must be boolean, got ${typeof opts.premultiply}`);
  }
  if (opts.linearRGB !== undefined && typeof opts.linearRGB !== "boolean") {
    throw new TypeError(`options.linearRGB must be boolean, got ${typeof opts.linearRGB}`);
  }
}

// wasm/squoosh_resize.js
function getUint8Memory0() {
  if (cachegetUint8Memory0 === null || cachegetUint8Memory0.buffer !== wasm.memory.buffer) {
    cachegetUint8Memory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachegetUint8Memory0;
}
function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1);
  getUint8Memory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
function getInt32Memory0() {
  if (cachegetInt32Memory0 === null || cachegetInt32Memory0.buffer !== wasm.memory.buffer) {
    cachegetInt32Memory0 = new Int32Array(wasm.memory.buffer);
  }
  return cachegetInt32Memory0;
}
function getUint8ClampedMemory0() {
  if (cachegetUint8ClampedMemory0 === null || cachegetUint8ClampedMemory0.buffer !== wasm.memory.buffer) {
    cachegetUint8ClampedMemory0 = new Uint8ClampedArray(wasm.memory.buffer);
  }
  return cachegetUint8ClampedMemory0;
}
function getClampedArrayU8FromWasm0(ptr, len) {
  return getUint8ClampedMemory0().subarray(ptr / 1, ptr / 1 + len);
}
function resize(input_image, input_width, input_height, output_width, output_height, typ_idx, premultiply, color_space_conversion) {
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
    var ptr0 = passArray8ToWasm0(input_image, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.resize(retptr, ptr0, len0, input_width, input_height, output_width, output_height, typ_idx, premultiply, color_space_conversion);
    var r0 = getInt32Memory0()[retptr / 4 + 0];
    var r1 = getInt32Memory0()[retptr / 4 + 1];
    var v1 = getClampedArrayU8FromWasm0(r0, r1).slice();
    wasm.__wbindgen_free(r0, r1 * 1);
    return v1;
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}
async function load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        if (module.headers.get("Content-Type") != "application/wasm") {
          console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
        } else {
          throw e;
        }
      }
    }
    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);
    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }
}
async function init(input) {
  if (typeof input === "undefined") {
    input = new URL("squoosh_resize_bg.wasm", import.meta.url);
  }
  const imports = {};
  if (typeof input === "string" || typeof Request === "function" && input instanceof Request || typeof URL === "function" && input instanceof URL) {
    input = fetch(input);
  }
  const { instance, module } = await load(await input, imports);
  wasm = instance.exports;
  init.__wbindgen_wasm_module = module;
  return wasm;
}
var wasm, cachegetUint8Memory0 = null, WASM_VECTOR_LEN = 0, cachegetInt32Memory0 = null, cachegetUint8ClampedMemory0 = null, squoosh_resize_default;
var init_squoosh_resize = __esm(() => {
  squoosh_resize_default = init;
});

// src/resize.worker.ts
var exports_resize_worker = {};
__export(exports_resize_worker, {
  resizeClient: () => resizeClient
});
async function init2() {
  if (wasmResize) {
    return;
  }
  if (initPromise) {
    return initPromise;
  }
  initPromise = (async () => {
    try {
      const workerBaseUrl = new URL(".", import.meta.url);
      const isSource = import.meta.url.includes("/src/");
      const wasmPathsToTry = isSource ? ["../wasm/squoosh_resize_bg.wasm", "./wasm/squoosh_resize_bg.wasm"] : ["./wasm/squoosh_resize_bg.wasm", "../wasm/squoosh_resize_bg.wasm"];
      let wasmBuffer = null;
      let lastError = null;
      for (const path of wasmPathsToTry) {
        try {
          wasmBuffer = await loadWasmBinary(path, workerBaseUrl);
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (!wasmBuffer) {
        throw lastError || new Error("Could not load WASM binary from any path");
      }
      try {
        await squoosh_resize_default(wasmBuffer);
      } catch (initError) {
        if (initError instanceof Error && (initError.message.includes("SharedArrayBuffer") || initError.message.includes("first argument must be"))) {
          if (typeof SharedArrayBuffer === "undefined") {
            globalThis.SharedArrayBuffer = ArrayBuffer;
          }
          try {
            await squoosh_resize_default(wasmBuffer);
          } catch (retryError) {
            throw new Error(`WASM module initialization failed even with polyfill: ${retryError instanceof Error ? retryError.message : String(retryError)}`, { cause: retryError });
          }
        } else {
          throw initError;
        }
      }
      wasmResize = resize;
    } catch (error) {
      initPromise = null;
      throw new Error(`Failed to initialize resize WASM module: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  })();
  return initPromise;
}
async function _resizeCore(image, options) {
  validateImageInput(image);
  validateResizeOptions(options);
  await init2();
  if (!wasmResize) {
    throw new Error("Resize module not initialized");
  }
  const { data, width: inputWidth, height: inputHeight } = image;
  let outputWidth = options.width ?? inputWidth;
  let outputHeight = options.height ?? inputHeight;
  if (options.width && !options.height) {
    outputHeight = Math.max(1, Math.round(inputHeight * options.width / inputWidth));
  } else if (options.height && !options.width) {
    outputWidth = Math.max(1, Math.round(inputWidth * options.height / inputHeight));
  }
  if (outputWidth < 1 || outputHeight < 1) {
    throw new RangeError(`Output dimensions must be at least 1x1, got ${outputWidth}x${outputHeight}`);
  }
  const dataArray = data instanceof Uint8ClampedArray ? new Uint8Array(data.buffer, data.byteOffset, data.length) : new Uint8Array(data.buffer, data.byteOffset, data.length);
  const result = wasmResize(dataArray, inputWidth, inputHeight, outputWidth, outputHeight, getResizeMethod(options), options.premultiply ?? true, options.linearRGB ?? true);
  return {
    data: result,
    width: outputWidth,
    height: outputHeight
  };
}
async function resizeClient(image, options, signal) {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  return _resizeCore(image, options);
}
function getResizeMethod(options) {
  const methodMap = {
    triangular: 0,
    catrom: 1,
    mitchell: 2,
    lanczos3: 3
  };
  return methodMap[options?.method ?? "lanczos3"] ?? 3;
}
var wasmResize = null, initPromise = null;
var init_resize_worker = __esm(() => {
  init_src();
  init_squoosh_resize();
  if (typeof self !== "undefined") {
    self.onmessage = async (event) => {
      const data = event.data;
      if (data?.type === "worker:ping") {
        await init2();
        self.postMessage({ type: "worker:ready" });
        return;
      }
      const { id, type, payload } = data;
      const response = { id, ok: false };
      try {
        if (type !== "resize:run") {
          throw new Error(`Unknown message type: ${type}`);
        }
        const resultImage = await _resizeCore(payload.image, payload.options);
        response.ok = true;
        response.data = resultImage;
        const transferBuffer = resultImage.data.buffer instanceof ArrayBuffer ? resultImage.data.buffer : resultImage.data.slice().buffer;
        self.postMessage(response, { transfer: [transferBuffer] });
      } catch (error) {
        response.error = error instanceof Error ? error.message : String(error);
        self.postMessage(response);
      }
    };
  }
});

// src/bridge.ts
init_src();
init_src();

class ResizeClientBridge {
  async resize(image, options, signal) {
    const module = await Promise.resolve().then(() => (init_resize_worker(), exports_resize_worker));
    const resizeClient2 = module.resizeClient;
    return resizeClient2(image, options, signal);
  }
  async terminate() {}
}

class ResizeWorkerBridge {
  worker = null;
  workerReady = null;
  options;
  constructor(options) {
    this.options = options;
  }
  async getWorker() {
    if (!this.workerReady) {
      this.workerReady = this.createWorker();
    }
    return this.workerReady;
  }
  async createWorker() {
    this.worker = await createReadyWorker("resize.worker.js", this.options);
    return this.worker;
  }
  async resize(image, options, signal) {
    const worker = await this.getWorker();
    validateImageInput(image);
    try {
      const result = await callWorker(worker, "resize:run", { image, options }, signal);
      return result;
    } catch (error) {
      console.error("Resize error:", error);
      throw error;
    }
  }
  async terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.workerReady = null;
    }
  }
}
function createBridge(mode, options) {
  if (mode === "worker") {
    return new ResizeWorkerBridge(options);
  }
  return new ResizeClientBridge;
}

// src/index.ts
var globalClientBridge = null;
async function resize2(imageData, options, signal) {
  if (!globalClientBridge) {
    globalClientBridge = createBridge("worker");
  }
  return globalClientBridge.resize(imageData, options, signal);
}
function createResizer(mode = "worker", options) {
  const bridge = createBridge(mode, options);
  return Object.assign((imageData, options2, signal) => {
    return bridge.resize(imageData, options2, signal);
  }, {
    terminate: async () => {
      await bridge.terminate();
    }
  });
}
export {
  resize2 as resize,
  createResizer
};

//# debugId=E7B981B6F40DA2DA64756E2164756E21

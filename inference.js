/* Mirsad: local YOLOv8n inference. ONNX Runtime Web 1.22.0 (MIT).
 * Inputs: RGB, float32/255, NCHW, fixed 640 x 640 letterbox, padding 114.
 * Output: raw YOLOv8 [1, 5, 8400]; coordinates are in 640-pixel input space.
 */
(function () {
  "use strict";

  const scriptURL = document.currentScript && document.currentScript.src;
  const baseURL = new URL("./", scriptURL || document.baseURI);
  const MODEL_URL = new URL("assets/mirsad.onnx", baseURL).href;
  const VENDOR_URL = new URL("vendor/", baseURL).href;
  const INPUT_SIZE = 640;
  const CONFIDENCE = 0.339;
  const NMS_IOU = 0.7;
  const MAX_DETECTIONS = 300;
  let session = null;
  let loadingPromise = null;
  let runtimePromise = null;
  let busy = false;

  function progress(callback, stage, message, value) {
    if (typeof callback === "function") {
      callback({ stage, message, progress: value });
    }
  }

  function loadRuntime() {
    if (window.ort && window.ort.InferenceSession) return Promise.resolve();
    if (!runtimePromise) {
      runtimePromise = new Promise(function (resolve, reject) {
        const tag = document.createElement("script");
        tag.src = new URL("ort.min.js", VENDOR_URL).href;
        tag.async = true;
        tag.onload = function () {
          if (window.ort && window.ort.InferenceSession) resolve();
          else reject(new Error("The inference runtime did not initialise."));
        };
        tag.onerror = function () {
          tag.remove();
          reject(new Error("Could not load the local inference runtime. Reload the page and try again."));
        };
        document.head.appendChild(tag);
      }).catch(function (error) {
        runtimePromise = null;
        throw error;
      });
    }
    return runtimePromise;
  }

  async function fetchModel(callback) {
    const response = await fetch(MODEL_URL, { cache: "force-cache" });
    if (!response.ok) {
      throw new Error("The trained model is unavailable (HTTP " + response.status + ").");
    }
    const total = Number(response.headers.get("content-length")) || 0;
    if (!response.body || !response.body.getReader) {
      return new Uint8Array(await response.arrayBuffer());
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      chunks.push(item.value);
      received += item.value.byteLength;
      const fraction = total ? Math.min(received / total, 1) : 0.5;
      progress(callback, "download", "Loading the trained model…", 0.12 + fraction * 0.6);
    }
    const data = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (data.byteLength < 1024) throw new Error("The model download is incomplete.");
    return data;
  }

  async function loadModel(callback) {
    if (session) {
      progress(callback, "ready", "Model ready", 1);
      return session;
    }
    if (!loadingPromise) {
      loadingPromise = (async function () {
        progress(callback, "runtime", "Preparing the image analyser…", 0.04);
        await loadRuntime();
        window.ort.env.wasm.numThreads = 1;
        window.ort.env.wasm.proxy = false;
        window.ort.env.wasm.wasmPaths = VENDOR_URL;
        window.ort.env.logLevel = "warning";
        const model = await fetchModel(callback);
        progress(callback, "initialise", "Initialising the trained model…", 0.78);
        const candidate = await window.ort.InferenceSession.create(model, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
          executionMode: "sequential"
        });
        if (candidate.inputNames.length !== 1 || candidate.outputNames.length !== 1) {
          await candidate.release();
          throw new Error("This model does not match the expected Mirsad detector.");
        }
        session = candidate;
        progress(callback, "ready", "Model ready", 1);
        return session;
      })().catch(function (error) {
        loadingPromise = null;
        throw error;
      });
    }
    return loadingPromise;
  }

  // Python round() uses ties-to-even, including the resize in Ultralytics LetterBox.
  function roundEven(value) {
    const floor = Math.floor(value);
    const fraction = value - floor;
    if (fraction === 0.5) return floor % 2 === 0 ? floor : floor + 1;
    return Math.round(value);
  }

  function preprocess(image) {
    const width = image.naturalWidth || image.videoWidth || image.width;
    const height = image.naturalHeight || image.videoHeight || image.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error("The image could not be read. Select a valid image and try again.");
    }
    const scale = Math.min(INPUT_SIZE / width, INPUT_SIZE / height);
    const resizedWidth = roundEven(width * scale);
    const resizedHeight = roundEven(height * scale);
    const left = roundEven((INPUT_SIZE - resizedWidth) / 2 - 0.1);
    const top = roundEven((INPUT_SIZE - resizedHeight) / 2 - 0.1);
    const canvas = document.createElement("canvas");
    // Decode at native resolution. Browser-scaled drawImage can select a
    // downsampling filter different from OpenCV INTER_LINEAR.
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("This browser cannot prepare images for analysis.");
    ctx.fillStyle = "rgb(114,114,114)";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    canvas.width = 1;
    canvas.height = 1;
    const plane = INPUT_SIZE * INPUT_SIZE;
    const values = new Float32Array(plane * 3);
    values.fill(114 / 255);
    const x0s = new Int32Array(resizedWidth);
    const x1s = new Int32Array(resizedWidth);
    const xWeights = new Float64Array(resizedWidth);
    const scaleX = width / resizedWidth;
    const scaleY = height / resizedHeight;
    for (let x = 0; x < resizedWidth; x++) {
      const sourceX = Math.max(0, Math.min(width - 1, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sourceX);
      x0s[x] = x0;
      x1s[x] = Math.min(x0 + 1, width - 1);
      xWeights[x] = sourceX - x0;
    }
    for (let y = 0; y < resizedHeight; y++) {
      const sourceY = Math.max(0, Math.min(height - 1, (y + 0.5) * scaleY - 0.5));
      const y0 = Math.floor(sourceY);
      const y1 = Math.min(y0 + 1, height - 1);
      const wy = sourceY - y0;
      const row0 = y0 * width * 4;
      const row1 = y1 * width * 4;
      const destinationRow = (top + y) * INPUT_SIZE + left;
      for (let x = 0; x < resizedWidth; x++) {
        const wx = xWeights[x];
        const p00 = row0 + x0s[x] * 4;
        const p01 = row0 + x1s[x] * 4;
        const p10 = row1 + x0s[x] * 4;
        const p11 = row1 + x1s[x] * 4;
        const destination = destinationRow + x;
        for (let channel = 0; channel < 3; channel++) {
          const upper = rgba[p00 + channel] * (1 - wx) + rgba[p01 + channel] * wx;
          const lower = rgba[p10 + channel] * (1 - wx) + rgba[p11 + channel] * wx;
          // Resize to uint8 first, then normalise, as the Python pipeline does.
          const pixel = Math.round(upper * (1 - wy) + lower * wy);
          values[channel * plane + destination] = pixel / 255;
        }
      }
    }
    return { values, width, height, scale, left, top };
  }

  function intersectionOverUnion(a, b) {
    const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
    const h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    const intersection = w * h;
    const union = (a.x2 - a.x1) * (a.y2 - a.y1) +
      (b.x2 - b.x1) * (b.y2 - b.y1) - intersection;
    return union > 0 ? intersection / union : 0;
  }

  function decode(tensor, prepared) {
    const dims = tensor.dims;
    if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== 5 || dims[2] < 1) {
      throw new Error("Unexpected model output shape: " + dims.join(" × ") + ".");
    }
    const count = dims[2];
    const data = tensor.data;
    if (data.length !== count * 5) throw new Error("The model returned incomplete detection data.");
    const candidates = [];
    for (let i = 0; i < count; i++) {
      const score = data[4 * count + i];
      if (!Number.isFinite(score)) throw new Error("The model returned an invalid confidence score.");
      if (score <= CONFIDENCE) continue;
      const cx = data[i];
      const cy = data[count + i];
      const width = data[2 * count + i];
      const height = data[3 * count + i];
      if (![cx, cy, width, height].every(Number.isFinite)) {
        throw new Error("The model returned invalid box coordinates.");
      }
      if (width <= 0 || height <= 0) continue;
      candidates.push({
        x1: cx - width / 2, y1: cy - height / 2,
        x2: cx + width / 2, y2: cy + height / 2,
        confidence: score, classId: 0, sourceIndex: i
      });
    }
    candidates.sort(function (a, b) {
      return b.confidence - a.confidence || a.sourceIndex - b.sourceIndex;
    });
    const kept = [];
    for (const candidate of candidates) {
      let suppressed = false;
      for (const previous of kept) {
        if (intersectionOverUnion(candidate, previous) > NMS_IOU) {
          suppressed = true;
          break;
        }
      }
      if (!suppressed) {
        kept.push(candidate);
        if (kept.length >= MAX_DETECTIONS) break;
      }
    }
    function clamp(value, maximum) { return Math.min(Math.max(value, 0), maximum); }
    return kept.map(function (box) {
      return {
        x1: clamp((box.x1 - prepared.left) / prepared.scale, prepared.width),
        y1: clamp((box.y1 - prepared.top) / prepared.scale, prepared.height),
        x2: clamp((box.x2 - prepared.left) / prepared.scale, prepared.width),
        y2: clamp((box.y2 - prepared.top) / prepared.scale, prepared.height),
        confidence: box.confidence,
        classId: box.classId
      };
    });
  }

  async function analyze(image, callback) {
    if (busy) throw new Error("An image is already being analysed. Please wait for it to finish.");
    busy = true;
    let input = null;
    let outputs = null;
    try {
      await loadModel(callback);
      const started = performance.now();
      progress(callback, "prepare", "Preparing your image…", 0.12);
      const prepared = preprocess(image);
      input = new window.ort.Tensor("float32", prepared.values, [1, 3, INPUT_SIZE, INPUT_SIZE]);
      progress(callback, "infer", "Analysing visible floating litter…", 0.35);
      await new Promise(function (resolve) { setTimeout(resolve, 0); });
      outputs = await session.run({ [session.inputNames[0]]: input });
      progress(callback, "postprocess", "Locating detections…", 0.9);
      const boxes = decode(outputs[session.outputNames[0]], prepared);
      const result = {
        boxes,
        width: prepared.width,
        height: prepared.height,
        durationMs: performance.now() - started
      };
      progress(callback, "complete", "Analysis complete", 1);
      return result;
    } finally {
      if (input && typeof input.dispose === "function") input.dispose();
      if (outputs) {
        for (const tensor of Object.values(outputs)) {
          if (tensor && typeof tensor.dispose === "function") tensor.dispose();
        }
      }
      busy = false;
    }
  }

  window.MirsadInference = Object.freeze({
    loadModel,
    analyze,
    get loaded() { return Boolean(session); },
    get loading() { return Boolean(loadingPromise) && !session; },
    get analyzing() { return busy; },
    config: Object.freeze({
      inputSize: INPUT_SIZE,
      confidenceThreshold: CONFIDENCE,
      nmsIoU: NMS_IOU,
      maxDetections: MAX_DETECTIONS,
      runtimeVersion: "1.22.0"
    })
  });
})();

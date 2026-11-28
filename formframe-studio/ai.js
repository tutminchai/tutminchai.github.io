import { meshFromField } from './ai-mesh.js';
import { segmentImage } from './geometry.js';

const revision = '6f63d20348a169e9a2f04bdd8c520816dd3200e0';
const modelRoot = 'https://huggingface.co/cgb/triposr-onnx-webgpu/resolve/' + revision + '/';
const runtimeRoot = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
const files = {
  'triplane_q8.onnx': 885712,
  'triplane_q8.onnx.data': 483785728,
  'decoder.onnx': 173796
};
const totalBytes = Object.values(files).reduce((sum, size) => sum + size, 0);
const planeWidth = 64;
const channelCount = 40;
const resolution = 56;

function checkCanceled(signal) {
  if (signal?.aborted) throw new DOMException('已取消 AI 重建。', 'AbortError');
}

async function downloadFile(name, downloaded, report, signal) {
  const url = modelRoot + name;
  const expected = files[name];
  let cache;
  try { cache = await globalThis.caches?.open('formframe-triposr-v1'); } catch { /* browser storage is optional */ }
  const update = received => {
    const bytes = downloaded + Math.min(received, expected);
    report('讀取 AI 模型 ' + Math.round(bytes / 1e6) + ' / 485 MB', 0.02 + 0.48 * bytes / totalBytes);
  };
  const valid = async response => {
    if (!response) return null;
    const blob = await response.blob();
    return blob.size === expected ? blob : null;
  };
  if (cache) {
    const stored = await valid(await cache.match(url).catch(() => null));
    checkCanceled(signal);
    if (stored) { update(expected); return stored; }
  }
  let response;
  try { response = await fetch(url, {signal, credentials:'omit'}); }
  catch (error) {
    checkCanceled(signal);
    throw new Error('無法從 Hugging Face 下載 AI 模型。請確認網路連線後再試。', {cause:error});
  }
  if (!response.ok) throw new Error('AI 模型下載失敗（HTTP ' + response.status + '）。');
  let received = 0, lastReport = 0;
  let body = response;
  if (response.body && typeof TransformStream === 'function') {
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (performance.now() - lastReport > 150) { update(received); lastReport = performance.now(); }
        controller.enqueue(chunk);
      }
    }));
    body = new Response(stream);
  }
  // A Blob can be backed by disk. Avoid holding a second 484 MB JS buffer for the cache.
  const blob = await valid(body);
  checkCanceled(signal);
  if (!blob) throw new Error('AI 模型下載不完整，請重新產生。');
  if (cache) {
    try { await cache.put(url, new Response(blob)); } catch { /* private tabs / storage quota */ }
  }
  update(expected);
  return blob;
}

async function runtime() {
  if (!globalThis.isSecureContext || !navigator.gpu) {
    throw new Error('AI 重建需要 WebGPU。請用可使用硬體加速的新版 Chrome 或 Edge，開啟工作室。也可以改選旋轉成形、輪廓膨形或影像浮雕。');
  }
  const adapter = await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  if (!adapter) throw new Error('瀏覽器無法啟用 WebGPU，請開啟硬體加速，或改用具備相容顯示卡的電腦。');
  let ort;
  try { ort = await import(runtimeRoot + 'ort.webgpu.min.mjs'); }
  catch (cause) { throw new Error('無法載入 AI 運算元件，請確認瀏覽器可以連線至 jsDelivr。', {cause}); }
  ort.env.wasm.wasmPaths = runtimeRoot;
  ort.env.wasm.numThreads = 1;
  return ort;
}

// The model expects 85 percent foreground framing and grey at RGB 0.5 around the subject.
export function prepareModelInput(image, segment) {
  const {width, height, data} = image;
  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const sourceCtx = source.getContext('2d');
  const cutout = sourceCtx.createImageData(width, height);
  cutout.data.set(data);
  let left = width, top = height, right = -1, bottom = -1;
  for (let p = 0; p < width * height; p++) {
    const x = p % width, y = Math.floor(p / width);
    const sx = segment ? Math.min(segment.width-1, Math.floor((x+0.5)*segment.width/width)) : 0;
    const sy = segment ? Math.min(segment.height-1, Math.floor((y+0.5)*segment.height/height)) : 0;
    const alpha = segment && !segment.mask[sy*segment.width+sx] ? 0 : data[p * 4 + 3];
    cutout.data[p * 4 + 3] = alpha;
    if (alpha <= 8) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < left) throw new Error('圖片沒有可辨識的內容，請提供背景透明或主體清楚的圖片。');
  sourceCtx.putImageData(cutout, 0, 0);
  const canvas = document.createElement('canvas');
  const edge = 512;
  canvas.width = canvas.height = edge;
  const ctx = canvas.getContext('2d', {willReadFrequently:true});
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, edge, edge);
  const spanX = right - left + 1, spanY = bottom - top + 1;
  const scale = edge * 0.85 / Math.max(spanX, spanY);
  const w = spanX * scale, h = spanY * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, left, top, spanX, spanY, (edge-w)/2, (edge-h)/2, w, h);
  const pixels = ctx.getImageData(0, 0, edge, edge).data;
  const area = edge * edge, tensor = new Float32Array(area * 3);
  for (let i = 0; i < area; i++) {
    tensor[i] = pixels[i*4] / 255;
    tensor[i+area] = pixels[i*4+1] / 255;
    tensor[i+area*2] = pixels[i*4+2] / 255;
  }
  return tensor;
}

// Bilinear sampling with zero padding and align_corners=false, as in PyTorch grid_sample.
export function sampleFeatures(planes, start, count, gridSize) {
  const features = new Float32Array(count * channelCount * 3);
  const area = planeWidth * planeWidth;
  const coords = Array.from({length:gridSize}, (_, i) => planeWidth * i / (gridSize - 1) - 0.5);
  for (let i = 0; i < count; i++) {
    const idx = start + i;
    const x = coords[idx % gridSize];
    const y = coords[Math.floor(idx/gridSize) % gridSize];
    const z = coords[Math.floor(idx/(gridSize*gridSize))];
    for (let plane = 0; plane < 3; plane++) {
      const u = plane === 2 ? y : x, v = plane === 0 ? y : z;
      const u0 = Math.floor(u), v0 = Math.floor(v);
      const du = u - u0, dv = v - v0;
      let a = ((plane*channelCount)*planeWidth+v0)*planeWidth + u0;
      const w00 = u0 >= 0 && v0 >= 0 ? (1-du)*(1-dv) : 0;
      const w01 = u0+1 < planeWidth && v0 >= 0 ? du*(1-dv) : 0;
      const w10 = u0 >= 0 && v0+1 < planeWidth ? (1-du)*dv : 0;
      const w11 = u0+1 < planeWidth && v0+1 < planeWidth ? du*dv : 0;
      let dest = (i*3+plane)*channelCount;
      for (let ch = 0; ch < channelCount; ch++, a += area) {
        // Never read out of the typed array when padding has weight zero.
        features[dest++] = (w00 ? planes[a]*w00 : 0) + (w01 ? planes[a+1]*w01 : 0) +
          (w10 ? planes[a+planeWidth]*w10 : 0) + (w11 ? planes[a+planeWidth+1]*w11 : 0);
      }
    }
  }
  return features;
}

function yielding() { return new Promise(resolve => setTimeout(resolve, 0)); }

async function inferPlanes(ort, input, model, weights, report, signal) {
  let encoder, tensor, outputs;
  try {
    report('在顯示卡上載入 TripoSR…', 0.53);
    const graph = new Uint8Array(await model.arrayBuffer());
    // Some ONNX exporters prefix external file locations with "./". Read the graph declaration.
    const match = new TextDecoder('latin1').decode(graph).match(/(?:\.\/)?triplane_q8\.onnx\.data/);
    if (!match) throw new Error('TripoSR 權重路徑與模型版本不符。');
    encoder = await ort.InferenceSession.create(graph, {executionProviders:['webgpu'],
      externalData:[{path:match[0], data:weights}]});
    checkCanceled(signal);
    report('從圖片推估物體的立體形狀…', 0.61);
    tensor = new ort.Tensor('float32', input, [1,3,512,512]);
    outputs = await encoder.run({[encoder.inputNames[0]]:tensor});
    checkCanceled(signal);
    const triplane = outputs[encoder.outputNames[0]];
    if (triplane.dims.join(',') !== '1,3,40,64,64') throw new Error('AI 模型輸出尺寸與工作室不符。');
    return new Float32Array(triplane.data);
  } finally {
    for (const output of Object.values(outputs || {})) output.dispose();
    tensor?.dispose();
    if (encoder) await encoder.release();
  }
}

async function inferField(ort, planes, decoderModel, report, signal) {
  const decoder = await ort.InferenceSession.create(new Uint8Array(await decoderModel.arrayBuffer()),
    {executionProviders:['webgpu']});
  const voxels = resolution ** 3;
  const density = new Float32Array(voxels), colors = new Float32Array(voxels*3);
  const batchSize = 4096;
  try {
    for (let start = 0; start < voxels; start += batchSize) {
      checkCanceled(signal);
      const length = Math.min(batchSize, voxels - start);
      const input = new ort.Tensor('float32', sampleFeatures(planes, start, length, resolution), [length,120]);
      let outputs;
      try {
        outputs = await decoder.run({[decoder.inputNames[0]]:input});
        const tensors = Object.values(outputs);
        const d = tensors.find(t => t.size === length);
        const c = tensors.find(t => t.size === length*3);
        if (!d || !c) throw new Error('AI 模型沒有回傳預期的密度與色彩資料。');
        density.set(d.data, start);
        colors.set(c.data, start*3);
      } finally {
        input.dispose();
        for (const output of Object.values(outputs || {})) output.dispose();
      }
      report('重建表面形狀與色彩…', 0.72+0.23*(start+length)/voxels);
      await yielding();
    }
  } finally { await decoder.release(); }
  return {density, colors};
}

export async function buildAI(imageData, {onProgress = ()=>{}, signal, background = true} = {}) {
  checkCanceled(signal);
  const report = (message, fraction) => { checkCanceled(signal); onProgress(message, fraction); };
  report('檢查 WebGPU…', 0);
  const ort = await runtime();
  checkCanceled(signal);
  const segment = background ? segmentImage(imageData, true) : null;
  const input = prepareModelInput(imageData, segment);
  const encoderModel = await downloadFile('triplane_q8.onnx', 0, report, signal);
  let weights = await downloadFile('triplane_q8.onnx.data', files['triplane_q8.onnx'], report, signal);
  const decoderModel = await downloadFile('decoder.onnx', totalBytes-files['decoder.onnx'], report, signal);
  checkCanceled(signal);
  const planes = await inferPlanes(ort, input, encoderModel, weights, report, signal);
  weights = null;
  const {density, colors} = await inferField(ort, planes, decoderModel, report, signal);
  report('建立網格與色彩貼圖…', 0.96);
  await yielding();
  checkCanceled(signal);
  const result = meshFromField(density, colors, resolution);
  if (!result.indices.length) throw new Error('AI 未辨識到可重建的表面，請改用主體完整、背景透明的圖片。');
  report('AI 模型已完成', 1);
  return result;
}

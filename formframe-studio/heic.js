let loadingDecoder;

// File pickers and drag-and-drop do not always supply a MIME type.
export async function isHeicFile(file) {
  if (/\.hei[cf]$/i.test(file.name) || /^image\/(?:x-)?hei[cf](?:-sequence)?$/i.test(file.type)) return true;
  if (/^image\/(jpeg|png|webp)$/i.test(file.type)) return false;
  const header = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  if (header.length < 16) return false;
  const fourcc = i => String.fromCharCode(...header.subarray(i, i + 4));
  if (fourcc(4) !== 'ftyp') return false;
  const bytes = new DataView(header.buffer).getUint32(0);
  if (bytes < 16) return false;
  const brands = [fourcc(8)];
  for (let i = 16; i + 4 <= Math.min(bytes, header.length); i += 4) brands.push(fourcc(i));
  if (brands.includes('avif') || brands.includes('avis')) return false;
  return brands.some(brand => /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand));
}

function loadDecoder() {
  if (typeof globalThis.HeicTo === 'function') return Promise.resolve(globalThis.HeicTo);
  if (!loadingDecoder) {
    loadingDecoder = new Promise((resolve, reject) => {
      const embedded = document.getElementById('heic-codec');
      const script = document.createElement('script');
      script.onload = () => typeof globalThis.HeicTo === 'function' ? resolve(globalThis.HeicTo) : reject(new Error('HEIC 解碼元件載入失敗。'));
      script.onerror = () => reject(new Error('無法載入 HEIC 解碼元件，請重新解壓縮工具包後再試。'));
      script.src = embedded ? 'data:text/javascript;base64,' + embedded.textContent.trim() : './vendor/heic-to.js';
      document.head.appendChild(script);
    }).catch(error => { loadingDecoder = undefined; throw error; });
  }
  return loadingDecoder;
}

export async function decodeHeic(file, loadImage) {
  const convert = await loadDecoder();
  try {
    if (typeof createImageBitmap === 'function') return await convert({blob:file, type:'bitmap'});
    const png = await convert({blob:file, type:'image/png'});
    const url = URL.createObjectURL(png);
    try { return await loadImage(url); } finally { URL.revokeObjectURL(url); }
  } catch {
    throw new Error('無法解碼這張 HEIC／HEIF 照片，請確認檔案完整後再試。');
  }
}

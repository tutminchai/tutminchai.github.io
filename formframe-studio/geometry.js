const limit = (value, low, high) => Math.min(high, Math.max(low, value));

function readRaster(image) {
  const { width: w, height: h, data } = image || {};
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 ||
      !data || data.length !== 4 * w * h)
    throw new Error('圖片資料不完整，請重新選擇圖片。');

  const scale = Math.min(1, 512 / Math.max(w, h));
  if (scale === 1) return { w, h, data };
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  const sampled = new Uint8ClampedArray(4 * sw * sh);
  for (let y = 0; y < sh; ++y) {
    for (let x = 0; x < sw; ++x) {
      const from = 4 * (Math.floor((y + 0.5) * h / sh) * w + Math.floor((x + 0.5) * w / sw));
      const to = 4 * (y * sw + x);
      for (let k = 0; k < 4; ++k) sampled[to + k] = data[from + k];
    }
  }
  return { w: sw, h: sh, data: sampled };
}

// Pick a border color only if it recurs around the frame. A busy photographic
// background can then be retained instead of erasing arbitrary object colors.
function backgroundColor({ w, h, data }) {
  const samples = [];
  function sample(x, y) {
    const i = 4 * (x + y * w);
    samples.push([data[i], data[i + 1], data[i + 2]]);
  }
  for (let k = 0; k < 32; ++k) {
    const x = Math.round((w - 1) * k / 31);
    const y = Math.round((h - 1) * k / 31);
    sample(x, 0); sample(x, h - 1); sample(0, y); sample(w - 1, y);
  }
  let members = [];
  for (const color of samples) {
    const near = samples.filter(other => other.every((value, k) => Math.abs(value - color[k]) < 25));
    if (near.length > members.length) members = near;
  }
  if (members.length < samples.length * 0.42) return null;
  const color = [0, 1, 2].map(k => members.map(c => c[k]).sort((a, b) => a - b)[members.length >> 1]);
  const variance = members.reduce((sum, c) => sum + Math.max(...c.map((v, k) => Math.abs(v - color[k]))), 0) / members.length;
  return { color, threshold: limit(23 + variance * 1.8, 25, 49) };
}

function cutMatte(raster, enabled) {
  const { w, h, data } = raster;
  const mask = new Uint8Array(w * h);
  let translucent = 0;
  let visible = 0;
  for (let i = 0; i < mask.length; ++i) {
    mask[i] = data[4 * i + 3] >= 64 ? 1 : 0;
    visible += mask[i];
    if (data[4 * i + 3] < 64) ++translucent;
  }
  if (!visible) throw new Error('這張圖片完全透明，請選擇含有可見主體的圖片。');
  if (!enabled || translucent > 0) return mask;

  const background = backgroundColor(raster);
  if (!background) return mask;
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  function enqueue(i) {
    if (!mask[i]) return;
    const j = 4 * i;
    for (let k = 0; k < 3; ++k)
      if (Math.abs(data[j + k] - background.color[k]) > background.threshold) return;
    mask[i] = 0;
    queue[tail++] = i;
  }
  for (let x = 0; x < w; ++x) { enqueue(x); enqueue(x + (h - 1) * w); }
  for (let y = 0; y < h; ++y) { enqueue(y * w); enqueue(y * w + w - 1); }
  while (head < tail) {
    const i = queue[head++], x = i % w;
    if (x) enqueue(i - 1);
    if (x + 1 < w) enqueue(i + 1);
    if (i >= w) enqueue(i - w);
    if (i + w < mask.length) enqueue(i + w);
  }
  if (tail === mask.length) {
    throw new Error('主體與背景顏色太接近。請關閉自動去背，或上傳透明背景的 PNG。');
  }
  return mask;
}

function maskBounds(mask, w, h) {
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let i = 0; i < mask.length; ++i) if (mask[i]) {
    const x = i % w, y = Math.floor(i / w);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { x0, y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// The continuous integral of the pixel-cell mask gives an antialiased contour,
// including when a rectangular source fills the whole image.
function makeCoverage(mask, w, h) {
  const stride = w + 1;
  const integral = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; ++y) {
    let row = 0;
    for (let x = 0; x < w; ++x) {
      row += mask[y * w + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  function area(x, y) {
    x = limit(x, 0, w); y = limit(y, 0, h);
    const ix = Math.min(w - 1, Math.floor(x)), iy = Math.min(h - 1, Math.floor(y));
    const fx = x - ix, fy = y - iy, p = iy * stride + ix;
    const top = integral[p] * (1 - fx) + integral[p + 1] * fx;
    const bottom = integral[p + stride] * (1 - fx) + integral[p + stride + 1] * fx;
    return top * (1 - fy) + bottom * fy;
  }
  return (x, y, dx, dy) => {
    const left = x - dx / 2, right = x + dx / 2, top = y - dy / 2, bottom = y + dy / 2;
    return (area(right, bottom) - area(left, bottom) - area(right, top) + area(left, top)) / (dx * dy);
  };
}

function makeSampler({ w, h, data }, mask) {
  // Propagate the closest foreground sample for UVs that fall just beyond an
  // antialiased cut edge. This prevents white or transparent outlines.
  const owner = new Int32Array(mask.length).fill(-1);
  const queue = new Int32Array(mask.length);
  let head = 0, tail = 0;
  for (let i = 0; i < mask.length; ++i) if (mask[i]) {
    owner[i] = i;
    queue[tail++] = i;
  }
  function visit(i, source) {
    if (owner[i] >= 0) return;
    owner[i] = source;
    queue[tail++] = i;
  }
  while (head < tail) {
    const i = queue[head++], source = owner[i], x = i % w;
    if (x) visit(i - 1, source);
    if (x + 1 < w) visit(i + 1, source);
    if (i >= w) visit(i - w, source);
    if (i + w < mask.length) visit(i + w, source);
  }
  const pixel = (x, y) => limit(y, 0, h - 1) * w + limit(x, 0, w - 1);
  function uv(x, y) {
    // Stay at least half a texel inside the source frame.
    x = limit(x, 0.5, w - 0.5); y = limit(y, 0.5, h - 0.5);
    const i = pixel(Math.floor(x), Math.floor(y));
    const ix = Math.floor(x - 0.5), iy = Math.floor(y - 0.5);
    if (!mask[pixel(ix, iy)] || !mask[pixel(ix + 1, iy)] ||
        !mask[pixel(ix, iy + 1)] || !mask[pixel(ix + 1, iy + 1)]) {
      const j = owner[i];
      x = j % w + 0.5; y = Math.floor(j / w) + 0.5;
    }
    return [x / w, 1 - y / h];
  }
  function light(x, y) {
    const i = owner[pixel(Math.floor(x), Math.floor(y))] * 4;
    return (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
  }
  return { uv, light };
}

function contourDistances(field, cols, rows, dx, dy) {
  const dist = new Float32Array(field.length);
  const diag = Math.hypot(dx, dy);
  for (let i = 0; i < field.length; ++i) {
    if (field[i] <= 0) continue;
    let best = Infinity;
    for (const [off, length] of [[-1, dx], [1, dx], [-cols, dy], [cols, dy]]) {
      if (field[i + off] <= 0) best = Math.min(best, length * field[i] / (field[i] - field[i + off]));
    }
    dist[i] = best;
  }
  for (let y = 1; y < rows - 1; ++y) for (let x = 1; x < cols - 1; ++x) {
    const i = y * cols + x;
    if (dist[i]) dist[i] = Math.min(dist[i], dist[i - 1] + dx, dist[i - cols] + dy,
      dist[i - cols - 1] + diag, dist[i - cols + 1] + diag);
  }
  let maximum = 0;
  for (let y = rows - 2; y >= 1; --y) for (let x = cols - 2; x >= 1; --x) {
    const i = y * cols + x;
    if (dist[i]) {
      dist[i] = Math.min(dist[i], dist[i + 1] + dx, dist[i + cols] + dy,
        dist[i + cols + 1] + diag, dist[i + cols - 1] + diag);
      maximum = Math.max(maximum, dist[i]);
    }
  }
  return { dist, maximum: Math.max(0.0001, maximum) };
}

function makeSurface(raster, mask, bounds, sampler, mode, depth, detail) {
  const { x0, y0, width, height } = bounds;
  const longest = Math.max(width, height), unit = 2 / longest;
  const nx = Math.max(2, Math.round(detail * width / longest));
  const ny = Math.max(2, Math.round(detail * height / longest));
  const dx = width / nx, dy = height / ny;
  // Two samples outside the crop protect the outermost edge of the grid.
  const cols = nx + 5, rows = ny + 5;
  const px = i => x0 + ((i % cols) - 2) * dx;
  const py = i => y0 + (Math.floor(i / cols) - 2) * dy;
  const coverage = makeCoverage(mask, raster.w, raster.h);
  const field = new Float32Array(cols * rows);
  for (let i = 0; i < field.length; ++i)
    field[i] = coverage(px(i), py(i), dx * 0.9, dy * 0.9) - 0.50001;
  const { dist, maximum } = contourDistances(field, cols, rows, dx, dy);
  const p = [], backZ = [], uv = [], idx = [], perimeter = [];
  const corners = new Int32Array(field.length).fill(-1), cuts = new Map();
  const lip = 0.003 + Math.min(0.012, Math.min(width, height) * unit * 0.012);
  const amplitude = Math.min(maximum * unit, 1) * depth;

  function add(x, y, distance) {
    let front, back;
    if (mode === 'relief') {
      const brightness = (4 * sampler.light(x, y) + sampler.light(x - dx / 3, y) +
        sampler.light(x + dx / 3, y) + sampler.light(x, y - dy / 3) + sampler.light(x, y + dy / 3)) / 8;
      front = 0.018 + depth * 0.6 * (brightness - 0.5);
      back = -0.018 - depth * 0.3;
    } else {
      const t = limit(distance / maximum, 0, 1);
      front = lip + amplitude * Math.sqrt(t * (2 - t));
      back = -front;
    }
    const k = backZ.length;
    p.push((x - x0 - width / 2) * unit, (y0 + height / 2 - y) * unit, front);
    backZ.push(back); uv.push(...sampler.uv(x, y));
    return k;
  }
  function corner(i) {
    if (corners[i] === -1) corners[i] = add(px(i), py(i), dist[i]);
    return corners[i];
  }
  function cut(a, b) {
    if (a > b) [a, b] = [b, a];
    const key = a * field.length + b;
    let k = cuts.get(key);
    if (k !== undefined) return k;
    const t = field[a] / (field[a] - field[b]);
    k = add(px(a) + (px(b) - px(a)) * t, py(a) + (py(b) - py(a)) * t, 0);
    cuts.set(key, k);
    return k;
  }
  function triangle(a, b, c) {
    const v = [a, b, c];
    const inside = v.filter(i => field[i] > 0).length;
    if (!inside) return;
    if (inside === 3) { idx.push(corner(a), corner(b), corner(c)); return; }
    const polygon = [], borders = [];
    for (let i = 0; i < 3; ++i) {
      const start = v[i], end = v[(i + 1) % 3];
      if (field[start] > 0) { polygon.push(corner(start)); borders.push(false); }
      if ((field[start] > 0) !== (field[end] > 0)) { polygon.push(cut(start, end)); borders.push(true); }
    }
    for (let i = 1; i + 1 < polygon.length; ++i) idx.push(polygon[0], polygon[i], polygon[i + 1]);
    for (let i = 0; i < polygon.length; ++i) {
      const j = (i + 1) % polygon.length;
      if (borders[i] && borders[j]) perimeter.push(polygon[i], polygon[j]);
    }
  }
  for (let y = 0; y + 1 < rows; ++y) for (let x = 0; x + 1 < cols; ++x) {
    const a = y * cols + x, b = a + 1, c = a + cols, d = c + 1;
    triangle(a, c, d); triangle(a, d, b);
  }
  if (!idx.length) throw new Error('圖片中的線條太細，請提高細緻度或放大主體。');
  const count = backZ.length, frontLength = idx.length;
  for (let i = 0; i < count; ++i) {
    p.push(p[i * 3], p[i * 3 + 1], backZ[i]);
    uv.push(uv[i * 2], uv[i * 2 + 1]);
  }
  for (let i = 0; i < frontLength; i += 3) idx.push(count + idx[i + 2], count + idx[i + 1], count + idx[i]);
  for (let i = 0; i < perimeter.length; i += 2) {
    const a = perimeter[i], b = perimeter[i + 1];
    idx.push(b, a, a + count, b, a + count, b + count);
  }
  return finish(p, idx, uv);
}

function makeLathe(raster, mask, bounds, sampler, depth, detail) {
  const { x0, y0, width, height } = bounds;
  if (width < 2 || height < 2) throw new Error('旋轉建模需要有寬度和高度的主體。');
  const profile = [];
  for (let y = y0; y < y0 + height; ++y) {
    let left = x0 + width, right = -1;
    for (let x = x0; x < x0 + width; ++x) if (mask[y * raster.w + x]) {
      left = Math.min(left, x); right = x;
    }
    if (right >= left) profile.push({ y: y + 0.5, center: (left + right + 1) / 2, radius: (right - left + 1) / 2 });
  }
  if (profile.length < 2) throw new Error('未能辨識垂直輪廓，請使用正面直立的物件照片。');
  const n = Math.max(4, Math.round(detail * height / Math.max(width, height)));
  const slices = limit(4 * Math.round(detail * 0.65 / 4), 24, 88);
  const p = [], uv = [], idx = [], unit = 2 / Math.max(width, height);
  const oval = 0.55 + 0.9 * depth;
  let j = 0;
  for (let i = 0; i <= n; ++i) {
    const y = y0 + height * i / n;
    while (j + 2 < profile.length && profile[j + 1].y < y) ++j;
    const a = profile[j], b = profile[j + 1];
    const t = limit((y - a.y) / (b.y - a.y), 0, 1);
    const radius = a.radius * (1 - t) + b.radius * t, center = a.center * (1 - t) + b.center * t;
    for (let k = 0; k < slices; ++k) {
      const angle = k * 2 * Math.PI / slices, horizontal = Math.sin(angle);
      p.push(radius * unit * horizontal, (y0 + height / 2 - y) * unit, radius * unit * Math.cos(angle) * oval);
      uv.push(...sampler.uv(center + horizontal * Math.max(0, radius - 0.5), limit(y, y0 + 0.5, y0 + height - 0.5)));
    }
    if (!i) continue;
    for (let k = 0; k < slices; ++k) {
      const next = (k + 1) % slices, a = (i - 1) * slices + k, b = (i - 1) * slices + next;
      idx.push(a, a + slices, b, b, a + slices, b + slices);
    }
  }
  for (const bottom of [false, true]) {
    const row = bottom ? n * slices : 0;
    const cap = p.length / 3, sample = bottom ? profile[profile.length - 1] : profile[0];
    p.push(0, (bottom ? -1 : 1) * height * unit / 2, 0);
    uv.push(...sampler.uv(sample.center, sample.y));
    for (let k = 0; k < slices; ++k) {
      const a = row + k, b = row + (k + 1) % slices;
      if (bottom) idx.push(cap, b, a); else idx.push(cap, a, b);
    }
  }
  return finish(p, idx, uv);
}

function finish(p, indices, uvs) {
  const normals = new Float32Array(p.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const x = p[b] - p[a], y = p[b + 1] - p[a + 1], z = p[b + 2] - p[a + 2];
    const dx = p[c] - p[a], dy = p[c + 1] - p[a + 1], dz = p[c + 2] - p[a + 2];
    const nx = y * dz - z * dy, ny = z * dx - x * dz, nz = x * dy - y * dx;
    for (const k of [a, b, c]) { normals[k] += nx; normals[k + 1] += ny; normals[k + 2] += nz; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= length; normals[i + 1] /= length; normals[i + 2] /= length;
  }
  return { positions: new Float32Array(p), indices: new Uint32Array(indices), uvs: new Float32Array(uvs), normals };
}

export function buildGeometry(imageData, { mode = 'inflate', depth = 0.55, detail = 64, background = true } = {}) {
  if (!['inflate', 'relief', 'lathe'].includes(mode)) throw new Error('請選擇有效的建模方式。');
  const raster = readRaster(imageData);
  const mask = cutMatte(raster, background === true || background === 'on');
  const bounds = maskBounds(mask, raster.w, raster.h);
  const sampler = makeSampler(raster, mask);
  const d = Number.isFinite(Number(depth)) ? limit(Number(depth), 0.1, 1) : 0.55;
  const n = Number.isFinite(Number(detail)) ? limit(Math.round(Number(detail)), 16, 128) : 64;
  return mode === 'lathe' ? makeLathe(raster, mask, bounds, sampler, d, n)
    : makeSurface(raster, mask, bounds, sampler, mode, d, n);
}

export function segmentImage(imageData, background = true) {
  const raster = readRaster(imageData);
  return {
    width: raster.w,
    height: raster.h,
    mask: cutMatte(raster, background === true || background === 'on')
  };
}

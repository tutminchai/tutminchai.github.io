// TripoSR uses a Z-up density grid; the viewer and exporters use Y-up.
const DOMAIN_RADIUS = 0.87;
const SURFACE_DENSITY = 25;
const TETRAHEDRA = [
  [0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7],
  [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7]
];

function gradientAt(field, i, size, stride, coordinate) {
  const previous = coordinate === 0 ? i : i - stride;
  const next = coordinate === size - 1 ? i : i + stride;
  // The occupied side of the surface has higher density.
  return (field[previous] - field[next]) / (previous === i || next === i ? 1 : 2);
}

function makeAtlas(vertices, triangles) {
  const count = triangles.length / 3;
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  // Each little square contains a triangle plus gutters with extended edge colour.
  const cell = columns > 380 ? 4 : 8;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1);
  canvas.width = columns * cell;
  canvas.height = rows * cell;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('無法建立模型的色彩貼圖。');
  const bitmap = context.createImageData(canvas.width, canvas.height);
  const positions = new Float32Array(triangles.length * 3);
  const normals = new Float32Array(positions.length);
  const indices = new Uint32Array(triangles.length);
  const uvs = new Float32Array(triangles.length * 2);
  const span = cell - 3;
  const weights = new Float32Array(cell * cell * 3);
  for (let py = 0; py < cell; py++) {
    for (let px = 0; px < cell; px++) {
      let b = Math.max(0, (px - 1) / span);
      let c = Math.max(0, (py - 1) / span);
      const sum = b + c;
      if (sum > 1) { b /= sum; c /= sum; }
      const k = (py * cell + px) * 3;
      weights[k] = 1 - b - c;
      weights[k + 1] = b;
      weights[k + 2] = c;
    }
  }
  // The atlas assigns UVs per face. Preserve the shared isosurface normals
  // when splitting the vertices at these UV seams.
  for (let face = 0; face < count; face++) {
    const x = (face % columns) * cell;
    const y = Math.floor(face / columns) * cell;
    const at = face * 3;
    const a = vertices[triangles[at]];
    const b = vertices[triangles[at + 1]];
    const c = vertices[triangles[at + 2]];
    for (let corner = 0; corner < 3; corner++) {
      const id = at + corner;
      const v = vertices[triangles[id]];
      indices[id] = id;
      positions.set(v.subarray(0, 3), id * 3);
      normals.set(v.subarray(3, 6), id * 3);
      uvs[id * 2] = (x + 1.5 + (corner === 1 ? span : 0)) / canvas.width;
      uvs[id * 2 + 1] = 1 - (y + 1.5 + (corner === 2 ? span : 0)) / canvas.height;
    }
    for (let py = 0; py < cell; py++) {
      let k = py * cell * 3;
      let offset = ((y + py) * canvas.width + x) * 4;
      for (let px = 0; px < cell; px++, offset += 4, k += 3) {
        const wa = weights[k], wb = weights[k + 1], wc = weights[k + 2];
        for (let channel = 0; channel < 3; channel++) {
          const j = 6 + channel;
          bitmap.data[offset + channel] = 255 * (wa * a[j] + wb * b[j] + wc * c[j]);
        }
        bitmap.data[offset + 3] = 255;
      }
    }
  }
  context.putImageData(bitmap, 0, 0);
  return { positions, normals, indices, uvs, textureCanvas: canvas };
}

export function meshFromField(density, colors, resolution) {
  const n = resolution;
  const plane = n * n;
  const total = plane * n;
  if (!Number.isInteger(n) || n < 2 || density.length !== total || colors.length !== total * 3) {
    throw new Error('AI 輸出的密度或色彩資料不完整。');
  }
  // Log density gives better numerical stability when interpolating this model's
  // exponential activation and shares exactly the same isosurface at the threshold.
  const field = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    if (Number.isNaN(density[i])) throw new Error('AI 推估時產生無效數值，請換一張主體清楚的圖重試。');
    field[i] = Math.log1p(Math.min(1e12, Math.max(0, density[i])));
  }
  const iso = Math.log1p(SURFACE_DENSITY);
  const normals = new Float32Array(total * 3);
  for (let i = 0; i < total; i++) {
    normals[i * 3] = gradientAt(field, i, n, 1, i % n);
    normals[i * 3 + 1] = gradientAt(field, i, n, n, Math.floor(i / n) % n);
    normals[i * 3 + 2] = gradientAt(field, i, n, plane, Math.floor(i / plane));
  }
  const vertices = [];
  const triangles = [];
  const edgeCache = new Map();
  const cube = new Int32Array(8);
  const offsets = [0, 1, n, n + 1, plane, plane + 1, plane + n, plane + n + 1];
  const step = 2 * DOMAIN_RADIUS / (n - 1);

  function edgePoint(a, b) {
    const key = Math.min(a, b) * total + Math.max(a, b);
    const cached = edgeCache.get(key);
    if (cached !== undefined) return cached;
    const t = Math.max(0, Math.min(1, (iso - field[a]) / (field[b] - field[a])));
    const u = 1 - t;
    const ax = a % n, ay = Math.floor(a / n) % n, az = Math.floor(a / plane);
    const bx = b % n, by = Math.floor(b / n) % n, bz = Math.floor(b / plane);
    const x = (ax * u + bx * t) * step - DOMAIN_RADIUS;
    const y = (ay * u + by * t) * step - DOMAIN_RADIUS;
    const z = (az * u + bz * t) * step - DOMAIN_RADIUS;
    const ga = a * 3, gb = b * 3;
    let nx = normals[ga] * u + normals[gb] * t;
    let ny = normals[ga + 1] * u + normals[gb + 1] * t;
    let nz = normals[ga + 2] * u + normals[gb + 2] * t;
    let length = Math.hypot(nx, ny, nz);
    if (length < 1e-9) {
      const sign = field[a] >= iso ? 1 : -1;
      nx = (bx - ax) * sign;
      ny = (by - ay) * sign;
      nz = (bz - az) * sign;
      length = Math.hypot(nx, ny, nz);
    }
    const vertex = new Float32Array(9);
    vertex.set([-y, z, -x, -ny / length, nz / length, -nx / length]);
    for (let channel = 0; channel < 3; channel++) {
      vertex[6 + channel] = colors[ga + channel] * u + colors[gb + channel] * t;
    }
    const index = vertices.length;
    vertices.push(vertex);
    edgeCache.set(key, index);
    return index;
  }

  function emit(ai, bi, ci, direction) {
    const a = vertices[ai], b = vertices[bi], c = vertices[ci];
    const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
    const cx = c[0] - a[0], cy = c[1] - a[1], cz = c[2] - a[2];
    const nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
    if (nx * nx + ny * ny + nz * nz < 1e-24) return;
    // Orient using an occupied-to-empty tetrahedral edge. Unlike smoothed
    // normals, this determines the correct side even at a saddle point.
    if (nx * direction[0] + ny * direction[1] + nz * direction[2] >= 0) triangles.push(ai, bi, ci);
    else triangles.push(ai, ci, bi);
  }

  const inside = new Int32Array(4), outside = new Int32Array(4);
  const direction = new Float32Array(3);
  for (let z = 0; z < n - 1; z++) {
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const base = x + y * n + z * plane;
        let filled = 0;
        for (let j = 0; j < 8; j++) {
          cube[j] = base + offsets[j];
          if (field[cube[j]] >= iso) filled++;
        }
        if (filled === 0 || filled === 8) continue;
        for (const tetra of TETRAHEDRA) {
          let high = 0, low = 0;
          for (const corner of tetra) {
            const id = cube[corner];
            if (field[id] >= iso) inside[high++] = id;
            else outside[low++] = id;
          }
          if (!high || !low) continue;
          const i = inside[0], o = outside[0];
          direction[0] = Math.floor(i / n) % n - Math.floor(o / n) % n;
          direction[1] = Math.floor(o / plane) - Math.floor(i / plane);
          direction[2] = i % n - o % n;
          const a = edgePoint(i, o);
          if (high === 2) {
            const b = edgePoint(i, outside[1]);
            const c = edgePoint(inside[1], outside[1]);
            const d = edgePoint(inside[1], o);
            emit(a, b, c, direction);
            emit(a, c, d, direction);
          } else if (high === 1) {
            emit(a, edgePoint(i, outside[1]), edgePoint(i, outside[2]), direction);
          } else {
            emit(a, edgePoint(inside[1], o), edgePoint(inside[2], o), direction);
          }
        }
      }
    }
  }
  if (!triangles.length) throw new Error('AI 沒有辨識出立體表面。請使用完整、置中且背景單純的物件圖片再試一次。');
  return makeAtlas(vertices, triangles);
}

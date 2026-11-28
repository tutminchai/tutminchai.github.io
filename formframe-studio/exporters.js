import { writeFBX } from './fbx.js';

const encoder = new TextEncoder();
const signature = [137, 80, 78, 71, 13, 10, 26, 10];

function validate(model) {
  const { positions, normals, uvs, indices, texture } = model;
  const count = positions?.length / 3;
  if (!Number.isInteger(count) || count < 3 || normals?.length !== count * 3 ||
      uvs?.length !== count * 2 || !indices?.length || indices.length % 3 !== 0) {
    throw new Error('模型的頂點、法線、UV 或三角面資料不完整。');
  }
  for (const values of [positions, normals, uvs]) {
    for (const value of values) {
      if (!Number.isFinite(value)) throw new Error('模型座標含有無效數值。');
    }
  }
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('模型含有無效的頂點索引。');
  }
  if (!texture || signature.some((value, index) => texture[index] !== value)) {
    throw new Error('模型的 PNG 貼圖無法讀取。');
  }
}

function bufferView(size) {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
  return value >>> 0;
});

function crc32(data) {
  let result = 0xffffffff;
  for (const byte of data) result = crcTable[(result ^ byte) & 0xff] ^ (result >>> 8);
  return (result ^ 0xffffffff) >>> 0;
}

// USDZ uses stored ZIP entries with the start of each file's payload aligned to 64 bytes.
function zipFiles(entries, align, type) {
  const parts = [], directory = [];
  let offset = 0, directorySize = 0;
  for (const [filename, data] of entries) {
    const name = encoder.encode(filename);
    const size = data.byteLength;
    let padding = align ? (64 - ((offset + 30 + name.length) % 64)) % 64 : 0;
    if (padding && padding < 4) padding += 64;
    const local = bufferView(30 + name.length + padding);
    const record = bufferView(46 + name.length);
    local.view.setUint32(0, 0x04034b50, true);
    record.view.setUint32(0, 0x02014b50, true);
    record.view.setUint16(4, 20, true);
    const crc = crc32(data);
    for (const [target, shift] of [[local, 0], [record, 2]]) {
      target.view.setUint16(4 + shift, 20, true);
      target.view.setUint16(12 + shift, 33, true); // DOS date, January 1, 1980.
      target.view.setUint32(14 + shift, crc, true);
      target.view.setUint32(18 + shift, size, true);
      target.view.setUint32(22 + shift, size, true);
      target.view.setUint16(26 + shift, name.length, true);
    }
    local.bytes.set(name, 30);
    if (padding) {
      local.view.setUint16(28, padding, true);
      local.view.setUint16(30 + name.length, 0x1986, true);
      local.view.setUint16(32 + name.length, padding - 4, true);
    }
    record.view.setUint32(42, offset, true);
    record.bytes.set(name, 46);
    parts.push(local.bytes, data);
    directory.push(record.bytes);
    offset += local.bytes.length + size;
    directorySize += record.bytes.length;
  }
  const end = bufferView(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, directorySize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end.bytes], { type });
}

function formatValue(value) {
  return String(Number(value.toPrecision(8)));
}

function vectorRows(data, width, format) {
  const rows = new Array(data.length / width);
  for (let i = 0; i < data.length; i += width) {
    const values = [];
    for (let j = 0; j < width; j++) values.push(formatValue(data[i + j]));
    rows[i / width] = format(values);
  }
  return rows;
}

function objPackage({ positions, normals, uvs, indices, texture }) {
  const lines = ['# FormFrame Studio', 'mtllib model.mtl', 'o Model'];
  const vertices = vectorRows(positions, 3, row => 'v ' + row.join(' '));
  const coords = vectorRows(uvs, 2, row => 'vt ' + row.join(' '));
  const directions = vectorRows(normals, 3, row => 'vn ' + row.join(' '));
  const faces = new Array(indices.length / 3);
  for (let i = 0; i < indices.length; i += 3) {
    const corners = [];
    for (let j = 0; j < 3; j++) {
      const index = indices[i + j] + 1;
      corners.push(index + '/' + index + '/' + index);
    }
    faces[i / 3] = 'f ' + corners.join(' ');
  }
  const geometry = [lines.join('\n'), vertices.join('\n'), coords.join('\n'), directions.join('\n'), 'usemtl Surface', faces.join('\n'), ''].join('\n');
  const material = 'newmtl Surface\nKd 1 1 1\nKs 0 0 0\nNs 8\nd 1\nillum 2\nmap_Kd texture.png\n';
  return zipFiles([['model.obj', encoder.encode(geometry)], ['model.mtl', encoder.encode(material)], ['texture.png', texture]], false, 'application/zip');
}

function getBounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      min[j] = Math.min(min[j], positions[i + j]);
      max[j] = Math.max(max[j], positions[i + j]);
    }
  }
  return { min, max };
}

function writeGLB({ positions, normals, uvs, indices, texture }) {
  const targetUV = new Float32Array(uvs);
  for (let i = 1; i < uvs.length; i += 2) targetUV[i] = 1 - uvs[i];
  const arrays = [new Float32Array(positions), new Float32Array(normals), targetUV, new Uint32Array(indices), texture];
  let length = 0;
  const targets = [34962, 34962, 34962, 34963];
  const bufferViews = arrays.map((array, i) => {
    const entry = { buffer: 0, byteOffset: length, byteLength: array.byteLength };
    if (i < targets.length) entry.target = targets[i];
    length += (array.byteLength + 3) & ~3;
    return entry;
  });
  const vertices = positions.length / 3;
  const doc = {
    asset: { version: '2.0', generator: 'FormFrame Studio' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ name: 'Model', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: 'Surface', doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, roughnessFactor: 0.86, metallicFactor: 0 } }],
    samplers: [{ wrapS: 33071, wrapT: 33071, magFilter: 9729, minFilter: 9729 }],
    textures: [{ source: 0, sampler: 0 }], images: [{ name: 'texture', mimeType: 'image/png', bufferView: 4 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertices, type: 'VEC3', ...getBounds(positions) },
      { bufferView: 1, componentType: 5126, count: vertices, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: vertices, type: 'VEC2' },
      { bufferView: 3, componentType: 5125, count: indices.length, type: 'SCALAR' }
    ],
    buffers: [{ byteLength: length }], bufferViews
  };
  const json = encoder.encode(JSON.stringify(doc));
  const jsonLength = (json.length + 3) & ~3;
  const header = bufferView(20);
  header.view.setUint32(0, 0x46546c67, true);
  header.view.setUint32(4, 2, true);
  header.view.setUint32(8, 28 + jsonLength + length, true);
  header.view.setUint32(12, jsonLength, true);
  header.view.setUint32(16, 0x4e4f534a, true);
  const binaryHeader = bufferView(8);
  binaryHeader.view.setUint32(0, length, true);
  binaryHeader.view.setUint32(4, 0x004e4942, true);
  const parts = [header.bytes, json, new Uint8Array(jsonLength - json.length).fill(32), binaryHeader.bytes];
  for (const array of arrays) parts.push(array, new Uint8Array((4 - (array.byteLength % 4)) % 4));
  return new Blob(parts, { type: 'model/gltf-binary' });
}

function writeUSDZ({ positions, normals, uvs, indices, texture }) {
  const tuples = (data, width) => vectorRows(data, width, row => '(' + row.join(', ') + ')').join(', ');
  const bounds = getBounds(positions);
  const stage = `#usda 1.0
(
    defaultPrim = "Model"
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "Model" (
    kind = "component"
)
{
    def Mesh "Geometry" (
        prepend apiSchemas = ["MaterialBindingAPI"]
    )
    {
        uniform token subdivisionScheme = "none"
        uniform token orientation = "rightHanded"
        uniform bool doubleSided = true
        float3[] extent = [(${bounds.min.map(formatValue).join(', ')}), (${bounds.max.map(formatValue).join(', ')})]
        point3f[] points = [${tuples(positions, 3)}]
        int[] faceVertexCounts = [${new Array(indices.length / 3).fill(3).join(', ')}]
        int[] faceVertexIndices = [${indices.join(', ')}]
        normal3f[] normals = [${tuples(normals, 3)}] (
            interpolation = "vertex"
        )
        texCoord2f[] primvars:st = [${tuples(uvs, 2)}] (
            interpolation = "vertex"
        )
        rel material:binding = </Model/Surface>
    }

    def Material "Surface"
    {
        token outputs:surface.connect = </Model/Surface/PBR.outputs:surface>
        def Shader "PBR"
        {
            uniform token info:id = "UsdPreviewSurface"
            color3f inputs:diffuseColor.connect = </Model/Surface/Color.outputs:rgb>
            float inputs:roughness = 0.86
            float inputs:metallic = 0
            token outputs:surface
        }
        def Shader "Color"
        {
            uniform token info:id = "UsdUVTexture"
            asset inputs:file = @texture.png@
            float2 inputs:st.connect = </Model/Surface/UV.outputs:result>
            token inputs:sourceColorSpace = "sRGB"
            token inputs:wrapS = "clamp"
            token inputs:wrapT = "clamp"
            float3 outputs:rgb
        }
        def Shader "UV"
        {
            uniform token info:id = "UsdPrimvarReader_float2"
            string inputs:varname = "st"
            float2 outputs:result
        }
    }
}
`;
  return zipFiles([['model.usda', encoder.encode(stage)], ['texture.png', texture]], true, 'model/vnd.usdz+zip');
}

export async function exportModel(model, format) {
  validate(model);
  switch (String(format).toLowerCase()) {
    case 'obj': return objPackage(model);
    case 'glb': return writeGLB(model);
    case 'usdz': return writeUSDZ(model);
    case 'fbx': {
      const output = writeFBX(model);
      return output instanceof Blob ? output : new Blob([output], { type: 'application/octet-stream' });
    }
    default: throw new Error('請選擇 OBJ、FBX、GLB 或 USDZ 格式。');
  }
}

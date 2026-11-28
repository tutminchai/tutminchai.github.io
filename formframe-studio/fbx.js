// Binary FBX 7.4 stores absolute end offsets in every node header. Build small
// header blocks first and keep geometry arrays as separate parts of the Blob.
const encoder = new TextEncoder();
const version = 7400;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const string = value => ['S', encoder.encode(value)];
const integer = value => ['I', value];
const double = value => ['D', value];
const id = value => ['L', value];
const integerArray = values => ['i', values];
const doubleArray = values => ['d', values];
const raw = values => ['R', values];
const record = (name, properties = [], children = []) => ({name, properties, children});
const field = (name, property) => record(name, [property]);
const fields = (name, children) => record(name, [], children);
const setting = (name, type, values, label = '', flags = '') =>
  record('P', [string(name), string(type), string(label), string(flags), ...values]);
const qualified = (name, kind) => string(name + '\x00\x01' + kind);

function binaryFile(nodes) {
  const parts = [];
  let length = 0;
  function append(bytes) {
    parts.push(bytes);
    length += bytes.byteLength;
  }
  function u32(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    append(bytes);
  }
  function property([type, value]) {
    append(Uint8Array.of(type.charCodeAt(0)));
    if (type === 'S' || type === 'R') {
      u32(value.byteLength);
      append(value);
      return;
    }
    if (type === 'i' || type === 'd') {
      const width = type === 'i' ? 4 : 8;
      u32(value.length);
      u32(0); // uncompressed
      u32(value.length * width);
      const ArrayType = type === 'i' ? Int32Array : Float64Array;
      const array = value instanceof ArrayType ? value : new ArrayType(value);
      if (littleEndian) {
        append(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
      } else {
        const bytes = new Uint8Array(array.byteLength);
        const view = new DataView(bytes.buffer);
        const write = type === 'i' ? 'setInt32' : 'setFloat64';
        array.forEach((number, i) => view[write](i * width, number, true));
        append(bytes);
      }
      return;
    }
    const bytes = new Uint8Array(type === 'I' ? 4 : 8);
    const view = new DataView(bytes.buffer);
    if (type === 'L') view.setBigInt64(0, BigInt(value), true);
    if (type === 'D') view.setFloat64(0, value, true);
    if (type === 'I') view.setInt32(0, value, true);
    append(bytes);
  }
  function writeNode(node) {
    const name = encoder.encode(node.name);
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    header[12] = name.length;
    view.setUint32(4, node.properties.length, true);
    append(header);
    append(name);
    const start = length;
    node.properties.forEach(property);
    view.setUint32(8, length - start, true);
    if (node.children.length) {
      node.children.forEach(writeNode);
      append(new Uint8Array(13));
    }
    if (length > 0xffffffff) throw new Error('模型超過 FBX 7.4 的檔案容量。');
    view.setUint32(0, length, true);
  }

  append(encoder.encode('Kaydara FBX Binary  \x00\x1a\x00'));
  u32(version);
  nodes.forEach(writeNode);
  append(new Uint8Array(13));
  append(Uint8Array.of(0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e));
  u32(0);
  append(new Uint8Array(16 - length % 16));
  u32(version);
  append(new Uint8Array(120));
  append(Uint8Array.of(0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b));
  return new Blob(parts, {type: 'application/octet-stream'});
}

function geometry(model) {
  const triangleIndices = new Int32Array(model.indices);
  const polygonEnds = new Int32Array(triangleIndices);
  // FBX signals the final control point of each polygon with its bitwise NOT.
  for (let i = 2; i < polygonEnds.length; i += 3) polygonEnds[i] = ~polygonEnds[i];
  function layer(type, name, mapping, reference, data) {
    return record(type, [integer(0)], [
      field('Version', integer(101)), field('Name', string(name)),
      field('MappingInformationType', string(mapping)), field('ReferenceInformationType', string(reference)),
      ...data
    ]);
  }
  const layerTypes = ['LayerElementNormal', 'LayerElementUV', 'LayerElementMaterial'];
  return record('Geometry', [id(1001), qualified('ModelMesh', 'Geometry'), string('Mesh')], [
    field('GeometryVersion', integer(124)),
    field('Vertices', doubleArray(model.positions)),
    field('PolygonVertexIndex', integerArray(polygonEnds)),
    layer(layerTypes[0], '', 'ByPolygonVertex', 'IndexToDirect', [
      field('Normals', doubleArray(model.normals)), field('NormalsIndex', integerArray(triangleIndices))
    ]),
    layer(layerTypes[1], 'UVMap', 'ByPolygonVertex', 'IndexToDirect', [
      field('UV', doubleArray(model.uvs)), field('UVIndex', integerArray(triangleIndices))
    ]),
    layer(layerTypes[2], '', 'AllSame', 'IndexToDirect', [field('Materials', integerArray([0]))]),
    record('Layer', [integer(0)], [
      field('Version', integer(100)),
      ...layerTypes.map(type => fields('LayerElement', [field('Type', string(type)), field('TypedIndex', integer(0))]))
    ])
  ]);
}

export function writeFBX(model) {
  const imageName = 'model.png';
  const creator = string('Formframe Studio');
  const xyz = (x, y, z) => [double(x), double(y), double(z)];
  const node = record('Model', [id(1002), qualified('Model', 'Model'), string('Mesh')], [
    field('Version', integer(232)), fields('Properties70', [
      setting('Lcl Translation', 'Lcl Translation', xyz(0, 0, 0), '', 'A'),
      setting('Lcl Rotation', 'Lcl Rotation', xyz(0, 0, 0), '', 'A'),
      setting('Lcl Scaling', 'Lcl Scaling', xyz(1, 1, 1), '', 'A'),
      setting('InheritType', 'enum', [integer(1)])
    ]), field('Culling', string('CullingOff'))
  ]);
  const material = record('Material', [id(1003), qualified('ImageMaterial', 'Material'), string('')], [
    field('Version', integer(102)), field('ShadingModel', string('phong')), field('MultiLayer', integer(0)),
    fields('Properties70', [
      setting('DiffuseColor', 'Color', xyz(1, 1, 1), '', 'A'),
      setting('DiffuseFactor', 'Number', [double(1)], '', 'A'),
      setting('SpecularColor', 'Color', xyz(0.1, 0.1, 0.1), '', 'A')
    ])
  ]);
  const texture = record('Texture', [id(1004), qualified('Color', 'Texture'), string('')], [
    field('Type', string('TextureVideoClip')), field('Version', integer(202)),
    field('TextureName', qualified('Color', 'Texture')), field('Media', qualified(imageName, 'Video')),
    field('FileName', string(imageName)), field('RelativeFilename', string(imageName)),
    fields('Properties70', [setting('UVSet', 'KString', [string('UVMap')]),
      setting('WrapModeU', 'enum', [integer(1)]), setting('WrapModeV', 'enum', [integer(1)])])
  ]);
  const video = record('Video', [id(1005), qualified(imageName, 'Video'), string('Clip')], [
    field('Type', string('Clip')), fields('Properties70', [setting('Path', 'KString', [string(imageName)], 'XRefUrl')]),
    field('UseMipMap', integer(0)),
    field('Filename', string(imageName)), field('RelativeFilename', string(imageName)),
    field('Content', raw(model.texture))
  ]);
  const axisSettings = {UpAxis: 1, UpAxisSign: 1, FrontAxis: 2, FrontAxisSign: 1, CoordAxis: 0, CoordAxisSign: 1};
  const objectTypes = ['Geometry', 'Model', 'Material', 'Texture', 'Video'];
  const objectConnection = (child, parent) => record('C', [string('OO'), id(child), id(parent)]);
  return binaryFile([
    fields('FBXHeaderExtension', [
      field('FBXHeaderVersion', integer(1003)), field('FBXVersion', integer(version)), field('EncryptionType', integer(0)),
      fields('CreationTimeStamp', Object.entries({Version:1000, Year:1970, Month:1, Day:1, Hour:10, Minute:0, Second:0, Millisecond:0})
        .map(([key, value]) => field(key, integer(value)))), field('Creator', creator)
    ]),
    field('FileId', raw(Uint8Array.of(0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1))),
    field('CreationTime', string('1970-01-01 10:00:00:000')), field('Creator', creator),
    fields('GlobalSettings', [field('Version', integer(1000)), fields('Properties70', [
      ...Object.entries(axisSettings).map(([key, value]) => setting(key, 'int', [integer(value)], 'Integer')),
      setting('UnitScaleFactor', 'double', [double(100)], 'Number'),
      setting('OriginalUnitScaleFactor', 'double', [double(100)], 'Number')
    ])]),
    fields('Documents', [field('Count', integer(1)), record('Document', [id(1000), string('Scene'), string('Scene')], [field('RootNode', id(0))])]),
    fields('Definitions', [field('Version', integer(100)), field('Count', integer(objectTypes.length)),
      ...objectTypes.map(type => record('ObjectType', [string(type)], [field('Count', integer(1))]))]),
    fields('Objects', [geometry(model), node, material, texture, video]),
    fields('Connections', [objectConnection(1002, 0), objectConnection(1001, 1002), objectConnection(1003, 1002),
      record('C', [string('OP'), id(1004), id(1003), string('DiffuseColor')]), objectConnection(1005, 1004)])
  ]);
}

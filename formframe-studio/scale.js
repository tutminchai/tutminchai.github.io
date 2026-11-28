// GLB and USD use metres; FBX declares metres. OBJ stores the same coordinates.
export function withExportHeight(mesh, heightCm) {
  if (!Number.isFinite(heightCm) || heightCm < 0.1 || heightCm > 10000) {
    throw new Error('請輸入 0.1 到 10,000 公分之間的匯出高度。');
  }
  const raw=mesh.positions;
  let bottom=Infinity, top=-Infinity;
  for(let i=1;i<raw.length;i+=3) {bottom=Math.min(bottom,raw[i]); top=Math.max(top,raw[i]);}
  if(!(top>bottom)) throw new Error('無法計算模型的垂直高度。');
  const scale=(heightCm/100)/(top-bottom), positions=new Float32Array(raw.length);
  for(let i=0;i<raw.length;i+=3) {
    positions[i]=raw[i]*scale; positions[i+1]=(raw[i+1]-bottom)*scale; positions[i+2]=raw[i+2]*scale;
  }
  return {...mesh,positions};
}

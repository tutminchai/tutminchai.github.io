import {createViewer} from './viewer.js';
import {isHeicFile, decodeHeic} from './heic.js';
import {buildGeometry} from './geometry.js';
import {exportModel} from './exporters.js';
import {withExportHeight} from './scale.js';
import {buildAI} from './ai.js';

const sampleURL = './sample.png';
const $ = id => document.getElementById(id);
const paths = {
  upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  download:'<path d="M12 3v13m-5-5 5 5 5-5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.7 8.7a2.45 2.45 0 1 1 3.8 2.3c-.95.6-1.5 1-1.5 2.5m0 3h.02"/>',
  image:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.25"/><path d="m3 17 5-5 3 3 4-5 6 7"/>',
  sliders:'<path d="M3 7h7m4 0h7M3 17h11m4 0h3"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>',
  cube:'<path d="m12 2 9 5v10l-9 5-9-5V7Zm0 10L3 7m9 5 9-5m-9 5v10"/>',
  mesh:'<path d="m12 2 9 5v10l-9 5-9-5V7Zm0 10L3 7m9 5 9-5m-9 5v10M3 17l9-15 9 15Z"/>',
  orbit:'<ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(-27 12 12)"/><path d="M6 8a7.2 7.2 0 0 1 13 4M5 12a7.2 7.2 0 0 0 13 4"/>',
  reset:'<path d="M4 10a8 8 0 1 1 .9 6M4 4v6h6"/>',
  chevron:'<path d="m7 10 5 5 5-5"/>'
};
document.querySelectorAll('[data-icon]').forEach(el => {
  el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (paths[el.dataset.icon] || '') + '</svg>';
});
const notes = {
  ai:'TripoSR 會推估側面與背面。需使用 WebGPU，首次下載約 515 MB，圖片留在裝置內。',
  lathe:'沿垂直軸旋轉物件輪廓，適合直立、左右對稱的瓶罐。背面沿用正面色彩。',
  inflate:'將剪影向前後撐起，保留原圖色彩。適合透明背景的角色插畫、貼紙與圖示。',
  relief:'依照影像明暗建立起伏，亮處凸起、暗處下沉，背面為平面。'
};
const formats = {
  glb:'網頁與 WebAR 常用格式，模型與貼圖包含在同一個 GLB 檔。',
  obj:'下載 ZIP，內含 OBJ 網格、MTL 材質與 PNG 貼圖。解壓縮後請將三者放在同一個資料夾。',
  fbx:'下載含有材質與內嵌貼圖的二進位 FBX，可匯入 Unity 或 3D 編輯軟體。',
  usdz:'模型與貼圖包含在同一個 USDZ 檔，可用於 Apple 裝置的 AR 預覽。'
};
const names = {lathe:'旋轉成形',inflate:'輪廓膨形',relief:'影像浮雕',ai:'AI 重建'};
let source = null, model = null, viewer = null, format = 'glb', controller = null;
let loading = false, exporting = false, sequence = 0, explicitMode=false;
const select = $('mode');
function message(id, text='', kind='') {
  const el=$(id); el.textContent=text; el.className='task-msg' + (kind ? ' '+kind : '');
}
function PNG(canvas) {
  return new Promise((resolve,reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('瀏覽器無法建立貼圖。')), 'image/png'));
}
function toCanvas(image, maxEdge) {
  const w=image.naturalWidth || image.width, h=image.naturalHeight || image.height;
  const scale=Math.min(1, maxEdge/Math.max(w,h));
  const c=document.createElement('canvas'); c.width=Math.max(1,Math.round(w*scale)); c.height=Math.max(1,Math.round(h*scale));
  const ctx=c.getContext('2d',{willReadFrequently:true});
  if(!ctx) throw new Error('瀏覽器無法建立圖片畫布。');
  ctx.imageSmoothingQuality='high'; ctx.drawImage(image,0,0,c.width,c.height);
  return c;
}
function flags() {
  const busy=!!controller || loading || exporting;
  for(const id of ['drop','example','mode','depth','quality','background','input-file']) $(id).disabled=busy;
  $('generate').disabled=busy || !source; $('download').disabled=busy || !model;
  for(const id of ['rotate','wire','reset']) $(id).disabled=!model;
  $('model-height').disabled=exporting; document.querySelectorAll('[data-format]').forEach(el => {el.disabled=exporting;});
  $('cancel').hidden=!(controller && select.value==='ai');
  $('genlabel').textContent=controller?'建模中…':'建立 3D 模型';
}
function invalidate(label='請重新建立模型') {
  model=null; viewer?.setModel(null,null); $('empty-label').textContent=label; $('empty').hidden=false;
  $('stage-name').textContent=source?.base || '模型預覽'; $('counter').textContent=''; $('stagehelp').hidden=true;
  message('export-msg'); message('task-msg'); flags();
}
function updateNotes() {
  $('mode-note').textContent=notes[select.value]; const ai=select.value==='ai';
  $('depth-row').hidden=ai; $('detail-row').hidden=ai;
  $('depthout').textContent=$('depth').value+'%'; $('qualityout').textContent=$('quality').value;
}
function setFormat(value) {
  format=value; document.querySelectorAll('[data-format]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.format===value)));
  $('format-desc').textContent=formats[value]; $('extension').textContent=value.toUpperCase(); message('export-msg');
}
function loadImage(url) {
  return new Promise((resolve,reject)=>{const image=new Image(); image.onload=()=>resolve(image); image.onerror=()=>reject(new Error('無法讀取圖片，請檢查檔案後重新上傳。')); image.src=url;});
}
async function read(file=null) {
  if(controller || exporting) return;
  const ticket=++sequence, example=!file; let url=null, thumb=null, img=null;
  const priorMode=select.value;
  loading=true; flags(); message('task-msg');
  try {
    if(file && (!file.size || file.size>20*1024*1024)) throw new Error('請使用 20 MB 以內且內容完整的圖片。');
    const heic=file && await isHeicFile(file);
    if(file && !heic && !(/^image\/(png|jpeg|webp)$/i.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name))) {
      throw new Error('請選擇 PNG、JPG、WebP 或 HEIC／HEIF 圖片。');
    }
    url=file?URL.createObjectURL(file):sampleURL;
    try { img=await loadImage(url); }
    catch(error) {
      if(!heic) throw error;
      message('task-msg','正在裝置上解碼 HEIC 照片…');
      img=await decodeHeic(file,loadImage);
    }
    const width=img.naturalWidth || img.width, height=img.naturalHeight || img.height;
    if(width*height>65000000) throw new Error('圖片超過 6,500 萬像素，請縮小後再上傳。');
    const texture=toCanvas(img,2048), small=toCanvas(texture,512);
    const raster=small.getContext('2d').getImageData(0,0,small.width,small.height);
    const textureBlob=await PNG(texture); thumb=URL.createObjectURL(textureBlob);
    if(ticket!==sequence) return;
    if(source?.thumb) URL.revokeObjectURL(source.thumb);
    const prevWasExample=source?.example;
    const name=file?.name || '陶瓶範例.png', base=name.replace(/\.[^/.]+$/,'') || '模型';
    source={name,base,thumb,texture,textureBlob,raster,example}; thumb=null;
    $('thumb').src=source.thumb; $('filename').textContent=name; $('filename').title=name;
    $('filemeta').textContent=width+' × '+height+' px';
    if(example) {
      explicitMode=false; select.value='lathe'; $('depth').value='50'; $('quality').value='80'; $('background').checked=true;
    } else if(prevWasExample && !explicitMode && priorMode==='lathe') {
      select.value=(window.isSecureContext && navigator.gpu)?'ai':'inflate';
    }
    updateNotes(); invalidate('按「建立 3D 模型」開始');
  } catch(e) {
    if(ticket===sequence) message('task-msg',e.message,'error'); return;
  } finally {
    if(typeof img?.close==='function') img.close();
    if(file && url) URL.revokeObjectURL(url); if(thumb) URL.revokeObjectURL(thumb);
    if(ticket===sequence) {loading=false; flags();}
  }
  if(example && ticket===sequence) await generate(true);
}
async function generate(initial=false) {
  if(!source || controller || loading || exporting) return;
  const job=new AbortController(); controller=job;
  invalidate('正在建立模型…'); message('task-msg','正在準備圖片…'); flags();
  const ai=select.value==='ai', start=performance.now();
  $('progress').hidden=!ai; $('progress').value=0;
  try {
    await new Promise(resolve=>setTimeout(resolve,25));
    let result;
    if(ai) {
      result=await buildAI(source.raster,{background:$('background').checked,signal:job.signal,onProgress:(msg,f)=>{
        if(!job.signal.aborted){ message('task-msg',msg); $('progress').value=f; }
      }});
    } else {
      result=buildGeometry(source.raster,{mode:select.value,depth:Number($('depth').value)/100,detail:Number($('quality').value),background:$('background').checked});
    }
    const textureCanvas=result.textureCanvas || source.texture;
    result.texture=new Uint8Array(await (result.textureCanvas?await PNG(textureCanvas):source.textureBlob).arrayBuffer());
    if(job.signal.aborted) throw new DOMException('已取消','AbortError');
    model=result; let previewError=false;
    try { if(viewer) viewer.setModel(result,textureCanvas); else previewError=true; }
    catch(e) { previewError=true; }
    $('empty').hidden=!previewError; $('empty-label').textContent='此裝置無法預覽，仍可下載模型';
    $('stagehelp').hidden=previewError; $('stage-name').textContent=source.base+' · '+names[select.value];
    $('counter').textContent=(model.indices.length/3).toLocaleString('zh-TW')+' 個三角面';
    message('task-msg',initial?'':('模型已建立，可預覽或下載。'+(ai?' 耗時 '+Math.round((performance.now()-start)/1000)+' 秒。':'')),'good');
  } catch(e) {
    const canceled=job.signal.aborted || e.name==='AbortError';
    invalidate(canceled?'已取消建模':'尚未產生模型');
    const msg=canceled?'已取消。可調整設定後再試。':(e.message||'建模失敗，請重新嘗試。');
    message('task-msg',msg + (ai && !canceled?' 也可改選輪廓膨形、影像浮雕或旋轉成形。':''),canceled?'':'error');
  } finally {controller=null; $('progress').hidden=true; flags();}
}
async function save() {
  if(!model || controller || exporting || loading) return;
  const chosen=format; exporting=true; flags(); message('export-msg','正在封裝 '+chosen.toUpperCase()+'…');
  try {
    await new Promise(resolve=>setTimeout(resolve,20));
    const mesh=withExportHeight(model,$('model-height').valueAsNumber);
    const blob=await exportModel(mesh,chosen);
    const url=URL.createObjectURL(blob), a=document.createElement('a');
    const stem=source.base.replace(/[<>:"/\\|?*\u0000-\u001F]/g,'_').slice(0,100);
    a.href=url; a.download=stem+'-'+names[select.value]+(chosen==='obj'?'-OBJ.zip':'.'+chosen);
    document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000);
    message('export-msg','已建立 '+a.download+'（'+(blob.size/1048576).toFixed(2)+' MB）。','good');
  } catch(e) {message('export-msg',e.message||'匯出失敗，請再試一次。','error');}
  finally {exporting=false; flags();}
}
function toggleViewer(id,callback) {
  $(id).addEventListener('click',()=>{const pressed=$(id).getAttribute('aria-pressed')!=='true'; $(id).setAttribute('aria-pressed',String(pressed)); callback(pressed);});
}
try { viewer=createViewer($('viewport')); } catch {}
toggleViewer('wire',value=>viewer?.setWireframe(value)); toggleViewer('rotate',value=>viewer?.setRotation(value));
$('reset').onclick=()=>viewer?.reset(); $('generate').onclick=()=>generate(); $('download').onclick=save;
$('cancel').onclick=()=>{ controller?.abort(); $('cancel').disabled=true; message('task-msg','正在取消，請稍候…'); };
$('generate').addEventListener('click',()=>{$('cancel').disabled=false});
$('drop').onclick=()=>$('input-file').click(); $('input-file').onchange=e=>{const file=e.target.files?.[0];e.target.value='';if(file) read(file);};
$('example').onclick=()=>read();
for(const name of ['dragover','dragenter','dragleave','drop']) $('drop').addEventListener(name,event=>{
  event.preventDefault(); if(controller || loading || exporting) return;
  $('drop').classList.toggle('drag',name==='dragover'||name==='dragenter');
  if(name==='drop' && event.dataTransfer.files?.[0]) read(event.dataTransfer.files[0]);
});
for(const id of ['mode','background','quality','depth']) $(id).addEventListener(id==='quality'||id==='depth'?'input':'change',()=>{if(id==='mode') explicitMode=true; updateNotes();invalidate();});
document.querySelectorAll('[data-format]').forEach(el=>el.addEventListener('click',()=>setFormat(el.dataset.format)));
const dialog=$('guide-dialog');
$('guide').onclick=()=>dialog.showModal(); $('close-guide').onclick=()=>dialog.close();
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
setFormat('glb'); updateNotes(); flags(); read();

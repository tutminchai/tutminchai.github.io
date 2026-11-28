(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const paths = {
    help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4"/><path d="M12 16h.01"/>',
    upload:'<path d="M12 15V3m-4 4 4-4 4 4M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
    play:'<path d="M7 4.9c0-.7.7-1 1.3-.6l11 7a.8.8 0 0 1 0 1.4l-11 7c-.6.4-1.3.1-1.3-.6z" fill="currentColor" stroke="none"/>',
    pause:'<path d="M7 5h3v14H7zm7 0h3v14h-3z" fill="currentColor" stroke="none"/>',
    speed:'<path d="M3.3 17.5a9 9 0 1 1 17.4 0M12 13l4-4"/><circle cx="12" cy="13" r="1.2"/>',
    chevron:'<path d="m6 9 6 6 6-6"/>',score:'<path d="M3 5h12M3 9h10M3 13h5m1 4v-4l11-3v4m0-4V5L9 8v5"/><ellipse cx="7" cy="18" rx="2.5" ry="1.8"/><ellipse cx="18" cy="15" rx="2.5" ry="1.8"/>',
    download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
    file:'<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 13h6m-6 4h6"/>',
    print:'<path d="M7 8V3h10v5m0 9h3V9H4v8h3m0-4h10v8H7z"/>',
    tune:'<path d="M3 6h8m4 0h6M3 12h3m4 0h11M3 18h10m4 0h4"/><circle cx="13" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="15" cy="18" r="2"/>',
    x:'<path d="m6 6 12 12M6 18 18 6"/>',notes:'<path d="M9 17V6l10-3v12M9 10l10-3"/><ellipse cx="6.5" cy="18" rx="2.5" ry="1.7"/><ellipse cx="16.5" cy="16" rx="2.5" ry="1.7"/>'
  };
  const icon = name => '<svg aria-hidden="true" class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+paths[name]+'</svg>';
  for (const mark of document.querySelectorAll('i[data-icon]')) mark.innerHTML = icon(mark.dataset.icon);
  const views = {both:'吉他合併譜',staff:'主旋律五線譜',tab:'吉他六線譜'};
  const embedded = window.FRETLEAF_ASSETS || {};
  const state = {score:window.DEMO_SCORE,view:'both',mode:'original',peaks:[],file:null,worker:null,job:0,load:0,ready:false,isDemo:true,active:-1};
  const playback = new AudioDesk({onTick:updateTime});
  let scoreWidth = 0, waveWidth = 0, wave = null, shownPlay = null, demoBuffer = null, seekPending = false;
  const time = n => { const s = Math.max(0, Math.floor(n || 0)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };
  const message = s => $('liveMessage').textContent = s;
  function updateActive(sec) {
    const notes = state.score.notes, beat = sec*state.score.bpm/60;
    let lo = 0, hi = notes.length;
    while (lo < hi) { const mid = (lo+hi) >> 1; if (notes[mid].start <= beat+1e-6) lo=mid+1; else hi=mid; }
    const i = lo-1;
    state.active=i>=0 && beat < notes[i].start+notes[i].duration && sec<playback.duration ? i : -1;
    Notation.setActive($('score'),state.active);
  }
  function updateTime(sec,playing) {
    if(!seekPending) $('seek').value=sec;
    $('clock').textContent=time(sec);
    if(shownPlay!==playing) {
      shownPlay=playing; $('play').innerHTML=icon(playing?'pause':'play');
      $('play').setAttribute('aria-label',playing?'暫停':'播放');$('play').title=playing?'暫停':'播放';
    }
    $('seek').setAttribute('aria-valuetext',time(sec)+' / '+time(playback.duration));
    updateActive(sec); drawWave();
  }
  function getPeaks(buffer) {
    const data=buffer.getChannelData(0), slices=Math.min(1400,data.length), peaks=[];
    for(let i=0;i<slices;i++) {
      const first=Math.floor(i*data.length/slices), end=Math.floor((i+1)*data.length/slices);
      let energy=0,n=0; const step=Math.max(1,Math.floor((end-first)/80));
      for(let k=first;k<end;k+=step){energy+=data[k]*data[k];n++;}
      peaks.push(Math.sqrt(energy/Math.max(n,1)));
    }return peaks;
  }
  function prepareWave(){
    const canvas=$('wave'),box=canvas.getBoundingClientRect(),w=Math.round(box.width),h=Math.round(box.height);
    if(!w||!h) return;
    const ratio=Math.min(2,window.devicePixelRatio||1);
    canvas.width=Math.round(w*ratio);canvas.height=Math.round(h*ratio);
    const count=Math.max(1,Math.floor(w/4)),a=state.peaks,peak=Math.max(.00001,...a);
    wave={ctx:canvas.getContext('2d'),ratio,w,h,bars:[]};
    for(let i=0;i<count;i++){
      const begin=Math.floor(i*a.length/count),end=Math.max(begin+1,Math.floor((i+1)*a.length/count));
      let p=0;for(let j=begin;j<end;j++)p=Math.max(p,a[j]||0);
      wave.bars.push({x:(i+.5)*w/count,h:Math.max(2,Math.pow(p/peak,.75)*(h-3))});
    }drawWave();
  }
  function drawWave(){
    if(!wave)return;const {ctx,ratio,w,h,bars}=wave;
    const pos=Number($('seek').value)/(playback.duration||1)*w;
    ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,w,h);ctx.lineCap='round';ctx.lineWidth=2.3;
    for(const b of bars){ctx.strokeStyle=b.x<=pos?'#efac6a':'#adbf9d';ctx.beginPath();ctx.moveTo(b.x,(h-b.h)/2);ctx.lineTo(b.x,(h+b.h)/2);ctx.stroke();}
    ctx.lineWidth=1.8;ctx.strokeStyle='#ffb66f';ctx.beginPath();ctx.moveTo(Math.min(w-1,Math.max(1,pos)),0);ctx.lineTo(Math.min(w-1,Math.max(1,pos)),h);ctx.stroke();
  }
  function renderScore(){
    const s=state.score; $('scoreTitle').textContent=$('trackTitle').textContent=s.title;
    $('sheetType').textContent=views[state.view];$('tempoValue').textContent='♩ = '+s.bpm;
    $('count').textContent=Math.max(1,Math.ceil(s.length/4))+' 小節 · '+s.notes.length+' 個旋律音';
    $('sourceLabel').textContent=state.isDemo?'預編範例':'匯入音檔';
    $('footInfo').textContent=state.isDemo?'預先編譜的原創範例':'單旋律自動轉譜';
    Notation.render($('score'),s,{view:state.view,chords:true});
    if(!state.isDemo){
      const unsure=new Set(s.notes.flatMap((n,i)=>n.confidence<.48?[i]:[]));
      if(unsure.size){
        for(const g of $('score').querySelectorAll('[data-note]'))if(unsure.has(Number(g.dataset.note)))g.classList.add('uncertain');
        $('footInfo').textContent='琥珀色音符需核對（'+unsure.size+' 個）';
      }
    }
    Notation.setActive($('score'),state.active);
  }
  function changeMode(mode){
    playback.setMode(mode);state.mode=mode;
    for(const id of ['original','melody'])$(id).setAttribute('aria-pressed',String(id===mode));
  }
  function setRecording(buffer,score,demo){
    state.score=score;state.isDemo=demo;state.active=-1;state.ready=true;
    $('endTime').textContent=time(buffer.duration);$('seek').max=buffer.duration;$('seek').value=0;
    state.peaks=getPeaks(buffer);playback.setTrack(buffer,score);changeMode('original');
    $('play').disabled=$('seek').disabled=false;renderScore();prepareWave();
  }
  async function loadDemo(){
    const token=++state.load;
    try {
      if(!demoBuffer){
        const response=await fetch(embedded.demo || 'demo.wav');
        if(!response.ok)throw Error();
        demoBuffer=await playback.decode(await response.arrayBuffer());
      }
      if(token!==state.load)return;
      setRecording(demoBuffer,window.DEMO_SCORE,true);message('');
    }catch{
      if(token===state.load)message('示範音訊無法讀取。您仍可匯入自己的錄音進行轉譜。');
    }
  }
  function importStatus(text,isError=false){$('importStatus').textContent=text;$('importStatus').classList.toggle('error',isError);}
  function cancelJob(){
    ++state.job;if(state.worker){state.worker.terminate();state.worker=null;}
    $('drop').disabled=$('bpm').disabled=false;$('analyze').disabled=!state.file;
    $('progress').hidden=true;
  }
  function choose(file){
    if(!file)return;
    cancelJob();state.file=file;$('fileLabel').textContent=file.name;
    $('analyze').disabled=false;importStatus('');
  }
  function openImport(){
    cancelJob();state.file=null;$('fileLabel').textContent='選擇或拖入音檔';$('pickFile').value='';$('bpm').value='';
    $('analyze').disabled=true;importStatus('');$('importDlg').showModal();
  }
  let workerUrl='';
  function newWorker(){
    if(embedded.engine&&!workerUrl)workerUrl=URL.createObjectURL(new Blob([embedded.engine],{type:'text/javascript'}));
    return new Worker(workerUrl || 'engine.js');
  }
  async function analyze(){
    const file=state.file;if(!file||$('analyze').disabled)return;
    if(!$('bpm').reportValidity())return;
    const tempo=$('bpm').value ? Number($('bpm').value) : undefined;
    const job=++state.job; ++state.load;playback.pause();
    $('drop').disabled=$('bpm').disabled=$('analyze').disabled=true;
    $('progress').hidden=false;$('progress').value=.02;importStatus('正在讀取音檔…');
    const fail=msg=>{if(job!==state.job)return;cancelJob();importStatus(msg,true);};
    try{
      const buffer=await playback.decode(await file.arrayBuffer());
      if(job!==state.job)return;
      importStatus('正在準備旋律分析…');
      const samples=await AudioDesk.mono(buffer);if(job!==state.job)return;
      const worker=state.worker=newWorker();
      worker.onerror=()=>fail('音訊分析未能完成。可選擇較短的片段再試。');
      worker.onmessage=({data})=>{
        if(job!==state.job)return;
        if(data.type==='progress'){
          const p=.08+.9*data.value;$('progress').value=p;importStatus('正在辨認音高與節奏… '+Math.round(p*100)+'%');return;
        }
        if(data.type==='error'){fail(data.message);return;}
        if(data.type==='done'){
          const title=file.name.replace(/\.[^.]+$/,'')||file.name;
          setRecording(buffer,{...data,title},false);$('importDlg').close();
          const timing=data.tempoSource==='fallback'?'節拍線索較少，曲速採用預設值。可重新匯入並指定 BPM。':data.tempoSource==='manual'?'已使用指定曲速。':'曲速為自動估算。';
          message('已辨認 '+data.notes.length+' 個旋律音。'+timing+' 可切換原音與旋律核對。');
        }
      };
      worker.postMessage({samples,sampleRate:11025,tempo},[samples.buffer]);
    }catch{fail('無法解碼這個音檔。請確認檔案可播放，或改用 MP3、WAV 再試一次。');}
  }
  const setMenu=open=>{$('exportMenu').hidden=!open;$('exportBtn').setAttribute('aria-expanded',String(open));};
  $('play').onclick=async()=>{try{if(playback.playing)playback.pause();else await playback.play();}catch{message('無法播放音訊，請再次點選播放鍵。');}};
  $('original').onclick=()=>changeMode('original');$('melody').onclick=()=>changeMode('melody');
  $('rate').onchange=()=>playback.setRate(Number($('rate').value));
  $('seek').addEventListener('input',()=>{seekPending=true;playback.seek(Number($('seek').value));seekPending=false;});
  for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{
    state.view=button.dataset.view;for(const other of document.querySelectorAll('[data-view]'))other.setAttribute('aria-pressed',String(other===button));renderScore();
  };
  $('score').onclick=e=>{
    const note=e.target.closest('[data-note]');
    if(!note||!state.ready)return;
    const n=state.score.notes[Number(note.dataset.note)];if(n)playback.seek(n.start*60/state.score.bpm);
  };
  $('exportBtn').onclick=()=>setMenu($('exportMenu').hidden);
  document.addEventListener('click',e=>{if(!e.target.closest('.export-wrap'))setMenu(false);});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('exportMenu').hidden){setMenu(false);$('exportBtn').focus();}});
  $('print').onclick=()=>{setMenu(false);window.print();};
  $('xml').onclick=()=>{
    setMenu(false);const url=URL.createObjectURL(new Blob([Notation.musicXML(state.score)],{type:'application/vnd.recordare.musicxml+xml'}));
    const a=document.createElement('a');a.href=url;a.download=(state.score.title||'拾音譜').replace(/[\\/:*?"<>|]/g,'-')+'.musicxml';
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  };
  $('openImport').onclick=openImport;$('cancelImport').onclick=()=>$('importDlg').close();
  $('importDlg').addEventListener('close',cancelJob);$('analyze').onclick=analyze;
  $('drop').onclick=()=>$('pickFile').click();$('pickFile').onchange=()=>choose($('pickFile').files[0]);
  for(const type of ['dragenter','dragover','dragleave','drop'])$('drop').addEventListener(type,e=>{
    e.preventDefault();if($('drop').disabled)return;
    $('drop').classList.toggle('over',type==='dragenter'||type==='dragover');
    if(type==='drop')choose(e.dataTransfer.files[0]);
  });
  $('help').onclick=()=>$('helpDlg').showModal();
  $('loadDemo').onclick=()=>{$('helpDlg').close();loadDemo();};
  for(const dlg of document.querySelectorAll('dialog'))dlg.addEventListener('click',e=>{
    if(e.target===dlg){const r=dlg.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dlg.close();}
  });
  function resize(){
    const a=$('score').clientWidth,b=$('wave').clientWidth;
    if(a&&a!==scoreWidth){scoreWidth=a;renderScore();}
    if(b&&b!==waveWidth){waveWidth=b;prepareWave();}
  }
  if(window.ResizeObserver){const ro=new ResizeObserver(resize);ro.observe($('score'));ro.observe($('wave'));}else window.addEventListener('resize',resize);
  window.addEventListener('beforeprint',renderScore);window.addEventListener('afterprint',renderScore);
  $('play').disabled=$('seek').disabled=true;resize();loadDemo();
})();

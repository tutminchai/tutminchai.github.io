'use strict';
const $ = id => document.getElementById(id);
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const synthesis = window.speechSynthesis;
const langs = {
  zh: {name:'繁體中文', short:'中文', speech:'zh-TW', api:'zh-TW'},
  ja: {name:'日本語', short:'日文', speech:'ja-JP', api:'ja'}
};
let from = 'zh', mode = 'chat', listening = false, engine = null, restartTimer = null;
let relayActive=false, relayId=0, handoffTimer=null, playback=null;
let speaking = false, processing = false, last = null, tick = 0;
let pendingMic = null, micVerified = false, retrySpeechDirectly = false;
let micState = '', savedAuto = true, draft = null, keyboardLive = false, showStageOnStart = false;
const jobs = [], records = [];
const targetOf = src => src === 'zh' ? 'ja' : 'zh';
const hasVoice = !!(synthesis && window.SpeechSynthesisUtterance);
const timeFormat = new Intl.DateTimeFormat('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false});
function drawSignal(){
  const svg=$('signal'), ns='http://www.w3.org/2000/svg';
  for(let j=0;j<42;j++){
    const path=document.createElementNS(ns,'path'), points=[];
    for(let x=-3;x<=604;x+=3){
      const t=x/600, k=j/41;
      const left=Math.exp(-Math.pow((t-.22-.046*k)/.165,2));
      const right=Math.exp(-Math.pow((t-.74+.055*k)/.149,2));
      const y=61+(left*32*Math.sin(12*t+2.7*k)+right*55*Math.sin(17*t+2.9*k))+(k-.5)*10*Math.cos(t*11);
      points.push((points.length?'L':'M')+x+' '+y.toFixed(2));
    }
    path.setAttribute('d',points.join(' '));path.setAttribute('fill','none');
    path.setAttribute('stroke','hsl('+(329+j*.97)+' 95% '+(68+j*.32)+'%)');
    path.setAttribute('opacity',String(.38+.25*Math.sin(j/41*Math.PI)));
    path.setAttribute('stroke-width','1.1');svg.append(path);
  }
}
function controls(){
  const live=mode==='live', waiting=processing || jobs.length>0, busy=!!engine || listening, occupied=busy || relayActive;
  $('modeChat').setAttribute('aria-pressed',String(!live));$('modeLive').setAttribute('aria-pressed',String(live));
  $('from').textContent=langs[from].name;$('from').lang=langs[from].speech;
  $('to').textContent=langs[targetOf(from)].name;$('to').lang=langs[targetOf(from)].speech;
  $('swap').disabled=occupied || waiting;$('modeChat').disabled=occupied || waiting;$('modeLive').disabled=occupied || waiting;
  $('auto').disabled=live || !hasVoice || relayActive;$('key').disabled=occupied;
  $('send').disabled=occupied || waiting;$('clear').disabled=occupied || waiting || !records.length;
  const state=speaking?'播放譯音中 · 読み上げ中':busy?(micState || '收音中'):(micState || (Recognition?'麥克風待命':'需要瀏覽器語音辨識'));
  $('state').textContent=state;$('stageState').textContent=state+' · '+$('notice').textContent;
  $('console').classList.toggle('listening',busy);
  $('mic').disabled=!relayActive && ((!listening && !!engine) || (!live && waiting && !busy));
  let buttonText=live?'開始即時翻譯':(from==='ja'?'日本語で話す':'開始中文對話');
  if(!Recognition)buttonText='開啟收音協助';
  if(retrySpeechDirectly)buttonText='啟動語音辨識';
  if(engine && !listening)buttonText='正在結束';
  if(listening)buttonText=live?'停止連續收音':'結束這句';
  if(relayActive)buttonText='結束對話 / 終了';
  if(pendingMic)buttonText='取消權限請求';
  $('otherStart').hidden=live || occupied || waiting || !Recognition;
  $('otherStart').textContent=from==='zh'?'日本語から':'中文先說';
  $('otherStart').lang=from==='zh'?'ja':'zh-TW';
  $('micLabel').textContent=buttonText;$('stageMic').textContent=buttonText;$('stageMic').disabled=$('mic').disabled;
  $('mic').querySelector('use').setAttribute('href',occupied?'#i-stop':(Recognition?'#i-mic':'#i-typing'));
  $('micHint').textContent=pendingMic?'看到麥克風提示時，請選擇允許。':(relayActive && speaking)?'請等譯音播完，再由對方發言。':listening?(from==='ja'?'日本語でお話しください。':'請說中文，說完一句稍作停頓。'):(live?'點一次即可連續說'+langs[from].short+'。':'點一下，說一句'+langs[from].short+'。');
  $('typeLabel').textContent='輸入'+langs[from].short+'原文';$('typed').lang=langs[from].speech;
  $('play').disabled=!hasVoice || !last?.translation || !!draft || occupied || waiting;
  $('play').lastChild.textContent=speaking?'停止朗讀':(last?.src==='zh'?'重播日文 / 再生':last?.src==='ja'?'重播中文 / 再生':'重播譯音');
}
function display(row=null){
  const src=row?.src || from, dest=targetOf(src);
  const target=row?(row.translation || (row.error?'翻譯未完成':'翻譯中…')):(dest==='ja'?'ここに日本語訳が表示されます。':'譯文將顯示在這裡。');
  $('sourceLang').textContent=langs[src].name;$('targetLang').textContent=langs[dest].name;
  $('source').textContent=row?.source || (src==='ja'?'日本語でお話しください…':'等待發言…');$('source').lang=langs[src].speech;
  $('target').textContent=target;$('target').lang=langs[dest].speech;
  $('source').classList.toggle('placeholder',!row);$('target').classList.toggle('placeholder',!row?.translation);
  $('stageLang').textContent=langs[dest].name;$('stageTarget').textContent=target;$('stageTarget').lang=langs[dest].speech;
  $('stageSource').textContent=row?.source || '';$('stageSource').lang=langs[src].speech;
  controls();
}
function notice(text){$('notice').textContent=text;$('stageState').textContent=$('state').textContent+' · '+text}
function renderHistory(){
  const list=$('history');list.replaceChildren();$('count').textContent=String(records.length);
  if(!records.length){const p=document.createElement('p');p.className='empty';p.textContent='完成翻譯後，雙語紀錄會依序出現在這裡。';list.append(p);return}
  for(const row of records.slice().reverse()){
    const line=document.createElement('article');line.className='record';
    const time=document.createElement('small');time.textContent=timeFormat.format(row.time)+' · '+(row.src==='zh'?'中日':'日中');
    const original=document.createElement('p');original.textContent=row.source;original.lang=langs[row.src].speech;
    const result=document.createElement('p');result.className='translated';result.lang=langs[targetOf(row.src)].speech;
    result.textContent=row.translation || row.error || '翻譯中…';
    if(row.error){const retry=document.createElement('button');retry.className='textbtn';retry.textContent='重試';retry.onclick=()=>{if(row.error){row.error='';jobs.push(row);renderHistory();processJobs()}};result.append(retry)}
    line.append(time,original,result);list.append(line);
  }
}
function endRelay(){
  relayActive=false;relayId++;clearTimeout(handoffTimer);handoffTimer=null;controls();
}
function cancelVoice(){
  if(playback)playback.finish('cancelled');
  synthesis?.cancel();
}
function chooseVoice(language){
  const voices=synthesis.getVoices();
  const exact=voices.find(v=>v.lang.replaceAll('_','-').toLowerCase()===language.toLowerCase());
  if(exact)return exact;
  const preferred=language==='ja-JP'?/^ja(?:-|$)/i:/^(?:cmn|zh-(?:Hant|TW|CN|SG)|zh$)/i;
  return voices.find(v=>preferred.test(v.lang.replaceAll('_','-')));
}
function readAloud(row){
  if(!row?.translation || !hasVoice || listening || engine)return Promise.resolve('failed');
  cancelVoice();
  const language=langs[targetOf(row.src)];
  return new Promise(resolve=>{
    const utterance=new SpeechSynthesisUtterance(row.translation);
    const voice=chooseVoice(language.speech);
    if(voice)utterance.voice=voice;
    utterance.lang=language.speech;utterance.rate=.96;
    let timeout=null;
    const current={utterance,finish};playback=current;
    function finish(result){
      if(playback!==current)return;
      playback=null;speaking=false;clearTimeout(timeout);
      utterance.onstart=utterance.onend=utterance.onerror=null;
      if(result==='failed'){
        synthesis.cancel();
        notice('裝置未能播放'+language.short+'。請點「重播」，或檢查系統的'+language.short+'語音。');
      }else if(result==='done')notice('譯音播放完畢');
      controls();resolve(result);
    }
    timeout=setTimeout(()=>finish('failed'),6500);
    utterance.onstart=()=>{
      if(playback!==current)return;
      clearTimeout(timeout);
      timeout=setTimeout(()=>finish('failed'),Math.max(15000,utterance.text.length*550+6000));
      notice('正在朗讀'+language.short);
    };
    utterance.onend=()=>finish('done');utterance.onerror=()=>finish('failed');
    speaking=true;controls();
    try{synthesis.speak(utterance)}catch{finish('failed')}
  });
}
function splitSegments(text){
  const enc=new TextEncoder(), out=[];let chunk='', bytes=0;
  for(const unit of text.match(/[^。！？!?.,，、；;\s]+|[。！？!?.,，、；;\s]+/gu) || []){
    const n=enc.encode(unit).length;
    if(bytes+n>500 && chunk.trim()){out.push(chunk.trim());chunk='';bytes=0}
    for(const c of unit){
      const size=enc.encode(c).length;
      if(bytes+size>500){if(chunk.trim())out.push(chunk.trim());chunk='';bytes=0}
      chunk+=c;bytes+=size;
    }
  }
  if(chunk.trim())out.push(chunk.trim());return out;
}
async function translate(row, signal){
  const dest=targetOf(row.src), output=[];
  for(const segment of splitSegments(row.source)){
    const query=new URLSearchParams({q:segment,langpair:langs[row.src].api+'|'+langs[dest].api,mt:'1'});
    const abort=new AbortController(), timeout=setTimeout(()=>abort.abort(),13000);
    const cancel=()=>abort.abort();
    if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
    try{
      const r=await fetch('https://api.mymemory.translated.net/get?'+query,{signal:abort.signal,credentials:'omit',referrerPolicy:'no-referrer'});
      if(r.status===429)throw new Error('已達翻譯服務用量上限，請稍後再試。');
      if(!r.ok)throw new Error('無法連上翻譯服務，請檢查網路後重試。');
      const data=await r.json(), value=data.responseData?.translatedText;
      if(data.quotaFinished || Number(data.responseStatus)===429)throw new Error('已達翻譯服務用量上限，請稍後再試。');
      if(Number(data.responseStatus)!==200 || typeof value!=='string' || !value.trim())throw new Error('翻譯服務未回傳譯文，請重試。');
      const decoded=new DOMParser().parseFromString(value.replace(/</g,'&lt;'), 'text/html').body.textContent;
      output.push(decoded.trim());
    }finally{clearTimeout(timeout);signal?.removeEventListener('abort',cancel)}
  }
  return output.join('');
}
const canonicalUrl = 'https://tutminchai.github.io/relay-interpreter-ja/';
const recovery = {
  'not-allowed':['瀏覽器未授權收音','如果畫面上方有「編輯網站」，請按「複製網址」，從手機桌面開啟 Chrome 並貼上。若已在 Chrome，請檢查本站的麥克風權限和 Android 設定中的 Chrome 麥克風權限。'],
  'blocked-frame':['內嵌頁面禁止使用麥克風','這個頁面的權限設定擋住了麥克風。請按「複製網址」，再從手機桌面開啟 Chrome 並貼上網址。'],
  'blocked-policy':['網站權限政策禁止使用麥克風','目前頁面的麥克風受到權限政策限制。您可以點「用鍵盤語音輸入」，直接對著鍵盤麥克風說話。'],
  'insecure':['這個頁面無法安全啟用麥克風','請在 Chrome 貼上本站完整的 HTTPS 網址，再點「開始即時翻譯」。'],
  'speech-denied':['麥克風可用，語音辨識未啟動','請再點一次「啟動語音辨識」。若仍無法使用，可點「用鍵盤語音輸入」，再點手機鍵盤上的麥克風。'],
  'speech-unverified':['瀏覽器未開放語音辨識','此瀏覽器未能確認麥克風存取權。請改在 Chrome 開啟，或點「用鍵盤語音輸入」。'],
  'prompt-timeout':['尚未取得麥克風授權','若手機仍顯示權限提示，請先選擇允許，再點「開始即時翻譯」。若完全沒有提示，請複製網址到 Chrome 開啟。'],
  'mic-busy':['無法啟用麥克風','請先結束可能正在使用麥克風的通話或錄音，再試一次。'],
  'service-not-allowed':['目前的瀏覽器無法啟用語音服務','可以改用手機的 Chrome 開啟本站，或使用鍵盤上的麥克風。'],
  'unsupported':['這個瀏覽器未提供語音辨識','請在手機的 Chrome 開啟本站，或使用鍵盤上的麥克風繼續。'],
  'audio-capture':['目前收不到麥克風聲音','請確認手機的麥克風存取權已開啟，再試一次。'],
  'network':['語音服務連線中斷','請確認網路連線，再點一次收音。也可以使用鍵盤上的麥克風。'],
  'language-not-supported':['此裝置無法辨識所選語言','可以在 Chrome 開啟本站，或選擇鍵盤上的麥克風。'],
  'timeout':['麥克風沒有回應','如果沒有看到權限提示，請在手機瀏覽器開啟本站，允許麥克風後再試。']
};
function showRecovery(code){
  const [title,advice]=recovery[code] || ['收音已中斷','可以重新開始收音，或使用手機鍵盤的麥克風。'];
  endRelay();micState=title;
  $('micProblem').textContent=title;$('micAdvice').textContent=advice;
  $('copyStatus').textContent='';$('micHelp').hidden=false;
  if($('stage').open)$('stage').close();
  notice(title);controls();
}
function openText(){
  $('textForm').hidden=false;$('key').setAttribute('aria-expanded','true');$('typed').focus();
}
function resetKeyboard(){
  if(keyboardLive)discardDraft();
  keyboardLive=false;$('keyboardLive').hidden=false;$('dictateHint').hidden=true;$('send').textContent='翻譯';
}
function stopKeyboard(){
  resetKeyboard();
  $('textForm').hidden=true;$('key').setAttribute('aria-expanded','false');
}
function redraw(){
  if(draft){
    display(draft);
    notice(draft.translation?'暫譯 · 隨發言更新':'正在辨識 · 等待暫譯');
  }else{
    display(last);
  }
}
// The final sentence takes ownership of an exact in-flight preview, saving a second request.
function discardDraft(finalText=''){
  const old=draft;
  if(!old)return null;
  draft=null;clearTimeout(old.timer);
  if(finalText && old.request?.text===finalText)return old.request.promise;
  old.request?.abort.abort();
  return old.translatedText===finalText && old.translation ? Promise.resolve(old.translation) : null;
}
function schedulePreview(d){
  if(d!==draft || d.timer || d.request || d.sent===d.source)return;
  const wait=d.sent ? Math.max(0,1600-(Date.now()-d.lastSentAt)) : 350;
  d.timer=setTimeout(async()=>{
    d.timer=null;
    if(d!==draft)return;
    const text=d.source, abort=new AbortController();
    d.sent=text;d.lastSentAt=Date.now();
    const promise=translate({source:text,src:d.src},abort.signal);
    d.request={text,abort,promise};
    try{
      const translated=await promise;
      if(d===draft && d.source.startsWith(text)){
        d.translation=translated;d.translatedText=text;redraw();
      }
    }catch{
      if(d===draft)notice('等待翻譯服務，定稿時會再試一次。');
    }finally{
      d.request=null;
      if(d===draft)schedulePreview(d);
    }
  },wait);
}
function showDraft(words,src){
  if(!words){
    if(draft){discardDraft();redraw()}
    return;
  }
  if(!draft)draft={src,source:'',translation:'',translatedText:'',sent:'',lastSentAt:0,timer:null,request:null};
  if(draft.source===words)return;
  draft.source=words;
  if(draft.translation && !words.startsWith(draft.translatedText)){
    draft.translation='';draft.translatedText='';
  }
  redraw();schedulePreview(draft);
}
function enqueue(text,src,turn=null){
  const source=text.trim();
  if(!source)return;
  const preview=discardDraft(source);
  // Attach a handler immediately, even when another final sentence is ahead in the queue.
  const reusable=preview?.catch(()=>null);
  jobs.push({source,src,translation:'',error:'',time:new Date(),reusable,turn});processJobs();
}
async function processJobs(){
  if(processing)return;
  processing=true;
  while(jobs.length){
    const row=jobs.shift();
    if(!draft){notice('翻譯中…');if(!last?.translation || mode==='chat'){last=row;display(row)}}
    try{
      row.translation=(await row.reusable) || await translate(row);
      if(!draft)notice('已完成翻譯');
    }catch(e){
      row.error=e instanceof TypeError || e.name==='AbortError'?'連線未完成，請檢查網路後重試。':e.message;
      if(mode==='live' && listening)stopMic();
      notice(row.error);
    }
    delete row.reusable;
    if(!records.includes(row))records.push(row);
    last=row;redraw();renderHistory();
  }
  processing=false;controls();
  const row=last;
  if(mode!=='chat' || !row || engine || listening)return;
  const turn=row.turn;
  if(turn!=null && (!relayActive || turn!==relayId))return;
  if(!row.translation){if(turn!=null)endRelay();return}
  if(!hasVoice && !draft)notice('這個瀏覽器未提供朗讀功能，請改用有中日語音的瀏覽器。');
  const sound=$('auto').checked ? await readAloud(row) : 'muted';
  if(turn==null || !relayActive || turn!==relayId)return;
  if(sound==='failed'){endRelay();return}
  from=targetOf(row.src);
  notice(from==='ja'?'次は日本語でお話しください。':'換您說中文。');
  controls();
  handoffTimer=setTimeout(()=>{
    if(!relayActive || turn!==relayId || document.hidden)return;
    listening=true;micState='等待下一位發言';controls();startEngine();
  },350);
}
function stopMic(){
  cancelMicCheck();listening=false;clearTimeout(restartTimer);restartTimer=null;
  if(engine)engine.stop();
  else{micState='';controls()}
}
function startEngine(){
  if(!listening || engine)return;
  let recognition;
  try{recognition=new Recognition()}catch{listening=false;showRecovery('unsupported');return}
  const src=from, live=mode==='live', seen=new Set();
  const turn=relayActive?relayId:null;
  let buffered=[], partial='', watchdog=null, started=false, hadResult=false;
  const session={stop,abandon};
  engine=session;
  recognition.lang=langs[src].speech;recognition.continuous=live;
  recognition.interimResults=true;recognition.maxAlternatives=1;
  function arm(callback,ms){clearTimeout(watchdog);watchdog=setTimeout(()=>{if(engine===session)callback()},ms)}
  function detach(){
    if(engine!==session)return false;
    clearTimeout(watchdog);engine=null;
    recognition.onstart=recognition.onresult=recognition.onerror=recognition.onend=null;
    recognition.onspeechstart=recognition.onspeechend=null;
    return true;
  }
  function abortNative(){try{recognition.abort()}catch{}}
  function abandon(){
    if(!detach())return;
    listening=false;discardDraft();abortNative();micState='';controls();
  }
  function finish({code='',force=false}={}){
    if(!detach())return;
    if(force || code)abortNative();
    if(code){
      listening=false;discardDraft();
      if(buffered.length)enqueue(buffered.join(''),src,turn);
      redraw();showRecovery(code);return;
    }
    micState='';
    const words=[...buffered,partial].filter(Boolean).join('');
    if(words)enqueue(words,src,turn);
    else if(!live && !hadResult){endRelay();notice('沒有收到語音，請點選發言語言再試一次。')}
    if(!live)listening=false;
    if(listening){
      tick=hadResult?0:tick+1;
      if(tick>=4){listening=false;notice('暫時沒有收到語音，點一下可繼續。')}
      else restartTimer=setTimeout(startEngine,300);
    }
    redraw();
  }
  function stop(){
    micState='正在結束收音';controls();
    arm(()=>finish({force:true}),1100);
    try{recognition.stop()}catch{finish({force:true})}
  }
  function idleWatch(){if(listening)arm(()=>finish({force:true}),32000)}
  function ready(){
    if(started || engine!==session || !listening)return;
    started=true;retrySpeechDirectly=false;micState='正在收音';controls();idleWatch();
    if(showStageOnStart){
      showStageOnStart=false;
      if(!$('stage').open && !$('guide').open)$('stage').showModal();
    }
  }
  recognition.onstart=ready;
  recognition.onspeechstart=idleWatch;
  recognition.onspeechend=idleWatch;
  recognition.onresult=e=>{
    if(engine!==session)return;
    ready();idleWatch();
    const fragments=[];
    for(let i=0;i<e.results.length;i++){
      const result=e.results[i], text=result[0].transcript.trim();
      if(result.isFinal){
        if(seen.has(i))continue;
        seen.add(i);if(text)hadResult=true;
        if(live)enqueue(text,src);else if(text)buffered.push(text);
      }else if(text)fragments.push(text);
    }
    partial=fragments.join('');
    if(partial)hadResult=true;
    showDraft(live?partial:[...buffered,partial].filter(Boolean).join(''),src);
    if(!live && buffered.length && !partial)stop();

  };
  recognition.onerror=e=>{
    if(engine!==session)return;
    if(e.error==='no-speech' || (e.error==='aborted' && !listening))finish({force:true});
    else if(e.error==='not-allowed' || e.error==='service-not-allowed'){
      retrySpeechDirectly=micVerified;
      finish({code:micVerified?'speech-denied':(e.error==='not-allowed'?'speech-unverified':e.error)});
    }else finish({code:e.error});
  };
  recognition.onend=()=>finish();
  arm(()=>finish({code:'timeout'}),18000);
  try{recognition.start()}catch{finish({code:'service-not-allowed'})}
}
function captureRestriction(){
  if(window.isSecureContext===false)return 'insecure';
  const policy=document.permissionsPolicy || document.featurePolicy;
  try{
    if(policy?.allowsFeature('microphone')===false){
      return window.self!==window.top ? 'blocked-frame':'blocked-policy';
    }
  }catch{}
  return '';
}
function cancelMicCheck(){
  if(!pendingMic)return;
  clearTimeout(pendingMic.timer);pendingMic=null;
}
async function requestMicrophone(){
  const attempt={timer:null};
  pendingMic=attempt;
  micState='正在要求麥克風權限';notice('請允許使用麥克風');controls();
  function fail(code){
    if(pendingMic!==attempt)return;
    cancelMicCheck();listening=false;showRecovery(code);
  }
  attempt.timer=setTimeout(()=>fail('prompt-timeout'),30000);
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    let usable=false;
    try{usable=stream.getAudioTracks().some(track=>track.readyState==='live')}
    finally{for(const track of stream.getTracks())track.stop()}
    if(pendingMic!==attempt)return;
    if(!usable){fail('audio-capture');return}
    micVerified=true;cancelMicCheck();micState='正在啟動語音辨識';notice('麥克風已允許');controls();startEngine();
  }catch(error){
    const code=captureRestriction() || ({NotAllowedError:'not-allowed',SecurityError:'not-allowed',NotFoundError:'audio-capture',NotReadableError:'mic-busy'}[error?.name] || 'audio-capture');
    fail(code);
  }
}
function micAction(){
  if(relayActive){endRelay();cancelVoice();stopMic();notice('對話已結束');return}
  if(listening){stopMic();return}
  if(engine || (processing && mode==='chat'))return;
  const blocked=captureRestriction();
  if(blocked || !Recognition){showRecovery(blocked || 'unsupported');return}
  resetKeyboard();cancelVoice();$('micHelp').hidden=true;
  if(mode==='chat'){relayActive=true;relayId++}
  showStageOnStart=mode==='live' && window.matchMedia('(max-width: 780px)').matches && !$('stage').open;
  listening=true;micState='等待麥克風…';tick=0;notice('等待語音');controls();
  if(retrySpeechDirectly || !navigator.mediaDevices?.getUserMedia){retrySpeechDirectly=false;startEngine();return}
  micVerified=false;requestMicrophone();
}
function setMode(next){
  if(listening || engine || processing || mode===next)return;
  resetKeyboard();cancelVoice();if(next==='live'){savedAuto=$('auto').checked;$('auto').checked=false}else $('auto').checked=savedAuto && hasVoice;
  mode=next;micState='';redraw();notice(next==='live'?'即時字幕已就緒':'雙向對話已就緒');
}
$('mic').onclick=$('stageMic').onclick=micAction;
$('otherStart').onclick=()=>{if(relayActive || listening || engine || processing)return;from=targetOf(from);micAction()};

$('modeChat').onclick=()=>setMode('chat');$('modeLive').onclick=()=>setMode('live');
$('swap').onclick=()=>{resetKeyboard();cancelVoice();from=targetOf(from);micState='';last=null;display();notice('已交換語言')};
$('auto').onchange=()=>{if(!$('auto').checked)cancelVoice()};
$('play').onclick=()=>speaking?cancelVoice():readAloud(last);
$('key').onclick=()=>{if($('textForm').hidden)openText();else{stopKeyboard();redraw()}};
$('textForm').onsubmit=e=>{e.preventDefault();const s=$('typed').value.trim();if(!s || listening || engine || processing)return;cancelVoice();enqueue(s,from);$('typed').value=''};
$('clear').onclick=()=>{resetKeyboard();cancelVoice();records.length=0;last=null;renderHistory();display();notice('已清除本次紀錄')};
$('expand').onclick=()=>$('stage').showModal();$('closeStage').onclick=()=>$('stage').close();
$('help').onclick=()=>$('guide').showModal();$('closeHelp').onclick=()=>$('guide').close();
const android=/Android/i.test(navigator.userAgent);
if(android){
  $('external').textContent='用 Chrome 開啟';
  $('external').removeAttribute('target');
  $('external').href='intent://'+canonicalUrl.slice('https://'.length)+'#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url='+encodeURIComponent(canonicalUrl)+';end';
}
$('copyUrl').onclick=async()=>{
  try{await navigator.clipboard.writeText(canonicalUrl);$('copyStatus').textContent='網址已複製，請貼到 Chrome 網址列。'}
  catch{$('copyStatus').textContent='可長按複製 '+canonicalUrl}
};
$('dictate').onclick=$('keyboardLive').onclick=()=>{
  keyboardLive=true;$('keyboardLive').hidden=true;$('dictateHint').hidden=false;$('send').textContent='完成這句';
  openText();showDraft($('typed').value.trim(),from);
};
$('typed').addEventListener('input',()=>{if(keyboardLive)showDraft($('typed').value.trim(),from)});
window.addEventListener('pagehide',()=>{
  endRelay();cancelMicCheck();listening=false;clearTimeout(restartTimer);engine?.abandon();discardDraft();cancelVoice();
});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden && (relayActive || speaking)){endRelay();cancelVoice();stopMic();notice('對話已暫停')}
});
if(!hasVoice)$('auto').checked=false;
synthesis?.getVoices();
drawSignal();display();
const initialBlock=captureRestriction();
if(initialBlock || !Recognition)showRecovery(initialBlock || 'unsupported');

/* Engraving for a monophonic score on a sixteenth-note grid. */
(() => {
  'use strict';

  const DIVISIONS = 4;
  const BAR = DIVISIONS * 4;
  const OPEN = [64, 59, 55, 50, 45, 40]; // String 1 to 6, concert MIDI pitch.
  const SPELLING = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const SCALE = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const VALUES = [
    [16, 'whole'], [12, 'half', true], [8, 'half'], [6, 'quarter', true],
    [4, 'quarter'], [3, 'eighth', true], [2, 'eighth'], [1, '16th']
  ];
  const cache = new WeakMap();
  const layouts = new WeakMap();
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
    {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[c]
  ));
  const tick = n => Math.round(n * DIVISIONS);
  const xy = n => Number(n.toFixed(2));
  const line = (x1, y1, x2, y2, attrs = '') =>
    `<line x1="${xy(x1)}" y1="${xy(y1)}" x2="${xy(x2)}" y2="${xy(y2)}" ${attrs}/>`;
  const text = (x, y, content, attrs = '') =>
    `<text x="${xy(x)}" y="${xy(y)}" ${attrs}>${esc(content)}</text>`;
  const path = (d, attrs = '') => `<path d="${d}" ${attrs}/>`;

  function pitch(midi) {
    const name = SPELLING[midi % 12];
    const octave = Math.floor(midi / 12) - 1;
    const step = name[0], alter = name.length > 1 ? 1 : 0;
    return {step, alter, octave, diatonic: (octave + 1) * 7 + SCALE.indexOf(step)};
  }

  // Only realizable fingerings are considered. Minimize hand movement across a phrase.
  function assignFrets(notes) {
    let layers = [];
    function finishPhrase() {
      if (!layers.length) return;
      let pos = layers.at(-1).reduce((best, p, i, all) => p.cost < all[best].cost ? i : best, 0);
      for (let i = layers.length - 1; i >= 0; i--) {
        const p = layers[i][pos];
        p.note.tab = {string: p.string, fret: p.fret};
        pos = p.prev;
      }
      layers = [];
    }
    let lastEnd = -Infinity;
    for (const n of notes) {
      if (n.start - lastEnd >= BAR) finishPhrase();
      lastEnd = n.end;
      const positions = OPEN.map((open, i) => ({string: i+1, fret: n.midi-open, note: n}))
        .filter(p => p.fret >= 0 && p.fret <= 24);
      if (!positions.length) {
        finishPhrase();
        continue;
      }
      const preceding = layers.at(-1) || [];
      for (const p of positions) {
        const local = 0.09 * p.fret + Math.max(0, p.fret - 12) * 0.12;
        p.cost = local;
        p.prev = -1;
        if (preceding.length) {
          let best = Infinity;
          preceding.forEach((q, j) => {
            const shift = p.fret && q.fret ? Math.abs(p.fret-q.fret) : 0;
            const cost = q.cost + 0.4 * shift + 0.15 * Math.abs(p.string-q.string);
            if (cost < best) { best = cost; p.prev = j; }
          });
          p.cost += best;
        }
      }
      layers.push(positions);
    }
    finishPhrase();
  }

  function analyze(score) {
    if (cache.has(score)) return cache.get(score);
    const notes = (Array.isArray(score.notes) ? score.notes : []).map((n, i) => ({
      index: i, midi: Math.round(n.midi), start: Math.max(0, tick(n.start)),
      end: tick(n.start + n.duration)
    })).filter(n => Number.isFinite(n.start) && Number.isFinite(n.end) &&
      Number.isInteger(n.midi) && n.midi >= 0 && n.midi <= 127 && n.end > n.start)
      .sort((a,b) => a.start-b.start || a.index-b.index);
    notes.forEach((n, i) => { if (notes[i+1]) n.end = Math.min(n.end, notes[i+1].start); });
    const played = notes.filter(n => n.end > n.start);
    assignFrets(played);
    const end = Math.max(tick(Number(score.length) || 0), played.at(-1)?.end || 0, BAR);
    const bars = Array.from({length: Math.ceil(end / BAR)}, (_, i) => ({number: i+1, events: [], chords: []}));
    const addSpan = (start, stop, n) => {
      for (let cursor = start; cursor < stop;) {
        const offset = cursor % BAR;
        const inBar = Math.min(stop-cursor, BAR-offset);
        let available = inBar;
        // Preserve beat groupings for offbeat notes and rests.
        if (offset % 4) available = Math.min(inBar, 4-offset%4);
        else if (offset === 4 && inBar > 4 && inBar < 12) available = 4;
        const value = VALUES.find(v => v[0] <= available);
        const event = {n, tick: cursor, offset, units: value[0], type: value[1], dot: Boolean(value[2]),
          incoming: Boolean(n && cursor > start), outgoing: Boolean(n && cursor+value[0] < stop)};
        bars[Math.floor(cursor/BAR)].events.push(event);
        cursor += value[0];
      }
    };
    let cursor = 0;
    for (const n of played) {
      if (cursor < n.start) addSpan(cursor, n.start, null);
      addSpan(n.start, n.end, n);
      cursor = n.end;
    }
    if (cursor < bars.length * BAR) addSpan(cursor, bars.length * BAR, null);
    for (const c of score.chords || []) {
      if (!c || !c.label || !Number.isFinite(c.beat) || c.beat < 0) continue;
      const t = tick(c.beat), bar = bars[Math.floor(t/BAR)];
      if (bar) bar.chords.push({offset:t%BAR, label:String(c.label)});
    }
    bars.forEach(bar => {
      const state = new Map();
      for (const e of bar.events) {
        if (!e.n) continue;
        const p = pitch(e.n.midi), key = p.step+p.octave;
        const previous = state.get(key) || 0;
        if (!e.incoming && p.alter !== previous) e.acc = p.alter ? 'sharp' : 'natural';
        if (!e.incoming) state.set(key, p.alter);
        // The bottom line is written E4. The guitar sounds one octave lower.
        e.steps = p.diatonic - (4*7 + 2);
      }
    });
    const model = {bars, played};
    cache.set(score, model);
    return model;
  }

  function treble(x, bottom) {
    // The spiral encloses the G line (second line up).
    return `<g transform="translate(${xy(x)} ${xy(bottom - 8)}) scale(.8)" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">`+
      path('M 5 20 C 12 23 14 17 13 11 L 7 -20 C 5 -31 8 -38 10 -39 C 16 -29 9 -19 3 -13 C -6 -5 -6 2 0 6 C 5 10 15 7 15 0 C 15 -7 8 -10 4 -6 C 0 -3 1 2 5 3','stroke-width="2.5"')+
      '<circle cx="6" cy="18.5" r="3.1" fill="currentColor" stroke="none"/></g>';
  }

  function rest(x, center, e) {
    const g = `<g transform="translate(${xy(x)} ${xy(center)})">`;
    let mark;
    switch (e.type) {
      case 'whole': mark = '<rect x="-4.6" y="-8" width="9.2" height="3.4"/>'; break;
      case 'half': mark = '<rect x="-4.6" y="-3.4" width="9.2" height="3.4"/>'; break;
      case 'quarter':
        mark = path('M -2 -11 L 4 -5 L 1 -1 L 4 4 C 0 0 -4 2 1 8 C -7 5 -6 -1 -1 0 L -4 -4 L 0 -7 Z');
        break;
      default:
        mark = path('M 4 -6 L 0 7 M 3 -5 Q 0 -1 -3 -5','stroke="currentColor" fill="none" stroke-width="1.5"')+
          '<circle cx="-3" cy="-5" r="2"/>';
        if (e.type === '16th') mark += path('M 2 -1 Q -1 3 -4 0','stroke="currentColor" fill="none" stroke-width="1.5"')+'<circle cx="-4" cy="0" r="2"/>';
    }
    return g+mark+(e.dot?'<circle cx="7" cy="-3" r="1.35"/>':'')+'</g>';
  }

  function accidental(x,y,kind) {
    const g = `<g transform="translate(${xy(x)} ${xy(y)})" stroke="currentColor" fill="none">`;
    return g+(kind === 'sharp' ?
      path('M -2 -6 V 7 M 2 -8 V 5','stroke-width="1"')+
      path('M -4 -2 L 4 -4 M -4 3 L 4 1','stroke-width="2"') :
      path('M -2 -8 V 3 L 2 2 V -3 L -2 -2 M 2 -3 V 7','stroke-width="1.4"'))+'</g>';
  }

  function notehead(x, y, e, stemUp, beamed) {
    const open = e.type === 'whole' || e.type === 'half';
    const rx = e.type === 'whole' ? 5.4 : 4.4;
    let s = `<ellipse cx="${xy(x)}" cy="${xy(y)}" rx="${rx}" ry="2.9" transform="rotate(-19 ${xy(x)} ${xy(y)})" fill="${open?'white':'currentColor'}" stroke="currentColor" stroke-width="1.3"/>`;
    if (e.type !== 'whole' && !beamed) {
      const dir = stemUp ? -1 : 1, sx = x + (stemUp ? 3.9 : -3.9), ey = y+dir*24;
      s += line(sx,y,sx,ey,'stroke="currentColor" stroke-width="1.15"');
      const flags = e.type === '16th' ? 2 : e.type === 'eighth' ? 1 : 0;
      for (let f=0; f<flags; f++) {
        const fy = ey - dir*f*5;
        s += path(`M ${xy(sx)} ${xy(fy)} q 9 ${-dir*5} 5 ${-dir*12} q 2 ${dir*6} -5 ${dir*8} z`);
      }
    }
    if (e.dot) s+=`<circle cx="${xy(x+8.4)}" cy="${xy(y-(e.steps%2===0?3.1:0))}" r="1.5"/>`;
    if (e.acc) s+=accidental(x-10,y,e.acc);
    return s;
  }

  function beams(events, bottom) {
    const groups = [];
    let group = [];
    function close() { if (group.length > 1) groups.push(group); group=[]; }
    for (const e of events) {
      if (!e.n || (e.type!=='eighth' && e.type!=='16th')) { close(); continue; }
      if (group.length && Math.floor(group[0].offset/4)!==Math.floor(e.offset/4)) close();
      group.push(e);
    }
    close();
    const beamed = new Set();
    let markup = '';
    for (const group of groups) {
      const up = group.reduce((sum,e)=>sum+e.steps,0)/group.length < 4;
      const y = e=>bottom-e.steps*4;
      const sx = e=>e.x+(up?3.9:-3.9);
      const beamY = (up ? Math.min : Math.max)(...group.map(y))+(up?-22:22);
      const thick = up?3:-3;
      const bar = (left,right,level) => {
        const top = beamY+level*(up?5:-5);
        return path(`M ${xy(left)} ${xy(top)} H ${xy(right)} v ${thick} H ${xy(left)} Z`);
      };
      markup += bar(sx(group[0]),sx(group.at(-1)),0);
      group.forEach((e,i) => {
        beamed.add(e);
        markup += line(sx(e),y(e),sx(e),beamY,'stroke="currentColor" stroke-width="1.15"');
        const prev = group[i-1], next = group[i+1];
        if (e.type==='16th') {
          if (next?.type==='16th') markup += bar(sx(e),sx(next),1);
          else if (prev?.type!=='16th') markup += bar(sx(e),sx(e)+(next?5:-5),1);
        }
      });
    }
    return {beamed, markup};
  }

  function tie(x1,x2,y,above=false) {
    if (x2-x1 < 5) return '';
    const bend = (above?-1:1)*Math.min(7,(x2-x1)/5);
    return path(`M ${xy(x1)} ${xy(y)} Q ${xy((x1+x2)/2)} ${xy(y+bend)} ${xy(x2)} ${xy(y)} Q ${xy((x1+x2)/2)} ${xy(y+bend*1.5)} ${xy(x1)} ${xy(y)} Z`);
  }

  function prepareBar(bar, chords) {
    // Give fast and accidental notes enough room, while keeping chord and note times aligned.
    const ticks = new Set(bar.events.map(e=>e.offset));
    if (chords) bar.chords.forEach(c=>ticks.add(c.offset));
    const offsets = [...ticks].sort((a,b)=>a-b), coords = new Map();
    let pos = 0;
    for (let i=0; i<offsets.length; i++) {
      const t = offsets[i], e = bar.events.find(ev=>ev.offset===t);
      if (i && e?.acc) pos += 4;
      coords.set(t,pos);
      const span = (offsets[i+1] ?? BAR)-t;
      pos += 13+Math.sqrt(span)*6;
    }
    return {bar, coords, natural: Math.max(112, pos+18), span:pos};
  }

  const svgStyle = '<style>.fl-system{display:block;width:100%;height:auto;overflow:visible;break-inside:avoid;color:#252c29;fill:currentColor;background:white}.fl-system text{font-family:system-ui,sans-serif}.fl-system .fl-note.is-active{color:#007b65;fill:currentColor}.fl-system .fl-note.is-active .fl-halo{opacity:1}.fl-halo{opacity:0;fill:#def5e9}.fl-fret{font-family:ui-monospace,SFMono-Regular,monospace!important;font-weight:650;paint-order:stroke;stroke:white;stroke-width:4px;stroke-linejoin:round}.fl-system .fl-measure{fill:#6b756b;font-size:10px}.fl-system .fl-time{font-family:Georgia,serif;font-weight:700;font-size:21px}</style>';

  function system(row, width, opts, first, last) {
    const staff = opts.view !== 'tab', tab = opts.view !== 'staff';
    const all = row.flatMap(b=>b.bar.events), steps = all.filter(e=>e.n).map(e=>e.steps);
    const anyChords = opts.chords && row.some(b=>b.bar.chords.length);
    const min = steps.length ? Math.min(...steps) : 0, max = steps.length ? Math.max(...steps) : 8;
    const highHead = Math.max(0,(max-8)*4);
    const lowHead = Math.max(0,-min*4);
    const staffTop = 25+(anyChords?18:0)+highHead, bottom=staffTop+32;
    const tabTop = staff ? bottom+lowHead+33 : 24+(anyChords?21:0);
    const gap=9, tabBottom=tabTop+gap*5;
    const height = (tab ? tabBottom : bottom+lowHead)+(!staff && tab ? 32 : 23);
    const left = 11, right = width-10;
    const start = first ? 66 : 48;
    const weights = row.reduce((sum,b)=>sum+b.natural,0);
    let base=start, paint='', bars='', labels='', music='';
    for (const b of row) {
      const w=(right-start)*b.natural/weights;
      const point=t=>base+12+(b.coords.get(t) || 0)/Math.max(b.span,1)*(w-16);
      for (const e of b.bar.events) e.x=point(e.offset);
      b.left=base; b.right=base+w;
      if (opts.chords) for (const c of b.bar.chords) labels+=text(point(c.offset),first||anyChords?27:24,c.label,'font-size="13" font-weight="650" fill="#345e50"');
      base+=w;
    }
    if (staff) {
      for(let i=0;i<5;i++) paint+=line(left,staffTop+i*8,right,staffTop+i*8,'stroke="#87918b" stroke-width=".82"');
      labels+=treble(left+9,bottom)+text(left+16,bottom+16,'8','text-anchor="middle" font-size="8.5" font-weight="650"');
      if (first) labels+=timeSig(45,staffTop+15);
    }
    if(tab) {
      for(let i=0;i<6;i++) paint+=line(left,tabTop+i*gap,right,tabTop+i*gap,'stroke="#a0a8a3" stroke-width=".82"');
      for(let i=0;i<3;i++) labels+=text(left+11,tabTop+12+i*13,'TAB'[i],'text-anchor="middle" font-weight="700" font-size="13" paint-order="stroke" stroke="white" stroke-width="4"');
      if (first && !staff) labels+=timeSig(44,tabTop+20);
    }
    const firstY = staff?staffTop:tabTop, lastY=tab?tabBottom:bottom;
    paint+=line(left,firstY,left,lastY,'stroke="currentColor" stroke-width="1.1"');
    labels+=text(left,12,row[0].bar.number,'class="fl-measure"');
    for (const b of row) {
      const isLast=last && b===row.at(-1);
      const bx=b.right - (isLast?3:0);
      if(staff) bars+=line(bx,staffTop,bx,bottom,'stroke="currentColor" stroke-width="1.05"');
      if(tab) bars+=line(bx,tabTop,bx,tabBottom,'stroke="currentColor" stroke-width="1.05"');
      if(isLast) {
        if(staff) bars+=line(bx+3,staffTop,bx+3,bottom,'stroke="currentColor" stroke-width="2.5"');
        if(tab) bars+=line(bx+3,tabTop,bx+3,tabBottom,'stroke="currentColor" stroke-width="2.5"');
      }
      const beam = staff ? beams(b.bar.events,bottom) : {beamed:new Set(),markup:''};
      for (const e of b.bar.events) {
        const x=e.x, n=e.n;
        if (!n) { music+=rest(e.units===BAR ? (b.left+b.right)/2 : x,staff ? staffTop+16 : tabTop+18,e); continue; }
        music+=`<g data-note="${n.index}" class="fl-note">`;
        if(staff) {
          const y=bottom-e.steps*4, up=e.steps<4;
          music+=`<ellipse class="fl-halo" cx="${xy(x)}" cy="${xy(y)}" rx="9" ry="6"/>`;
          if(e.steps<=-2) for(let k=-2;k>=e.steps;k-=2) music+=line(x-7,bottom-k*4,x+7,bottom-k*4,'stroke="currentColor" stroke-width="1"');
          if(e.steps>=10) for(let k=10;k<=e.steps;k+=2) music+=line(x-7,bottom-k*4,x+7,bottom-k*4,'stroke="currentColor" stroke-width="1"');
          music+=notehead(x,y,e,up,beam.beamed.has(e));
        }
        if(tab && n.tab) {
          const y=tabTop+(n.tab.string-1)*gap;
          music+=`<rect class="fl-halo" x="${xy(x-9)}" y="${xy(y-6)}" width="18" height="12" rx="3"/>`+
            text(x,y+3.7,n.tab.fret,'text-anchor="middle" class="fl-fret" font-size="11"');
        } else if (tab) {
          music+=text(x,tabTop+26,'×','text-anchor="middle" class="fl-fret" font-size="14"')+'<title>超出標準調弦 24 格音域</title>';
        }
        if (tab && !staff && e.type!=='whole') {
          const ry=tabBottom+12, end=ry+(e.type==='half'?5:10);
          music+=line(x,ry,x,end,'stroke="currentColor" stroke-width="1.15"');
          const flags=e.type==='16th'?2:e.type==='eighth'?1:0;
          for(let k=0;k<flags;k++) music+=line(x,end-k*3,x+5,end-k*3-2.5,'stroke="currentColor" stroke-width="1.5"');
          if(e.dot) music+=`<circle cx="${xy(x+4)}" cy="${xy(ry+2)}" r="1.2"/>`;
        }
        music+='</g>';
      }
      music+=beam.markup;
    }
    for(let i=0;i<all.length;i++) {
      const e=all[i];
      if(!e.n) continue;
      const next=all[i+1], up=e.steps>=4;
      const y=bottom-e.steps*4+(up?-4.5:4.5);
      const tabY=e.n.tab ? tabTop+(e.n.tab.string-1)*gap+5 : 0;
      if (e.outgoing) {
        const x2=next?.n===e.n?next.x-4:right-3;
        if(staff) music+=tie(e.x+4,x2,y,up);
        if(tab && !staff && e.n.tab) music+=tie(e.x+4,x2,tabY);
      }
      if(i===0 && e.incoming) {
        if(staff) music+=tie(start-3,e.x-4,y,up);
        if(tab && !staff && e.n.tab) music+=tie(start-3,e.x-4,tabY);
      }
    }
    return `<svg class="fl-system" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="第 ${row[0].bar.number} 至 ${row.at(-1).bar.number} 小節">${paint}${bars}${labels}${music}</svg>`;
  }

  function timeSig(x,y) {
    return text(x,y,'4','class="fl-time" text-anchor="middle"')+text(x,y+16,'4','class="fl-time" text-anchor="middle"');
  }

  function render(container, score, options = {}) {
    if (!container) return;
    const {bars,played}=analyze(score);
    const opts={view:options.view || 'both', chords:options.chords !== false};
    const width=Math.max(235,Math.round(container.clientWidth || container.getBoundingClientRect().width || 700));
    const groups=[];
    let row=[], used=0;
    const rowLimit = Math.min(4, Math.max(1, Math.floor((width-52)/155)));
    for(const bar of bars) {
      const b=prepareBar(bar,opts.chords);
      if(row.length && (row.length>=rowLimit || used+b.natural>width-66)) {
        groups.push(row); row=[]; used=0;
      }
      row.push(b); used+=b.natural;
    }
    if(row.length) groups.push(row);
    let html=svgStyle+groups.map((r,i)=>system(r,width,opts,i===0,i===groups.length-1)).join('');
    if(opts.view!=='staff' && played.some(n=>!n.tab)) html+='<p style="margin:.25rem .7rem;font-size:.85rem;color:#5b635f">× 表示該音超出吉他標準調弦的 24 格音域。</p>';
    container.innerHTML=html;
    layouts.set(container,{active:-1,groups:[]});
  }

  function setActive(container, index) {
    const state=layouts.get(container);
    if (!state || state.active===index) return;
    for (const g of state.groups) g.classList.remove('is-active');
    state.active=index;
    state.groups=Number.isInteger(index) && index>=0 ? container.querySelectorAll('[data-note="'+index+'"]') : [];
    for (const g of state.groups) g.classList.add('is-active');
  }

  function xmlChord(chord) {
    const m=chord.label.match(/^([A-G])([#♯b♭]?)([^/]*)(?:\/([A-G])([#♯b♭]?))?$/);
    if(!m) return '';
    const alt=a=>a==='b'||a==='♭'?-1:1;
    const names={'':'major','m':'minor','min':'minor','maj':'major','M':'major','7':'dominant','m7':'minor-seventh','maj7':'major-seventh','M7':'major-seventh','dim':'diminished','aug':'augmented','sus4':'suspended-fourth','sus2':'suspended-second','5':'power','6':'major-sixth','m6':'minor-sixth'};
    return '<harmony><root><root-step>'+m[1]+'</root-step>'+(m[2]?'<root-alter>'+alt(m[2])+'</root-alter>':'')+'</root><kind text="'+esc(m[3])+'">'+(names[m[3]]||'other')+'</kind>'+
      (m[4]?'<bass><bass-step>'+m[4]+'</bass-step>'+(m[5]?'<bass-alter>'+alt(m[5])+'</bass-alter>':'')+'</bass>':'')+
      (chord.offset?'<offset>'+chord.offset+'</offset>':'')+'<staff>1</staff></harmony>';
  }

  function xmlEvent(e, staff) {
    const outside=Boolean(staff===2 && e.n && !e.n.tab);
    const n=outside?null:e.n, fullRest=!n && e.units===BAR;
    let xml=outside && !e.incoming ? '<direction placement="above"><direction-type><words>× 超出吉他音域</words></direction-type><staff>2</staff></direction>' : '';
    xml+='<note'+(staff===2?' dynamics="0"':'')+'>';
    if(n) {
      const p=pitch(n.midi);
      xml+='<pitch><step>'+p.step+'</step>'+(p.alter?'<alter>1</alter>':'')+'<octave>'+p.octave+'</octave></pitch>';
    } else xml+=fullRest?'<rest measure="yes"/>':'<rest/>';
    xml+='<duration>'+e.units+'</duration>';
    if(n && e.incoming) xml+='<tie type="stop"/>';
    if(n && e.outgoing) xml+='<tie type="start"/>';
    xml+='<voice>'+staff+'</voice><type>'+e.type+'</type>'+(e.dot?'<dot/>':'');
    if(e.acc && staff===1) xml+='<accidental>'+e.acc+'</accidental>';
    xml+='<staff>'+staff+'</staff>';
    let notation='';
    if(n && e.incoming) notation+='<tied type="stop"/>';
    if(n && e.outgoing) notation+='<tied type="start"/>';
    if(n?.tab) notation+='<technical><string>'+n.tab.string+'</string><fret>'+n.tab.fret+'</fret></technical>';
    if(notation) xml+='<notations>'+notation+'</notations>';
    return xml+'</note>';
  }

  function musicXML(score) {
    const {bars}=analyze(score);
    const name=esc(score.title || '未命名樂譜'), tempo = Math.max(1,Number(score.bpm)||100);
    const tuning=OPEN.slice().reverse().map((m,i)=>{
      const p=pitch(m);
      return '<staff-tuning line="'+(i+1)+'"><tuning-step>'+p.step+'</tuning-step><tuning-octave>'+p.octave+'</tuning-octave></staff-tuning>';
    }).join('');
    const attributes='<attributes><divisions>'+DIVISIONS+'</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves>'+
      '<clef number="1"><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef><clef number="2"><sign>TAB</sign><line>5</line></clef>'+
      '<staff-details number="2"><staff-lines>6</staff-lines>'+tuning+'</staff-details></attributes>';
    const direction='<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>'+tempo+'</per-minute></metronome></direction-type><staff>1</staff><sound tempo="'+tempo+'"/></direction>';
    return '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="4.0"><work><work-title>'+name+'</work-title></work><part-list><score-part id="P1"><part-name>Guitar</part-name><score-instrument id="I1"><instrument-name>Acoustic Guitar</instrument-name></score-instrument><midi-instrument id="I1"><midi-channel>1</midi-channel><midi-program>25</midi-program></midi-instrument></score-part></part-list><part id="P1">'+
      bars.map((b,i)=>'<measure number="'+b.number+'">'+(i===0?attributes+direction:'')+b.chords.map(xmlChord).join('')+
        b.events.map(e=>xmlEvent(e,1)).join('')+'<backup><duration>'+BAR+'</duration></backup>'+
        b.events.map(e=>xmlEvent(e,2)).join('')+(i===bars.length-1?'<barline location="right"><bar-style>light-heavy</bar-style></barline>':'')+'</measure>').join('\n')+'</part></score-partwise>';
  }

  window.Notation=Object.freeze({render,setActive,musicXML});
})();

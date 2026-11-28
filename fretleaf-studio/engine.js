/* Offline melody transcription worker. All frequency estimates use concert pitch. */
'use strict';

const FFT_SIZE = 2048;
const HOP = 160;
const LOW_NOTE = 36;
const HIGH_NOTE = 95;
const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function fftPlan(n) {
  const reversed = new Uint16Array(n);
  const window = new Float32Array(n);
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n; i++) {
    reversed[i] = (reversed[i >> 1] >> 1) | ((i & 1) ? n >> 1 : 0);
    window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    if (i < n / 2) {
      cos[i] = Math.cos(-2 * Math.PI * i / n);
      sin[i] = Math.sin(-2 * Math.PI * i / n);
    }
  }
  const real = new Float64Array(n);
  const imag = new Float64Array(n);
  const magnitudes = new Float64Array(n / 2);
  return (signal, center) => {
    imag.fill(0);
    for (let i = 0; i < n; i++) {
      const pos = center + i - n / 2;
      real[reversed[i]] = (pos >= 0 && pos < signal.length ? signal[pos] : 0) * window[i];
    }
    for (let width = 2; width <= n; width *= 2) {
      const half = width / 2, stride = n / width;
      for (let start = 0; start < n; start += width) {
        for (let j = 0; j < half; j++) {
          const a = start + j, b = a + half, t = j * stride;
          const re = cos[t] * real[b] - sin[t] * imag[b];
          const im = sin[t] * real[b] + cos[t] * imag[b];
          real[b] = real[a] - re;
          imag[b] = imag[a] - im;
          real[a] += re;
          imag[a] += im;
        }
      }
    }
    for (let i = 0; i < magnitudes.length; i++) {
      magnitudes[i] = Math.hypot(real[i], imag[i]);
    }
    return magnitudes;
  };
}

function extractPeaks(spectrum, rate) {
  const peaks = [];
  let max = 0, sum = 0, sumSq = 0;
  const top = Math.min(spectrum.length - 2, Math.floor(5000 * FFT_SIZE / rate));
  for (let i = 6; i <= top; i++) {
    const v = spectrum[i];
    max = Math.max(max, v);
    sum += v; sumSq += v * v;
  }
  for (let i = 6; i <= top; i++) {
    const v = spectrum[i];
    if (v < max * 0.045 || v < spectrum[i - 1] || v <= spectrum[i + 1]) continue;
    const left = Math.log(spectrum[i - 1] + 1e-12), mid = Math.log(v + 1e-12);
    const right = Math.log(spectrum[i + 1] + 1e-12);
    const shift = clamp(0.5 * (left - right) / (left - 2 * mid + right || 1), -0.5, 0.5);
    const hz = (i + shift) * rate / FFT_SIZE;
    const pitch = 69 + 12 * Math.log2(hz / 440);
    peaks.push({pitch, hz, amp: Math.exp(mid - 0.25 * (left - right) * shift) / (max || 1)});
  }
  // Wideband percussion can have many local peaks but little tonal concentration.
  const tonal = clamp(1 - 4 * sum * sum / ((top - 5) * (sumSq || 1)), 0, 1);
  return {peaks, tonal};
}

function scorePitches(peaks, tonal) {
  const direct = new Float32Array(128);
  const support = new Float32Array(128);
  for (const p of peaks) {
    const midi = Math.round(p.pitch);
    if (midi < LOW_NOTE || midi >= direct.length) continue;
    const weight = p.amp * Math.exp(-1.7 * (p.pitch - midi) ** 2);
    direct[midi] = Math.max(direct[midi], weight);
    for (const [partial, factor] of [[2, 0.52], [3, 0.32], [4, 0.15], [5, 0.08]]) {
      const fundamental = p.pitch - 12 * Math.log2(partial);
      const note = Math.round(fundamental);
      if (note < LOW_NOTE || note > HIGH_NOTE) continue;
      support[note] += weight * factor * Math.exp(-2.4 * (fundamental - note) ** 2);
    }
  }
  const candidates = [];
  for (let midi = LOW_NOTE; midi <= HIGH_NOTE; midi++) {
    if (direct[midi] < 0.075) continue;
    const score = (direct[midi] + support[midi] * Math.sqrt(direct[midi])) *
      (1 + 0.10 * Math.exp(-((midi - 69) ** 2) / 200));
    candidates.push({midi, score});
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0]?.score || 0;
  if (!top || tonal < 0.18) return [];
  const rival = candidates[1]?.score || 0;
  return candidates.slice(0, 5).filter(p => p.score > top * 0.32).map(p => ({
    midi: p.midi,
    likelihood: Math.log(p.score / top),
    confidence: clamp((0.5 + 0.45 * (1 - rival / top)) * (0.56 + 0.44 * tonal) * p.score / top, 0, 1)
  }));
}

function guessTriad(peaks) {
  const chroma = new Float64Array(12);
  const roots = [];
  for (const peak of peaks) {
    if (peak.amp < 0.13 || peak.pitch < 35.5 || peak.pitch > 90.5) continue;
    const note = Math.round(peak.pitch);
    if (Math.abs(peak.pitch - note) > 0.38) continue;
    const overtone = roots.some(base => {
      const ratio = peak.hz / base.hz, harmonic = Math.round(ratio);
      return harmonic >= 2 && harmonic <= 9 && Math.abs(12 * Math.log2(ratio / harmonic)) < 0.32 &&
        peak.amp <= base.amp * (harmonic <= 3 ? 1.8 : 1);
    });
    if (overtone) continue;
    roots.push(peak);
    chroma[note % 12] = Math.max(chroma[note % 12], peak.amp);
  }
  if (roots.length < 3) return -1;
  const total = chroma.reduce((s, v) => s + v, 0);
  let best = -1, bestScore = 0, runner = 0;
  for (let id = 0; id < 24; id++) {
    const root = id % 12;
    const a = chroma[root], b = chroma[(root + (id < 12 ? 4 : 3)) % 12], c = chroma[(root + 7) % 12];
    if (Math.min(a, b, c) < 0.14) continue;
    const score = (a + b + c) / total;
    if (score > bestScore) { runner = bestScore; bestScore = score; best = id; }
    else runner = Math.max(runner, score);
  }
  return bestScore > 0.72 && bestScore - runner > 0.09 ? best : -1;
}

function resolveContour(frames) {
  const contour = new Int16Array(frames.length).fill(-1);
  const confidence = new Float32Array(frames.length);
  let start = 0;
  while (start < frames.length) {
    if (!frames[start].candidates.length) { start++; continue; }
    let prev = [];
    let end = start;
    for (; end < frames.length && frames[end].candidates.length; end++) {
      const current = frames[end].candidates;
      for (const c of current) {
        let best = -Infinity, bestIndex = -1;
        for (let i = 0; i < prev.length; i++) {
          const interval = Math.abs(c.midi - prev[i].midi);
          const cost = interval ? 0.58 + 0.045 * Math.min(17, interval) : 0;
          const value = prev[i].path - cost;
          if (value > best) {best = value; bestIndex = i;}
        }
        c.path = (prev.length ? best : 0) + c.likelihood;
        c.prev = bestIndex;
      }
      prev = current;
    }
    let idx = prev.reduce((best, c, i) => c.path > prev[best].path ? i : best, 0);
    for (let j = end - 1; j >= start; j--) {
      const c = frames[j].candidates[idx];
      contour[j] = c.midi;
      confidence[j] = c.confidence;
      idx = c.prev;
    }
    start = end;
  }
  // A single unstable analysis frame should not interrupt a sustained pitch.
  for (let i = 1; i + 1 < contour.length; i++) {
    if (contour[i - 1] === contour[i + 1] && contour[i - 1] !== contour[i]) {
      contour[i] = contour[i - 1];
      confidence[i] = Math.min(confidence[i - 1], confidence[i + 1]);
    }
  }
  return {contour, confidence};
}

function segment(frames, contour, confidence, dt) {
  const events = [];
  let start = 0;
  function close(end) {
    const midi = contour[start];
    if (midi < 0 || (end - start) * dt < 0.058) return;
    let sum = 0;
    for (let i = start; i < end; i++) sum += confidence[i];
    events.push({midi, from: Math.max(0, (start - 0.5) * dt), to: (end - 0.5) * dt, confidence: sum / (end - start)});
  }
  for (let i = 1; i <= frames.length; i++) {
    const change = i === frames.length || contour[i] !== contour[start];
    let attacked = false;
    if (!change && contour[i] >= 0 && (i - start) * dt > 0.095 && i + 2 < frames.length) {
      const f = frames[i];
      const before = frames[Math.max(start, i - 3)];
      const after = frames[i + 2];
      const next = frames[i + 1], prior = frames[i - 1];
      const rise = f.energy - prior.energy;
      const envelopeAttack = rise > 0.30 * f.energy && rise >= next.energy - f.energy &&
        rise > prior.energy - frames[i - 2].energy && after.energy > 1.9 * before.energy;
      // Require a local attack and energy recovery to avoid splitting steady vibrato.
      const spectralAttack = f.flux > 0.085 && f.flux >= prior.flux && f.flux > next.flux &&
        after.energy > before.energy * 1.65;
      attacked = (envelopeAttack || spectralAttack) && contour[i + 2] === contour[i];
    }
    if (change || attacked) { close(i); start = i; }
  }
  return events;
}

function estimateTempo(events, manual) {
  if (Number.isFinite(manual) && manual >= 30 && manual <= 300) {
    return {bpm: Math.round(manual * 100) / 100, tempoConfidence: 1, tempoSource: 'manual'};
  }
  if (events.length < 3) return {bpm: 100, tempoConfidence: 0, tempoSource: 'fallback'};
  // Consecutive and longer onset intervals jointly vote for a quarter-note pulse.
  // Wider intervals remove drift bias from the finite analysis hop.
  const sampled = events.length > 2400 ? events.slice(0, 2400) : events;
  const gaps = [];
  for (let i = 1; i < sampled.length; i++) {
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      const gap = sampled[i].from - sampled[j].from;
      if (gap < 0.09 || gap > 4.5) continue;
      gaps.push({gap, weight: (0.35 + 0.65 * sampled[i].confidence) / Math.sqrt(i - j), adjacent: j === i - 1});
    }
  }
  if (!gaps.length) return {bpm: 100, tempoConfidence: 0, tempoSource: 'fallback'};
  const scored = [];
  for (let bpm = 50; bpm <= 190; bpm++) {
    let hit = 0, total = 0;
    for (const {gap, weight, adjacent} of gaps) {
      const beats = gap * bpm / 60;
      let value = 0;
      for (const [grid, strength] of [[1, 1], [0.5, 0.79], [0.25, 0.52]]) {
        const tick = Math.round(beats / grid) * grid;
        if (tick < 0.25) continue;
        const err = (beats - tick) * 60 / bpm;
        const likelihood = Math.exp(-0.5 * (err / (0.023 + gap * 0.008)) ** 2);
        value = Math.max(value, strength * likelihood);
      }
      if (adjacent) value *= 0.94 + 0.06 * Math.exp(-((beats - 1) ** 2));
      hit += weight * value; total += weight;
    }
    const preference = 0.97 + 0.03 * Math.exp(-((bpm - 108) ** 2) / 2400);
    scored.push({bpm, score: preference * hit / total});
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const alternate = scored.find(p => Math.abs(p.bpm - best.bpm) > 6);
  const confidence = clamp((best.score - 0.42) * 1.2 + (best.score - alternate.score), 0, 0.95);
  return {bpm: best.bpm, tempoConfidence: confidence, tempoSource: 'estimated'};
}

function quantize(events, bpm, totalSeconds) {
  const unitsPerSecond = bpm / 60 * 4;
  const kept = [];
  for (const e of events) {
    const from = Math.round(e.from * unitsPerSecond);
    let to = Math.max(from + 1, Math.round(Math.min(totalSeconds, e.to) * unitsPerSecond));
    const prev = kept[kept.length - 1];
    if (prev && prev.from === from) {
      if (e.to - e.from > prev.seconds) kept.pop();
      else continue;
    }
    const earlier = kept[kept.length - 1];
    if (earlier && earlier.to > from) earlier.to = from;
    kept.push({from, to, midi: e.midi, seconds: e.to - e.from, confidence: Math.round(e.confidence * 100) / 100});
  }
  return kept.map(e => ({midi:e.midi, start:e.from / 4, duration:(e.to - e.from) / 4, confidence:e.confidence}));
}

function chordChanges(frames, dt, bpm) {
  const buckets = [];
  const beatRate = bpm / 60;
  frames.forEach((frame, i) => {
    const beat = Math.floor(i * dt * beatRate);
    const bucket = buckets[beat] || (buckets[beat] = {n:0, votes:new Uint16Array(24)});
    bucket.n++;
    if (frame.chord >= 0) bucket.votes[frame.chord]++;
  });
  const result = [];
  let previous = -1;
  buckets.forEach((bucket, beat) => {
    const id = bucket.votes.reduce((best, v, i, all) => v > all[best] ? i : best, 0);
    const current = bucket.votes[id] > Math.max(3, bucket.n * 0.57) ? id : -1;
    if (current >= 0 && previous !== current) {
      result.push({beat, label:NAMES[current % 12] + (current >= 12 ? 'm' : '')});
    }
    previous = current;
  });
  return result;
}

self.onmessage = function ({data}) {
  try {
    const {samples, sampleRate, tempo} = data;
    if (!samples?.length || sampleRate !== 11025) throw Error('音訊資料格式有誤，請重新匯入音檔。');
    if (samples.length < sampleRate * 0.09) throw Error('音檔太短，請選擇含有完整音符的片段。');
    const count = Math.ceil(samples.length / HOP), dt = HOP / sampleRate;
    const rms = new Float32Array(count);
    let loudest = 0;
    for (let i = 0; i < count; i++) {
      let sum = 0;
      const end = Math.min(samples.length, (i + 1) * HOP);
      for (let s = i * HOP; s < end; s++) sum += samples[s] * samples[s];
      rms[i] = Math.sqrt(sum / Math.max(1, end - i * HOP));
      loudest = Math.max(loudest, rms[i]);
    }
    const threshold = Math.max(0.000035, loudest * 0.011);
    const transform = fftPlan(FFT_SIZE);
    const previous = new Float64Array(FFT_SIZE / 2);
    const frames = [];
    for (let i = 0; i < count; i++) {
      const energy = rms[i];
      if (energy < threshold) {
        frames.push({candidates:[], flux:0, energy, chord:-1});
        previous.fill(0);
      } else {
        const spectrum = transform(samples, i * HOP + Math.floor(HOP / 2));
        let rise = 0, sum = 1e-12;
        for (let k = 5; k < spectrum.length; k++) {
          const v = Math.sqrt(spectrum[k]);
          rise += Math.max(0, v - previous[k]); sum += v; previous[k] = v;
        }
        const {peaks, tonal} = extractPeaks(spectrum, sampleRate);
        frames.push({candidates:scorePitches(peaks, tonal), flux:rise / sum, energy, chord:tonal > 0.25 ? guessTriad(peaks) : -1});
      }
      if (i % 40 === 0) self.postMessage({type:'progress', value:0.93 * i / count});
    }
    const {contour, confidence} = resolveContour(frames);
    const events = segment(frames, contour, confidence, dt);
    if (!events.length) throw Error('這段音檔沒有辨識出穩定的音高，請改用旋律較清楚的錄音。');
    self.postMessage({type:'progress', value:0.95});
    const timing = estimateTempo(events, tempo);
    const seconds = samples.length / sampleRate;
    const notes = quantize(events, timing.bpm, seconds);
    const last = notes[notes.length - 1];
    const length = Math.max(last.start + last.duration, Math.round(seconds * timing.bpm / 60 * 4) / 4);
    self.postMessage({type:'done', ...timing, notes, length, chords:chordChanges(frames, dt, timing.bpm)});
  } catch (error) {
    self.postMessage({type:'error', message:error.message || '無法分析這段音檔，請重新選取。'});
  }
};

/* Local decoding, sample-rate conversion and synchronized practice playback. */
(() => {
  'use strict';

  const audioType = () => window.AudioContext || window.webkitAudioContext;
  const offlineType = () => window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  // A score is monophonic. Find the first note that has yet to finish.
  function firstActive(notes, seconds) {
    let lo = 0, hi = notes.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (notes[mid].to <= seconds) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  class AudioDesk {
    constructor({onTick = () => {}, onEnded = () => {}} = {}) {
      this._onTick = onTick;
      this._onEnded = onEnded;
      this._context = null;
      this._decoder = null;
      this._buffer = null;
      this._notes = [];
      this._mode = 'original';
      this._rate = 1;
      this._pos = 0;
      this._startedAt = 0;
      this._running = false;
      this._intent = 0;
      this._timer = null;
      this._voices = new Set();
      this._bus = null;
      this._wave = null;
    }

    async decode(arrayBuffer) {
      if (!arrayBuffer?.byteLength) throw new Error('音檔沒有可讀取的內容。');
      const Offline = offlineType();
      if (!Offline) throw new Error('此瀏覽器無法在裝置上解碼音檔，請改用新版 Safari 或 Chrome。');
      // Decoding is independent of the playback context and its autoplay state.
      this._decoder ||= new Offline(1, 1, 44100);
      return this._decoder.decodeAudioData(arrayBuffer);
    }

    static async mono(buffer) {
      const rate = 11025;
      const length = Math.max(1, Math.ceil(buffer.length * rate / buffer.sampleRate));
      if (buffer.numberOfChannels === 1 && buffer.sampleRate === rate) return buffer.getChannelData(0).slice();
      const Offline = offlineType();
      if (!Offline) throw new Error('此瀏覽器無法進行音訊取樣。');
      const ctx = new Offline(1, length, rate);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
      const rendered = await ctx.startRendering();
      return rendered.getChannelData(0);
    }

    setTrack(buffer, score) {
      this._intent++;
      this._halt();
      this._buffer = buffer || null;
      this._pos = 0;
      const unit = 60 / (Number(score?.bpm) || 100);
      this._notes = (score?.notes || []).filter(n => Number.isFinite(n.midi) && Number.isFinite(n.start) && n.duration > 0)
        .map(n => ({from: n.start * unit, to: (n.start + n.duration) * unit, midi: n.midi,
          accent: Math.abs(n.start % 4) < 0.001 ? 1.08 : 1}));
      this._tick();
    }

    get duration() { return this._buffer?.duration || 0; }
    get playing() { return this._running; }
    get seconds() {
      if (!this._running) return this._pos;
      return Math.min(this.duration, this._pos + Math.max(0, this._context.currentTime - this._startedAt) * this._rate);
    }

    async play() {
      if (!this._buffer || this._running) return;
      const intent = ++this._intent;
      if (!this._context) {
        const Context = audioType();
        if (!Context) throw new Error('此瀏覽器無法播放音訊。');
        this._context = new Context();
      }
      if (this._context.state !== 'running') await this._context.resume();
      if (intent !== this._intent || !this._buffer) return;
      if (this._pos >= this.duration) this._pos = 0;
      this._start();
    }

    pause() {
      this._intent++;
      this._pos = this.seconds;
      this._halt();
      this._tick();
    }

    seek(seconds) {
      if (!Number.isFinite(seconds)) return;
      const restart = this._running;
      this._halt();
      this._pos = clamp(seconds, 0, this.duration);
      if (restart && this._pos >= this.duration) this._finish();
      else if (restart) this._start();
      else this._tick();
    }

    setMode(mode) {
      if (!['original', 'melody'].includes(mode) || mode === this._mode) return;
      const position = this.seconds, restart = this._running;
      this._halt();
      this._pos = position;
      this._mode = mode;
      if (restart && position < this.duration) this._start();
      else if (restart) this._finish();
      else this._tick();
    }

    setRate(rate) {
      if (!Number.isFinite(rate) || rate <= 0 || rate === this._rate) return;
      const position = this.seconds, restart = this._running;
      this._halt();
      this._pos = position;
      this._rate = rate;
      if (restart && position < this.duration) this._start();
      else if (restart) this._finish();
      else this._tick();
    }

    _tick() { this._onTick(this.seconds, this.playing); }

    _start() {
      const ctx = this._context;
      const bus = this._bus = ctx.createGain();
      this._startedAt = ctx.currentTime;
      bus.gain.setValueAtTime(0.0001, ctx.currentTime);
      bus.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 0.008);
      bus.connect(ctx.destination);
      this._running = true;
      if (this._mode === 'original') {
        const source = ctx.createBufferSource();
        source.buffer = this._buffer;
        source.playbackRate.value = this._rate;
        source.connect(bus);
        this._trackVoice(source, []);
        source.start(ctx.currentTime, this._pos);
      } else {
        this._next = firstActive(this._notes, this._pos);
        this._schedule();
      }
      this._timer = window.setInterval(() => {
        if (this.seconds >= this.duration) { this._finish(); return; }
        if (this._mode === 'melody') this._schedule();
        this._tick();
      }, 30);
      this._tick();
    }

    _finish() {
      this._pos = this.duration;
      this._halt();
      this._tick();
      this._onEnded();
    }

    _halt() {
      window.clearInterval(this._timer);
      this._timer = null;
      this._running = false;
      if (!this._bus) return;
      const bus = this._bus;
      const now = this._context.currentTime;
      bus.gain.cancelScheduledValues(now);
      bus.gain.setTargetAtTime(0.0001, now, 0.002);
      for (const source of this._voices) {
        try { source.stop(now + 0.012); } catch (_) { /* Already ended. */ }
      }
      this._voices.clear();
      window.setTimeout(() => bus.disconnect(), 30);
      this._bus = null;
    }

    _trackVoice(source, effects) {
      this._voices.add(source);
      source.onended = () => {
        this._voices.delete(source);
        source.disconnect();
        for (const effect of effects) effect.disconnect();
      };
    }

    _schedule() {
      const start = this.seconds;
      const horizon = Math.min(this.duration, start + 0.38 * this._rate);
      while (this._next < this._notes.length && this._notes[this._next].from < horizon) {
        const note = this._notes[this._next++];
        if (note.to > start) this._pluck(note, Math.max(start, note.from));
      }
    }

    _pluck(note, start) {
      const ctx = this._context;
      const at = Math.max(ctx.currentTime, this._startedAt + (start - this._pos) / this._rate);
      const span = (Math.min(this.duration, note.to) - start) / this._rate;
      if (span <= 0.002) return;
      const elapsed = (start - note.from) / this._rate;
      if (!this._wave) {
        this._wave = ctx.createPeriodicWave(new Float32Array(9), Float32Array.of(0, 1, 0.47, 0.26, 0.15, 0.1, 0.06, 0.04, 0.018));
      }
      const voice = ctx.createOscillator();
      voice.setPeriodicWave(this._wave);
      voice.frequency.value = 440 * 2 ** ((note.midi - 69) / 12);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.45;
      const bright = Math.min(ctx.sampleRate * 0.45, 1200 + voice.frequency.value * 7);
      filter.frequency.setValueAtTime(Math.max(650, bright * Math.exp(-elapsed * 2)), at);
      filter.frequency.exponentialRampToValueAtTime(Math.max(650, bright * Math.exp(-(elapsed + span) * 2)), at + span);
      const amp = ctx.createGain();
      const peak = (0.11 + 0.32 * Math.exp(-elapsed * 2.8)) * note.accent;
      const attack = Math.min(0.007, span * 0.2), release = Math.min(0.045, span * 0.30);
      amp.gain.setValueAtTime(0.0001, at);
      amp.gain.exponentialRampToValueAtTime(peak, at + attack);
      amp.gain.exponentialRampToValueAtTime((0.11 + 0.32 * Math.exp(-(elapsed + span - release) * 2.8)) * note.accent, at + span - release);
      amp.gain.exponentialRampToValueAtTime(0.0001, at + span);
      voice.connect(filter); filter.connect(amp); amp.connect(this._bus);
      this._trackVoice(voice, [filter, amp]);
      voice.start(at);
      voice.stop(at + span);
    }
  }
  window.AudioDesk = AudioDesk;
})();

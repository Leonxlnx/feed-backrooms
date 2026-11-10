import * as THREE from 'three';

const NONE = { setVolume() {}, setPlaybackRate() {}, stop() {}, kill() {}, isPlaying: false };

// every sound is a downloaded recording listed in /assets/sfx/manifest.json (see CREDITS.md there)
export class AudioSys {
  constructor(camera, scene) {
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    this.scene = scene;
    this.buf = {};
  }

  async load(onProgress) {
    let manifest = {};
    try {
      const r = await fetch('/assets/sfx/manifest.json');
      if (r.ok) manifest = await r.json();
    } catch { /* silent game */ }
    const loader = new THREE.AudioLoader();
    const jobs = [];
    let done = 0, total = 0;
    for (const [key, files] of Object.entries(manifest)) {
      if (!Array.isArray(files)) continue;
      this.buf[key] = [];
      for (const f of files) {
        total++;
        jobs.push(
          loader.loadAsync('/assets/sfx/' + f)
            .then((b) => { this.buf[key].push(b); })
            .catch(() => {})
            .finally(() => { done++; if (onProgress) onProgress(done / total); })
        );
      }
    }
    await Promise.all(jobs);
  }

  resume() {
    const ctx = this.listener.context;
    if (ctx.state !== 'running') ctx.resume();
  }

  _pick(key) {
    const a = this.buf[key];
    if (!a || !a.length) return null;
    return a[Math.floor(Math.random() * a.length)];
  }

  // `this.rec` (set by tools/record.js) taps every sound call so the trailer recorder can mix the
  // exact same sounds offline, frame-accurately, instead of playing them live
  play(key, volume = 1, rate = 1, rateVar = 0.06) {
    const b = this._pick(key);
    if (!b) return NONE;
    const r = rate * (1 + (Math.random() - 0.5) * 2 * rateVar);
    if (this.rec) return this.rec.oneShot(b, volume, r, null, 0);
    const a = new THREE.Audio(this.listener);
    a.setBuffer(b);
    a.setVolume(volume);
    a.setPlaybackRate(r);
    a.play();
    return a;
  }

  playAt(key, pos, volume = 1, o = {}) {
    const b = this._pick(key);
    if (!b) return NONE;
    const r = (o.rate ?? 1) * (1 + (Math.random() - 0.5) * 2 * (o.rateVar ?? 0.07));
    if (this.rec) {
      const w = pos.clone();
      if (o.parent) o.parent.localToWorld(w);
      return this.rec.oneShot(b, volume, r, { pos: w, ref: o.ref ?? 4, rolloff: o.rolloff ?? 1.5 }, o.delay ?? 0);
    }
    const a = new THREE.PositionalAudio(this.listener);
    a.setBuffer(b);
    a.setRefDistance(o.ref ?? 4);
    a.setRolloffFactor(o.rolloff ?? 1.5);
    a.setVolume(volume);
    a.setPlaybackRate(r);
    // o.parent: ride along with a moving object (pos is then local to it)
    const parent = o.parent || this.scene;
    a.position.copy(pos);
    parent.add(a);
    a.updateMatrixWorld(true);
    const end = a.onEnded.bind(a);
    a.onEnded = () => { end(); parent.remove(a); };
    a.kill = () => { if (a.isPlaying) a.stop(); parent.remove(a); };
    a.play(o.delay ?? 0);
    return a;
  }

  loop(key, volume = 0) {
    const b = this._pick(key);
    if (!b) return NONE;
    if (this.rec) return this.rec.loop(b, volume);
    const a = new THREE.Audio(this.listener);
    a.setBuffer(b);
    a.setLoop(true);
    a.setVolume(volume);
    a.play();
    return a;
  }
}

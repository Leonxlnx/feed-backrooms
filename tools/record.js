// Films the trailer: an autopilot plays the monster while the game is stepped frame by frame, every frame is
// composited with the HUD and sent to the dev server, and the same sound calls the game makes are mixed offline.
//
//   npm run dev, then open  http://localhost:5199/?seed=7&record=1&every=2
//   (the take in media/ used exactly that: seed 7, every second frame = 30 fps). It writes
//   .capture/frames/f00000.jpg, f00002.jpg, ... and, when the last frame is done, .capture/audio/track.wav.
//   Renumber the frames without gaps, then:
//     ffmpeg -framerate 30 -i seq/s%05d.jpg -i .capture/audio/track.wav -c:v libx264 -crf 23 \
//            -pix_fmt yuv420p -c:a aac -b:a 160k -shortest media/feed-gameplay.mp4
//   Rehearse without rendering from the console:  (await import('/tools/record.js')).record({ dry: true })
//
// Keep the window in the foreground: a browser throttles a hidden or covered window and the take crawls.
// Progress lives in window.__rec.

const G = window.__G, D = G.dev;
const FPS = 60, DT = 1 / FPS, DURATION = 45;
const OUT_W = 1280, OUT_H = 720, RENDER_W = 1600, RENDER_H = 900; // rendered big, scaled down = free anti-aliasing
const MAX_KILLS = 3;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const angleDiff = (a, b) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

// ------------------------------------------------------------------ sound tap + offline mix
function makeTap() {
  const tap = { events: [], loops: [], t: 0 };
  tap.oneShot = (buffer, volume, rate, spatial, delay) => {
    const e = { t: tap.t + delay, buffer, volume, rate, pan: 0, end: tap.t + delay + buffer.duration / rate, cut: null };
    if (spatial) {
      const cam = G.camera.position;
      const dx = spatial.pos.x - cam.x, dy = spatial.pos.y - cam.y, dz = spatial.pos.z - cam.z;
      const d = Math.hypot(dx, dy, dz), h = Math.hypot(dx, dz) || 1;
      e.volume *= spatial.ref / (spatial.ref + spatial.rolloff * (Math.max(d, spatial.ref) - spatial.ref));
      const yaw = G.player.yaw;
      e.pan = clamp((dx * Math.cos(yaw) - dz * Math.sin(yaw)) / h, -1, 1) * 0.8 * Math.min(1, h / 1.5);
    }
    tap.events.push(e);
    return {
      get isPlaying() { return e.cut == null && tap.t < e.end; },
      kill() { if (e.cut == null && tap.t < e.end) e.cut = tap.t; },
      stop() { this.kill(); }, setVolume() {}, setPlaybackRate() {},
    };
  };
  tap.loop = (buffer, volume) => {
    const L = { buffer, start: tap.t, vol: [[tap.t, volume]], rate: [[tap.t, 1]] };
    tap.loops.push(L);
    const push = (arr, v) => { if (Math.abs(arr[arr.length - 1][1] - v) > 0.004) arr.push([tap.t, v]); };
    return { isPlaying: true, setVolume: (v) => push(L.vol, v), setPlaybackRate: (r) => push(L.rate, r), stop() {}, kill() {} };
  };
  return tap;
}

async function mix(tap, duration) {
  const sr = 48000, ctx = new OfflineAudioContext(2, Math.ceil(sr * duration), sr);
  const master = ctx.createGain(), comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.22;
  master.connect(comp); comp.connect(ctx.destination);
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(0.85, 1.2);
  master.gain.setValueAtTime(0.85, duration - 2.3);
  master.gain.linearRampToValueAtTime(0, duration - 0.1);
  for (const e of tap.events) {
    if (e.t >= duration - 0.05) continue;
    const src = ctx.createBufferSource(), g = ctx.createGain(), p = ctx.createStereoPanner();
    src.buffer = e.buffer; src.playbackRate.value = e.rate; g.gain.value = e.volume; p.pan.value = e.pan;
    src.connect(g); g.connect(p); p.connect(master);
    src.start(Math.max(0, e.t));
    if (e.cut != null) {
      g.gain.setValueAtTime(e.volume, e.cut);
      g.gain.linearRampToValueAtTime(0, e.cut + 0.06);
      src.stop(e.cut + 0.08);
    }
  }
  for (const L of tap.loops) {
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = L.buffer; src.loop = true;
    g.gain.setValueAtTime(L.vol[0][1], 0);
    for (let i = 1; i < L.vol.length; i++) g.gain.linearRampToValueAtTime(L.vol[i][1], L.vol[i][0] + 0.03);
    src.playbackRate.setValueAtTime(L.rate[0][1], 0);
    for (let i = 1; i < L.rate.length; i++) src.playbackRate.linearRampToValueAtTime(L.rate[i][1], L.rate[i][0] + 0.03);
    src.connect(g); g.connect(master);
    src.start(L.start);
  }
  const buf = await ctx.startRendering();
  // 16-bit stereo WAV
  const n = buf.length, out = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt '); out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); out.setUint16(22, 2, true); out.setUint32(24, sr, true); out.setUint32(28, sr * 4, true);
  out.setUint16(32, 4, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * 4, true);
  const l = buf.getChannelData(0), r = buf.getChannelData(1);
  for (let i = 0; i < n; i++) {
    out.setInt16(44 + i * 4, clamp(l[i], -1, 1) * 32767, true);
    out.setInt16(46 + i * 4, clamp(r[i], -1, 1) * 32767, true);
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

// ------------------------------------------------------------------ HUD + title cards drawn onto each frame
function makeHud(captions) {
  const c = document.createElement('canvas');
  c.width = OUT_W; c.height = OUT_H;
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  const serif = '"Times New Roman", Times, serif';
  const flick = (t) => (t > 0.62 && t < 0.66 ? 0.3 : t > 1.31 && t < 1.33 ? 0.5 : t > 1.36 && t < 1.4 ? 0.12 : 1);
  const title = (a, t, sub) => {
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.globalAlpha = a * flick(t % 3);
    x.font = `170px ${serif}`; x.letterSpacing = '68px';
    x.fillStyle = '#8f0e0e'; x.shadowColor = 'rgba(170,0,0,.55)'; x.shadowBlur = 34;
    x.fillText('FEED', OUT_W / 2 + 34, OUT_H / 2 - 24);
    x.shadowBlur = 0;
    if (sub) {
      x.globalAlpha = a;
      x.font = `italic 18px ${serif}`; x.letterSpacing = '6px'; x.fillStyle = '#8a8373';
      x.fillText('they wandered in. you were already here.', OUT_W / 2 + 3, OUT_H / 2 + 92);
    }
    x.letterSpacing = '0px';
  };
  return (t) => {
    x.globalAlpha = 1; x.shadowBlur = 0;
    x.drawImage(D.canvas, 0, 0, OUT_W, OUT_H);

    const hudA = clamp((t - 3.0) / 1.2, 0, 1) * (1 - clamp((t - (DURATION - 2.6)) / 0.8, 0, 1));
    if (hudA > 0) {
      // tally of who is left
      x.font = `28px ${serif}`; x.textAlign = 'left'; x.textBaseline = 'alphabetic';
      let tx = 34;
      const ty = OUT_H - 26;
      for (let i = 0; i < G.total; i++) {
        const dead = i < G.kills;
        x.globalAlpha = hudA * (dead ? 1 : 0.75);
        x.fillStyle = dead ? '#8f0e0e' : '#b9b1a0';
        x.shadowColor = dead ? 'rgba(170,0,0,.7)' : '#000'; x.shadowBlur = dead ? 8 : 6;
        x.fillText('|', tx, ty);
        if (dead) x.fillRect(tx - 3, ty - 11, 13, 2);
        tx += 15;
      }
      x.shadowBlur = 0;
      // hunger + stamina
      const bw = 230, bx = (OUT_W - bw) / 2;
      x.globalAlpha = hudA;
      x.fillStyle = 'rgba(255,255,255,.07)'; x.fillRect(bx, OUT_H - 38, bw, 2);
      x.shadowColor = 'rgba(190,0,0,.8)'; x.shadowBlur = 9;
      x.fillStyle = '#9a1010'; x.fillRect(bx, OUT_H - 38, bw * clamp(G.hunger, 0, 1), 2);
      x.shadowBlur = 0;
      if (G.player.stamina < 0.995) {
        x.fillStyle = 'rgba(255,255,255,.07)'; x.fillRect(bx, OUT_H - 31, bw, 1);
        x.fillStyle = '#8a8373'; x.fillRect(bx, OUT_H - 31, bw * G.player.stamina, 1);
      }
      // caption
      const cap = captions[captions.length - 1];
      if (cap) {
        const a = clamp((t - cap.t) / 0.6, 0, 1) * (1 - clamp((t - cap.t - cap.dur) / 0.9, 0, 1));
        if (a > 0) {
          x.globalAlpha = a * hudA;
          x.font = `italic 20px ${serif}`; x.letterSpacing = '7px'; x.textAlign = 'center';
          x.fillStyle = '#c9c0ae'; x.shadowColor = '#000'; x.shadowBlur = 12;
          x.fillText(cap.text.toLowerCase(), OUT_W / 2 + 3, OUT_H * 0.83);
          x.fillText(cap.text.toLowerCase(), OUT_W / 2 + 3, OUT_H * 0.83);
          x.letterSpacing = '0px'; x.shadowBlur = 0;
        }
      }
    }

    // opening card over the live view
    const openA = t < 2.2 ? 1 : clamp(1 - (t - 2.2) / 1.3, 0, 1);
    if (openA > 0) {
      const gr = x.createRadialGradient(OUT_W / 2, OUT_H / 2, 40, OUT_W / 2, OUT_H / 2, OUT_W * 0.6);
      gr.addColorStop(0, 'rgba(0,0,0,0.45)'); gr.addColorStop(0.7, 'rgba(0,0,0,0.93)'); gr.addColorStop(1, '#000');
      x.globalAlpha = openA; x.fillStyle = gr; x.fillRect(0, 0, OUT_W, OUT_H);
      title(openA, t, true);
    }
    // closing: cut to black, title comes back
    const endA = clamp((t - (DURATION - 2.1)) / 1.0, 0, 1);
    if (endA > 0) {
      x.globalAlpha = endA; x.fillStyle = '#000'; x.fillRect(0, 0, OUT_W, OUT_H);
      const a2 = clamp((t - (DURATION - 1.2)) / 0.4, 0, 1) * (1 - clamp((t - (DURATION - 0.25)) / 0.25, 0, 1));
      if (a2 > 0) title(a2, 0, false);
    }
    x.globalAlpha = 1;
    // toDataURL on purpose: toBlob encodes in idle time, which a background window almost never gets
    const url = c.toDataURL('image/jpeg', 0.93);
    const bin = atob(url.slice(url.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };
}

// ------------------------------------------------------------------ the autopilot
function makeDirector(opt) {
  const L = G.level, P = G.player, n = L.n, keys = D.keys;
  const fieldP = new Int16Array(n * n), fieldM = new Int16Array(n * n);
  const S = { t: 0, pt: 0, phase: 'intro', target: null, hunt: 0, yawGoal: P.yaw, yaw0: P.yaw, roared: false, hold: 0, kills: 0, fieldT: 0, log: [] };
  const cellOf = (x, z) => Math.floor(z / 2) * n + Math.floor(x / 2);
  const center = (i) => ({ x: ((i % n) + 0.5) * 2, z: (Math.floor(i / n) + 0.5) * 2 });
  const yawTo = (x, z) => Math.atan2(-(x - P.pos.x), -(z - P.pos.z));
  const note = (s) => S.log.push(`${S.t.toFixed(2)}s ${s}`);
  const setPhase = (p) => { S.phase = p; S.pt = 0; note(p); };
  // a body-wide line of sight, so the monster does not clip corners
  const clear = (x0, z0, x1, z1, w = 0.5) => {
    const dx = x1 - x0, dz = z1 - z0, d = Math.hypot(dx, dz);
    if (d < 1e-3) return true;
    const ox = (-dz / d) * w, oz = (dx / d) * w;
    return L.los(x0, z0, x1, z1) && L.los(x0 + ox, z0 + oz, x1 + ox, z1 + oz) && L.los(x0 - ox, z0 - oz, x1 - ox, z1 - oz);
  };

  // staging: keep the film's pacing by putting the next victim a short stalk away, out of sight, somewhere lit
  function stage(p, cells) {
    const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
    let pick = -1, best = -1e9;
    for (let i = 0; i < n * n; i++) {
      const v = fieldM[i];
      if (v < cells - 1 || v > cells + 1) continue;
      const c = center(i);
      if (L.los(P.pos.x, P.pos.z, c.x, c.z)) continue;
      const dx = c.x - P.pos.x, dz = c.z - P.pos.z, d = Math.hypot(dx, dz) || 1;
      let s = ((dx * fx + dz * fz) / d) * 0.8 + Math.min(L.lightAt(c.x, c.z), 0.35) * 5;
      for (const q of G.prey) if (q !== p && Math.hypot(q.pos.x - c.x, q.pos.z - c.z) < 9) s -= 2.5;
      if (s > best) { best = s; pick = i; }
    }
    if (pick < 0) return false;
    const c = center(pick);
    p.pos.set(c.x, 0, c.z);
    p.root.position.set(c.x, 0, c.z);
    p.wp = null; p.hasTarget = false; p.idleT = 3; p.state = 'wander'; p.stateT = 0; p.fear = 0; p.nervous = 0;
    return true;
  }

  function pickTarget() {
    L.bfs(Math.floor(P.pos.x / 2), Math.floor(P.pos.z / 2), fieldM);
    let t = null, bd = 1e9;
    for (const p of G.prey) {
      if (!p.alive) continue;
      const v = fieldM[cellOf(p.pos.x, p.pos.z)];
      if (v >= 0 && v < bd) { bd = v; t = p; }
    }
    if (!t) return null;
    const want = opt.stalk[Math.min(S.hunt, opt.stalk.length - 1)];
    if (Math.abs(bd - want) > 1.5) { stage(t, want); note(`staged prey ${t.id} at ~${want * 2} m of path (was ${bd * 2} m)`); }
    S.fieldT = 0;
    return t;
  }

  function followPath() {
    let cur = cellOf(P.pos.x, P.pos.z);
    if (fieldP[cur] < 0) return null;
    const cells = [];
    for (let k = 0; k < 6; k++) {
      const cx = cur % n, cz = (cur / n) | 0;
      let nb = -1, bv = fieldP[cur];
      for (let oz = -1; oz <= 1; oz++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oz) continue;
          const xx = cx + ox, zz = cz + oz;
          if (L.isWall(xx, zz)) continue;
          if (ox && oz && (L.isWall(cx + ox, cz) || L.isWall(cx, cz + oz))) continue;
          const v = fieldP[zz * n + xx];
          if (v >= 0 && v < bv) { bv = v; nb = zz * n + xx; }
        }
      }
      if (nb < 0) break;
      cells.push(nb); cur = nb;
    }
    if (!cells.length) return null;
    let pick = cells[0];
    for (const c of cells) { const q = center(c); if (clear(P.pos.x, P.pos.z, q.x, q.z)) pick = c; else break; }
    return center(pick);
  }

  function next() {
    S.hunt++; S.roared = false;
    S.target = pickTarget();
    setPhase(S.target ? 'smell' : 'outro');
  }

  function step(dt) {
    S.t += dt; S.pt += dt; S.hold -= dt;
    keys.KeyW = keys.ShiftLeft = keys.KeyE = false;
    const p = S.target, alive = !!(p && p.alive);
    let dist = 99, los = false, toPrey = S.yawGoal;
    if (p) {
      dist = Math.hypot(p.pos.x - P.pos.x, p.pos.z - P.pos.z);
      los = clear(P.pos.x, P.pos.z, p.pos.x, p.pos.z, 0.35);
      if (dist > 0.5) toPrey = yawTo(p.pos.x, p.pos.z);
    }
    if (G.kills > S.kills) { S.kills = G.kills; note(`KILL ${G.kills}`); setPhase('feed'); }
    if (alive) {
      S.fieldT -= dt;
      if (S.fieldT <= 0) { S.fieldT = 0.2; L.bfs(Math.floor(p.pos.x / 2), Math.floor(p.pos.z / 2), fieldP); }
    }

    let pitch = -0.05, turn = 3.4, rate = 5;
    const sway = Math.sin(S.t * 0.7) * 0.09 + Math.sin(S.t * 1.9 + 1) * 0.045;
    switch (S.phase) {
      case 'intro':
        S.yawGoal = S.yaw0 + S.t * 0.09; pitch = -0.02;
        if (S.t > 3.3) { S.target = pickTarget(); setPhase(S.target ? 'smell' : 'outro'); }
        break;
      case 'smell': // stop, breathe them in, turn to where the heat is
        keys.KeyE = S.pt > 0.25;
        S.yawGoal = toPrey; pitch = -0.07; turn = 2.6; rate = 3.5;
        if (S.pt > opt.smell) setPhase('stalk');
        break;
      case 'stalk': {
        if (!alive) { next(); break; }
        const noticed = p.state !== 'wander' && p.state !== 'alert';
        const hunting = G.kills < MAX_KILLS; // after the last allowed kill it only prowls toward the next one
        if (hunting && los && (dist < 11 || (noticed && dist < 15))) { setPhase('chase'); break; }
        const w = followPath();
        if (w) { S.yawGoal = yawTo(w.x, w.z) + sway; keys.KeyW = Math.abs(angleDiff(P.yaw, S.yawGoal)) < 1.0 && (hunting || dist > 7) && S.hold <= 0; }
        keys.ShiftLeft = noticed && hunting; // they bolted: run them down
        // closing beat: it stops and roars down the corridor at whoever is left
        if (!hunting && !S.endRoar && S.t > opt.endRoarAt && P.roarCd <= 0) {
          S.endRoar = true; S.hold = 9;
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
          note('END ROAR');
        }
        pitch = -0.05 + Math.sin(S.t * 0.5) * 0.03;
        break;
      }
      case 'chase': {
        if (!alive) { next(); break; }
        if (!S.roared && los && dist < 11 && dist > 4.5 && P.roarCd <= 0 && G.kills < MAX_KILLS) {
          S.roared = true; S.hold = 0.35;
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
          note(`ROAR at ${dist.toFixed(1)} m`);
        }
        let tx = p.pos.x, tz = p.pos.z;
        if (!los) { const w = followPath(); if (w) { tx = w.x; tz = w.z; } }
        S.yawGoal = yawTo(tx, tz);
        const off = Math.abs(angleDiff(P.yaw, S.yawGoal));
        // after the last allowed kill the next one is only hunted, never touched: the film ends on the chase
        const keepOff = G.kills >= MAX_KILLS && dist < 4.5;
        keys.KeyW = off < 1.0 && S.hold <= 0 && !keepOff;
        keys.ShiftLeft = true;
        turn = 8; rate = 9;
        pitch = los ? Math.max(-0.5, Math.atan2(1.2 - 2.14, Math.max(dist, 0.8))) : -0.06;
        if (los && dist < 2.7 && Math.abs(angleDiff(P.yaw, toPrey)) < 0.45 && P.attackCd <= 0 && G.kills < MAX_KILLS) {
          window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
        }
        if (S.pt > 13) { note('lost them'); next(); }
        break;
      }
      case 'feed': // stand over what is left
        S.yawGoal = toPrey; turn = 5;
        pitch = S.pt < 1.0 ? -0.66 : -0.15;
        if (S.pt > opt.feed) next();
        break;
      case 'outro': {
        keys.KeyE = S.pt > 0.4;
        let q = null, qd = 1e9;
        for (const o of G.prey) { if (!o.alive) continue; const d2 = Math.hypot(o.pos.x - P.pos.x, o.pos.z - P.pos.z); if (d2 < qd) { qd = d2; q = o; } }
        if (q) S.yawGoal = yawTo(q.pos.x, q.pos.z);
        turn = 1.6; rate = 2.5;
        break;
      }
    }
    const d = angleDiff(P.yaw, S.yawGoal);
    P.yaw += clamp(d * (1 - Math.exp(-dt * rate)), -turn * dt, turn * dt);
    P.pitch += (pitch - P.pitch) * (1 - Math.exp(-dt * 4.5));
  }
  return { step, S };
}

// ------------------------------------------------------------------ run
// stalk: how many cells (2 m each) of path lie between the monster and each victim when a hunt begins
export async function record({ dry = false, seconds = DURATION, stalk = [13, 17, 17, 16], smell = 2.4, feed = 2.2 } = {}) {
  const st = (window.__rec = { frame: 0, total: Math.round(seconds * FPS), done: false, log: null, error: null, t0: performance.now() });
  try {
    if (G.state !== 'title') throw new Error(`reload the page first (state is "${G.state}")`);
    D.manual = true; D.noRender = dry;
    const tap = makeTap();
    G.audio.rec = tap; G.rec = true;
    const captions = [];
    G.onSay = (text, dur) => captions.push({ text, t: tap.t, dur });
    G.time = 0;

    // open on a lit room near the middle of the level, looking down the longest view
    const L = G.level, P = G.player, mid = L.size / 2;
    const fx = L.fixtures.filter((f) => f.state === 1).sort((a, b) => Math.hypot(a.x - mid, a.z - mid) - Math.hypot(b.x - mid, b.z - mid))[0];
    P.pos.set(fx.x - 1.2, 0, fx.z + 0.9);
    let bestA = 0, bestD = -1;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      let d = 0;
      while (d < 40 && !L.isWallAt(P.pos.x - Math.sin(a) * (d + 1), P.pos.z - Math.cos(a) * (d + 1))) d += 1;
      if (d > bestD) { bestD = d; bestA = a; }
    }
    P.yaw = bestA - 0.15; P.pitch = -0.02;

    if (!dry) D.setSize(RENDER_W, RENDER_H);
    document.getElementById('title').click(); // -> startGame(): loops + whisper start at t = 0
    if (G.state !== 'playing') throw new Error('game did not start');
    const dir = makeDirector({ stalk, smell, feed, endRoarAt: seconds - 3.9 });
    const hud = dry ? null : makeHud(captions);
    const pending = [];
    // the simulation always runs at 60 Hz (so a rehearsal and the take match tick for tick);
    // ?every=2 keeps every second frame (a 30 fps film), ?resume=N re-uses frames below N from an earlier take
    const q = new URLSearchParams(location.search);
    const every = Number(q.get('every')) || 1, resume = Number(q.get('resume')) || 0;
    for (let f = 0; f < st.total; f++) {
      const t = (tap.t = f * DT);
      if (f === Math.round(3.7 * FPS)) G.onSay('you can smell them.', 2.4);
      if (f === Math.round((seconds - 2.1) * FPS)) G.audio.play('stinger', 0.55, 0.7, 0);
      dir.step(DT);
      G.hunger = Math.max(G.hunger, 0.2);
      const keep = !dry && f >= resume && f % every === 0;
      D.noRender = !keep;
      D.tick(DT);
      if (keep) {
        pending.push(fetch(`/__capture?d=frames&n=f${String(f).padStart(5, '0')}&e=jpg`, { method: 'POST', body: hud(t) }));
        if (pending.length >= 4) { await Promise.all(pending); pending.length = 0; }
      } else if (f % 240 === 0) await new Promise((r) => setTimeout(r));
      st.frame = f + 1;
    }
    await Promise.all(pending);
    st.log = dir.S.log;
    st.kills = G.kills;
    if (!dry) {
      const wav = await mix(tap, seconds);
      await fetch('/__capture?d=audio&n=track&e=wav', { method: 'POST', body: wav });
      st.sounds = tap.events.length;
    }
    st.ms = Math.round(performance.now() - st.t0);
    st.done = true;
  } catch (e) {
    st.error = String(e) + '\n' + (e.stack || '').slice(0, 600);
  }
  return st;
}

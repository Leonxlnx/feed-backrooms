import * as THREE from 'three';
import { inject } from '@vercel/analytics';
import { Level, CELL } from './level.js';
import { Prey } from './prey.js';
import { Player } from './player.js';
import { AudioSys } from './audio.js';
import { makePost } from './post.js';
import { loadTextures } from './assets.js';
import { shared, makeGrimeTexture } from './materials.js';
import { mulberry32, clamp, damp, smoothstep } from './util.js';

const $ = (id) => document.getElementById(id);
inject({ mode: import.meta.env.DEV ? 'development' : 'production' }); // Vercel Analytics page views
// ?seed=123 replays the same building and the same people
const SEED = Number(new URLSearchParams(location.search).get('seed')) || (Math.random() * 1e9) | 0;
const rng = mulberry32(SEED);

// phones and tablets get thumb controls, a lighter renderer and a fullscreen layout (?touch=1 forces it)
const TOUCH = new URLSearchParams(location.search).has('touch')
  || matchMedia('(hover: none) and (pointer: coarse)').matches
  || (navigator.maxTouchPoints > 0 && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent));
document.body.classList.toggle('touch', TOUCH);

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.prepend(renderer.domElement);
const canvas = renderer.domElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x040302);
scene.fog = new THREE.FogExp2(0x040302, 0.052);
const camera = new THREE.PerspectiveCamera(80, innerWidth / innerHeight, 0.05, 80);
scene.add(camera);
const post = makePost(renderer, scene, camera);

// internal resolution budget: the picture is shaded per pixel by several shadowed lights, so pixels are what
// cost frame rate. Integrated GPUs get ~1.1 MP, discrete cards ~2.3 MP; grain + bloom hide the upscale.
function gpuName() {
  try {
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  } catch { return ''; }
}
const FAST_GPU = /RTX|GTX|Radeon RX|Radeon Pro|Arc\(TM\) [AB]\d|Quadro|Apple M\d/i.test(gpuName());
const MAX_PIXELS = TOUCH ? 0.55e6 : FAST_GPU ? 2.3e6 : 1.1e6;
let scaleDown = 1; // lowered automatically when frames run long
let userBoost = 1, autoScale = true; // keys 1 and 2 trade sharpness for speed by hand
let pixelRatio = 1;
function resize() {
  pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt((MAX_PIXELS * userBoost) / (innerWidth * innerHeight))) * scaleDown;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  post.resize(innerWidth, innerHeight, pixelRatio);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ game state
const TOTAL_PREY = 8;
const G = {
  scene, camera, rng, time: 0, elapsed: 0, state: 'loading', prey: [], kills: 0, total: TOTAL_PREY,
  hunger: 0.8, hitstop: 0, blood: 0, caKick: 0, winT: -1, warned: false,
};
window.__G = G;
const audio = new AudioSys(camera, scene);
G.audio = audio;
let player, level;
const loops = {};
const flashPool = [];

// ------------------------------------------------------------------ hud
const msgEl = $('msg');
let msgTimer = 0;
function say(text, dur = 3.2) {
  if (G.onSay) G.onSay(text, dur);
  msgEl.textContent = text;
  msgEl.style.opacity = 1;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { msgEl.style.opacity = 0; }, dur * 1000);
}
function drawTally() {
  let h = '';
  for (let i = 0; i < G.total; i++) h += i < G.kills ? '<s>|</s>' : '|';
  $('tally').innerHTML = h;
}
const hungerBar = $('hunger').firstElementChild, stamBar = $('stam').firstElementChild;

// ------------------------------------------------------------------ blood
const BMAX = 260;
const bPos = new Float32Array(BMAX * 3).fill(-10), bVel = new Float32Array(BMAX * 3), bLife = new Float32Array(BMAX);
const bGeo = new THREE.BufferGeometry();
bGeo.setAttribute('position', new THREE.BufferAttribute(bPos, 3));
const bMat = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 500 }, uLight: { value: 1 } },
  vertexShader: `
    uniform float uScale;
    void main() {
      vec4 mv = modelViewMatrix * vec4( position, 1.0 );
      gl_PointSize = clamp( uScale * 0.06 / max( -mv.z, 0.05 ), 1.5, 20.0 );
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform float uLight;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float d = dot( c, c );
      if ( d > 0.25 ) discard;
      float sh = 0.5 + 0.5 * smoothstep( 0.25, 0.0, d + c.y * 0.25 ); // round droplet with a wet highlight side
      gl_FragColor = vec4( vec3( 0.36, 0.008, 0.008 ) * sh * uLight, 1.0 );
    }`,
});
const bPoints = new THREE.Points(bGeo, bMat);
bPoints.frustumCulled = false;
scene.add(bPoints);
let bNext = 0;
const pools = [];
function spawnBlood(x, y, z, dx, dz, n = 80) {
  for (let i = 0; i < n; i++) {
    const j = bNext; bNext = (bNext + 1) % BMAX;
    bPos[j * 3] = x; bPos[j * 3 + 1] = y + (Math.random() - 0.5) * 0.5; bPos[j * 3 + 2] = z;
    const a = Math.random() * Math.PI * 2, s = Math.random() * 3.2;
    bVel[j * 3] = Math.cos(a) * s + dx * 2.2; bVel[j * 3 + 1] = 1 + Math.random() * 4.2; bVel[j * 3 + 2] = Math.sin(a) * s + dz * 2.2;
    bLife[j] = 1.6;
  }
}
function updateBlood(dt) {
  for (let j = 0; j < BMAX; j++) {
    if (bLife[j] <= 0) continue;
    bLife[j] -= dt;
    bVel[j * 3 + 1] -= 11 * dt;
    bPos[j * 3] += bVel[j * 3] * dt; bPos[j * 3 + 1] += bVel[j * 3 + 1] * dt; bPos[j * 3 + 2] += bVel[j * 3 + 2] * dt;
    if (bPos[j * 3 + 1] < 0.02 || bLife[j] <= 0 || level.isWallAt(bPos[j * 3], bPos[j * 3 + 2])) { bLife[j] = 0; bPos[j * 3 + 1] = -10; }
  }
  bGeo.attributes.position.needsUpdate = true;
  bMat.uniforms.uScale.value = canvas.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  bMat.uniforms.uLight.value = clamp(0.3 + level.lightAt(player.pos.x, player.pos.z) * 2.5, 0.3, 1);
  for (const p of pools) {
    if (p.t >= 1) continue;
    p.t = Math.min(1, p.t + dt / 6);
    const s = p.size * (0.25 + 0.75 * Math.sqrt(p.t));
    p.mesh.scale.set(s, s, 1);
  }
}

// ------------------------------------------------------------------ scent trails (only visible while smelling)
const TRAIL_N = 44;
let trail = null;
function initTrails() {
  const n = TOTAL_PREY * TRAIL_N;
  const pos = new Float32Array(n * 3), birth = new Float32Array(n).fill(-1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aBirth', new THREE.BufferAttribute(birth, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uSense: { value: 0 }, uScale: { value: 500 } },
    vertexShader: `
      attribute float aBirth;
      uniform float uTime, uSense, uScale;
      varying float vA;
      void main() {
        float age = uTime - aBirth;
        float life = clamp( 1.0 - age / 32.0, 0.0, 1.0 );
        vA = life * uSense * step( 0.0, aBirth );
        vec3 p = position;
        p.y += age * 0.014;
        p.x += sin( age * 0.6 + position.z * 2.7 ) * 0.1;
        p.z += cos( age * 0.5 + position.x * 2.3 ) * 0.1;
        vec4 mv = modelViewMatrix * vec4( p, 1.0 );
        gl_PointSize = uScale * ( 0.3 + 0.4 * ( 1.0 - life ) ) / max( -mv.z, 0.1 );
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA;
      void main() {
        float d = length( gl_PointCoord - 0.5 );
        float a = smoothstep( 0.5, 0.05, d ) * vA * 0.8;
        gl_FragColor = vec4( vec3( 1.6, 0.3, 0.08 ) * a, a );
      }`,
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 998;
  pts.visible = false;
  scene.add(pts);
  trail = { pos, birth, geo, mat, pts, next: new Int32Array(TOTAL_PREY), last: G.prey.map((p) => ({ x: p.pos.x, z: p.pos.z })) };
}
function updateTrails() {
  let dirty = false;
  for (const p of G.prey) {
    if (!p.alive) continue;
    const l = trail.last[p.id];
    if ((p.pos.x - l.x) ** 2 + (p.pos.z - l.z) ** 2 < 0.8) continue;
    l.x = p.pos.x; l.z = p.pos.z;
    const j = p.id * TRAIL_N + trail.next[p.id];
    trail.next[p.id] = (trail.next[p.id] + 1) % TRAIL_N;
    trail.pos[j * 3] = p.pos.x; trail.pos[j * 3 + 1] = 0.2 + Math.random() * 0.6; trail.pos[j * 3 + 2] = p.pos.z;
    trail.birth[j] = G.time;
    dirty = true;
  }
  if (dirty) { trail.geo.attributes.position.needsUpdate = true; trail.geo.attributes.aBirth.needsUpdate = true; }
  const u = trail.mat.uniforms;
  u.uTime.value = G.time;
  u.uSense.value = player.sense;
  u.uScale.value = canvas.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  trail.pts.visible = player.sense > 0.02;
}

// ------------------------------------------------------------------ callbacks used by player / prey
const vTmp = new THREE.Vector3();
let stingerCd = 0, sawCd = 0;

G.preyVoice = (p, key, vol = 1, delay = 0) => {
  if (p.dist > 40) return;
  if (p.voice && p.voice.isPlaying) {
    if (key === 'prey_whimper') return; // still gasping from the last one
    p.voice.kill();
  }
  vTmp.set(0, 1.5, 0);
  p.voice = audio.playAt(key, vTmp, vol * (p.hasLos ? 1 : 0.55), { ref: 5, delay, parent: p.root });
};
G.preyStep = (p) => {
  if (p.dist > 22) return;
  vTmp.set(p.pos.x, 0.1, p.pos.z);
  audio.playAt('prey_step', vTmp, 0.5 * (p.hasLos ? 1 : 0.5), { ref: 3, rateVar: 0.12 });
};
G.spreadPanic = (src) => {
  for (const q of G.prey) {
    if (q === src || !q.alive) continue;
    if (Math.hypot(q.pos.x - src.pos.x, q.pos.z - src.pos.z) < 15) q.alert(src.pos.x, src.pos.z, 0.8);
  }
};
G.onPreySpotted = (p) => {
  G.preyVoice(p, 'prey_scream', 1);
  p.screamCd = 3;
  if (stingerCd <= 0) { audio.play('stinger', 0.55); stingerCd = 9; }
  if (sawCd <= 0) { say(pickLine(['it saw you.', 'they know.', 'run, then.'])); sawCd = 20; }
  G.spreadPanic(p);
};
G.monsterStep = (sprint) => {
  audio.play('monster_step', sprint ? 0.7 : 0.42, sprint ? 0.95 : 0.8, 0.1);
  player.trauma = Math.max(player.trauma, sprint ? 0.2 : 0.1);
};
G.onAttackStart = () => { audio.play('monster_growl', 0.6, 1.05, 0.12); };
G.onRoar = () => {
  audio.play('monster_roar', 1.0, 0.9, 0.05);
  player.trauma = 1;
  G.caKick = 1;
  if (TOUCH && navigator.vibrate) navigator.vibrate(160);
  for (const p of G.prey) p.roared(Math.hypot(p.pos.x - player.pos.x, p.pos.z - player.pos.z));
};
G.tryKill = () => {
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  let best = null, bd = 2.9;
  for (const p of G.prey) {
    if (!p.alive) continue;
    const dx = p.pos.x - player.pos.x, dz = p.pos.z - player.pos.z, d = Math.hypot(dx, dz);
    if (d > bd) continue;
    if (d > 0.9 && (dx * fx + dz * fz) / d < 0.4) continue;
    if (!level.los(player.pos.x, player.pos.z, p.pos.x, p.pos.z)) continue;
    best = p; bd = d;
  }
  if (!best) return;
  kill(best, fx, fz);
};

const pickLine = (a) => a[Math.floor(Math.random() * a.length)];

function kill(p, fx, fz) {
  p.die();
  G.kills++;
  G.hunger = Math.min(1, G.hunger + 0.36);
  G.hitstop = 0.13;
  G.blood = 1;
  player.trauma = 1;
  if (TOUCH && navigator.vibrate) navigator.vibrate([30, 40, 110]);
  if (p.voice) p.voice.kill();
  vTmp.set(p.pos.x, 1.3, p.pos.z);
  audio.playAt('prey_death', vTmp, 1.0, { ref: 6 });
  audio.play('gore', 0.95, 1, 0.1);
  audio.play('stinger', 0.3, 0.8);
  spawnBlood(p.pos.x, 1.25, p.pos.z, fx, fz, 90);
  const mesh = level.makeBloodDecal(p.pos.x + fx * 0.4, p.pos.z + fz * 0.4, 0.4);
  mesh.rotation.z = Math.random() * 6.28;
  level.group.add(mesh);
  pools.push({ mesh, t: 0, size: 2.6 + Math.random() * 1.4 });
  drawTally();
  player.setBlood(G.kills / 3);
  // everyone close enough hears it end
  for (const q of G.prey) {
    if (!q.alive) continue;
    const d = Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
    if (d < 18) q.alert(p.pos.x, p.pos.z, 1);
  }
  const left = G.total - G.kills;
  if (left === 0) { G.winT = 3; say('quiet now.', 4); }
  else say(pickLine(['warm.', 'more.', 'it stops moving.', 'the hunger quiets.', left === 1 ? 'one left.' : `${left} left.`]));
}

// ------------------------------------------------------------------ setup
async function init() {
  const go = $('go');
  const [tex] = await Promise.all([
    loadTextures(renderer),
    audio.load((f) => { go.textContent = 'waking ' + '.'.repeat(1 + Math.floor(f * 5)); }),
  ]);
  shared.uGrime.value = makeGrimeTexture();
  // the classic sickly yellow, layered over whatever wallpaper / carpet was sourced
  tex.wall.tint = new THREE.Color(2.15, 1.75, 0.72);
  tex.carpet.tint = new THREE.Color(0.6, 0.47, 0.3);
  tex.ceiling.tint = new THREE.Color(0.8, 0.75, 0.6);
  tex.ceiling.tile = 3.6; // 6x6 tiles of 60cm per repeat

  G.tex = tex;
  level = new Level(rng, 12);
  G.level = level;
  level.build(scene, tex);
  level.initLights(scene, TOUCH ? 3 : 4, TOUCH ? 512 : 1024);
  G.monsterField = new Int16Array(level.n * level.n);

  const start = level.macroCenter(6, 6);
  player = new Player(G, camera, start.x, start.z);
  player.yaw = rng() * Math.PI * 2;
  G.player = player;

  // prey: scattered, never right on top of the monster
  const spots = [];
  for (let mz = 0; mz < level.M; mz++) for (let mx = 0; mx < level.M; mx++) {
    const c = level.macroCenter(mx, mz);
    if (Math.hypot(c.x - start.x, c.z - start.z) > 22) spots.push(c);
  }
  for (let i = spots.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [spots[i], spots[j]] = [spots[j], spots[i]]; }
  for (let i = 0; i < TOTAL_PREY; i++) {
    const c = spots[i];
    G.prey.push(new Prey(G, c.x + (rng() - 0.5) * 2, c.z + (rng() - 0.5) * 2, rng, i));
  }

  // two real torch beams (one on phones), handed to whichever torches are nearest
  for (let i = 0; i < (TOUCH ? 1 : 2); i++) {
    const l = new THREE.SpotLight(0xfff1d6, 0, 20, 0.36, 0.5, 1.5);
    l.castShadow = true;
    l.shadow.mapSize.set(512, 512);
    l.shadow.camera.near = 0.3;
    l.shadow.camera.far = 20;
    l.shadow.bias = -0.001;
    l.shadow.normalBias = 0.02;
    l.shadow.autoUpdate = false;
    l.shadow.needsUpdate = true;
    scene.add(l, l.target);
    flashPool.push(l);
  }

  initTrails();

  // upload every texture and build every shader now, so nothing hitches the first time it swings into view
  for (const set of Object.values(tex)) for (const k of ['color', 'normal', 'roughness']) if (set[k]) renderer.initTexture(set[k]);
  scene.traverse((o) => { if (o.material && o.material.map) renderer.initTexture(o.material.map); });
  player.update(0.016, titleInp);
  for (const p of G.prey) { p.setSense(1, 5, 0); p.root.updateMatrixWorld(true); }
  trail.pts.visible = true;
  const t0 = performance.now();
  try { await renderer.compileAsync(scene, camera); } catch (e) { console.warn(e); }
  console.log(`[feed] shaders ready in ${Math.round(performance.now() - t0)} ms (page ${document.visibilityState})`);
  for (const p of G.prey) p.setSense(0, 5, 0);
  trail.pts.visible = false;

  drawTally();
  G.state = 'title';
  go.textContent = TOUCH ? 'tap to wake' : 'click to wake';

  // dev server only: ?record=1 films the trailer with tools/record.js (see the notes at the top of that file)
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('record')) {
    import(/* @vite-ignore */ '/tools/record.js').then((m) => m.record());
  }
}

function startGame() {
  audio.resume();
  loops.hum = audio.loop('amb_hum', 0.42);
  loops.drone = audio.loop('amb_drone', 0.2);
  loops.breath = audio.loop('monster_breath', 0.22);
  loops.heart = audio.loop('heartbeat', 0);
  audio.play('whisper', 0.4, 1, 0);
  G.state = 'playing';
  $('title').classList.add('hidden');
  $('hud').classList.remove('hidden');
  if (G.rec) return; // the trailer recorder drives input and captions itself
  if (TOUCH) { goFullscreen(); $('touch').classList.remove('hidden'); } else lock();
  setTimeout(() => G.state === 'playing' && say('you can smell them.', 3), 900);
  setTimeout(() => G.state === 'playing' && say('find them before the hunger finds you.', 3.6), 4600);
}

let hadLock = false;
// raw mouse input (no OS acceleration) is what keeps fast turns from stuttering; fall back if unsupported
function lock() {
  const plain = () => { try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* play without lock */ } };
  try {
    const p = canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(plain);
  } catch { plain(); }
}
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (locked) { hadLock = true; return; }
  if (hadLock && G.state === 'playing') {
    G.state = 'paused';
    $('pause').classList.remove('hidden');
  }
});
$('title').addEventListener('click', () => { if (G.state === 'title') startGame(); });
$('pause').addEventListener('click', () => {
  if (G.state !== 'paused') return;
  G.state = 'playing';
  $('pause').classList.add('hidden');
  lock();
});
$('end').addEventListener('click', () => { if (G.state === 'ended') location.reload(); });

function endGame(won) {
  G.state = 'ended';
  if (document.pointerLockElement) document.exitPointerLock();
  const m = Math.floor(G.elapsed / 60), s = Math.floor(G.elapsed % 60).toString().padStart(2, '0');
  $('endTitle').textContent = won ? 'NOTHING LEFT' : 'YOU STARVED';
  $('endSub').textContent = won
    ? `all ${G.total} devoured in ${m}:${s}. the rooms are quiet again.`
    : `${G.kills} of ${G.total} devoured. the rest are still down here, somewhere.`;
  $('end').classList.remove('hidden');
  $('hud').classList.add('hidden');
  $('touch').classList.add('hidden');
  for (const k of ['breath', 'heart']) loops[k] && loops[k].setVolume(0);
  if (!won) audio.play('stinger', 0.6, 0.6);
}

// ------------------------------------------------------------------ input
const keys = {};
const inp = { fwd: 0, strafe: 0, sprint: false, attack: false, roar: false, sense: false, dx: 0, dy: 0 };
let rmb = false, attackQ = false, roarQ = false;
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys[e.code] = true;
  if (G.state === 'playing' && (e.code === 'KeyR' || e.code === 'Space')) roarQ = true;
  if (e.code === 'Digit1' || e.code === 'Digit2') {
    userBoost = clamp(userBoost * (e.code === 'Digit2' ? 1.35 : 1 / 1.35), 0.3, 4);
    autoScale = false; scaleDown = 1;
    resize();
    say(`${canvas.width} × ${canvas.height}`, 1.4);
  }
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; rmb = false; });
addEventListener('mousedown', (e) => {
  if (G.state !== 'playing' || TOUCH) return; // on phones a tap also fires a fake mousedown
  if (e.button === 0) attackQ = true;
  if (e.button === 2) rmb = true;
});
addEventListener('mouseup', (e) => { if (e.button === 2) rmb = false; });
addEventListener('contextmenu', (e) => e.preventDefault());
let mAvg = 0;
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  // browsers sometimes report one huge bogus delta under pointer lock (the view "skips"); drop those
  const mx = e.movementX, my = e.movementY, mag = Math.hypot(mx, my);
  const spike = mag > 140 && mag > mAvg * 7 + 80;
  mAvg += (Math.min(mag, 400) - mAvg) * 0.25;
  if (spike) return;
  inp.dx += mx; inp.dy += my;
});

// ------------------------------------------------------------------ touch controls (phones / tablets)
// left thumb: a stick that appears where you put it down (push it all the way forward to run)
// right thumb: drag to look, quick tap to tear. buttons: tear, roar, hold to smell
const touch = { fwd: 0, strafe: 0, sprint: false, sense: false, moveId: null, lookId: null, ox: 0, oy: 0, lx: 0, ly: 0, t0: 0, moved: 0 };
function goFullscreen() {
  const el = document.documentElement, req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req || document.fullscreenElement) return;
  try {
    const p = req.call(el, { navigationUI: 'hide' });
    if (p && p.then) p.then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {})).catch(() => {});
  } catch { /* iPhone Safari has no fullscreen API: add to home screen instead */ }
}
if (TOUCH) {
  const layer = $('touch'), stick = $('stick'), knob = stick.firstElementChild;
  const R = 54, LOOK = 2.3; // stick travel in px, look speed (px -> mouse counts)
  const endMove = () => {
    touch.moveId = null; touch.fwd = touch.strafe = 0; touch.sprint = false;
    stick.classList.remove('on', 'run');
  };
  layer.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (G.state !== 'playing') return;
    for (const t of e.changedTouches) {
      if (t.target.closest('button')) continue; // buttons handle themselves
      if (t.clientX < innerWidth * 0.45 && touch.moveId === null) {
        touch.moveId = t.identifier; touch.ox = t.clientX; touch.oy = t.clientY;
        stick.style.left = t.clientX + 'px'; stick.style.top = t.clientY + 'px';
        knob.style.transform = 'translate(0px, 0px)';
        stick.classList.add('on');
      } else if (touch.lookId === null) {
        touch.lookId = t.identifier; touch.lx = t.clientX; touch.ly = t.clientY;
        touch.t0 = performance.now(); touch.moved = 0;
      }
    }
  }, { passive: false });
  layer.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === touch.moveId) {
        let dx = t.clientX - touch.ox, dy = t.clientY - touch.oy;
        const d = Math.hypot(dx, dy);
        if (d > R) { dx *= R / d; dy *= R / d; }
        knob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
        const mag = Math.min(d, R) / R;
        touch.strafe = mag < 0.16 ? 0 : dx / R;
        touch.fwd = mag < 0.16 ? 0 : -dy / R;
        touch.sprint = mag > 0.9 && touch.fwd > 0.55;
        stick.classList.toggle('run', touch.sprint);
      } else if (t.identifier === touch.lookId) {
        const dx = t.clientX - touch.lx, dy = t.clientY - touch.ly;
        touch.lx = t.clientX; touch.ly = t.clientY;
        touch.moved += Math.abs(dx) + Math.abs(dy);
        inp.dx += dx * LOOK; inp.dy += dy * LOOK;
      }
    }
  }, { passive: false });
  const end = (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === touch.moveId) endMove();
      else if (t.identifier === touch.lookId) {
        touch.lookId = null;
        if (G.state === 'playing' && touch.moved < 14 && performance.now() - touch.t0 < 240) attackQ = true; // a tap
      }
    }
  };
  layer.addEventListener('touchend', end, { passive: false });
  layer.addEventListener('touchcancel', end, { passive: false });

  const button = (id, down, up) => {
    const b = $(id);
    b.addEventListener('touchstart', (e) => { e.preventDefault(); b.classList.add('down'); if (G.state === 'playing') down(); }, { passive: false });
    const release = (e) => { e.preventDefault(); b.classList.remove('down'); if (up) up(); };
    b.addEventListener('touchend', release, { passive: false });
    b.addEventListener('touchcancel', release, { passive: false });
  };
  button('bAtk', () => { attackQ = true; });
  button('bRoar', () => { roarQ = true; });
  button('bSmell', () => { touch.sense = true; }, () => { touch.sense = false; });

  $('keys').innerHTML = '<b>left thumb</b> stalk, push far to run &nbsp;·&nbsp; <b>right thumb</b> look, tap to tear<br><b>roar</b> freezes them &nbsp;·&nbsp; <b>hold smell</b> to see their fear';
  addEventListener('orientationchange', () => setTimeout(resize, 250));
}

// ------------------------------------------------------------------ per-frame
const fPos = new THREE.Vector3(), fDir = new THREE.Vector3();
function updateFlashlights() {
  const list = [];
  for (const p of G.prey) {
    if (!p.flashOn) continue;
    p._fd = Math.hypot(p.pos.x - player.pos.x, p.pos.z - player.pos.z);
    list.push(p);
  }
  list.sort((a, b) => a._fd - b._fd);
  for (let i = 0; i < flashPool.length; i++) {
    const l = flashPool[i], p = list[i];
    if (!p || p._fd > 34) { l.intensity = 0; continue; }
    p.getFlash(fPos, fDir);
    l.position.copy(fPos);
    l.target.position.copy(fPos).addScaledVector(fDir, 4);
    l.target.updateMatrixWorld();
    l.intensity = 95 * (1 - smoothstep(24, 34, p._fd)) * (G.dim ?? 1);
    l.shadow.needsUpdate = true;
  }
}

let fieldT = 0, zapT = 3;
function update(dt) {
  G.elapsed += dt;
  inp.fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) + touch.fwd;
  inp.strafe = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) + touch.strafe;
  inp.sprint = !!(keys.ShiftLeft || keys.ShiftRight) || touch.sprint;
  inp.sense = rmb || !!keys.KeyE || touch.sense;
  inp.attack = attackQ; inp.roar = roarQ;
  attackQ = roarQ = false;
  player.update(dt, inp);
  inp.dx = inp.dy = 0;

  fieldT -= dt;
  if (fieldT <= 0) {
    fieldT = 0.15;
    level.bfs(Math.floor(player.pos.x / CELL), Math.floor(player.pos.z / CELL), G.monsterField);
  }

  let nearest = 99, nearFear = 0;
  for (const p of G.prey) {
    p.update(dt);
    if (!p.alive) continue;
    const d = Math.hypot(p.pos.x - player.pos.x, p.pos.z - player.pos.z);
    if (d < nearest) { nearest = d; nearFear = p.fear; }
    p.setSense(player.sense, d, G.time); // glowing body + heartbeat through the walls while smelling
  }
  updateTrails();
  // people do not stand inside each other
  for (let i = 0; i < G.prey.length; i++) {
    const a = G.prey[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < G.prey.length; j++) {
      const b = G.prey[j];
      if (!b.alive) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.6 && d > 1e-4) {
        const k = ((0.6 - d) / d) * 0.5;
        a.pos.x -= dx * k; a.pos.z -= dz * k; b.pos.x += dx * k; b.pos.z += dz * k;
      }
    }
  }

  // hunger
  if (G.winT < 0) G.hunger -= dt / 150;
  if (G.hunger < 0.25 && !G.warned) { G.warned = true; say('you are starving.', 3.5); }
  if (G.hunger > 0.45) G.warned = false;
  if (G.hunger <= 0) return endGame(false);
  if (G.winT > 0) { G.winT -= dt; if (G.winT <= 0) return endGame(true); }

  updateBlood(dt);
  stingerCd -= dt; sawCd -= dt;

  // sound that follows the hunt
  const close = clamp(1 - nearest / 17, 0, 1);
  loops.heart.setVolume(Math.pow(close, 1.4) * 0.95 + player.sense * 0.12);
  loops.heart.setPlaybackRate(0.9 + nearFear * 0.45 + close * 0.15);
  loops.breath.setVolume(0.2 + (player.sprinting ? 0.34 : 0) + (1 - player.stamina) * 0.25);
  loops.breath.setPlaybackRate(1 + (1 - player.stamina) * 0.3);
  zapT -= dt;
  if (zapT <= 0) {
    zapT = 2.5 + Math.random() * 5;
    const f = level.nearestFlicker(player.pos.x, player.pos.z, 16);
    if (f) { vTmp.set(f.x, 2.9, f.z); audio.playAt('flicker', vTmp, 0.5, { ref: 3 }); }
  }

  // hud
  hungerBar.style.transform = `scaleX(${clamp(G.hunger, 0, 1).toFixed(3)})`;
  stamBar.style.transform = `scaleX(${player.stamina.toFixed(3)})`;
  $('stam').style.opacity = player.stamina < 0.995 ? 1 : 0;
}

const NV_WARM = new THREE.Color(0.5, 0.2, 0.16), NV_COLD = new THREE.Color(0.1, 0.17, 0.34);
const titleInp = { fwd: 0, strafe: 0, sprint: false, attack: false, roar: false, sense: false, dx: 0, dy: 0 };
const movers = [];
let lastNow = performance.now();
let fpsT = 0, fpsN = 0;
function frame(now = performance.now()) {
  requestAnimationFrame(frame);
  const real = (now - lastNow) / 1000;
  lastNow = now;
  if (G.dev.manual) return; // tools/record.js is stepping the game frame by frame
  tick(Math.min(Math.max(real, 0), 0.05), real);
}
// hooks for tools/record.js (the autopilot that filmed the trailer): hand-step the simulation,
// hold keys, and render at a fixed size regardless of the window
G.dev = {
  keys, canvas, post, manual: false, noRender: false,
  tick: (dt = 1 / 60) => tick(dt, dt),
  setSize: (w, h) => {
    autoScale = false;
    removeEventListener('resize', resize);
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    post.resize(w, h, 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  },
};
function tick(raw, real) {
  if (G.state === 'loading') return;
  let dt = raw;
  if (G.hitstop > 0) { G.hitstop -= raw; dt *= 0.05; }
  G.time += dt;

  // a phone held upright shows "turn your phone" and the hunt waits
  if (G.state === 'playing' && !(TOUCH && innerHeight > innerWidth)) update(dt);
  else if (G.state === 'title') { titleInp.dx = -raw * 22; player.update(dt, titleInp); }

  // smelling: the lit world sinks into cold dark so only body heat is left glowing
  const dim = 1 - 0.86 * player.sense;
  G.dim = dim;
  shared.uGridIntensity.value = dim;
  shared.uNightVision.value = 0.55 + player.sense * 0.75;
  shared.uNVColor.value.copy(NV_WARM).lerp(NV_COLD, player.sense);
  level.panels.material.color.setScalar(dim);

  movers.length = 0;
  movers.push(player.pos);
  for (const p of G.prey) if (p.alive || p.deadT < 3) movers.push(p.pos);
  level.updateLights(camera.position, G.time, 46 * dim, movers);
  updateFlashlights();

  // the monster's eye
  const u = post.u;
  G.blood = Math.max(0, G.blood - raw * 0.9);
  G.caKick = Math.max(0, G.caKick - raw * 1.3);
  u.uTime.value = G.time;
  u.uSense.value = player.sense;
  u.uBlood.value = G.blood;
  u.uStarve.value = smoothstep(0.32, 0.0, G.hunger);
  u.uCA.value = 0.0035 + (player.sprinting ? 0.004 : 0) + G.caKick * 0.02 + G.blood * 0.008 + player.sense * 0.004;
  u.uDistort.value = damp(u.uDistort.value, 0.16 + (player.sprinting ? 0.1 : 0) + G.caKick * 0.25, 5, raw);

  if (!G.dev.noRender) post.composer.render(raw);

  // drop internal resolution a notch whenever the machine cannot hold ~55 fps
  if (real < 0.25) { fpsT += real; fpsN++; }
  if (fpsT > 2.5) {
    if (autoScale && fpsT / fpsN > 0.0185 && scaleDown > 0.55 && G.state === 'playing' && document.visibilityState === 'visible') { scaleDown *= 0.87; resize(); }
    fpsT = 0; fpsN = 0;
  }
}

init().then(() => frame()).catch((e) => {
  console.error(e);
  $('go').textContent = 'it would not wake — see console';
});

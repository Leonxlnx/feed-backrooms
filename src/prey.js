import * as THREE from 'three';
import { CELL } from './level.js';
import { clamp, damp, angleDiff, pick, smoothstep } from './util.js';
import { patchMaterial } from './materials.js';

// ---- shared low-poly parts (all built from primitives, flat shaded) ----
const G_LIMB = new THREE.CylinderGeometry(0.5, 0.38, 1, 5);
G_LIMB.translate(0, -0.5, 0); // pivot at the top of the limb
const G_TORSO = new THREE.CylinderGeometry(0.5, 0.4, 1, 6);
const G_HEAD = new THREE.IcosahedronGeometry(0.5, 1);
const G_BOX = new THREE.BoxGeometry(1, 1, 1);
const G_TUBE = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
const G_BEAM = new THREE.ConeGeometry(1, 1, 20, 1, true);
G_BEAM.translate(0, -0.5, 0);
G_BEAM.rotateX(-Math.PI / 2); // apex at origin, opening along +z

const SKIN = [0xf0c8a0, 0xd9a47a, 0xb07a52, 0x8a5a3a, 0x5e3b24, 0xf5d6bd];
const SHIRT = [0xc23b3b, 0x2f74c0, 0x3d9a58, 0xe0b83a, 0xe07a2a, 0x8f55b8, 0xe8e2d4, 0x3aa9b5, 0xd95a8a];
const PANTS = [0x27303f, 0x3b3226, 0x1f1f24, 0x4a5568, 0x5a4632];
const HAIR = [0x1a1210, 0x3a2414, 0x6b4a22, 0xb08a3a, 0x7a2a12, 0x8a8a8a];

const HIP = 0.86;
const BEAM_LEN = 7.5;

const beamMat = () =>
  new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0.22 }, uColor: { value: new THREE.Color(1.0, 0.95, 0.8) } },
    vertexShader: `
      varying float vL; varying vec3 vN; varying vec3 vV;
      void main() {
        vL = position.z;
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        vN = normalMatrix * normal; vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uOpacity; uniform vec3 uColor;
      varying float vL; varying vec3 vN; varying vec3 vV;
      void main() {
        float f = abs( dot( normalize( vN ), normalize( vV ) ) );
        float a = pow( f, 2.2 ) * ( 1.0 - vL ) * ( 1.0 - vL ) * uOpacity;
        gl_FragColor = vec4( uColor * a, a );
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });

const ghostMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 }, uBeat: { value: 0 } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        vN = normalMatrix * normal; vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uOpacity, uBeat;
      varying vec3 vN; varying vec3 vV;
      void main() {
        float f = 1.0 - abs( dot( normalize( vN ), normalize( vV ) ) );
        float rim = pow( f, 1.4 );
        // hot core, white-hot edges; values above 1 so it blooms
        vec3 c = mix( vec3( 1.5, 0.12, 0.02 ), vec3( 2.6, 1.3, 0.45 ), rim ) * ( 1.0 + uBeat * 0.8 );
        float a = ( 0.34 + 0.66 * rim ) * uOpacity;
        gl_FragColor = vec4( c * a, a );
      }`,
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });

let _halo = null;
function haloTexture() {
  if (_halo) return _halo;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)');
  gr.addColorStop(0.3, 'rgba(255,255,255,0.35)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  _halo = new THREE.CanvasTexture(c);
  return _halo;
}

const POSE_KEYS = ['lean', 'bodyY', 'legL', 'legR', 'kneeL', 'kneeR', 'armLx', 'armRx', 'armLz', 'armRz', 'elbL', 'elbR', 'headX', 'headY'];

export class Prey {
  constructor(game, x, z, rng, id) {
    this.g = game;
    this.rng = rng;
    this.id = id;
    this.pos = new THREE.Vector3(x, 0, z);
    this.heading = rng() * Math.PI * 2;
    this.state = 'wander';
    this.stateT = 0;
    this.fear = 0;
    this.stamina = 1;
    this.speed = 0;
    this.phase = rng() * 6;
    this.wp = null; this.wpCell = -1; this.prevCell = -1; this.wpT = 0;
    this.field = new Int16Array(game.level.n * game.level.n);
    this.hasTarget = false;
    this.idleT = rng() * 2.5;
    this.nervous = 0;
    this.screamCd = 0;
    this.whimperCd = 2 + rng() * 4;
    this.lastSeenT = 99;
    this.cowerSafeT = 0;
    this.mouth = 0;
    this.lookYaw = 0;
    this.flail = rng() < 0.4;
    this.alive = true;
    this.deadT = 0;
    this.thinkT = rng() * 0.15;
    this.sees = false; this.hears = false; this.hasLos = false; this.dist = 99; this.angTo = 0;
    this.flashOn = rng() < 0.75;
    this.pose = {}; this.poseT = {};
    for (const k of POSE_KEYS) { this.pose[k] = 0; this.poseT[k] = 0; }
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._build(rng);
  }

  _build(rng) {
    const mat = (c, extra = {}) =>
      patchMaterial(new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.82, flatShading: true }, extra)), { gridOffset: 0, nv: 1.3 });
    const skin = mat(pick(rng, SKIN)), shirt = mat(pick(rng, SHIRT)), pants = mat(pick(rng, PANTS));
    const hair = mat(pick(rng, HAIR)), shoe = mat(0x15120f);
    const mesh = (geo, m, sx, sy, sz, x = 0, y = 0, z = 0) => {
      const o = new THREE.Mesh(geo, m);
      o.scale.set(sx, sy, sz); o.position.set(x, y, z); o.castShadow = true;
      return o;
    };
    const limb = (m, len, w) => { const p = new THREE.Group(); p.add(mesh(G_LIMB, m, w, len, w)); return p; };

    const root = (this.root = new THREE.Group());
    root.rotation.order = 'YXZ';
    const hips = (this.hips = new THREE.Group());
    hips.position.y = HIP;
    root.add(hips);
    const torso = (this.torso = new THREE.Group());
    hips.add(torso);
    torso.add(mesh(G_TORSO, shirt, 0.44, 0.58, 0.26, 0, 0.3, 0));
    hips.add(mesh(G_TORSO, pants, 0.38, 0.16, 0.24, 0, 0.0, 0));

    // legs
    const leg = (x) => {
      const thigh = limb(pants, 0.42, 0.155);
      thigh.position.set(x, 0, 0);
      const knee = limb(pants, 0.4, 0.125);
      knee.position.y = -0.42;
      knee.add(mesh(G_BOX, shoe, 0.115, 0.075, 0.25, 0, -0.4, 0.055));
      thigh.add(knee);
      hips.add(thigh);
      return [thigh, knee];
    };
    [this.legL, this.kneeL] = leg(-0.105);
    [this.legR, this.kneeR] = leg(0.105);

    // arms
    const arm = (x) => {
      const upper = limb(shirt, 0.3, 0.115);
      upper.position.set(x, 0.52, 0);
      const fore = limb(skin, 0.28, 0.09);
      fore.position.y = -0.3;
      fore.add(mesh(G_BOX, skin, 0.075, 0.09, 0.075, 0, -0.31, 0));
      upper.add(fore);
      torso.add(upper);
      return [upper, fore];
    };
    [this.armL, this.elbL] = arm(-0.265);
    [this.armR, this.elbR] = arm(0.265);

    // head + face
    const head = (this.head = new THREE.Group());
    head.position.y = 0.6;
    torso.add(head);
    head.add(mesh(G_TUBE, skin, 0.1, 0.08, 0.1, 0, 0.0, 0));
    head.add(mesh(G_HEAD, skin, 0.235, 0.275, 0.245, 0, 0.17, 0));
    if (rng() < 0.88) head.add(mesh(G_HEAD, hair, 0.255, 0.26, 0.265, 0, 0.215, -0.035));
    const white = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xe8e4dc, emissive: 0x262626, roughness: 0.35, flatShading: true }), { gridOffset: 0 });
    const black = new THREE.MeshBasicMaterial({ color: 0x050303 });
    const mouthMat = new THREE.MeshBasicMaterial({ color: 0x230404 });
    this.eyes = []; this.pupils = []; this.brows = [];
    for (const sx of [-1, 1]) {
      const e = mesh(G_HEAD, white, 0.062, 0.062, 0.05, sx * 0.055, 0.19, 0.103);
      const p = mesh(G_HEAD, black, 0.03, 0.03, 0.02, sx * 0.055, 0.19, 0.128);
      const b = mesh(G_BOX, hair, 0.065, 0.014, 0.016, sx * 0.055, 0.243, 0.112);
      e.castShadow = p.castShadow = b.castShadow = false;
      head.add(e, p, b);
      this.eyes.push(e); this.pupils.push(p); this.brows.push(b);
    }
    this.mouthMesh = mesh(G_BOX, mouthMat, 0.06, 0.012, 0.03, 0, 0.085, 0.108);
    this.mouthMesh.castShadow = false;
    head.add(this.mouthMesh);

    // flashlight in the right hand, pointing along the forearm
    const fl = (this.flash = new THREE.Group());
    fl.position.set(0, -0.33, 0.03);
    fl.rotation.x = Math.PI / 2;
    this.elbR.add(fl);
    if (this.flashOn) {
      const body = mesh(G_TUBE, mat(0x202024, { roughness: 0.4 }), 0.05, 0.17, 0.05);
      body.rotation.x = Math.PI / 2;
      fl.add(body);
      const lens = new THREE.Mesh(G_TUBE, new THREE.MeshBasicMaterial({ color: 0xfff6d8 }));
      lens.scale.set(0.058, 0.012, 0.058); lens.rotation.x = Math.PI / 2; lens.position.z = 0.09;
      fl.add(lens);
      this.lens = lens;
      const beam = (this.beam = new THREE.Mesh(G_BEAM, beamMat()));
      const r = BEAM_LEN * Math.tan(0.36);
      beam.scale.set(r, r, BEAM_LEN);
      beam.position.z = 0.1;
      beam.frustumCulled = false;
      fl.add(beam);
    }

    // thermal ghost of the whole body (every limb, so you see them run / cower through walls)
    // plus a beating heart, only drawn while the monster is smelling
    this.ghostMat = ghostMaterial();
    this.ghosts = [];
    const parts = [];
    root.traverse((o) => { if (o.isMesh && o.castShadow) parts.push(o); });
    for (const o of parts) {
      const gm = new THREE.Mesh(o.geometry, this.ghostMat);
      gm.renderOrder = 999;
      gm.visible = false;
      o.add(gm);
      this.ghosts.push(gm);
    }
    this.heart = new THREE.Mesh(G_HEAD, new THREE.MeshBasicMaterial({
      color: 0xff6a30, transparent: true, opacity: 0, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }));
    this.heart.position.set(-0.05, 0.37, 0.05);
    this.heart.renderOrder = 1000;
    this.heart.visible = false;
    torso.add(this.heart);
    // soft body-heat halo so they still read from across the level
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: haloTexture(), color: 0xff3208, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false,
    }));
    this.halo.scale.set(2.3, 3.0, 1);
    this.halo.position.y = 0.95;
    this.halo.renderOrder = 997;
    this.halo.visible = false;
    root.add(this.halo);
    this.ghostOn = false;

    const s = 0.93 + rng() * 0.15;
    root.scale.setScalar(s);
    root.position.copy(this.pos);
    this.g.scene.add(root);
  }

  // ------------------------------------------------------------ perception
  _perceive() {
    const p = this.g.player, L = this.g.level;
    const dx = p.pos.x - this.pos.x, dz = p.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    this.dist = dist;
    this.angTo = Math.atan2(dx, dz);
    this.hasLos = dist < 26 && L.los(this.pos.x, this.pos.z, p.pos.x, p.pos.z);
    let sees = false;
    if (this.hasLos) {
      const off = Math.abs(angleDiff(this.heading + this.lookYaw, this.angTo));
      const lit = L.lightAt(p.pos.x, p.pos.z);
      let range = 6.5 + 15 * clamp(lit * 3.2, 0, 1); // the dark hides you
      if (this.flashOn && off < 0.42) range = Math.max(range, 15);
      if (this.state === 'flee' || this.state === 'cower') range += 6;
      if (dist < 3 || (off < 1.3 && dist < range)) sees = true;
    }
    this.sees = sees;
    this.hears = dist < 2.4 || (p.sprinting && p.moving && dist < 9.5);
  }

  // ------------------------------------------------------------ state changes
  _set(state) { this.state = state; this.stateT = 0; this.wp = null; }

  _startle() {
    if (this.state === 'startle') return;
    this._set('startle');
    this.fear = 1;
    this.mouth = 1;
    this.lastSeenT = 0;
    this.g.onPreySpotted(this);
  }

  alert(x, z, fear = 0.6) {
    if (!this.alive || this.state !== 'wander') return;
    this._set('alert');
    this.alertDir = Math.atan2(x - this.pos.x, z - this.pos.z);
    this.alertDur = 0.9 + this.rng() * 1.3;
    this.fear = Math.max(this.fear, fear);
    this.nervous = 14;
    if (this.whimperCd <= 0.5) { this.g.preyVoice(this, 'prey_whimper', 0.7); this.whimperCd = 3 + this.rng() * 3; this.mouth = 0.6; }
  }

  roared(dist) {
    if (!this.alive) return;
    if (dist < 14) {
      this._set('frozen');
      this.frozenDur = 1.3 + this.rng() * 1.1;
      this.fear = 1; this.mouth = 1;
      this.g.preyVoice(this, 'prey_scream', 1, this.rng() * 0.5);
      this.screamCd = 3;
    } else if (this.state === 'wander') {
      const p = this.g.player.pos;
      this.alert(p.x, p.z, 0.8);
    }
  }

  die() {
    this.alive = false;
    this._set('dead');
    this.deadT = 0;
    this.speed = 0;
    this.setSense(0, 0, 0);
    this.fallDir = this.rng() < 0.5 ? 1 : -1;
    if (this.beam && this.rng() < 0.45) { this.flashOn = false; this.beam.visible = false; this.lens.material.color.set(0x111111); }
  }

  // ------------------------------------------------------------ movement helpers
  _cell() {
    const L = this.g.level;
    return Math.floor(this.pos.z / CELL) * L.n + Math.floor(this.pos.x / CELL);
  }

  // walk along a BFS field: sign -1 descends to the field origin, +1 climbs away from it.
  // returns 'moving' | 'arrived' | 'cornered'
  _follow(dt, field, sign, speed, turn) {
    const L = this.g.level, n = L.n;
    const cur = this._cell();
    this.wpT += dt;
    let need = !this.wp || this.wpT > 2.2;
    if (this.wp) {
      const dx = this.wp.x - this.pos.x, dz = this.wp.z - this.pos.z;
      if (dx * dx + dz * dz < 0.2) need = true;
    }
    if (need) {
      const cx = cur % n, cz = (cur / n) | 0, here = field[cur];
      let best = -1, bestScore = -1e9, bestVal = here;
      for (let oz = -1; oz <= 1; oz++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oz) continue;
          const x = cx + ox, z = cz + oz;
          if (L.isWall(x, z)) continue;
          if (ox && oz && (L.isWall(cx + ox, cz) || L.isWall(cx, cz + oz))) continue; // no corner cutting
          const i = z * n + x, v = field[i];
          if (v < 0) continue;
          let score = sign * v;
          if (sign > 0) score += this.rng() * 0.7 - (i === this.prevCell ? 1.4 : 0);
          if (score > bestScore) { bestScore = score; best = i; bestVal = v; }
        }
      }
      if (best < 0 || (sign < 0 && bestVal >= here) || (sign > 0 && bestVal <= here)) {
        this.wp = null;
        this.speed = damp(this.speed, 0, 10, dt);
        return sign < 0 ? 'arrived' : 'cornered';
      }
      this.prevCell = cur; this.wpCell = best; this.wpT = 0;
      this.wp = {
        x: ((best % n) + 0.5 + (this.rng() - 0.5) * 0.35) * CELL,
        z: (((best / n) | 0) + 0.5 + (this.rng() - 0.5) * 0.35) * CELL,
      };
    }
    const want = Math.atan2(this.wp.x - this.pos.x, this.wp.z - this.pos.z);
    const diff = angleDiff(this.heading, want);
    this.heading += clamp(diff, -turn * dt, turn * dt);
    const slow = Math.abs(diff) > 1.1 ? 0.35 : 1;
    this.speed = damp(this.speed, speed * slow, 7, dt);
    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.z += Math.cos(this.heading) * this.speed * dt;
    L.resolveCircle(this.pos, 0.3);
    return 'moving';
  }

  _face(angle, dt, rate = 9) {
    this.heading += clamp(angleDiff(this.heading, angle), -rate * dt, rate * dt);
  }

  _pickTarget() {
    const L = this.g.level, M = L.M;
    for (let tries = 0; tries < 6; tries++) {
      const mx = Math.floor(this.rng() * M), mz = Math.floor(this.rng() * M);
      const c = L.macroCenter(mx, mz);
      // nervous people do not wander toward where they last heard the thing
      if (this.nervous > 0) {
        const p = this.g.player.pos;
        if (Math.hypot(c.x - p.x, c.z - p.z) < 22) continue;
      }
      L.bfs(Math.floor(c.x / CELL), Math.floor(c.z / CELL), this.field);
      if (this.field[this._cell()] > 0) { this.hasTarget = true; return; }
    }
  }

  // ------------------------------------------------------------ brain
  _act(dt) {
    const g = this.g, rng = this.rng;
    switch (this.state) {
      case 'wander': {
        this.fear = damp(this.fear, this.nervous > 0 ? 0.35 : 0, 0.6, dt);
        if (this.sees) return this._startle();
        if (this.hears) return this.alert(g.player.pos.x, g.player.pos.z);
        if (this.idleT > 0) {
          this.idleT -= dt;
          this.speed = damp(this.speed, 0, 8, dt);
          this.lookYaw = damp(this.lookYaw, Math.sin(g.time * 0.8 + this.id * 2.1) * 1.0, 3, dt);
          return;
        }
        this.lookYaw = damp(this.lookYaw, Math.sin(g.time * 0.5 + this.id) * 0.45, 3, dt);
        if (!this.hasTarget) { this._pickTarget(); if (!this.hasTarget) { this.idleT = 1; return; } }
        const r = this._follow(dt, this.field, -1, this.nervous > 0 ? 2.0 : 1.2, 4.5);
        if (r === 'arrived') { this.hasTarget = false; this.idleT = this.nervous > 0 ? 0.6 + rng() : 1.2 + rng() * 3.5; }
        return;
      }
      case 'alert': {
        this.speed = damp(this.speed, 0, 10, dt);
        this._face(this.alertDir, dt, 5);
        this.lookYaw = damp(this.lookYaw, 0, 5, dt);
        if (this.sees) return this._startle();
        if (this.stateT > this.alertDur) { this._set('wander'); this.hasTarget = false; this.idleT = 0; }
        return;
      }
      case 'startle': {
        this.speed = damp(this.speed, 0, 14, dt);
        this._face(this.angTo, dt, 12);
        this.lookYaw = damp(this.lookYaw, 0, 10, dt);
        if (this.stateT > 0.55) this._set('flee');
        return;
      }
      case 'frozen': {
        this.speed = damp(this.speed, 0, 14, dt);
        this._face(this.angTo, dt, 6);
        this.fear = 1;
        if (this.stateT > this.frozenDur) { this._set('flee'); this.lastSeenT = 0; }
        return;
      }
      case 'flee': {
        this.fear = 1;
        this.lastSeenT = this.sees ? 0 : this.lastSeenT + dt;
        this.stamina = Math.max(0, this.stamina - dt * 0.085);
        const speed = this.stamina > 0 ? 4.9 : 3.1;
        const r = this._follow(dt, g.monsterField, 1, speed, 9);
        // glance back over the shoulder
        const glance = Math.sin(g.time * 2.6 + this.id * 3) > 0.35 ? clamp(angleDiff(this.heading, this.angTo), -2.0, 2.0) : 0;
        this.lookYaw = damp(this.lookYaw, glance, 9, dt);
        if (r === 'cornered') {
          this._face(this.angTo, dt, 8);
          if (this.dist < 6 && this.hasLos) { this._set('cower'); this.cowerSafeT = 0; this.cowerBreak = 5 + rng() * 5; return; }
        }
        if (this.lastSeenT > 7 && this.dist > 15) {
          this._set('wander'); this.nervous = 16; this.hasTarget = false; this.idleT = 0.5;
          return;
        }
        if (this.screamCd <= 0 && this.dist < 7 && this.hasLos) {
          g.preyVoice(this, 'prey_scream', 1, rng() * 0.25);
          this.screamCd = 2.6 + rng() * 2.5; this.mouth = 1;
          g.spreadPanic(this);
        } else if (this.whimperCd <= 0) {
          g.preyVoice(this, 'prey_whimper', 0.75);
          this.whimperCd = 2.5 + rng() * 3.5; this.mouth = 0.7;
        }
        return;
      }
      case 'cower': {
        this.fear = 1;
        this.speed = damp(this.speed, 0, 14, dt);
        this._face(this.angTo, dt, 4);
        this.stamina = Math.min(1, this.stamina + dt * 0.1);
        this.cowerSafeT = this.sees ? 0 : this.cowerSafeT + dt;
        if (this.screamCd <= 0 && this.dist < 3.6) {
          g.preyVoice(this, 'prey_scream', 1, rng() * 0.3);
          this.screamCd = 2 + rng() * 2; this.mouth = 1;
        } else if (this.whimperCd <= 0) {
          g.preyVoice(this, 'prey_whimper', 0.8);
          this.whimperCd = 1.8 + rng() * 2.5; this.mouth = 0.6;
        }
        // either the thing left, or they lose their nerve and bolt
        if ((this.cowerSafeT > 3 && this.dist > 8) || (this.stateT > this.cowerBreak && this.dist > 3.2)) {
          this._set('flee'); this.lastSeenT = 3; this.prevCell = -1;
        }
        return;
      }
    }
  }

  // ------------------------------------------------------------ animation
  _animate(dt) {
    const t = this.g.time, T = this.poseT, s = this.state;
    const moving = this.speed > 0.2, run = this.speed > 2.7;
    const prevPh = this.phase;
    if (moving) this.phase += dt * (3.0 + this.speed * 2.0);
    const ph = this.phase, sn = Math.sin(ph), cs = Math.cos(ph);
    if (run && Math.floor(prevPh / Math.PI) !== Math.floor(ph / Math.PI)) this.g.preyStep(this);

    // neutral: standing, torch arm held out
    T.lean = 0.04; T.bodyY = 0; T.legL = 0; T.legR = 0; T.kneeL = 0.06; T.kneeR = 0.06;
    T.armLx = 0; T.armLz = -0.07; T.elbL = -0.15;
    T.armRx = this.flashOn ? -1.05 : 0; T.armRz = 0.07; T.elbR = this.flashOn ? -0.45 : -0.15;
    T.headX = 0; T.headY = this.lookYaw;

    if (moving) {
      const A = run ? 0.95 : 0.42, K = run ? 1.55 : 0.7;
      T.legL = -sn * A; T.legR = sn * A;
      T.kneeL = Math.max(0, cs) * K + 0.08; T.kneeR = Math.max(0, -cs) * K + 0.08;
      T.bodyY = Math.abs(cs) * (run ? 0.07 : 0.022);
      T.lean = run ? 0.36 : 0.07;
      T.armLx = sn * (run ? 1.05 : 0.38); T.elbL = run ? -1.5 : -0.25;
      if (run) {
        T.armRx = -sn * 1.05; T.elbR = -1.5;
        if (this.flail) {
          T.armLx = -2.75 + Math.sin(ph * 1.7) * 0.55; T.armRx = -2.65 + Math.cos(ph * 1.9) * 0.55;
          T.armLz = -0.55; T.armRz = 0.55; T.elbL = -0.5; T.elbR = -0.6;
        }
      } else if (this.flashOn) {
        T.armRx = -1.05 + sn * 0.05;
      }
    }
    if (s === 'alert') {
      T.bodyY = -0.05; T.lean = 0.12; T.armLx = -0.75; T.elbL = -1.7; T.kneeL = T.kneeR = 0.25; T.legL = T.legR = -0.12;
    } else if (s === 'startle' || s === 'frozen') {
      T.lean = -0.2; T.bodyY = -0.05;
      T.armLx = -0.7; T.armLz = -1.05; T.elbL = -0.5;
      T.armRx = -0.7; T.armRz = 1.05; T.elbR = -0.5;
      T.kneeL = T.kneeR = 0.3; T.legL = T.legR = -0.15;
    } else if (s === 'cower') {
      T.bodyY = -0.6; T.lean = 0.78;
      T.legL = T.legR = -1.75; T.kneeL = T.kneeR = 2.5;
      T.armLx = T.armRx = -2.5; T.elbL = T.elbR = -2.0; T.armLz = -0.28; T.armRz = 0.28;
      T.headX = 0.55; T.headY = 0;
    } else if (s === 'flee' && !moving) {
      // cornered but still on their feet: backing up, hands out
      T.lean = -0.12; T.armLx = -1.2; T.armRx = -1.2; T.elbL = -0.6; T.elbR = -0.6; T.kneeL = T.kneeR = 0.35; T.legL = T.legR = -0.17;
    }

    const P = this.pose, k = s === 'startle' ? 22 : 13;
    for (const key of POSE_KEYS) P[key] = damp(P[key], T[key], k, dt);

    const f = this.fear, shake = f * (s === 'cower' || s === 'frozen' ? 2.2 : 1);
    this.hips.position.y = HIP + P.bodyY;
    this.torso.rotation.set(P.lean, 0, Math.sin(t * 53 + this.id) * 0.018 * shake);
    this.legL.rotation.x = P.legL; this.legR.rotation.x = P.legR;
    this.kneeL.rotation.x = P.kneeL; this.kneeR.rotation.x = P.kneeR;
    this.armL.rotation.set(P.armLx + Math.sin(t * 61 + this.id) * 0.03 * shake, 0, P.armLz);
    this.armR.rotation.set(P.armRx + Math.sin(t * 57 + this.id * 2) * 0.04 * shake, 0, P.armRz);
    this.elbL.rotation.x = P.elbL; this.elbR.rotation.x = P.elbR;
    this.head.rotation.set(P.headX + Math.sin(t * 49) * 0.02 * shake, P.headY, 0);

    // the face
    this.mouth = Math.max(0, this.mouth - dt * 0.9);
    const open = Math.max(this.mouth, f > 0.6 ? 0.32 + 0.1 * Math.sin(t * 9 + this.id) : 0);
    this.mouthMesh.scale.set(0.06 - open * 0.012, 0.012 + open * 0.085, 0.03);
    this.mouthMesh.position.y = 0.085 - open * 0.02;
    for (let i = 0; i < 2; i++) {
      const es = 1 + f * 0.75;
      this.eyes[i].scale.set(0.062 * es, 0.062 * es, 0.05);
      this.pupils[i].scale.set(0.03 * (1 - f * 0.4), 0.03 * (1 - f * 0.4), 0.02);
      this.pupils[i].position.z = 0.128 + f * 0.004;
      this.brows[i].position.y = 0.243 + f * 0.03;
      this.brows[i].rotation.z = (i === 0 ? 1 : -1) * f * 0.55;
    }

    this.root.position.set(this.pos.x, 0, this.pos.z);
    this.root.rotation.set(0, this.heading, Math.sin(t * 47 + this.id) * 0.012 * shake);
  }

  _animateDead(dt) {
    this.deadT += dt;
    const k = 1 - Math.exp(-this.deadT * 7);
    const P = this.pose;
    const T = { lean: 0, bodyY: 0, legL: -0.25, legR: 0.2, kneeL: 0.5, kneeR: 0.1, armLx: -0.4, armRx: 0.3, armLz: -1.25, armRz: 1.0, elbL: -0.6, elbR: -0.3, headX: -0.3, headY: 0.7 * this.fallDir };
    for (const key of POSE_KEYS) P[key] = damp(P[key], T[key], 9, dt);
    this.hips.position.y = HIP;
    this.torso.rotation.set(P.lean, 0, 0);
    this.legL.rotation.x = P.legL; this.legR.rotation.x = P.legR;
    this.kneeL.rotation.x = P.kneeL; this.kneeR.rotation.x = P.kneeR;
    this.armL.rotation.set(P.armLx, 0, P.armLz); this.armR.rotation.set(P.armRx, 0, P.armRz);
    this.elbL.rotation.x = P.elbL; this.elbR.rotation.x = P.elbR;
    this.head.rotation.set(P.headX, P.headY, 0);
    // topple backwards and settle on the carpet
    this.root.rotation.set((-Math.PI / 2) * k, this.heading, 0.12 * this.fallDir * k);
    this.root.position.set(this.pos.x, 0.13 * k, this.pos.z);
    this.mouthMesh.scale.set(0.05, 0.07, 0.03);
  }

  update(dt) {
    if (!this.alive) { if (this.deadT < 3) this._animateDead(dt); return; }
    this.stateT += dt;
    this.screamCd -= dt; this.whimperCd -= dt;
    if (this.nervous > 0) this.nervous -= dt;
    if (this.state !== 'flee' && this.state !== 'cower') this.stamina = Math.min(1, this.stamina + dt * 0.06);
    this.thinkT -= dt;
    if (this.thinkT <= 0) { this.thinkT = 0.1; this._perceive(); }
    this._act(dt);
    if (this.alive) this._animate(dt);
  }

  // drive the thermal ghost: sense 0..1, distance to the monster, time
  setSense(sense, d, t) {
    const on = sense > 0.02 && this.alive;
    if (on !== this.ghostOn) {
      this.ghostOn = on;
      for (const gm of this.ghosts) gm.visible = on;
      this.heart.visible = on;
      this.halo.visible = on;
    }
    if (!on) return;
    const beat = Math.pow(0.5 + 0.5 * Math.sin(t * (5 + this.fear * 7) + this.id * 1.7), 6);
    const fade = 1 - smoothstep(42, 68, d);
    this.ghostMat.uniforms.uOpacity.value = sense * fade * (0.8 + 0.35 * beat);
    this.ghostMat.uniforms.uBeat.value = beat;
    this.heart.material.opacity = sense * fade;
    this.heart.scale.setScalar((0.075 + beat * 0.06) * (1 + d * 0.045));
    // the halo grows a little with distance so far-off prey are still findable
    this.halo.material.opacity = sense * fade * (0.22 + 0.2 * beat);
    const hs = 1 + d * 0.02;
    this.halo.scale.set(2.3 * hs, 3.0 * hs, 1);
  }

  // world-space torch origin + direction
  getFlash(pos, dir) {
    this.flash.getWorldPosition(pos);
    this.flash.getWorldQuaternion(this._q);
    dir.set(0, 0, 1).applyQuaternion(this._q);
  }
}

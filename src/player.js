import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, damp } from './util.js';
import { patchMaterial } from './materials.js';

// geometry baking helpers: place a copy of a primitive, then weld static pieces into a single mesh
const UP = new THREE.Vector3(0, 1, 0), ONE = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
function bake(geo, px, py, pz, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.applyMatrix4(_m.compose(new THREE.Vector3(px, py, pz), _q.setFromEuler(_e.set(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)));
  return g;
}
function strutGeo(a, b, r0, r1, seg = 6) {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg).toNonIndexed();
  g.applyMatrix4(_m.compose(a.clone().addScaledVector(d, 0.5), _q.setFromUnitVectors(UP, d.clone().normalize()), ONE));
  return g;
}
function merged(list, mat) {
  const g = mergeGeometries(list, false);
  for (const x of list) x.dispose();
  return new THREE.Mesh(g, mat);
}

const EYE = 2.14; // it is taller than they are
const ease = (x) => x * x * (3 - 2 * x);
const IVORY = new THREE.Color(0xcfc3a4), GORE = new THREE.Color(0x6a0404);

// claw swipe keyframes -> [rotX, rotY, posY, posZ] offsets
function slash(a) {
  if (a <= 0 || a >= 1) return [0, 0, 0, 0];
  if (a < 0.3) { const k = ease(a / 0.3); return [0.8 * k, -0.5 * k, 0.16 * k, 0.06 * k]; }
  if (a < 0.55) { const k = ease((a - 0.3) / 0.25); return [0.8 - 1.55 * k, -0.5 + 1.3 * k, 0.16 - 0.24 * k, 0.06 - 0.34 * k]; }
  const k = 1 - ease((a - 0.55) / 0.45);
  return [-0.75 * k, 0.8 * k, -0.08 * k, -0.28 * k];
}

// forearm silhouette: [radius, distance from elbow]
const FORE = [[0.06, 0], [0.078, 0.07], [0.074, 0.2], [0.055, 0.42], [0.038, 0.62], [0.031, 0.74], [0.039, 0.8]];
function foreRadius(d) {
  for (let i = 1; i < FORE.length; i++) {
    if (d <= FORE[i][1]) {
      const k = (d - FORE[i - 1][1]) / (FORE[i][1] - FORE[i - 1][1]);
      return FORE[i - 1][0] + (FORE[i][0] - FORE[i - 1][0]) * k;
    }
  }
  return FORE[FORE.length - 1][0];
}

export class Player {
  constructor(game, camera, x, z) {
    this.g = game;
    this.cam = camera;
    this.pos = new THREE.Vector3(x, 0, z);
    this.yaw = 0; this.pitch = 0;
    this.vx = 0; this.vz = 0;
    this.stamina = 1; this.exhausted = false;
    this.sprinting = false; this.moving = false;
    this.bob = 0; this.speed = 0;
    this.attackT = -1; this.attackCd = 0; this.hitDone = true;
    this.roarCd = 0; this.roarT = 9;
    this.sense = 0; this.trauma = 0; this.lungeV = 0; this.dip = 0;
    camera.rotation.order = 'YXZ';
    this._buildArms();
    this._buildShadowBody();
  }

  _buildArms() {
    const tex = this.g.tex && this.g.tex.concrete;
    const col = (tex && tex.color) || null, nrm = (tex && tex.normal) || null, rgh = (tex && tex.roughness) || null;
    // leathery hide: the stained concrete set makes good mottled skin, pores and scars
    // (same texture slots + shader variant as the walls, so it costs no extra shader compile)
    const skin = patchMaterial(new THREE.MeshStandardMaterial({
      color: 0x7a605c, map: col, roughness: rgh ? 0.55 : 0.45, roughnessMap: rgh, normalMap: nrm, normalScale: new THREE.Vector2(2.4, 2.4),
    }), { gridOffset: 0, nv: 1.6, grimeVariant: true });
    const sinew = (this.sinewMat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0x5e2420, roughness: 0.3, emissive: 0x200403 }), { gridOffset: 0, nv: 1.6 }));
    const bone = (this.clawMat = patchMaterial(new THREE.MeshStandardMaterial({ color: IVORY.clone(), roughness: 0.24 }), { gridOffset: 0, nv: 1.6 }));

    const uvScale = (g, su, sv) => { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv); return g; };
    const foreGeo = uvScale(new THREE.LatheGeometry(FORE.map(([r, y]) => new THREE.Vector2(r, y)), 14), 2, 3);
    foreGeo.rotateX(-Math.PI / 2); // elbow at z = 0, wrist at z = -0.8
    const blobGeo = uvScale(new THREE.IcosahedronGeometry(1, 2), 2, 2);
    const segGeo = new THREE.CylinderGeometry(0.8, 1, 1, 7);
    segGeo.translate(0, 0.5, 0); segGeo.rotateX(-Math.PI / 2); // from z = 0 to z = -1, thick end at the joint
    const knuckleGeo = new THREE.IcosahedronGeometry(1, 1);
    // hooked talon: a cone bent downward along its length
    const clawGeo = new THREE.ConeGeometry(0.0115, 0.17, 7, 8);
    clawGeo.translate(0, 0.085, 0);
    {
      const p = clawGeo.attributes.position;
      for (let i = 0; i < p.count; i++) { const t = p.getY(i) / 0.17; p.setZ(i, p.getZ(i) - 0.055 * t * t); }
      clawGeo.rotateX(-Math.PI / 2);
      clawGeo.computeVertexNormals();
    }
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const HZ = -0.8; // wrist

    // everything that does not move against the forearm is baked into one mesh per material,
    // and every finger bone is one mesh, so two detailed arms cost ~45 draw calls instead of ~220
    const mk = (side) => {
      const arm = new THREE.Group();
      const S = [], N = [], B = []; // skin, sinew, bone
      S.push(bake(foreGeo, 0, 0, 0, 1.22, 0.86, 1));
      // elbow + a stub of upper arm so nothing ends in mid-air when the arm swings up
      S.push(bake(blobGeo, 0, 0, 0, 0.085, 0.07, 0.08));
      S.push(strutGeo(V(0, 0, 0.02), V(side * 0.14, -0.5, 0.36), 0.075, 0.09, 10));
      // tendons standing out along the top of the forearm
      for (const tx of [-0.022, 0, 0.022]) N.push(strutGeo(V(tx * 0.5, 0.05, -0.26), V(tx, 0.03, HZ), 0.008, 0.005));
      N.push(strutGeo(V(-side * 0.05, 0.02, -0.2), V(-side * 0.03, 0.012, -0.78), 0.007, 0.004));
      // bone spurs breaking through along the outer edge
      const spurs = [[0.1, 0.1, 0.016], [0.24, 0.085, 0.014], [0.38, 0.065, 0.011], [0.5, 0.05, 0.009], [0.6, 0.036, 0.007]];
      for (const [d, len, r] of spurs) {
        const sx = side * foreRadius(d) * 1.05;
        B.push(strutGeo(V(sx, 0.012, -d), V(sx + side * len * 0.75, 0.012 + len * 0.35, -d + len * 0.55), r, 0.0008));
      }
      // wrist + palm
      S.push(bake(blobGeo, 0, 0, HZ, 0.047, 0.032, 0.042));
      S.push(bake(blobGeo, 0, 0, HZ - 0.066, 0.064, 0.022, 0.07));

      const hand = new THREE.Group();
      hand.position.z = HZ;
      arm.add(hand);

      const fingers = [];
      const finger = (x, z, yaw, lens, r, base, clawScale) => {
        const joints = [];
        let parent = hand, px = x, py = 0.004, pz = z;
        lens.forEach((L, i) => {
          const j = new THREE.Group();
          j.position.set(px, py, pz);
          if (i === 0) { j.rotation.order = 'YXZ'; j.rotation.y = yaw; }
          j.rotation.x = base[i];
          parent.add(j);
          const rr = r * (1 - i * 0.15);
          const parts = [bake(segGeo, 0, 0, 0, rr, rr, L), bake(knuckleGeo, 0, 0, 0, rr * 1.32, rr * 1.32, rr * 1.32)];
          if (i === lens.length - 1) {
            // fingertip knuckle and the talon ride on the last bone
            parts.push(bake(knuckleGeo, 0, 0, -L, r * 0.95, r * 0.95, r * 0.95));
            j.add(new THREE.Mesh(bake(clawGeo, 0, 0, -L, clawScale, clawScale, clawScale, -0.28), bone));
          }
          j.add(merged(parts, skin));
          joints.push(j);
          parent = j; px = 0; py = 0; pz = -L;
        });
        fingers.push({ joints, base, cur: 0 });
      };
      const lenMul = [0.95, 1.12, 1.05, 0.84];
      for (let i = 0; i < 4; i++) {
        const o = i - 1.5, m = lenMul[side > 0 ? i : 3 - i];
        const kx = o * 0.034, kz = -0.122 + Math.abs(o) * 0.013;
        N.push(strutGeo(V(o * 0.012, 0.016, HZ - 0.005), V(kx, 0.014, HZ + kz), 0.0075, 0.006)); // metacarpal ridge
        finger(kx, kz, -o * 0.21, [0.088 * m, 0.062 * m, 0.046 * m], 0.0125, [-0.16, -0.42, -0.5], 0.9 + m * 0.2);
      }
      finger(-side * 0.052, -0.03, side * 1.05, [0.062, 0.05], 0.0135, [-0.25, -0.45], 0.95); // thumb
      arm.add(merged(S, skin), merged(N, sinew), merged(B, bone));
      return { arm, hand, fingers, side };
    };
    this.arms = [mk(-1), mk(1)];
    this.armRoot = new THREE.Group();
    for (const a of this.arms) this.armRoot.add(a.arm);
    this.cam.add(this.armRoot);
  }

  // claws stay wet after feeding: k = 0 clean ivory, 1 soaked
  setBlood(k) {
    this.clawMat.color.lerpColors(IVORY, GORE, clamp(k, 0, 1));
    this.clawMat.roughness = 0.24 - 0.14 * clamp(k, 0, 1);
  }

  // invisible to the camera, but it still casts the thing's silhouette on the walls
  _buildShadowBody() {
    const m = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    const g = (this.body = new THREE.Group());
    const parts = [];
    const add = (geo, x, y, z, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) => { parts.push(bake(geo, x, y, z, sx, sy, sz, rx, 0, rz)); };
    const cyl = (r0, r1, h) => new THREE.CylinderGeometry(r0, r1, h, 6);
    add(cyl(0.2, 0.3, 1.2), 0, 1.4, 0.05, 0.12);
    add(new THREE.IcosahedronGeometry(0.25, 0), 0, 2.16, -0.02, 0, 0, 0.85, 1.25, 1.0);
    for (const s of [-1, 1]) {
      add(cyl(0.02, 0.04, 0.62), s * 0.22, 2.56, 0, 0, -s * 0.55); // antler
      add(cyl(0.012, 0.022, 0.3), s * 0.36, 2.68, 0, 0, -s * 1.25);
      add(cyl(0.012, 0.022, 0.26), s * 0.2, 2.74, 0, 0, s * 0.25);
      add(cyl(0.05, 0.035, 1.45), s * 0.42, 1.3, 0, 0, s * 0.16); // arm
      for (let i = -1; i <= 1; i++) add(new THREE.ConeGeometry(0.015, 0.3, 4), s * 0.53 + i * 0.04, 0.47, 0, Math.PI, s * 0.1 + i * 0.25);
      add(cyl(0.09, 0.06, 0.95), s * 0.14, 0.47, 0); // leg
    }
    const whole = merged(parts, m); // one draw per shadow pass
    whole.castShadow = true;
    g.add(whole);
    this.g.scene.add(g);
  }

  update(dt, inp) {
    const g = this.g, t = g.time;
    this.yaw -= inp.dx * 0.0021;
    this.pitch = clamp(this.pitch - inp.dy * 0.0021, -1.3, 1.3);

    const sensing = inp.sense && this.attackT < 0;
    this.sense = damp(this.sense, sensing ? 1 : 0, 7, dt);

    let f = inp.fwd, s = inp.strafe;
    const len = Math.hypot(f, s);
    if (len > 1) { f /= len; s /= len; }
    this.moving = len > 0.1;
    if (this.stamina <= 0) this.exhausted = true;
    if (this.stamina > 0.3) this.exhausted = false;
    this.sprinting = inp.sprint && this.moving && inp.fwd > 0 && !sensing && !this.exhausted;
    this.stamina = clamp(this.stamina + dt * (this.sprinting ? -0.16 : 0.12), 0, 1);

    let speed = this.sprinting ? 7.2 : 3.5;
    if (sensing) speed *= 0.42;
    const sn = Math.sin(this.yaw), cs = Math.cos(this.yaw);
    const wx = (-sn * f + cs * s) * speed, wz = (-cs * f - sn * s) * speed;
    this.vx = damp(this.vx, wx, 9, dt);
    this.vz = damp(this.vz, wz, 9, dt);
    this.lungeV = damp(this.lungeV, 0, 7, dt);
    this.pos.x += (this.vx - sn * this.lungeV) * dt;
    this.pos.z += (this.vz - cs * this.lungeV) * dt;
    g.level.resolveCircle(this.pos, 0.42);
    this.speed = Math.hypot(this.vx, this.vz);

    // heavy steps
    const prev = this.bob;
    this.bob += dt * this.speed * 1.38;
    if (this.speed > 1 && Math.floor(prev / Math.PI) !== Math.floor(this.bob / Math.PI)) {
      g.monsterStep(this.sprinting);
      this.dip = this.sprinting ? 0.05 : 0.03;
    }
    this.dip = damp(this.dip, 0, 9, dt);

    // attack
    this.attackCd -= dt;
    if (inp.attack && this.attackCd <= 0 && !sensing) {
      this.attackT = 0; this.attackCd = 0.72; this.hitDone = false; this.lungeV = 8;
      g.onAttackStart();
    }
    if (this.attackT >= 0) {
      this.attackT += dt / 0.5;
      if (!this.hitDone && this.attackT > 0.42) { this.hitDone = true; g.tryKill(); }
      if (this.attackT >= 1) this.attackT = -1;
    }
    // roar
    this.roarCd -= dt; this.roarT += dt;
    if (inp.roar && this.roarCd <= 0) { this.roarCd = 11; this.roarT = 0; g.onRoar(); }

    // camera
    this.trauma = Math.max(0, this.trauma - dt * 1.5);
    const sh = this.trauma * this.trauma;
    const sway = clamp(this.speed / 6.5, 0, 1);
    const breathe = Math.sin(t * 1.5) * 0.012;
    const cam = this.cam;
    cam.position.set(
      this.pos.x + Math.sin(t * 61) * sh * 0.05,
      EYE - this.sense * 0.3 + Math.abs(Math.sin(this.bob)) * 0.07 * sway - this.dip + breathe + Math.sin(t * 73) * sh * 0.05,
      this.pos.z + Math.sin(t * 67) * sh * 0.05
    );
    const roar = this.roarT < 1 ? Math.sin(this.roarT * 60) * (1 - this.roarT) * 0.02 : 0;
    cam.rotation.set(
      this.pitch + Math.sin(t * 83) * sh * 0.06 + roar,
      this.yaw + Math.sin(t * 71) * sh * 0.06,
      Math.sin(this.bob) * 0.016 * sway + Math.sin(t * 59) * sh * 0.07 + roar
    );
    const fov = 80 + (this.sprinting ? 13 : 0) - this.sense * 12 + (this.attackT >= 0 ? 6 : 0) + (this.roarT < 0.8 ? 8 : 0);
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov = damp(cam.fov, fov, 6, dt); cam.updateProjectionMatrix(); }

    // claws
    const run = this.sprinting ? 1 : 0;
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.1);
    this.sinewMat.emissiveIntensity = 0.25 + pulse * 0.5;
    for (const a of this.arms) {
      const sd = a.side;
      const at = this.attackT < 0 ? 0 : sd > 0 ? this.attackT : this.attackT - 0.14;
      const an = at / (sd > 0 ? 1 : 0.86);
      const [rx, ry, py, pz] = slash(an);
      const swing = Math.sin(this.bob + (sd > 0 ? 0 : Math.PI));
      a.arm.position.set(
        sd * 0.43,
        -0.5 + py + breathe * 1.5 + swing * 0.03 * sway - this.sense * 0.32 + Math.sin(t * 1.1 + sd) * 0.008,
        -0.02 + pz + swing * 0.07 * sway * (1 + run)
      );
      a.arm.rotation.set(0.16 + rx + swing * 0.1 * sway * (1 + run), sd * (0.12 + ry), -sd * 0.45);
      // talons: curl while winding up, splay wide on the strike, twitch at rest
      const flex = an > 0 && an < 0.3 ? -0.55 : an >= 0.3 && an < 0.62 ? 0.3 : 0;
      for (let i = 0; i < a.fingers.length; i++) {
        const F = a.fingers[i];
        F.cur = damp(F.cur, flex + Math.sin(t * 2.1 + i * 1.7 + sd) * 0.07 - this.sense * 0.2, 16, dt);
        F.joints[0].rotation.x = F.base[0] + F.cur * 0.7;
        for (let j = 1; j < F.joints.length; j++) F.joints[j].rotation.x = F.base[j] + F.cur;
      }
    }

    this.body.position.set(this.pos.x, 0, this.pos.z);
    this.body.rotation.y = this.yaw + Math.PI;
  }
}

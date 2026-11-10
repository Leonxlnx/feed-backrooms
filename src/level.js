import * as THREE from 'three';
import { clamp, smoothstep } from './util.js';
import { patchMaterial, makePanelTexture, makeBloodTexture, makeScrawlTextures, shared } from './materials.js';

export const CELL = 2;
export const WALL_H = 3.0;
const MACRO = 4; // a "room" is 3 open cells + 1 partition cell
const GRID_RES = 2; // light-grid texels per cell

export class Level {
  constructor(rng, macroN = 12) {
    this.rng = rng;
    this.M = macroN;
    this.n = macroN * MACRO + 1;
    this.size = this.n * CELL;
    this.grid = new Uint8Array(this.n * this.n);
    this.fixtures = [];
    this.wallFaces = [];
    this._queue = new Int32Array(this.n * this.n);
    this._generate();
    this._placeFixtures();
    this._bakeLightGrid();
  }

  // ---------------------------------------------------------------- queries
  isWall(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= this.n || cz >= this.n) return true;
    return this.grid[cz * this.n + cx] === 1;
  }
  isWallAt(x, z) {
    return this.isWall(Math.floor(x / CELL), Math.floor(z / CELL));
  }
  macroCenter(mx, mz) {
    return { x: (mx * MACRO + 2.5) * CELL, z: (mz * MACRO + 2.5) * CELL };
  }

  // push a circle out of wall cells (in place)
  resolveCircle(p, r) {
    for (let it = 0; it < 2; it++) {
      const c0x = Math.floor((p.x - r) / CELL), c1x = Math.floor((p.x + r) / CELL);
      const c0z = Math.floor((p.z - r) / CELL), c1z = Math.floor((p.z + r) / CELL);
      for (let cz = c0z; cz <= c1z; cz++) {
        for (let cx = c0x; cx <= c1x; cx++) {
          if (!this.isWall(cx, cz)) continue;
          const x0 = cx * CELL, x1 = x0 + CELL, z0 = cz * CELL, z1 = z0 + CELL;
          const qx = clamp(p.x, x0, x1), qz = clamp(p.z, z0, z1);
          let dx = p.x - qx, dz = p.z - qz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          if (d2 > 1e-9) {
            const d = Math.sqrt(d2), k = (r - d) / d;
            p.x += dx * k; p.z += dz * k;
          } else {
            // centre is inside the block: leave through the nearest side
            const l = p.x - x0, rr = x1 - p.x, t = p.z - z0, b = z1 - p.z;
            const m = Math.min(l, rr, t, b);
            if (m === l) p.x = x0 - r; else if (m === rr) p.x = x1 + r; else if (m === t) p.z = z0 - r; else p.z = z1 + r;
          }
        }
      }
    }
  }

  // grid DDA line of sight
  los(x0, z0, x1, z1) {
    let cx = Math.floor(x0 / CELL), cz = Math.floor(z0 / CELL);
    const ex = Math.floor(x1 / CELL), ez = Math.floor(z1 / CELL);
    const dx = x1 - x0, dz = z1 - z0;
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(CELL / dx) : Infinity;
    const tdz = dz !== 0 ? Math.abs(CELL / dz) : Infinity;
    let tmx = dx !== 0 ? (dx > 0 ? (cx + 1) * CELL - x0 : x0 - cx * CELL) / Math.abs(dx) : Infinity;
    let tmz = dz !== 0 ? (dz > 0 ? (cz + 1) * CELL - z0 : z0 - cz * CELL) / Math.abs(dz) : Infinity;
    for (let i = 0; i < 256; i++) {
      if (this.isWall(cx, cz)) return false;
      if (cx === ex && cz === ez) return true;
      if (tmx < tmz) { cx += sx; tmx += tdx; } else { cz += sz; tmz += tdz; }
    }
    return true;
  }

  // breadth-first step distance from a cell into `out` (Int16Array n*n, -1 = unreachable)
  bfs(cx, cz, out) {
    const n = this.n, q = this._queue, g = this.grid;
    out.fill(-1);
    if (this.isWall(cx, cz)) return;
    let head = 0, tail = 0;
    const start = cz * n + cx;
    out[start] = 0;
    q[tail++] = start;
    while (head < tail) {
      const i = q[head++], d = out[i] + 1;
      const x = i % n, z = (i / n) | 0;
      if (x > 0 && g[i - 1] === 0 && out[i - 1] < 0) { out[i - 1] = d; q[tail++] = i - 1; }
      if (x < n - 1 && g[i + 1] === 0 && out[i + 1] < 0) { out[i + 1] = d; q[tail++] = i + 1; }
      if (z > 0 && g[i - n] === 0 && out[i - n] < 0) { out[i - n] = d; q[tail++] = i - n; }
      if (z < n - 1 && g[i + n] === 0 && out[i + n] < 0) { out[i + n] = d; q[tail++] = i + n; }
    }
  }

  // baked light level (0..~1) at a world position, used by prey vision
  lightAt(x, z) {
    const R = this.gridRes;
    const tx = clamp(Math.floor((x / this.size) * R), 0, R - 1);
    const tz = clamp(Math.floor((z / this.size) * R), 0, R - 1);
    return this.lightLum[tz * R + tx];
  }

  // ---------------------------------------------------------------- generation
  _generate() {
    const { n, M, rng, grid } = this;
    const P = 5;
    const makeField = () => {
      const lat = Array.from({ length: P * P }, () => rng());
      return (mx, mz) => {
        const x = (mx / (M - 1)) * (P - 1), z = (mz / (M - 1)) * (P - 1);
        const xi = Math.min(P - 2, Math.floor(x)), zi = Math.min(P - 2, Math.floor(z));
        const fx = x - xi, fz = z - zi;
        const a = lat[zi * P + xi], b = lat[zi * P + xi + 1], c = lat[(zi + 1) * P + xi], d = lat[(zi + 1) * P + xi + 1];
        return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
      };
    };
    const density = makeField();
    this._darkField = makeField();

    // partition edges between macro cells: 0 open, 1 wall, 2 wall with doorway
    const V = new Uint8Array((M + 1) * M), H = new Uint8Array(M * (M + 1));
    const vi = (k, mz) => k * M + mz, hi = (mx, k) => mx * (M + 1) + k;
    const parent = Array.from({ length: M * M }, (_, i) => i);
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => { parent[find(a)] = find(b); };
    const closed = [];
    const decide = (a, b, set) => {
      const p = 0.1 + 0.62 * (density(a % M, (a / M) | 0) + density(b % M, (b / M) | 0)) * 0.5;
      const r = rng();
      const t = r < p ? 1 : r < p + 0.2 ? 2 : 0;
      set(t);
      if (t !== 1) union(a, b); else closed.push({ a, b, set });
    };
    for (let mz = 0; mz < M; mz++) {
      for (let k = 1; k < M; k++) decide(mz * M + k - 1, mz * M + k, (t) => { V[vi(k, mz)] = t; });
      V[vi(0, mz)] = 1; V[vi(M, mz)] = 1;
    }
    for (let mx = 0; mx < M; mx++) {
      for (let k = 1; k < M; k++) decide((k - 1) * M + mx, k * M + mx, (t) => { H[hi(mx, k)] = t; });
      H[hi(mx, 0)] = 1; H[hi(mx, M)] = 1;
    }
    // guarantee everything is reachable: open a doorway wherever two regions are still sealed apart
    for (let i = closed.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [closed[i], closed[j]] = [closed[j], closed[i]];
    }
    for (const e of closed) if (find(e.a) !== find(e.b)) { e.set(2); union(e.a, e.b); }

    const set = (cx, cz) => { grid[cz * n + cx] = 1; };
    const gapOf = () => (rng() < 0.5 ? 2 : rng() < 0.5 ? 1 : 3);
    for (let k = 0; k <= M; k++) {
      for (let mz = 0; mz < M; mz++) {
        const t = V[vi(k, mz)];
        if (!t) continue;
        const gap = t === 2 ? gapOf() : 0;
        for (let j = 1; j <= 3; j++) if (j !== gap) set(k * MACRO, mz * MACRO + j);
      }
    }
    for (let mx = 0; mx < M; mx++) {
      for (let k = 0; k <= M; k++) {
        const t = H[hi(mx, k)];
        if (!t) continue;
        const gap = t === 2 ? gapOf() : 0;
        for (let j = 1; j <= 3; j++) if (j !== gap) set(mx * MACRO + j, k * MACRO);
      }
    }
    // lattice nodes: wall junctions, or the free-standing square pillars
    for (let kx = 0; kx <= M; kx++) {
      for (let kz = 0; kz <= M; kz++) {
        let any = false;
        if (kz > 0 && V[vi(kx, kz - 1)]) any = true;
        if (kz < M && V[vi(kx, kz)]) any = true;
        if (kx > 0 && H[hi(kx - 1, kz)]) any = true;
        if (kx < M && H[hi(kx, kz)]) any = true;
        if (any || rng() < 0.62) set(kx * MACRO, kz * MACRO);
      }
    }
  }

  _placeFixtures() {
    const { M, rng } = this;
    for (let mz = 0; mz < M; mz++) {
      for (let mx = 0; mx < M; mx++) {
        const dark = this._darkField(mx, mz);
        const pDead = 0.06 + 0.8 * Math.pow(dark, 1.6);
        const r = rng();
        const state = r < pDead ? 0 : rng() < 0.2 ? 2 : 1;
        const c = this.macroCenter(mx, mz);
        const warm = rng();
        this.fixtures.push({
          x: c.x, z: c.z, state,
          color: new THREE.Color(1.0, 0.9 + warm * 0.06, 0.62 + warm * 0.2),
          value: state === 0 ? 0 : 1,
          phase: rng() * 100,
          rot: rng() < 0.5 ? 0 : Math.PI / 2,
        });
      }
    }
  }

  _bakeLightGrid() {
    const R = (this.gridRes = this.n * GRID_RES);
    const texel = CELL / GRID_RES;
    const acc = new Float32Array(R * R * 3);
    const RANGE = 13;
    for (let tz = 0; tz < R; tz++) {
      for (let tx = 0; tx < R; tx++) {
        const x = (tx + 0.5) * texel, z = (tz + 0.5) * texel;
        if (this.isWallAt(x, z)) continue;
        let r = 0, g = 0, b = 0;
        for (const f of this.fixtures) {
          if (f.state === 0) continue;
          const dx = f.x - x, dz = f.z - z, d2 = dx * dx + dz * dz;
          if (d2 > RANGE * RANGE) continue;
          if (!this.los(x, z, f.x, f.z)) continue;
          const d = Math.sqrt(d2);
          let w = (0.5 / (1 + d2 / 6)) * (1 - smoothstep(RANGE * 0.6, RANGE, d));
          if (f.state === 2) w *= 0.4;
          r += f.color.r * w; g += f.color.g * w; b += f.color.b * w;
        }
        const i = (tz * R + tx) * 3;
        acc[i] = r; acc[i + 1] = g; acc[i + 2] = b;
      }
    }
    // one soft blur so line-of-sight edges read as penumbra, plus a little bounce into the dark
    const out = new Uint16Array(R * R * 4);
    this.lightLum = new Float32Array(R * R);
    for (let tz = 0; tz < R; tz++) {
      for (let tx = 0; tx < R; tx++) {
        let r = 0, g = 0, b = 0, wsum = 0;
        for (let oz = -1; oz <= 1; oz++) {
          for (let ox = -1; ox <= 1; ox++) {
            const x = tx + ox, z = tz + oz;
            if (x < 0 || z < 0 || x >= R || z >= R) continue;
            const w = ox === 0 && oz === 0 ? 4 : ox === 0 || oz === 0 ? 2 : 1;
            const i = (z * R + x) * 3;
            r += acc[i] * w; g += acc[i + 1] * w; b += acc[i + 2] * w; wsum += w;
          }
        }
        const wall = this.isWallAt((tx + 0.5) * texel, (tz + 0.5) * texel);
        const k = wall ? 0.35 : 1;
        r = (r / wsum) * k; g = (g / wsum) * k; b = (b / wsum) * k;
        const o = (tz * R + tx) * 4;
        out[o] = THREE.DataUtils.toHalfFloat(r);
        out[o + 1] = THREE.DataUtils.toHalfFloat(g);
        out[o + 2] = THREE.DataUtils.toHalfFloat(b);
        out[o + 3] = THREE.DataUtils.toHalfFloat(1);
        this.lightLum[tz * R + tx] = r * 0.3 + g * 0.6 + b * 0.1;
      }
    }
    const tex = new THREE.DataTexture(out, R, R, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.lightTexture = tex;
    shared.uLightGrid.value = tex;
    shared.uGridInv.value = 1 / this.size;
  }

  // ---------------------------------------------------------------- meshes
  build(scene, tex) {
    const group = new THREE.Group();
    const n = this.n, H = WALL_H;
    const mk = () => ({ pos: [], nor: [], uv: [], idx: [] });
    const walls = mk(), pillars = mk(), trim = mk();
    const quad = (b, p0, p1, p2, p3, nrm, u0, u1, v0, v1) => {
      const base = b.pos.length / 3;
      b.pos.push(...p0, ...p1, ...p2, ...p3);
      for (let i = 0; i < 4; i++) b.nor.push(...nrm);
      b.uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
      b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let cz = 0; cz < n; cz++) {
      for (let cx = 0; cx < n; cx++) {
        if (!this.isWall(cx, cz)) continue;
        let openSides = 0;
        for (const [dx, dz] of dirs) if (!this.isWall(cx + dx, cz + dz)) openSides++;
        const isPillar = openSides === 4;
        const b = isPillar ? pillars : walls;
        const tile = isPillar ? tex.concrete.tile : tex.wall.tile;
        for (const [dx, dz] of dirs) {
          if (this.isWall(cx + dx, cz + dz)) continue;
          const fx = (cx + 0.5 + dx * 0.5) * CELL, fz = (cz + 0.5 + dz * 0.5) * CELL;
          const tx = dz, tz = -dx, h = CELL / 2;
          const ax = fx - tx * h, az = fz - tz * h, bx = fx + tx * h, bz = fz + tz * h;
          const uA = (ax * tx + az * tz) / tile, uB = (bx * tx + bz * tz) / tile;
          quad(b, [ax, 0, az], [bx, 0, bz], [bx, H, bz], [ax, H, az], [dx, 0, dz], uA, uB, 0, H / tile);
          const o = 0.014, th = 0.11;
          quad(trim, [ax + dx * o, 0, az + dz * o], [bx + dx * o, 0, bz + dz * o], [bx + dx * o, th, bz + dz * o], [ax + dx * o, th, az + dz * o], [dx, 0, dz], 0, 1, 0, 1);
          // little top lip so the baseboard has thickness
          quad(trim, [ax + dx * o, th, az + dz * o], [bx + dx * o, th, bz + dz * o], [bx, th, bz], [ax, th, az], [0, 1, 0], 0, 1, 0, 1);
          if (!isPillar) this.wallFaces.push({ x: fx, z: fz, nx: dx, nz: dz });
        }
      }
    }
    const toGeo = (b) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setIndex(b.idx);
      g.computeBoundingSphere();
      return g;
    };
    const std = (set, extra = {}) =>
      new THREE.MeshStandardMaterial(Object.assign({
        map: set.color, normalMap: set.normal || null, roughnessMap: set.roughness || null,
        roughness: set.roughness ? 1 : 0.85, metalness: 0,
      }, extra));

    this.wallMat = patchMaterial(std(tex.wall, { color: tex.wall.tint ?? 0xffffff }), { grime: 1, wet: 0.45, wall: true });
    this.wallMat.normalScale.set(1.2, 1.2);
    const wallMesh = new THREE.Mesh(toGeo(walls), this.wallMat);
    wallMesh.castShadow = wallMesh.receiveShadow = true;
    group.add(wallMesh);

    if (pillars.idx.length) {
      const pm = patchMaterial(std(tex.concrete, { color: 0xb8b0a0 }), { grime: 0.9, wet: 0.3, wall: true });
      const pMesh = new THREE.Mesh(toGeo(pillars), pm);
      pMesh.castShadow = pMesh.receiveShadow = true;
      group.add(pMesh);
    }

    const trimMesh = new THREE.Mesh(toGeo(trim), patchMaterial(new THREE.MeshStandardMaterial({ color: 0x1d1811, roughness: 0.55 }), {}));
    trimMesh.receiveShadow = true;
    group.add(trimMesh);

    // floor + ceiling
    const plane = (tile) => {
      const g = new THREE.PlaneGeometry(this.size, this.size);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * this.size) / tile, (uv.getY(i) * this.size) / tile);
      return g;
    };
    this.floorMat = patchMaterial(std(tex.carpet, { color: tex.carpet.tint ?? 0xffffff }), { grime: 1, wet: 0.85, gridOffset: 0 });
    this.floorMat.normalScale.set(1.4, 1.4);
    const floor = new THREE.Mesh(plane(tex.carpet.tile), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(this.size / 2, 0, this.size / 2);
    floor.receiveShadow = true;
    group.add(floor);

    this.ceilMat = patchMaterial(std(tex.ceiling, { color: tex.ceiling.tint ?? 0xffffff }), { grime: 0.75, wet: 0, gridOffset: 0, gridScale: 0.6 });
    const ceil = new THREE.Mesh(plane(tex.ceiling.tile), this.ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(this.size / 2, H, this.size / 2);
    ceil.receiveShadow = true;
    group.add(ceil);

    // fluorescent panels
    const panelGeo = new THREE.BoxGeometry(1.25, 0.05, 0.62);
    const panelMat = new THREE.MeshBasicMaterial({ map: makePanelTexture() });
    this.panels = new THREE.InstancedMesh(panelGeo, panelMat, this.fixtures.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    this._c = new THREE.Color();
    this.fixtures.forEach((f, i) => {
      q.setFromAxisAngle(up, f.rot);
      m.compose(new THREE.Vector3(f.x, H - 0.022, f.z), q, new THREE.Vector3(1, 1, 1));
      this.panels.setMatrixAt(i, m);
      this._setPanelColor(i, f);
    });
    this.panels.instanceColor.needsUpdate = true;
    this.panels.frustumCulled = false;
    group.add(this.panels);

    this._addDecals(group);
    scene.add(group);
    this.group = group;
  }

  _setPanelColor(i, f) {
    const v = f.state === 0 ? 0.012 : 0.05 + f.value * 2.5;
    this._c.setRGB(f.color.r * v, f.color.g * v, f.color.b * v);
    this.panels.setColorAt(i, this._c);
  }

  _addDecals(group) {
    const rng = this.rng;
    const scrawls = makeScrawlTextures();
    const mats = scrawls.map((t) => patchMaterial(new THREE.MeshStandardMaterial({
      map: t, transparent: true, roughness: 0.75, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
    }), {}));
    const geo = new THREE.PlaneGeometry(1.7, 0.85);
    const count = Math.min(46, this.wallFaces.length);
    for (let i = 0; i < count; i++) {
      const f = this.wallFaces[Math.floor(rng() * this.wallFaces.length)];
      const mesh = new THREE.Mesh(geo, mats[Math.floor(rng() * mats.length)]);
      mesh.position.set(f.x + f.nx * 0.02, 1.15 + rng() * 0.9, f.z + f.nz * 0.02);
      mesh.rotation.y = Math.atan2(f.nx, f.nz);
      mesh.rotation.z = (rng() - 0.5) * 0.25;
      const s = 0.6 + rng() * 0.6;
      mesh.scale.set(s, s, 1);
      mesh.renderOrder = 2;
      group.add(mesh);
    }
    // old dried blood on the carpet
    this.bloodTextures = [makeBloodTexture(1), makeBloodTexture(2), makeBloodTexture(3)];
    this.bloodGeo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < 16; i++) {
      const x = (1 + rng() * (this.n - 2)) * CELL, z = (1 + rng() * (this.n - 2)) * CELL;
      if (this.isWallAt(x, z)) continue;
      const d = this.makeBloodDecal(x, z, 1.2 + rng() * 2.2, true);
      d.rotation.z = rng() * 6.28;
      group.add(d);
    }
  }

  makeBloodDecal(x, z, size, dried = false) {
    const mat = patchMaterial(new THREE.MeshStandardMaterial({
      map: this.bloodTextures[Math.floor(this.rng() * 3)], transparent: true, depthWrite: false,
      color: dried ? 0x6a5a50 : 0xffffff, roughness: dried ? 0.7 : 0.08, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -4, opacity: dried ? 0.8 : 1,
    }), { gridOffset: 0, nv: dried ? 1 : 2.4 }); // fresh blood stands out to the thing that spilled it
    const m = new THREE.Mesh(this.bloodGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.012, z);
    m.scale.set(size, size, 1);
    m.receiveShadow = true;
    m.renderOrder = 1;
    return m;
  }

  // ---------------------------------------------------------------- dynamic ceiling lights
  initLights(scene, count = 5, mapSize = 1024) {
    this.pool = [];
    for (let i = 0; i < count; i++) {
      const l = new THREE.SpotLight(0xffe2a8, 0, 14, 1.08, 0.9, 1.7);
      l.castShadow = true;
      l.shadow.mapSize.set(mapSize, mapSize);
      l.shadow.camera.near = 0.2;
      l.shadow.camera.far = 14;
      l.shadow.bias = -0.0008;
      l.shadow.normalBias = 0.03;
      l.shadow.autoUpdate = false; // re-rendered only when something that casts a shadow is under it
      l.shadow.needsUpdate = true;
      l.position.set(0, WALL_H - 0.1, 0);
      scene.add(l, l.target);
      this.pool.push({ light: l, fixture: null, dirty: true });
    }
    this._working = this.fixtures.filter((f) => f.state !== 0);
    this._flickers = [];
    this.fixtures.forEach((f, i) => { if (f.state === 2) this._flickers.push([f, i]); });
  }

  // movers: [{x, z}] of everything that can cast a moving shadow this frame
  updateLights(camPos, time, baseIntensity, movers = []) {
    // flicker
    for (const [f, i] of this._flickers) {
      const t = time + f.phase;
      let v = Math.sin(t * 31.0) * Math.sin(t * 17.3 + f.phase) > -0.25 ? 1 : 0.06;
      if (Math.sin(t * 0.9) > 0.72) v *= 0.04;
      v *= 0.86 + 0.14 * Math.sin(t * 113);
      f.value = v;
      this._setPanelColor(i, f);
    }
    if (this._flickers.length) this.panels.instanceColor.needsUpdate = true;

    for (const f of this._working) {
      const dx = f.x - camPos.x, dz = f.z - camPos.z;
      f._d2 = dx * dx + dz * dz;
    }
    this._working.sort((a, b) => a._d2 - b._d2);
    const want = this._working.slice(0, this.pool.length);
    for (const s of this.pool) if (s.fixture && !want.includes(s.fixture)) s.fixture = null;
    for (const f of want) {
      if (this.pool.some((s) => s.fixture === f)) continue;
      const free = this.pool.find((s) => !s.fixture);
      if (!free) break;
      free.fixture = f;
      free.dirty = true;
      free.light.position.set(f.x, WALL_H - 0.1, f.z);
      free.light.target.position.set(f.x, 0, f.z);
      free.light.target.updateMatrixWorld();
    }
    for (const s of this.pool) {
      if (!s.fixture) { s.light.intensity = 0; continue; }
      const f = s.fixture, d = Math.sqrt(f._d2);
      const fade = 1 - smoothstep(9, 15, d);
      s.light.intensity = baseIntensity * f.value * fade;
      s.light.color.copy(f.color);
      // the cone only reaches ~5.5 m out on the floor, so only nearby movers can change its shadow map
      let dirty = s.dirty;
      s.dirty = false;
      if (!dirty) {
        for (const m of movers) {
          if ((m.x - f.x) ** 2 + (m.z - f.z) ** 2 < 56) { dirty = true; s.dirty = true; break; } // one extra frame after they leave
        }
      }
      if (dirty) s.light.shadow.needsUpdate = true;
    }
  }

  // nearest flickering fixture to a point (for the buzz sound), or null
  nearestFlicker(x, z, maxD) {
    let best = null, bd = maxD * maxD;
    for (const [f] of this._flickers) {
      const d = (f.x - x) ** 2 + (f.z - z) ** 2;
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }
}

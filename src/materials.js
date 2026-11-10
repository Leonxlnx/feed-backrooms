import * as THREE from 'three';
import { mulberry32, makeTileNoise } from './util.js';

// uniforms shared by every patched material (same object references, updated once per frame)
export const shared = {
  uLightGrid: { value: null },
  uGridInv: { value: 1 },
  uGridIntensity: { value: 1.0 },
  uNightVision: { value: 0.55 },
  uNVColor: { value: new THREE.Color(0.5, 0.2, 0.16) },
  uGrime: { value: null },
};

// Adds to a MeshStandardMaterial:
//  - baked light-grid ambient (world-space lookup, pushed off walls along the normal)
//  - "monster night vision" headlamp term that falls off with distance
//  - optional world-space grime / damp stains that also lower roughness (wet patches)
// Every tunable is a per-material uniform, so all patched materials share just two shader variants
// (with / without the grime lookups) instead of compiling one big program each.
export function patchMaterial(mat, o = {}) {
  const opt = Object.assign({ grime: 0, wet: 0, gridScale: 1, gridOffset: 0.6, wall: false, nv: 1, grimeVariant: false }, o);
  const useGrime = opt.grime > 0 || opt.grimeVariant;
  const own = {
    uGrimeAmt: { value: opt.grime }, uWetAmt: { value: opt.wet }, uGridScale: { value: opt.gridScale },
    uGridOffset: { value: opt.gridOffset }, uWall: { value: opt.wall ? 1 : 0 }, uNV: { value: opt.nv },
  };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLightGrid = shared.uLightGrid;
    shader.uniforms.uGridInv = shared.uGridInv;
    shader.uniforms.uGridIntensity = shared.uGridIntensity;
    shader.uniforms.uNightVision = shared.uNightVision;
    shader.uniforms.uNVColor = shared.uNVColor;
    shader.uniforms.uGrime = shared.uGrime;
    Object.assign(shader.uniforms, own);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGridPos;\nvarying vec3 vGridN;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 gwp = vec4( transformed, 1.0 );
          vec3 gwn = objectNormal;
          #ifdef USE_INSTANCING
            gwp = instanceMatrix * gwp;
            gwn = mat3( instanceMatrix ) * gwn;
          #endif
          gwp = modelMatrix * gwp;
          vGridPos = gwp.xyz;
          vGridN = mat3( modelMatrix ) * gwn;
        }`
      );

    const grimeCode = useGrime ? `
        {
          vec3 gAbs = abs( normalize( vGridN ) );
          vec2 gp2 = gAbs.y > 0.5 ? vGridPos.xz : ( gAbs.x > 0.5 ? vGridPos.zy : vGridPos.xy );
          float gA = texture2D( uGrime, gp2 * 0.043 ).r;
          float gC = texture2D( uGrime, gp2 * 0.19 + 0.31 ).r;
          gGrime = smoothstep( 0.46, 0.8, gA * 0.75 + gC * 0.35 );
          // walls only: drips running down from the ceiling, damp rising from the carpet
          float gH = clamp( vGridPos.y / 3.0, 0.0, 1.0 );
          float gB = texture2D( uGrime, vec2( gp2.x * 0.33, gp2.y * 0.05 ) ).g;
          float gDrip = smoothstep( 0.52, 0.86, gB ) * smoothstep( 0.05, 0.95, gH );
          float gBase = smoothstep( 0.22, 0.0, gH ) * ( 0.35 + 0.65 * gC );
          gGrime = max( gGrime, max( gDrip, gBase ) * uWall );
          gGrime = clamp( gGrime * uGrimeAmt, 0.0, 1.0 );
          diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.30, 0.22, 0.13 ), gGrime );
        }` : '';

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vGridPos;
        varying vec3 vGridN;
        uniform sampler2D uLightGrid;
        uniform sampler2D uGrime;
        uniform float uGridInv;
        uniform float uGridIntensity;
        uniform float uNightVision;
        uniform vec3 uNVColor;
        uniform float uGrimeAmt, uWetAmt, uGridScale, uGridOffset, uWall, uNV;`
      )
      .replace('#include <map_fragment>', `#include <map_fragment>\nfloat gGrime = 0.0;${grimeCode}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.16, gGrime * uWetAmt );`
      )
      .replace(
        '#include <aomap_fragment>',
        `{
          vec3 gN = normalize( vGridN );
          vec2 gUv = ( vGridPos.xz + gN.xz * uGridOffset ) * uGridInv;
          vec3 gL = texture2D( uLightGrid, gUv ).rgb * uGridIntensity * uGridScale;
          gL *= mix( 1.0, mix( 0.7, 1.25, clamp( vGridPos.y / 3.0, 0.0, 1.0 ) ), uWall );
          float gCam = length( vViewPosition );
          float gNV = uNightVision * uNV * exp( -gCam * 0.085 ) * ( 0.3 + 0.7 * max( dot( normal, normalize( vViewPosition ) ), 0.0 ) );
          reflectedLight.indirectDiffuse += ( gL + uNVColor * gNV ) * diffuseColor.rgb;
        }
        #include <aomap_fragment>`
      );
  };
  mat.customProgramCacheKey = () => (useGrime ? 'grid-grime' : 'grid');
  return mat;
}

// ---------- procedural helper textures (masks / decals only; surface PBR sets come from disk) ----------

export function makeGrimeTexture() {
  const S = 256;
  const rng = mulberry32(9917);
  const n1 = makeTileNoise(rng, 8), n2 = makeTileNoise(rng, 16), n3 = makeTileNoise(rng, 64);
  const s1 = makeTileNoise(rng, 32), s2 = makeTileNoise(rng, 64);
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const blot = n1(u * 8, v * 8) * 0.55 + n2(u * 16, v * 16) * 0.3 + n3(u * 64, v * 64) * 0.15;
      const streak = s1(u * 32, v * 4) * 0.65 + s2(u * 64, v * 8) * 0.35;
      const i = (y * S + x) * 4;
      data[i] = Math.floor(blot * 255);
      data[i + 1] = Math.floor(streak * 255);
      data[i + 2] = Math.floor(n3(u * 64 + 11, v * 64 + 5) * 255);
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

// fluorescent panel face: diffuser grid with two tubes glowing through
export function makePanelTexture() {
  const [c, g] = canvas(256, 128);
  g.fillStyle = '#9a9684';
  g.fillRect(0, 0, 256, 128);
  for (const y of [40, 88]) {
    const gr = g.createLinearGradient(0, y - 26, 0, y + 26);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.5, 'rgba(255,255,255,1)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(10, y - 26, 236, 52);
  }
  g.strokeStyle = 'rgba(40,36,26,0.35)';
  g.lineWidth = 1;
  for (let x = 0; x <= 256; x += 8) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 128); g.stroke(); }
  for (let y = 0; y <= 128; y += 8) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
  g.strokeStyle = '#2a2a26';
  g.lineWidth = 8;
  g.strokeRect(0, 0, 256, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// irregular blood pool alpha/colour
export function makeBloodTexture(seed = 1) {
  const rng = mulberry32(seed * 7919 + 3);
  const [c, g] = canvas(256, 256);
  g.clearRect(0, 0, 256, 256);
  const blob = (x, y, r, a) => {
    const gr = g.createRadialGradient(x, y, r * 0.2, x, y, r);
    gr.addColorStop(0, `rgba(118,4,4,${a})`);
    gr.addColorStop(0.75, `rgba(96,2,2,${a})`);
    gr.addColorStop(1, 'rgba(80,0,0,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  };
  blob(128, 128, 70, 1);
  for (let i = 0; i < 26; i++) {
    const a = rng() * Math.PI * 2, d = 30 + rng() * 62;
    blob(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 8 + rng() * 26, 0.95);
  }
  for (let i = 0; i < 40; i++) {
    const a = rng() * Math.PI * 2, d = 80 + rng() * 44;
    blob(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 1.5 + rng() * 5, 0.9);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// scrawled wall writing left by people who did not make it
const SCRAWLS = [
  ['NO EXIT', '#3a0606'],
  ['it hears you', '#141210'],
  ["DON'T RUN", '#3a0606'],
  ['day 41', '#141210'],
  ['WE ARE NOT ALONE', '#141210'],
  ['turn off the light', '#3a0606'],
  ['IT WAS HERE FIRST', '#141210'],
  ['|||| |||| ||||  ||', '#141210'],
  ['hide', '#3a0606'],
  ['MOM', '#3a0606'],
];
export function makeScrawlTextures() {
  const out = [];
  const rng = mulberry32(4242);
  for (const [text, col] of SCRAWLS) {
    const [c, g] = canvas(512, 256);
    g.clearRect(0, 0, 512, 256);
    const size = Math.min(110, Math.floor(820 / text.length) + 16);
    g.font = `bold ${size}px "Ink Free", "Segoe Print", "Bradley Hand ITC", "Comic Sans MS", cursive`;
    g.textBaseline = 'middle';
    const total = g.measureText(text).width;
    let x = (512 - total) / 2;
    for (const ch of text) {
      const w = g.measureText(ch).width;
      for (let pass = 0; pass < 3; pass++) {
        g.save();
        g.translate(x + w / 2 + (rng() - 0.5) * 4, 128 + (rng() - 0.5) * 18);
        g.rotate((rng() - 0.5) * 0.28);
        g.globalAlpha = 0.45 + rng() * 0.3;
        g.fillStyle = col;
        g.fillText(ch, -w / 2, 0);
        g.restore();
      }
      x += w;
    }
    if (col === '#3a0606') {
      // drips
      g.strokeStyle = 'rgba(58,6,6,0.7)';
      for (let i = 0; i < 9; i++) {
        const dx = (512 - total) / 2 + rng() * total;
        g.lineWidth = 2 + rng() * 3;
        g.beginPath(); g.moveTo(dx, 128 + size * 0.2); g.lineTo(dx + (rng() - 0.5) * 3, 150 + size * 0.3 + rng() * 70); g.stroke();
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    out.push(t);
  }
  return out;
}

// simple procedural stand-in used only if a PBR set failed to load
export function fallbackColorTexture(hex, seed) {
  const rng = mulberry32(seed);
  const [c, g] = canvas(256, 256);
  g.fillStyle = hex;
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(${rng() < 0.5 ? 0 : 255},${rng() < 0.5 ? 0 : 255},${rng() < 0.5 ? 0 : 200},${rng() * 0.05})`;
    g.fillRect(rng() * 256, rng() * 256, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

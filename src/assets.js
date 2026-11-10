import * as THREE from 'three';
import { fallbackColorTexture } from './materials.js';

const SETS = ['wall', 'carpet', 'ceiling', 'concrete']; // the manifest lists a few spare sets too
const FALLBACK = { wall: '#b9a55c', carpet: '#7d6c45', ceiling: '#b5b09c', concrete: '#77736a', tiles: '#b9b9b0', metal: '#5a4a3c' };

// loads the downloaded CC0 PBR sets listed in /assets/textures/manifest.json
export async function loadTextures(renderer) {
  let manifest = {};
  try {
    const r = await fetch('/assets/textures/manifest.json');
    if (r.ok) manifest = await r.json();
  } catch { /* fall back below */ }
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const loader = new THREE.TextureLoader();
  const load = (url, srgb) =>
    new Promise((res) => {
      loader.load(url, (t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = aniso;
        res(t);
      }, undefined, () => res(null));
    });
  const out = {};
  await Promise.all(SETS.map(async (name, i) => {
    const m = manifest[name];
    const set = { tile: (m && m.tileMeters) || 2, color: null, normal: null, roughness: null };
    if (m) {
      const maps = m.maps || ['color', 'normal', 'roughness'];
      const [c, n, r] = await Promise.all([
        maps.includes('color') ? load(`/assets/textures/${name}/color.jpg`, true) : null,
        maps.includes('normal') ? load(`/assets/textures/${name}/normal.jpg`, false) : null,
        maps.includes('roughness') ? load(`/assets/textures/${name}/roughness.jpg`, false) : null,
      ]);
      set.color = c; set.normal = n; set.roughness = r;
    }
    if (!set.color) set.color = fallbackColorTexture(FALLBACK[name], 100 + i);
    out[name] = set;
  }));
  return out;
}

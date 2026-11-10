import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// what the thing sees: warped lens, colour fringes, grain, blood at the edges
const MonsterEye = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uCA: { value: 0.004 },
    uVig: { value: 0.7 },
    uGrain: { value: 0.07 },
    uSense: { value: 0 },
    uBlood: { value: 0 },
    uStarve: { value: 0 },
    uDistort: { value: 0.18 },
    uFade: { value: 1 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform float uTime, uCA, uVig, uGrain, uSense, uBlood, uStarve, uDistort, uFade;
    varying vec2 vUv;
    float hash( vec2 p ) {
      p = fract( p * vec2( 123.34, 456.21 ) );
      p += dot( p, p + 45.32 );
      return fract( p.x * p.y );
    }
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot( c, c );
      vec2 uv = 0.5 + c * ( 1.0 - uDistort * 0.5 + uDistort * r2 );
      vec2 dir = c * ( uCA * ( 0.35 + 3.2 * r2 ) );
      vec3 col;
      col.r = texture2D( tDiffuse, uv + dir ).r;
      col.g = texture2D( tDiffuse, uv ).g;
      col.b = texture2D( tDiffuse, uv - dir ).b;

      float l = dot( col, vec3( 0.299, 0.587, 0.114 ) );
      // smelling: the room drains to cold grey-blue, anything hot (body heat, scent) keeps its colour
      float hot = smoothstep( 0.04, 0.22, col.r - col.b );
      vec3 sc = vec3( l ) * vec3( 0.62, 0.74, 1.0 );
      col = mix( col, sc, uSense * ( 1.0 - hot ) );

      float v = smoothstep( 0.1, 0.6, r2 );
      col *= 1.0 - ( uVig + uSense * 0.2 ) * v;

      float pulse = 0.5 + 0.5 * sin( uTime * 4.2 );
      col += vec3( 0.42, 0.01, 0.0 ) * v * ( uBlood * 1.4 + uStarve * ( 0.3 + 0.4 * pulse ) );
      col = mix( col, vec3( 0.32, 0.0, 0.0 ), uBlood * 0.3 );

      float n = hash( vUv * uRes + fract( uTime * 7.31 ) * 311.0 );
      col += ( n - 0.5 ) * uGrain * ( 1.15 - 0.6 * l );
      gl_FragColor = vec4( col * uFade, 1.0 );
    }`,
};

export function makePost(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.42, 0.7, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const eye = new ShaderPass(MonsterEye);
  composer.addPass(eye);
  return {
    composer, bloom, u: eye.uniforms,
    resize(w, h, pr) {
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      eye.uniforms.uRes.value.set(w * pr, h * pr);
    },
  };
}

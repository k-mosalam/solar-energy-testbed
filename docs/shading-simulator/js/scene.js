// Realistic 3D scene of the RFS testbed (Three.js r128, global THREE + THREE.OrbitControls).
// World axes: x = east, y = north, z = up. Frame positions come from the LiDAR plane fits.
import { frameBasis } from './site.js';
import { frontCoordinates, traceRay, rng } from './obstructions.js';
import { add, scale, sub } from './vec.js';

const T = globalThis.THREE;

const STEEL = { A: { color: 0x9aa1a8, metalness: 0.65, roughness: 0.42 }, B: { color: 0x6b3a2a, metalness: 0.35, roughness: 0.72 } };
const FOLIAGE = [0x4d7436, 0x5b8541, 0x3f6630, 0x6a924d];
const SCENE_CENTRE = new T.Vector3(1.8, 0.6, 1.0);

// ---------- Procedural textures ----------

function canvasTexture(size, draw, { repeat = [1, 1], srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = size[0]; c.height = size[1];
  draw(c.getContext('2d'), c.width, c.height);
  const tex = new T.CanvasTexture(c);
  tex.wrapS = tex.wrapT = T.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  if (srgb) tex.encoding = T.sRGBEncoding;
  return tex;
}

function mixHex(a, b, t) {
  const ca = new T.Color(a), cb = new T.Color(b);
  return '#' + ca.lerp(cb, t).getHexString();
}

/** Grass ground texture; `dry` 0 = green winter grass, 1 = golden summer grass (as in the site photo). */
function grassTexture(dry, seed = 3) {
  const rand = rng(seed);
  return canvasTexture([512, 512], (g, w, h) => {
    g.fillStyle = mixHex('#5f7f37', '#9e8b5f', dry); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) { // soft patches
      g.fillStyle = mixHex(rand() < 0.5 ? '#4f6d2c' : '#6f8d40', rand() < 0.5 ? '#7d6c45' : '#b9a576', dry);
      g.globalAlpha = 0.22; g.beginPath();
      g.ellipse(rand() * w, rand() * h, 10 + rand() * 40, 6 + rand() * 24, rand() * 3, 0, 7); g.fill();
    }
    g.globalAlpha = 0.85; g.lineWidth = 1.2;
    for (let i = 0; i < 9000; i++) { // blades
      const x = rand() * w, y = rand() * h, l = 3 + rand() * 7, a = rand() * Math.PI * 2;
      g.strokeStyle = mixHex(['#3f5d22', '#7ea04a', '#5d7d33'][i % 3], ['#7a6640', '#c9b98f', '#8f7b55'][i % 3], dry);
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
  }, { repeat: [90, 90] });
}

/** Dark CdTe glass with faint scribe lines along the cell stripes. */
function moduleTexture(direction) {
  return canvasTexture([256, 512], (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, '#141b26'); grd.addColorStop(1, '#0b1018');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(120,140,170,0.10)'; g.lineWidth = 1;
    if (direction === 'slope') for (let x = 4; x < w; x += 5) { g.beginPath(); g.moveTo(x, 6); g.lineTo(x, h - 6); g.stroke(); }
    else for (let y = 4; y < h; y += 5) { g.beginPath(); g.moveTo(6, y); g.lineTo(w - 6, y); g.stroke(); }
    g.strokeStyle = 'rgba(160,170,185,0.25)'; g.lineWidth = 6; g.strokeRect(0, 0, w, h); // edge deletion border
  });
}

/** Leaf clusters with see-through gaps; coverage roughly follows the canopy density. */
function leafTexture(coverage, seed) {
  const rand = rng(seed);
  return canvasTexture([256, 256], (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const n = Math.round(260 + coverage * 1500);
    for (let i = 0; i < n; i++) {
      const x = rand() * w, y = rand() * h, s = 3 + rand() * 6;
      const v = 130 + rand() * 90 | 0;
      g.fillStyle = `rgb(${v - 25},${v},${v - 55})`;
      g.beginPath(); g.ellipse(x, y, s, s * 0.45, rand() * Math.PI, 0, Math.PI * 2); g.fill();
    }
  }, { repeat: [2, 2] });
}

function barkTexture() {
  const rand = rng(5);
  return canvasTexture([128, 256], (g, w, h) => {
    g.fillStyle = '#5a4433'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 160; i++) {
      g.strokeStyle = `rgba(${30 + rand() * 40},${22 + rand() * 30},${14 + rand() * 20},0.6)`;
      g.lineWidth = 1 + rand() * 2; const x = rand() * w;
      g.beginPath(); g.moveTo(x, rand() * h); g.lineTo(x + (rand() - 0.5) * 6, rand() * h); g.stroke();
    }
  });
}

function woodTexture() {
  const rand = rng(9);
  return canvasTexture([256, 256], (g, w, h) => {
    g.fillStyle = '#8a6a48'; g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 32) { g.fillStyle = 'rgba(40,28,16,0.35)'; g.fillRect(0, y, w, 2); }
    for (let i = 0; i < 300; i++) {
      g.strokeStyle = `rgba(60,40,22,${0.1 + rand() * 0.2})`; const y = rand() * h;
      g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(w / 3, y + rand() * 6, (2 * w) / 3, y - rand() * 6, w, y); g.stroke();
    }
  });
}

function glowTexture(inner, outer) {
  return canvasTexture([256, 256], (g, w) => {
    const grd = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    grd.addColorStop(0, inner); grd.addColorStop(0.18, inner); grd.addColorStop(0.4, outer); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, w);
  });
}

function labelTexture(text, sub) {
  return canvasTexture([512, 160], (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(15,28,45,0.78)';
    g.beginPath(); g.roundRect ? g.roundRect(8, 8, w - 16, h - 16, 28) : g.rect(8, 8, w - 16, h - 16); g.fill();
    g.fillStyle = '#ffffff'; g.font = '600 54px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText(text, w / 2, 76);
    g.fillStyle = '#cfe0f5'; g.font = '36px system-ui, sans-serif'; g.fillText(sub, w / 2, 126);
  });
}

// ---------- Geometry helpers ----------

function cylinderBetween(a, b, r0, r1, material, seg = 10) {
  const va = new T.Vector3(...a), vb = new T.Vector3(...b);
  const dir = vb.clone().sub(va), len = dir.length();
  const mesh = new T.Mesh(new T.CylinderGeometry(r1, r0, len, seg, 1), material);
  mesh.position.copy(va).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.normalize());
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

function orientedBox(size, centre, xAxis, yAxis, zAxis, material) {
  const mesh = new T.Mesh(new T.BoxGeometry(...size), material);
  const m = new T.Matrix4().makeBasis(new T.Vector3(...xAxis), new T.Vector3(...yAxis), new T.Vector3(...zAxis));
  mesh.quaternion.setFromRotationMatrix(m);
  mesh.position.set(...centre);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

/** Square-tube member between two points (boxes look like the steel frames in the photo). */
function tubeBetween(a, b, size, material) {
  const va = new T.Vector3(...a), vb = new T.Vector3(...b);
  const dir = vb.clone().sub(va), len = dir.length();
  const mesh = new T.Mesh(new T.BoxGeometry(size, len, size), material);
  mesh.position.copy(va).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.normalize());
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { if (m.userData?.shared) continue; m.dispose(); }
  });
}

// ---------- Scene ----------

export class Scene3D {
  constructor(container, { onObjectDrag, onObjectDragEnd } = {}) {
    if (!T || !T.OrbitControls) throw new Error('Three.js did not load.');
    T.Object3D.DefaultUp.set(0, 0, 1);
    this.container = container;
    this.onObjectDrag = onObjectDrag;
    this.onObjectDragEnd = onObjectDragEnd;
    this.options = { rays: true, scenery: true, lidar: false, heatmap: false };
    this.clock = new T.Clock();

    const r = this.renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    r.shadowMap.enabled = true; r.shadowMap.type = T.PCFSoftShadowMap;
    r.shadowMap.autoUpdate = false; // shadows are re-rendered only when the sun or objects change
    r.outputEncoding = T.sRGBEncoding; r.toneMapping = T.ACESFilmicToneMapping; r.toneMappingExposure = 1.0;
    r.domElement.setAttribute('aria-label', '3D model of the two RFS test frames, the obstruction, the sun and the shadows');
    r.domElement.setAttribute('role', 'img');
    container.appendChild(r.domElement);

    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(40, 1, 0.05, 1200);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(-3.2, -10.8, 4.4);
    this.controls = new T.OrbitControls(this.camera, r.domElement);
    this.controls.target.copy(SCENE_CENTRE);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.1;
    this.controls.maxPolarAngle = Math.PI * 0.495; this.controls.minDistance = 1.2; this.controls.maxDistance = 90;
    this.controls.screenSpacePanning = true;
    this.controls.update();
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.dirty = true;
    this.lastRender = 0;

    this.shared = {
      steelA: new T.MeshStandardMaterial(STEEL.A), steelB: new T.MeshStandardMaterial(STEEL.B),
      pipe: new T.MeshStandardMaterial({ color: 0x8e979c, metalness: 0.3, roughness: 0.5 }),
      rubber: new T.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 }),
      aluminium: new T.MeshStandardMaterial({ color: 0xc9cdd2, metalness: 0.8, roughness: 0.32 }),
      backsheet: new T.MeshStandardMaterial({ color: 0x23272d, roughness: 0.8 }),
      bark: new T.MeshStandardMaterial({ map: barkTexture(), roughness: 0.95 }),
      wood: new T.MeshStandardMaterial({ map: woodTexture(), roughness: 0.85 }),
      polewood: new T.MeshStandardMaterial({ color: 0x5e4a38, roughness: 0.9 }),
      cable: new T.MeshStandardMaterial({ color: 0xb3261e, roughness: 0.6 }),
      box: new T.MeshStandardMaterial({ color: 0x2b63b5, roughness: 0.45 }),
    };
    for (const m of Object.values(this.shared)) m.userData.shared = true;
    this.leafTextures = new Map();

    this._buildEnvironment();
    this._buildSunVisuals();
    this.framesGroup = new T.Group(); this.scene.add(this.framesGroup);
    this.objectGroup = new T.Group(); this.scene.add(this.objectGroup);
    this.raysGroup = new T.Group(); this.scene.add(this.raysGroup);
    this.lidarGroup = new T.Group(); this.lidarGroup.visible = false; this.scene.add(this.lidarGroup);

    this._bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this._loop = this._loop.bind(this);
    this.frameId = requestAnimationFrame(this._loop);
  }

  // ----- Environment: sky, light, ground, pad, scenery -----

  _buildEnvironment() {
    const s = this.scene;
    this.skyUniforms = {
      sunDir: { value: new T.Vector3(0, -0.5, 0.8) },
      zenith: { value: new T.Color(0x1f5fc4) }, horizon: { value: new T.Color(0xa9cdee) }, glow: { value: new T.Color(0xfff2c8) },
    };
    const sky = new T.Mesh(new T.SphereGeometry(600, 48, 24), new T.ShaderMaterial({
      side: T.BackSide, depthWrite: false, uniforms: this.skyUniforms,
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 sunDir; uniform vec3 zenith; uniform vec3 horizon; uniform vec3 glow; varying vec3 vDir;
        void main(){ float h = max(vDir.z, 0.0); vec3 col = mix(horizon, zenith, pow(h, 0.55));
          float d = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
          col += glow * (pow(d, 6.0) * 0.28 + pow(d, 64.0) * 0.5 + pow(d, 2400.0) * 6.0) * smoothstep(-0.1, 0.05, sunDir.z);
          if (vDir.z < 0.0) col = mix(horizon, horizon * 0.8, min(-vDir.z * 4.0, 1.0));
          gl_FragColor = vec4(col, 1.0); }`,
    }));
    sky.frustumCulled = false; s.add(sky); this.sky = sky;
    s.fog = new T.Fog(0xbfdaf2, 160, 900);

    this.hemi = new T.HemisphereLight(0xcfe3ff, 0x8a7a52, 0.55); s.add(this.hemi);
    const sun = this.sunLight = new T.DirectionalLight(0xfff1dc, 2.6);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.00025; sun.shadow.normalBias = 0.025;
    const cam = sun.shadow.camera; cam.near = 1; cam.far = 220; cam.left = -16; cam.right = 16; cam.top = 16; cam.bottom = -16;
    s.add(sun); s.add(sun.target);
    this.ambient = new T.AmbientLight(0xffffff, 0.08); s.add(this.ambient);

    // Static environment map so the glass reflects a sky.
    const pmrem = new T.PMREMGenerator(this.renderer);
    const envTex = canvasTexture([512, 256], (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0, '#3d74c9'); grd.addColorStop(0.48, '#c9def2'); grd.addColorStop(0.52, '#9b8f6c'); grd.addColorStop(1, '#5d5643');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    });
    envTex.mapping = T.EquirectangularReflectionMapping;
    this.envMap = pmrem.fromEquirectangular(envTex).texture;
    envTex.dispose(); pmrem.dispose();

    // Base ground beyond the scanned area (dry grass, matching the scanned terrain colours).
    const baseTex = grassTexture(1);
    baseTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.groundMat = new T.MeshStandardMaterial({ map: baseTex, color: 0xe9dcc0, roughness: 1, metalness: 0 });
    const ground = new T.Mesh(new T.PlaneGeometry(900, 900), this.groundMat);
    ground.position.z = -0.05; ground.receiveShadow = true; s.add(ground); this.ground = ground;

    this.scenery = new T.Group(); s.add(this.scenery);
    this._buildCompass();
  }

  /**
   * Real surroundings from the three raw LiDAR sessions (tools/build_environment.py):
   * a terrain mesh from the ground points (receives shadows) and sun-lit points for everything else.
   */
  setEnvironment(meta, terrainBuffer, pointsBuffer) {
    disposeTree(this.scenery);
    this.scenery.clear();
    const t = meta.terrain, n = t.n;
    const heights = new Int16Array(terrainBuffer, 0, n * n);
    const rgb = new Uint8Array(terrainBuffer, n * n * 2, n * n * 3);
    const index = new Int32Array(n * n).fill(-1);
    const pos = [], col = [], tri = [];
    const c = new T.Color();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (heights[k] === t.noData) continue;
      index[k] = pos.length / 3;
      pos.push(t.x0 + (i + 0.5) * t.cell, t.y0 + (j + 0.5) * t.cell, heights[k] / 1000);
      c.setRGB(rgb[k * 3] / 255, rgb[k * 3 + 1] / 255, rgb[k * 3 + 2] / 255).convertSRGBToLinear();
      col.push(c.r, c.g, c.b);
    }
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = index[j * n + i], b = index[j * n + i + 1], d = index[(j + 1) * n + i], e = index[(j + 1) * n + i + 1];
      if (a >= 0 && b >= 0 && e >= 0) tri.push(a, b, e);
      if (a >= 0 && e >= 0 && d >= 0) tri.push(a, e, d);
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    geo.setIndex(tri);
    geo.computeVertexNormals();
    const detail = canvasTexture([512, 512], (g, w, h) => {
      const rand = rng(8);
      g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 14000; i++) {
        const v = 200 + rand() * 55 | 0;
        g.fillStyle = `rgba(${v},${v},${v},0.55)`;
        g.fillRect(rand() * w, rand() * h, 1 + rand() * 3, 1 + rand() * 3);
      }
    }, { repeat: [220, 220] });
    detail.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const terrain = new T.Mesh(geo, new T.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 1, metalness: 0 }));
    terrain.receiveShadow = true;
    this.scenery.add(terrain);

    // Object points: int16 xyz (mm), int8 normal, uint8 sRGB colour, 12 bytes each.
    const count = meta.points.count;
    const view = new DataView(pointsBuffer);
    const p = new Float32Array(count * 3), nn = new Float32Array(count * 3), cc = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const o = i * 12;
      p[i * 3] = view.getInt16(o, true) / 1000; p[i * 3 + 1] = view.getInt16(o + 2, true) / 1000; p[i * 3 + 2] = view.getInt16(o + 4, true) / 1000;
      nn[i * 3] = view.getInt8(o + 6) / 127; nn[i * 3 + 1] = view.getInt8(o + 7) / 127; nn[i * 3 + 2] = view.getInt8(o + 8) / 127;
      cc[i * 3] = view.getUint8(o + 9) / 255; cc[i * 3 + 1] = view.getUint8(o + 10) / 255; cc[i * 3 + 2] = view.getUint8(o + 11) / 255;
    }
    const pg = new T.BufferGeometry();
    pg.setAttribute('position', new T.BufferAttribute(p, 3));
    pg.setAttribute('aNormal', new T.BufferAttribute(nn, 3));
    pg.setAttribute('aColor', new T.BufferAttribute(cc, 3));
    this.pointUniforms = T.UniformsUtils.merge([T.UniformsLib.fog, {
      size: { value: 0.038 }, scale: { value: 600 },
      sunDir: { value: new T.Vector3(0, -0.5, 0.8) }, sunColor: { value: new T.Color(1, 1, 1) },
      skyColor: { value: new T.Color(0.4, 0.45, 0.5) }, groundColor: { value: new T.Color(0.3, 0.25, 0.2) },
    }]);
    const mat = new T.ShaderMaterial({
      uniforms: this.pointUniforms, fog: true,
      vertexShader: `#include <common>
        #include <fog_pars_vertex>
        attribute vec3 aNormal; attribute vec3 aColor;
        uniform float size; uniform float scale;
        uniform vec3 sunDir; uniform vec3 sunColor; uniform vec3 skyColor; uniform vec3 groundColor;
        varying vec3 vColor;
        void main() {
          vec3 nrm = normalize(aNormal);
          vec3 base = pow(aColor, vec3(2.2));
          vec3 hemi = mix(groundColor, skyColor, 0.5 + 0.5 * nrm.z);
          vColor = base * (hemi * 0.85 + sunColor * (0.12 + 0.5 * abs(dot(nrm, sunDir))));
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(size * scale / -mvPosition.z, 1.0, 9.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `#include <common>
        #include <fog_pars_fragment>
        varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - 0.5; float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          gl_FragColor = vec4(vColor * (1.0 - r2 * 0.5), 1.0);
          #include <tonemapping_fragment>
          #include <encodings_fragment>
          #include <fog_fragment>
        }`,
    });
    const cloud = new T.Points(pg, mat);
    cloud.frustumCulled = false;
    this.scenery.add(cloud);
    this._updatePointLighting();
    this.resize();
    this.renderer.shadowMap.needsUpdate = true; this.dirty = true;
  }

  _updatePointLighting() {
    if (!this.pointUniforms) return;
    const u = this.pointUniforms;
    u.sunDir.value.copy(this.sunLight.position).sub(this.sunLight.target.position).normalize();
    u.sunColor.value.copy(this.sunLight.color).multiplyScalar(this.sunLight.intensity);
    u.skyColor.value.copy(this.hemi.color).multiplyScalar(this.hemi.intensity).add(new T.Color(this.ambient.color).multiplyScalar(this.ambient.intensity));
    u.groundColor.value.copy(this.hemi.groundColor).multiplyScalar(this.hemi.intensity).add(new T.Color(this.ambient.color).multiplyScalar(this.ambient.intensity));
  }

  _buildCompass() {
    const tex = canvasTexture([256, 256], (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,0.85)'; g.strokeStyle = 'rgba(20,40,60,0.8)'; g.lineWidth = 6;
      g.beginPath(); g.arc(w / 2, h / 2, 100, 0, 7); g.fill(); g.stroke();
      g.fillStyle = '#c0392b'; g.beginPath(); g.moveTo(w / 2, 40); g.lineTo(w / 2 + 26, h / 2); g.lineTo(w / 2 - 26, h / 2); g.fill();
      g.fillStyle = '#2c3e50'; g.beginPath(); g.moveTo(w / 2, h - 40); g.lineTo(w / 2 + 26, h / 2); g.lineTo(w / 2 - 26, h / 2); g.fill();
      g.fillStyle = '#c0392b'; g.font = 'bold 44px system-ui'; g.textAlign = 'center'; g.fillText('N', w / 2, 36);
    });
    const c = new T.Mesh(new T.PlaneGeometry(1.2, 1.2), new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    c.position.set(-3.4, -4.2, 0.04); this.scene.add(c);
  }

  _buildSunVisuals() {
    this.sunSprite = new T.Sprite(new T.SpriteMaterial({ map: glowTexture('rgba(255,252,235,1)', 'rgba(255,214,120,0.35)'),
      blending: T.AdditiveBlending, depthWrite: false, fog: false, transparent: true }));
    this.sunSprite.scale.set(46, 46, 1);
    this.scene.add(this.sunSprite);
    this.impactTexture = glowTexture('rgba(255,250,220,1)', 'rgba(255,200,90,0.5)');
    this.blockTexture = glowTexture('rgba(255,170,110,1)', 'rgba(255,110,60,0.45)');
  }

  // ----- Frames -----

  setFrames(frames, { testFrame, stripeDirection = 'slope' } = {}, racks = null) {
    if (racks) this.racks = racks;
    disposeTree(this.framesGroup);
    this.framesGroup.clear();
    this.frames = frames;
    this.moduleMeshes = {};
    const glassTex = moduleTexture(stripeDirection);
    glassTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const glass = new T.MeshPhysicalMaterial({ map: glassTex, color: 0xffffff, metalness: 0.1, roughness: 0.16,
      clearcoat: 0.6, clearcoatRoughness: 0.12, envMap: this.envMap, envMapIntensity: 0.35 });
    for (const f of frames) {
      const group = new T.Group();
      this._buildRack(group, f);
      this.moduleMeshes[f.id] = f.modules.map((m) => this._buildModule(group, f, m, glass));
      const label = new T.Sprite(new T.SpriteMaterial({ map: labelTexture(`Frame ${f.id}`,
        `${f.id === testFrame ? 'test' : 'reference'} · ${f.scanTilt.toFixed(1)}°`), depthTest: false, transparent: true }));
      label.scale.set(1.5, 0.47, 1);
      label.position.set(...add(f.upperMid, [0, 0.15, 0.55]));
      label.renderOrder = 10;
      group.add(label);
      this.framesGroup.add(group);
    }
    this._fitShadowCamera();
    this.renderer.shadowMap.needsUpdate = true; this.dirty = true;
  }

  _buildModule(group, f, m, glassMat) {
    const across = new T.Vector3(...f.across), up = new T.Vector3(...f.up), n = new T.Vector3(...f.normal);
    const basis = new T.Matrix4().makeBasis(across, up, n);
    const holder = new T.Group();
    holder.quaternion.setFromRotationMatrix(basis);
    const c = f.point((m.u0 + m.u1) / 2, (m.v0 + m.v1) / 2);
    holder.position.set(...c);
    const w = m.u1 - m.u0, l = m.v1 - m.v0;
    const body = new T.Mesh(new T.BoxGeometry(w - 0.01, l - 0.01, 0.035), this.shared.backsheet);
    body.position.z = -0.02; body.castShadow = true; body.receiveShadow = true; holder.add(body);
    const glass = new T.Mesh(new T.PlaneGeometry(w - 0.05, l - 0.05), glassMat);
    glass.position.z = 0.001; glass.receiveShadow = true; holder.add(glass);
    for (const [sx, sy, px, py] of [[w, 0.032, 0, l / 2 - 0.016], [w, 0.032, 0, -l / 2 + 0.016], [0.032, l, w / 2 - 0.016, 0], [0.032, l, -w / 2 + 0.016, 0]]) {
      const bar = new T.Mesh(new T.BoxGeometry(sx, sy, 0.042), this.shared.aluminium);
      bar.position.set(px, py, -0.012); bar.castShadow = true; bar.receiveShadow = true; holder.add(bar);
    }
    // Stripe heat-map overlay (hidden unless enabled).
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 1;
    const tex = new T.CanvasTexture(canvas); tex.magFilter = T.NearestFilter; tex.minFilter = T.NearestFilter;
    const overlay = new T.Mesh(new T.PlaneGeometry(w - 0.05, l - 0.05), new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    overlay.position.z = 0.004; overlay.visible = false; overlay.renderOrder = 2; holder.add(overlay);
    group.add(holder);
    return { holder, overlay, canvas, tex };
  }

  /** Steel rack built to the dimensions measured in the raw scans (site.json "racks"). */
  _buildRack(group, f) {
    const mat = f.id === 'A' ? this.shared.steelA : this.shared.steelB;
    const r = this.racks?.[f.id];
    if (!r) return;
    const railZ = 0.14, tube = 0.05;
    const [x0, x1] = r.baseX, [y0, y1] = r.baseY;
    const yPost = (r.posts[0][1] + r.posts[1][1]) / 2;
    // Height of the panel plane above a ground point (the posts carry the pivot just under the panel).
    const planeZ = (x, y) => f.corners[0][2] - (f.normal[0] * (x - f.corners[0][0]) + f.normal[1] * (y - f.corners[0][1])) / f.normal[2];
    // Caster base: rectangle plus a cross member through the posts.
    const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    for (let i = 0; i < 4; i++) group.add(tubeBetween([...c[i], railZ], [...c[(i + 1) % 4], railZ], tube, mat));
    group.add(tubeBetween([x0, yPost, railZ], [x1, yPost, railZ], tube, mat));
    for (const [x, y] of [...c, [(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1]]) {
      const wheel = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, 0.035, 14), this.shared.rubber);
      wheel.position.set(x, y, 0.055);
      wheel.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), new T.Vector3(1, 0, 0));
      wheel.castShadow = true; group.add(wheel);
      group.add(tubeBetween([x, y, 0.09], [x, y, railZ - tube / 2], 0.02, this.shared.aluminium));
    }
    // Pivot axle (torque tube) sits behind the modules: its centre is a fixed distance behind the glass,
    // measured along the panel normal, so it clears the module rails at every tilt. Solving for the
    // height directly above each post keeps the posts vertical.
    const axleR = f.id === 'B' ? 0.055 : 0.03;
    const railBack = 0.07 + 0.02; // rails behind the modules: centre 7 cm behind the glass, 4 cm square
    const axleZ = (x, y) => planeZ(x, y) - (railBack + axleR) / f.normal[2];
    // Posts to the pivot, back braces, pivot brackets (bracket top meets the underside of the axle).
    const tops = r.posts.map(([x, y]) => [x, y, axleZ(x, y) - axleR - 0.06]);
    for (const [k, [x, y]] of r.posts.entries()) {
      const top = tops[k];
      group.add(tubeBetween([x, y, railZ], top, 0.055, mat));
      group.add(tubeBetween([x, y, railZ + (top[2] - railZ) * 0.5], [x, y1 - 0.03, railZ], 0.035, mat));
      group.add(orientedBox([0.09, 0.12, 0.12], top, [1, 0, 0], [0, 1, 0], [0, 0, 1], mat));
    }
    // Pivot axle between the posts (Frame B: the long grey pipe seen in the photo) and rails behind the modules.
    const ext = f.id === 'B' ? 0.45 : 0.05;
    const a0 = [tops[0][0] - ext, tops[0][1], axleZ(...r.posts[0])], a1 = [tops[1][0] + ext, tops[1][1], axleZ(...r.posts[1])];
    if (f.id === 'B') group.add(cylinderBetween(a0, a1, axleR, axleR, this.shared.pipe, 16));
    else group.add(tubeBetween(a0, a1, axleR * 2, mat));
    const nOff = scale(f.normal, -0.07);
    for (const u of [0.25, f.width - 0.25, f.width / 2]) {
      group.add(tubeBetween(add(f.point(u, 0.08), nOff), add(f.point(u, f.slope - 0.08), nOff), 0.04, mat));
    }
    if (f.id === 'A') {
      // Blue junction box and red cables on Frame A's west post (as in the photo).
      const boxPos = [r.posts[0][0] - 0.06, r.posts[0][1] - 0.02, 1.15];
      group.add(orientedBox([0.06, 0.16, 0.22], boxPos, [1, 0, 0], [0, 1, 0], [0, 0, 1], this.shared.box));
      const curve = new T.CatmullRomCurve3([new T.Vector3(...boxPos), new T.Vector3(boxPos[0] + 0.25, boxPos[1] - 0.4, 0.75),
        new T.Vector3(...add(f.point(0.4, 0.1), scale(f.normal, -0.08)))]);
      group.add(new T.Mesh(new T.TubeGeometry(curve, 24, 0.008, 6), this.shared.cable));
    }
  }

  // ----- Obstructions -----

  _leafMaterial(color, coverage) {
    const key = Math.round(coverage * 10);
    if (!this.leafTextures.has(key)) this.leafTextures.set(key, leafTexture(key / 10, 50 + key));
    const map = this.leafTextures.get(key);
    const mat = new T.MeshStandardMaterial({ map, color, alphaTest: 0.5, side: T.DoubleSide, roughness: 0.8 });
    const depth = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking, map, alphaTest: 0.5 });
    return { mat, depth };
  }

  _treeMesh(tree, palette, density) {
    const group = new T.Group();
    for (const s of [...tree.render.trunk, ...tree.render.branches]) group.add(cylinderBetween(s.a, s.b, s.r0, s.r1, this.shared.bark, 9));
    const rand = rng(tree.render.seed * 31 + 1);
    // Per-shell leaf coverage chosen so that a ray crossing one cluster (about four leaf shells)
    // is blocked roughly `density` of the time, matching the shading calculation.
    const coverage = 1 - Math.pow(1 - Math.min(density, 0.98), 1 / 4);
    const mats = palette.map((c) => this._leafMaterial(c, coverage));
    for (const b of tree.render.blobs) {
      for (const shell of [1, 0.72]) {
        const geo = new T.IcosahedronGeometry(1, 2);
        const p = geo.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const k = 1 + (rand() - 0.5) * 0.22;
          p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
        }
        geo.computeVertexNormals();
        const { mat, depth } = mats[(b.tint + (shell < 1 ? 1 : 0)) % mats.length];
        const mesh = new T.Mesh(geo, mat);
        mesh.customDepthMaterial = depth;
        mesh.scale.set(b.radii[0] * shell, b.radii[1] * shell, b.radii[2] * shell);
        mesh.rotation.set(rand() * 6, rand() * 6, rand() * 6);
        mesh.position.set(...b.c);
        mesh.castShadow = true; mesh.receiveShadow = true;
        group.add(mesh);
      }
    }
    return group;
  }

  setObstructions(obstructions, settings) {
    disposeTree(this.objectGroup);
    this.objectGroup.clear();
    this.obstructions = obstructions;
    this.anchorFrame = this.frames?.find((f) => f.id === settings.anchor);
    this.objectKind = settings.object.type;
    for (const ob of obstructions) {
      if (ob.scanned) continue; // the scanned pole is already part of the scenery
      let mesh;
      if (ob.kind === 'tree') mesh = this._treeMesh(ob, FOLIAGE, settings.object.density);
      else if (ob.kind === 'pole') {
        mesh = new T.Group();
        const r = ob.render;
        mesh.add(cylinderBetween([r.base[0], r.base[1], 0], [r.base[0], r.base[1], r.height], r.r * 1.1, r.r * 0.85, this.shared.polewood, 14));
        for (const z of r.arms) {
          const side = [-r.armAxis[1], r.armAxis[0], 0];
          mesh.add(orientedBox([2.4, 0.1, 0.1], [r.base[0], r.base[1], z], r.armAxis, side, [0, 0, 1], this.shared.polewood));
        }
      } else if (ob.kind === 'overhang') {
        mesh = new T.Group();
        const s = ob.render.slab;
        mesh.add(orientedBox([s.h[0] * 2, s.h[1] * 2, s.h[2] * 2], s.c, s.ax[0], s.ax[1], s.ax[2], this.shared.wood));
        for (const p of ob.render.posts) mesh.add(cylinderBetween(p.a, p.b, p.r, p.r, this.shared.wood, 10));
      }
      if (mesh) { mesh.userData.draggable = true; this.objectGroup.add(mesh); }
    }
    this._fitShadowCamera();
    this.renderer.shadowMap.needsUpdate = true; this.dirty = true;
  }

  // ----- Sun, sky and season -----

  setSun(sun, date) {
    this.sun = sun;
    const v = new T.Vector3(...sun.vector);
    const el = sun.apparentElevation;
    const day = T.MathUtils.smoothstep(el, -4, 8), golden = 1 - T.MathUtils.smoothstep(el, 2, 22);
    this.skyUniforms.sunDir.value.copy(v);
    const zen = new T.Color(0x0b1631).lerp(new T.Color(0x1d5cc2), day);
    const hor = new T.Color(0x1d2b4a).lerp(new T.Color(0xa6cbec), day).lerp(new T.Color(0xf3b47c), golden * day * 0.75);
    this.skyUniforms.zenith.value.copy(zen); this.skyUniforms.horizon.value.copy(hor);
    this.scene.fog.color.copy(hor);
    this.sunLight.color.set(0xfff1dc).lerp(new T.Color(0xffa860), golden);
    this.sunLight.intensity = 2.3 * T.MathUtils.smoothstep(el, -1, 6);
    this.hemi.intensity = 0.1 + 0.38 * day;
    this.hemi.color.copy(hor).lerp(new T.Color(0xcfe3ff), 0.5);
    this.ambient.intensity = 0.06 + 0.06 * (1 - day);
    this.renderer.toneMappingExposure = 0.72 + 0.2 * day;
    this.sunLight.position.copy(SCENE_CENTRE).addScaledVector(v, 80);
    this.sunLight.target.position.copy(SCENE_CENTRE);
    this.sunSprite.position.copy(this.camera.position).addScaledVector(v, 420);
    this.sunSprite.visible = el > -1.5;
    this.renderer.shadowMap.needsUpdate = true; this.dirty = true;
    this._updatePointLighting();
  }

  _fitShadowCamera() {
    // Fit the shadow frustum to the frames and obstructions so shadow edges stay crisp.
    const pts = [];
    for (const f of this.frames ?? []) pts.push(...f.corners, [f.pivot[0], f.pivot[1], 0]);
    for (const ob of this.obstructions ?? []) if (!ob.scanned) pts.push(ob.bounds.lo, ob.bounds.hi);
    if (!pts.length) return;
    let r = 0;
    for (const p of pts) r = Math.max(r, Math.hypot(p[0] - SCENE_CENTRE.x, p[1] - SCENE_CENTRE.y, p[2] - SCENE_CENTRE.z));
    r = Math.min(30, Math.max(7, r + 3));
    const cam = this.sunLight.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.updateProjectionMatrix();
  }

  // ----- Sun rays, heat map -----

  /** Draw a bundle of sunbeams onto the panels; beams that hit the obstruction stop there. */
  setRays(sun, frames, obstructions, highlight) {
    this.dirty = true;
    disposeTree(this.raysGroup);
    this.raysGroup.clear();
    this.rayMaterials = [];
    if (!this.options.rays || sun.apparentElevation <= 0.5) return;
    const v = sun.vector, far = 7;
    for (const f of frames) {
      if (f.normal[0] * v[0] + f.normal[1] * v[1] + f.normal[2] * v[2] <= 0.02) continue;
      const dense = f.id === highlight;
      if (dense) this._addShaft(f, v);
      const nu = dense ? 2 : 1, nv = dense ? 3 : 2;
      for (const m of f.modules) for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
        const p = add(f.point(m.u0 + ((i + 0.5) / nu) * (m.u1 - m.u0), m.v0 + ((j + 0.5) / nv) * (m.v1 - m.v0)), scale(f.normal, 0.01));
        const hit = traceRay(p, v, obstructions);
        const blocked = hit.first < far && hit.tau < 0.5;
        const start = blocked ? add(p, scale(v, hit.first)) : p;
        this._addBeam(start, add(p, scale(v, far)), blocked);
        const spr = new T.Sprite(new T.SpriteMaterial({ map: blocked ? this.blockTexture : this.impactTexture,
          blending: T.AdditiveBlending, depthWrite: false, transparent: true, opacity: blocked ? 0.85 : 0.5 }));
        spr.position.set(...start); spr.scale.setScalar(blocked ? 0.16 : 0.1);
        this.raysGroup.add(spr);
        if (blocked) this._addShadowLine(start, p);
      }
    }
  }

  /** Soft golden volume of sunlight arriving on a frame (the frame outline swept toward the sun). */
  _addShaft(f, v) {
    const L = 9, base = f.corners.map((c) => add(c, scale(f.normal, 0.02)));
    const top = base.map((c) => add(c, scale(v, L)));
    const pos = [], uv = [];
    for (let i = 0; i < 4; i++) {
      const a = base[i], b = base[(i + 1) % 4], c = top[(i + 1) % 4], d = top[i];
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    const mat = new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide,
      uniforms: { time: { value: 0 }, len: { value: L }, color: { value: new T.Color(0xffc86b) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float time; uniform vec3 color; varying vec2 vUv;
        void main(){ float fade = pow(1.0 - vUv.y, 1.8) * smoothstep(0.0, 0.02, vUv.y + 0.02);
          float shimmer = 0.85 + 0.15 * sin(vUv.x * 40.0 + time * 1.5);
          gl_FragColor = vec4(color, 0.16 * fade * shimmer); }`,
    });
    this.rayMaterials.push(mat);
    const mesh = new T.Mesh(geo, mat);
    mesh.renderOrder = 4;
    this.raysGroup.add(mesh);
  }

  _addBeam(a, b, blocked) {
    const va = new T.Vector3(...a), vb = new T.Vector3(...b), dir = vb.clone().sub(va), len = dir.length();
    const mat = new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide,
      uniforms: { time: { value: 0 }, len: { value: len }, color: { value: new T.Color(blocked ? 0xff7a33 : 0xffc23d) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float time; uniform float len; uniform vec3 color; varying vec2 vUv;
        void main(){ float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
          float fade = smoothstep(0.0, 0.03, vUv.y) * (1.0 - smoothstep(0.35, 1.0, vUv.y));
          float pulse = 0.55 + 0.45 * sin(vUv.y * len * 2.2 + time * 5.0);
          gl_FragColor = vec4(color, pow(across, 2.2) * fade * pulse * 0.55); }`,
    });
    this.rayMaterials.push(mat);
    for (const rot of [0, Math.PI / 2]) {
      const geo = new T.PlaneGeometry(0.035, len);
      geo.translate(0, len / 2, 0);
      const mesh = new T.Mesh(geo, mat);
      mesh.position.copy(va);
      mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.clone().normalize());
      mesh.rotateY(rot);
      mesh.renderOrder = 5;
      this.raysGroup.add(mesh);
    }
  }

  _addShadowLine(a, b) {
    const geo = new T.BufferGeometry().setFromPoints([new T.Vector3(...a), new T.Vector3(...b)]);
    const line = new T.Line(geo, new T.LineDashedMaterial({ color: 0x30343a, dashSize: 0.08, gapSize: 0.06, transparent: true, opacity: 0.7 }));
    line.computeLineDistances();
    this.raysGroup.add(line);
  }

  /** Colour each module's stripes by how much sunlight they get; the weakest stripe is outlined in red. */
  setHeatmap(instantData) {
    this.dirty = true;
    for (const f of this.frames ?? []) {
      const data = instantData.frames[f.id];
      (this.moduleMeshes[f.id] ?? []).forEach((mm, mIndex) => {
        const show = this.options.heatmap && data?.stripeTau;
        mm.overlay.visible = !!show;
        if (!show) return;
        const taus = data.stripeTau[mIndex];
        mm.canvas.width = taus.length;
        const g = mm.canvas.getContext('2d');
        g.clearRect(0, 0, taus.length, 1);
        taus.forEach((tau, s) => {
          const weakest = data.weakest && data.weakest.module === mIndex && data.weakest.stripe === s && data.ratio < 0.999;
          if (weakest) g.fillStyle = 'rgba(255,40,40,0.95)';
          else if (tau > 0.995) g.fillStyle = 'rgba(80,200,120,0.18)';
          else g.fillStyle = `rgba(255,${Math.round(80 + 140 * tau)},40,${0.35 + 0.5 * (1 - tau)})`;
          g.fillRect(s, 0, 1, 1);
        });
        mm.tex.needsUpdate = true;
      });
    }
  }

  // ----- LiDAR points -----

  setLidar(decoded) {
    this.dirty = true;
    disposeTree(this.lidarGroup);
    this.lidarGroup.clear();
    if (!decoded) return;
    const colors = new Float32Array(decoded.count * 3);
    const palette = [[0.86, 0.86, 0.86], [0.55, 0.5, 0.4], [0.3, 0.64, 1.0], [1.0, 0.62, 0.25]];
    for (let i = 0; i < decoded.count; i++) colors.set(palette[decoded.classes[i]] ?? palette[0], i * 3);
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(decoded.positions, 3));
    geo.setAttribute('color', new T.BufferAttribute(colors, 3));
    const pts = new T.Points(geo, new T.PointsMaterial({ size: 0.025, vertexColors: true, sizeAttenuation: true }));
    this.lidarGroup.add(pts);
  }

  setOptions(opts) {
    this.dirty = true;
    Object.assign(this.options, opts);
    this.scenery.visible = this.options.scenery;
    this.lidarGroup.visible = this.options.lidar;
    this.raysGroup.visible = this.options.rays;
  }

  // ----- Camera -----

  setView(name) {
    this.dirty = true;
    const target = SCENE_CENTRE.clone();
    let pos;
    if (name === 'sun' && this.sun && this.sun.apparentElevation > 1) {
      pos = target.clone().addScaledVector(new T.Vector3(...this.sun.vector), 24);
    } else if (name === 'top') {
      pos = target.clone().add(new T.Vector3(0, -0.5, 26));
    } else if (name === 'side') {
      pos = target.clone().add(new T.Vector3(-11, 1.5, 2.4));
    } else {
      pos = new T.Vector3(-3.2, -10.8, 4.4);
    }
    this.tween = { from: this.camera.position.clone(), to: pos, tFrom: this.controls.target.clone(), tTo: target, t: 0 };
  }

  // ----- Interaction: drag the obstruction -----

  _bindPointer() {
    const el = this.renderer.domElement;
    const ray = new T.Raycaster(), ndc = new T.Vector2();
    const pick = (e) => {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.objectGroup.children.length || !this.anchorFrame) return;
      pick(e);
      const hits = ray.intersectObjects(this.objectGroup.children, true);
      if (!hits.length) return;
      const plane = new T.Plane(new T.Vector3(0, 0, 1), -(this.objectKind === 'overhang' ? hits[0].point.z : 0));
      const start = new T.Vector3();
      if (!ray.ray.intersectPlane(plane, start)) return;
      this.drag = { plane, last: start, pointerId: e.pointerId };
      this.controls.enabled = false;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      pick(e);
      if (!this.drag) {
        const over = this.objectGroup.children.length && ray.intersectObjects(this.objectGroup.children, true).length;
        el.style.cursor = over ? 'grab' : '';
        return;
      }
      const p = new T.Vector3();
      if (!ray.ray.intersectPlane(this.drag.plane, p)) return;
      const delta = p.clone().sub(this.drag.last);
      this.drag.last = p;
      const d = frontCoordinates(this.anchorFrame, [delta.x + this.anchorFrame.lowerMid[0], delta.y + this.anchorFrame.lowerMid[1], 0]);
      this.onObjectDrag?.({ dDistance: d.distance, dOffset: d.offset });
    });
    const end = () => {
      if (!this.drag) return;
      this.drag = null; this.controls.enabled = true; el.style.cursor = '';
      this.onObjectDragEnd?.();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // ----- Loop -----

  resize() {
    this.dirty = true;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    if (this.pointUniforms) this.pointUniforms.scale.value = (h * this.renderer.getPixelRatio()) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  _loop(now = 0) {
    this.frameId = requestAnimationFrame(this._loop);
    const dt = this.clock.getDelta();
    if (this.tween) {
      const tw = this.tween; tw.t = Math.min(1, tw.t + dt / 0.7);
      const k = tw.t * tw.t * (3 - 2 * tw.t);
      this.camera.position.lerpVectors(tw.from, tw.to, k);
      this.controls.target.lerpVectors(tw.tFrom, tw.tTo, k);
      if (tw.t >= 1) this.tween = null;
      this.dirty = true;
    }
    this.controls.update();
    // Render only when something changed; the sunbeam pulses animate at about 30 fps.
    const animating = this.options.rays && this.rayMaterials?.length && !document.hidden;
    if (!this.dirty && !(animating && now - this.lastRender > 33)) return;
    this.dirty = false;
    this.lastRender = now;
    const time = this.clock.elapsedTime;
    for (const m of this.rayMaterials ?? []) m.uniforms.time.value = time;
    if (this.sun) this.sunSprite.position.copy(this.camera.position).addScaledVector(new T.Vector3(...this.sun.vector), 420);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }
}

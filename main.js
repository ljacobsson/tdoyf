// Tunables for depth shaping and relief strength
const DEPTH_GAMMA = 0.7;           // <1 expands near range
const DETAIL_WEIGHT = 0.2;         // contribution of image detail on top of depth (lower = smoother)
const DETAIL_BOOST = 1.6;          // high-pass amplification for detail
let DISPLACEMENT_SCALE = 52;       // world height exaggeration
let DEPTH_SIGN = -1;               // flip if features look inverted (−1 makes near areas rise)
const SMOOTH_PASSES = 2;           // number of blur passes
const USE_MEDIAN = true;           // remove isolated spikes before blurring

console.info('[TinyDOOM-Face] build: ONNX MiDaS depth preferred');
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// --- DOM ---
const faceFileInput = document.getElementById('faceFile');
const startBtn = document.getElementById('startBtn');
const statusEl = document.getElementById('status');
const splashEl = document.getElementById('splash');
const splashUploadBtn = document.getElementById('splashUploadBtn');
const enterBtn = document.getElementById('enterBtn');

splashUploadBtn?.addEventListener('click', () => {
  faceFileInput?.click();
});
enterBtn?.addEventListener('click', () => {
  splashEl?.classList.remove('show');
});

// Hide splash when image is picked
faceFileInput?.addEventListener('change', () => {
  splashEl?.classList.remove('show');
});

// Mobile controls
const mobileControlsEl = document.getElementById('mobileControls');
const stickLEl = document.getElementById('stickL');
const stickREl = document.getElementById('stickR');
const knobL = stickLEl?.querySelector('.knob');
const knobR = stickREl?.querySelector('.knob');
const btnShoot = document.getElementById('btnShoot');
const btnJump = document.getElementById('btnJump');
const isCoarse = window.matchMedia('(pointer: coarse)').matches;
if (isCoarse) mobileControlsEl?.classList.remove('hidden');
let mobileMove = { x: 0, y: 0 };
let mobileLook = { x: 0, y: 0 };

function bindStick(stickEl, knobEl, onMove) {
  if (!stickEl || !knobEl) return;
  let active = false;
  let center = { x: 0, y: 0 };
  const radius = 70;

  function updateKnob(dx, dy) {
    const len = Math.hypot(dx, dy);
    const clamped = Math.min(1, len / radius);
    const angle = Math.atan2(dy, dx);
    const kx = Math.cos(angle) * clamped * radius;
    const ky = Math.sin(angle) * clamped * radius;
    knobEl.style.transform = `translate(${kx}px, ${ky}px)`;
    onMove({ x: clamped * Math.cos(angle), y: clamped * Math.sin(angle) });
  }

  function reset() {
    knobEl.style.transform = 'translate(-50%, -50%)';
    onMove({ x: 0, y: 0 });
  }

  const start = (e) => {
    active = true;
    const t = e.touches ? e.touches[0] : e;
    const rect = stickEl.getBoundingClientRect();
    center.x = rect.left + rect.width / 2;
    center.y = rect.top + rect.height / 2;
    updateKnob(t.clientX - center.x, t.clientY - center.y);
  };
  const move = (e) => {
    if (!active) return;
    const t = e.touches ? e.touches[0] : e;
    updateKnob(t.clientX - center.x, t.clientY - center.y);
  };
  const end = () => { active = false; reset(); };

  stickEl.addEventListener('touchstart', start, { passive: true });
  stickEl.addEventListener('touchmove', move, { passive: true });
  stickEl.addEventListener('touchend', end);
  stickEl.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
}

bindStick(stickLEl, knobL, (v) => { mobileMove = v; });
bindStick(stickREl, knobR, (v) => { mobileLook = v; });
btnShoot?.addEventListener('click', () => { tryShoot(); });
btnJump?.addEventListener('click', () => { keys.add('Space'); setTimeout(() => keys.delete('Space'), 120); });

// --- Renderer & Scene ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0a);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 5000);
scene.add(camera);

const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.getObject());

// For mobile look, rotate yaw/pitch manually when not pointer-locked
let manualYaw = 0;
let manualPitch = 0;

// Player gun (FPS viewmodel)
let playerGun = null;
let gunBarrel = null;
let ejectPort = null;
const gunBasePos = new THREE.Vector3(0.45, -0.35, -0.9);
const gunBaseRot = new THREE.Euler(-0.06, 0.32, 0.0);
const gunState = { recoil: 0, swayTime: 0 };
function createPlayerGun() {
  const root = new THREE.Group();

  const polymer = new THREE.MeshStandardMaterial({ color: 0x1f1f1f, metalness: 0.15, roughness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x888a92, metalness: 1.0, roughness: 0.35 });
  const blackSteel = new THREE.MeshStandardMaterial({ color: 0x121212, metalness: 0.9, roughness: 0.5 });

  // Frame (polymer)
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, 0.7), polymer);
  frame.position.set(0.0, -0.02, -0.45);
  root.add(frame);

  // Grip
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.36, 0.18), polymer);
  grip.position.set(-0.05, -0.28, -0.18);
  grip.rotation.x = 0.35;
  root.add(grip);

  // Slide (steel)
  const slide = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.16, 0.8), steel);
  slide.position.set(0.0, 0.06, -0.5);
  root.add(slide);

  // Barrel (black steel)
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.28, 16), blackSteel);
  barrel.rotation.z = Math.PI / 2;
  barrel.position.set(0.05, 0.045, -0.86);
  root.add(barrel);

  // Front sight
  const sightF = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.05), blackSteel);
  sightF.position.set(0.0, 0.14, -0.82);
  root.add(sightF);

  // Rear sight
  const sightR = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.05), blackSteel);
  sightR.position.set(0.0, 0.12, -0.35);
  root.add(sightR);

  // Muzzle and eject port anchors
  gunBarrel = new THREE.Object3D();
  gunBarrel.position.set(0.09, 0.05, -0.94);
  root.add(gunBarrel);

  ejectPort = new THREE.Object3D();
  ejectPort.position.set(0.12, 0.08, -0.6);
  root.add(ejectPort);

  // Place in camera space and render above world (no depth test)
  root.position.copy(gunBasePos);
  root.rotation.copy(gunBaseRot);
  root.traverse(n => { n.renderOrder = 999; if (n.material) n.material.depthTest = false; });

  return root;
}
playerGun = createPlayerGun();
camera.add(playerGun);

function updateGun(dt) {
  if (!playerGun) return;
  // Sway based on movement
  const speed = Math.min(1, Math.sqrt(moveVelocity.x * moveVelocity.x + moveVelocity.z * moveVelocity.z) * 0.5);
  gunState.swayTime += dt * (4 + speed * 6);

  const swayX = Math.sin(gunState.swayTime * 2.2) * 0.015 * speed;
  const swayY = Math.sin(gunState.swayTime * 4.4) * 0.01 * speed;

  // Recoil decay
  gunState.recoil = Math.max(0, gunState.recoil - dt * 6);

  playerGun.position.set(gunBasePos.x + swayX, gunBasePos.y + swayY - gunState.recoil * 0.02, gunBasePos.z - gunState.recoil * 0.06);
  playerGun.rotation.set(gunBaseRot.x - gunState.recoil * 0.22, gunBaseRot.y + swayX * 0.3, gunBaseRot.z);
}

function addRecoil(kick = 1) {
  gunState.recoil = Math.min(1.2, gunState.recoil + 0.25 * kick);
}

// Lighting
const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 0.8);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 1.0);
dir.position.set(100, 200, 100);
scene.add(dir);

// Ground placeholders until image loads
let terrainMesh = null;
let terrainSize = 400; // world units (square)
let terrainResolution = 256; // segments per side
let heightData = null; // Float32Array, normalized 0..1
let heightDataSize = 0; // width==height

// Player state
const eyeHeight = 6;
const moveVelocity = new THREE.Vector3();
const playerSpeed = 40; // world units/second
let isOnGround = true;
let jumpVelocity = 0;

// Intro cinematic state
let isCinematic = false;
let cinematic = null;
const playerStartPos = new THREE.Vector3();

// Shooting
const raycaster = new THREE.Raycaster();
raycaster.far = 500;
let shootCooldown = 0;
const shootCooldownMax = 0.15;
let kills = 0;

// FX
const effects = [];
function spawnMuzzleFlash() {
  if (!gunBarrel) return;
  const mat = new THREE.SpriteMaterial({ color: 0xffcc88, transparent: true, opacity: 1, depthTest: false, blending: THREE.AdditiveBlending });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(0.25);
  gunBarrel.add(s);
  effects.push({ obj: s, life: 0.07, maxLife: 0.07, isSprite: true });
}
function spawnShellEject() {
  if (!ejectPort) return;
  const mat = new THREE.MeshStandardMaterial({ color: 0xC0A060, metalness: 0.8, roughness: 0.3, transparent: true, opacity: 1 });
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.16, 10), mat);
  mesh.rotation.z = Math.PI / 2;
  const worldPos = ejectPort.getWorldPosition(new THREE.Vector3());
  mesh.position.copy(worldPos);
  scene.add(mesh);
  // Velocity mostly to the right and slightly up/forward
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const vel = new THREE.Vector3().addScaledVector(right, 2.2).addScaledVector(up, 1.2).addScaledVector(fwd, 0.3);
  const rot = new THREE.Vector3((Math.random()-0.5)*6, (Math.random()-0.5)*6, (Math.random()-0.5)*6);
  effects.push({ obj: mesh, life: 1.2, maxLife: 1.2, vel, rot });
}
function spawnKillBurst(at) {
  // Expanding shockwave
  const ringGeo = new THREE.RingGeometry(0.05, 0.07, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false, blending: THREE.AdditiveBlending });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(at);
  ring.position.y += 0.2;
  scene.add(ring);
  effects.push({ obj: ring, life: 0.5, maxLife: 0.5, scaleVel: 6 });

  // Spark sprites
  const colors = [0xffee88, 0x88ddff, 0xff6699, 0xaaff88];
  for (let i = 0; i < 28; i++) {
    const c = colors[i % colors.length];
    const mat = new THREE.SpriteMaterial({ color: c, transparent: true, opacity: 1, depthTest: false, blending: THREE.AdditiveBlending });
    const s = new THREE.Sprite(mat);
    s.scale.setScalar(0.08 + Math.random() * 0.05);
    s.position.copy(at);
    scene.add(s);
    const vel = new THREE.Vector3().randomDirection().multiplyScalar(3 + Math.random() * 4);
    vel.y += 2;
    effects.push({ obj: s, life: 0.6, maxLife: 0.6, vel, isSprite: true });
  }
}
function updateEffects(dt) {
  for (let i = effects.length - 1; i >= 0; i--) {
    const fx = effects[i];
    fx.life -= dt;
    const t = Math.max(0, fx.life / fx.maxLife);
    if (fx.vel) {
      fx.vel.y -= 9.8 * dt;
      fx.obj.position.addScaledVector(fx.vel, dt);
    }
    if (fx.rot) {
      fx.obj.rotation.x += fx.rot.x * dt;
      fx.obj.rotation.y += fx.rot.y * dt;
      fx.obj.rotation.z += fx.rot.z * dt;
    }
    if (fx.scaleVel) {
      const s = 1 + fx.scaleVel * dt;
      fx.obj.scale.multiplyScalar(s);
      if (fx.obj.material) fx.obj.material.opacity = t * 0.8;
    }
    if (fx.isSprite) fx.obj.material.opacity = t; else if (!fx.scaleVel && fx.obj.material) fx.obj.material.opacity = Math.max(0.05, t);
    if (fx.life <= 0) {
      fx.obj.parent?.remove(fx.obj);
      if (fx.obj.material) fx.obj.material.dispose?.();
      if (fx.obj.geometry) fx.obj.geometry.dispose?.();
      effects.splice(i, 1);
    }
  }
}

// Audio
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
  }
  return audioCtx;
}
function createNoiseBuffer(ctx, duration = 0.2) {
  const buffer = ctx.createBuffer(1, Math.ceil(duration * ctx.sampleRate), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
function playShotSound() {
  const ctx = ensureAudio();
  const now = ctx.currentTime;

  // Master gain
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.7, now);
  master.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
  master.connect(ctx.destination);

  // Noise burst through bandpass (muzzle blast)
  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.2);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(2500, now);
  bp.Q.setValueAtTime(0.6, now);
  noise.connect(bp).connect(master);
  noise.start(now);
  noise.stop(now + 0.18);

  // Clicky transient (square osc downward pitch)
  const osc = ctx.createOscillator();
  osc.type = 'square';
  const oGain = ctx.createGain();
  oGain.gain.setValueAtTime(0.4, now);
  oGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  osc.frequency.setValueAtTime(900, now);
  osc.frequency.exponentialRampToValueAtTime(120, now + 0.12);
  osc.connect(oGain).connect(master);
  osc.start(now);
  osc.stop(now + 0.12);
}

function playOhNo() {
  // 50 random death quips
  const quips = [
    'oh no', 'ouch', 'aargh', 'bye!', 'nooo', 'yikes', 'uh oh', "I'm hit", 'that hurt', 'why me',
    'not again', 'you got me', 'see ya', 'farewell', 'so cold', 'tell my mom', 'this is fine', 'ow', 'down I go', 'oops',
    'dang it', 'blast', 'that stings', 'goodbye cruel world', 'what a world', 'I regret nothing', 'not today', 'sleepy time', 'whoa', 'boo',
    'mercy', 'adios', 'ciao', 'hasta la vista', 'au revoir', 'later', 'rip me', 'zoinks', 'kaboom', 'ugh',
    'oof', 'my spleen', 'right in the pixels', 'sayonara', 'it burns', 'fatality', 'defeated', 'out of ammo', 'game over', "I'm melting"
  ];
  const text = quips[Math.floor(Math.random() * quips.length)];
  try {
    if ('speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined') {
      const u = new SpeechSynthesisUtterance(text);
      // slight randomization for variety
      u.rate = 0.95 + Math.random() * 0.2;
      u.pitch = 0.7 + Math.random() * 0.3;
      u.volume = 0.9;
      window.speechSynthesis.speak(u);
      return;
    }
  } catch {}
  // Fallback: simple WebAudio vowel-like tone with glide
  const ctx = ensureAudio();
  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.connect(ctx.destination);

  const osc1 = ctx.createOscillator(); osc1.type = 'triangle';
  const osc2 = ctx.createOscillator(); osc2.type = 'sine'; osc2.detune.value = -8;
  const vGain = ctx.createGain();
  vGain.connect(master);
  osc1.connect(vGain); osc2.connect(vGain);

  vGain.gain.setValueAtTime(0.0001, now);
  vGain.gain.exponentialRampToValueAtTime(0.3, now + 0.04);
  vGain.gain.exponentialRampToValueAtTime(0.08, now + 0.20);
  vGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.85);

  osc1.frequency.setValueAtTime(320, now);
  osc2.frequency.setValueAtTime(320, now);
  osc1.frequency.exponentialRampToValueAtTime(260, now + 0.18);
  osc2.frequency.exponentialRampToValueAtTime(260, now + 0.18);
  osc1.frequency.exponentialRampToValueAtTime(180, now + 0.75);
  osc2.frequency.exponentialRampToValueAtTime(180, now + 0.75);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1800, now);
  lp.Q.value = 0.7;
  vGain.disconnect();
  osc1.disconnect(); osc2.disconnect();
  const mix = ctx.createGain();
  osc1.connect(mix); osc2.connect(mix);
  mix.connect(lp).connect(master);

  osc1.start(now); osc2.start(now);
  osc1.stop(now + 0.9); osc2.stop(now + 0.9);
}

// Agents
const agents = [];
const bullets = [];
const worldBounds = { minX: -terrainSize/2, maxX: terrainSize/2, minZ: -terrainSize/2, maxZ: terrainSize/2 };

function setStatus(text) {
  statusEl.textContent = text;
}

function median3x3(src, size) {
  const dst = new Float32Array(src.length);
  const w = size, h = size;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const vals = [];
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          vals.push(src[yy * w + xx]);
        }
      }
      vals.sort((a, b) => a - b);
      dst[y * w + x] = vals[4];
    }
  }
  return dst;
}

function blurSeparable(src, size, passes = 1) {
  const w = size, h = size;
  let a = src, b = new Float32Array(src.length);
  const k0 = 1 / 4, k1 = 2 / 4; // kernel [1,2,1]/4
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const xm1 = Math.max(0, x - 1), xp1 = Math.min(w - 1, x + 1);
        b[row + x] = k0 * a[row + xm1] + k1 * a[row + x] + k0 * a[row + xp1];
      }
    }
    // vertical
    for (let y = 0; y < h; y++) {
      const ym1 = Math.max(0, y - 1), yp1 = Math.min(h - 1, y + 1);
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        a[i] = k0 * b[ym1 * w + x] + k1 * b[i] + k0 * b[yp1 * w + x];
      }
    }
  }
  return a;
}

async function inferDepthONNX(sourceCanvas, targetSize) {
  if (!window.ort) throw new Error('ONNX Runtime Web not available');
  const ort = window.ort;
  // Avoid crossOriginIsolated requirement: force single-threaded WASM
  try {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
  } catch {}
  // MiDaS small expects 256x256 RGB normalized
  const inputW = 256, inputH = 256;
  const tmp = document.createElement('canvas');
  tmp.width = inputW; tmp.height = inputH;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(sourceCanvas, 0, 0, inputW, inputH);
  const img = tctx.getImageData(0, 0, inputW, inputH).data;
  // Build Float32 NHWC then transpose to NCHW as needed
  const chw = new Float32Array(1 * 3 * inputH * inputW);
  for (let y = 0; y < inputH; y++) {
    for (let x = 0; x < inputW; x++) {
      const i = (y * inputW + x) * 4;
      const r = img[i] / 255;
      const g = img[i + 1] / 255;
      const b = img[i + 2] / 255;
      const idx = y * inputW + x;
      chw[idx] = r;               // C0
      chw[inputW * inputH + idx] = g; // C1
      chw[2 * inputW * inputH + idx] = b; // C2
    }
  }

  const session = await ort.InferenceSession.create('./assets/models/midas_small_v21.onnx', { executionProviders: ['wasm'] });
  const feeds = {};
  // Input name varies; pick the first input
  const inputName = session.inputNames[0];
  feeds[inputName] = new ort.Tensor('float32', chw, [1, 3, inputH, inputW]);
  const output = await session.run(feeds);
  const outputName = session.outputNames[0];
  const outTensor = output[outputName]; // shape [1,1,H,W] or [1,H,W]
  const outData = outTensor.data;
  let outH, outW;
  if (outTensor.dims.length === 4) { outH = outTensor.dims[2]; outW = outTensor.dims[3]; }
  else if (outTensor.dims.length === 3) { outH = outTensor.dims[1]; outW = outTensor.dims[2]; }
  else throw new Error('Unexpected tensor dims');

  // Robust normalize using percentiles to ignore outliers, then invert and gamma
  const arr = Array.from(outData);
  arr.sort((a,b)=>a-b);
  const p = (q)=>arr[Math.max(0, Math.min(arr.length-1, Math.floor(q*(arr.length-1))))];
  const lo = p(0.02), hi = p(0.98);
  const invRange = Math.max(1e-6, hi - lo);
  const out01 = new Float32Array(outData.length);
  const gamma = DEPTH_GAMMA;
  for (let i = 0; i < outData.length; i++) {
    let v = (outData[i] - lo) / invRange; // 0..1
    v = Math.max(0, Math.min(1, v));
    v = 1 - v;                 // invert so nearer -> higher
    v = Math.pow(v, gamma);    // gamma shape to accentuate near
    out01[i] = v;
  }

  // Resample to targetSize x targetSize bilinearly
  const resampled = new Float32Array(targetSize * targetSize);
  for (let y = 0; y < targetSize; y++) {
    const v = y / (targetSize - 1);
    const sy = v * (outH - 1);
    const y0 = Math.floor(sy), y1 = Math.min(outH - 1, Math.ceil(sy));
    const ty = sy - y0;
    for (let x = 0; x < targetSize; x++) {
      const u = x / (targetSize - 1);
      const sx = u * (outW - 1);
      const x0 = Math.floor(sx), x1 = Math.min(outW - 1, Math.ceil(sx));
      const tx = sx - x0;
      const i00 = y0 * outW + x0;
      const i10 = y0 * outW + x1;
      const i01 = y1 * outW + x0;
      const i11 = y1 * outW + x1;
      const a = out01[i00] * (1 - tx) + out01[i10] * tx;
      const b = out01[i01] * (1 - tx) + out01[i11] * tx;
      resampled[y * targetSize + x] = a * (1 - ty) + b * ty;
    }
  }
  return resampled;
}

async function createTerrainFromImage(imageBitmap) {
  // Prefer ONNX MiDaS; fallback to blur method
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imageBitmap, 0, 0, size, size);

  // Keep this as the minimap background source
  minimapSourceCanvas = canvas;

  let usedML = false;
  let depth01 = null;
  try {
    if (window.ort) {
      setStatus('Estimating depth (ONNX)…');
      depth01 = await inferDepthONNX(canvas, size);
      usedML = true;
      console.info('[DepthONNX] success');
    }
  } catch (e) {
    console.warn('[DepthONNX] failed; using blur fallback', e);
  }

  // Always compute detail map from image (to blend even with ML)
  const blurCanvas = document.createElement('canvas');
  blurCanvas.width = size; blurCanvas.height = size;
  const blurCtx = blurCanvas.getContext('2d');
  blurCtx.filter = 'blur(12px)';
  blurCtx.drawImage(canvas, 0, 0);
  const img = ctx.getImageData(0, 0, size, size).data;
  const blurImg = blurCtx.getImageData(0, 0, size, size).data;
  const detail01 = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const r = img[i*4]/255, g = img[i*4+1]/255, b = img[i*4+2]/255;
    const br = blurImg[i*4]/255, bg = blurImg[i*4+1]/255, bb = blurImg[i*4+2]/255;
    const l = 0.2126*r + 0.7152*g + 0.0722*b;
    const base = 0.2126*br + 0.7152*bg + 0.0722*bb;
    const d = Math.max(-0.5, Math.min(0.5, (l - base) * DETAIL_BOOST));
    detail01[i] = d + 0.5; // 0..1
  }

  if (usedML && depth01) {
    // Blend depth with detail, then clamp
    heightData = new Float32Array(size * size);
    for (let i = 0; i < heightData.length; i++) {
      let h = depth01[i] + DETAIL_WEIGHT * (detail01[i] - 0.5);
      h = Math.max(0, Math.min(1, h));
      heightData[i] = h;
    }
    heightDataSize = size;
  } else {
    // Fallback: normalize blended base (like before) if ML missing
    heightData = new Float32Array(size * size);
    let minH = Infinity, maxH = -Infinity;
    const baseWeight = 0.85;
    const dWeight = 0.55 * 0.7; // slightly toned down
    for (let i = 0; i < size * size; i++) {
      const br = blurImg[i*4]/255, bg = blurImg[i*4+1]/255, bb = blurImg[i*4+2]/255;
      const base = 0.2126*br + 0.7152*bg + 0.0722*bb;
      const h = baseWeight * base + dWeight * (detail01[i]);
      if (h < minH) minH = h; if (h > maxH) maxH = h;
      heightData[i] = h;
    }
    const range = Math.max(1e-5, maxH - minH);
    for (let i = 0; i < heightData.length; i++) heightData[i] = (heightData[i] - minH) / range;
    heightDataSize = size;
  }

  // Smoothing to reduce spikes
  if (USE_MEDIAN) heightData = median3x3(heightData, size);
  heightData = blurSeparable(heightData, size, SMOOTH_PASSES);
  // Re-normalize to 0..1 after smoothing
  {
    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < heightData.length; i++) { const v = heightData[i]; if (v < minV) minV = v; if (v > maxV) maxV = v; }
    const range = Math.max(1e-6, maxV - minV);
    for (let i = 0; i < heightData.length; i++) heightData[i] = (heightData[i] - minV) / range;
  }

  // Construct mesh from heightData
  const texture = new THREE.CanvasTexture(ctx.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const geometry = new THREE.PlaneGeometry(terrainSize, terrainSize, terrainResolution, terrainResolution);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  const uvs = geometry.attributes.uv;
  const displacementScale = DISPLACEMENT_SCALE;
  for (let i = 0; i < positions.count; i++) {
    const u = uvs.getX(i);
    const v = uvs.getY(i);
    const h = sampleHeightData(u, v);
    positions.setY(i, positions.getY(i) + (h - 0.5) * 2 * displacementScale * DEPTH_SIGN);
  }
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  if (terrainMesh) scene.remove(terrainMesh);
  terrainMesh = mesh; scene.add(terrainMesh);

  playerStartPos.set(0, getHeightAt(0, 0) + eyeHeight, terrainSize * 0.35);
  const farPos = new THREE.Vector3(0, terrainSize * 0.9, terrainSize * 1.4);
  controls.getObject().position.copy(farPos);
  camera.fov = 40; camera.updateProjectionMatrix();
  setStatus('Playing intro…'); startBtn.disabled = true;
  startIntroCinematic(farPos, playerStartPos, 40, 70);

  if (agents.length === 0) spawnAgents(24); else for (const a of agents) placeAgentOnSurface(a, a.object.position.x, a.object.position.z, true);
}

function sampleHeightData(u, v) {
  if (!heightData) return 0.5; // flat mid
  // Clamp uv to [0,1]
  u = Math.min(1, Math.max(0, u));
  v = Math.min(1, Math.max(0, v));
  const x = u * (heightDataSize - 1);
  const y = (1 - v) * (heightDataSize - 1); // flip v
  const x0 = Math.floor(x), x1 = Math.min(heightDataSize - 1, Math.ceil(x));
  const y0 = Math.floor(y), y1 = Math.min(heightDataSize - 1, Math.ceil(y));
  const tx = x - x0, ty = y - y0;
  const i00 = y0 * heightDataSize + x0;
  const i10 = y0 * heightDataSize + x1;
  const i01 = y1 * heightDataSize + x0;
  const i11 = y1 * heightDataSize + x1;
  const a = heightData[i00] * (1 - tx) + heightData[i10] * tx;
  const b = heightData[i01] * (1 - tx) + heightData[i11] * tx;
  return a * (1 - ty) + b * ty;
}

function getHeightAt(x, z) {
  // Map world (x,z) in [-size/2, size/2] to uv
  const u = (x + terrainSize / 2) / terrainSize;
  const v = 1 - (z + terrainSize / 2) / terrainSize;
  const h01 = sampleHeightData(u, v); // 0..1
  const scale = DISPLACEMENT_SCALE;
  const y = (h01 - 0.5) * 2 * scale * DEPTH_SIGN;
  return y;
}

function easeInOutCubic(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function startIntroCinematic(fromPos, toPos, fov0 = 40, fov1 = 70) {
  isCinematic = true;
  cinematic = {
    from: fromPos.clone(),
    to: toPos.clone(),
    fov0,
    fov1,
    durationSec: 3.5,
    elapsedSec: 0,
    onComplete: () => {
      isCinematic = false;
      controls.getObject().position.copy(toPos);
      camera.fov = fov1;
      camera.updateProjectionMatrix();
      startBtn.disabled = false;
      setStatus('Image loaded. Click Play to lock mouse.');
    }
  };
}

function updateCinematic(dt) {
  if (!isCinematic || !cinematic) return;
  cinematic.elapsedSec += dt;
  const tRaw = Math.min(1, cinematic.elapsedSec / cinematic.durationSec);
  const t = easeInOutCubic(tRaw);

  const pos = new THREE.Vector3().lerpVectors(cinematic.from, cinematic.to, t);
  controls.getObject().position.copy(pos);

  const lookTarget = new THREE.Vector3(0, getHeightAt(pos.x, pos.z) + eyeHeight, 0);
  camera.lookAt(lookTarget);
  camera.fov = THREE.MathUtils.lerp(cinematic.fov0, cinematic.fov1, t);
  camera.updateProjectionMatrix();

  if (tRaw >= 1 && cinematic.onComplete) {
    const done = cinematic.onComplete;
    cinematic.onComplete = null;
    done();
  }
}

// --- Agents ---
function createAgent() {
  const group = new THREE.Group();

  const bodyMaterial = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.5, 0.5) });
  const blackMaterial = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.2, roughness: 0.8 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.8, 1.0, 4, 8), bodyMaterial);
  body.castShadow = true;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 12), bodyMaterial);
  head.position.y = 1.6;
  head.castShadow = true;
  group.add(head);

  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.2, 0.2), blackMaterial);
  gun.position.set(0.7, 0.6, 0);
  group.add(gun);

  group.scale.setScalar(1.2);

  return group;
}

function spawnAgents(count) {
  for (let i = 0; i < count; i++) {
    const object = createAgent();
    scene.add(object);
    const agent = {
      object,
      velocity: new THREE.Vector3(),
      heading: Math.random() * Math.PI * 2,
      fireCooldown: Math.random() * 1.5,
    };
    // Tag all descendant meshes with a back-reference to this agent for hit detection
    object.traverse(node => { node.userData.agent = agent; });

    const x = THREE.MathUtils.lerp(worldBounds.minX + 10, worldBounds.maxX - 10, Math.random());
    const z = THREE.MathUtils.lerp(worldBounds.minZ + 10, worldBounds.maxZ - 10, Math.random());
    placeAgentOnSurface(agent, x, z, true);
    agents.push(agent);
  }
}

function placeAgentOnSurface(agent, x, z, randomizeHeading = false) {
  const y = getHeightAt(x, z);
  agent.object.position.set(x, y + 1.2, z);
  if (randomizeHeading) agent.heading = Math.random() * Math.PI * 2;
}

function updateAgents(dt) {
  for (const a of agents) {
    // Wander behavior
    const turnRate = 0.9; // rad/s
    a.heading += (Math.random() - 0.5) * turnRate * dt;
    const speed = 10 + Math.random() * 4;
    const dirX = Math.cos(a.heading);
    const dirZ = Math.sin(a.heading);
    a.object.position.x += dirX * speed * dt;
    a.object.position.z += dirZ * speed * dt;

    // Keep within bounds
    a.object.position.x = THREE.MathUtils.clamp(a.object.position.x, worldBounds.minX + 2, worldBounds.maxX - 2);
    a.object.position.z = THREE.MathUtils.clamp(a.object.position.z, worldBounds.minZ + 2, worldBounds.maxZ - 2);

    // Stick to surface
    const groundY = getHeightAt(a.object.position.x, a.object.position.z);
    a.object.position.y = groundY + 1.2;

    // Look forward
    a.object.rotation.y = Math.atan2(dirX, dirZ);

    // Firing
    a.fireCooldown -= dt;
    if (a.fireCooldown <= 0) {
      a.fireCooldown = 0.6 + Math.random() * 1.2;
      const target = pickTarget(a);
      if (target) fireBullet(a.object.position, target.object.position);
    }
  }
}

function pickTarget(fromAgent) {
  let best = null;
  let bestDist2 = Infinity;
  for (const other of agents) {
    if (other === fromAgent) continue;
    const d2 = fromAgent.object.position.distanceToSquared(other.object.position);
    if (d2 < bestDist2 && d2 < 1200) { // within ~34 units
      best = other;
      bestDist2 = d2;
    }
  }
  return best;
}

function fireBullet(from, to, color = 0xffcc66, life = 0.12) {
  const geom = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, depthTest: false, blending: THREE.AdditiveBlending });
  const line = new THREE.Line(geom, mat);
  scene.add(line);
  bullets.push({ line, life });
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.life -= dt;
    b.line.material.opacity = Math.max(0, b.life / 0.12);
    if (b.life <= 0) {
      scene.remove(b.line);
      b.line.geometry.dispose();
      b.line.material.dispose();
      bullets.splice(i, 1);
    }
  }
}

// --- Player movement ---
const keys = new Set();
window.addEventListener('keydown', (e) => { keys.add(e.code); });
window.addEventListener('keyup', (e) => { keys.delete(e.code); });

startBtn.addEventListener('click', () => {
  if (isCoarse) {
    // On mobile, don’t lock pointer; show controls
    controls.unlock();
  } else {
    controls.lock();
  }
});

controls.addEventListener('lock', () => {
  setStatus('Mouse locked. Left-click to shoot. WASD to move, Space to jump, Esc to release.');
});
controls.addEventListener('unlock', () => {
  if (isCoarse) setStatus('Touch sticks to move/look. Buttons to shoot/jump.');
  else setStatus('Mouse unlocked. Click Play to lock again.');
});

renderer.domElement.addEventListener('mousedown', (e) => {
  if (!controls.isLocked || isCinematic) return;
  if (e.button !== 0) return; // left click
  tryShoot();
});

function tryShoot() {
  if (shootCooldown > 0) return;
  shootCooldown = shootCooldownMax;

  // Setup ray from camera
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const agentObjects = agents.map(a => a.object);
  const hits = raycaster.intersectObjects(agentObjects, true);

  const camPos = new THREE.Vector3();
  camera.getWorldPosition(camPos);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  // Start tracer slightly in front of camera or at gun muzzle
  let startPoint = camPos.clone().addScaledVector(dir, 0.6);
  if (gunBarrel) startPoint = gunBarrel.getWorldPosition(new THREE.Vector3());

  let endPoint = new THREE.Vector3();
  if (hits.length > 0) {
    const hit = hits[0];
    endPoint.copy(hit.point);
    const hitAgent = hit.object.userData.agent;
    if (hitAgent) removeAgent(hitAgent);
  } else {
    endPoint.copy(startPoint).addScaledVector(dir, raycaster.far);
  }

  spawnMuzzleFlash();
  spawnShellEject();
  addRecoil(1);
  playShotSound();
  // Tracer
  fireBullet(startPoint, endPoint, 0x66ccff, 0.08);
}

function removeAgent(agent) {
  const idx = agents.indexOf(agent);
  if (idx !== -1) {
    // Spawn kill FX before removing
    spawnKillBurst(agent.object.position.clone());

    scene.remove(agent.object);
    agent.object.traverse(node => {
      if (node.geometry) node.geometry.dispose?.();
      if (node.material) node.material.dispose?.();
    });
    agents.splice(idx, 1);
    kills += 1;
    setStatus(`Kills: ${kills} | Enemies: ${agents.length}`);
    playOhNo(); // Call the new function here
  }
}

// Apply mobile look each frame if needed
function applyMobileLook(dt) {
  if (!isCoarse || isCinematic) return;
  // Scale look speed
  const yawSpeed = 1.8; // rad/s at full stick
  const pitchSpeed = 1.4;
  manualYaw += -mobileLook.x * yawSpeed * dt; // drag right -> look right
  manualPitch += -mobileLook.y * pitchSpeed * dt;
  manualPitch = Math.max(-Math.PI/2 + 0.1, Math.min(Math.PI/2 - 0.1, manualPitch));
  controls.getObject().rotation.y = manualYaw;
  camera.rotation.x = manualPitch;
}

function updatePlayer(dt) {
  if (isCinematic) return;

  const forward = new THREE.Vector3();
  const up = new THREE.Vector3(0,1,0);
  if (controls.isLocked && !isCoarse) {
    controls.getDirection(forward);
    forward.y = 0; forward.normalize();
  } else {
    // Build forward from manual yaw when not pointer-locked (mobile)
    forward.set(Math.sin(controls.getObject().rotation.y), 0, Math.cos(controls.getObject().rotation.y)).negate();
  }
  const right = new THREE.Vector3().crossVectors(forward, up).normalize();

  moveVelocity.set(0, 0, 0);
  if (keys.has('KeyW') || (isCoarse && mobileMove.y < 0)) moveVelocity.addScaledVector(forward, Math.abs(mobileMove.y) || 1);
  if (keys.has('KeyS') || (isCoarse && mobileMove.y > 0)) moveVelocity.addScaledVector(forward, -Math.abs(mobileMove.y) || -1);
  if (keys.has('KeyA') || (isCoarse && mobileMove.x < 0)) moveVelocity.addScaledVector(right, -(Math.abs(mobileMove.x) || 1));
  if (keys.has('KeyD') || (isCoarse && mobileMove.x > 0)) moveVelocity.addScaledVector(right, (Math.abs(mobileMove.x) || 1));
  if (moveVelocity.lengthSq() > 0) moveVelocity.normalize().multiplyScalar(playerSpeed * dt);

  const currentPos = controls.getObject().position;
  currentPos.x += moveVelocity.x;
  currentPos.z += moveVelocity.z;

  // Bounds
  currentPos.x = THREE.MathUtils.clamp(currentPos.x, worldBounds.minX + 2, worldBounds.maxX - 2);
  currentPos.z = THREE.MathUtils.clamp(currentPos.z, worldBounds.minZ + 2, worldBounds.maxZ - 2);

  // Ground follow + jump/gravity
  const groundY = getHeightAt(currentPos.x, currentPos.z) + eyeHeight;
  if (isOnGround) {
    if (keys.has('Space')) {
      jumpVelocity = 10;
      isOnGround = false;
    } else {
      currentPos.y = groundY;
    }
  }

  if (!isOnGround) {
    jumpVelocity -= 30 * dt; // gravity
    currentPos.y += jumpVelocity * dt;
    if (currentPos.y <= groundY) {
      currentPos.y = groundY;
      isOnGround = true;
      jumpVelocity = 0;
    }
  }
}

// --- Image upload ---
faceFileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  // Ensure camera overlay is closed if it was open
  try { closeCamera(); } catch {}
  setStatus('Loading image…');
  try {
    // Prefer direct decode from the File (works cross-origin when hosted)
    const imageBitmap = await createImageBitmap(file);
    await createTerrainFromImage(imageBitmap);
  } catch (err) {
    // Fallback path via HTMLImageElement and canvas
    try {
      const blobURL = URL.createObjectURL(file);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = blobURL;
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx2 = c.getContext('2d');
      if (!ctx2) throw new Error('Canvas 2D context unavailable');
      ctx2.drawImage(img, 0, 0);
      const imageBitmap = await createImageBitmap(c);
      URL.revokeObjectURL(blobURL);
      await createTerrainFromImage(imageBitmap);
    } catch (err2) {
      console.error('Failed to load image', err, err2);
      setStatus('Failed to load image');
    }
  }
});

// --- Resize ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Minimap elements
const minimapCanvas = document.getElementById('minimap');
let minimapCtx = minimapCanvas ? minimapCanvas.getContext('2d') : null;
let minimapPixelSize = 180;
let minimapSourceCanvas = null; // will hold the 512x512 image canvas used for texture

function initMinimapCanvas() {
  if (!minimapCanvas || !minimapCtx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = parseInt(getComputedStyle(minimapCanvas).width, 10) || 180;
  const cssH = parseInt(getComputedStyle(minimapCanvas).height, 10) || 180;
  minimapCanvas.width = Math.round(cssW * dpr);
  minimapCanvas.height = Math.round(cssH * dpr);
  minimapPixelSize = Math.min(minimapCanvas.width, minimapCanvas.height);
  minimapCtx.imageSmoothingEnabled = true;
}
initMinimapCanvas();
window.addEventListener('resize', initMinimapCanvas);

function drawMinimap() {
  if (!minimapCanvas || !minimapCtx) return;
  minimapCtx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
  const w = minimapCanvas.width;
  const h = minimapCanvas.height;

  // Background: draw the face image as-is (no flip)
  if (minimapSourceCanvas) {
    minimapCtx.globalAlpha = 0.95;
    minimapCtx.drawImage(minimapSourceCanvas, 0, 0, w, h);
    minimapCtx.globalAlpha = 1;
  } else {
    minimapCtx.fillStyle = 'rgba(0,0,0,0.5)';
    minimapCtx.fillRect(0, 0, w, h);
  }

  // Helper: map world (x,z) to pixel (mx,my) so increasing world Z moves the dot DOWN (south)
  const worldToMap = (x, z) => {
    const u = (x + terrainSize / 2) / terrainSize;
    const v = (z + terrainSize / 2) / terrainSize;
    const mx = u * w;
    const my = v * h; // world +Z => canvas +Y (down)
    return [mx, my];
  };

  // Draw agents
  minimapCtx.lineWidth = Math.max(1, w * 0.006);
  for (const a of agents) {
    const [mx, my] = worldToMap(a.object.position.x, a.object.position.z);
    minimapCtx.fillStyle = '#ff6b6b';
    minimapCtx.strokeStyle = 'rgba(0,0,0,0.6)';
    minimapCtx.beginPath();
    minimapCtx.arc(mx, my, w * 0.015, 0, Math.PI * 2);
    minimapCtx.fill();
    minimapCtx.stroke();
  }

  // Draw player and facing
  const px = controls.getObject().position.x;
  const pz = controls.getObject().position.z;
  const [pmx, pmy] = worldToMap(px, pz);
  minimapCtx.fillStyle = '#66ccff';
  minimapCtx.strokeStyle = 'rgba(0,0,0,0.6)';
  minimapCtx.beginPath();
  minimapCtx.arc(pmx, pmy, w * 0.018, 0, Math.PI * 2);
  minimapCtx.fill();
  minimapCtx.stroke();

  // Facing arrow: use positive dir.z to move arrow DOWN (south) on the map
  const dir = new THREE.Vector3();
  controls.getDirection(dir);
  const pxPerWorld = w / terrainSize;
  const arrowWorldLen = terrainSize * 0.12;
  const dx = dir.x * arrowWorldLen * pxPerWorld;
  const dy = dir.z * arrowWorldLen * pxPerWorld; // +Z => canvas down
  minimapCtx.strokeStyle = '#66ccff';
  minimapCtx.lineWidth = Math.max(2, w * 0.01);
  minimapCtx.beginPath();
  minimapCtx.moveTo(pmx, pmy);
  minimapCtx.lineTo(pmx + dx, pmy + dy);
  minimapCtx.stroke();

  // Border
  minimapCtx.strokeStyle = 'rgba(255,255,255,0.3)';
  minimapCtx.lineWidth = Math.max(1, w * 0.01);
  minimapCtx.strokeRect(0.5 * minimapCtx.lineWidth, 0.5 * minimapCtx.lineWidth, w - minimapCtx.lineWidth, h - minimapCtx.lineWidth);
}

// --- Animation loop ---
let lastTime = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.033, (now - lastTime) / 1000); // clamp to avoid huge steps
  lastTime = now;

  shootCooldown = Math.max(0, shootCooldown - dt);
  updateCinematic(dt);
  applyMobileLook(dt);
  updatePlayer(dt);
  updateAgents(dt);
  updateBullets(dt);
  updateEffects(dt);
  updateGun(dt);
  drawMinimap();

  renderer.render(scene, camera);
}
animate();

// Initial flat plane so you see something even before uploading
(function initFlatPlane() {
  const geo = new THREE.PlaneGeometry(terrainSize, terrainSize, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 1.0 });
  terrainMesh = new THREE.Mesh(geo, mat);
  scene.add(terrainMesh);

  camera.position.set(0, 30, 120);
  camera.lookAt(0, 0, 0);
})();

// Camera capture elements
const cameraBtn = document.getElementById('splashCameraBtn');
const cameraOverlay = document.getElementById('cameraOverlay');
const cameraVideo = document.getElementById('cameraVideo');
const cameraCaptureBtn = document.getElementById('cameraCaptureBtn');
const cameraCancelBtn = document.getElementById('cameraCancelBtn');
let cameraStream = null;

async function openCamera() {
  try {
    const constraints = { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false };
    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    cameraVideo.srcObject = cameraStream;
    cameraOverlay.classList.remove('hidden');
    splashEl?.classList.remove('show');
  } catch (e) {
    console.warn('Camera open failed', e);
    // Fallback to file picker
    faceFileInput?.click();
  }
}
function closeCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  cameraVideo.srcObject = null;
  cameraOverlay.classList.add('hidden');
}

async function captureCameraFrame() {
  if (!cameraVideo.videoWidth || !cameraVideo.videoHeight) return;
  const maxDim = 1024;
  const ar = cameraVideo.videoWidth / cameraVideo.videoHeight;
  const w = ar >= 1 ? maxDim : Math.round(maxDim * ar);
  const h = ar >= 1 ? Math.round(maxDim / ar) : maxDim;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  // Mirror for front camera
  cx.translate(w, 0); cx.scale(-1, 1);
  cx.drawImage(cameraVideo, 0, 0, w, h);
  const bitmap = await createImageBitmap(c);
  closeCamera();
  await createTerrainFromImage(bitmap);
}

cameraBtn?.addEventListener('click', openCamera);
cameraCancelBtn?.addEventListener('click', closeCamera);
cameraCaptureBtn?.addEventListener('click', captureCameraFrame); 
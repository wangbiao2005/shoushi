import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';

// Declare global variables for MediaPipe provided via script tags
declare global {
  interface Window {
    Hands: any;
    Camera: any;
    drawConnectors: any;
    drawLandmarks: any;
  }
}

// Configuration
const PARTICLE_COUNT = 25000; // Increased for Earth density
const STAR_COUNT = 2500;
const PARTICLE_SIZE = 0.15;
const CAMERA_Z = 45;
const COLLISION_RADIUS = 0.15;
const GRID_DIM = 60; 
const GRID_OFFSET = 30; 
const CELL_SIZE = 1.0; 

// State
let targetScale = 1.0;
let currentScale = 1.0;
let targetRotation = { x: 0, y: 0 };
let currentRotation = { x: 0, y: 0 };
let isHandDetected = false;
let currentShape = 'earth';
let baseColor = new THREE.Color(0x00f3ff);
let time = 0;
let trailsEnabled = true;
let physicsEnabled = true;

// Hand tracking specific
let handLandmarks: any[] = [];
let isPinching = false;
let pinchTriggered = false; // Debounce for clicks

// Audio State
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let dataArray: Uint8Array | null = null;
let isAudioActive = false;
let bassFactor = 0; // 0.0 to 1.0
let shockwave = 0; 

// Visualizer UI Elements
let vizBarLow: HTMLElement | null = null;
let vizBarMid: HTMLElement | null = null;
let vizBarHigh: HTMLElement | null = null;

// Interaction State
const mouse = new THREE.Vector2(-9999, -9999);
const raycaster = new THREE.Raycaster();
let hoverPoint: THREE.Vector3 | null = null;

// Three.js Globals
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let composer: EffectComposer;
let bloomPass: UnrealBloomPass;
let afterimagePass: AfterimagePass;

// Main Particles
let geometry: THREE.BufferGeometry;
let material: THREE.PointsMaterial;
let points: THREE.Points;
let cursorMesh: THREE.Mesh; // The "Iron Man" targeting reticle

// Physics Data
const velocities = new Float32Array(PARTICLE_COUNT * 3);
const gridHead = new Int32Array(GRID_DIM * GRID_DIM * GRID_DIM);
const gridNext = new Int32Array(PARTICLE_COUNT);

// Starfield (Warp Effect)
let starGeometry: THREE.BufferGeometry;
let starMaterial: THREE.PointsMaterial;
let starPoints: THREE.Points;

// Geometry Targets
const targets: { [key: string]: Float32Array } = {};
const originalPositions: Float32Array = new Float32Array(PARTICLE_COUNT * 3);

// --- Initialization ---

async function init() {
  try {
    initThree();
    generateShapes();
    setupUI();
    
    try {
      initMediaPipe();
    } catch (e) {
      console.warn("MediaPipe failed to initialize (Camera/Hands might be blocked):", e);
    }
    
    initInputListeners();
    animate();
    
    const loadingEl = document.getElementById('loading');
    if(loadingEl) loadingEl.style.display = 'none';
  } catch (err) {
    console.error("Critical Initialization Error:", err);
    const loadingEl = document.getElementById('loading');
    if (loadingEl) {
      loadingEl.innerHTML = `SYSTEM FAILURE<br><span style="font-size:12px;color:#ff0055;font-family:monospace;display:block;margin-top:10px">${err}</span>`;
    }
  }
}

function initThree() {
  const container = document.getElementById('canvas-container');
  if (!container) throw new Error("Canvas container not found");

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020205); 
  scene.fog = new THREE.FogExp2(0x020205, 0.015); 

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = CAMERA_Z;

  renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false }); 
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ReinhardToneMapping;
  container.appendChild(renderer.domElement);

  // --- Post Processing ---
  const renderScene = new RenderPass(scene, camera);
  
  afterimagePass = new AfterimagePass();
  afterimagePass.uniforms['damp'].value = 0.88; 

  bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.6, 0.4, 0.1); 
  
  composer = new EffectComposer(renderer);
  composer.addPass(renderScene);
  composer.addPass(afterimagePass);
  composer.addPass(bloomPass);

  // --- Main Particle System ---
  geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  
  for(let i=0; i<PARTICLE_COUNT*3; i++) {
      originalPositions[i] = (Math.random() - 0.5) * 100;
      velocities[i] = 0; 
  }
  
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const sprite = createParticleTexture();

  material = new THREE.PointsMaterial({
    color: baseColor,
    size: PARTICLE_SIZE,
    map: sprite,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 0.9,
    vertexColors: false 
  });

  points = new THREE.Points(geometry, material);
  scene.add(points);

  // --- Targeting Reticle (Cursor) ---
  const cursorGeo = new THREE.RingGeometry(0.5, 0.6, 32);
  const cursorMat = new THREE.MeshBasicMaterial({ 
      color: 0xffffff, 
      transparent: true, 
      opacity: 0.8, 
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
  });
  cursorMesh = new THREE.Mesh(cursorGeo, cursorMat);
  cursorMesh.visible = false;
  scene.add(cursorMesh);

  // --- Starfield ---
  createStarfield();

  window.addEventListener('resize', onWindowResize);
}

function createStarfield() {
  starGeometry = new THREE.BufferGeometry();
  const starPositions = new Float32Array(STAR_COUNT * 3);
  
  for(let i=0; i<STAR_COUNT; i++) {
    const i3 = i * 3;
    starPositions[i3] = (Math.random() - 0.5) * 800; 
    starPositions[i3+1] = (Math.random() - 0.5) * 800; 
    starPositions[i3+2] = (Math.random() - 0.5) * 800; 
  }
  
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  
  starMaterial = new THREE.PointsMaterial({
    color: 0x88ccff, 
    size: 0.6,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending 
  });
  
  starPoints = new THREE.Points(starGeometry, starMaterial);
  scene.add(starPoints);
}

function createParticleTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (ctx) {
      const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, 'rgba(255,255,255,1)'); 
      grad.addColorStop(0.3, 'rgba(255,255,255,0.8)');
      grad.addColorStop(0.6, 'rgba(255,255,255,0.1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 32, 32);
  }
  return new THREE.CanvasTexture(canvas);
}

// --- Audio Logic ---
// (Kept identical to previous version, omitted for brevity but assumed included in full logic)
async function toggleAudio() {
    if (isAudioActive) {
      if (audioContext) audioContext.close();
      audioContext = null;
      isAudioActive = false;
      bassFactor = 0;
      document.getElementById('audio-btn')?.classList.remove('active');
      if (vizBarLow) resetBar(vizBarLow);
      if (vizBarMid) resetBar(vizBarMid);
      if (vizBarHigh) resetBar(vizBarHigh);
      return;
    }
  
    try {
      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8; 
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      
      dataArray = new Uint8Array(analyser.frequencyBinCount);
      isAudioActive = true;
      document.getElementById('audio-btn')?.classList.add('active');
    } catch (err) {
      console.error("Audio init failed", err);
      alert("无法访问麦克风。请确保已授予权限。");
    }
  }
  
  function updateAudioAnalysis() {
    if (!isAudioActive || !analyser || !dataArray) {
      bassFactor *= 0.95; 
      return;
    }
    
    analyser.getByteFrequencyData(dataArray);
    const bufferLength = analyser.frequencyBinCount;
    const lowCount = Math.floor(bufferLength * 0.1);
    const midCount = Math.floor(bufferLength * 0.4);
    const highCount = bufferLength - lowCount - midCount;
  
    let lowSum = 0;
    let midSum = 0;
    let highSum = 0;
  
    for (let i = 0; i < bufferLength; i++) {
        const val = dataArray[i];
        if (i < lowCount) lowSum += val;
        else if (i < lowCount + midCount) midSum += val;
        else highSum += val;
    }
  
    const lowAvg = lowCount > 0 ? lowSum / lowCount : 0;
    const midAvg = midCount > 0 ? midSum / midCount : 0;
    const highAvg = highCount > 0 ? highSum / highCount : 0;
    
    const targetBass = lowAvg / 255.0;
    bassFactor = THREE.MathUtils.lerp(bassFactor, targetBass, 0.3);
  
    if (bassFactor > 0.8) {
        shockwave = Math.min(shockwave + 0.1, 2.0);
        material.color.offsetHSL(0.01, 0, 0);
    }
  
    if (vizBarLow) updateBar(vizBarLow, lowAvg);
    if (vizBarMid) updateBar(vizBarMid, midAvg);
    if (vizBarHigh) updateBar(vizBarHigh, highAvg * 1.5); 
  }
  
  function updateBar(bar: HTMLElement, val: number) {
      const percent = Math.min(100, Math.max(15, (val / 255) * 100));
      bar.style.height = `${percent}%`;
      if (val > 140) {
          bar.style.backgroundColor = '#ff0055'; 
          bar.style.boxShadow = '0 0 10px #ff0055';
      } else {
          bar.style.backgroundColor = '#00f3ff'; 
          bar.style.boxShadow = '0 0 5px #00f3ff';
      }
  }
  
  function resetBar(bar: HTMLElement) {
      bar.style.height = '20%';
      bar.style.backgroundColor = '#00f3ff';
      bar.style.boxShadow = '0 0 5px #00f3ff';
  }

// --- Shape Generation ---

function generateShapes() {
  targets.earth = generateEarth();
  targets.heart = generateHeart();
  targets.flower = generateFlower();
  targets.saturn = generateSaturn();
  targets.buddha = generateBuddha();
  targets.galaxy = generateGalaxy(); 
  targets.dna = generateDNA();
  targets.cube = generateQuantumCube();
  targets.mobius = generateMobiusStrip();
  
  // Initialize
  const posAttr = geometry.attributes.position as THREE.BufferAttribute;
  for(let i=0; i<PARTICLE_COUNT*3; i++) {
      posAttr.array[i] = (Math.random() - 0.5) * 50;
  }
  posAttr.needsUpdate = true;
}

function generateEarth(): Float32Array {
    const arr = new Float32Array(PARTICLE_COUNT * 3);
    const radius = 14;
    for(let i=0; i<PARTICLE_COUNT; i++) {
        const i3 = i*3;
        // Evenly distributed sphere
        const phi = Math.acos(-1 + (2 * i) / PARTICLE_COUNT);
        const theta = Math.sqrt(PARTICLE_COUNT * Math.PI) * phi;
        
        // Add some noise to simulate terrain/tech blocks
        const noise = (Math.sin(phi*20) * Math.cos(theta*20)) > 0 ? 0.5 : 0;
        
        // Grid Lines effect
        const isGrid = (Math.floor(phi * 10) % 2 === 0) || (Math.floor(theta * 10) % 2 === 0);
        
        let r = radius;
        if(isGrid) r += 0.2; // Raised grid
        
        arr[i3] = r * Math.cos(theta) * Math.sin(phi);
        arr[i3+1] = r * Math.sin(theta) * Math.sin(phi);
        arr[i3+2] = r * Math.cos(phi);
    }
    return arr;
}

// Reuse existing shape generators...
function generateHeart(): Float32Array {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const t = Math.random() * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2*t) - 2 * Math.cos(3*t) - Math.cos(4*t);
    const scale = 0.8;
    const z = (Math.random() - 0.5) * 10 * (1 - Math.abs(y)/25); 
    const i3 = i * 3;
    arr[i3] = x * scale; arr[i3 + 1] = y * scale; arr[i3 + 2] = z;
  }
  return arr;
}

function generateFlower(): Float32Array {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const u = Math.random() * Math.PI * 2;
    const v = Math.random() * Math.PI;
    const k = 6; 
    const r = Math.cos(k * u) * 10 + 6;
    const x = r * Math.sin(v) * Math.cos(u);
    const y = r * Math.cos(v) * 0.8 + (Math.random()-0.5)*3; 
    const z = r * Math.sin(v) * Math.sin(u);
    const i3 = i * 3;
    arr[i3] = x; arr[i3 + 1] = y; arr[i3 + 2] = z;
  }
  return arr;
}

function generateSaturn(): Float32Array {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  const planetParticles = Math.floor(PARTICLE_COUNT * 0.4);
  for (let i = 0; i < planetParticles; i++) {
    const r = 9;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const i3 = i * 3;
    arr[i3] = r * Math.sin(phi) * Math.cos(theta);
    arr[i3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    arr[i3 + 2] = r * Math.cos(phi);
  }
  for (let i = planetParticles; i < PARTICLE_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 14 + Math.random() * 15; 
    const i3 = i * 3;
    const rX = Math.cos(angle) * dist;
    const rZ = Math.sin(angle) * dist;
    const rY = (Math.random() - 0.5) * 0.5; 
    const tilt = 0.4;
    arr[i3] = rX * Math.cos(tilt) - rY * Math.sin(tilt);
    arr[i3 + 1] = rX * Math.sin(tilt) + rY * Math.cos(tilt);
    arr[i3 + 2] = rZ;
  }
  return arr;
}

function generateBuddha(): Float32Array {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  let idx = 0;
  function addSphere(cx: number, cy: number, cz: number, r: number, count: number) {
    for (let i = 0; i < count; i++) {
      if (idx >= PARTICLE_COUNT) return;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const i3 = idx * 3;
      arr[i3] = cx + r * Math.sin(phi) * Math.cos(theta);
      arr[i3 + 1] = cy + r * Math.sin(phi) * Math.sin(theta);
      arr[i3 + 2] = cz + r * Math.cos(phi);
      idx++;
    }
  }
  addSphere(0, -6, 0, 7, PARTICLE_COUNT * 0.35); 
  addSphere(0, 2, 0, 4.5, PARTICLE_COUNT * 0.25); 
  addSphere(0, 7.5, 0, 3, PARTICLE_COUNT * 0.15); 
  addSphere(-4.5, 1, 0, 2, PARTICLE_COUNT * 0.05); 
  addSphere(4.5, 1, 0, 2, PARTICLE_COUNT * 0.05);
  while(idx < PARTICLE_COUNT) {
      const i3 = idx * 3;
      const t = Math.random() * Math.PI * 2;
      const r = 15 + Math.random() * 3;
      arr[i3] = r * Math.cos(t); arr[i3+1] = (Math.random() - 0.5) * 28; arr[i3+2] = r * Math.sin(t);
      idx++;
  }
  return arr;
}

function generateGalaxy(): Float32Array {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  const arms = 5;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const i3 = i * 3;
    const t = Math.random(); 
    const angle = t * Math.PI * 2 * 3 + (i % arms) * (Math.PI * 2 / arms);
    const radius = t * 20;
    const spread = (Math.random() - 0.5) * (5 * t); 
    
    arr[i3] = Math.cos(angle) * radius + spread;
    arr[i3 + 1] = (Math.random() - 0.5) * (3 * (1-t) + 0.5); 
    arr[i3 + 2] = Math.sin(angle) * radius + spread;
  }
  return arr;
}

function generateDNA(): Float32Array {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const i3 = i * 3;
    const type = Math.random();
    const h = (Math.random() - 0.5) * 45; 
    const t = h * 0.6; 
    const radius = 6;
    if (type < 0.4) {
      arr[i3] = Math.cos(t) * radius + (Math.random()-0.5);
      arr[i3+1] = h;
      arr[i3+2] = Math.sin(t) * radius + (Math.random()-0.5);
    } else if (type < 0.8) {
      arr[i3] = Math.cos(t + Math.PI) * radius + (Math.random()-0.5);
      arr[i3+1] = h;
      arr[i3+2] = Math.sin(t + Math.PI) * radius + (Math.random()-0.5);
    } else {
      const percent = Math.random();
      const x1 = Math.cos(t) * radius; const z1 = Math.sin(t) * radius;
      const x2 = Math.cos(t + Math.PI) * radius; const z2 = Math.sin(t + Math.PI) * radius;
      arr[i3] = x1 + (x2 - x1) * percent;
      arr[i3+1] = h;
      arr[i3+2] = z1 + (z2 - z1) * percent;
    }
  }
  return arr;
}

function generateQuantumCube(): Float32Array {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const i3 = i * 3;
    const layer = Math.random();
    let size = 10;
    if (layer < 0.2) size = 3; else if (layer < 0.5) size = 7; else size = 12;
    
    const axis = Math.floor(Math.random() * 3);
    const dir = Math.random() > 0.5 ? 1 : -1;
    
    let x = (Math.random() - 0.5) * 2 * size;
    let y = (Math.random() - 0.5) * 2 * size;
    let z = (Math.random() - 0.5) * 2 * size;
    
    if (axis === 0) x = size * dir;
    else if (axis === 1) y = size * dir;
    else z = size * dir;

    arr[i3] = x; arr[i3+1] = y; arr[i3+2] = z;
  }
  return arr;
}

function generateMobiusStrip(): Float32Array {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const i3 = i * 3;
    const u = Math.random() * Math.PI * 2; 
    const v = (Math.random() - 0.5) * 6;
    const radius = 10;
    const x = (radius + v/2 * Math.cos(u/2)) * Math.cos(u);
    const y = (radius + v/2 * Math.cos(u/2)) * Math.sin(u);
    const z = v/2 * Math.sin(u/2);
    arr[i3] = x; arr[i3+1] = y; arr[i3+2] = z;
  }
  return arr;
}

// --- Interaction Logic ---

function setupUI() {
  const shapeSelect = document.getElementById('shape-select') as HTMLSelectElement;
  if(shapeSelect) {
      shapeSelect.addEventListener('change', (e: any) => {
        currentShape = e.target.value;
        
        // Reset rotation for better UX when switching
        targetRotation.x = 0;
        targetRotation.y = 0;
        
        // Special colors for Earth
        if (currentShape === 'earth') {
             baseColor.set('#00aaff');
             const picker = document.getElementById('color-picker') as HTMLInputElement;
             if(picker) picker.value = '#00aaff';
        }
      });
  }

  const colorPicker = document.getElementById('color-picker') as HTMLInputElement;
  if(colorPicker) {
      colorPicker.addEventListener('input', (e: any) => {
        baseColor.set(e.target.value);
      });
  }
  
  const trailsToggle = document.getElementById('trails-toggle') as HTMLInputElement;
  if(trailsToggle) {
      trailsToggle.addEventListener('change', (e: any) => {
          trailsEnabled = e.target.checked;
          if (afterimagePass) {
              afterimagePass.enabled = trailsEnabled;
          }
      });
  }

  const fsBtn = document.getElementById('fullscreen-btn');
  fsBtn?.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  });

  const audioBtn = document.getElementById('audio-btn');
  audioBtn?.addEventListener('click', toggleAudio);
  
  vizBarLow = document.getElementById('bar-low');
  vizBarMid = document.getElementById('bar-mid');
  vizBarHigh = document.getElementById('bar-high');
}

function initInputListeners() {
    document.addEventListener('mousemove', (event) => {
        // Only use mouse if hand is not detected or we are not in hacker mode
        if (!isHandDetected) {
            mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
            mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
        }
    });
}

function initMediaPipe() {
  const videoElement = document.getElementById('input-video') as HTMLVideoElement;
  const trackingDot = document.getElementById('tracking-dot');
  const statusText = document.querySelector('.status-text');

  if (!window.Hands || !window.Camera) {
      console.log("MediaPipe libraries not loaded.");
      return; 
  }
  
  if (!videoElement) return;

  const hands = new window.Hands({
    locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
  });

  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.65,
    minTrackingConfidence: 0.65
  });

  hands.onResults((results: any) => {
    isHandDetected = results.multiHandLandmarks && results.multiHandLandmarks.length > 0;
    handLandmarks = results.multiHandLandmarks; // Store for global access

    if (isHandDetected) {
      if (trackingDot) trackingDot.classList.add('active');
      if (statusText) statusText.textContent = "SYSTEM: ONLINE";
      
      const hand = handLandmarks[0];
      
      // -- Hacker Mode Logic vs Standard Logic --
      
      if (currentShape === 'earth') {
          // EARTH MODE: Index finger controls cursor
          const indexTip = hand[8];
          
          // Map index tip to screen coords (cursor logic)
          // Note: MediaPipe x is 0-1 (left-right), we flip x for mirroring if needed, but standard is 0=left
          // To match ThreeJS mouse, we need -1 to 1
          const cursorX = (1 - indexTip.x) * 2 - 1; // Flip X because webcam is mirrored usually
          const cursorY = -(indexTip.y) * 2 + 1;
          
          mouse.set(cursorX, cursorY);

          // Check for Pinch (Thumb 4 and Index 8)
          const thumb = hand[4];
          const dist = Math.sqrt(Math.pow(thumb.x - indexTip.x, 2) + Math.pow(thumb.y - indexTip.y, 2));
          isPinching = dist < 0.05;

      } else {
          // CLASSIC MODE: Palm center rotation
          const centerX = hand[9].x; 
          const centerY = hand[9].y;
          const navX = (centerX - 0.5) * 2; 
          const navY = (centerY - 0.5) * 2;
          targetRotation.y = navX * 1.5; 
          targetRotation.x = navY * 1.5;
          mouse.set(-999, -999); // Hide cursor interaction
      }

      // Universal Zoom (Two Hands)
      if (handLandmarks.length === 2) {
        const h1 = handLandmarks[0][8]; 
        const h2 = handLandmarks[1][8];
        const dx = h1.x - h2.x;
        const dy = h1.y - h2.y;
        const distance = Math.sqrt(dx*dx + dy*dy);
        targetScale = THREE.MathUtils.mapLinear(distance, 0.1, 0.8, 0.5, 4.0);
      }
      
    } else {
      if (trackingDot) trackingDot.classList.remove('active');
      if (statusText) statusText.textContent = "NEURAL_LINK: SCANNING";
      targetRotation.x = 0;
      targetRotation.y = 0;
      isPinching = false;
    }
  });

  try {
      const cameraUtils = new window.Camera(videoElement, {
        onFrame: async () => {
          await hands.send({image: videoElement});
        },
        width: 320,
        height: 240
      });
      cameraUtils.start().catch((e: any) => console.warn("Camera start failed", e));
  } catch (e) {
      console.warn("Camera instantiation failed", e);
  }
}

// --- Data Popup Logic ---

function showHackerData(x: number, y: number) {
    const overlay = document.getElementById('hacker-overlay');
    if (!overlay) return;

    // Convert normalized device coords to screen pixels
    // x, y are -1 to 1
    const screenX = (x * 0.5 + 0.5) * window.innerWidth;
    const screenY = -(y * 0.5 - 0.5) * window.innerHeight;

    const el = document.createElement('div');
    el.className = 'data-card';
    el.style.left = `${screenX + 20}px`;
    el.style.top = `${screenY - 20}px`;

    // Generate random hacker data
    const lat = (Math.random() * 180 - 90).toFixed(4);
    const lon = (Math.random() * 360 - 180).toFixed(4);
    const ip = `192.168.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
    const pop = Math.floor(Math.random() * 10000000).toLocaleString();

    el.innerHTML = `
        <h3>TARGET LOCKED</h3>
        <div class="data-line"><span>LAT:</span> <span style="color:#00f3ff">${lat}</span></div>
        <div class="data-line"><span>LON:</span> <span style="color:#00f3ff">${lon}</span></div>
        <div class="data-line"><span>IP:</span> <span>${ip}</span></div>
        <div class="data-line"><span>POP:</span> <span>${pop}</span></div>
        <div class="data-line blinking-cursor">ANALYZING</div>
    `;

    overlay.appendChild(el);

    // Remove after 3 seconds
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'scale(0.9)';
        setTimeout(() => el.remove(), 300);
    }, 3000);
}


// --- Animation Loop ---

function animate() {
  requestAnimationFrame(animate);

  time += 0.01;
  shockwave *= 0.95; 
  updateAudioAnalysis();

  // --- Scale Physics ---
  let effectiveScale = currentScale;
  if (!isHandDetected) {
    const breathe = 1.0 + Math.sin(time * 0.8) * 0.1;
    currentScale = THREE.MathUtils.lerp(currentScale, breathe, 0.05);
  } else {
    currentScale = THREE.MathUtils.lerp(currentScale, targetScale, 0.1);
  }
  effectiveScale += (bassFactor * 0.5) + (shockwave * 0.5);

  // --- Rotation Physics ---
  // In Earth mode, rotation is manually controlled by dragging, otherwise auto spin
  if (currentShape === 'earth' && isHandDetected && handLandmarks.length === 2) {
      // Two hand rotation control (Tilt)
      const h1 = handLandmarks[0][8]; 
      const h2 = handLandmarks[1][8];
      const cx = (h1.x + h2.x) / 2;
      const tilt = (cx - 0.5) * 3;
      currentRotation.y += tilt * 0.05; 
  } else {
      currentRotation.x = THREE.MathUtils.lerp(currentRotation.x, targetRotation.x, 0.08);
      currentRotation.y = THREE.MathUtils.lerp(currentRotation.y, targetRotation.y + time * 0.05, 0.08);
  }
  
  if (points) {
      points.rotation.x = currentRotation.x;
      points.rotation.y = currentRotation.y;
  }

  // --- Physics & Raycasting ---

  // Clear grid
  gridHead.fill(-1);

  const posAttr = geometry ? geometry.attributes.position as THREE.BufferAttribute : null;
  if (!posAttr) return; 
  
  const targetPositions = targets[currentShape] || targets.heart;
  
  // Raycaster Logic for Hacker Mode
  if (camera && cursorMesh) {
      // Update raycaster from mouse/hand
      raycaster.setFromCamera(mouse, camera);
      
      // Update Cursor Mesh Position
      const vector = new THREE.Vector3(mouse.x, mouse.y, 0.5);
      vector.unproject(camera);
      const dir = vector.sub(camera.position).normalize();
      const distance = 40; // Arbitrary distance in front
      const cursorTarget = camera.position.clone().add(dir.multiplyScalar(distance));
      
      cursorMesh.position.lerp(cursorTarget, 0.2);
      cursorMesh.lookAt(camera.position);

      // Visibility based on mode
      cursorMesh.visible = (currentShape === 'earth' && isHandDetected);
      
      // Interaction Plane intersection for repulsion
      const distanceToPlane = (0 - raycaster.ray.origin.z) / raycaster.ray.direction.z;
      const interactPoint = new THREE.Vector3().copy(raycaster.ray.origin).add(raycaster.ray.direction.multiplyScalar(distanceToPlane));

      // Click / Pinch Detection
      if (currentShape === 'earth' && isHandDetected) {
           // Check if we hit the sphere "surface" (roughly)
           // Since particles are points, exact intersection is hard. We check distance to center (0,0,0)
           // Ray-Sphere intersection approximation
           const sphereRadius = 14 * effectiveScale;
           const rayOrigin = raycaster.ray.origin;
           const rayDir = raycaster.ray.direction;
           
           // Simple ray-sphere intersection check
           const b = 2 * (rayDir.x * rayOrigin.x + rayDir.y * rayOrigin.y + rayDir.z * rayOrigin.z);
           const c = rayOrigin.lengthSq() - sphereRadius * sphereRadius;
           const delta = b*b - 4*c;
           
           if (delta > 0) {
               // Hit!
               (cursorMesh.material as THREE.MeshBasicMaterial).color.setHex(0xff0055); // Red when hovering object
               
               if (isPinching) {
                   if (!pinchTriggered) {
                       pinchTriggered = true;
                       shockwave = 0.5; // Visual feedback
                       showHackerData(mouse.x, mouse.y);
                   }
               } else {
                   pinchTriggered = false;
               }
           } else {
               (cursorMesh.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
               pinchTriggered = false;
           }
      }

      // --- Particle Physics Loop ---
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const i3 = i * 3;
        
        const px = posAttr.array[i3];
        const py = posAttr.array[i3+1];
        const pz = posAttr.array[i3+2];
        
        let tx = targetPositions[i3] * effectiveScale;
        let ty = targetPositions[i3 + 1] * effectiveScale;
        let tz = targetPositions[i3 + 2] * effectiveScale;

        // Scanning Effect for Earth
        if (currentShape === 'earth') {
             const scanH = Math.sin(time * 2) * 15 * effectiveScale;
             if (Math.abs(py - scanH) < 1.0) {
                 // Highlight scan line
                 // We can't easily change color per vertex without a color attribute,
                 // but we can jitter them to make them "glow"
                 tx += (Math.random()-0.5) * 0.5;
                 tz += (Math.random()-0.5) * 0.5;
             }
        }

        // A. Spring Force
        const k = 0.03; 
        const fx = (tx - px) * k;
        const fy = (ty - py) * k;
        const fz = (tz - pz) * k;
        
        // B. Mouse Repulsion / Attraction
        let rx = 0, ry = 0, rz = 0;
        const dx = px - interactPoint.x;
        const dy = py - interactPoint.y;
        const distSq = dx*dx + dy*dy;
        
        // In Earth mode, we don't want repulsion, we want stability or attraction to cursor
        if (currentShape !== 'earth' && distSq < 150 && mouse.x > -100) {
            const dist = Math.sqrt(distSq);
            const force = (12 - dist) / 12;
            if (force > 0) {
                const angle = Math.atan2(dy, dx);
                const strength = 1.2 * force; 
                rx = Math.cos(angle) * strength;
                ry = Math.sin(angle) * strength;
            }
        }

        // C. Audio Jitter
        let ax = 0, ay = 0, az = 0;
        if (shockwave > 0.1) {
            ax = (Math.random() - 0.5) * shockwave * 2;
            ay = (Math.random() - 0.5) * shockwave * 2;
            az = (Math.random() - 0.5) * shockwave * 2;
        }

        velocities[i3] += fx + rx + ax;
        velocities[i3+1] += fy + ry + ay;
        velocities[i3+2] += fz + rz + az;

        velocities[i3] *= 0.92;
        velocities[i3+1] *= 0.92;
        velocities[i3+2] *= 0.92;

        posAttr.array[i3] += velocities[i3];
        posAttr.array[i3+1] += velocities[i3+1];
        posAttr.array[i3+2] += velocities[i3+2];

        // Spatial Grid Insert
        if (physicsEnabled) {
            const gx = Math.floor((posAttr.array[i3] + GRID_OFFSET) / CELL_SIZE);
            const gy = Math.floor((posAttr.array[i3+1] + GRID_OFFSET) / CELL_SIZE);
            const gz = Math.floor((posAttr.array[i3+2] + GRID_OFFSET) / CELL_SIZE);
            
            if (gx >= 0 && gx < GRID_DIM && gy >= 0 && gy < GRID_DIM && gz >= 0 && gz < GRID_DIM) {
                const cellIndex = gx + gy * GRID_DIM + gz * GRID_DIM * GRID_DIM;
                gridNext[i] = gridHead[cellIndex];
                gridHead[cellIndex] = i;
            } else {
                gridNext[i] = -1;
            }
        }
      }
  }

  // 4. Collision Resolution
  if (physicsEnabled && posAttr) {
      const minSq = COLLISION_RADIUS * COLLISION_RADIUS;
      
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const i3 = i * 3;
        const px = posAttr.array[i3];
        const py = posAttr.array[i3+1];
        const pz = posAttr.array[i3+2];

        const gx = Math.floor((px + GRID_OFFSET) / CELL_SIZE);
        const gy = Math.floor((py + GRID_OFFSET) / CELL_SIZE);
        const gz = Math.floor((pz + GRID_OFFSET) / CELL_SIZE);

        if (gx >= 0 && gx < GRID_DIM && gy >= 0 && gy < GRID_DIM && gz >= 0 && gz < GRID_DIM) {
             const cellIndex = gx + gy * GRID_DIM + gz * GRID_DIM * GRID_DIM;
             
             let neighbor = gridHead[cellIndex];
             let checks = 0;
             
             while (neighbor !== -1 && checks < 8) { 
                 if (neighbor !== i) {
                     const n3 = neighbor * 3;
                     const nx = posAttr.array[n3];
                     const ny = posAttr.array[n3+1];
                     const nz = posAttr.array[n3+2];

                     const dx = px - nx;
                     const dy = py - ny;
                     const dz = pz - nz;
                     const d2 = dx*dx + dy*dy + dz*dz;

                     if (d2 > 0 && d2 < minSq) {
                         const dist = Math.sqrt(d2);
                         const penetration = COLLISION_RADIUS - dist;
                         
                         const nx_norm = dx / dist;
                         const ny_norm = dy / dist;
                         const nz_norm = dz / dist;

                         const separateFactor = 0.5; 
                         const sx = nx_norm * penetration * separateFactor;
                         const sy = ny_norm * penetration * separateFactor;
                         const sz = nz_norm * penetration * separateFactor;

                         posAttr.array[i3] += sx;
                         posAttr.array[i3+1] += sy;
                         posAttr.array[i3+2] += sz;
                         
                         posAttr.array[n3] -= sx;
                         posAttr.array[n3+1] -= sy;
                         posAttr.array[n3+2] -= sz;
                     }
                 }
                 neighbor = gridNext[neighbor];
                 checks++;
             }
        }
      }
  }
  
  if (posAttr) posAttr.needsUpdate = true;

  // Update Starfield
  if (starGeometry) {
      const starPos = starGeometry.attributes.position as THREE.BufferAttribute;
      for(let i=0; i<STAR_COUNT; i++) {
          const i3 = i*3;
          let z = starPos.array[i3+2];
          const speed = 0.8 + (bassFactor * 5.0) + (shockwave * 8.0); 
          z += speed;
          if (z > 50) z = -750;
          starPos.array[i3+2] = z;
      }
      starPos.needsUpdate = true;
  }

  // Camera Shake
  if (camera) {
      if (shockwave > 0.5) {
          camera.position.x = (Math.random() - 0.5) * shockwave;
          camera.position.y = (Math.random() - 0.5) * shockwave;
      } else {
          camera.position.x = 0;
          camera.position.y = 0;
      }
  }

  // Color & Bloom Intensity
  if (material) {
     const hueOffset = (time * 0.05) % 1; 
     const hsl = { h: 0, s: 0, l: 0 };
     baseColor.getHSL(hsl);
     const finalHue = (hsl.h + hueOffset) % 1;
     const dynamicColor = new THREE.Color().setHSL(finalHue, 0.9, 0.6); 
     
     material.color.lerp(dynamicColor, 0.1);
     
     const pulse = Math.sin(time * 1.5) * 0.5 + Math.sin(time * 3.5) * 0.2;
     material.size = PARTICLE_SIZE + (pulse * 0.02) + (bassFactor * 0.1);
     material.opacity = THREE.MathUtils.clamp(0.85 + (pulse * 0.1), 0.5, 1.0);

     if (bloomPass) {
         bloomPass.strength = 1.5 + (bassFactor * 2.0) + (shockwave * 3.0);
     }
  }

  if (composer) composer.render();
}

function onWindowResize() {
  if (camera && renderer && composer) {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    bloomPass.resolution.set(window.innerWidth, window.innerHeight);
  }
}

// Start
init();

export {};
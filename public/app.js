import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const canvas = document.getElementById('universeCanvas');
const scenePanel = canvas.parentElement;
const statusEl = document.getElementById('status');
const planetListEl = document.getElementById('planetList');
const reloadBtn = document.getElementById('reloadBtn');
const hoverCardEl = document.getElementById('planetHoverCard');
const fingerToggleBtn = document.getElementById('fingerToggleBtn');
const fingerStatusEl = document.getElementById('fingerStatus');
const cameraPreviewEl = document.getElementById('cameraPreview');
const fingerCursorEl = document.getElementById('fingerCursor');
const handOverlayEl = document.getElementById('handOverlay');
const handOverlayCtx = handOverlayEl.getContext('2d');

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x020611, 0.008);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(scenePanel.clientWidth, scenePanel.clientHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const camera = new THREE.PerspectiveCamera(52, scenePanel.clientWidth / scenePanel.clientHeight, 0.1, 300);
camera.position.set(0, 18, 34);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxDistance = 150;
controls.minDistance = 5;
controls.maxPolarAngle = Math.PI * 0.48;
controls.target.set(0, 0, 0);

const ambientLight = new THREE.AmbientLight(0x89c2ff, 0.72);
scene.add(ambientLight);

const hemiLight = new THREE.HemisphereLight(0xaed8ff, 0x0d1d3e, 0.35);
scene.add(hemiLight);

const sunLight = new THREE.PointLight(0xffd17e, 2.1, 220);
sunLight.position.set(0, 0, 0);
scene.add(sunLight);

const starsGeometry = new THREE.BufferGeometry();
const starCount = 2800;
const positions = new Float32Array(starCount * 3);

for (let i = 0; i < starCount; i += 1) {
  positions[i * 3] = (Math.random() - 0.5) * 260;
  positions[i * 3 + 1] = (Math.random() - 0.5) * 260;
  positions[i * 3 + 2] = (Math.random() - 0.5) * 260;
}

starsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

const stars = new THREE.Points(
  starsGeometry,
  new THREE.PointsMaterial({ color: 0xd8ecff, size: 0.25, transparent: true, opacity: 0.9 })
);
scene.add(stars);

const sun = new THREE.Mesh(
  new THREE.SphereGeometry(3.5, 48, 48),
  new THREE.MeshBasicMaterial({ color: 0xffc857 })
);
scene.add(sun);

const orbitMaterial = new THREE.LineBasicMaterial({ color: 0x2e6ea4, transparent: true, opacity: 0.45 });
const exoplanetGroup = new THREE.Group();
scene.add(exoplanetGroup);

const exoplanetBodies = [];
const meshBodyMap = new Map();
const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();

let hoveredBody = null;
let selectedBody = null;
let fingerEnabled = false;
let pinchLatched = false;
let handTracker = null;
let mediaStream = null;
let handLoopRequestId = null;
let previousPinchDistance = null;
let smoothedFingerX = null;
let smoothedFingerY = null;
let previousSteerX = null;
let previousSteerY = null;
let handSendInFlight = false;
let consecutiveTrackingErrors = 0;

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17]
];

const orbitingBodies = [
  { name: 'Mercury', radius: 0.45, distance: 6.5, speed: 0.022, color: 0xb4a69c },
  { name: 'Venus', radius: 0.8, distance: 9, speed: 0.017, color: 0xe5b870 },
  { name: 'Earth', radius: 0.88, distance: 11.5, speed: 0.012, color: 0x4ab3ff },
  { name: 'Mars', radius: 0.65, distance: 14.5, speed: 0.0095, color: 0xd07a55 },
  { name: 'Jupiter', radius: 1.9, distance: 18.5, speed: 0.0065, color: 0xe6bf88 },
  { name: 'Saturn', radius: 1.6, distance: 22.5, speed: 0.005, color: 0xf2cf9d },
  { name: 'Uranus', radius: 1.2, distance: 26, speed: 0.004, color: 0x8ed9da },
  { name: 'Neptune', radius: 1.15, distance: 29.5, speed: 0.0032, color: 0x4d78d8 }
].map((body) => {
  const material = new THREE.MeshStandardMaterial({
    color: body.color,
    roughness: 0.8,
    metalness: 0.1,
    emissive: 0x16324d,
    emissiveIntensity: 0.08
  });

  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(body.radius, 32, 32),
    material
  );

  const orbitCurve = new THREE.EllipseCurve(0, 0, body.distance, body.distance);
  const points = orbitCurve.getPoints(120).map((point) => new THREE.Vector3(point.x, 0, point.y));
  const orbit = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), orbitMaterial);

  scene.add(planet);
  scene.add(orbit);

  if (body.name === 'Saturn') {
    const rings = new THREE.Mesh(
      new THREE.RingGeometry(2.1, 3.2, 64),
      new THREE.MeshBasicMaterial({ color: 0xcaa66f, side: THREE.DoubleSide, transparent: true, opacity: 0.65 })
    );
    rings.rotation.x = Math.PI / 2.8;
    planet.add(rings);
  }

  const angle = Math.random() * Math.PI * 2;
  planet.position.set(
    Math.cos(angle) * body.distance,
    0,
    Math.sin(angle) * body.distance
  );

  const bodyData = {
    ...body,
    mesh: planet,
    angle,
    targetScale: 1,
    targetEmissive: 0.08,
    metadata: { name: body.name, mass: null, radius: null, temperature: null, period: null, semi_major_axis: null, distance_light_year: null }
  };

  meshBodyMap.set(planet, bodyData);
  return bodyData;
});

const solarBodies = orbitingBodies;

function formatNumber(value, digits = 2) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Unknown';
  return value.toFixed(digits);
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function exoplanetColorFromTemperature(temperature) {
  const temp = numberOrNull(temperature);
  if (temp === null) return new THREE.Color(0x7ec8ff);
  if (temp < 450) return new THREE.Color(0x6dc1ff);
  if (temp < 900) return new THREE.Color(0x7ee8b3);
  if (temp < 1500) return new THREE.Color(0xffcf78);
  return new THREE.Color(0xff8f70);
}

function exoplanetRadius(planet) {
  const apiRadius = numberOrNull(planet.radius);
  const apiMass = numberOrNull(planet.mass);
  if (apiRadius !== null) return THREE.MathUtils.clamp(apiRadius * 0.38, 0.16, 0.75);
  if (apiMass !== null) return THREE.MathUtils.clamp(Math.cbrt(apiMass) * 0.22, 0.14, 0.65);
  return 0.2;
}

function median(values, fallback) {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return fallback;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function buildPlanetStats(planets) {
  return {
    mass: median(planets.map((planet) => planet.mass), 1.1),
    radius: median(planets.map((planet) => planet.radius), 1),
    temperature: median(planets.map((planet) => planet.temperature), 750),
    period: median(planets.map((planet) => planet.period), 240),
    semi_major_axis: median(planets.map((planet) => planet.semi_major_axis), 1),
    distance_light_year: median(planets.map((planet) => planet.distance_light_year), 120),
    host_star_mass: median(planets.map((planet) => planet.host_star_mass), 1),
    host_star_temperature: median(planets.map((planet) => planet.host_star_temperature), 5600)
  };
}

function enrichPlanetData(planet, stats) {
  let { mass, radius, period, semi_major_axis: semiMajorAxis, temperature, distance_light_year: distanceLy, host_star_mass: hostStarMass, host_star_temperature: hostStarTemperature } = planet;
  
  mass = numberOrNull(mass); radius = numberOrNull(radius); period = numberOrNull(period); semiMajorAxis = numberOrNull(semiMajorAxis); temperature = numberOrNull(temperature); distanceLy = numberOrNull(distanceLy);
  hostStarMass = numberOrNull(hostStarMass) ?? stats.host_star_mass;
  hostStarTemperature = numberOrNull(hostStarTemperature) ?? stats.host_star_temperature;

  if (radius === null && mass !== null) radius = THREE.MathUtils.clamp(Math.sqrt(Math.max(mass, 0.03)) * 0.92, 0.2, 2.3);
  if (mass === null && radius !== null) mass = THREE.MathUtils.clamp(Math.pow(Math.max(radius, 0.15), 1.8), 0.05, 12);
  if (period === null && semiMajorAxis !== null && hostStarMass) period = Math.sqrt(Math.pow(Math.max(semiMajorAxis, 0.01), 3) / Math.max(hostStarMass, 0.05)) * 365.25;
  if (semiMajorAxis === null && period !== null && hostStarMass) semiMajorAxis = Math.pow(Math.max(period / 365.25, 0.01) * Math.max(period / 365.25, 0.01) * Math.max(hostStarMass, 0.05), 1 / 3);
  if (temperature === null) temperature = semiMajorAxis !== null ? (278 * (hostStarTemperature / 5778)) / Math.sqrt(Math.max(semiMajorAxis, 0.04)) : stats.temperature;

  return {
    ...planet,
    mass: mass ?? stats.mass,
    radius: radius ?? stats.radius,
    period: period ?? stats.period,
    semi_major_axis: semiMajorAxis ?? stats.semi_major_axis,
    temperature: temperature,
    distance_light_year: distanceLy ?? stats.distance_light_year
  };
}

function hideHoverCard() { hoverCardEl.classList.add('is-hidden'); }

function showHoverCard(metadata, clientX, clientY) {
  hoverCardEl.classList.remove('is-hidden');
  hoverCardEl.innerHTML = `
    <p class="planet-hover-title">${metadata.name || 'Unnamed Planet'}</p>
    <p class="planet-hover-meta">
      <span>Mass: ${formatNumber(metadata.mass)} Jupters</span>
      <span>Radius: ${formatNumber(metadata.radius)} Jupiters</span>
      <span>Temp: ${formatNumber(metadata.temperature, 0)} K</span>
    </p>
  `;
  const panelRect = scenePanel.getBoundingClientRect();
  const left = THREE.MathUtils.clamp(clientX - panelRect.left + 18, 10, panelRect.width - hoverCardEl.offsetWidth - 10);
  const top = THREE.MathUtils.clamp(clientY - panelRect.top + 18, 10, panelRect.height - hoverCardEl.offsetHeight - 10);
  hoverCardEl.style.left = `${left}px`;
  hoverCardEl.style.top = `${top}px`;
}

function showLockedCard(metadata) {
  hoverCardEl.classList.remove('is-hidden');
  hoverCardEl.innerHTML = `<p class="planet-hover-title">${metadata.name || 'Unnamed Planet'} (Selected)</p>`;
  hoverCardEl.style.left = `${Math.max(10, scenePanel.clientWidth - hoverCardEl.offsetWidth - 12)}px`;
  hoverCardEl.style.top = '12px';
}

function applyBodyFocusTargets() {
  [...solarBodies, ...exoplanetBodies].forEach((body) => { body.targetScale = 1; body.targetEmissive = 0.08; });
  if (hoveredBody) { hoveredBody.targetScale = 2.5; hoveredBody.targetEmissive = 0.55; }
  if (selectedBody) { selectedBody.targetScale = 3.8; selectedBody.targetEmissive = 1.0; }
}

function setSelectedBody(nextBody) {
  selectedBody = nextBody;
  applyBodyFocusTargets();
  if (selectedBody) showLockedCard(selectedBody.metadata);
  else if (!hoveredBody) hideHoverCard();
}

function setHoveredBody(nextBody) {
  if (hoveredBody === nextBody) return;
  hoveredBody = nextBody;
  if (!hoveredBody && !selectedBody) hideHoverCard();
  applyBodyFocusTargets();
}

function intersectPlanet(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const meshes = [...solarBodies, ...exoplanetBodies].map((body) => body.mesh);
  const intersects = raycaster.intersectObjects(meshes, false);

  if (!intersects.length) {
    setHoveredBody(null);
    if (selectedBody) showLockedCard(selectedBody.metadata);
    return;
  }

  const nextBody = meshBodyMap.get(intersects[0].object) || null;
  setHoveredBody(nextBody);
  if (nextBody) {
    if (selectedBody === nextBody) showLockedCard(selectedBody.metadata);
    else showHoverCard(nextBody.metadata, clientX, clientY);
  }
}

function clearExoplanets() {
  if (exoplanetBodies.includes(hoveredBody)) hoveredBody = null;
  if (exoplanetBodies.includes(selectedBody)) selectedBody = null;
  exoplanetBodies.forEach((body) => meshBodyMap.delete(body.mesh));
  exoplanetBodies.length = 0;
  applyBodyFocusTargets();
  while (exoplanetGroup.children.length) {
    const mesh = exoplanetGroup.children.pop();
    mesh.geometry.dispose(); mesh.material.dispose();
  }
}

function rebuildExoplanets(planets) {
  clearExoplanets();
  planets.forEach((planet, index) => {
    const radius = exoplanetRadius(planet);
    const color = exoplanetColorFromTemperature(planet.temperature);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 20), new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.08, emissive: color.clone().multiplyScalar(0.24), emissiveIntensity: 0.12 }));
    
    const ringIndex = index % 60; const ringLayer = Math.floor(index / 60);
    const distance = 34 + ringIndex * 0.62 + ringLayer * 2.8;
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.0013 + (60 - ringIndex) * 0.00001;
    const yRange = 0.2 + (index % 5) * 0.08;
    const spin = 0.003 + Math.random() * 0.01;

    mesh.position.set(Math.cos(angle) * distance, Math.sin(angle * 1.9) * yRange, Math.sin(angle) * distance);

    const bodyData = { mesh, angle, distance, speed, yRange, spin, targetScale: 1, targetEmissive: 0.08, metadata: { name: planet.name, mass: planet.mass, radius: planet.radius, temperature: planet.temperature } };
    exoplanetGroup.add(mesh); exoplanetBodies.push(bodyData); meshBodyMap.set(mesh, bodyData);
  });
}

function planetCard(planet, index) {
  const li = document.createElement('li');
  li.style.animationDelay = `${Math.min(index * 35, 360)}ms`;
  li.innerHTML = `<p class="planet-name">${planet.name || 'Unnamed'}</p>`;
  return li;
}

function animate() {
  requestAnimationFrame(animate);
  const time = performance.now() * 0.001;

  sun.rotation.y += 0.0028; stars.rotation.y += 0.00035;

  [...orbitingBodies, ...exoplanetBodies].forEach((body) => {
    body.angle += body.speed;
    const yPos = body.yRange ? Math.sin(body.angle * 1.9) * body.yRange : 0;
    body.mesh.position.set(Math.cos(body.angle) * body.distance, yPos, Math.sin(body.angle) * body.distance);
    body.mesh.rotation.y += body.spin || 0.015;

    const pulse = selectedBody === body ? 1 + Math.sin(time * 8) * 0.08 : 1;
    body.mesh.scale.setScalar(THREE.MathUtils.lerp(body.mesh.scale.x, body.targetScale * pulse, 0.28));
    if (body.mesh.material.emissiveIntensity !== undefined) {
      body.mesh.material.emissiveIntensity = THREE.MathUtils.lerp(body.mesh.material.emissiveIntensity, body.targetEmissive, 0.2);
    }
  });

  if (selectedBody && previousSteerX === null) {
    controls.target.lerp(selectedBody.mesh.position, 0.07);
  }

  controls.update();
  renderer.render(scene, camera);
}

function clearHandOverlay() { handOverlayCtx.clearRect(0, 0, handOverlayEl.width, handOverlayEl.height); }

function drawHandOverlay(landmarks) {
  clearHandOverlay();
  if (!landmarks || !landmarks.length) return;

  const width = handOverlayEl.width; const height = handOverlayEl.height;
  handOverlayCtx.lineWidth = 2; handOverlayCtx.strokeStyle = 'rgba(102, 231, 255, 0.9)'; handOverlayCtx.fillStyle = 'rgba(182, 244, 255, 0.85)';

  HAND_CONNECTIONS.forEach(([a, b]) => {
    if (!landmarks[a] || !landmarks[b]) return;
    handOverlayCtx.beginPath();
    handOverlayCtx.moveTo((1 - landmarks[a].x) * width, landmarks[a].y * height);
    handOverlayCtx.lineTo((1 - landmarks[b].x) * width, landmarks[b].y * height);
    handOverlayCtx.stroke();
  });

  landmarks.forEach((point, index) => {
    handOverlayCtx.beginPath();
    handOverlayCtx.arc((1 - point.x) * width, point.y * height, index === 8 ? 5 : 3, 0, Math.PI * 2);
    handOverlayCtx.fill();
  });
}

function isFingerExtended(landmarks, tipIndex, pipIndex) {
  return landmarks[tipIndex].y < landmarks[pipIndex].y;
}

function steerCamera(deltaX, deltaY) {
  setSelectedBody(null);
  const panSpeed = 0.05; 
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  camera.matrix.extractBasis(right, up, new THREE.Vector3());

  const panVector = new THREE.Vector3()
    .addScaledVector(right, -deltaX * panSpeed)
    .addScaledVector(up, deltaY * panSpeed);

  camera.position.add(panVector);
  controls.target.add(panVector);
}

function zoomCamera(amount) {
  setSelectedBody(null); 
  const offset = camera.position.clone().sub(controls.target);
  let distance = offset.length() + amount;
  distance = THREE.MathUtils.clamp(distance, controls.minDistance, controls.maxDistance);
  offset.normalize().multiplyScalar(distance);
  camera.position.copy(controls.target.clone().add(offset));
}

function onHandResults(results) {
  if (!fingerEnabled) return;
  const landmarks = results.multiHandLandmarks?.[0];

  if (!landmarks) {
    pinchLatched = false; previousPinchDistance = null; smoothedFingerX = null; smoothedFingerY = null;
    previousSteerX = null; previousSteerY = null;
    fingerStatusEl.textContent = 'No hand detected.';
    fingerCursorEl.classList.add('is-hidden');
    clearHandOverlay();
    if (!selectedBody) setHoveredBody(null);
    return;
  }

  drawHandOverlay(landmarks);

  const panelRect = scenePanel.getBoundingClientRect();
  const indexTip = landmarks[8]; const middleTip = landmarks[12]; const thumbTip = landmarks[4];
  
  const rawClientX = panelRect.left + (1 - indexTip.x) * panelRect.width;
  const rawClientY = panelRect.top + indexTip.y * panelRect.height;

  if (smoothedFingerX === null) { smoothedFingerX = rawClientX; smoothedFingerY = rawClientY; } 
  else {
    const alpha = 0.15;
    smoothedFingerX += (rawClientX - smoothedFingerX) * alpha;
    smoothedFingerY += (rawClientY - smoothedFingerY) * alpha;
  }

  const indexExtended = isFingerExtended(landmarks, 8, 6);
  const middleExtended = isFingerExtended(landmarks, 12, 10);
  const ringExtended = isFingerExtended(landmarks, 16, 14);
  const pinkyExtended = isFingerExtended(landmarks, 20, 18);

  const steeringGestureActive = indexExtended && middleExtended && !ringExtended && !pinkyExtended;

  if (steeringGestureActive) {
    fingerCursorEl.classList.add('is-hidden'); 
    
    const rawSteerX = panelRect.left + (1 - ((indexTip.x + middleTip.x) * 0.5)) * panelRect.width;
    const rawSteerY = panelRect.top + ((indexTip.y + middleTip.y) * 0.5) * panelRect.height;

    if (previousSteerX !== null && previousSteerY !== null) {
      const deltaX = rawSteerX - previousSteerX;
      const deltaY = rawSteerY - previousSteerY;
      const deadzone = 6.0; 

      if (Math.abs(deltaX) > deadzone || Math.abs(deltaY) > deadzone) {
        steerCamera(deltaX, deltaY);
        previousSteerX = rawSteerX;
        previousSteerY = rawSteerY;
      }
    } else {
      previousSteerX = rawSteerX;
      previousSteerY = rawSteerY;
    }

    fingerStatusEl.textContent = 'Steering: Moving display Left/Right/Up/Down.';
    previousPinchDistance = null; pinchLatched = false;
    return; 
  }

  previousSteerX = null; previousSteerY = null;
  fingerCursorEl.classList.remove('is-hidden');
  fingerCursorEl.style.left = `${THREE.MathUtils.clamp(smoothedFingerX - panelRect.left, 0, panelRect.width)}px`;
  fingerCursorEl.style.top = `${THREE.MathUtils.clamp(smoothedFingerY - panelRect.top, 0, panelRect.height)}px`;
  
  intersectPlanet(smoothedFingerX, smoothedFingerY);

  const pinchDistance = Math.hypot(indexTip.x - thumbTip.x, indexTip.y - thumbTip.y, indexTip.z - thumbTip.z);
  const isPinching = pinchDistance < 0.04; 

  let gestureMessage = isPinching ? 'Picking...' : '1 Finger: Pick. 2 Fingers: Move Display. Spread/Close: Zoom';

  if (previousPinchDistance !== null && !steeringGestureActive) {
    const pinchDelta = pinchDistance - previousPinchDistance;
    if (Math.abs(pinchDelta) > 0.0015) {
      zoomCamera(-pinchDelta * 200); 
      gestureMessage = pinchDelta > 0 ? 'Zooming Bigger...' : 'Zooming Smaller...';
    }
  }

  fingerStatusEl.textContent = gestureMessage;

  if (isPinching && !pinchLatched) {
    setSelectedBody(hoveredBody || null);
    pinchLatched = true;
  }
  if (!isPinching) pinchLatched = false;

  previousPinchDistance = pinchDistance;
}

async function enableFingerControl() {
  if (!navigator.mediaDevices?.getUserMedia) { fingerStatusEl.textContent = 'Webcam unavailable.'; return; }
  const HandsCtor = window.Hands || globalThis.Hands;
  if (!HandsCtor) { fingerStatusEl.textContent = 'Hand tracking library missing.'; return; }

  handTracker = new HandsCtor({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
  handTracker.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });
  handTracker.onResults(onHandResults);

  mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  cameraPreviewEl.srcObject = mediaStream;
  await cameraPreviewEl.play();
  
  onResize();
  fingerEnabled = true; consecutiveTrackingErrors = 0; handSendInFlight = false;

  const runHandLoop = async () => {
    if (!fingerEnabled || !handTracker) return;
    try {
      if (mediaStream?.getVideoTracks?.()[0]?.readyState !== 'live') throw new Error('Webcam ended.');
      if (cameraPreviewEl.readyState >= 2 && !handSendInFlight) {
        handSendInFlight = true;
        await handTracker.send({ image: cameraPreviewEl });
        handSendInFlight = false; consecutiveTrackingErrors = 0;
      }
    } catch (e) {
      handSendInFlight = false; consecutiveTrackingErrors++;
      if (consecutiveTrackingErrors > 8) return disableFingerControl(`Stopped: ${e.message}`);
    }
    handLoopRequestId = requestAnimationFrame(runHandLoop);
  };
  runHandLoop();
  fingerToggleBtn.textContent = 'Disable Finger Control';
}

function disableFingerControl(msg = 'Finger control is off.') {
  fingerEnabled = false; pinchLatched = false; previousPinchDistance = null; smoothedFingerX = null; smoothedFingerY = null;
  previousSteerX = null; previousSteerY = null; handSendInFlight = false; consecutiveTrackingErrors = 0;
  fingerCursorEl.classList.add('is-hidden'); clearHandOverlay(); setHoveredBody(null);
  if (handLoopRequestId) cancelAnimationFrame(handLoopRequestId); handLoopRequestId = null;
  mediaStream?.getTracks().forEach((t) => t.stop()); mediaStream = null; cameraPreviewEl.srcObject = null;
  handTracker = null; fingerToggleBtn.textContent = 'Enable Finger Control'; fingerStatusEl.textContent = msg;
}

function onResize() {
  const width = scenePanel.clientWidth; const height = scenePanel.clientHeight;
  if (!width || !height) return;
  camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false);
  const camW = cameraPreviewEl.clientWidth || 320; const camH = cameraPreviewEl.clientHeight || 240;
  handOverlayEl.width = camW * Math.min(window.devicePixelRatio, 2);
  handOverlayEl.height = camH * Math.min(window.devicePixelRatio, 2);
  handOverlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  handOverlayCtx.scale(handOverlayEl.width / camW, handOverlayEl.height / camH);
}

async function loadPlanets() {
  statusEl.textContent = 'Loading planets...'; reloadBtn.disabled = true;
  try {
    const res = await fetch('/api/planets');
    if (!res.ok) throw new Error('Failed to load planets');
    const planets = await res.json();
    const stats = buildPlanetStats(planets);
    const filledPlanets = planets.map((p) => enrichPlanetData(p, stats));
    rebuildExoplanets(filledPlanets.slice(0, 120));
    planetListEl.innerHTML = '';
    filledPlanets.slice(0, 40).forEach((p, i) => planetListEl.appendChild(planetCard(p, i)));
    statusEl.textContent = `Showing planets from API.`;
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`; planetListEl.innerHTML = '';
  } finally { reloadBtn.disabled = false; }
}

window.addEventListener('resize', onResize);
renderer.domElement.addEventListener('pointermove', (e) => intersectPlanet(e.clientX, e.clientY));
renderer.domElement.addEventListener('pointerleave', () => { if (!fingerEnabled) setHoveredBody(null); });
fingerToggleBtn.addEventListener('click', async () => fingerEnabled ? disableFingerControl() : enableFingerControl());
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setSelectedBody(null); });

hideHoverCard(); onResize(); animate();
reloadBtn.addEventListener('click', loadPlanets); loadPlanets();
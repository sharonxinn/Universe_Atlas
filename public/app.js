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

function createGlowTexture() {
  const size = 128;
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = size;
  glowCanvas.height = size;
  const ctx = glowCanvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(glowCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const glowTexture = createGlowTexture();

function createGlowSprite(color, scale = 6, opacity = 0.22) {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false
    })
  );
  sprite.scale.set(scale, scale, 1);
  return sprite;
}

function buildStarField(starCount, spread, color, size, opacity) {
  const starsGeometry = new THREE.BufferGeometry();
  const positions = new Float32Array(starCount * 3);

  for (let i = 0; i < starCount; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * spread;
    positions[i * 3 + 1] = (Math.random() - 0.5) * spread;
    positions[i * 3 + 2] = (Math.random() - 0.5) * spread;
  }

  starsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    starsGeometry,
    new THREE.PointsMaterial({ color, size, transparent: true, opacity })
  );
}

const starsFar = buildStarField(2800, 260, 0xd8ecff, 0.25, 0.82);
const starsNear = buildStarField(1200, 180, 0xbde6ff, 0.38, 0.55);
scene.add(starsFar);
scene.add(starsNear);

const sun = new THREE.Mesh(
  new THREE.SphereGeometry(3.5, 48, 48),
  new THREE.MeshBasicMaterial({ color: 0xffc857 })
);
scene.add(sun);

const sunCorona = new THREE.Mesh(
  new THREE.SphereGeometry(4.15, 48, 48),
  new THREE.MeshBasicMaterial({
    color: 0xffd17e,
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false
  })
);
sun.add(sunCorona);

const sunGlow = createGlowSprite(0xffbe66, 15, 0.4);
sun.add(sunGlow);

const orbitMaterial = new THREE.LineBasicMaterial({ color: 0x2e6ea4, transparent: true, opacity: 0.45 });
const shipOrbitMaterial = new THREE.LineBasicMaterial({ color: 0x7bd6ff, transparent: true, opacity: 0.22 });
const exoplanetGroup = new THREE.Group();
scene.add(exoplanetGroup);
const spaceshipGroup = new THREE.Group();
scene.add(spaceshipGroup);

const exoplanetBodies = [];
const spaceships = [];
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

const SOLAR_SYSTEM_DEFAULTS = {
  Mercury: {
    mass: 0.000174,
    radius: 0.0342,
    temperature: 440,
    period: 88,
    semi_major_axis: 0.39,
    distance_light_year: 0
  },
  Venus: {
    mass: 0.00256,
    radius: 0.0847,
    temperature: 737,
    period: 225,
    semi_major_axis: 0.72,
    distance_light_year: 0
  },
  Earth: {
    mass: 0.00315,
    radius: 0.0892,
    temperature: 288,
    period: 365,
    semi_major_axis: 1,
    distance_light_year: 0
  },
  Mars: {
    mass: 0.000337,
    radius: 0.0475,
    temperature: 210,
    period: 687,
    semi_major_axis: 1.52,
    distance_light_year: 0
  },
  Jupiter: {
    mass: 1,
    radius: 1,
    temperature: 165,
    period: 4333,
    semi_major_axis: 5.2,
    distance_light_year: 0
  },
  Saturn: {
    mass: 0.299,
    radius: 0.843,
    temperature: 134,
    period: 10759,
    semi_major_axis: 9.58,
    distance_light_year: 0
  },
  Uranus: {
    mass: 0.046,
    radius: 0.357,
    temperature: 76,
    period: 30687,
    semi_major_axis: 19.2,
    distance_light_year: 0
  },
  Neptune: {
    mass: 0.054,
    radius: 0.346,
    temperature: 72,
    period: 60190,
    semi_major_axis: 30.05,
    distance_light_year: 0
  }
};

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
  const material = new THREE.MeshPhysicalMaterial({
    color: body.color,
    roughness: 0.68,
    metalness: 0.12,
    clearcoat: 0.45,
    clearcoatRoughness: 0.5,
    emissive: 0x16324d,
    emissiveIntensity: 0.11
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

  const atmosphereColor = new THREE.Color(body.color).offsetHSL(0.01, 0.12, 0.12);
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(body.radius * 1.1, 28, 28),
    new THREE.MeshBasicMaterial({
      color: atmosphereColor,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false
    })
  );
  planet.add(atmosphere);

  const glow = createGlowSprite(atmosphereColor.getHex(), body.radius * 3.4, 0.18);
  planet.add(glow);

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
    targetGlowOpacity: 0.18,
    glow,
    atmosphere,
    metadata: {
      name: body.name,
      ...SOLAR_SYSTEM_DEFAULTS[body.name]
    }
  };

  meshBodyMap.set(planet, bodyData);
  return bodyData;
});

const solarBodies = orbitingBodies;

function createSpaceship(colorHex = 0x8cc7ff) {
  const ship = new THREE.Group();

  const hull = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.2, 1.05, 10),
    new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.35, metalness: 0.65, emissive: 0x1c3f5f, emissiveIntensity: 0.25 })
  );
  hull.rotation.z = Math.PI / 2;
  ship.add(hull);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 0.35, 10),
    new THREE.MeshStandardMaterial({ color: 0xf1fbff, roughness: 0.25, metalness: 0.35, emissive: 0x1b2a36, emissiveIntensity: 0.2 })
  );
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 0.66;
  ship.add(nose);

  const cockpit = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 14, 14),
    new THREE.MeshStandardMaterial({ color: 0x77e7ff, emissive: 0x1b8ac4, emissiveIntensity: 0.26, roughness: 0.2, metalness: 0.2 })
  );
  cockpit.position.set(0.18, 0.14, 0);
  ship.add(cockpit);

  const wingGeometry = new THREE.BoxGeometry(0.36, 0.03, 0.56);
  const wingMaterial = new THREE.MeshStandardMaterial({ color: 0x9eb6d3, roughness: 0.45, metalness: 0.58 });

  const wingTop = new THREE.Mesh(wingGeometry, wingMaterial);
  wingTop.position.set(-0.08, 0.12, 0);
  wingTop.rotation.x = 0.28;
  ship.add(wingTop);

  const wingBottom = new THREE.Mesh(wingGeometry, wingMaterial);
  wingBottom.position.set(-0.08, -0.12, 0);
  wingBottom.rotation.x = -0.28;
  ship.add(wingBottom);

  const engineGlow = createGlowSprite(0x7ee8ff, 1.35, 0.85);
  engineGlow.position.set(-0.72, 0, 0);
  ship.add(engineGlow);

  const beacon = createGlowSprite(0xa7f3ff, 0.5, 0.5);
  beacon.position.set(0.12, 0.25, 0);
  ship.add(beacon);

  ship.scale.setScalar(1.9);

  return { mesh: ship, engineGlow, beacon };
}

[
  { radius: 12.5, speed: 0.0049, tilt: 0.22, yOffset: 1.0, color: 0x8cc7ff, phase: 0.4 },
  { radius: 18.5, speed: 0.0038, tilt: -0.15, yOffset: -0.9, color: 0xffb77c, phase: 2.1 },
  { radius: 25.5, speed: 0.0032, tilt: 0.08, yOffset: 1.6, color: 0x91f5c8, phase: 4.0 },
  { radius: 31.5, speed: 0.0027, tilt: -0.25, yOffset: -1.4, color: 0xc4a5ff, phase: 1.3 }
].forEach((cfg) => {
  const built = createSpaceship(cfg.color);

  const orbitCurve = new THREE.EllipseCurve(0, 0, cfg.radius, cfg.radius);
  const orbitPoints = orbitCurve.getPoints(120).map((point) => new THREE.Vector3(point.x, cfg.yOffset * 0.45, point.y));
  const shipOrbit = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(orbitPoints), shipOrbitMaterial);
  scene.add(shipOrbit);

  const shipData = {
    mesh: built.mesh,
    engineGlow: built.engineGlow,
    beacon: built.beacon,
    radius: cfg.radius,
    speed: cfg.speed,
    tilt: cfg.tilt,
    yOffset: cfg.yOffset,
    phase: cfg.phase
  };
  spaceships.push(shipData);
  spaceshipGroup.add(shipData.mesh);
});

function formatNumber(value, digits = 2) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'Unknown';
  return value.toFixed(digits);
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function primaryReason(prediction) {
  if (!prediction) return 'Habitability prediction is not available for this object.';
  const reason = prediction.top_reasons?.[0]
    || prediction.reasons?.negative?.[0]
    || prediction.reasons?.positive?.[0]
    || prediction.reasons?.missing?.[0]
    || prediction.reasons?.summary;
  if (reason) return reason;

  if (typeof prediction.score === 'number') {
    if (prediction.score >= 0.72) {
      return 'Overall indicators are favorable for possible human habitability.';
    }
    if (prediction.score >= 0.5) {
      return 'Indicators are mixed, so human habitability remains uncertain.';
    }
    return 'Core indicators currently work against human habitability.';
  }

  return 'Prediction generated with limited explanation details.';
}

function reasonIndicator(reasonText) {
  const text = String(reasonText || '').toLowerCase();
  if (
    text.includes('works against')
    || text.includes('unfavorable')
    || text.includes('too hot')
    || text.includes('too cold')
    || text.includes('outside')
  ) {
    return { label: 'Risk', className: 'reason-indicator--risk' };
  }
  if (
    text.includes('insufficient')
    || text.includes('unknown')
    || text.includes('missing')
    || text.includes('uncertain')
  ) {
    return { label: 'Uncertain', className: 'reason-indicator--uncertain' };
  }
  return { label: 'Helpful', className: 'reason-indicator--helpful' };
}

function reasonLineMarkup(prediction) {
  const reasonText = primaryReason(prediction);
  const indicator = reasonIndicator(reasonText);
  return `<span class="planet-reason"><span class="reason-indicator ${indicator.className}">${indicator.label}</span>${reasonText}</span>`;
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
  const prediction = metadata.prediction;
  const predictionLine = prediction
    ? `<span>Habitability: ${prediction.label} (${formatNumber(prediction.score * 100, 0)}%)</span>`
    : '<span>Habitability: Unknown</span>';
  const reasonLine = reasonLineMarkup(prediction);

  hoverCardEl.classList.remove('is-hidden');
  hoverCardEl.innerHTML = `
    <p class="planet-hover-title">${metadata.name || 'Unnamed Planet'}</p>
    <p class="planet-hover-meta">
      <span>Mass: ${formatNumber(metadata.mass)} Jupiters</span>
      <span>Radius: ${formatNumber(metadata.radius)} Jupiters</span>
      <span>Temp: ${formatNumber(metadata.temperature, 0)} K</span>
      ${predictionLine}
      ${reasonLine}
    </p>
  `;
  const panelRect = scenePanel.getBoundingClientRect();
  const left = THREE.MathUtils.clamp(clientX - panelRect.left + 18, 10, panelRect.width - hoverCardEl.offsetWidth - 10);
  const top = THREE.MathUtils.clamp(clientY - panelRect.top + 18, 10, panelRect.height - hoverCardEl.offsetHeight - 10);
  hoverCardEl.style.left = `${left}px`;
  hoverCardEl.style.top = `${top}px`;
}

function showLockedCard(metadata) {
  const prediction = metadata.prediction;
  const predictionLine = prediction
    ? `<span>Habitability: ${prediction.label} (${formatNumber(prediction.score * 100, 0)}%)</span>`
    : '<span>Habitability: Unknown</span>';
  const reasonLine = reasonLineMarkup(prediction);

  hoverCardEl.classList.remove('is-hidden');
  hoverCardEl.innerHTML = `
    <p class="planet-hover-title">${metadata.name || 'Unnamed Planet'} (Selected)</p>
    <p class="planet-hover-meta">
      <span>Mass: ${formatNumber(metadata.mass)} Jupiters</span>
      <span>Radius: ${formatNumber(metadata.radius)} Jupiters</span>
      <span>Temp: ${formatNumber(metadata.temperature, 0)} K</span>
      ${predictionLine}
      ${reasonLine}
    </p>
  `;
  hoverCardEl.style.left = `${Math.max(10, scenePanel.clientWidth - hoverCardEl.offsetWidth - 12)}px`;
  hoverCardEl.style.top = '12px';
}

function applyBodyFocusTargets() {
  [...solarBodies, ...exoplanetBodies].forEach((body) => {
    body.targetScale = 1;
    body.targetEmissive = 0.08;
    body.targetGlowOpacity = 0.16;
  });
  if (hoveredBody) {
    hoveredBody.targetScale = 2.5;
    hoveredBody.targetEmissive = 0.55;
    hoveredBody.targetGlowOpacity = 0.28;
  }
  if (selectedBody) {
    selectedBody.targetScale = 3.8;
    selectedBody.targetEmissive = 1.0;
    selectedBody.targetGlowOpacity = 0.4;
  }
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

  const disposeMeshRecursive = (mesh) => {
    if (!mesh) return;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) {
      if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
      else mesh.material.dispose();
    }
    mesh.children?.forEach((child) => disposeMeshRecursive(child));
  };

  while (exoplanetGroup.children.length) {
    const mesh = exoplanetGroup.children.pop();
    disposeMeshRecursive(mesh);
  }
}

function rebuildExoplanets(planets) {
  clearExoplanets();
  planets.forEach((planet, index) => {
    const radius = exoplanetRadius(planet);
    const color = exoplanetColorFromTemperature(planet.temperature);
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 20, 20),
      new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.5,
        metalness: 0.06,
        clearcoat: 0.38,
        clearcoatRoughness: 0.44,
        emissive: color.clone().multiplyScalar(0.24),
        emissiveIntensity: 0.12
      })
    );

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.12, 16, 16),
      new THREE.MeshBasicMaterial({
        color: color.clone().offsetHSL(0, 0.1, 0.08),
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false
      })
    );
    mesh.add(atmosphere);

    const glow = createGlowSprite(color.getHex(), Math.max(1.3, radius * 4), 0.12);
    mesh.add(glow);
    
    const ringIndex = index % 60; const ringLayer = Math.floor(index / 60);
    const distance = 34 + ringIndex * 0.62 + ringLayer * 2.8;
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.0013 + (60 - ringIndex) * 0.00001;
    const yRange = 0.2 + (index % 5) * 0.08;
    const spin = 0.003 + Math.random() * 0.01;

    mesh.position.set(Math.cos(angle) * distance, Math.sin(angle * 1.9) * yRange, Math.sin(angle) * distance);

    const bodyData = {
      mesh,
      angle,
      distance,
      speed,
      yRange,
      spin,
      targetScale: 1,
      targetEmissive: 0.08,
      targetGlowOpacity: 0.12,
      glow,
      atmosphere,
      metadata: {
        name: planet.name,
        mass: planet.mass,
        radius: planet.radius,
        temperature: planet.temperature,
        prediction: planet.prediction || null
      }
    };
    exoplanetGroup.add(mesh); exoplanetBodies.push(bodyData); meshBodyMap.set(mesh, bodyData);
  });
}

function predictionBadgeClass(prediction) {
  if (!prediction) return 'prediction-chip prediction-chip--unknown';
  if (prediction.score >= 0.75) return 'prediction-chip prediction-chip--high';
  if (prediction.score >= 0.52) return 'prediction-chip prediction-chip--moderate';
  return 'prediction-chip prediction-chip--low';
}

function planetCard(planet, index) {
  const li = document.createElement('li');
  li.style.animationDelay = `${Math.min(index * 35, 360)}ms`;
  const prediction = planet.prediction;
  li.innerHTML = `
    <div class="planet-row">
      <p class="planet-name">${planet.name || 'Unnamed'}</p>
      <span class="${predictionBadgeClass(prediction)}">${prediction ? prediction.label : 'Unknown'}</span>
    </div>
    <p class="planet-meta">
      <span>Temp: ${formatNumber(planet.temperature, 0)} K</span>
      <span>Orbital Period: ${formatNumber(planet.period, 0)} days</span>
      <span>Habitability Score: ${prediction ? `${formatNumber(prediction.score * 100, 0)}%` : 'Unknown'}</span>
      ${reasonLineMarkup(prediction)}
    </p>
  `;
  return li;
}

async function fetchPredictions(planets) {
  const response = await fetch('/api/predictions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planets })
  });

  if (!response.ok) {
    throw new Error('Prediction model is unavailable');
  }

  const payload = await response.json();
  const predictionMap = new Map(
    (payload.predictions || []).map((item) => [item.id, item.prediction])
  );

  return planets.map((planet, index) => ({
    ...planet,
    prediction: predictionMap.get(planet.name || `planet-${index + 1}`) || null
  }));
}

function animate() {
  requestAnimationFrame(animate);
  const time = performance.now() * 0.001;

  sun.rotation.y += 0.0028;
  starsFar.rotation.y += 0.00035;
  starsNear.rotation.y -= 0.00018;
  starsNear.material.opacity = 0.48 + Math.sin(time * 0.95) * 0.12;
  starsFar.material.opacity = 0.76 + Math.sin(time * 0.6 + 1.4) * 0.06;

  sunLight.intensity = 2.05 + Math.sin(time * 1.8) * 0.1;
  sunGlow.material.opacity = 0.36 + Math.sin(time * 2.4) * 0.08;
  sunCorona.material.opacity = 0.2 + Math.sin(time * 1.6 + 0.8) * 0.05;

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

    if (body.atmosphere?.material?.opacity !== undefined) {
      const targetAtmosphere = Math.min(0.38, body.targetGlowOpacity + 0.03);
      body.atmosphere.material.opacity = THREE.MathUtils.lerp(body.atmosphere.material.opacity, targetAtmosphere, 0.2);
    }

    if (body.glow?.material?.opacity !== undefined) {
      const twinkle = 0.02 * Math.sin(time * 3.2 + body.angle * 2.1);
      body.glow.material.opacity = THREE.MathUtils.lerp(body.glow.material.opacity, body.targetGlowOpacity + twinkle, 0.18);
    }
  });

  spaceships.forEach((ship, index) => {
    const angle = time * ship.speed * 60 + ship.phase;
    const radialPulse = Math.sin(time * 0.9 + index) * 0.8;
    const orbitalRadius = ship.radius + radialPulse;
    const x = Math.cos(angle) * orbitalRadius;
    const z = Math.sin(angle) * orbitalRadius;
    const y = ship.yOffset + Math.sin(angle * 1.7 + index) * 0.85;

    ship.mesh.position.set(x, y, z);
    ship.mesh.rotation.y = -angle + Math.PI * 0.5;
    ship.mesh.rotation.z = ship.tilt + Math.sin(time * 2.4 + index) * 0.06;
    ship.mesh.rotation.x = Math.sin(time * 1.8 + index) * 0.05;

    if (ship.engineGlow?.material?.opacity !== undefined) {
      ship.engineGlow.material.opacity = 0.34 + (Math.sin(time * 12 + index * 2.4) + 1) * 0.18;
    }
    if (ship.beacon?.material?.opacity !== undefined) {
      ship.beacon.material.opacity = 0.32 + (Math.sin(time * 9 + index * 1.7) + 1) * 0.22;
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
    const predictedPlanets = await fetchPredictions(filledPlanets);
    rebuildExoplanets(predictedPlanets.slice(0, 120));
    planetListEl.innerHTML = '';
    predictedPlanets.slice(0, 40).forEach((p, i) => planetListEl.appendChild(planetCard(p, i)));
    statusEl.textContent = `Showing planets with model predictions.`;
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
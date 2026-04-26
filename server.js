const path = require('path');
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_NINJAS_KEY;

const chatMessages = [];
let nextChatMessageId = 1;
const chatPresenceByPlanet = new Map();
const chatTypingByChannelPlanet = new Map();
const ONLINE_WINDOW_MS = 30000;
const TYPING_WINDOW_MS = 5000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalize01(value, min, max) {
  if (max <= min) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}

function scoreByRange(value, goodMin, goodMax, hardMin, hardMax) {
  if (value === null) return null;
  if (value < hardMin || value > hardMax) return 0;
  if (value >= goodMin && value <= goodMax) return 1;
  if (value < goodMin) return (value - hardMin) / (goodMin - hardMin);
  return (hardMax - value) / (hardMax - goodMax);
}

function pushReason(bucket, condition, message) {
  if (condition) bucket.push(message);
}

function formatValue(value, digits = 2, unit = '') {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  return `${value.toFixed(digits)}${unit}`;
}

function sanitizePlanetName(value) {
  return String(value || '').trim();
}

function getChannelKey(planetA, planetB) {
  const a = sanitizePlanetName(planetA);
  const b = sanitizePlanetName(planetB);
  if (!a || !b) return '';
  return [a, b].sort((left, right) => left.localeCompare(right)).join('|');
}

function cleanupPresenceAndTyping() {
  const now = Date.now();
  for (const [planet, timestamp] of chatPresenceByPlanet.entries()) {
    if (now - timestamp > ONLINE_WINDOW_MS) {
      chatPresenceByPlanet.delete(planet);
    }
  }

  for (const [key, timestamp] of chatTypingByChannelPlanet.entries()) {
    if (now - timestamp > TYPING_WINDOW_MS) {
      chatTypingByChannelPlanet.delete(key);
    }
  }
}

function scorePlanetHabitability(planet) {
  // API values are in Jupiter units, so convert to Earth-relative units for human-habitability scoring.
  const massJupiter = numberOrNull(planet.mass);
  const radiusJupiter = numberOrNull(planet.radius);
  const massEarth = massJupiter === null ? null : massJupiter * 317.8;
  const radiusEarth = radiusJupiter === null ? null : radiusJupiter * 11.209;
  const temperature = numberOrNull(planet.temperature);
  const semiMajorAxis = numberOrNull(planet.semi_major_axis);
  const period = numberOrNull(planet.period);
  const hostStarMass = numberOrNull(planet.host_star_mass);
  const hostStarTemperature = numberOrNull(planet.host_star_temperature);

  const stellarFlux =
    semiMajorAxis === null
      ? null
      : (() => {
          if (hostStarTemperature !== null) {
            return Math.pow(hostStarTemperature / 5778, 4) / Math.max(Math.pow(semiMajorAxis, 2), 0.01);
          }
          if (hostStarMass !== null) {
            return Math.pow(hostStarMass, 3.5) / Math.max(Math.pow(semiMajorAxis, 2), 0.01);
          }
          return null;
        })();

  const gravityRelativeToEarth =
    massEarth !== null && radiusEarth !== null
      ? massEarth / Math.max(Math.pow(radiusEarth, 2), 0.05)
      : null;

  const rockyLikelihood =
    massEarth !== null || radiusEarth !== null
      ? (() => {
          const radiusScore = scoreByRange(radiusEarth, 0.8, 1.6, 0.4, 2.2);
          const massScore = scoreByRange(massEarth, 0.5, 5.0, 0.1, 10.0);
          if (radiusScore !== null && massScore !== null) return (radiusScore + massScore) / 2;
          return radiusScore ?? massScore;
        })()
      : null;

  const featureScores = {
    equilibrium_temperature: scoreByRange(temperature, 240, 320, 170, 390),
    stellar_flux: scoreByRange(stellarFlux, 0.6, 1.4, 0.25, 2.2),
    gravity: scoreByRange(gravityRelativeToEarth, 0.7, 1.4, 0.3, 2.2),
    rocky_likelihood: rockyLikelihood,
    host_star_temperature: scoreByRange(hostStarTemperature, 4700, 6400, 3500, 7600),
    orbital_period: scoreByRange(period, 220, 520, 90, 1100),
    earth_radius_match: scoreByRange(radiusEarth, 0.8, 1.4, 0.4, 2.2),
    earth_mass_match: scoreByRange(massEarth, 0.6, 3.5, 0.1, 10.0)
  };

  const weights = {
    equilibrium_temperature: 0.2,
    stellar_flux: 0.28,
    gravity: 0.18,
    rocky_likelihood: 0.14,
    host_star_temperature: 0.1,
    orbital_period: 0.06,
    earth_radius_match: 0.02,
    earth_mass_match: 0.02
  };

  const weighted = Object.entries(weights).reduce((acc, [key, weight]) => {
    const value = featureScores[key];
    const fallback = key === 'stellar_flux' || key === 'equilibrium_temperature' || key === 'gravity' ? 0.35 : 0.45;
    return acc + (value === null ? fallback : value) * weight;
  }, 0);

  const score = clamp(weighted, 0, 1);
  const knownInputs = Object.values(featureScores).filter((value) => value !== null).length;
  let confidence = clamp(0.2 + (knownInputs / 8) * 0.8, 0.2, 1);
  if (stellarFlux === null) confidence = Math.max(0.2, confidence - 0.15);
  if (temperature === null) confidence = Math.max(0.2, confidence - 0.12);

  let label = 'Low Potential';
  if (score >= 0.72) label = 'High Potential for Humans';
  else if (score >= 0.5) label = 'Moderate Potential for Humans';

  const positive = [];
  const negative = [];
  const missing = [];

  pushReason(positive, featureScores.stellar_flux !== null && featureScores.stellar_flux >= 0.8, 'Stellar energy received is near Earth-like levels.');
  pushReason(negative, featureScores.stellar_flux !== null && featureScores.stellar_flux <= 0.35, 'Stellar energy is far from Earth-like, likely too hot or too cold for human habitability.');
  pushReason(missing, stellarFlux === null, 'Missing or incomplete star and orbital data makes climate suitability uncertain.');

  pushReason(positive, featureScores.equilibrium_temperature !== null && featureScores.equilibrium_temperature >= 0.75, 'Estimated temperature is within a range where liquid water is more plausible.');
  pushReason(negative, featureScores.equilibrium_temperature !== null && featureScores.equilibrium_temperature <= 0.35, 'Estimated temperature is outside the human-friendly range for stable liquid water.');
  pushReason(missing, temperature === null, 'Temperature is missing, so thermal habitability is uncertain.');

  pushReason(positive, gravityRelativeToEarth !== null && gravityRelativeToEarth >= 0.7 && gravityRelativeToEarth <= 1.4, 'Estimated gravity is near a potentially human-tolerable range.');
  pushReason(negative, gravityRelativeToEarth !== null && (gravityRelativeToEarth < 0.45 || gravityRelativeToEarth > 1.9), 'Estimated gravity is far from Earth-like and could stress human physiology.');

  pushReason(positive, rockyLikelihood !== null && rockyLikelihood >= 0.7, 'Size and mass are consistent with a rocky world rather than a gas giant.');
  pushReason(negative, rockyLikelihood !== null && rockyLikelihood <= 0.35, 'Size/mass suggest a non-rocky planet, reducing odds of a human-habitable surface.');
  pushReason(missing, rockyLikelihood === null, 'Mass/radius data is incomplete, so planet type is uncertain.');

  const impactReasons = [
    { key: 'stellar_flux', title: 'Stellar flux suitability', score: featureScores.stellar_flux },
    { key: 'equilibrium_temperature', title: 'Thermal suitability', score: featureScores.equilibrium_temperature },
    { key: 'gravity', title: 'Gravity suitability', score: featureScores.gravity },
    { key: 'rocky_likelihood', title: 'Rocky-surface likelihood', score: featureScores.rocky_likelihood }
  ].map((item) => {
    const value = item.score;
    let verdict = 'insufficient data';
    if (value !== null && value >= 0.75) verdict = 'strongly supports habitability';
    else if (value !== null && value >= 0.5) verdict = 'partially supports habitability';
    else if (value !== null) verdict = 'works against habitability';

    let details = 'Data is insufficient for this factor.';
    if (item.key === 'stellar_flux') {
      details = stellarFlux === null
        ? 'Flux is unknown due to missing orbital/star inputs.'
        : `Flux is ${formatValue(stellarFlux, 2, 'x Earth')} (ideal 0.60-1.40x Earth).`;
    }
    if (item.key === 'equilibrium_temperature') {
      details = temperature === null
        ? 'Estimated temperature is unknown.'
        : `Temperature is ${formatValue(temperature, 0, ' K')} (preferred 240-320 K).`;
    }
    if (item.key === 'gravity') {
      details = gravityRelativeToEarth === null
        ? 'Gravity estimate is unavailable from mass/radius.'
        : `Estimated gravity is ${formatValue(gravityRelativeToEarth, 2, ' g')} (preferred 0.70-1.40 g).`;
    }
    if (item.key === 'rocky_likelihood') {
      details = rockyLikelihood === null
        ? 'Rocky-likelihood is unavailable due to missing size/mass.'
        : `Rocky-likelihood score is ${formatValue(rockyLikelihood, 2)} (higher is better for surface habitability).`;
    }

    return {
      ...item,
      verdict,
      details,
      weightedImpact: weights[item.key] * (value === null ? 0.4 : Math.abs(value - 0.5) * 2)
    };
  });

  const topReasons = impactReasons
    .sort((a, b) => b.weightedImpact - a.weightedImpact)
    .slice(0, 3)
    .map((item) => `${item.title}: ${item.details} This ${item.verdict}.`);

  const summary =
    label === 'High Potential for Humans'
      ? 'Multiple core indicators align with potential human habitability, but this remains a heuristic estimate.'
      : label === 'Moderate Potential for Humans'
        ? 'Some indicators are favorable for human habitability, while other signals remain uncertain or unfavorable.'
        : 'Several core indicators are unfavorable for human habitability with the available data.';

  return {
    score,
    confidence,
    label,
    factors: featureScores,
    reasons: {
      summary,
      positive,
      negative,
      missing
    },
    top_reasons: topReasons,
    human_context: {
      mass_earth: massEarth,
      radius_earth: radiusEarth,
      gravity_earth_g: gravityRelativeToEarth,
      stellar_flux_earth: stellarFlux
    }
  };
}

app.get('/api/planets', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: 'Missing API_NINJAS_KEY. Add it to your .env file.'
    });
  }

  try {
    const response = await fetch('https://api.api-ninjas.com/v1/planets?min_mass=0', {
      headers: {
        'X-Api-Key': API_KEY
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({
        error: 'Failed to fetch planets from upstream API.',
        details: errText
      });
    }

    const planets = await response.json();
    return res.json(planets);
  } catch (error) {
    return res.status(500).json({
      error: 'Unexpected error while calling API Ninjas.',
      details: error.message
    });
  }
});

app.post('/api/predictions', (req, res) => {
  const planets = req.body?.planets;
  if (!Array.isArray(planets)) {
    return res.status(400).json({
      error: 'Expected body format: { planets: Planet[] }'
    });
  }

  const predictions = planets.map((planet, index) => ({
    id: planet?.name || `planet-${index + 1}`,
    name: planet?.name || `Unnamed ${index + 1}`,
    prediction: scorePlanetHabitability(planet || {})
  }));

  return res.json({
    model: {
      name: 'human-habitability-heuristic-v2',
      description: 'Human-centered, explainable rule-based scoring using flux, temperature, gravity, and rocky-likelihood signals',
      disclaimer: 'Not a validated astrobiology classifier. Results are heuristic and should be treated as exploratory.'
    },
    predictions
  });
});

app.get('/api/chat/messages', (req, res) => {
  cleanupPresenceAndTyping();
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const sinceIdRaw = Number.parseInt(req.query.sinceId, 10);
  const channel = String(req.query.channel || '').trim();
  const limit = Number.isFinite(limitRaw) ? clamp(limitRaw, 1, 200) : 80;
  const sinceId = Number.isFinite(sinceIdRaw) ? Math.max(0, sinceIdRaw) : 0;

  const filtered = chatMessages
    .filter((message) => !channel || message.channel === channel)
    .filter((message) => message.id > sinceId)
    .slice(-limit);

  return res.json({
    messages: filtered,
    latestId: chatMessages.length ? chatMessages[chatMessages.length - 1].id : 0
  });
});

app.post('/api/chat/messages', (req, res) => {
  const senderPlanet = sanitizePlanetName(req.body?.senderPlanet);
  const recipientPlanet = sanitizePlanetName(req.body?.recipientPlanet);
  const text = String(req.body?.text || '').trim();
  const mode = req.body?.mode === 'voice' ? 'voice' : 'text';
  const channel = getChannelKey(senderPlanet, recipientPlanet);

  if (!senderPlanet || !recipientPlanet || !text || !channel) {
    return res.status(400).json({
      error: 'Expected { senderPlanet, recipientPlanet, text, mode } with non-empty values.'
    });
  }

  const message = {
    id: nextChatMessageId,
    senderPlanet,
    recipientPlanet,
    channel,
    text,
    mode,
    timestamp: Date.now()
  };

  nextChatMessageId += 1;
  chatMessages.push(message);

  // Keep only recent history in memory.
  if (chatMessages.length > 500) {
    chatMessages.splice(0, chatMessages.length - 500);
  }

  return res.status(201).json({ message });
});

app.post('/api/chat/presence', (req, res) => {
  cleanupPresenceAndTyping();
  const planet = sanitizePlanetName(req.body?.planet);
  if (!planet) {
    return res.status(400).json({ error: 'Expected { planet } with non-empty value.' });
  }

  chatPresenceByPlanet.set(planet, Date.now());
  return res.status(204).end();
});

app.post('/api/chat/typing', (req, res) => {
  cleanupPresenceAndTyping();
  const planet = sanitizePlanetName(req.body?.planet);
  const channel = String(req.body?.channel || '').trim();
  const isTyping = Boolean(req.body?.isTyping);
  if (!planet || !channel) {
    return res.status(400).json({ error: 'Expected { planet, channel, isTyping }.' });
  }

  const key = `${channel}:${planet}`;
  if (isTyping) {
    chatTypingByChannelPlanet.set(key, Date.now());
  } else {
    chatTypingByChannelPlanet.delete(key);
  }

  return res.status(204).end();
});

app.get('/api/chat/status', (req, res) => {
  cleanupPresenceAndTyping();
  const channel = String(req.query.channel || '').trim();

  const onlinePlanets = [...chatPresenceByPlanet.keys()].sort((a, b) => a.localeCompare(b));
  const typingPlanets = [];
  if (channel) {
    const prefix = `${channel}:`;
    for (const key of chatTypingByChannelPlanet.keys()) {
      if (key.startsWith(prefix)) {
        typingPlanets.push(key.slice(prefix.length));
      }
    }
  }

  typingPlanets.sort((a, b) => a.localeCompare(b));
  return res.json({ onlinePlanets, typingPlanets });
});

app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Universe app running at http://localhost:${PORT}`);
});

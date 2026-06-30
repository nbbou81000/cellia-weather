// scripts/fetch-weather.js
// Recupere les donnees Netatmo (interieur) + Open-Meteo (exterieur si module en panne)
// Historique permanent : un fichier JSON par mois + index global
// Node.js 18+ natif, zero dependance externe

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.join(__dirname, '..');
const DATA_OUT   = path.join(ROOT, 'weather-data.json');
const INDEX_OUT  = path.join(ROOT, 'history-index.json');
const TIMEOUT_MS = 15_000;
// Plafond par fichier mensuel : 96 points/jour x 31 jours = 2976
// On garde une marge et on ne purge JAMAIS les anciens mois
const MONTH_MAX  = 3000;

const CLIENT_ID     = process.env.NETATMO_CLIENT_ID;
const CLIENT_SECRET = process.env.NETATMO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.NETATMO_REFRESH_TOKEN;

// Coordonnees REELLES (privees), utilisees uniquement en interne pour
// interroger Open-Meteo et obtenir une meteo locale precise.
// Ne jamais ecrire LATITUDE/LONGITUDE telles quelles dans un fichier de sortie.
const LATITUDE   = process.env.LOCATION_LAT || '43.9333';
const LONGITUDE  = process.env.LOCATION_LON || '1.9667';

// Coordonnees PUBLIQUES fixes (centre approximatif de Cagnac-les-Mines),
// totalement independantes des vraies coordonnees ci-dessus.
// C'est la seule version exposee dans weather-data.json.
const PUBLIC_PLACE = {
  city:     'Cagnac-les-Mines',
  country:  'FR',
  timezone: 'Europe/Paris',
  location: [1.9667, 43.9333],
};

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error('Variables manquantes : NETATMO_CLIENT_ID, NETATMO_CLIENT_SECRET, NETATMO_REFRESH_TOKEN');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function monthKey(date) {
  // Retourne ex: "2026-06"
  var y = date.getUTCFullYear();
  var m = date.getUTCMonth() + 1;
  return y + '-' + (m < 10 ? '0' + m : m);
}

function monthFile(key) {
  return path.join(ROOT, 'history-' + key + '.json');
}

function readJSON(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch(e) {
    console.warn('Lecture JSON echouee : ' + filePath + ' - ' + e.message);
  }
  return fallback;
}

// ── OAuth2 Netatmo ────────────────────────────────────────────────────────
async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: REFRESH_TOKEN,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch('https://api.netatmo.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('Token refresh failed: ' + res.status);
  const data = await res.json();
  console.log('Token Netatmo OK (expire dans ' + data.expires_in + 's)');
  return data.access_token;
}

// ── Netatmo data ──────────────────────────────────────────────────────────
async function getNetatmoData(token) {
  const res = await fetch('https://api.netatmo.com/api/getstationsdata?get_favorites=false', {
    headers: { 'Authorization': 'Bearer ' + token },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('Netatmo API failed: ' + res.status);
  return res.json();
}

function parseNetatmo(apiData) {
  const devices = apiData.body && apiData.body.devices;
  if (!devices || !devices.length) throw new Error('Aucune station trouvee');
  const station = devices[0];
  const dash    = station.dashboard_data || {};
  const modules = station.modules || [];

  const outdoorModule = modules.find(function(m) { return m.type === 'NAModule1'; });
  const outdoorDash   = outdoorModule && outdoorModule.dashboard_data;
  const outdoorAge    = (outdoorDash && outdoorDash.time_utc)
    ? (Date.now() / 1000 - outdoorDash.time_utc) : Infinity;
  const outdoorOk = outdoorDash && outdoorAge < 1800;

  return {
    // Nom generique : on n'expose jamais le station_name reel (peut contenir
    // un nom de famille / une adresse selon la config du compte Netatmo).
    station_name: 'Station meteo',
    // place n'est PLUS lue depuis l'API Netatmo (contenait ville/pays/GPS reels).
    // On utilise systematiquement PUBLIC_PLACE, defini plus haut.
    indoor: {
      temperature:  dash.Temperature      || null,
      humidity:     dash.Humidity         || null,
      co2:          dash.CO2              || null,
      noise:        dash.Noise            || null,
      pressure:     dash.Pressure         || null,
      abs_pressure: dash.AbsolutePressure || null,
      module_name:  'Etage',
    },
    outdoor_native: outdoorOk ? {
      temperature: outdoorDash.Temperature || null,
      humidity:    outdoorDash.Humidity    || null,
      source:      'netatmo',
    } : null,
  };
}

// ── Open-Meteo fallback ───────────────────────────────────────────────────
async function getOpenMeteo() {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude='  + LATITUDE
    + '&longitude=' + LONGITUDE
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,precipitation'
    + '&timezone=auto&forecast_days=1';
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error('Open-Meteo failed: ' + res.status);
  const data = await res.json();
  const cur  = data.current || {};
  return {
    temperature:          cur.temperature_2m       || null,
    humidity:             cur.relative_humidity_2m || null,
    apparent_temperature: cur.apparent_temperature || null,
    wind_speed:           cur.wind_speed_10m       || null,
    wind_direction:       cur.wind_direction_10m   || null,
    precipitation:        cur.precipitation        || null,
    weather_code:         cur.weather_code         || null,
    source:               'open-meteo',
    source_label:         'Open-Meteo (module en panne)',
  };
}

// ── MAIN ──────────────────────────────────────────────────────────────────
console.log('Recuperation des donnees...');

const token  = await getAccessToken();
const raw    = await getNetatmoData(token);
const parsed = parseNetatmo(raw);

let outdoor;
if (parsed.outdoor_native) {
  console.log('Module exterieur Netatmo OK');
  outdoor = parsed.outdoor_native;
} else {
  console.log('Module exterieur en panne -> fallback Open-Meteo');
  outdoor = await getOpenMeteo();
}

console.log('  Interieur : ' + parsed.indoor.temperature + 'C | ' + parsed.indoor.humidity + '% | ' + parsed.indoor.co2 + ' ppm | ' + parsed.indoor.pressure + ' hPa');
console.log('  Exterieur : ' + outdoor.temperature + 'C | ' + outdoor.humidity + '% [' + outdoor.source + ']');

// ── Ecriture weather-data.json ────────────────────────────────────────────
const now = new Date().toISOString();
const result = {
  last_updated:   now,
  station_name:   parsed.station_name,
  place:          PUBLIC_PLACE, // coordonnees publiques fixes, jamais la position reelle
  indoor:         parsed.indoor,
  outdoor:        outdoor,
  outdoor_source: outdoor.source,
};
fs.writeFileSync(DATA_OUT, JSON.stringify(result, null, 2), 'utf-8');
console.log('weather-data.json ecrit');

// ── Ecriture fichier mensuel ──────────────────────────────────────────────
const nowDate = new Date(now);
const key     = monthKey(nowDate);
const mFile   = monthFile(key);

let monthData = readJSON(mFile, { month: key, entries: [] });

// Migration automatique : si l ancien weather-history.json existe encore,
// on importe ses entrees dans le bon fichier mensuel (une seule fois)
const legacyFile = path.join(ROOT, 'weather-history.json');
if (fs.existsSync(legacyFile)) {
  const legacy = readJSON(legacyFile, { entries: [] });
  if (legacy.entries && legacy.entries.length > 0) {
    console.log('Migration de weather-history.json (' + legacy.entries.length + ' entrees)...');
    // Repartir les entrees dans les bons fichiers mensuels
    const byMonth = {};
    for (var i = 0; i < legacy.entries.length; i++) {
      var e = legacy.entries[i];
      var mk = e.timestamp ? monthKey(new Date(e.timestamp)) : key;
      if (!byMonth[mk]) byMonth[mk] = [];
      byMonth[mk].push(e);
    }
    const mKeys = Object.keys(byMonth);
    for (var mi = 0; mi < mKeys.length; mi++) {
      var mk2 = mKeys[mi];
      var mf2 = monthFile(mk2);
      var existing = readJSON(mf2, { month: mk2, entries: [] });
      // Fusionner sans doublons (par timestamp)
      var existingTs = new Set(existing.entries.map(function(e){ return e.timestamp; }));
      var toAdd = byMonth[mk2].filter(function(e){ return !existingTs.has(e.timestamp); });
      existing.entries = existing.entries.concat(toAdd);
      existing.entries.sort(function(a,b){ return a.timestamp < b.timestamp ? -1 : 1; });
      fs.writeFileSync(mf2, JSON.stringify(existing, null, 2), 'utf-8');
      console.log('  Migre ' + toAdd.length + ' entrees vers history-' + mk2 + '.json');
    }
    // Renommer l ancien fichier en .migrated pour ne plus le retraiter
    fs.renameSync(legacyFile, legacyFile + '.migrated');
    console.log('Migration terminee - weather-history.json renomme en .migrated');
    // Recharger le fichier du mois courant apres migration
    monthData = readJSON(mFile, { month: key, entries: [] });
  }
}

// Ajouter la nouvelle entree
const newEntry = {
  timestamp:      now,
  temp_out:       outdoor.temperature,
  temp_in:        parsed.indoor.temperature,
  hum_out:        outdoor.humidity,
  hum_in:         parsed.indoor.humidity,
  pressure:       parsed.indoor.pressure,
  co2:            parsed.indoor.co2,
  noise:          parsed.indoor.noise,
  outdoor_source: outdoor.source,
};
monthData.entries.push(newEntry);

// Securite : ne pas depasser MONTH_MAX (ne devrait jamais arriver en pratique)
if (monthData.entries.length > MONTH_MAX) {
  monthData.entries = monthData.entries.slice(-MONTH_MAX);
}

fs.writeFileSync(mFile, JSON.stringify(monthData, null, 2), 'utf-8');
console.log('history-' + key + '.json ecrit (' + monthData.entries.length + ' entrees)');

// ── Mise a jour de l index ────────────────────────────────────────────────
let index = readJSON(INDEX_OUT, { files: [], last_updated: now });

// Lister tous les fichiers history-YYYY-MM.json presents dans le repo
const allFiles = fs.readdirSync(ROOT)
  .filter(function(f){ return /^history-\d{4}-\d{2}\.json$/.test(f); })
  .sort();

index.files       = allFiles.map(function(f){ return f.replace('.json','').replace('history-',''); });
index.last_updated = now;
index.total_months = allFiles.length;

// Calculer les stats globales depuis le fichier le plus ancien
var firstEntry = null;
if (allFiles.length > 0) {
  var oldest = readJSON(path.join(ROOT, allFiles[0]), { entries: [] });
  if (oldest.entries.length > 0) firstEntry = oldest.entries[0].timestamp;
}
index.first_entry = firstEntry;

fs.writeFileSync(INDEX_OUT, JSON.stringify(index, null, 2), 'utf-8');
console.log('history-index.json mis a jour (' + index.files.length + ' mois disponibles)');

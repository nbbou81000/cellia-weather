// scripts/fetch-weather.js
// Recupere les donnees Netatmo (interieur) + Open-Meteo (exterieur si module en panne)
// Node.js 18+ natif, zero dependance externe

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const DATA_OUT    = path.join(__dirname, '..', 'weather-data.json');
const HIST_OUT    = path.join(__dirname, '..', 'weather-history.json');
const TIMEOUT_MS  = 15_000;
const HISTORY_MAX = 2880;

const CLIENT_ID     = process.env.NETATMO_CLIENT_ID;
const CLIENT_SECRET = process.env.NETATMO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.NETATMO_REFRESH_TOKEN;

// Modifiez avec vos coordonnees GPS (maps.google.com -> clic droit)
const LATITUDE  = process.env.LOCATION_LAT || '44.8378';
const LONGITUDE = process.env.LOCATION_LON || '-0.5792';

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error('Variables manquantes : NETATMO_CLIENT_ID, NETATMO_CLIENT_SECRET, NETATMO_REFRESH_TOKEN');
  process.exit(1);
}

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
    ? (Date.now() / 1000 - outdoorDash.time_utc)
    : Infinity;
  const outdoorOk = outdoorDash && outdoorAge < 1800;

  return {
    station_name: station.station_name || 'Ma Station',
    place:        station.place || {},
    indoor: {
      temperature:  dash.Temperature      || null,
      humidity:     dash.Humidity         || null,
      co2:          dash.CO2              || null,
      noise:        dash.Noise            || null,
      pressure:     dash.Pressure         || null,
      abs_pressure: dash.AbsolutePressure || null,
      module_name:  station.module_name   || 'Interieur',
    },
    outdoor_native: outdoorOk ? {
      temperature: outdoorDash.Temperature || null,
      humidity:    outdoorDash.Humidity    || null,
      source:      'netatmo',
    } : null,
  };
}

async function getOpenMeteo() {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude='  + LATITUDE
    + '&longitude=' + LONGITUDE
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,precipitation'
    + '&timezone=auto'
    + '&forecast_days=1';

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error('Open-Meteo failed: ' + res.status);
  const data = await res.json();
  const cur  = data.current || {};

  return {
    temperature:           cur.temperature_2m        || null,
    humidity:              cur.relative_humidity_2m  || null,
    apparent_temperature:  cur.apparent_temperature  || null,
    wind_speed:            cur.wind_speed_10m        || null,
    wind_direction:        cur.wind_direction_10m    || null,
    precipitation:         cur.precipitation         || null,
    weather_code:          cur.weather_code          || null,
    source:                'open-meteo',
    source_label:          'Open-Meteo (module en panne)',
  };
}

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

const now    = new Date().toISOString();
const result = {
  last_updated:   now,
  station_name:   parsed.station_name,
  place:          parsed.place,
  indoor:         parsed.indoor,
  outdoor:        outdoor,
  outdoor_source: outdoor.source,
};

fs.writeFileSync(DATA_OUT, JSON.stringify(result, null, 2), 'utf-8');
console.log('weather-data.json ecrit');

let history = { entries: [] };
try {
  if (fs.existsSync(HIST_OUT)) {
    history = JSON.parse(fs.readFileSync(HIST_OUT, 'utf-8'));
  }
} catch(e) {}

history.entries.push({
  timestamp:      now,
  temp_out:       outdoor.temperature,
  temp_in:        parsed.indoor.temperature,
  hum_out:        outdoor.humidity,
  hum_in:         parsed.indoor.humidity,
  pressure:       parsed.indoor.pressure,
  co2:            parsed.indoor.co2,
  noise:          parsed.indoor.noise,
  outdoor_source: outdoor.source,
});

if (history.entries.length > HISTORY_MAX) {
  history.entries = history.entries.slice(-HISTORY_MAX);
}

fs.writeFileSync(HIST_OUT, JSON.stringify(history, null, 2), 'utf-8');
console.log('weather-history.json ecrit (' + history.entries.length + ' entrees)');

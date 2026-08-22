#!/usr/bin/env node
/**
 * generate-eink.js
 *
 * Genere eink.html a partir de eink-template.html en injectant les
 * donnees courantes + un extrait d'historique DIRECTEMENT dans le HTML
 * (aucun fetch() cote navigateur). Ca elimine toute dependance au
 * comportement reseau/timing du moteur de rendu utilise par le plugin
 * TRMNL "Screenshot" (Chromium headless serveur, timeout 5s).
 *
 * A lancer APRES l'etape existante qui met a jour weather-data.json et
 * history-YYYY-MM.json dans le pipeline GitHub Actions (meme repertoire).
 *
 * Usage : node generate-eink.js
 * (suppose que le script est place a la racine du repo cellia-weather,
 * a cote de weather-data.json, history-*.json, eink-template.html)
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TEMPLATE_PATH = path.join(ROOT, 'eink-template.html');
const OUTPUT_PATH = path.join(ROOT, 'eink.html');
const CURRENT_DATA_PATH = path.join(ROOT, 'weather-data.json');

const MAX_POINTS_24H = 96;   // ~1 point / 15 min
const MAX_POINTS_7J = 120;

function monthKey(date) {
  const y = date.getFullYear(), m = date.getMonth() + 1;
  return y + '-' + String(m).padStart(2, '0');
}

function loadEntries(key) {
  const p = path.join(ROOT, 'history-' + key + '.json');
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data.entries || [];
  } catch (e) {
    console.error('Impossible de lire ' + p + ' : ' + e.message);
    return [];
  }
}

function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr;
  const step = Math.ceil(arr.length / maxPoints);
  return arr.filter((_, i) => i % step === 0);
}

function main() {
  if (!fs.existsSync(CURRENT_DATA_PATH)) {
    console.error('weather-data.json introuvable a la racine, abandon.');
    process.exit(1);
  }
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error('eink-template.html introuvable a la racine, abandon.');
    process.exit(1);
  }

  const currentData = JSON.parse(fs.readFileSync(CURRENT_DATA_PATH, 'utf8'));

  const now = new Date();
  const curKey = monthKey(now);
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevKey = monthKey(prevDate);

  let entries = loadEntries(curKey);

  // Si le mois courant ne couvre pas encore 7 jours pleins (debut de mois),
  // on complete avec la fin du mois precedent pour garder un historique
  // 7 jours coherent.
  const sevenDaysAgoMs = now.getTime() - 7 * 24 * 3600 * 1000;
  const earliestCurrent = entries.length ? new Date(entries[0].timestamp).getTime() : now.getTime();
  if (earliestCurrent > sevenDaysAgoMs) {
    entries = loadEntries(prevKey).concat(entries);
  }

  const nowMs = now.getTime();
  const last24 = entries.filter(e => nowMs - new Date(e.timestamp).getTime() <= 24 * 3600 * 1000);
  const last7d = entries.filter(e => nowMs - new Date(e.timestamp).getTime() <= 7 * 24 * 3600 * 1000);

  const d24 = downsample(last24, MAX_POINTS_24H);
  const d7 = downsample(last7d, MAX_POINTS_7J);

  const payload = {
    current: currentData,
    temp24: d24.map(e => ({ t: e.timestamp, out: e.temp_out, in: e.temp_in })),
    press24: d24.map(e => ({ t: e.timestamp, p: e.pressure })),
    temp7: d7.map(e => ({ t: e.timestamp, out: e.temp_out })),
    generated_at: now.toISOString()
  };

  // Echappement anti-injection basique (les '<' casseraient le tag <script>
  // si jamais une valeur contenait '</script>' ou similaire).
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');

  let template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  if (!template.includes('/*__EINK_DATA__*/')) {
    console.error('Placeholder /*__EINK_DATA__*/ introuvable dans le template, abandon.');
    process.exit(1);
  }
  const output = template.replace('/*__EINK_DATA__*/', 'const EINK_DATA = ' + json + ';');

  fs.writeFileSync(OUTPUT_PATH, output);
  console.log(
    'eink.html genere : ' + d24.length + ' pts/24h, ' + d7.length + ' pts/7j, ' +
    'source ' + curKey + (earliestCurrent > sevenDaysAgoMs ? ' + ' + prevKey : '')
  );
}

main();

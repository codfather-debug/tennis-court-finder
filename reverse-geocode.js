// reverse-geocode.js
// Fills in missing addresses for all courts using Nominatim (free, no API key).
// Rate-limited to 1 req/sec. Saves progress every 25 courts so you can Ctrl+C
// and resume — it won't re-fetch addresses already found.
// Run: node reverse-geocode.js

const fs = require('fs');
const path = require('path');

const COURTS_FILE   = path.join(__dirname, 'courts-data.json');
const PROGRESS_FILE = path.join(__dirname, '.geocode-progress.json');

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch(e) { return {}; }
}
function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=17&addressdetails=1`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'ChicagolandTennisCourtFinder/1.0' }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();

  // Build a clean street address from the response
  const a = data.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const city   = a.city || a.town || a.village || a.suburb || a.county || '';
  const state  = a.state || '';
  return [street, city, state].filter(Boolean).join(', ') || data.display_name?.split(',').slice(0,3).join(',').trim() || '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const courts  = JSON.parse(fs.readFileSync(COURTS_FILE, 'utf8'));
  const progress = loadProgress();

  const toGeocode = courts.filter(c => !c.addr || c.addr.trim() === '');
  console.log(`\n=== Reverse Geocoder ===`);
  console.log(`Courts missing addresses: ${toGeocode.length}`);
  const alreadyDone = toGeocode.filter(c => progress[c.key] !== undefined).length;
  console.log(`Already cached:           ${alreadyDone}`);
  console.log(`Remaining to fetch:       ${toGeocode.length - alreadyDone}`);
  console.log(`Estimated time:           ~${Math.ceil((toGeocode.length - alreadyDone) / 60)} min\n`);
  console.log('Press Ctrl+C anytime — progress is saved every 25 courts.\n');

  let fetched = 0, skipped = 0, failed = 0;

  for (let i = 0; i < toGeocode.length; i++) {
    const c = toGeocode[i];

    // Use cached result if available
    if (progress[c.key] !== undefined) {
      skipped++;
      continue;
    }

    try {
      const addr = await reverseGeocode(c.lat, c.lng);
      progress[c.key] = addr;
      fetched++;

      const pct = Math.round(((i + 1) / toGeocode.length) * 100);
      process.stdout.write(`\r[${pct}%] ${i+1}/${toGeocode.length} — ${addr.slice(0, 60).padEnd(60)}`);

      // Save progress every 25 fetches
      if (fetched % 25 === 0) {
        saveProgress(progress);
        applyAndSave(courts, progress);
      }

      await sleep(1100); // respect Nominatim 1 req/sec limit
    } catch(e) {
      progress[c.key] = ''; // mark as attempted so we skip it next run
      failed++;
      await sleep(2000);
    }
  }

  // Final save
  saveProgress(progress);
  const updated = applyAndSave(courts, progress);

  console.log(`\n\n═══════════════════════════════`);
  console.log(`Addresses fetched:  ${fetched}`);
  console.log(`From cache:         ${skipped}`);
  console.log(`Failed/empty:       ${failed}`);
  console.log(`Courts updated:     ${updated}`);
  console.log(`═══════════════════════════════`);
  console.log('\n✓ courts-data.json saved!');
  console.log('Next: git add courts-data.json && git commit -m "Add reverse geocoded addresses" && git push\n');
}

function applyAndSave(courts, progress) {
  let count = 0;
  for (const c of courts) {
    if ((!c.addr || c.addr.trim() === '') && progress[c.key]) {
      c.addr = progress[c.key];
      count++;
    }
  }
  fs.writeFileSync(COURTS_FILE, JSON.stringify(courts, null, 2));
  return count;
}

main().catch(e => {
  console.error('\nError:', e.message);
  process.exit(1);
});

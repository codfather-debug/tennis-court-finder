// merge-usta.js
// Fetches all USTA facilities for Chicagoland, matches them to courts-data.json
// by proximity, and merges verified data (lighting, surface, courts, name, address).
// Run: node merge-usta.js

const fs = require('fs');
const path = require('path');

const COURTS_FILE = path.join(__dirname, 'courts-data.json');
const OUTPUT_FILE = path.join(__dirname, 'courts-data.json');
const UNMATCHED_FILE = path.join(__dirname, 'usta-unmatched.json');

// Grid of center points covering Chicago → DeKalb/Aurora area
// Each point queries 30mi radius — overlapping is fine, we deduplicate by ID
const GRID = [
  { lat: 41.85, lng: -87.65 },  // Chicago core
  { lat: 41.85, lng: -88.00 },  // Western suburbs (Oak Park, Elmhurst, Wheaton)
  { lat: 41.85, lng: -88.35 },  // Far west (Batavia, Geneva, DeKalb)
  { lat: 42.15, lng: -87.80 },  // North suburbs (Evanston, Skokie, Arlington Heights)
  { lat: 42.15, lng: -88.10 },  // NW suburbs (Schaumburg, Hoffman Estates)
  { lat: 41.55, lng: -87.75 },  // South suburbs (Orland Park, Tinley Park)
  { lat: 41.55, lng: -88.10 },  // SW suburbs (Joliet area)
];

const MATCH_RADIUS_MILES = 0.2; // match OSM court to USTA facility if within 0.2 miles

function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

async function fetchUSTAPage(lat, lng, page = 1) {
  const body = JSON.stringify({
    pageSize: "200",
    pageNumber: page,
    sortCriteria: "distanceAsc",
    distance: "30",
    latitude: lat,
    longitude: lng,
    has36: false, has60: false, has78: false,
    hasClayCourt: false, hasGrassCourt: false, hasHardCourt: false,
    hasHittingWall: false, hasProShop: false, hasSpanishSpeakingTranslator: false,
    indoorCourtCountFacet: false, isCoachingAvailable: false,
    isLit: false, isPrivate: false, isPublic: false
  });

  const resp = await fetch('https://services.usta.com/v1/servicebus/facilities/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://www.usta.com',
      'Referer': 'https://www.usta.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    },
    body
  });

  if (!resp.ok) throw new Error(`USTA API error ${resp.status} for ${lat},${lng}`);
  return resp.json();
}

async function fetchAllForPoint(lat, lng) {
  const facilities = [];
  let page = 1;
  while (true) {
    process.stdout.write(`  Page ${page}...`);
    const result = await fetchUSTAPage(lat, lng, page);
    const items = result.data || result.facilities || result.results || [];
    if (!items.length) break;
    facilities.push(...items);
    process.stdout.write(` ${items.length} results\n`);
    if (items.length < 200) break; // last page
    page++;
    await new Promise(r => setTimeout(r, 300)); // be polite
  }
  return facilities;
}

function normalizeSurface(ustaFacility) {
  if (ustaFacility.hasHardCourt) return 'hard';
  if (ustaFacility.hasClayCourt) return 'clay';
  if (ustaFacility.hasGrassCourt) return 'grass';
  return '';
}

function getUSTALat(f) {
  return f.latitude || f.lat || null;
}
function getUSTALng(f) {
  return f.longitude || f.lng || null;
}
function getUSTAAddr(f) {
  // USTA uses flat address fields: addressLine1, addressCity, addressState, addressZipCode
  const street = f.addressLine1 || '';
  const city   = f.addressCity  || '';
  const state  = f.addressState || '';
  return [street, city, state].filter(Boolean).join(', ') || f.displayAddress || '';
}

function getUSTACourts(f) {
  return f.courtsCount || f.totalCourtCount || f.numberOfCourts || null;
}

function getUSTALit(f) {
  // Check facilitySuggestKeywords for "lit" or check isLit field
  if (f.isLit === true || f.isLit === 'true') return true;
  const kw = (f.facilitySuggestKeywords || []).map(k => k.toLowerCase());
  return kw.includes('lit') || kw.includes('lights') || kw.includes('lighted');
}

async function main() {
  console.log('=== USTA Court Merger ===\n');

  // ── Step 1: Fetch all USTA facilities ────────────────────────────────────
  const allFacilitiesMap = new Map(); // deduplicate by ID
  for (const point of GRID) {
    console.log(`Querying ${point.lat}, ${point.lng}...`);
    try {
      const facilities = await fetchAllForPoint(point.lat, point.lng);
      for (const f of facilities) {
        if (f.id && !allFacilitiesMap.has(f.id)) {
          allFacilitiesMap.set(f.id, f);
        }
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error(`  Error: ${e.message}`);
    }
  }

  const ustaFacilities = [...allFacilitiesMap.values()];
  console.log(`\n✓ ${ustaFacilities.length} unique USTA facilities fetched\n`);

  // Log first facility to understand structure
  if (ustaFacilities.length > 0) {
    console.log('Sample USTA facility fields:', Object.keys(ustaFacilities[0]).join(', '));
    console.log('Sample:', JSON.stringify(ustaFacilities[0], null, 2).slice(0, 800));
  }

  // ── Step 2: Load existing courts-data.json ────────────────────────────────
  const courts = JSON.parse(fs.readFileSync(COURTS_FILE, 'utf8'));
  console.log(`\n✓ ${courts.length} courts loaded from courts-data.json\n`);

  // ── Step 3: Match and merge ───────────────────────────────────────────────
  let matched = 0, litUpdated = 0, surfaceUpdated = 0, nameUpdated = 0, addrUpdated = 0;
  const unmatchedUSTA = [];

  for (const uf of ustaFacilities) {
    const uLat = getUSTALat(uf);
    const uLng = getUSTALng(uf);
    if (!uLat || !uLng) { unmatchedUSTA.push({ reason: 'no coords', ...uf }); continue; }

    const uName = uf.displayName || uf.name || '';
    const uAddr = getUSTAAddr(uf);
    const uLit  = getUSTALit(uf);
    const uSurf = normalizeSurface(uf);
    const uCourts = getUSTACourts(uf);

    // Find nearest OSM court within MATCH_RADIUS_MILES
    let bestCourt = null, bestDist = MATCH_RADIUS_MILES;
    for (const c of courts) {
      const d = haversine(c.lat, c.lng, uLat, uLng);
      if (d < bestDist) { bestDist = d; bestCourt = c; }
    }

    if (!bestCourt) {
      unmatchedUSTA.push({ reason: 'no nearby OSM court', uName, uAddr, uLat, uLng, uLit, uSurf });
      continue;
    }

    matched++;

    // Merge: prefer USTA data for lighting and surface (it's verified)
    if (uLit && !bestCourt.lit) {
      bestCourt.lit = true;
      litUpdated++;
    }
    if (uSurf && !bestCourt.surface) {
      bestCourt.surface = uSurf;
      surfaceUpdated++;
    }
    if (uName && (!bestCourt.name || bestCourt.name.trim() === '')) {
      bestCourt.name = uName;
      nameUpdated++;
    }
    if (uAddr && (!bestCourt.addr || bestCourt.addr.trim() === '')) {
      bestCourt.addr = uAddr;
      addrUpdated++;
    }
    if (uCourts && uCourts > bestCourt.courts) {
      bestCourt.courts = uCourts;
    }
    // Tag as USTA-verified
    bestCourt.ustaVerified = true;
  }

  // ── Step 4: Save results ──────────────────────────────────────────────────
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(courts, null, 2));
  fs.writeFileSync(UNMATCHED_FILE, JSON.stringify(unmatchedUSTA, null, 2));

  console.log('═══════════════════════════════');
  console.log(`USTA facilities fetched:  ${ustaFacilities.length}`);
  console.log(`Matched to OSM courts:    ${matched}`);
  console.log(`  Lighting updated:       ${litUpdated}`);
  console.log(`  Surface updated:        ${surfaceUpdated}`);
  console.log(`  Names filled in:        ${nameUpdated}`);
  console.log(`  Addresses filled in:    ${addrUpdated}`);
  console.log(`Unmatched USTA (saved):   ${unmatchedUSTA.length} → usta-unmatched.json`);
  console.log('═══════════════════════════════');
  console.log('\n✓ courts-data.json updated!');
  console.log('Next: git add courts-data.json && git commit -m "Merge USTA data" && git push');
}

main().catch(console.error);

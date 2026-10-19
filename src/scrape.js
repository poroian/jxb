const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const CONFIG_PATH = path.join(ROOT, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('config.json not found. Copy config.example.json to config.json and edit it for your own search, then run again.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
// search: plain terms sent to LinkedIn as-is, one query each. No prefixes, no local filtering —
// excluding/narrowing by title happens in filterTitle instead.
const rawSearch = process.argv.slice(2).length ? process.argv.slice(2) : config.search || [];
const { makeTitleFilter, salaryMax } = require('./filters');
const KEYWORDS = rawSearch.map(k => k.trim()).filter(Boolean);
const titleAllowed = makeTitleFilter(config.filterTitle || []);
// location: a single string or an array of strings. Each one runs as its own full search pass.
const LOCATIONS = (Array.isArray(config.location) ? config.location : [config.location]).filter(Boolean);
const OUT_DIR = path.join(ROOT, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
const OUT_JSON = path.join(OUT_DIR, `jobs_${stamp}.json`);

const UNIT_MS = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 };
function postedAt(relText, isoDate) {
  const m = /(\d+)\s+(minute|hour|day|week|month)s?\s+ago/i.exec(relText || '');
  if (m) return new Date(Date.now() - Number(m[1]) * UNIT_MS[m[2].toLowerCase()]).toISOString();
  return isoDate ? new Date(isoDate).toISOString() : '';
}
const PROFILE = path.join(ROOT, '.profile');

const POSTED = { '24h': 'r86400', week: 'r604800', month: 'r2592000' };

// LinkedIn's search-results page drops location, f_SAL, f_WT and sortBy from the URL, so location goes
// in as a geoId and salary/remote are checked locally against each card (see keepCard).
function buildUrl(keyword, geoId, page) {
  const q = new URLSearchParams({ keywords: keyword, start: String(page * 25) });
  if (geoId) q.set('geoId', geoId);
  if (POSTED[config.postedWithin]) q.set('f_TPR', POSTED[config.postedWithin]);
  return `https://www.linkedin.com/jobs/search-results/?${q}`;
}

// Resolves a location string ("New York, NY") to LinkedIn's geoId via the logged-in typeahead.
// The typeahead mangles state abbreviations ("New York, NY" -> Nyack), so we search the city alone
// and prefer the hit named "<city>, <full state name>..." so "New York, NY" isn't the whole state.
async function resolveGeo(ctx, location) {
  const [city, region = ''] = location.split(',').map(s => s.trim());
  const state = US_STATES[region.toUpperCase()] || region;
  const csrf = (await ctx.cookies()).find(c => c.name === 'JSESSIONID')?.value.replace(/"/g, '');
  const url = 'https://www.linkedin.com/voyager/api/graphql?variables=(keywords:' + encodeURIComponent(city) +
    ',query:(typeaheadFilterQuery:(geoSearchTypes:List(MARKET_AREA,COUNTRY_REGION,ADMIN_DIVISION_1,CITY))),type:GEO)' +
    '&queryId=voyagerSearchDashReusableTypeahead.4c7caa85341b17b470153ad3d1a29caf';
  try {
    const res = await ctx.request.get(url, { headers: { 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', accept: 'application/json' } });
    const hits = (await res.json()).data.searchDashReusableTypeaheadByType.elements
      .map(e => ({ id: JSON.stringify(e).match(/urn:li:fsd_geo:(\d+)/)?.[1], name: e.title?.text || '' }))
      .filter(h => h.id);
    const lc = s => s.toLowerCase();
    const starts = prefix => hits.find(h => lc(h.name).startsWith(lc(prefix)));
    return (state && starts(`${city}, ${state}`)) || starts(`${city},`) || hits[0] || null;
  } catch {}
  return null;
}

const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// Salary/remote used to be LinkedIn URL filters; now checked against the card. Cards with no salary listed are kept.
function keepCard(c) {
  if (config.remote && !/\(remote\)/i.test(c.location)) return false;
  if (config.minSalary) {
    const max = salaryMax(c.salary);
    if (max !== null && max < config.minSalary) return false;
  }
  return true;
}

const sleep = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
const isLoggedIn = page => !/login|authwall|checkpoint|signup/.test(page.url());

async function login(page) {
  const { LINKEDIN_USERNAME: user, LINKEDIN_PASSWORD: pass } = process.env;
  if (user && pass) {
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
    await sleep(1500, 3000);
    await page.fill('#username', user);
    await sleep(500, 1200);
    await page.fill('#password', pass);
    await sleep(500, 1200);
    await page.click('button[type="submit"]');
  } else {
    console.log('No credentials in .env. Log in manually in the browser window.');
  }
  console.log('If LinkedIn asks for 2FA or a captcha, finish it in the window. Waiting up to 5 minutes...');
  await page.waitForURL(/linkedin\.com\/(feed|jobs|in)\//, { timeout: 300000 });
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  if (!isLoggedIn(page)) await login(page);
  await sleep(3000, 6000);

  const jobs = {};
  const save = () => {
    const sorted = Object.values(jobs).sort((a, b) => (b.postedAt || '').localeCompare(a.postedAt || ''));
    fs.writeFileSync(OUT_JSON, JSON.stringify(sorted, null, 2));
  };

  for (const loc of LOCATIONS.length ? LOCATIONS : [undefined]) {
  let geoId;
  if (loc) {
    const geo = await resolveGeo(ctx, loc);
    if (!geo) { console.log(`Could not resolve location "${loc}" on LinkedIn, skipping it.`); continue; }
    console.log(`Location "${loc}" -> ${geo.name} (geoId ${geo.id})`);
    geoId = geo.id;
  }
  for (const kw of KEYWORDS) {
    for (let p = 0; p < config.pagesPerKeyword; p++) {
      const url = buildUrl(kw, geoId, p);
      console.log(`Searching "${kw}"${loc ? ` in "${loc}"` : ''} page ${p + 1}`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(3000, 6000);

      if (!isLoggedIn(page)) {
        await login(page);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await sleep(3000, 6000);
      }

      // LinkedIn only renders a card's contents once it has been scrolled into view
      // Class names are obfuscated, so cards are found by componentkey and read by <p> position:
      // [title, company, location, ...salary/benefits/posted lines]
      const CARD = 'div[role="button"][componentkey^="job-card-component-ref-"]';
      const cardLocator = page.locator(CARD);
      const total = await cardLocator.count();
      for (let i = 0; i < total; i++) {
        await cardLocator.nth(i).scrollIntoViewIfNeeded().catch(() => {});
        await sleep(250, 600);
      }

      const cards = await page.$$eval(CARD, els =>
        els.map(el => {
          const ps = [...el.querySelectorAll('p')].map(p => p.innerText.trim());
          const titleP = el.querySelector('p');
          const title = (titleP?.querySelector('span[aria-hidden="true"]')?.innerText || ps[0]?.split('\n')[0] || '')
            .replace(/\s*\(Verified job\)\s*$/, '').trim();
          return {
            id: el.getAttribute('componentkey').replace('job-card-component-ref-', ''),
            title,
            company: ps[1] || '',
            location: ps[2] || '',
            salary: ps.slice(3).find(t => /\$/.test(t)) || '',
            postedText: ps.find(t => /\bago\b/.test(t))?.split('\n').pop() || '',
          };
        })
      );
      let added = 0;
      let excluded = 0;
      for (const c of cards) {
        if (!c.id || !c.title || jobs[c.id]) continue;
        if (!titleAllowed(c.title) || !keepCard(c)) { excluded++; continue; }
        jobs[c.id] = { ...c, postedAt: postedAt(c.postedText), url: `https://www.linkedin.com/jobs/view/${c.id}/`, keyword: kw, foundAt: new Date().toISOString() };
        added++;
      }
      console.log(`  +${added} new, ${excluded} filtered out (${Object.keys(jobs).length} total)`);
      save();
      if (cards.length === 0) break;
      await sleep(4000, 9000);
    }
  }
  }

  await ctx.close();
  console.log(`Done. ${Object.keys(jobs).length} jobs in ${OUT_JSON}`);
})();

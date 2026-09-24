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
const { makeTitleFilter } = require('./filters');
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

// LinkedIn salary buckets: f_SAL=1..9 => $40k, 60k, 80k, 100k, 120k, 140k, 160k, 180k, 200k+
const SALARY_BUCKETS = [40, 60, 80, 100, 120, 140, 160, 180, 200];
const POSTED = { '24h': 'r86400', week: 'r604800', month: 'r2592000' };

function buildUrl(keyword, location, page) {
  const q = new URLSearchParams({ keywords: keyword, start: String(page * 25), sortBy: 'DD' });
  if (location) q.set('location', location);
  if (config.minSalary) {
    const k = config.minSalary / 1000;
    const idx = SALARY_BUCKETS.filter(b => b <= k).length;
    if (idx > 0) q.set('f_SAL', String(idx));
  }
  if (config.remote) q.set('f_WT', '2');
  if (POSTED[config.postedWithin]) q.set('f_TPR', POSTED[config.postedWithin]);
  return `https://www.linkedin.com/jobs/search/?${q}`;
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
  for (const kw of KEYWORDS) {
    for (let p = 0; p < config.pagesPerKeyword; p++) {
      const url = buildUrl(kw, loc, p);
      console.log(`Searching "${kw}"${loc ? ` in "${loc}"` : ''} page ${p + 1}`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(3000, 6000);

      if (!isLoggedIn(page)) {
        await login(page);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await sleep(3000, 6000);
      }

      // LinkedIn only renders a card's contents once it has been scrolled into view
      const cardLocator = page.locator('li[data-occludable-job-id]');
      const total = await cardLocator.count();
      for (let i = 0; i < total; i++) {
        await cardLocator.nth(i).scrollIntoViewIfNeeded().catch(() => {});
        await sleep(250, 600);
      }

      const cards = await page.$$eval('li[data-occludable-job-id]', lis =>
        lis.map(li => {
          const text = sel => li.querySelector(sel)?.innerText.split('\n')[0].trim() || '';
          return {
            id: li.getAttribute('data-occludable-job-id'),
            title: text('a[href*="/jobs/view/"]'),
            company: text('.artdeco-entity-lockup__subtitle'),
            location: text('.artdeco-entity-lockup__caption'),
            salary: text('.artdeco-entity-lockup__metadata'),
            postedText: text('time'),
            postedDate: li.querySelector('time')?.getAttribute('datetime') || '',
          };
        })
      );
      let added = 0;
      let excluded = 0;
      for (const c of cards) {
        if (!c.id || !c.title || jobs[c.id]) continue;
        if (!titleAllowed(c.title)) { excluded++; continue; }
        const { postedDate, ...rest } = c;
        jobs[c.id] = { ...rest, postedAt: postedAt(c.postedText, postedDate), url: `https://www.linkedin.com/jobs/view/${c.id}/`, keyword: kw, foundAt: new Date().toISOString() };
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

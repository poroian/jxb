# Job scraper

- supports LinkedIn

## Setup

```
npm install
npx playwright install chromium
cp config.example.json config.json
```

`config.json` is gitignored as it functions as your on config for sure. Customize to your needs (see Configure below).

## Run

```
npm start
```

A Chrome window opens. First time only: log in to LinkedIn in that window. Your session is saved in `.profile/`, so later runs skip login.

Results are saved to `output/jobs_<date>_<time>.json`.

## Configure

Edit `config.json`:

- **`search`** — a list of words/phrases, each run as its own LinkedIn search (e.g. `"react"` finds the same jobs as typing "react" into LinkedIn's job search box). This decides which jobs get pulled, since LinkedIn checks it against the full listing (title, description, company, skills) on their end. Results from every entry are combined.
- **`filterTitle`** — a second pass we run ourselves after `search` returns results, to narrow them further. We only ever see the **job title**, not the description, so this can't filter on anything `search` already missed. Supports the fuller `=` / ordering syntax below.
- **`location`** — a LinkedIn location string, or an array, e.g. ["New York, NY", "San Francisco, CA", "San Jose, CA"]. Each one runs the full `search` list again, so this multiplies your total requests.
- **`minSalary`** — rounds down to LinkedIn's nearest $20k filter bucket (so `200000` → the "$200k+" filter). Loose: LinkedIn still returns some jobs under this.
- **`remote`** — `true` restricts to remote listings.
- **`postedWithin`** — `"24h"`, `"week"`, `"month"`, or `"any"`.
- **`pagesPerKeyword`** — pages of results to load per `search` entry (~25 jobs/page, so `3` ≈ 75 raw listings per keyword before `filterTitle` trims them). Higher = more results but more requests, more run time, more risk of LinkedIn flagging the account. Recommended: 3–5.

### `filterTitle` syntax

(This syntax is `filterTitle`-only. `search` doesn't use any of it — see above.)

- **no prefix** → contains match. `staff` matches "Staff Engineer" and "Staffing Coordinator".
- **`=`** → exact match, whole word only. `=staff` matches "Staff Engineer" but not "Staffing Coordinator".
- **`-`** → exclude instead of include. `-staff` drops any job matching "staff".

Stack `-` and `=` to exclude an exact word: `-=staff` drops "Staff Engineer" but not "Staffing Coordinator" (`-` always comes first).

For `filterTitle`, the **last matching entry wins** — list order matters. 

## Test the filters

```
npm test
```

Checks `filterTitle` against example job titles in `test/filters.test.js`.

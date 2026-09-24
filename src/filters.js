// Syntax: "React" = contains, "=React" = whole word, "-Staff" = exclude contains, "-=Staff" = exclude whole word
function parseTerm(raw) {
  let s = raw.trim();
  const exclude = s.startsWith('-');
  if (exclude) s = s.slice(1).trim();
  const exact = s.startsWith('=');
  if (exact) s = s.slice(1).trim();
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = exact ? new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu') : null;
  return { term: s, exact, exclude, regex };
}

const parseList = list => list.map(parseTerm).filter(t => t.term);

const matches = (text, t) => (t.exact ? t.regex.test(text) : text.toLowerCase().includes(t.term.toLowerCase()));

// Last matching entry wins; if none match, keep only when the list has no include entries.
// Use for a list that's meant to fully decide inclusion on its own (e.g. filterTitle).
function makeTitleFilter(rawList) {
  const terms = parseList(rawList);
  const hasIncludes = terms.some(t => !t.exclude);
  return title => {
    let verdict = null;
    for (const t of terms) if (matches(title, t)) verdict = !t.exclude;
    return verdict === null ? !hasIncludes : verdict;
  };
}

module.exports = { parseTerm, parseList, matches, makeTitleFilter };

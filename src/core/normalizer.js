/**
 * Smart normalizer for Ukrainian dates, days of week (all grammatical cases),
 * date ranges, and fuzzy student/class matching.
 */

const DAY_STEMS = [
  { dayIndex: 0, canonical: 'неділя', stems: ['неділ', 'нд', 'sunday'] },
  { dayIndex: 1, canonical: 'понеділок', stems: ['понеділ', 'пн', 'monday'] },
  { dayIndex: 2, canonical: 'вівторок', stems: ['вівтор', 'вт', 'tuesday'] },
  { dayIndex: 3, canonical: 'середа', stems: ['серед', 'ср', 'wednesday'] },
  { dayIndex: 4, canonical: 'четвер', stems: ['четвер', 'чт', 'thursday'] },
  { dayIndex: 5, canonical: "п'ятниця", stems: ['п\'ятниц', 'пятниц', 'пʼятниц', 'пт', 'friday'] },
  { dayIndex: 6, canonical: 'субота', stems: ['субот', 'сб', 'saturday'] }
];

function cleanStr(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[ʼ`’]/g, "'")
    .replace(/\s+/g, ' ');
}

function formatIsoDate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDmDate(dateObj) {
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${d}.${m}`;
}

function formatDmyDate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${d}.${m}.${y}`;
}

/**
 * Detects if a query string refers to a Ukrainian day of week (in any grammatical case)
 * Returns { dayIndex, canonical } or null.
 */
function matchDayOfWeek(query) {
  const q = cleanStr(query);
  if (!q) return null;
  for (const item of DAY_STEMS) {
    if (item.stems.some(stem => q === stem || (stem.length > 2 && q.includes(stem)))) {
      return item;
    }
  }
  return null;
}

/**
 * Resolves a human date string ("сьогодні", "завтра", "вчора", "05.10", "2026-10-05", "вівторок")
 * into structured { dm: "DD.MM", dmy: "DD.MM.YYYY", iso: "YYYY-MM-DD", dateObj }
 */
function parseSmartDate(dateStr, referenceDate = new Date()) {
  if (!dateStr) return null;
  const s = cleanStr(dateStr);
  if (!s) return null;

  const base = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());

  if (s === 'сьогодні' || s === 'today' || s === 'на сьогодні') {
    return { dm: formatDmDate(base), dmy: formatDmyDate(base), iso: formatIsoDate(base), dateObj: base };
  }
  if (s === 'вчора' || s === 'yesterday' || s === 'за вчора') {
    const dt = new Date(base);
    dt.setDate(dt.getDate() - 1);
    return { dm: formatDmDate(dt), dmy: formatDmyDate(dt), iso: formatIsoDate(dt), dateObj: dt };
  }
  if (s === 'позавчора') {
    const dt = new Date(base);
    dt.setDate(dt.getDate() - 2);
    return { dm: formatDmDate(dt), dmy: formatDmyDate(dt), iso: formatIsoDate(dt), dateObj: dt };
  }
  if (s === 'завтра' || s === 'tomorrow' || s === 'на завтра') {
    const dt = new Date(base);
    dt.setDate(dt.getDate() + 1);
    return { dm: formatDmDate(dt), dmy: formatDmyDate(dt), iso: formatIsoDate(dt), dateObj: dt };
  }
  if (s === 'післязавтра') {
    const dt = new Date(base);
    dt.setDate(dt.getDate() + 2);
    return { dm: formatDmDate(dt), dmy: formatDmyDate(dt), iso: formatIsoDate(dt), dateObj: dt };
  }

  // ISO YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const y = Number(isoMatch[1]);
    const m = Number(isoMatch[2]);
    const d = Number(isoMatch[3]);
    const dt = new Date(y, m - 1, d);
    return { dm: formatDmDate(dt), dmy: formatDmyDate(dt), iso: formatIsoDate(dt), dateObj: dt };
  }

  // DD.MM.YYYY or DD.MM
  const dmMatch = s.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/);
  if (dmMatch) {
    const d = Number(dmMatch[1]);
    const m = Number(dmMatch[2]);
    let y = dmMatch[3] ? Number(dmMatch[3]) : base.getFullYear();
    if (y < 100) y += 2000;
    // If no year given, infer school year (Sept-Dec vs Jan-Jun)
    if (!dmMatch[3]) {
      const currentMonth = base.getMonth() + 1;
      if (currentMonth >= 8 && m <= 6) y = base.getFullYear() + 1;
      else if (currentMonth <= 6 && m >= 8) y = base.getFullYear() - 1;
    }
    const dt = new Date(y, m - 1, d);
    return { dm: formatDmDate(dt), dmy: formatDmyDate(dt), iso: formatIsoDate(dt), dateObj: dt };
  }

  // Check if day of week within current week (Mon..Sun)
  const dow = matchDayOfWeek(s);
  if (dow) {
    const currentDow = base.getDay(); // 0=Sun, 1=Mon...
    const mondayOffset = currentDow === 0 ? -6 : 1 - currentDow;
    const targetOffset = dow.dayIndex === 0 ? 6 : dow.dayIndex - 1;
    const dt = new Date(base);
    dt.setDate(base.getDate() + mondayOffset + targetOffset);
    if (s.includes('наступн')) {
      dt.setDate(dt.getDate() + 7);
    } else if (s.includes('минул')) {
      dt.setDate(dt.getDate() - 7);
    }
    return { dm: formatDmDate(dt), dmy: formatDmyDate(dt), iso: formatIsoDate(dt), dateObj: dt, dayOfWeek: dow.canonical };
  }

  return null;
}

/**
 * Resolves a week or period range ("цей тиждень", "наступний тиждень", "минулий тиждень", etc.)
 * into { startIso, endIso, label }
 */
function resolveDateRange({ filter, startDate, endDate }, referenceDate = new Date()) {
  const base = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const currentDow = base.getDay();
  const mondayOffset = currentDow === 0 ? -6 : 1 - currentDow;

  const getWeekBounds = (weekShift = 0) => {
    const mon = new Date(base);
    mon.setDate(base.getDate() + mondayOffset + weekShift * 7);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return { startIso: formatIsoDate(mon), endIso: formatIsoDate(sun) };
  };

  if (startDate || endDate) {
    const sParsed = parseSmartDate(startDate || endDate, referenceDate);
    const eParsed = parseSmartDate(endDate || startDate, referenceDate);
    if (sParsed && eParsed) {
      return {
        startIso: sParsed.iso,
        endIso: eParsed.iso,
        singleDate: startDate && !endDate ? sParsed : null
      };
    }
  }

  if (filter) {
    const q = cleanStr(filter);
    if (q.includes('наступний тиждень') || q.includes('наступного тижня') || q === 'next_week') {
      return { ...getWeekBounds(1), rangeType: 'next_week' };
    }
    if (q.includes('минулий тиждень') || q.includes('минулого тижня') || q === 'last_week') {
      return { ...getWeekBounds(-1), rangeType: 'last_week' };
    }
    if (q.includes('цей тиждень') || q.includes('поточний тиждень') || q === 'this_week') {
      return { ...getWeekBounds(0), rangeType: 'this_week' };
    }

    const single = parseSmartDate(q, referenceDate);
    if (single) {
      // Fetch the week containing this date so day grouping works nicely
      const dDow = single.dateObj.getDay();
      const dMonOff = dDow === 0 ? -6 : 1 - dDow;
      const mon = new Date(single.dateObj);
      mon.setDate(single.dateObj.getDate() + dMonOff);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      return {
        startIso: formatIsoDate(mon),
        endIso: formatIsoDate(sun),
        singleDate: single
      };
    }
  }

  return { ...getWeekBounds(0), rangeType: 'this_week' };
}

/**
 * Levenshtein distance for typo-tolerant Ukrainian surname matching
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/**
 * Matches a pupil in a list by exact substring or typo-tolerant surname match.
 * Throws a clear disambiguation error if multiple students match.
 */
function matchStudentInList(students, nameQuery, getNameFn = (s) => s.studentName || s.name) {
  const q = cleanStr(nameQuery);
  if (!q) {
    throw new Error('Ім\'я або прізвище учня не може бути порожнім.');
  }

  // 1. Exact full match
  const exactFull = students.filter(s => cleanStr(getNameFn(s)) === q);
  if (exactFull.length === 1) return exactFull[0];

  // 2. Substring or token match
  const qTokens = q.split(' ').filter(Boolean);
  const subMatches = students.filter(s => {
    const full = cleanStr(getNameFn(s));
    return qTokens.every(t => full.includes(t));
  });

  if (subMatches.length === 1) return subMatches[0];
  if (subMatches.length > 1) {
    // Check if one of them has exact surname match
    const exactSurname = subMatches.filter(s => {
      const firstWord = cleanStr(getNameFn(s)).split(' ')[0];
      return firstWord === qTokens[0];
    });
    if (exactSurname.length === 1) return exactSurname[0];

    throw new Error(
      `Неоднозначне прізвище "${nameQuery}" — знайдено кількох учнів: ${subMatches
        .map(s => getNameFn(s))
        .join(', ')}. Будь ласка, вкажіть прізвище та ім'я точніше.`
    );
  }

  // 3. Fuzzy surname match (max 1-2 character typo)
  if (qTokens.length === 1 && qTokens[0].length >= 4) {
    const target = qTokens[0];
    const fuzzyMatches = students.filter(s => {
      const surname = cleanStr(getNameFn(s)).split(' ')[0];
      return levenshtein(target, surname) <= 1;
    });
    if (fuzzyMatches.length === 1) return fuzzyMatches[0];
  }

  const available = students.map(s => getNameFn(s)).join(', ');
  throw new Error(`Учня "${nameQuery}" не знайдено у класі. Доступні учні: ${available}`);
}

module.exports = {
  cleanStr,
  formatIsoDate,
  formatDmDate,
  formatDmyDate,
  matchDayOfWeek,
  parseSmartDate,
  resolveDateRange,
  matchStudentInList
};

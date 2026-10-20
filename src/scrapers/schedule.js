const cheerio = require('cheerio');
const {
  cleanStr,
  matchDayOfWeek,
  parseSmartDate,
  resolveDateRange,
  formatIsoDate
} = require('../core/normalizer');

const UKRAINIAN_DAYS = [
  'неділя',
  'понеділок',
  'вівторок',
  'середа',
  'четвер',
  "п'ятниця",
  'субота'
];

function getDayOfWeekFromDmy(dmyStr) {
  const m = String(dmyStr || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return '';
  const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return UKRAINIAN_DAYS[dt.getDay()] || '';
}

/**
 * Fetches rich timetable rows from /ClassDetail/TeacherTimetableInfo for any date range.
 * Includes time, subject, class, lessonId, topic, notes, attendance status, and homework status!
 */
async function fetchTimetableRange(client, startIso, endIso) {
  const url = `/ClassDetail/TeacherTimetableInfo?StartDate=${encodeURIComponent(startIso)}&EndDate=${encodeURIComponent(endIso)}`;
  const res = await client.get(url);
  const $ = cheerio.load(res.data);

  const dataTable = $('table')
    .filter((_, tbl) => {
      const text = $(tbl).find('thead').text();
      return text.includes('Дата') && text.includes('Предмет') && text.includes('Тема');
    })
    .first();

  if (!dataTable.length) {
    return [];
  }

  const lessons = [];
  dataTable.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 10) return;

    const dateDmy = $(tds[0]).text().replace(/\s+/g, ' ').trim();
    const time = $(tds[1]).text().replace(/\s+/g, ' ').trim();
    const teacher = $(tds[2]).text().replace(/\s+/g, ' ').trim();
    const subject = $(tds[3]).text().replace(/\s+/g, ' ').trim();
    const className = $(tds[4]).text().replace(/\s+/g, ' ').trim();
    const topic = $(tds[5]).text().replace(/\s+/g, ' ').trim();
    const notes = $(tds[6]).text().replace(/\s+/g, ' ').trim();
    const attText = $(tds[7]).text().replace(/\s+/g, ' ').trim();
    const filesText = $(tds[8]).text().replace(/\s+/g, ' ').trim();
    const hwText = $(tds[9]).text().replace(/\s+/g, ' ').trim();

    const editLink =
      $(tr).find('[data-url*="LessonEdit"]').attr('data-url') ||
      $(tr).find('a[href*="LessonEdit"]').attr('href') ||
      '';
    const idMatch = editLink.match(/lessonID=(\d+)/i);
    const lessonId = idMatch ? idMatch[1] : null;

    if (!dateDmy) return;

    const dayOfWeek = getDayOfWeekFromDmy(dateDmy);
    const dm = dateDmy.slice(0, 5);

    lessons.push({
      lessonId,
      date: dm,
      fullDate: dateDmy,
      dayOfWeek,
      time,
      subject,
      className,
      topic: topic || '',
      notes: notes || '',
      hasAttendance: attText.toLowerCase() === 'так',
      hasFiles: filesText.toLowerCase() === 'так',
      hasHomework: hwText.toLowerCase() === 'так',
      teacher
    });
  });

  // Compute lessonNumberForClassOnDate (1 or 2 when paired lessons exist on the same day)
  const counters = new Map();
  for (const l of lessons) {
    const key = `${l.fullDate}|${l.className}|${l.subject}`;
    const num = (counters.get(key) || 0) + 1;
    counters.set(key, num);
    l.lessonNumber = num;
  }

  return lessons;
}

/**
 * Enhanced getSchedule:
 * Supports any date, week ("цей тиждень", "наступний тиждень", "минулий тиждень"),
 * relative dates ("сьогодні", "завтра", "вчора"), Ukrainian days of week in any grammatical case,
 * plus filtering by class and/or subject.
 */
async function getSchedule(client, metadata, options = {}) {
  const filterObj =
    typeof options === 'string' || options === null ? { filter: options } : options || {};

  const rawFilter = filterObj.filter || filterObj.day || null;
  const classFilter = filterObj.class_name || null;
  const subjectFilter = filterObj.subject || null;
  const startDate = filterObj.start_date || null;
  const endDate = filterObj.end_date || null;

  const range = resolveDateRange({
    filter: rawFilter,
    startDate,
    endDate
  });

  let lessons = await fetchTimetableRange(client, range.startIso, range.endIso);

  // If singleDate was parsed (e.g. "сьогодні", "завтра", "вівторок", "19.10"), filter to that date
  if (range.singleDate) {
    lessons = lessons.filter(l => l.date === range.singleDate.dm);
  } else if (rawFilter && !range.rangeType) {
    // Check if rawFilter is a day of week or class/subject query
    const dow = matchDayOfWeek(rawFilter);
    if (dow) {
      lessons = lessons.filter(l => l.dayOfWeek === dow.canonical);
    } else {
      const q = cleanStr(rawFilter);
      lessons = lessons.filter(
        l => cleanStr(l.className).includes(q) || cleanStr(l.subject).includes(q)
      );
    }
  }

  if (classFilter) {
    const cQ = cleanStr(classFilter).replace(/клас/g, '').trim();
    lessons = lessons.filter(l => cleanStr(l.className).includes(cQ));
  }

  if (subjectFilter) {
    const sQ = cleanStr(subjectFilter);
    lessons = lessons.filter(l => cleanStr(l.subject).includes(sQ));
  }

  // Group by day
  const daysMap = new Map();
  for (const l of lessons) {
    const dayKey = `${l.dayOfWeek}, ${l.fullDate}`;
    if (!daysMap.has(dayKey)) {
      daysMap.set(dayKey, {
        day: dayKey,
        dayOfWeek: l.dayOfWeek,
        date: l.date,
        fullDate: l.fullDate,
        lessonsCount: 0,
        lessons: []
      });
    }
    const group = daysMap.get(dayKey);
    group.lessons.push({
      lessonId: l.lessonId,
      lessonNumber: l.lessonNumber,
      time: l.time,
      subject: l.subject,
      className: l.className,
      topic: l.topic,
      hasHomework: l.hasHomework,
      hasAttendance: l.hasAttendance
    });
    group.lessonsCount = group.lessons.length;
  }

  const days = Array.from(daysMap.values());

  return {
    teacher: metadata.teacherName,
    periodRange: { start: range.startIso, end: range.endIso },
    filterApplied: rawFilter || classFilter || subjectFilter || null,
    totalDays: days.length,
    totalLessons: lessons.length,
    days,
    lessons
  };
}

/**
 * Global Audit Tool: audit_lessons_filling
 * Checks all classes & subjects in a single fast request to find lessons missing topic, homework, or attendance.
 */
async function auditLessonsFilling(client, metadata, options = {}) {
  const now = new Date();
  const defaultStart =
    now.getMonth() >= 7 ? `${now.getFullYear()}-09-01` : `${now.getFullYear()}-01-01`;
  const defaultEnd = formatIsoDate(now);

  const startParsed = options.start_date ? parseSmartDate(options.start_date, now) : null;
  const endParsed = options.end_date ? parseSmartDate(options.end_date, now) : null;

  const startIso = startParsed ? startParsed.iso : defaultStart;
  const endIso = endParsed ? endParsed.iso : defaultEnd;

  let allLessons = await fetchTimetableRange(client, startIso, endIso);

  if (options.class_name) {
    const cQ = cleanStr(options.class_name).replace(/клас/g, '').trim();
    allLessons = allLessons.filter(l => cleanStr(l.className).includes(cQ));
  }
  if (options.subject) {
    const sQ = cleanStr(options.subject);
    allLessons = allLessons.filter(l => cleanStr(l.subject).includes(sQ));
  }

  const missingTopic = allLessons.filter(l => !l.topic || l.topic.trim() === '');
  const missingHomework = allLessons.filter(l => !l.hasHomework);
  const missingAttendance = allLessons.filter(l => !l.hasAttendance);

  const total = allLessons.length;
  const pct = count => (total > 0 ? Math.round(((total - count) / total) * 100) : 100);

  const unfilledLessons = allLessons
    .filter(l => !l.topic || !l.hasHomework || !l.hasAttendance)
    .map(l => {
      const issues = [];
      if (!l.topic) issues.push('Немає теми');
      if (!l.hasHomework) issues.push('Немає ДЗ');
      if (!l.hasAttendance) issues.push('Не відмічено відвідуваність');
      return {
        lessonId: l.lessonId,
        date: l.fullDate,
        dayOfWeek: l.dayOfWeek,
        time: l.time,
        className: l.className,
        subject: l.subject,
        lessonNumber: l.lessonNumber,
        topic: l.topic || '(ПОРОЖНЬО)',
        issues
      };
    });

  return {
    teacher: metadata.teacherName,
    auditPeriod: { start: startIso, end: endIso },
    summary: {
      totalLessonsChecked: total,
      topicFilledPercent: `${pct(missingTopic.length)}%`,
      homeworkFilledPercent: `${pct(missingHomework.length)}%`,
      attendanceFilledPercent: `${pct(missingAttendance.length)}%`,
      missingTopicCount: missingTopic.length,
      missingHomeworkCount: missingHomework.length,
      missingAttendanceCount: missingAttendance.length,
      totalLessonsWithGaps: unfilledLessons.length
    },
    unfilledLessons
  };
}

module.exports = {
  getSchedule,
  auditLessonsFilling,
  fetchTimetableRange
};

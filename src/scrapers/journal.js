const cheerio = require('cheerio');
const { matchStudentInList, parseSmartDate } = require('../core/normalizer');

function isAbsenceMark(markStr) {
  const m = String(markStr || '').trim().toUpperCase();
  return m === 'Н' || m === 'N';
}

/**
 * Parses the full class journal grid (/Diary/DiaryView) with token-efficient structure,
 * column types, lesson numbers on paired days, and rich class analytics.
 */
async function getClassJournal(client, metadata, targetJournal, options = {}) {
  const { studentName = null, dateFrom = null, dateTo = null, cache = null } = options;
  const periodId = targetJournal.schoolPeriodId || metadata.schoolPeriodId;
  const url = `/Diary/DiaryView?View=1&ViewID=${metadata.teacherId}&SchoolPeriodID=${periodId}&TeacherID=${metadata.teacherId}&DisciplineID=${targetJournal.disciplineId}&ClassID=${targetJournal.classId}`;

  const cacheKey = `diary_view:${targetJournal.classId}:${targetJournal.disciplineId}:${periodId}`;
  const htmlData = cache
    ? await cache.getOrFetch(cacheKey, async () => (await client.get(url)).data, 45 * 1000)
    : (await client.get(url)).data;

  const $ = cheerio.load(htmlData);

  // Extract available periods (semesters) from the page selector
  const availablePeriods = [];
  $('select[name="SchoolPeriodID"] option, select#SchoolPeriodID option').each((_, opt) => {
    availablePeriods.push({
      id: $(opt).attr('value'),
      name: $(opt).text().replace(/\s+/g, ' ').trim(),
      isSelected: $(opt).is(':selected')
    });
  });

  // Target the actual student matrix table (which has 2 thead rows: dates + column types)
  const journalTable = $('table')
    .filter((_, el) => {
      return (
        $(el).find('thead tr').length >= 2 &&
        $(el).text().includes('Сер. бал') &&
        $(el).text().includes('Відвідування')
      );
    })
    .first();

  if (!journalTable.length) {
    return {
      className: targetJournal.className,
      disciplineName: targetJournal.disciplineName,
      message: 'Таблицю журналу не знайдено або вона порожня.'
    };
  }

  const headerRow0 = journalTable.find('thead tr').eq(0).find('th');
  const headerRow1 = journalTable.find('thead tr').eq(1).find('th');

  const columns = [];
  const dateCounters = new Map();

  headerRow0.each((colIdx, th) => {
    if (colIdx < 3) return;
    const t = $(th).text().replace(/\s+/g, ' ').trim();
    const dateMatch = t.match(/(\d{2}\.\d{2})/);
    const dateStr = dateMatch ? dateMatch[1] : t;

    const editLink = $(th).find('[data-url*="DiaryEdit"]').attr('data-url') || '';
    const m = editLink.match(/timetableid=(\d+)/i);
    const lessonId = m ? m[1] : null;

    const topic = ($(th).attr('title') || '').replace(/\s+/g, ' ').trim();
    const colType = headerRow1.eq(colIdx).text().replace(/\s+/g, ' ').trim() || 'Поточна';

    const lessonNum = (dateCounters.get(dateStr) || 0) + 1;
    dateCounters.set(dateStr, lessonNum);

    columns.push({
      index: colIdx - 3,
      date: dateStr,
      lessonNumber: lessonNum,
      lessonId,
      columnType: colType,
      topic
    });
  });

  // Optional date range filtering on columns
  let activeColIndices = null;
  if (dateFrom || dateTo) {
    const now = new Date();
    const fromParsed = dateFrom ? parseSmartDate(dateFrom, now) : null;
    const toParsed = dateTo ? parseSmartDate(dateTo, now) : null;

    activeColIndices = new Set();
    columns.forEach(c => {
      const cParsed = parseSmartDate(c.date, now);
      if (!cParsed) return;
      if (fromParsed && cParsed.dateObj < fromParsed.dateObj) return;
      if (toParsed && cParsed.dateObj > toParsed.dateObj) return;
      activeColIndices.add(c.index);
    });
  }

  const filteredColumns = activeColIndices
    ? columns.filter(c => activeColIndices.has(c.index))
    : columns;

  const uniqueDates = [...new Set(filteredColumns.map(c => c.date))];

  // Parse students
  const students = [];
  journalTable.find('tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;

    const name = $(tds[0]).text().replace(/\s+/g, ' ').trim();
    const avg = $(tds[1]).text().replace(/\s+/g, ' ').trim();
    const att = $(tds[2]).text().replace(/\s+/g, ' ').trim();

    if (!name) return;

    const marks = [];
    tds.slice(3).each((colIdx, td) => {
      if (activeColIndices && !activeColIndices.has(colIdx)) return;
      const mark = $(td).text().replace(/\s+/g, ' ').trim() || $(td).find('input').val() || '';
      const colInfo = columns[colIdx];
      if (mark && colInfo) {
        marks.push({
          date: colInfo.date,
          lessonNumber: colInfo.lessonNumber,
          lessonId: colInfo.lessonId,
          columnType: colInfo.columnType,
          mark
        });
      }
    });

    const absencesCount = marks.filter(m => isAbsenceMark(m.mark)).length;
    const gradesCount = marks.filter(m => !isAbsenceMark(m.mark)).length;

    students.push({
      name,
      averageGrade: avg && avg !== '—' ? avg : null,
      attendance: att || null,
      gradesCount,
      absencesCount,
      marks
    });
  });

  // Targeted single student profile
  if (studentName) {
    const targetStudent = matchStudentInList(students, studentName, s => s.name);
    const colByLessonId = new Map(columns.map(c => [c.lessonId, c]));

    const absences = targetStudent.marks.filter(m => isAbsenceMark(m.mark));
    const grades = targetStudent.marks.filter(m => !isAbsenceMark(m.mark));

    return {
      className: targetJournal.className,
      disciplineName: targetJournal.disciplineName,
      student: {
        name: targetStudent.name,
        averageGrade: targetStudent.averageGrade,
        attendance: targetStudent.attendance,
        totalMarksGiven: grades.length,
        totalAbsencesCount: absences.length,
        absenceDates: absences.map(a => a.date),
        marksHistory: targetStudent.marks.map(m => ({
          ...m,
          topic: (colByLessonId.get(m.lessonId) || {}).topic || ''
        }))
      }
    };
  }

  // Class Analytics
  const validAvgs = students.map(s => parseFloat(s.averageGrade)).filter(n => !isNaN(n));
  const classAvg = validAvgs.length
    ? Number((validAvgs.reduce((a, b) => a + b, 0) / validAvgs.length).toFixed(2))
    : null;

  const topStudents = students
    .filter(s => parseFloat(s.averageGrade) >= 10)
    .map(s => ({ name: s.name, average: s.averageGrade, gradesCount: s.gradesCount }));

  const atRiskStudents = students
    .filter(s => {
      const avg = parseFloat(s.averageGrade);
      return (!isNaN(avg) && avg < 6) || s.absencesCount >= 3;
    })
    .map(s => ({
      name: s.name,
      average: s.averageGrade || '(немає)',
      gradesCount: s.gradesCount,
      absencesCount: s.absencesCount
    }));

  const needsMoreGradesStudents = students
    .filter(s => s.gradesCount < 3)
    .map(s => ({
      name: s.name,
      gradesCount: s.gradesCount,
      average: s.averageGrade || '(немає)'
    }));

  return {
    className: targetJournal.className,
    disciplineName: targetJournal.disciplineName,
    availablePeriods: availablePeriods.length ? availablePeriods : undefined,
    studentsCount: students.length,
    classAverageGrade: classAvg,
    analytics: {
      topStudents,
      atRiskStudents,
      needsMoreGradesStudents,
      unratedCount: students.filter(s => !s.averageGrade).length
    },
    lessonDates: uniqueDates,
    columns: filteredColumns,
    students
  };
}

/**
 * New Tool: get_student_dossier
 * Builds a complete multi-subject report for a student across all subjects taught by the teacher in that class.
 */
async function getStudentDossier(client, metadataManager, { studentName, classNameOrId, cache }) {
  if (!studentName || !classNameOrId) {
    throw new Error('Для формування досьє учня необхідно вказати student_name та class_name_or_id.');
  }

  const metadata = await metadataManager.getMetadata();
  const classJournals = metadataManager.findJournalsByClass(classNameOrId);

  const subjectReports = await Promise.all(
    classJournals.map(async journal => {
      const res = await getClassJournal(client, metadata, journal, {
        studentName,
        cache
      });
      return {
        subject: journal.disciplineName,
        disciplineId: journal.disciplineId,
        ...res.student
      };
    })
  );

  const resolvedName = subjectReports[0] ? subjectReports[0].name : studentName;
  const resolvedClass = classJournals[0].className;

  return {
    studentName: resolvedName,
    className: resolvedClass,
    subjectsCount: subjectReports.length,
    subjects: subjectReports
  };
}

module.exports = {
  getClassJournal,
  getStudentDossier,
  isAbsenceMark
};

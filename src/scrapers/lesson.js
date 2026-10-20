const cheerio = require('cheerio');
const { parseSmartDate, cleanStr } = require('../core/normalizer');
const { serializeAspNetForm, assertNoFormErrors } = require('../core/form-utils');

function cleanHomeworkText(raw) {
  if (!raw) return '';
  return raw
    .replace(/Домашнє завдання/gi, '')
    .replace(/\b\d+\/\d+\b/g, '')
    .replace(/[✔️✔]\s*\d*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scrapes the full lesson plan (/TeacherLesson) for a class and subject with caching.
 */
async function getLessonPlan(client, metadata, targetJournal, options = {}) {
  const { cache = null, forceRefresh = false } = options;
  const periodId = targetJournal.schoolPeriodId || metadata.schoolPeriodId;
  const url = `/TeacherLesson?View=1&ViewID=${metadata.teacherId}&SchoolPeriodID=${periodId}&TeacherID=${metadata.teacherId}&DisciplineID=${targetJournal.disciplineId}&ClassID=${targetJournal.classId}`;

  const cacheKey = `lesson_plan:${targetJournal.classId}:${targetJournal.disciplineId}:${periodId}`;
  if (forceRefresh && cache) {
    cache.invalidatePrefix(cacheKey);
  }

  const htmlData = cache
    ? await cache.getOrFetch(cacheKey, async () => (await client.get(url)).data, 60 * 1000)
    : (await client.get(url)).data;

  const $ = cheerio.load(htmlData);

  const lessons = [];
  const dateCounters = new Map();

  $('table tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;

    const num = $(tds[0]).text().replace(/\s+/g, ' ').trim();
    const date = $(tds[1]).text().replace(/\s+/g, ' ').trim();
    const col2 = $(tds[2]).text().replace(/\s+/g, ' ').trim();
    const col3 = tds.length >= 4 ? $(tds[3]).text().replace(/\s+/g, ' ').trim() : '';
    const rawHomework = tds.length >= 5 ? $(tds[4]).text().replace(/\s+/g, ' ').trim() : '';

    const editButton =
      $(tr).find('[data-url*="LessonEdit"]').attr('data-url') ||
      $(tr).find('a[href*="LessonEdit"]').attr('href') ||
      '';
    const lessonIdMatch = editButton.match(/lessonID=(\d+)/i);
    const lessonId = lessonIdMatch ? lessonIdMatch[1] : null;

    const dmMatch = date ? date.match(/(\d{2}\.\d{2})/) : null;
    if (dmMatch) {
      const dm = dmMatch[1];
      const idxOnDate = (dateCounters.get(dm) || 0) + 1;
      dateCounters.set(dm, idxOnDate);

      lessons.push({
        lessonNumber: num,
        lessonIndexOnDate: idxOnDate,
        lessonId,
        date,
        dateDm: dm,
        time: col2.match(/^\d{2}:\d{2}\s*-\s*\d{2}:\d{2}$/) ? col2 : '',
        topic: col3 || col2,
        homework: cleanHomeworkText(rawHomework)
      });
    }
  });

  return {
    className: targetJournal.className,
    disciplineName: targetJournal.disciplineName,
    classId: targetJournal.classId,
    disciplineId: targetJournal.disciplineId,
    totalLessons: lessons.length,
    lessons
  };
}

/**
 * Universal Resolver: finds a lesson by ID or by (class + subject + date + lessonNumber).
 * Strictly validates date parsing so an invalid date never matches the entire semester!
 */
async function resolveLesson(
  client,
  metadataManager,
  { lessonId, classNameOrId, subjectOrId, date, lessonNumber = 1, cache = null }
) {
  if (lessonId) {
    return {
      lessonId: String(lessonId).trim(),
      resolvedBy: 'id'
    };
  }

  if (!classNameOrId || !subjectOrId) {
    throw new Error(
      'Потрібно передати lesson_id АБО комбінацію (class_name_or_id, subject_or_id та date).'
    );
  }

  if (!date) {
    throw new Error(
      'Для пошуку уроку за класом та предметом обов\'язково вкажіть дату (наприклад, "05.10", "сьогодні", "завтра", "вівторок").'
    );
  }

  const parsedDate = parseSmartDate(date);
  if (!parsedDate || !parsedDate.dm) {
    throw new Error(
      `Не вдалося розпізнати дату "${date}". Використовуйте формат ДД.ММ (наприклад "05.10"), РРРР-ММ-ДД, або "сьогодні", "завтра", "вчора", день тижня.`
    );
  }

  const metadata = await metadataManager.getMetadata();
  const targetJournal = metadataManager.findJournal(classNameOrId, subjectOrId);
  const plan = await getLessonPlan(client, metadata, targetJournal, { cache });

  const matched = plan.lessons.filter(l => l.dateDm === parsedDate.dm);
  if (matched.length === 0) {
    const sampleDates = [...new Set(plan.lessons.map(l => l.dateDm))].slice(0, 15).join(', ');
    throw new Error(
      `Урок на дату "${date}" (${parsedDate.dm}) для ${targetJournal.className} (${targetJournal.disciplineName}) не знайдено в календарному плані. Доступні дати: ${sampleDates}...`
    );
  }

  const requestedIdx = Math.max(1, Number(lessonNumber) || 1);
  if (requestedIdx > matched.length) {
    throw new Error(
      `На дату ${parsedDate.dm} у ${targetJournal.className} (${targetJournal.disciplineName}) є лише ${matched.length} урок(ів), а ви вказали lesson_number=${requestedIdx}.`
    );
  }

  const targetLesson = matched[requestedIdx - 1];

  return {
    lessonId: String(targetLesson.lessonId),
    lessonNumberInPlan: targetLesson.lessonNumber,
    lessonIndexOnDate: requestedIdx,
    totalLessonsOnDate: matched.length,
    date: targetLesson.date,
    time: targetLesson.time,
    topic: targetLesson.topic,
    homework: targetLesson.homework,
    className: targetJournal.className,
    disciplineName: targetJournal.disciplineName,
    classId: targetJournal.classId,
    disciplineId: targetJournal.disciplineId,
    resolvedBy: 'search'
  };
}

/**
 * Filter and search lessons in the lesson plan
 */
async function findLessons(
  client,
  metadataManager,
  {
    classNameOrId,
    subjectOrId,
    date,
    dateFrom,
    dateTo,
    onlyPast = false,
    query = null,
    filterStatus = null,
    limit = 30,
    cache = null
  }
) {
  const metadata = await metadataManager.getMetadata();
  const targetJournal = metadataManager.findJournal(classNameOrId, subjectOrId);
  const plan = await getLessonPlan(client, metadata, targetJournal, { cache });

  let result = plan.lessons;
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

  if (date) {
    const parsed = parseSmartDate(date, now);
    if (!parsed) {
      throw new Error(`Не вдалося розпізнати дату "${date}".`);
    }
    result = result.filter(l => l.dateDm === parsed.dm);
  }

  if (dateFrom || dateTo || onlyPast) {
    const fromParsed = dateFrom ? parseSmartDate(dateFrom, now) : null;
    const toParsed = dateTo ? parseSmartDate(dateTo, now) : null;

    result = result.filter(l => {
      const lParsed = parseSmartDate(l.date, now);
      if (!lParsed) return true;
      if (fromParsed && lParsed.dateObj < fromParsed.dateObj) return false;
      if (toParsed && lParsed.dateObj > toParsed.dateObj) return false;
      if (onlyPast && lParsed.dateObj > todayMidnight) return false;
      return true;
    });
  }

  if (query) {
    const q = cleanStr(query);
    result = result.filter(
      l => cleanStr(l.topic).includes(q) || cleanStr(l.homework).includes(q)
    );
  }

  if (filterStatus) {
    const s = cleanStr(filterStatus);
    if (s === 'missing_topic' || s === 'no_topic') {
      result = result.filter(l => !l.topic || l.topic.trim() === '');
    } else if (s === 'missing_homework' || s === 'no_homework') {
      result = result.filter(l => !l.homework || l.homework.trim() === '');
    } else if (s === 'unfilled') {
      result = result.filter(
        l => !l.topic || l.topic.trim() === '' || !l.homework || l.homework.trim() === ''
      );
    }
  }

  return {
    className: targetJournal.className,
    disciplineName: targetJournal.disciplineName,
    filterApplied: {
      date: date || null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      onlyPast: Boolean(onlyPast),
      query: query || null,
      filterStatus: filterStatus || null
    },
    totalFound: result.length,
    lessons: result.slice(0, Number(limit) || 30).map(l => ({
      lessonId: l.lessonId,
      lessonNumberInPlan: l.lessonNumber,
      lessonIndexOnDate: l.lessonIndexOnDate,
      date: l.date,
      time: l.time,
      topic: l.topic,
      homework: l.homework
    }))
  };
}

/**
 * Helper that reads current LessonEdit form and builds the diff + execute closure
 */
async function prepareLessonUpdate(client, metadataManager, options) {
  const {
    lessonId: inputLessonId,
    classNameOrId,
    subjectOrId,
    date,
    lessonNumber = 1,
    topic,
    homework,
    notes,
    videoLink,
    deadlineDate,
    cache = null
  } = options;

  const resolved = await resolveLesson(client, metadataManager, {
    lessonId: inputLessonId,
    classNameOrId,
    subjectOrId,
    date,
    lessonNumber,
    cache
  });

  const lessonId = resolved.lessonId;
  const editUrl = `/Timetable/LessonEdit?lessonID=${lessonId}&lessonType=1`;
  const res = await client.get(editUrl);
  const $ = cheerio.load(res.data);

  const form = $('form[action*="ClassLessonEdit"]').first();
  if (!form.length) {
    throw new Error(`Форма редагування уроку ID ${lessonId} не знайдена.`);
  }

  const currentTopic = form.find('#Topic').val() || '';
  const currentNotes = form.find('#Notes').val() || '';
  const currentVideo = form.find('#VideoConferenceLink').val() || '';
  const currentHomework = form.find('#LessonPupils_0__Homework').val() || '';
  const currentDeadline = form.find('#HomeworkDeadline').val() || '';
  const pupilsCount = form.find('[name^="LessonPupils["][name$=".ID"]').length;

  const warnings = [];
  if (topic !== undefined && currentTopic && currentTopic !== topic) {
    warnings.push(`Увага: поточна тема уроку ("${currentTopic}") буде замінена на нову.`);
  }
  if (homework !== undefined && currentHomework && currentHomework !== homework) {
    warnings.push(`Увага: поточне ДЗ ("${currentHomework}") буде замінено на нове.`);
  }

  let normalizedDeadline = deadlineDate;
  if (deadlineDate) {
    const parsedDl = parseSmartDate(deadlineDate);
    if (parsedDl && parsedDl.iso) {
      normalizedDeadline = parsedDl.iso;
    }
  }

  const previewDiff = {
    lessonId,
    lessonInfo: {
      date: resolved.date || '(з форми)',
      time: resolved.time || '',
      lessonIndexOnDate: resolved.lessonIndexOnDate || 1,
      totalLessonsOnDate: resolved.totalLessonsOnDate || 1,
      className: resolved.className || '',
      disciplineName: resolved.disciplineName || ''
    },
    currentData: {
      topic: currentTopic || '(порожньо)',
      homework: currentHomework || '(порожньо)',
      notes: currentNotes || '(порожньо)',
      videoLink: currentVideo || '(порожньо)',
      deadline: currentDeadline || '(немає)',
      pupilsCount
    },
    proposedChanges: {
      topic: topic !== undefined ? topic : '(без змін)',
      homework: homework !== undefined ? homework : '(без змін)',
      notes: notes !== undefined ? notes : '(без змін)',
      videoLink: videoLink !== undefined ? videoLink : '(без змін)',
      deadline: normalizedDeadline !== undefined ? normalizedDeadline : '(без змін)'
    },
    warnings: warnings.length > 0 ? warnings : undefined
  };

  const executeWrite = async () => {
    const overrides = {};
    if (topic !== undefined) overrides['Topic'] = topic;
    if (notes !== undefined) overrides['Notes'] = notes;
    if (videoLink !== undefined) overrides['VideoConferenceLink'] = videoLink;
    if (normalizedDeadline !== undefined) {
      overrides['HomeworkDeadline'] = normalizedDeadline;
      overrides['IsHomeworkDeadline'] = Boolean(normalizedDeadline);
    }
    if (homework !== undefined) {
      for (let i = 0; i < pupilsCount; i++) {
        overrides[`LessonPupils[${i}].Homework`] = homework;
      }
    }

    const params = serializeAspNetForm($, form, overrides);
    const action = form.attr('action') || '/Timetable/ClassLessonEdit';

    const postRes = await client.post(action, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${client.baseURL}${editUrl}`
      }
    });

    assertNoFormErrors(postRes.data, `Оновлення уроку ID ${lessonId}`);

    if (cache && resolved.classId) {
      cache.invalidatePrefix(`lesson_plan:${resolved.classId}`);
      cache.invalidatePrefix(`diary_view:${resolved.classId}`);
    }

    // Post-write verification read
    const verifyRes = await client.get(editUrl);
    const $v = cheerio.load(verifyRes.data);
    const verifiedTopic = $v('#Topic').val() || '';
    const verifiedHomework = $v('#LessonPupils_0__Homework').val() || '';

    return {
      status: 'SUCCESS',
      message: `Урок ID ${lessonId} успішно збережено та перевірено!`,
      lessonInfo: previewDiff.lessonInfo,
      verifiedDataInJournal: {
        topic: verifiedTopic,
        homework: verifiedHomework
      }
    };
  };

  return {
    resolved,
    previewDiff,
    executeWrite
  };
}

/**
 * Tool: update_lesson_content
 * Enforces two-phase preview -> confirm workflow.
 */
async function updateLessonContent(client, metadataManager, options) {
  const {
    confirm = false,
    previewToken = null,
    previewStore = null,
    cache = null
  } = options;

  const payloadKey = {
    lessonId: options.lessonId || null,
    classNameOrId: options.classNameOrId || null,
    subjectOrId: options.subjectOrId || null,
    date: options.date || null,
    lessonNumber: options.lessonNumber || 1,
    topic: options.topic,
    homework: options.homework,
    notes: options.notes,
    videoLink: options.videoLink,
    deadlineDate: options.deadlineDate
  };

  // Check if confirmed AND a valid preview already exists
  if (confirm && previewStore) {
    const existingPreview = previewStore.findValid(
      'update_lesson_content',
      payloadKey,
      previewToken
    );
    if (existingPreview) {
      previewStore.consume(existingPreview.token);
      if (typeof existingPreview.executeFn === 'function') {
        return await existingPreview.executeFn();
      }
      const prep = await prepareLessonUpdate(client, metadataManager, { ...options, cache });
      return await prep.executeWrite();
    }
  }

  // Otherwise prepare preview (even if agent passed confirm:true without prior preview!)
  const prepared = await prepareLessonUpdate(client, metadataManager, { ...options, cache });

  let token = null;
  if (previewStore) {
    token = previewStore.register({
      toolName: 'update_lesson_content',
      payloadKey,
      summary: `Оновлення уроку ${prepared.previewDiff.lessonInfo.className} (${prepared.previewDiff.lessonInfo.disciplineName}) за ${prepared.previewDiff.lessonInfo.date}`,
      executeFn: prepared.executeWrite
    });
  }

  const blockedDirectConfirm = confirm && previewStore;

  return {
    status: 'PREVIEW_ONLY (Жодних змін до журналу НЕ внесено)',
    previewToken: token,
    ...prepared.previewDiff,
    notice: blockedDirectConfirm
      ? '🛡️ Захист журналу: ви викликали confirm: true без попереднього Preview. Спочатку покажіть цей попередній перегляд користувачу, а після його згоди викличте confirm_pending_action з preview_token (або повторіть виклик з confirm: true та preview_token).'
      : 'Це безпечний попередній перегляд. Покажіть ці зміни вчителю. Після підтвердження викличте confirm_pending_action({ preview_token }) або повторіть виклик із confirm: true та preview_token.'
  };
}

/**
 * Tool: batch_update_lessons
 * Prepares and executes batch lesson updates with shared cached lesson plan and single preview token.
 */
async function batchUpdateLessons(client, metadataManager, options) {
  const {
    classNameOrId,
    subjectOrId,
    lessons,
    confirm = false,
    previewToken = null,
    previewStore = null,
    cache = null
  } = options;

  if (!lessons || !Array.isArray(lessons) || lessons.length === 0) {
    throw new Error('Параметр lessons має бути непорожнім масивом оновлень.');
  }

  const payloadKey = { classNameOrId, subjectOrId, lessons };

  if (confirm && previewStore) {
    const existingPreview = previewStore.findValid(
      'batch_update_lessons',
      payloadKey,
      previewToken
    );
    if (existingPreview && typeof existingPreview.executeFn === 'function') {
      previewStore.consume(existingPreview.token);
      return await existingPreview.executeFn();
    }
  }

  const preparedList = [];
  for (const item of lessons) {
    const prep = await prepareLessonUpdate(client, metadataManager, {
      lessonId: item.lesson_id,
      classNameOrId: item.class_name_or_id || classNameOrId,
      subjectOrId: item.subject_or_id || subjectOrId,
      date: item.date,
      lessonNumber: item.lesson_number || 1,
      topic: item.topic,
      homework: item.homework,
      notes: item.notes,
      videoLink: item.video_link,
      deadlineDate: item.deadline_date,
      cache
    });
    preparedList.push(prep);
  }

  const executeBatch = async () => {
    const results = [];
    for (const prep of preparedList) {
      results.push(await prep.executeWrite());
    }
    return {
      status: 'BATCH_SUCCESS',
      totalUpdated: results.length,
      results
    };
  };

  let token = null;
  if (previewStore) {
    token = previewStore.register({
      toolName: 'batch_update_lessons',
      payloadKey,
      summary: `Пакетне оновлення ${preparedList.length} уроків (${classNameOrId || ''}, ${subjectOrId || ''})`,
      executeFn: executeBatch
    });
  }

  return {
    status: 'BATCH_PREVIEW_ONLY (Жодних змін до журналу НЕ внесено)',
    previewToken: token,
    totalLessons: preparedList.length,
    previews: preparedList.map(p => p.previewDiff),
    notice:
      'Це безпечний попередній перегляд пакетного оновлення. Покажіть таблицю змін вчителю. Після підтвердження викличте confirm_pending_action({ preview_token }) або повторіть виклик із confirm: true та preview_token.'
  };
}

module.exports = {
  getLessonPlan,
  resolveLesson,
  findLessons,
  updateLessonContent,
  batchUpdateLessons
};

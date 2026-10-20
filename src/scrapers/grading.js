const cheerio = require('cheerio');
const { resolveLesson } = require('./lesson');
const { matchStudentInList } = require('../core/normalizer');
const { serializeAspNetForm, assertNoFormErrors } = require('../core/form-utils');
const { isAbsenceMark } = require('./journal');

/**
 * Extracts all pupils, columns, and mark types from the /Diary/DiaryEdit modal form
 */
async function getDiaryEditForm(client, { lessonId, classId, disciplineId, teacherId }) {
  let url = `/Diary/DiaryEdit?timetableid=${lessonId}`;
  if (classId) url += `&classid=${classId}`;
  if (disciplineId) url += `&disciplineid=${disciplineId}`;
  if (teacherId) url += `&teacherid=${teacherId}`;

  const res = await client.get(url);
  const $ = cheerio.load(res.data);
  const form = $('form[action*="DiaryEdit"]').first();

  // Extract column headers in this modal
  const columns = [];
  form.find('thead th').slice(1).each((colIdx, th) => {
    const title = $(th).text().replace(/\s+/g, ' ').trim();
    const markTypeId = $(th).find(`[name="Header[${colIdx}].MarkTypeID"]`).val() || '';
    columns.push({
      columnIndex: colIdx,
      title: title || 'Поточна',
      markTypeId
    });
  });

  // Extract available mark types that can be added
  const availableMarkTypes = [];
  $('#types option').each((_, opt) => {
    availableMarkTypes.push({
      id: $(opt).attr('value'),
      name: $(opt).text().replace(/\s+/g, ' ').trim()
    });
  });

  const pupils = [];
  form.find('[name$=".PupilID"]').each((i, el) => {
    const nameAttr = $(el).attr('name');
    const prefix = nameAttr.replace('.PupilID', '');
    const pupilId = $(el).val();

    const row = $(el).closest('tr');
    const studentName = row.find('td').first().text().replace(/\s+/g, ' ').trim();

    const cells = [];
    const colCount = Math.max(1, columns.length);
    for (let c = 0; c < colCount; c++) {
      const markInputName = `${prefix}.Cells[${c}].Mark`;
      const commentInputName = `${prefix}.Cells[${c}].Comment`;
      const valueIdInputName = `${prefix}.Cells[${c}].MarkTypeValueID`;

      const currentMark = row.find(`[name="${markInputName}"]`).val() || '';
      const rawComment = row.find(`[name="${commentInputName}"]`).val();
      const currentComment = rawComment && rawComment !== 'undefined' ? rawComment : '';

      cells.push({
        columnIndex: c,
        markInputName,
        commentInputName,
        valueIdInputName,
        currentMark,
        currentComment
      });
    }

    pupils.push({
      index: i,
      prefix,
      pupilId,
      studentName,
      currentMark: cells[0].currentMark,
      currentComment: cells[0].currentComment,
      markInputName: cells[0].markInputName,
      commentInputName: cells[0].commentInputName,
      valueIdInputName: cells[0].valueIdInputName,
      cells
    });
  });

  return { $, form, url, pupils, columns, availableMarkTypes };
}

/**
 * Helper: prepares mark updates and returns { previewDiff, executeWrite }
 */
async function prepareLessonMarks(client, metadataManager, options) {
  const {
    lessonId: inputLessonId,
    classNameOrId,
    subjectOrId,
    date,
    lessonNumber = 1,
    columnIndex = 0,
    marks,
    cache = null
  } = options;

  if (!marks || (Array.isArray(marks) && marks.length === 0)) {
    throw new Error('Параметр marks є обов\'язковим і не може бути порожнім.');
  }

  const metadata = await metadataManager.getMetadata();
  let classId = null;
  let disciplineId = null;
  const teacherId = metadata.teacherId;

  let resolvedLessonId = inputLessonId;
  let lessonInfo = null;

  if (!resolvedLessonId) {
    const resolved = await resolveLesson(client, metadataManager, {
      classNameOrId,
      subjectOrId,
      date,
      lessonNumber,
      cache
    });
    resolvedLessonId = resolved.lessonId;
    classId = resolved.classId;
    disciplineId = resolved.disciplineId;
    lessonInfo = {
      date: resolved.date,
      time: resolved.time,
      lessonIndexOnDate: resolved.lessonIndexOnDate,
      totalLessonsOnDate: resolved.totalLessonsOnDate,
      className: resolved.className,
      disciplineName: resolved.disciplineName,
      topic: resolved.topic
    };
  } else if (classNameOrId && subjectOrId) {
    const journal = metadataManager.findJournal(classNameOrId, subjectOrId);
    if (journal) {
      classId = journal.classId;
      disciplineId = journal.disciplineId;
    }
  }

  // Normalize marks array/object
  let marksList = [];
  if (Array.isArray(marks)) {
    marksList = marks;
  } else if (typeof marks === 'object') {
    marksList = Object.entries(marks).map(([name, val]) => ({
      student_name: name,
      mark: typeof val === 'object' && val !== null ? val.mark : val,
      comment: typeof val === 'object' && val !== null ? val.comment : '',
      clear: typeof val === 'object' && val !== null ? Boolean(val.clear) : val === null || val === ''
    }));
  }

  // Validate marks: 1..12 or clear (null / "" / clear: true)
  for (const item of marksList) {
    const isClear =
      item.clear === true ||
      item.mark === null ||
      item.mark === '' ||
      String(item.mark).toLowerCase() === 'clear' ||
      String(item.mark).toLowerCase() === 'видалити';

    if (!isClear) {
      const num = Number(item.mark);
      if (!Number.isInteger(num) || num < 1 || num > 12) {
        throw new Error(
          `Некоректна оцінка "${item.mark}" для учня "${item.student_name}". Дозволені цілі бали від 1 до 12 (або null / "" для видалення оцінки).`
        );
      }
    }
  }

  const { $, form, url, pupils, columns } = await getDiaryEditForm(client, {
    lessonId: resolvedLessonId,
    classId,
    disciplineId,
    teacherId
  });

  if (!form.length) {
    throw new Error(`Форма оцінювання DiaryEdit для уроку ID ${resolvedLessonId} не знайдена.`);
  }

  const colIdx = Math.max(0, Number(columnIndex) || 0);
  const warnings = [];
  const changes = [];

  for (const item of marksList) {
    const pupil = matchStudentInList(pupils, item.student_name, p => p.studentName);
    const cell = pupil.cells[colIdx] || pupil.cells[0];

    const isClear =
      item.clear === true ||
      item.mark === null ||
      item.mark === '' ||
      String(item.mark).toLowerCase() === 'clear' ||
      String(item.mark).toLowerCase() === 'видалити';

    const proposedMark = isClear ? '' : String(item.mark).trim();
    const proposedComment = isClear
      ? ''
      : item.comment !== undefined
      ? String(item.comment).trim()
      : cell.currentComment;

    if (!isClear && cell.currentMark && cell.currentMark !== proposedMark) {
      if (isAbsenceMark(cell.currentMark)) {
        warnings.push(
          `⚠️ Учня "${pupil.studentName}" відмічено як відсутнього ("${cell.currentMark}") на цьому уроці! Виставлення оцінки [${proposedMark}] замінить позначку "Н".`
        );
      } else {
        warnings.push(
          `⚠️ В учня "${pupil.studentName}" вже стоїть оцінка [${cell.currentMark}] — вона буде змінена на [${proposedMark}].`
        );
      }
    }

    changes.push({
      pupilId: pupil.pupilId,
      studentName: pupil.studentName,
      markInputName: cell.markInputName,
      commentInputName: cell.commentInputName,
      valueIdInputName: cell.valueIdInputName,
      currentMark: cell.currentMark || '(немає)',
      proposedMark,
      displayNewMark: isClear ? '🗑️ [ОЧИСТИТИ]' : proposedMark,
      currentComment: cell.currentComment || '',
      proposedComment
    });
  }

  const previewDiff = {
    lessonId: resolvedLessonId,
    lessonInfo: lessonInfo || { note: 'ID уроку задано прямо' },
    column: columns[colIdx] || { columnIndex: colIdx, title: 'Поточна' },
    totalPupilsInLesson: pupils.length,
    marksToUpdateCount: changes.length,
    changes: changes.map(c => ({
      student: c.studentName,
      currentMark: c.currentMark,
      newMark: c.displayNewMark,
      comment: c.proposedComment || '(без коментаря)'
    })),
    warnings: warnings.length > 0 ? warnings : undefined
  };

  const executeWrite = async () => {
    const overrides = {};
    for (const c of changes) {
      overrides[c.markInputName] = c.proposedMark;
      overrides[c.commentInputName] = c.proposedComment;
      overrides[c.valueIdInputName] = '0';
    }

    const params = serializeAspNetForm($, form, overrides);
    const action = form.attr('action') || '/Diary/DiaryEdit';

    const postRes = await client.post(action, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${client.baseURL}${url}`
      }
    });

    assertNoFormErrors(postRes.data, `Виставлення оцінок для уроку ID ${resolvedLessonId}`);

    if (cache && classId) {
      cache.invalidatePrefix(`diary_view:${classId}`);
    }

    // Post-write verification read
    const verifyForm = await getDiaryEditForm(client, {
      lessonId: resolvedLessonId,
      classId,
      disciplineId,
      teacherId
    });

    const verifiedChanges = changes.map(c => {
      const vp = verifyForm.pupils.find(p => p.pupilId === c.pupilId);
      const vCell = vp ? vp.cells[colIdx] || vp.cells[0] : null;
      return {
        student: c.studentName,
        verifiedMarkInJournal: vCell ? vCell.currentMark || '(очищено)' : c.proposedMark,
        verifiedCommentInJournal: vCell ? vCell.currentComment || '' : c.proposedComment
      };
    });

    return {
      status: 'SUCCESS',
      message: `Оцінки для уроку ID ${resolvedLessonId} успішно збережено та перевірено в журналі!`,
      lessonId: resolvedLessonId,
      lessonInfo: lessonInfo || undefined,
      updatedCount: changes.length,
      verifiedChanges
    };
  };

  return {
    previewDiff,
    executeWrite
  };
}

/**
 * Tool: set_lesson_marks
 * Enforces two-phase Preview -> Confirm workflow.
 */
async function setLessonMarks(client, metadataManager, options) {
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
    columnIndex: options.columnIndex || 0,
    marks: options.marks
  };

  if (confirm && previewStore) {
    const existingPreview = previewStore.findValid('set_lesson_marks', payloadKey, previewToken);
    if (existingPreview) {
      previewStore.consume(existingPreview.token);
      if (typeof existingPreview.executeFn === 'function') {
        return await existingPreview.executeFn();
      }
      const prep = await prepareLessonMarks(client, metadataManager, { ...options, cache });
      return await prep.executeWrite();
    }
  }

  const prepared = await prepareLessonMarks(client, metadataManager, { ...options, cache });

  let token = null;
  if (previewStore) {
    token = previewStore.register({
      toolName: 'set_lesson_marks',
      payloadKey,
      summary: `Виставлення оцінок (${prepared.previewDiff.marksToUpdateCount} учн.) — урок ID ${prepared.previewDiff.lessonId}`,
      executeFn: prepared.executeWrite
    });
  }

  const blockedDirectConfirm = confirm && previewStore;

  return {
    status: 'PREVIEW_ONLY (Жодних змін до журналу НЕ внесено)',
    previewToken: token,
    ...prepared.previewDiff,
    notice: blockedDirectConfirm
      ? '🛡️ Захист журналу: ви викликали confirm: true без попереднього Preview. Спочатку покажіть цю таблицю оцінок вчителю, а після підтвердження викличте confirm_pending_action({ preview_token }).'
      : 'Це безпечний попередній перегляд оцінок. Покажіть його вчителю. Після підтвердження викличте confirm_pending_action({ preview_token }) або повторіть виклик із confirm: true та preview_token.'
  };
}

/**
 * Tool: batch_set_marks
 */
async function batchSetLessonMarks(client, metadataManager, options) {
  const {
    classNameOrId,
    subjectOrId,
    entries,
    confirm = false,
    previewToken = null,
    previewStore = null,
    cache = null
  } = options;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    throw new Error('Параметр entries має бути непорожнім масивом записів для виставлення оцінок.');
  }

  const payloadKey = { classNameOrId, subjectOrId, entries };

  if (confirm && previewStore) {
    const existingPreview = previewStore.findValid('batch_set_marks', payloadKey, previewToken);
    if (existingPreview) {
      previewStore.consume(existingPreview.token);
      return await existingPreview.executeFn();
    }
  }

  const preparedList = [];
  for (const entry of entries) {
    const prep = await prepareLessonMarks(client, metadataManager, {
      lessonId: entry.lesson_id,
      classNameOrId: entry.class_name_or_id || classNameOrId,
      subjectOrId: entry.subject_or_id || subjectOrId,
      date: entry.date,
      lessonNumber: entry.lesson_number || 1,
      columnIndex: entry.column_index || 0,
      marks: entry.marks,
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
      totalLessonsUpdated: results.length,
      results
    };
  };

  let token = null;
  if (previewStore) {
    token = previewStore.register({
      toolName: 'batch_set_marks',
      payloadKey,
      summary: `Пакетне виставлення оцінок за ${preparedList.length} урок(ів)`,
      executeFn: executeBatch
    });
  }

  return {
    status: 'BATCH_PREVIEW_ONLY (Жодних змін до журналу НЕ внесено)',
    previewToken: token,
    totalEntries: preparedList.length,
    previews: preparedList.map(p => p.previewDiff),
    notice:
      'Це безпечний попередній перегляд пакетного виставлення оцінок. Покажіть його вчителю. Після підтвердження викличте confirm_pending_action({ preview_token }).'
  };
}

/**
 * Tool: set_attendance
 * Supports marking absences ("Н"), restoring presence (clearing "Н" without touching numerical marks!),
 * mark_all_present flag, and saving lateness_minutes into LessonEdit!
 */
async function setAttendance(client, metadataManager, options) {
  const {
    lessonId: inputLessonId,
    classNameOrId,
    subjectOrId,
    date,
    lessonNumber = 1,
    attendanceList = [],
    markAllPresent = false,
    confirm = false,
    previewToken = null,
    previewStore = null,
    cache = null
  } = options;

  if ((!attendanceList || attendanceList.length === 0) && !markAllPresent) {
    throw new Error('Вкажіть attendance_list або mark_all_present: true.');
  }

  const payloadKey = {
    lessonId: inputLessonId || null,
    classNameOrId: classNameOrId || null,
    subjectOrId: subjectOrId || null,
    date: date || null,
    lessonNumber,
    attendanceList,
    markAllPresent: Boolean(markAllPresent)
  };

  if (confirm && previewStore) {
    const existingPreview = previewStore.findValid('set_attendance', payloadKey, previewToken);
    if (existingPreview) {
      previewStore.consume(existingPreview.token);
      return await existingPreview.executeFn();
    }
  }

  const metadata = await metadataManager.getMetadata();
  let classId = null;
  let disciplineId = null;
  const teacherId = metadata.teacherId;

  let resolvedLessonId = inputLessonId;
  let lessonInfo = null;

  if (!resolvedLessonId) {
    const resolved = await resolveLesson(client, metadataManager, {
      classNameOrId,
      subjectOrId,
      date,
      lessonNumber,
      cache
    });
    resolvedLessonId = resolved.lessonId;
    classId = resolved.classId;
    disciplineId = resolved.disciplineId;
    lessonInfo = {
      date: resolved.date,
      time: resolved.time,
      lessonIndexOnDate: resolved.lessonIndexOnDate,
      totalLessonsOnDate: resolved.totalLessonsOnDate,
      className: resolved.className,
      disciplineName: resolved.disciplineName,
      topic: resolved.topic
    };
  } else if (classNameOrId && subjectOrId) {
    const journal = metadataManager.findJournal(classNameOrId, subjectOrId);
    if (journal) {
      classId = journal.classId;
      disciplineId = journal.disciplineId;
    }
  }

  const { $, form, url, pupils } = await getDiaryEditForm(client, {
    lessonId: resolvedLessonId,
    classId,
    disciplineId,
    teacherId
  });

  const explicitByPupilId = new Map();
  for (const item of attendanceList) {
    const pupil = matchStudentInList(pupils, item.student_name, p => p.studentName);
    explicitByPupilId.set(pupil.pupilId, {
      pupil,
      isPresent: item.is_present !== false,
      latenessMinutes: Math.max(0, Number(item.lateness_minutes) || 0)
    });
  }

  const previews = [];
  const warnings = [];
  let hasLatenessUpdates = false;

  for (const pupil of pupils) {
    const explicit = explicitByPupilId.get(pupil.pupilId);
    if (!explicit && !markAllPresent) continue;

    const isPresent = explicit ? explicit.isPresent : true;
    const lateness = explicit ? explicit.latenessMinutes : 0;
    if (lateness > 0) hasLatenessUpdates = true;

    const currentMark = pupil.currentMark || '';
    const hasNumericGrade = currentMark !== '' && !isAbsenceMark(currentMark);

    let proposedCellMark = currentMark;
    if (!isPresent) {
      if (hasNumericGrade) {
        warnings.push(
          `⚠️ Учня "${pupil.studentName}" вже оцінено балом [${currentMark}] на цьому уроці! Позначка "Н" замінить оцінку [${currentMark}].`
        );
      }
      proposedCellMark = 'Н';
    } else {
      // Student is present: if cell had "Н", clear it; if cell had a numeric grade (e.g. 10), KEEP IT!
      if (isAbsenceMark(currentMark)) {
        proposedCellMark = '';
      } else {
        proposedCellMark = currentMark;
      }
    }

    const statusText = !isPresent
      ? 'Відсутній (Н)'
      : lateness > 0
      ? `Присутній (запізнення ${lateness} хв)`
      : 'Присутній';

    // Only include in preview list if explicitly listed OR if their status is actually changing
    if (explicit || isAbsenceMark(currentMark)) {
      previews.push({
        pupilId: pupil.pupilId,
        student: pupil.studentName,
        previousCellValue: currentMark || '(порожньо)',
        newCellValue: proposedCellMark || '(присутній / порожньо)',
        newStatus: statusText,
        isPresent,
        latenessMinutes: lateness,
        markInputName: pupil.markInputName,
        valueIdInputName: pupil.valueIdInputName,
        proposedCellMark
      });
    }
  }

  const executeWrite = async () => {
    // 1. Update DiaryEdit grid (for "Н" marks)
    const diaryOverrides = {};
    for (const p of previews) {
      diaryOverrides[p.markInputName] = p.proposedCellMark;
      diaryOverrides[p.valueIdInputName] = '0';
    }

    const diaryParams = serializeAspNetForm($, form, diaryOverrides);
    const diaryAction = form.attr('action') || '/Diary/DiaryEdit';

    const postRes = await client.post(diaryAction, diaryParams.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${client.baseURL}${url}`
      }
    });
    assertNoFormErrors(postRes.data, `Збереження відвідуваності в журналі (урок ID ${resolvedLessonId})`);

    // 2. If any latenessMinutes > 0 were specified, also update LessonEdit (LessonPupils[i].LatenessTime & IsPresentValue)
    if (hasLatenessUpdates) {
      const editUrl = `/Timetable/LessonEdit?lessonID=${resolvedLessonId}&lessonType=1`;
      const leRes = await client.get(editUrl);
      const $le = cheerio.load(leRes.data);
      const leForm = $le('form[action*="ClassLessonEdit"]').first();

      if (leForm.length) {
        const leOverrides = {};
        leForm.find('tbody tr').each((_, tr) => {
          const rowText = $le(tr).find('td').first().text().replace(/\s+/g, ' ').trim();
          const latenessInput = $le(tr).find('[name$=".LatenessTime"]');
          const presentInput = $le(tr).find('input[type="checkbox"][name$=".IsPresentValue"]');
          if (!latenessInput.length) return;

          const matchedPreview = previews.find(
            p => rowText && rowText.toLowerCase().includes(p.student.toLowerCase().split(' ')[0])
          );
          if (matchedPreview) {
            leOverrides[latenessInput.attr('name')] = String(matchedPreview.latenessMinutes);
            if (presentInput.length) {
              leOverrides[presentInput.attr('name')] = matchedPreview.isPresent;
            }
          }
        });

        const leParams = serializeAspNetForm($le, leForm, leOverrides);
        const leAction = leForm.attr('action') || '/Timetable/ClassLessonEdit';
        await client.post(leAction, leParams.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': `${client.baseURL}${editUrl}`
          }
        });
      }
    }

    if (cache && classId) {
      cache.invalidatePrefix(`diary_view:${classId}`);
    }

    return {
      status: 'SUCCESS',
      message: `Відвідуваність для уроку ID ${resolvedLessonId} успішно збережено!`,
      lessonId: resolvedLessonId,
      lessonInfo: lessonInfo || undefined,
      updatedCount: previews.length,
      attendanceList: previews.map(p => ({
        student: p.student,
        status: p.newStatus,
        latenessMinutes: p.latenessMinutes
      }))
    };
  };

  let token = null;
  if (previewStore) {
    token = previewStore.register({
      toolName: 'set_attendance',
      payloadKey,
      summary: `Відмітка відвідуваності (${previews.length} учн.) — урок ID ${resolvedLessonId}`,
      executeFn: executeWrite
    });
  }

  return {
    status: 'PREVIEW_ONLY (Жодних змін до журналу НЕ внесено)',
    previewToken: token,
    lessonId: resolvedLessonId,
    lessonInfo: lessonInfo || undefined,
    markAllPresentApplied: Boolean(markAllPresent),
    attendancePreview: previews.map(p => ({
      student: p.student,
      previousValue: p.previousCellValue,
      newStatus: p.newStatus,
      latenessMinutes: p.latenessMinutes
    })),
    warnings: warnings.length > 0 ? warnings : undefined,
    notice:
      'Це безпечний попередній перегляд відвідуваності. Покажіть його вчителю. Після підтвердження викличте confirm_pending_action({ preview_token }) або повторіть виклик із confirm: true та preview_token.'
  };
}

/**
 * New Getter Tool: get_thematic_evaluation
 * Fetches /Diary/ThematicDiaryEdit for a class & subject to show School-Today's native
 * weighted average (Середньозважена), current grades in the thematic block, and recommended thematic mark!
 */
async function getThematicEvaluation(
  client,
  metadataManager,
  { classNameOrId, subjectOrId, date = null, lessonId: inputLessonId = null, cache = null }
) {
  const metadata = await metadataManager.getMetadata();
  const targetJournal = metadataManager.findJournal(classNameOrId, subjectOrId);

  let targetLessonId = inputLessonId;
  let lessonDate = date;

  if (!targetLessonId) {
    if (date) {
      const resolved = await resolveLesson(client, metadataManager, {
        classNameOrId,
        subjectOrId,
        date,
        cache
      });
      targetLessonId = resolved.lessonId;
      lessonDate = resolved.date;
    } else {
      // Pick the latest past or current lesson from the lesson plan
      const { getLessonPlan } = require('./lesson');
      const plan = await getLessonPlan(client, metadata, targetJournal, { cache });
      if (!plan.lessons.length) {
        throw new Error('У календарному плані цього класу немає уроків.');
      }
      const now = new Date();
      const { parseSmartDate } = require('../core/normalizer');
      const pastLessons = plan.lessons.filter(l => {
        const p = parseSmartDate(l.date, now);
        return p && p.dateObj <= now;
      });
      const chosen =
        pastLessons.length > 0
          ? pastLessons[pastLessons.length - 1]
          : plan.lessons[plan.lessons.length - 1];
      targetLessonId = chosen.lessonId;
      lessonDate = chosen.date;
    }
  }

  const periodId = targetJournal.schoolPeriodId || metadata.schoolPeriodId;
  const url = `/Diary/ThematicDiaryEdit?periodid=${periodId}&timetableid=${targetLessonId}&classid=${targetJournal.classId}&disciplineid=${targetJournal.disciplineId}&teacherid=${metadata.teacherId}`;

  const { getClassJournal } = require('./journal');
  const [res, journalData] = await Promise.all([
    client.get(url),
    getClassJournal(client, metadata, targetJournal, { cache })
  ]);

  const $ = cheerio.load(res.data);
  const journalStudentsByName = new Map(
    (journalData.students || []).map(s => [s.name.toLowerCase(), s])
  );

  const students = [];
  $('tr')
    .filter((_, tr) => $(tr).find('input[name$=".PupilID"]').length > 0)
    .each((_, tr) => {
      const pupilId = $(tr).find('input[name$=".PupilID"]').val();
      const fullName =
        $(tr).find('input[name$=".PupilFullName"]').val() ||
        $(tr).find('td').first().text().replace(/\s+/g, ' ').trim();
      if (!fullName) return;

      const currentAvg = $(tr).find('input[name$=".Cells[0].Mark"]').val() || null;
      const weightedAvg = $(tr).find('input[name$=".Cells[1].Mark"]').val() || currentAvg || null;

      const thematicInput = $(tr)
        .find('input[name$=".Mark"]')
        .filter((__, el) => !$(el).attr('name').includes('.Cells['))
        .first();
      const existingThematic = thematicInput.val() || null;

      const jStudent = journalStudentsByName.get(fullName.toLowerCase());
      const individualMarks = jStudent
        ? jStudent.marks.filter(m => !isAbsenceMark(m.mark)).map(m => m.mark)
        : [];
      const absencesCount = jStudent ? jStudent.absencesCount : 0;

      const avgNum = parseFloat(String(weightedAvg || '').replace(',', '.'));
      const recommendedMark = !isNaN(avgNum) && avgNum > 0 ? Math.round(avgNum) : null;

      students.push({
        pupilId,
        name: fullName,
        gradesCount: individualMarks.length,
        gradesList: individualMarks,
        absencesCount,
        schoolTodayCurrentAvg: currentAvg && currentAvg !== '-' ? currentAvg : null,
        schoolTodayWeightedAvg: weightedAvg && weightedAvg !== '-' ? weightedAvg : null,
        recommendedThematicMark: recommendedMark,
        existingThematicMark:
          existingThematic && existingThematic !== '-' ? existingThematic : null,
        status:
          individualMarks.length === 0
            ? '⚠️ Немає оцінок (потрібне опитування)'
            : individualMarks.length < 3
            ? `⚡ Мало оцінок (${individualMarks.length} з реком. 3+)`
            : '✅ Готовий до атестації'
      });
    });

  return {
    className: targetJournal.className,
    disciplineName: targetJournal.disciplineName,
    asOfLessonDate: lessonDate,
    lessonId: targetLessonId,
    studentsCount: students.length,
    readyCount: students.filter(s => s.gradesCount >= 3).length,
    needsAttentionCount: students.filter(s => s.gradesCount < 3).length,
    students
  };
}

module.exports = {
  getDiaryEditForm,
  setLessonMarks,
  batchSetLessonMarks,
  setAttendance,
  getThematicEvaluation
};

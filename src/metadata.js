const cheerio = require('cheerio');
const { cleanStr } = require('./core/normalizer');

class MetadataManager {
  constructor(client, cache = null) {
    this.client = client;
    this.cache = cache;
    this.cachedMetadata = null;
    this.lastFetchedAt = 0;
    this.ttlMs = 5 * 60 * 1000; // 5 minutes TTL
  }

  async getMetadata(forceRefresh = false) {
    const now = Date.now();
    if (this.cachedMetadata && !forceRefresh && now - this.lastFetchedAt < this.ttlMs) {
      return this.cachedMetadata;
    }

    // Fetch /Cabinet/Teachers which automatically redirects to /Cabinet/Teacher/{teacherId}
    const cabinetRes = await this.client.get('/Cabinet/Teachers');
    const finalUrl =
      (cabinetRes.request && cabinetRes.request.res && cabinetRes.request.res.responseUrl) || '';
    const urlIdMatch = finalUrl.match(/\/Cabinet\/Teacher\/(\d+)/i);

    let teacherId = urlIdMatch ? urlIdMatch[1] : null;
    let teacherName = '';

    const $cab = cheerio.load(cabinetRes.data);


    // Extract teacher name dynamically from header greeting ("Привіт, Патока Владислава!") or cabinet title
    const greetingMatch = $cab('body')
      .text()
      .match(/Привіт,\s*([^\n\r!]+)\s*!/i);
    if (greetingMatch) {
      teacherName = greetingMatch[1].replace(/\s+/g, ' ').trim();
    } else {
      teacherName =
        $cab('h2, h3, h4, .page-title, .user-name').first().text().replace(/\s+/g, ' ').trim() ||
        `Teacher #${teacherId}`;
    }

    let schoolPeriodId = null;
    const journals = [];

    // Parse every journal entry from the Cabinet DOM without any hardcoded subject/class names
    $cab('a[href*="/Diary/DiaryView"]').each((_, a) => {
      const href = $cab(a).attr('href');
      if (!href || !href.includes('?')) return;

      const u = new URL(href, this.client.baseURL);
      const pId = u.searchParams.get('SchoolPeriodID');
      const tId = u.searchParams.get('TeacherID') || u.searchParams.get('ViewID');
      const dId = u.searchParams.get('DisciplineID');
      const cId = u.searchParams.get('ClassID');

      if (pId && !schoolPeriodId) schoolPeriodId = pId;
      if (tId && !teacherId) teacherId = tId;

      if (dId && cId) {
        const listItem = $cab(a).closest('.list-group-item, .card, tr, .row').first();

        // Dynamic subject extraction from .media-body strong
        let disciplineName = listItem
          .find('.media-body strong')
          .first()
          .text()
          .replace(/\s+/g, ' ')
          .trim();

        // Dynamic class name extraction from .ms-auto small
        let className = listItem
          .find('.ms-auto small, small.text-muted')
          .last()
          .text()
          .replace(/\s+/g, ' ')
          .trim();

        if (!className) {
          const text = listItem.text().replace(/\s+/g, ' ').trim();
          const classMatch =
            text.match(/(\d+\s+клас[^\n\r"“]*["“][^"”]+["”])/i) || text.match(/(\d+\s+клас\S*)/i);
          className = classMatch ? classMatch[0].trim() : `Клас #${cId}`;
        }

        if (!disciplineName) {
          disciplineName = `Предмет #${dId}`;
        }

        if (!journals.some(j => j.classId === cId && j.disciplineId === dId)) {
          journals.push({
            classId: cId,
            className,
            disciplineId: dId,
            disciplineName,
            schoolPeriodId: pId || schoolPeriodId
          });
        }
      }
    });

    const uniqueClasses = [];
    for (const j of journals) {
      if (!uniqueClasses.some(c => c.classId === j.classId)) {
        uniqueClasses.push({
          classId: j.classId,
          className: j.className,
          subjects: journals
            .filter(x => x.classId === j.classId)
            .map(x => ({ disciplineId: x.disciplineId, disciplineName: x.disciplineName }))
        });
      }
    }

    const uniqueSubjects = [];
    for (const j of journals) {
      if (!uniqueSubjects.some(s => s.disciplineId === j.disciplineId)) {
        uniqueSubjects.push({
          disciplineId: j.disciplineId,
          disciplineName: j.disciplineName
        });
      }
    }

    this.cachedMetadata = {
      teacherId,
      teacherName,
      schoolPeriodId,
      cabinetUrl: `${this.client.baseURL}/Cabinet/Teacher/${teacherId}`,
      journals,
      classes: uniqueClasses,
      subjects: uniqueSubjects
    };
    this.lastFetchedAt = now;

    return this.cachedMetadata;
  }

  _matchClass(journal, classQuery) {
    const cQ = cleanStr(classQuery);
    if (!cQ) return true;
    const jClass = cleanStr(journal.className);
    if (journal.classId === cQ || jClass === cQ) return true;

    // Extract class number if query has a number (e.g. "7", "7 клас", "10")
    const qNumMatch = cQ.match(/\b(\d{1,2})\b/);
    const jNumMatch = jClass.match(/\b(\d{1,2})\b/);
    if (qNumMatch && jNumMatch) {
      if (qNumMatch[1] !== jNumMatch[1]) return false;
      // If query is just "7" or "7 клас", match the number
      const restQuery = cQ.replace(/\b\d{1,2}\b/, '').replace(/клас/g, '').trim();
      if (!restQuery) return true;
      return jClass.includes(restQuery);
    }

    return jClass.includes(cQ);
  }

  _matchSubject(journal, subjectQuery) {
    const sQ = cleanStr(subjectQuery);
    if (!sQ) return true;
    const jSub = cleanStr(journal.disciplineName);
    if (journal.disciplineId === sQ || jSub === sQ) return true;
    return jSub.includes(sQ);
  }

  /**
   * Finds a specific journal by class and subject with strict disambiguation.
   */
  findJournal(classQuery, subjectQuery) {
    if (!this.cachedMetadata) return null;
    if (!classQuery || !subjectQuery) {
      throw new Error('Необхідно вказати і клас (class_name_or_id), і предмет (subject_or_id).');
    }

    const candidates = this.cachedMetadata.journals.filter(
      j => this._matchClass(j, classQuery) && this._matchSubject(j, subjectQuery)
    );

    if (candidates.length === 1) {
      return candidates[0];
    }

    if (candidates.length > 1) {
      // Prefer exact discipline name match (e.g., "Біологія" vs "Біологія і екологія")
      const exactSub = candidates.filter(
        j => cleanStr(j.disciplineName) === cleanStr(subjectQuery)
      );
      if (exactSub.length === 1) return exactSub[0];

      const listStr = candidates
        .map(c => `${c.className} — ${c.disciplineName} (ClassID: ${c.classId}, DisciplineID: ${c.disciplineId})`)
        .join('; ');
      throw new Error(
        `Знайдено кілька журналів за запитом класу "${classQuery}" та предмета "${subjectQuery}": ${listStr}. Уточніть назву.`
      );
    }

    const available = this.cachedMetadata.journals
      .map(j => `${j.className} (${j.disciplineName})`)
      .join(', ');
    throw new Error(
      `Журнал не знайдено для класу "${classQuery}" та предмета "${subjectQuery}". Доступні журнали: ${available}`
    );
  }

  /**
   * Returns all journals taught by the teacher in a specific class (e.g., both Biology and Chemistry in 7th grade).
   */
  findJournalsByClass(classQuery) {
    if (!this.cachedMetadata) return [];
    const matched = this.cachedMetadata.journals.filter(j => this._matchClass(j, classQuery));
    if (matched.length === 0) {
      const available = this.cachedMetadata.classes.map(c => c.className).join(', ');
      throw new Error(`Клас "${classQuery}" не знайдено. Доступні класи: ${available}`);
    }
    return matched;
  }
}

module.exports = { MetadataManager };

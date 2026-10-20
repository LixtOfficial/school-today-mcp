const { getSchedule, auditLessonsFilling } = require('./scrapers/schedule');
const { getClassJournal, getStudentDossier } = require('./scrapers/journal');
const {
  getLessonPlan,
  findLessons,
  updateLessonContent,
  batchUpdateLessons
} = require('./scrapers/lesson');
const {
  setLessonMarks,
  setAttendance,
  batchSetLessonMarks,
  getThematicEvaluation
} = require('./scrapers/grading');

const READ_ONLY_ANNOTATIONS = {
  title: 'Read-Only Getter (Безпечне читання)',
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const SETTER_ANNOTATIONS = {
  title: 'Two-Phase Setter (Потребує Preview та підтвердження)',
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
};

const TOOLS_DEFINITIONS = [
  // ============================================================================
  // 🟢 ГРУПА 1: GETTERS (Швидке безпечне читання та аналітика без змін у журналі)
  // ============================================================================
  {
    name: 'get_auth_status',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      '[GETTER / Read-Only] Перевірити стан авторизації та сесії в School-Today, автоматичний вхід та базову інформацію про вчителя. Виконується миттєво без підтвердження.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_teacher_profile',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      '[GETTER / Read-Only] Отримати профіль вчителя (ПІБ, ID, поточний семестр, перелік класів та предметів).',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_classes_and_subjects',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      '[GETTER / Read-Only] Отримати динамічний список усіх закріплених класів, предметів та журналів з їхніми внутрішніми ID.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_schedule',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      '[GETTER / Read-Only] Отримати розклад уроків вчителя з темами, статусом ДЗ та відвідуваності. Підтримує будь-яку дату ("сьогодні", "завтра", "вчора", "19.10"), тиждень ("цей тиждень", "наступний тиждень", "минулий тиждень"), день тижня у будь-якому відмінку ("вівторок", "у середу", "на п\'ятницю"), діапазон start_date..end_date, а також фільтр за класом чи предметом.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description:
            'Фільтр: "сьогодні", "завтра", "цей тиждень", "наступний тиждень", день тижня ("вівторок", "у середу"), дата ("19.10") або назва класу/предмета.'
        },
        day: {
          type: 'string',
          description: 'Зворотна сумісність: день тижня або дата.'
        },
        class_name: {
          type: 'string',
          description: 'Опціональний фільтр за класом (наприклад: "7 клас", "10").'
        },
        subject: {
          type: 'string',
          description: 'Опціональний фільтр за предметом (наприклад: "Біологія", "Хімія").'
        },
        start_date: {
          type: 'string',
          description: 'Початкова дата діапазону (наприклад "01.10" або "2026-10-01").'
        },
        end_date: {
          type: 'string',
          description: 'Кінцева дата діапазону (наприклад "18.10" або "2026-10-18").'
        }
      }
    }
  },
  {
    name: 'audit_lessons_filling',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      '[GETTER / Read-Only] Глобальний аудит заповнення журналів по ВСІХ класах та предметах за один виклик. Миттєво знаходить проведені уроки, де не заповнена тема, не задано домашнє завдання або не відмічена відвідуваність, і рахує % заповнення.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description: 'Початкова дата перевірки (за замовчуванням з початку семестру "01.09").'
        },
        end_date: {
          type: 'string',
          description: 'Кінцева дата перевірки (за замовчуванням "сьогодні").'
        },
        class_name: {
          type: 'string',
          description: 'Опціонально: перевірити лише конкретний клас (наприклад "8 клас").'
        },
        subject: {
          type: 'string',
          description: 'Опціонально: перевірити лише конкретний предмет (наприклад "Хімія").'
        }
      }
    }
  },
  {
    name: 'get_class_journal',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      '[GETTER / Read-Only] Отримати журнал оцінок та відвідуваності класу з предмета. Включає стовпчики дат, типи уроків, теми, аналітику класу (середній бал, відмінники, учні в зоні ризику, кому бракує оцінок < 3) або детальну картку одного учня.',
    inputSchema: {
      type: 'object',
      properties: {
        class_name_or_id: {
          type: 'string',
          description: 'Назва класу (наприклад: "7 клас", "8", "10 клас") або ClassID.'
        },
        subject_or_id: {
          type: 'string',
          description: 'Назва предмета ("Біологія", "Хімія", "Біологія і екологія") або DisciplineID.'
        },
        student_name: {
          type: 'string',
          description:
            'Опціонально: прізвище або ім\'я конкретного учня для отримання його персональної картки.'
        },
        date_from: {
          type: 'string',
          description: 'Опціонально: фільтр оцінок від дати (наприклад "01.10").'
        },
        date_to: {
          type: 'string',
          description: 'Опціонально: фільтр оцінок до дати (наприклад "17.10").'
        }
      },
      required: ['class_name_or_id', 'subject_or_id']
    }
  },
  {
    name: 'get_student_dossier',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      '[GETTER / Read-Only] Повне досьє учня одразу з УСІХ предметів, які викладає вчитель у цьому класі (наприклад, одночасно з Біології та Хімії): середні бали, усі оцінки з темами, усі пропуски "Н" за один виклик.',
    inputSchema: {
      type: 'object',
      properties: {
        student_name: {
          type: 'string',
          description: 'Прізвище або ім\'я учня (наприклад: "Кемалов", "Балицький Михайло").'
        },
        class_name_or_id: {
          type: 'string',
          description: 'Клас учня (наприклад: "7 клас", "10 клас").'
        }
      },
      required: ['student_name', 'class_name_or_id']
    }
  },
  {
    name: 'get_lesson_plan',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      '[GETTER / Read-Only] Отримати повний календарний план уроків на семестр (номери уроків, дати, час, теми занять, домашні завдання, ID уроків) для класу та предмета.',
    inputSchema: {
      type: 'object',
      properties: {
        class_name_or_id: {
          type: 'string',
          description: 'Назва класу або ClassID.'
        },
        subject_or_id: {
          type: 'string',
          description: 'Назва предмета або DisciplineID.'
        }
      },
      required: ['class_name_or_id', 'subject_or_id']
    }
  },
  {
    name: 'find_lessons',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      '[GETTER / Read-Only] Швидкий пошук уроків класу з предмета за датою ("05.10", "сьогодні", "завтра"), діапазоном дат (date_from..date_to), ключовим словом у темі/ДЗ (query) або статусом заповненості ("missing_topic", "missing_homework", "unfilled").',
    inputSchema: {
      type: 'object',
      properties: {
        class_name_or_id: {
          type: 'string',
          description: 'Назва класу (наприклад: "7 клас") або ClassID.'
        },
        subject_or_id: {
          type: 'string',
          description: 'Назва предмета (наприклад: "Біологія") або DisciplineID.'
        },
        date: {
          type: 'string',
          description: 'Конкретна дата (наприклад "05.10", "сьогодні", "завтра", "вівторок").'
        },
        date_from: {
          type: 'string',
          description: 'Початкова дата пошуку (наприклад "01.10").'
        },
        date_to: {
          type: 'string',
          description: 'Кінцева дата пошуку (наприклад "20.10").'
        },
        only_past: {
          type: 'boolean',
          description: 'Якщо true — шукати лише серед вже проведених уроків (до сьогодні включно).'
        },
        query: {
          type: 'string',
          description: 'Пошук за текстом у темі або домашньому завданні.'
        },
        filter_status: {
          type: 'string',
          description:
            'Статус заповненості: "missing_topic" (без теми), "missing_homework" (без ДЗ), "unfilled" (без теми або без ДЗ).'
        },
        limit: {
          type: 'number',
          description: 'Максимальна кількість уроків у відповіді (за замовчуванням 30).'
        }
      },
      required: ['class_name_or_id', 'subject_or_id']
    }
  },
  {
    name: 'get_thematic_evaluation',
    annotations: READ_ONLY_ANNOTATIONS,
    description:
      '[GETTER / Read-Only] Отримати розрахунок тематичних оцінок для класу з предмета: показує поточні оцінки кожного учня, офіційну середньозважену оцінку School-Today, рекомендований тематичний бал та список учнів, яким бракує оцінок.',
    inputSchema: {
      type: 'object',
      properties: {
        class_name_or_id: {
          type: 'string',
          description: 'Клас (наприклад "7 клас", "10 клас").'
        },
        subject_or_id: {
          type: 'string',
          description: 'Предмет (наприклад "Біологія", "Хімія").'
        },
        date: {
          type: 'string',
          description: 'Опціонально: дата уроку, станом на який рахується тематична.'
        },
        lesson_id: {
          type: 'string',
          description: 'Опціонально: точний ID уроку.'
        }
      },
      required: ['class_name_or_id', 'subject_or_id']
    }
  },

  // ============================================================================
  // 🟠 ГРУПА 2: SETTERS (Двоетапний запис: Етап 1 = Preview, Етап 2 = Підтвердження)
  // ============================================================================
  {
    name: 'update_lesson_content',
    annotations: SETTER_ANNOTATIONS,
    description:
      '[SETTER / 2-Phase] Заповнити або оновити тему уроку, домашнє завдання, примітки, посилання на відеоурок чи дедлайн ДЗ. ЗАВЖДИ працює у два етапи: 1) Спочатку викликається з confirm: false і повертає безпечний Preview (таблицю БУЛО -> СТАНЕ) та preview_token. 2) Після підтвердження користувачем викличте confirm_pending_action({ preview_token }) або повторіть виклик з confirm: true та preview_token.',
    inputSchema: {
      type: 'object',
      properties: {
        lesson_id: {
          type: 'string',
          description: 'Ідентифікатор уроку (якщо відомий). Якщо не вказано — знайдеться автоматично.'
        },
        class_name_or_id: {
          type: 'string',
          description: 'Клас (наприклад: "7 клас", "11 клас").'
        },
        subject_or_id: {
          type: 'string',
          description: 'Предмет (наприклад: "Біологія", "Хімія").'
        },
        date: {
          type: 'string',
          description: 'Дата уроку ("05.10", "сьогодні", "завтра", "вівторок").'
        },
        lesson_number: {
          type: 'number',
          description: 'Номер уроку в цей день (1 або 2, якщо пара в один день). За замовчуванням 1.'
        },
        topic: {
          type: 'string',
          description: 'Тема уроку, яку потрібно встановити.'
        },
        homework: {
          type: 'string',
          description: 'Текст домашнього завдання (або "" для очищення ДЗ).'
        },
        notes: {
          type: 'string',
          description: 'Опціональні примітки до уроку.'
        },
        video_link: {
          type: 'string',
          description: 'Опціональне посилання на онлайн-урок (Zoom / Meet).'
        },
        deadline_date: {
          type: 'string',
          description: 'Опціональна дата дедлайну для ДЗ (наприклад "19.10" або "2026-10-19").'
        },
        preview_token: {
          type: 'string',
          description: 'Токен попереднього перегляду (передається на етапі 2 разом із confirm: true).'
        },
        confirm: {
          type: 'boolean',
          description: 'На першому кроці ЗАВЖДИ false (режим Preview). Встановлюйте true лише після підтвердження користувачем!'
        }
      }
    }
  },
  {
    name: 'batch_update_lessons',
    annotations: SETTER_ANNOTATIONS,
    description:
      '[SETTER / 2-Phase] Пакетне оновлення тем або домашніх завдань для кількох уроків за один виклик. Етап 1 (confirm: false) повертає зведений Preview усіх уроків та єдиний preview_token. Етап 2 — підтвердження через confirm_pending_action({ preview_token }).',
    inputSchema: {
      type: 'object',
      properties: {
        class_name_or_id: {
          type: 'string',
          description: 'Клас за замовчуванням для списку уроків (наприклад "7 клас").'
        },
        subject_or_id: {
          type: 'string',
          description: 'Предмет за замовчуванням (наприклад "Біологія").'
        },
        lessons: {
          type: 'array',
          description: 'Список уроків для оновлення.',
          items: {
            type: 'object',
            properties: {
              lesson_id: { type: 'string' },
              class_name_or_id: { type: 'string' },
              subject_or_id: { type: 'string' },
              date: { type: 'string', description: 'Дата уроку ("05.10", "завтра" тощо)' },
              lesson_number: { type: 'number', description: '1 або 2 (якщо пара)' },
              topic: { type: 'string' },
              homework: { type: 'string' },
              notes: { type: 'string' },
              video_link: { type: 'string' },
              deadline_date: { type: 'string' }
            }
          }
        },
        preview_token: {
          type: 'string',
          description: 'Токен попереднього перегляду для підтвердження.'
        },
        confirm: {
          type: 'boolean',
          description: 'За замовчуванням false (Preview).'
        }
      },
      required: ['lessons']
    }
  },
  {
    name: 'set_lesson_marks',
    annotations: SETTER_ANNOTATIONS,
    description:
      '[SETTER / 2-Phase] Виставити, змінити або видалити (очистити) оцінки учням за урок у журналі (DiaryEdit) разом із коментарями. Працює в два етапи: 1) confirm: false формує Preview та preview_token; 2) після згоди користувача — confirm_pending_action({ preview_token }). Щоб видалити помилкову оцінку, передайте mark: null або clear: true.',
    inputSchema: {
      type: 'object',
      properties: {
        lesson_id: {
          type: 'string',
          description: 'Ідентифікатор уроку (якщо відомий).'
        },
        class_name_or_id: {
          type: 'string',
          description: 'Клас (наприклад "7 клас").'
        },
        subject_or_id: {
          type: 'string',
          description: 'Предмет (наприклад "Біологія").'
        },
        date: {
          type: 'string',
          description: 'Дата уроку (наприклад "05.10", "сьогодні").'
        },
        lesson_number: {
          type: 'number',
          description: 'Номер уроку в цей день (1 або 2, якщо пара). За замовчуванням 1.'
        },
        column_index: {
          type: 'number',
          description: 'Індекс стовпчика оцінки в межах уроку (за замовчуванням 0 — основна оцінка).'
        },
        marks: {
          type: 'array',
          description:
            'Список оцінок: [{"student_name": "Прізвище", "mark": 10, "comment": "Коментар"}] або для видалення оцінки: [{"student_name": "Прізвище", "mark": null, "clear": true}].',
          items: {
            type: 'object',
            properties: {
              student_name: { type: 'string', description: 'Прізвище або ПІБ учня' },
              mark: {
                type: ['number', 'string', 'null'],
                description: 'Оцінка від 1 до 12, або null / "" для очищення клітинки'
              },
              comment: { type: 'string', description: 'Опціональний коментар до оцінки' },
              clear: { type: 'boolean', description: 'Встановіть true, щоб видалити/очистити оцінку' }
            },
            required: ['student_name']
          }
        },
        preview_token: {
          type: 'string',
          description: 'Токен попереднього перегляду.'
        },
        confirm: {
          type: 'boolean',
          description: 'За замовчуванням false (Preview).'
        }
      },
      required: ['marks']
    }
  },
  {
    name: 'batch_set_marks',
    annotations: SETTER_ANNOTATIONS,
    description:
      '[SETTER / 2-Phase] Пакетне виставлення оцінок за кілька уроків або дат. Етап 1 (confirm: false) повертає повний Preview та preview_token; Етап 2 — запис після підтвердження.',
    inputSchema: {
      type: 'object',
      properties: {
        class_name_or_id: {
          type: 'string',
          description: 'Клас за замовчуванням (наприклад "7 клас").'
        },
        subject_or_id: {
          type: 'string',
          description: 'Предмет за замовчуванням (наприклад "Біологія").'
        },
        entries: {
          type: 'array',
          description: 'Список уроків та оцінок.',
          items: {
            type: 'object',
            properties: {
              lesson_id: { type: 'string' },
              class_name_or_id: { type: 'string' },
              subject_or_id: { type: 'string' },
              date: { type: 'string' },
              lesson_number: { type: 'number' },
              marks: { type: 'array' }
            },
            required: ['marks']
          }
        },
        preview_token: {
          type: 'string'
        },
        confirm: {
          type: 'boolean',
          description: 'За замовчуванням false (Preview).'
        }
      },
      required: ['entries']
    }
  },
  {
    name: 'set_attendance',
    annotations: SETTER_ANNOTATIONS,
    description:
      '[SETTER / 2-Phase] Відмітити відвідуваність учнів на уроці: відсутній ("Н"), присутній (знімає "Н", не затираючи числові оцінки!) або запізнення у хвилинах (lateness_minutes). Працює в два етапи через Preview.',
    inputSchema: {
      type: 'object',
      properties: {
        lesson_id: {
          type: 'string',
          description: 'Ідентифікатор уроку (якщо відомий).'
        },
        class_name_or_id: {
          type: 'string',
          description: 'Клас (наприклад "7 клас").'
        },
        subject_or_id: {
          type: 'string',
          description: 'Предмет (наприклад "Біологія").'
        },
        date: {
          type: 'string',
          description: 'Дата уроку (наприклад "05.10", "сьогодні").'
        },
        lesson_number: {
          type: 'number',
          description: 'Номер уроку в цей день (1 або 2). За замовчуванням 1.'
        },
        attendance_list: {
          type: 'array',
          description:
            'Список учнів: [{"student_name": "Прізвище", "is_present": false, "lateness_minutes": 0}].',
          items: {
            type: 'object',
            properties: {
              student_name: { type: 'string' },
              is_present: { type: 'boolean' },
              lateness_minutes: { type: 'number' }
            },
            required: ['student_name']
          }
        },
        mark_all_present: {
          type: 'boolean',
          description:
            'Якщо true — всі інші учні класу вважаються присутніми (якщо у когось стояла "Н", вона буде знята, а числові оцінки збережуться).'
        },
        preview_token: {
          type: 'string'
        },
        confirm: {
          type: 'boolean',
          description: 'За замовчуванням false (Preview).'
        }
      }
    }
  },
  {
    name: 'confirm_pending_action',
    annotations: SETTER_ANNOTATIONS,
    description:
      '[SETTER / Commit Phase 2] Виконати та зберегти в журналі раніше підготовлену зміну (Preview) за її preview_token після того, як користувач явно підтвердив дію в чаті.',
    inputSchema: {
      type: 'object',
      properties: {
        preview_token: {
          type: 'string',
          description: 'Токен попереднього перегляду (наприклад "prv_a1b2c3d4e5f6"), отриманий на етапі Preview.'
        }
      },
      required: ['preview_token']
    }
  }
];

async function handleToolCall(name, args = {}, { client, metadataManager, cache, previewStore }) {
  if (name === 'get_auth_status') {
    const metadata = await metadataManager.getMetadata();
    return {
      status: 'AUTHENTICATED',
      authDiagnostics: client.getAuthDiagnostics(),
      teacher: {
        teacherName: metadata.teacherName,
        teacherId: metadata.teacherId,
        schoolPeriodId: metadata.schoolPeriodId,
        totalJournals: metadata.journals.length,
        classesCount: metadata.classes.length,
        subjectsCount: metadata.subjects.length
      }
    };
  }

  if (name === 'confirm_pending_action') {
    const token = args.preview_token;
    if (!token) {
      throw new Error('Необхідно передати preview_token для підтвердження дії.');
    }
    const pending = previewStore.getByToken(token);
    if (!pending) {
      const activeList = previewStore.listPending();
      throw new Error(
        `Токен підтвердження "${token}" не знайдено або його час дії минув. Активні прев'ю: ${
          activeList.length ? JSON.stringify(activeList) : 'немає'
        }. Сформуйте новий Preview.`
      );
    }
    if (typeof pending.executeFn === 'function') {
      previewStore.consume(token);
      return await pending.executeFn();
    }
    // Re-hydrate from persisted payloadKey if server restarted between preview and confirm
    const pk = pending.payloadKey || {};
    if (pending.toolName === 'update_lesson_content') {
      return await updateLessonContent(client, metadataManager, {
        ...pk,
        previewToken: token,
        confirm: true,
        previewStore,
        cache
      });
    }
    if (pending.toolName === 'set_lesson_marks') {
      return await setLessonMarks(client, metadataManager, {
        ...pk,
        previewToken: token,
        confirm: true,
        previewStore,
        cache
      });
    }
    previewStore.consume(token);
    throw new Error(`Токен "${token}" потребує повторного формування Preview після перезапуску.`);
  }

  const metadata = await metadataManager.getMetadata();

  if (name === 'get_teacher_profile') {
    return {
      teacherName: metadata.teacherName,
      teacherId: metadata.teacherId,
      schoolPeriodId: metadata.schoolPeriodId,
      cabinetUrl: metadata.cabinetUrl,
      classes: metadata.classes,
      subjects: metadata.subjects
    };
  }

  if (name === 'get_classes_and_subjects') {
    return metadata.journals;
  }

  if (name === 'get_schedule') {
    return await getSchedule(client, metadata, args);
  }

  if (name === 'audit_lessons_filling') {
    return await auditLessonsFilling(client, metadata, args);
  }

  if (name === 'get_class_journal') {
    const targetJournal = metadataManager.findJournal(args.class_name_or_id, args.subject_or_id);
    return await getClassJournal(client, metadata, targetJournal, {
      studentName: args.student_name,
      dateFrom: args.date_from,
      dateTo: args.date_to,
      cache
    });
  }

  if (name === 'get_student_dossier') {
    return await getStudentDossier(client, metadataManager, {
      studentName: args.student_name,
      classNameOrId: args.class_name_or_id,
      cache
    });
  }

  if (name === 'get_lesson_plan') {
    const targetJournal = metadataManager.findJournal(args.class_name_or_id, args.subject_or_id);
    return await getLessonPlan(client, metadata, targetJournal, { cache });
  }

  if (name === 'find_lessons') {
    return await findLessons(client, metadataManager, {
      classNameOrId: args.class_name_or_id,
      subjectOrId: args.subject_or_id,
      date: args.date,
      dateFrom: args.date_from,
      dateTo: args.date_to,
      onlyPast: Boolean(args.only_past),
      query: args.query,
      filterStatus: args.filter_status,
      limit: args.limit,
      cache
    });
  }

  if (name === 'get_thematic_evaluation') {
    return await getThematicEvaluation(client, metadataManager, {
      classNameOrId: args.class_name_or_id,
      subjectOrId: args.subject_or_id,
      date: args.date,
      lessonId: args.lesson_id,
      cache
    });
  }

  if (name === 'update_lesson_content') {
    return await updateLessonContent(client, metadataManager, {
      lessonId: args.lesson_id,
      classNameOrId: args.class_name_or_id,
      subjectOrId: args.subject_or_id,
      date: args.date,
      lessonNumber: args.lesson_number,
      topic: args.topic,
      homework: args.homework,
      notes: args.notes,
      videoLink: args.video_link,
      deadlineDate: args.deadline_date,
      previewToken: args.preview_token,
      confirm: Boolean(args.confirm),
      previewStore,
      cache
    });
  }

  if (name === 'batch_update_lessons') {
    return await batchUpdateLessons(client, metadataManager, {
      classNameOrId: args.class_name_or_id,
      subjectOrId: args.subject_or_id,
      lessons: args.lessons,
      previewToken: args.preview_token,
      confirm: Boolean(args.confirm),
      previewStore,
      cache
    });
  }

  if (name === 'set_lesson_marks') {
    return await setLessonMarks(client, metadataManager, {
      lessonId: args.lesson_id,
      classNameOrId: args.class_name_or_id,
      subjectOrId: args.subject_or_id,
      date: args.date,
      lessonNumber: args.lesson_number,
      columnIndex: args.column_index,
      marks: args.marks,
      previewToken: args.preview_token,
      confirm: Boolean(args.confirm),
      previewStore,
      cache
    });
  }

  if (name === 'batch_set_marks') {
    return await batchSetLessonMarks(client, metadataManager, {
      classNameOrId: args.class_name_or_id,
      subjectOrId: args.subject_or_id,
      entries: args.entries,
      previewToken: args.preview_token,
      confirm: Boolean(args.confirm),
      previewStore,
      cache
    });
  }

  if (name === 'set_attendance') {
    return await setAttendance(client, metadataManager, {
      lessonId: args.lesson_id,
      classNameOrId: args.class_name_or_id,
      subjectOrId: args.subject_or_id,
      date: args.date,
      lessonNumber: args.lesson_number,
      attendanceList: args.attendance_list,
      markAllPresent: Boolean(args.mark_all_present),
      previewToken: args.preview_token,
      confirm: Boolean(args.confirm),
      previewStore,
      cache
    });
  }

  throw new Error(`Невідомий інструмент: ${name}`);
}

module.exports = { TOOLS_DEFINITIONS, handleToolCall };

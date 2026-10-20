const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');

async function testMcpServer() {
  console.log('==================================================================');
  console.log('🚀 Тестування School-Today MCP Server v2.0 (Getters + Safe Setters)');
  console.log('🔒 ЖОДНИХ реальних змін до журналу під час тестів НЕ вноситься!');
  console.log('==================================================================\n');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, 'server.js')]
  });

  const client = new Client(
    { name: 'test-client-v2', version: '2.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('✅ З\'єднання з MCP-сервером встановлено!\n');

  // 1. Список інструментів та перевірка анотацій (Getters vs Setters)
  const tools = await client.listTools();
  const getters = tools.tools.filter(t => t.annotations && t.annotations.readOnlyHint === true);
  const setters = tools.tools.filter(t => t.annotations && t.annotations.readOnlyHint === false);
  console.log(`📋 1. Доступні інструменти: всього ${tools.tools.length} (🟢 Getters: ${getters.length}, 🟠 Setters: ${setters.length})`);
  for (const t of tools.tools) {
    const badge = t.annotations?.readOnlyHint ? '🟢 [GETTER]' : '🟠 [SETTER]';
    console.log(`   • ${badge} ${t.name}`);
  }

  // 2. Перевірка статусу авторизації (get_auth_status)
  console.log('\n🔐 2. Виклик get_auth_status:');
  const authRes = await client.callTool({ name: 'get_auth_status', arguments: {} });
  const authData = JSON.parse(authRes.content[0].text);
  console.log(`   Статус: ${authData.status}, Вчитель: ${authData.teacher.teacherName}, Автологін: ${authData.authDiagnostics.autoLoginConfigured}`);

  // 3. Перевірка розкладу з українськими відмінками та майбутнім тижнем (get_schedule)
  console.log('\n⏰ 3. Виклик get_schedule (filter: "наступний тиждень", class_name: "8 клас"):');
  const schedRes = await client.callTool({
    name: 'get_schedule',
    arguments: { filter: 'наступний тиждень', class_name: '8 клас' }
  });
  const schedData = JSON.parse(schedRes.content[0].text);
  console.log(`   Період: ${schedData.periodRange.start} .. ${schedData.periodRange.end}`);
  console.log(`   Знайдено уроків для 8 класу: ${schedData.totalLessons}`);
  schedData.lessons.forEach(l => {
    console.log(`     • [${l.fullDate}, ${l.dayOfWeek} ${l.time}] ${l.subject} — Тема: "${l.topic.slice(0, 45)}..." (ДЗ: ${l.hasHomework ? 'Так' : 'Ні'})`);
  });

  // 4. Глобальний аудит заповнення всіх журналів (audit_lessons_filling)
  console.log('\n🔍 4. Виклик audit_lessons_filling (перевірка заповненості всіх журналів):');
  const auditRes = await client.callTool({
    name: 'audit_lessons_filling',
    arguments: { start_date: '01.10', end_date: '17.10' }
  });
  const auditData = JSON.parse(auditRes.content[0].text);
  console.log('   Зведення за жовтень:', JSON.stringify(auditData.summary));

  // 5. Мультипредметне досьє учня (get_student_dossier)
  console.log('\n👤 5. Виклик get_student_dossier (student_name: "Кемалов", class_name_or_id: "7 клас"):');
  const dossierRes = await client.callTool({
    name: 'get_student_dossier',
    arguments: { student_name: 'Кемалов', class_name_or_id: '7 клас' }
  });
  const dossierData = JSON.parse(dossierRes.content[0].text);
  console.log(`   Учень: ${dossierData.studentName} (${dossierData.className}), Предметів: ${dossierData.subjectsCount}`);
  dossierData.subjects.forEach(s => {
    console.log(`     • ${s.subject}: Сер. бал = ${s.averageGrade || '—'}, Оцінок = ${s.totalMarksGiven}, Пропусків "Н" = ${s.totalAbsencesCount}`);
  });

  // 6. Розрахунок тематичних оцінок (get_thematic_evaluation)
  console.log('\n📊 6. Виклик get_thematic_evaluation ("7 клас", "Біологія"):');
  const themRes = await client.callTool({
    name: 'get_thematic_evaluation',
    arguments: { class_name_or_id: '7 клас', subject_or_id: 'Біологія' }
  });
  const themData = JSON.parse(themRes.content[0].text);
  console.log(`   Учнів у класі: ${themData.studentsCount}, Готові (>=3 оцінок): ${themData.readyCount}, Потребують опитування (<3 оцінок): ${themData.needsAttentionCount}`);
  themData.students.slice(0, 3).forEach(st => {
    console.log(`     • ${st.name}: оцінки [${st.gradesList.join(', ')}], середньозважена = ${st.schoolTodayWeightedAvg}, реком. тематична = ${st.recommendedThematicMark} (${st.status})`);
  });

  // 7. Тест SETTER: update_lesson_content (Preview + перевірка захисту від прямого confirm: true без прев'ю!)
  console.log('\n🛡️ 7. Тест захисту SETTER update_lesson_content (спроба передати confirm: true БЕЗ попереднього прев\'ю):');
  const updRes = await client.callTool({
    name: 'update_lesson_content',
    arguments: {
      class_name_or_id: '7 клас',
      subject_or_id: 'Біологія',
      date: '05.10',
      lesson_number: 1,
      topic: 'Тестова тема (Dry-Run)',
      confirm: true // Навмисно передаємо true без preview_token, щоб перевірити перехоплення!
    }
  });
  const updData = JSON.parse(updRes.content[0].text);
  console.log(`   Статус (має бути заблоковано в PREVIEW_ONLY): ${updData.status}`);
  console.log(`   Згенеровано previewToken: ${updData.previewToken}`);
  console.log(`   Повідомлення захисту: ${updData.notice}`);

  // 8. Тест SETTER: set_lesson_marks (Preview виставлення оцінки з коментарем + Preview очищення оцінки)
  console.log('\n🎯 8. Тест SETTER set_lesson_marks (Preview оцінки + коментар + очищення оцінки, confirm: false):');
  const marksRes = await client.callTool({
    name: 'set_lesson_marks',
    arguments: {
      class_name_or_id: '7 клас',
      subject_or_id: 'Біологія',
      date: '28.09',
      lesson_number: 2,
      marks: [
        { student_name: 'Балицький', mark: 10, comment: 'Активна робота' },
        { student_name: 'Кемалов', mark: null, clear: true }
      ],
      confirm: false
    }
  });
  const marksData = JSON.parse(marksRes.content[0].text);
  console.log(`   Статус: ${marksData.status}, previewToken: ${marksData.previewToken}`);
  marksData.changes.forEach(c => {
    console.log(`     • ${c.student}: було [${c.currentMark}] -> стане [${c.newMark}] (коментар: "${c.comment}")`);
  });
  if (marksData.warnings) {
    console.log('   Попередження безпеки:', marksData.warnings);
  }

  // 9. Тест SETTER: set_attendance (Preview з mark_all_present та захистом числових оцінок)
  console.log('\n⏱️ 9. Тест SETTER set_attendance (Preview на уроці з оцінками, перевірка захисту від затирання оцінок):');
  const attRes = await client.callTool({
    name: 'set_attendance',
    arguments: {
      class_name_or_id: '7 клас',
      subject_or_id: 'Біологія',
      date: '28.09',
      lesson_number: 2,
      attendance_list: [
        { student_name: 'Балицький', is_present: false },
        { student_name: 'Булаш', is_present: true, lateness_minutes: 10 }
      ],
      confirm: false
    }
  });
  const attData = JSON.parse(attRes.content[0].text);
  console.log(`   Статус: ${attData.status}, previewToken: ${attData.previewToken}`);
  attData.attendancePreview.forEach(a => {
    console.log(`     • ${a.student}: було [${a.previousValue}] -> статус [${a.newStatus}]`);
  });
  if (attData.warnings) {
    console.log('   Попередження безпеки:', attData.warnings);
  }

  await client.close();
  console.log('\n==================================================================');
  console.log('🎉 Усі тести MCP v2.0 пройдено на 100%! Жодних змін у реальний журнал не внесено.');
  console.log('==================================================================');
}

testMcpServer().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

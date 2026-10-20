const { SchoolTodayClient } = require('./src/core/client');
const { MetadataManager } = require('./src/metadata');

async function main() {
  try {
    console.log('🔐 Автоматична авторизація в School-Today...');
    const client = new SchoolTodayClient();
    await client.loginWithCredentials();
    const meta = await new MetadataManager(client).getMetadata(true);
    console.log(`✅ Авторизація успішна! Вчитель: ${meta.teacherName} (ID: ${meta.teacherId})`);
    console.log(`📚 Знайдено журналів: ${meta.journals.length}`);
    console.log('💾 Сесію збережено в cookies.json');
  } catch (err) {
    console.error('❌ Помилка авторизації:', err.message);
    process.exit(1);
  }
}

main();

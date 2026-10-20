const axios = require('axios');
const fs = require('fs');
const cheerio = require('cheerio');

async function testFetch() {
  const cookies = JSON.parse(fs.readFileSync('cookies.json', 'utf8'));
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  console.log('Sending direct HTTP GET to Teacher Cabinet...');
  const res = await axios.get('https://school-today.com/Cabinet/Teacher/20733', {
    headers: {
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  console.log('Status code:', res.status);
  const $ = cheerio.load(res.data);
  const title = $('title').text();
  console.log('Page Title:', title);

  // Parse Schedule items
  const scheduleItems = [];
  $('.widget').each((i, el) => {
    // Look for schedule containers
  });

  // Let's check text for teacher name
  console.log('Contains "Патока Владислава":', res.data.includes('Патока Владислава'));
  console.log('Contains "7 клас \\"Мислителі\\"":', res.data.includes('7 клас "Мислителі"'));
}

testFetch().catch(console.error);

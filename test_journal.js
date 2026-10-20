const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('journal_7_bio.html', 'utf8');
const $ = cheerio.load(html);

// Find the main journal table
const journalTable = $('table').filter((i, el) => {
  return $(el).text().includes('Балицький Михайло');
}).first();

console.log('Found journal table!');

// Extract column headers (Dates)
const columns = [];
journalTable.find('thead tr').each((rowIdx, tr) => {
  $(tr).find('th').each((colIdx, th) => {
    const text = $(th).text().replace(/\s+/g, ' ').trim();
    if (text) {
      columns.push(text);
    }
  });
});

console.log('Columns sample:', columns.slice(0, 15));

// Extract students and their marks
const students = [];
journalTable.find('tbody tr').each((rowIdx, tr) => {
  const tds = $(tr).find('td');
  if (tds.length > 2) {
    const name = $(tds[0]).text().trim();
    const avg = $(tds[1]).text().trim();
    const attendance = $(tds[2]).text().trim();
    
    // Marks in remaining cells
    const marks = [];
    tds.slice(3).each((colIdx, td) => {
      const cellText = $(td).text().trim();
      const inputVal = $(td).find('input').val();
      const mark = cellText || inputVal || '';
      if (mark) marks.push({ col: colIdx, val: mark });
    });

    if (name && !name.includes('семестр')) {
      students.push({
        name,
        averageGrade: avg,
        attendance,
        marksCount: marks.length,
        marksSample: marks.slice(0, 5)
      });
    }
  }
});

console.log(`\nSuccessfully parsed ${students.length} students:`);
console.log(JSON.stringify(students.slice(0, 5), null, 2));

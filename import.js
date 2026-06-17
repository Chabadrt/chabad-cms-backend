// import.js — CSV contact importer with column mapping support
const db = require('./db');

function importContacts(csv, mapping = {}, listId = null, listName = null) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return { imported: 0 };
  const rawHeaders = parseCSVLine(lines[0]);
  let imported = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(line);
    const getVal = (colIndex) => {
      if (colIndex === undefined || colIndex === null || colIndex < 0) return '';
      return (values[colIndex] || '').trim().replace(/^["']|["']$/g, '');
    };
    let name = '';
    if (mapping.fullName >= 0) {
      name = getVal(mapping.fullName);
    } else {
      const first = getVal(mapping.firstName);
      const last = getVal(mapping.lastName);
      name = [first, last].filter(Boolean).join(' ');
    }
    let phone = getVal(mapping.phone).replace(/[^\d+]/g, '');
    if (!phone) continue;
    if (!phone.startsWith('+')) {
      if (phone.length === 10) phone = '+1' + phone;
      else if (phone.length === 11 && phone.startsWith('1')) phone = '+' + phone;
      else phone = '+1' + phone;
    }
    let lists = ['all'];
    if (listId) {
      lists = [listId];
    } else if (mapping.list >= 0) {
      const csvListName = getVal(mapping.list);
      if (csvListName) {
        const csvListId = csvListName.toLowerCase().replace(/[^a-z0-9]/g, '_');
        lists = [csvListId];
      }
    }
    db.saveContact(phone, { name, lists });
    imported++;
  }
  return { imported };
}

function getCSVHeaders(csv) {
  const lines = csv.trim().split('\n');
  if (!lines.length) return [];
  return parseCSVLine(lines[0]).map(h => h.trim().replace(/^["']|["']$/g, ''));
}

function getCSVPreview(csv, maxRows = 3) {
  const lines = csv.trim().split('\n');
  const headers = parseCSVLine(lines[0]).map(h => h.trim().replace(/^["']|["']$/g, ''));
  const rows = [];
  for (let i = 1; i <= Math.min(maxRows, lines.length - 1); i++) {
    if (lines[i].trim()) rows.push(parseCSVLine(lines[i]).map(v => v.trim().replace(/^["']|["']$/g, '')));
  }
  return { headers, rows, total: lines.length - 1 };
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += char; }
  }
  result.push(current);
  return result;
}

module.exports = { importContacts, getCSVHeaders, getCSVPreview };

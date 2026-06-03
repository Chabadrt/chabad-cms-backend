// import.js — CSV contact importer endpoint
// Accepts a CSV file upload and saves all contacts to the database.

const db = require('./db');

function normalizePhone(raw) {
  // Strip everything except digits
  const digits = String(raw).replace(/[^0-9]/g, '');
  // Handle 10-digit or 11-digit (with leading 1)
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  // Normalize headers — lowercase, strip spaces
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, ''));

  const contacts = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Handle quoted fields
    const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || line.split(',');
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] || '').replace(/^"|"$/g, '').trim();
    });

    // Try to find phone — accept various column names
    const phoneRaw =
      row.phone || row.cell || row.mobile || row.number ||
      row.phone_number || row.cell_number || row.phonenumber || '';

    const phone = normalizePhone(phoneRaw);
    if (!phone) continue;

    // Try to find name
    const firstName =
      row.first_name || row.firstname || row.first || row.fname || '';
    const lastName =
      row.last_name || row.lastname || row.last || row.lname || '';
    const fullName =
      row.name || row.full_name || row.fullname ||
      [firstName, lastName].filter(Boolean).join(' ') || 'Guest';

    // List
    const list = row.list || row.group || row.tag || 'all';

    contacts.push({ phone, name: fullName, lists: [list] });
  }

  return contacts;
}

function importContacts(csvText) {
  const contacts = parseCSV(csvText);
  const results = { imported: 0, skipped: 0, errors: [] };

  for (const c of contacts) {
    try {
      db.saveContact(c.phone, { name: c.name, lists: c.lists });
      results.imported++;
    } catch (err) {
      results.skipped++;
      results.errors.push(`${c.phone}: ${err.message}`);
    }
  }

  return results;
}

module.exports = { importContacts, parseCSV };

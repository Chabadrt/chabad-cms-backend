// import.js — CSV contact importer
// Auto-creates any new list names found in the CSV

const db = require('./db');
const { getSettings, saveSettings } = require('./settings');

function normalizePhone(raw) {
  const digits = String(raw).replace(/[^0-9]/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, ''));
  const contacts = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || line.split(',');
    const row = {};
    headers.forEach((h, idx) => { row[h] = (values[idx] || '').replace(/^"|"$/g, '').trim(); });
    const phoneRaw = row.phone || row.cell || row.mobile || row.number || row.phone_number || row.cell_number || row.phonenumber || '';
    const phone = normalizePhone(phoneRaw);
    if (!phone) continue;
    const firstName = row.first_name || row.firstname || row.first || row.fname || '';
    const lastName = row.last_name || row.lastname || row.last || row.lname || '';
    const fullName = row.name || row.full_name || row.fullname || [firstName, lastName].filter(Boolean).join(' ') || 'Guest';
    const list = row.list || row.group || row.tag || 'all';
    contacts.push({ phone, name: fullName, lists: [list] });
  }
  return contacts;
}

function importContacts(csvText) {
  const contacts = parseCSV(csvText);
  const results = { imported: 0, skipped: 0, newLists: [], errors: [] };

  // Auto-create any new lists found in the CSV
  const settings = getSettings();
  const existingListIds = new Set(settings.lists.map(l => l.id));
  const listsToAdd = [];

  for (const c of contacts) {
    for (const listId of c.lists) {
      if (listId !== 'all' && !existingListIds.has(listId) && !listsToAdd.find(l => l.id === listId)) {
        // Convert id back to a readable name (e.g. "minyan_group" → "Minyan Group")
        const name = listId.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
        listsToAdd.push({ id: listId, name });
        existingListIds.add(listId);
        results.newLists.push(name);
      }
    }
  }

  if (listsToAdd.length) {
    const updatedLists = [...settings.lists, ...listsToAdd];
    saveSettings({ lists: updatedLists });
  }

  // Save contacts
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

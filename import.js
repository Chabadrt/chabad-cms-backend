const db = require('./db');

// mergeLists: when true (default), contacts keep any lists they were already in
// and the new list is added on top. When false, the new list replaces all others.
function importContacts(csv, mapping = {}, listId = null, listName = null, mergeLists = true) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return { imported: 0, merged: 0 };
  let imported = 0, merged = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(line);
    const getVal = (idx) => (idx == null || idx < 0) ? '' : (values[idx] || '').trim().replace(/^["']|["']$/g, '');

    let name = mapping.fullName >= 0
      ? getVal(mapping.fullName)
      : [getVal(mapping.firstName), getVal(mapping.lastName)].filter(Boolean).join(' ');

    let phone = getVal(mapping.phone).replace(/[^\d+]/g, '');
    if (!phone) continue;
    if (!phone.startsWith('+')) {
      if (phone.length === 10) phone = '+1' + phone;
      else if (phone.length === 11 && phone.startsWith('1')) phone = '+' + phone;
      else phone = '+1' + phone;
    }

    // Which list is this row headed for?
    let targetLists = ['all'];
    if (listId) {
      targetLists = [listId];
    } else if (mapping.list >= 0) {
      const n = getVal(mapping.list);
      if (n) targetLists = [n.toLowerCase().replace(/[^a-z0-9]/g, '_')];
    }

    let finalLists = targetLists;

    if (mergeLists) {
      const existing = db.getContact(phone);
      const existingLists = (existing && existing.lists) || [];
      if (existingLists.length) {
        const combined = existingLists.concat(targetLists);
        // de-dupe, preserving order
        const seen = {};
        finalLists = combined.filter(function (l) {
          if (!l || seen[l]) return false;
          seen[l] = true;
          return true;
        });
        // 'all' is the fallback bucket — drop it once there's a real list
        if (finalLists.length > 1 && finalLists.indexOf('all') > -1) {
          finalLists = finalLists.filter(l => l !== 'all');
        }
        if (finalLists.length > existingLists.length) merged++;
      }
    }

    // Only write name if the CSV actually supplied one, so a phone-only
    // import doesn't wipe a name we already have on file.
    const payload = { lists: finalLists };
    if (name) payload.name = name;

    db.saveContact(phone, payload);
    imported++;
  }

  return { imported, merged };
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
  let current = '', inQuotes = false;
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) { result.push(current); current = ''; }
    else current += char;
  }
  result.push(current);
  return result;
}

module.exports = { importContacts, getCSVPreview };

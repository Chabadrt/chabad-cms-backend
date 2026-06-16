// db.js — Simple file-based database using JSON
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function loadFile(name) {
  const p = path.join(DATA_DIR, name + '.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}
function saveFile(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(data, null, 2));
}

// ── CONTACTS ──────────────────────────────────────────────
function getContact(phone) { return loadFile('contacts')[phone] || null; }

function saveContact(phone, data) {
  const contacts = loadFile('contacts');
  contacts[phone] = { ...contacts[phone], ...data, phone, updatedAt: new Date().toISOString() };
  if (!contacts[phone].createdAt) contacts[phone].createdAt = new Date().toISOString();
  saveFile('contacts', contacts);
  return contacts[phone];
}

function getAllContacts() { return Object.values(loadFile('contacts')); }

// ── DELETE SINGLE CONTACT ─────────────────────────────────
function deleteContact(phone) {
  const contacts = loadFile('contacts');
  delete contacts[phone];
  saveFile('contacts', contacts);
}

// ── BULK DELETE CONTACTS ──────────────────────────────────
function bulkDeleteContacts(phones) {
  const contacts = loadFile('contacts');
  phones.forEach(phone => delete contacts[phone]);
  saveFile('contacts', contacts);
}

// ── REMOVE CONTACTS FROM A LIST ───────────────────────────
function removeContactsFromList(phones, listId) {
  const contacts = loadFile('contacts');
  phones.forEach(phone => {
    if (contacts[phone]) {
      contacts[phone].lists = (contacts[phone].lists || []).filter(l => l !== listId);
      if (!contacts[phone].lists.length) contacts[phone].lists = ['all'];
      contacts[phone].updatedAt = new Date().toISOString();
    }
  });
  saveFile('contacts', contacts);
}

// ── CONVERSATIONS ──────────────────────────────────────────
function getConversation(phone) { return loadFile('conversations')[phone] || { step: 'idle' }; }

function saveConversation(phone, data) {
  const convs = loadFile('conversations');
  convs[phone] = { ...convs[phone], ...data, phone, updatedAt: new Date().toISOString() };
  saveFile('conversations', convs);
}

function clearConversation(phone) {
  const convs = loadFile('conversations');
  convs[phone] = { step: 'idle' };
  saveFile('conversations', convs);
}

// ── EVENTS ────────────────────────────────────────────────
function saveEvent(event) { const events = loadFile('events'); events[event.id] = event; saveFile('events', events); }
function getEvent(id) { return loadFile('events')[id] || null; }
function getLatestEvent() {
  const events = Object.values(loadFile('events'));
  if (!events.length) return null;
  return events.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))[0];
}

// ── RSVPs ─────────────────────────────────────────────────
function saveRsvp(eventId, phone, data) {
  const rsvps = loadFile('rsvps');
  if (!rsvps[eventId]) rsvps[eventId] = {};
  rsvps[eventId][phone] = { ...rsvps[eventId][phone], ...data, phone, updatedAt: new Date().toISOString() };
  if (!rsvps[eventId][phone].createdAt) rsvps[eventId][phone].createdAt = new Date().toISOString();
  saveFile('rsvps', rsvps);
}
function getRsvpsForEvent(eventId) { return Object.values(loadFile('rsvps')[eventId] || {}); }

module.exports = {
  getContact, saveContact, getAllContacts,
  deleteContact, bulkDeleteContacts, removeContactsFromList,
  getConversation, saveConversation, clearConversation,
  saveEvent, getEvent, getLatestEvent,
  saveRsvp, getRsvpsForEvent
};

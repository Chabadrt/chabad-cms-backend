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
  const p = path.join(DATA_DIR, name + '.json');
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// ── CONTACTS ──────────────────────────────────────────────
function getContact(phone) {
  const contacts = loadFile('contacts');
  return contacts[phone] || null;
}

function saveContact(phone, data) {
  const contacts = loadFile('contacts');
  contacts[phone] = { ...contacts[phone], ...data, phone, updatedAt: new Date().toISOString() };
  if (!contacts[phone].createdAt) contacts[phone].createdAt = new Date().toISOString();
  saveFile('contacts', contacts);
  return contacts[phone];
}

function getAllContacts() {
  return Object.values(loadFile('contacts'));
}

// ── REMOVE CONTACTS FROM A LIST (bulk) ────────────────────
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
function getConversation(phone) {
  const convs = loadFile('conversations');
  return convs[phone] || { step: 'idle' };
}

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
function saveEvent(event) {
  const events = loadFile('events');
  events[event.id] = event;
  saveFile('events', events);
}

function getEvent(id) {
  const events = loadFile('events');
  return events[id] || null;
}

function getLatestEvent() {
  const events = Object.values(loadFile('events'));
  if (!events.length) return null;
  return events.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))[0];
}

// ── RSVPs ─────────────────────────────────────────────────
function saveRsvp(eventId, phone, data) {
  const rsvps = loadFile('rsvps');
  if (!rsvps[eventId]) rsvps[eventId] = {};
  rsvps[eventId][phone] = {
    ...rsvps[eventId][phone],
    ...data,
    phone,
    updatedAt: new Date().toISOString()
  };
  if (!rsvps[eventId][phone].createdAt) rsvps[eventId][phone].createdAt = new Date().toISOString();
  saveFile('rsvps', rsvps);
}

function getRsvpsForEvent(eventId) {
  const rsvps = loadFile('rsvps');
  return Object.values(rsvps[eventId] || {});
}

module.exports = {
  getContact, saveContact, getAllContacts, removeContactsFromList,
  getConversation, saveConversation, clearConversation,
  saveEvent, getEvent, getLatestEvent,
  saveRsvp, getRsvpsForEvent
};

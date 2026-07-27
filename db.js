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
}const fs = require('fs'), path = require('path');
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
function loadFile(name) { const p = path.join(DATA_DIR, name+'.json'); if (!fs.existsSync(p)) return {}; try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return {}; } }
function saveFile(name, data) { fs.writeFileSync(path.join(DATA_DIR, name+'.json'), JSON.stringify(data, null, 2)); }
function getContact(phone) { return loadFile('contacts')[phone] || null; }
function saveContact(phone, data) { const c = loadFile('contacts'); c[phone] = { ...c[phone], ...data, phone, updatedAt: new Date().toISOString() }; if (!c[phone].createdAt) c[phone].createdAt = new Date().toISOString(); saveFile('contacts', c); return c[phone]; }
function getAllContacts() { return Object.values(loadFile('contacts')); }
function deleteContact(phone) { const c = loadFile('contacts'); delete c[phone]; saveFile('contacts', c); }
function bulkDeleteContacts(phones) { const c = loadFile('contacts'); phones.forEach(p => delete c[p]); saveFile('contacts', c); }
function removeContactsFromList(phones, listId) { const c = loadFile('contacts'); phones.forEach(phone => { if (c[phone]) { c[phone].lists = (c[phone].lists||[]).filter(l=>l!==listId); if (!c[phone].lists.length) c[phone].lists=['all']; c[phone].updatedAt=new Date().toISOString(); } }); saveFile('contacts', c); }
function getConversation(phone) { return loadFile('conversations')[phone] || { step: 'idle' }; }
function saveConversation(phone, data) { const c = loadFile('conversations'); c[phone] = { ...c[phone], ...data, phone, updatedAt: new Date().toISOString() }; saveFile('conversations', c); }
function clearConversation(phone) { const c = loadFile('conversations'); c[phone] = { step: 'idle' }; saveFile('conversations', c); }
function saveEvent(event) { const e = loadFile('events'); e[event.id] = event; saveFile('events', e); }
function getEvent(id) { return loadFile('events')[id] || null; }
function getLatestEvent() { const e = Object.values(loadFile('events')); if (!e.length) return null; return e.sort((a,b)=>new Date(b.sentAt)-new Date(a.sentAt))[0]; }
function saveRsvp(eventId, phone, data) { const r = loadFile('rsvps'); if (!r[eventId]) r[eventId]={}; r[eventId][phone] = { ...r[eventId][phone], ...data, phone, updatedAt: new Date().toISOString() }; if (!r[eventId][phone].createdAt) r[eventId][phone].createdAt=new Date().toISOString(); saveFile('rsvps', r); }
function getRsvpsForEvent(eventId) { return Object.values(loadFile('rsvps')[eventId]||{}); }
module.exports = { getContact, saveContact, getAllContacts, deleteContact, bulkDeleteContacts, removeContactsFromList, getConversation, saveConversation, clearConversation, saveEvent, getEvent, getLatestEvent, saveRsvp, getRsvpsForEvent };


function getContact(phone) { return loadFile('contacts')[phone] || null; }
function saveContact(phone, data) {
  const contacts = loadFile('contacts');
  contacts[phone] = { ...contacts[phone], ...data, phone, updatedAt: new Date().toISOString() };
  if (!contacts[phone].createdAt) contacts[phone].createdAt = new Date().toISOString();
  saveFile('contacts', contacts);
  return contacts[phone];
}
function getAllContacts() { return Object.values(loadFile('contacts')); }
function deleteContact(phone) { const c = loadFile('contacts'); delete c[phone]; saveFile('contacts', c); }
function bulkDeleteContacts(phones) { const c = loadFile('contacts'); phones.forEach(p => delete c[p]); saveFile('contacts', c); }
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

function saveEvent(event) { const events = loadFile('events'); events[event.id] = event; saveFile('events', events); }
function getEvent(id) { return loadFile('events')[id] || null; }
function getLatestEvent() {
  const events = Object.values(loadFile('events'));const fs = require('fs'), path = require('path');
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
function loadFile(name) { const p = path.join(DATA_DIR, name+'.json'); if (!fs.existsSync(p)) return {}; try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { return {}; } }
function saveFile(name, data) { fs.writeFileSync(path.join(DATA_DIR, name+'.json'), JSON.stringify(data, null, 2)); }
function getContact(phone) { return loadFile('contacts')[phone] || null; }
function saveContact(phone, data) { const c = loadFile('contacts'); c[phone] = { ...c[phone], ...data, phone, updatedAt: new Date().toISOString() }; if (!c[phone].createdAt) c[phone].createdAt = new Date().toISOString(); saveFile('contacts', c); return c[phone]; }
function getAllContacts() { return Object.values(loadFile('contacts')); }
function deleteContact(phone) { const c = loadFile('contacts'); delete c[phone]; saveFile('contacts', c); }
function bulkDeleteContacts(phones) { const c = loadFile('contacts'); phones.forEach(p => delete c[p]); saveFile('contacts', c); }
function removeContactsFromList(phones, listId) { const c = loadFile('contacts'); phones.forEach(phone => { if (c[phone]) { c[phone].lists = (c[phone].lists||[]).filter(l=>l!==listId); if (!c[phone].lists.length) c[phone].lists=['all']; c[phone].updatedAt=new Date().toISOString(); } }); saveFile('contacts', c); }
function getConversation(phone) { return loadFile('conversations')[phone] || { step: 'idle' }; }
function saveConversation(phone, data) { const c = loadFile('conversations'); c[phone] = { ...c[phone], ...data, phone, updatedAt: new Date().toISOString() }; saveFile('conversations', c); }
function clearConversation(phone) { const c = loadFile('conversations'); c[phone] = { step: 'idle' }; saveFile('conversations', c); }
function saveEvent(event) { const e = loadFile('events'); e[event.id] = event; saveFile('events', e); }
function getEvent(id) { return loadFile('events')[id] || null; }
function getLatestEvent() { const e = Object.values(loadFile('events')); if (!e.length) return null; return e.sort((a,b)=>new Date(b.sentAt)-new Date(a.sentAt))[0]; }
function saveRsvp(eventId, phone, data) { const r = loadFile('rsvps'); if (!r[eventId]) r[eventId]={}; r[eventId][phone] = { ...r[eventId][phone], ...data, phone, updatedAt: new Date().toISOString() }; if (!r[eventId][phone].createdAt) r[eventId][phone].createdAt=new Date().toISOString(); saveFile('rsvps', r); }
function getRsvpsForEvent(eventId) { return Object.values(loadFile('rsvps')[eventId]||{}); }
module.exports = { getContact, saveContact, getAllContacts, deleteContact, bulkDeleteContacts, removeContactsFromList, getConversation, saveConversation, clearConversation, saveEvent, getEvent, getLatestEvent, saveRsvp, getRsvpsForEvent };

  if (!events.length) return null;
  return events.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))[0];
}

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

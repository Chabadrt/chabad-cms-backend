const fs = require('fs'), path = require('path');
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

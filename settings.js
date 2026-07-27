const fs = require('fs'), path = require('path');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const DEFAULTS = {
  botIntro: "This is Rabbi Benjy's new texting bot 🤖\n(yes, the Rabbi has been having a little too much fun with AI lately 😄)",
  rsvpPrompt: "Please reply with just a number:\n1 — I'll be there 🙏\n2 — Can't make it this time",
  noReply: "No worries! We'll miss you. Hope to see you next time! 💛\n\n— Rabbi Benjy & Hinda Silverman",
  donationAsk: "Would you like to make a donation to support our programs?",
  donationThankYou: "Great! Here's your secure payment link:",
  confirmationNote: "",
  unrecognizedReply: "Sorry, I didn't understand that. Please reply with 1 (Yes) or 2 (No).",
  lists: [{ id: 'all', name: 'All Contacts' }],
  receiptType: 'donation', receiptMessage: ''
};
function getSettings() { try { if (!fs.existsSync(SETTINGS_FILE)) return {...DEFAULTS}; return {...DEFAULTS,...JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8'))}; } catch { return {...DEFAULTS}; } }
function saveSettings(updates) { const dir=path.dirname(SETTINGS_FILE); if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true}); const merged={...getSettings(),...updates}; fs.writeFileSync(SETTINGS_FILE,JSON.stringify(merged,null,2)); return merged; }
module.exports = { getSettings, saveSettings };

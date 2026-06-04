// settings.js — Manages editable message settings
// Saves to a JSON file so changes persist across restarts

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  botIntro: "Hi! This is Rabbi Benjy's new texting bot 🤖\n(yes, the Rabbi has been having a little too much fun with AI lately 😄)",
  rsvpPrompt: "Please reply with just a number:\n1 — I'll be there 🙏\n2 — Can't make it this time",
  noReply: "No problem! We'll miss you. Hope to see you next time. 💛\n\nReply STOP to unsubscribe.",
  donationAsk: "💛 Would you like to make a donation to Chabad of the Rivertowns?",
  donationAmounts: "1 — $5\n2 — $10\n3 — $18 (Chai ✡️)\nN — No thank you",
  donationLink: "https://buy.stripe.com/aFa00j3Jcbj1bwhcPp53O00",
  confirmationNote: "Looking forward to seeing you! 🙏",
  unrecognizedReply: "To make sure I get your answer correctly, please reply with just:\n\n1 — Yes, I'll be there 🙏\n2 — Can't make it this time\n\n(This is an automated system — just the number works best! 🤖)",
};

function getSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return { ...DEFAULTS };
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(updates) {
  const current = getSettings();
  const merged = { ...current, ...updates };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = { getSettings, saveSettings, DEFAULTS };

// settings.js — Loads and saves bot message settings
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

const DEFAULTS = {
  botIntro: "This is Rabbi Benjy's new texting bot 🤖\n(yes, the Rabbi has been having a little too much fun with AI lately 😄)",
  rsvpPrompt: "Please reply with just a number:\n1 — I'll be there 🙏\n2 — Can't make it this time",
  noReply: "No worries! We'll miss you. Hope to see you next time! 💛\n\n— Rabbi Benjy & Hinda Silverman",
  donationAsk: "Would you like to make a donation to support our programs?",
  donationAmounts: "1 — $5\n2 — $10\n3 — $18 (Chai ✡️)\nOr reply with any amount\nN — No thank you",
  donationThankYou: "Great! Here's your secure payment link:",
  cardSavedNote: "💳 Your card has been saved for next time!",
  confirmationNote: "",
  unrecognizedReply: "Sorry, I didn't understand that. Please reply with 1 (Yes) or 2 (No).",
  donationLinks: { 5: '', 10: '', 18: '' },
  lists: [{ id: 'all', name: 'All Contacts' }],
  receiptType: 'donation',
  receiptMessage: ''
};

function getSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return { ...DEFAULTS };
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { ...DEFAULTS, ...data };
  } catch { return { ...DEFAULTS }; }
}

function saveSettings(updates) {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const current = getSettings();
  const merged = { ...current, ...updates };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = { getSettings, saveSettings };

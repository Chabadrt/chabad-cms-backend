# ✡️ Chabad of the Rivertowns — SMS RSVP Backend

This is the engine that powers the SMS RSVP system.
See the full setup guide (Word document) for step-by-step instructions.

## Files in this folder

| File | What it does |
|------|-------------|
| server.js | The main app — handles incoming texts and the dashboard |
| sms.js | The conversation brain — decides what to reply at each step |
| payments.js | Talks to Stripe for donations and card-on-file charging |
| db.js | Saves contacts, RSVPs, and events to local files |
| .env.example | Template for your credentials — rename to .env and fill in |
| railway.json | Tells Railway how to run the app |

## Deploying to Railway

1. Go to railway.app and log in
2. Click "New Project" → "Deploy from GitHub Repo" (or upload this folder)
3. Go to the Variables tab and add all values from .env.example
4. Railway will auto-deploy — takes about 2 minutes
5. Copy your Railway URL and paste it into the Twilio webhook field

## Your Webhook URL (for Twilio)

https://YOUR-RAILWAY-URL.railway.app/sms/incoming

## Need help?

Bring any error messages back to the Claude conversation and we'll fix it together.

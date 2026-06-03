
// ── CSV IMPORT ────────────────────────────────────────────
const { importContacts } = require('./import');

app.post('/contacts/import', (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'No CSV data provided' });
  try {
    const results = importContacts(csv);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DASHBOARD ─────────────────────────────────────────────
const path = require('path');
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

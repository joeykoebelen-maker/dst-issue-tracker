require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

// Monitored chat names
const MONITORED_CHATS = [
  'Joey - Deep Sand Technology',
  'CHDP Main Support',
  'Workgroup - FJD & DST',
  'Ordering Group'
];

// Google Sheets auth
function getSheetsClient() {
  const key = JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

// Get Lark tenant token
let tenantToken = null;
let tokenExpiry = 0;
async function getTenantToken() {
  if (tenantToken && Date.now() < tokenExpiry) return tenantToken;
  const res = await axios.post('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: LARK_APP_ID,
    app_secret: LARK_APP_SECRET
  });
  tenantToken = res.data.tenant_access_token;
  tokenExpiry = Date.now() + (res.data.expire - 60) * 1000;
  return tenantToken;
}

// Append row to Google Sheet
async function appendRow(sheet, values) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheet}!A1`,
    valueInputOption: 'RAW',
    resource: { values: [values] }
  });
}

// Get chat name from chat_id
async function getChatName(chatId) {
  try {
    const token = await getTenantToken();
    const res = await axios.get(`https://open.larksuite.com/open-apis/im/v1/chats/${chatId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return res.data.data.name || chatId;
  } catch (e) {
    return chatId;
  }
}

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Lark webhook
app.post('/webhook/lark/events', async (req, res) => {
  const body = req.body;

  // Handle Lark challenge verification
  if (body.challenge) {
    return res.json({ challenge: body.challenge });
  }

  try {
    const event = body.event;
    if (!event || !event.message) return res.json({ code: 0 });

    const msg = event.message;
    const chatId = msg.chat_id;
    const sender = event.sender?.sender_id?.user_id || 'unknown';
    const text = msg.content ? JSON.parse(msg.content).text || '' : '';
    const ts = msg.create_time || Date.now().toString();

    const chatName = await getChatName(chatId);

    // Only process monitored chats
    const isMonitored = MONITORED_CHATS.some(c => chatName.includes(c) || c.includes(chatName));
    if (!isMonitored) return res.json({ code: 0 });

    // Log to Messages sheet
    await appendRow('Messages', [chatName, text, sender, ts, JSON.stringify(body)]);

    // Check if this looks like a new issue (questions or problem keywords)
    const issueKeywords = ['issue', 'problem', 'error', 'help', 'broken', 'not working', 'fix', '?'];
    const isIssue = issueKeywords.some(k => text.toLowerCase().includes(k));

    if (isIssue) {
      const issueId = `ISS-${Date.now()}`;
      const now = new Date().toISOString();
      await appendRow('Issues', [
        issueId, chatName, text.substring(0, 100), now, '', now,
        sender, '', 'medium', 'open', 'true', '1'
      ]);
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
  }

  res.json({ code: 0 });
});

// Get all issues
app.get('/issues', async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Issues!A:L'
    });
    res.json({ issues: result.data.values || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get digest
app.get('/digest', async (req, res) => {
  try {
    const sheets = getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Issues!A:L'
    });
    const rows = result.data.values || [];
    const open = rows.filter(r => r[9] === 'open').length;
    res.json({ total: rows.length - 1, open, generated: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`DST Issue Tracker running on port ${PORT}`));

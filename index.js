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

// Monitored chat names (partial match)
const MONITORED_CHATS = [
  'Joey - Deep Sand Technology',
  'CHDP Main Support',
  'Workgroup - FJD & DST',
  'Ordering Group',
  'joey koebelen, Drew, Christian'
];

// Track last poll time per chat
const lastPollTime = {};
let tenantToken = null;
let tokenExpiry = 0;

// ---- LARK AUTH ----
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

// ---- GOOGLE SHEETS ----
function getSheetsClient() {
  const key = JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

async function appendToSheet(sheetName, values) {
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [values] }
    });
  } catch (e) {
    console.error('Sheet append error:', e.message);
  }
}

// ---- ISSUE DETECTION ----
function detectIssue(text) {
  const lower = text.toLowerCase();
  const issueKeywords = [
    'issue', 'problem', 'error', 'fail', 'broken', 'not working',
    'help', 'stuck', 'losing signal', 'activation failed', 'unresolved',
    'firmware', 'fix', 'bug', 'wrong', 'incorrect', 'missing',
    'cant', "can't", 'unable', 'wont', "won't", 'doesnt', "doesn't",
    'no response', 'not responding', 'delayed', 'overdue', 'waiting',
    'need', 'urgent', 'asap', 'please', 'update'
  ];
  return issueKeywords.some(k => lower.includes(k));
}

function classifyIssue(text) {
  const lower = text.toLowerCase();
  if (lower.includes('signal') || lower.includes('gps') || lower.includes('rtk')) return 'Signal/GPS';
  if (lower.includes('activation') || lower.includes('license')) return 'Activation/License';
  if (lower.includes('firmware') || lower.includes('update') || lower.includes('software')) return 'Firmware/Software';
  if (lower.includes('order') || lower.includes('ship') || lower.includes('deliver')) return 'Order/Shipping';
  if (lower.includes('camera') || lower.includes('sensor') || lower.includes('hardware')) return 'Hardware';
  if (lower.includes('cable') || lower.includes('power') || lower.includes('install')) return 'Install/Cable';
  return 'General';
}

// ---- FETCH CHAT LIST ----
async function getMonitoredChatIds() {
  const token = await getTenantToken();
  const chatIds = [];
  let pageToken = '';
  
  do {
    const res = await axios.get('https://open.larksuite.com/open-apis/im/v1/chats', {
      headers: { Authorization: `Bearer ${token}` },
      params: { page_size: 50, page_token: pageToken || undefined }
    });
    const items = res.data.data?.items || [];
    for (const chat of items) {
      const name = chat.name || '';
      if (MONITORED_CHATS.some(m => name.includes(m) || m.includes(name.substring(0,15)))) {
        chatIds.push({ id: chat.chat_id, name });
        console.log(`Monitoring chat: ${name} (${chat.chat_id})`);
      }
    }
    pageToken = res.data.data?.page_token || '';
  } while (pageToken);

  // Also try user token approach - fetch all chats the bot can see
  return chatIds;
}

// ---- FETCH MESSAGES ----
async function fetchRecentMessages(chatId, since) {
  const token = await getTenantToken();
  const messages = [];
  
  try {
    const params = {
      container_id_type: 'chat',
      container_id: chatId,
      page_size: 50
    };
    if (since) params.start_time = Math.floor(since / 1000).toString();
    
    const res = await axios.get('https://open.larksuite.com/open-apis/im/v1/messages', {
      headers: { Authorization: `Bearer ${token}` },
      params
    });
    
    const items = res.data.data?.items || [];
    for (const msg of items) {
      if (msg.msg_type === 'text') {
        try {
          const body = JSON.parse(msg.body?.content || '{}');
          messages.push({
            msgId: msg.message_id,
            sender: msg.sender?.id || 'unknown',
            text: body.text || '',
            time: new Date(parseInt(msg.create_time)).toISOString()
          });
        } catch(e) {}
      }
    }
  } catch(e) {
    console.error(`Fetch messages error for ${chatId}:`, e.message);
  }
  return messages;
}

// ---- MAIN POLL LOOP ----
let monitoredChats = [];
let pollInitialized = false;

async function initChats() {
  try {
    monitoredChats = await getMonitoredChatIds();
    console.log(`Found ${monitoredChats.length} monitored chats`);
    pollInitialized = true;
  } catch(e) {
    console.error('Init chats error:', e.message);
  }
}

async function pollMessages() {
  if (!pollInitialized) return;
  
  for (const chat of monitoredChats) {
    try {
      const since = lastPollTime[chat.id] || (Date.now() - 60 * 60 * 1000); // last 1 hour on first run
      const messages = await fetchRecentMessages(chat.id, since);
      
      for (const msg of messages) {
        const msgTime = new Date(msg.time).getTime();
        if (msgTime <= (lastPollTime[chat.id] || 0)) continue;
        
        // Log ALL messages to Messages sheet
        await appendToSheet('Messages', [
          new Date(msg.time).toLocaleString('en-US', {timeZone: 'America/Chicago'}),
          chat.name,
          msg.sender,
          msg.text.substring(0, 500)
        ]);
        
        // If message looks like an issue, log to Issues sheet
        if (detectIssue(msg.text)) {
          await appendToSheet('Issues', [
            new Date(msg.time).toLocaleString('en-US', {timeZone: 'America/Chicago'}),
            chat.name,
            msg.sender,
            classifyIssue(msg.text),
            msg.text.substring(0, 500),
            'Open',
            ''
          ]);
          console.log(`Issue logged from ${chat.name}: ${msg.text.substring(0, 80)}`);
        }
      }
      
      if (messages.length > 0) {
        lastPollTime[chat.id] = Date.now();
      }
    } catch(e) {
      console.error(`Poll error for ${chat.name}:`, e.message);
    }
  }
}

// ---- LARK WEBHOOK (still handle events if bot IS in a chat) ----
app.post('/webhook/lark/events', async (req, res) => {
  const body = req.body;
  
  // Verification challenge
  if (body.challenge) {
    return res.json({ challenge: body.challenge });
  }
  
  try {
    const event = body.event;
    if (event?.message?.message_type === 'text') {
      const chatId = event.message.chat_id;
      const text = JSON.parse(event.message.content || '{}').text || '';
      const senderId = event.sender?.sender_id?.user_id || 'unknown';
      const chatName = event.message.chat_id;
      const time = new Date().toLocaleString('en-US', {timeZone: 'America/Chicago'});
      
      await appendToSheet('Messages', [time, chatName, senderId, text.substring(0, 500)]);
      
      if (detectIssue(text)) {
        await appendToSheet('Issues', [time, chatName, senderId, classifyIssue(text), text.substring(0, 500), 'Open', '']);
      }
    }
  } catch(e) {
    console.error('Webhook error:', e.message);
  }
  
  res.json({ code: 0 });
});

// ---- STATUS ENDPOINT ----
app.get('/', (req, res) => {
  res.json({
    status: 'DST Issue Tracker running',
    monitoredChats: monitoredChats.length,
    chats: monitoredChats.map(c => c.name),
    lastPoll: new Date().toISOString()
  });
});

app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    monitoredChats: monitoredChats.map(c => ({ name: c.name, id: c.chat_id })),
    pollInitialized
  });
});

app.get('/poll-now', async (req, res) => {
  await pollMessages();
  res.json({ status: 'polled', chats: monitoredChats.length });
});

// ---- START ----
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initChats();
  // Poll every 5 minutes
  setInterval(pollMessages, 5 * 60 * 1000);
  // Run first poll after 10 seconds
  setTimeout(pollMessages, 10000);
});

const express = require("express");
const axios = require("axios");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../dashboard")));

// ── State ──────────────────────────────────────────────
let agentEnabled = true;
const chatHistory = {};
const contacts = {};

// ── Helpers ────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

function saveHistory() {}
function loadHistory() { log("Starting fresh (in-memory only)"); }

function getName(phone) {
  return contacts[phone] || phone;
}

function addMessage(phone, role, content) {
  if (!chatHistory[phone]) chatHistory[phone] = [];
  chatHistory[phone].push({ role, content, timestamp: Date.now() });
  if (chatHistory[phone].length > 50) chatHistory[phone].shift();
}

// ── UltraMsg: Send Message ──────────────────────────────
async function sendMessage(to, text) {
  const res = await axios.post(
    `https://api.ultramsg.com/${process.env.ULTRA_INSTANCE}/messages/chat`,
    {
      token: process.env.ULTRA_TOKEN,
      to: to,
      body: text,
    },
    { headers: { "Content-Type": "application/json" } }
  );
  log(`📤 Sent to ${getName(to)}: ${text.slice(0, 60)}`);
}

// ── Groq AI: Generate Reply ───────────────────────────
async function getAIReply(phone, incomingText) {
  const history = (chatHistory[phone] || []).map(h => ({
    role: h.role,
    content: h.content,
  }));

  history.push({ role: "user", content: incomingText });

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content: `Tera naam Ali hai. Tu ek super friendly aur funny WhatsApp chatbot hai.

Teri personality:
- Tu bahut funny aur entertaining hai — jokes aur memes wali language use karta hai
- Tu Urdu aur English dono mein baat karta hai (Hinglish/Roman Urdu style)
- Tu har message pe energetically respond karta hai
- Tu emojis freely use karta hai 😄🔥💯
- Tu kabhi boring nahi hota
- Tu saamne wale ko hamesha khush rakhta hai
- Agar koi sad ho toh tu unhe cheer up karta hai
- Tu chhoti chhoti baaton pe bhi mazaak karta hai
- Tu bahut caring bhi hai

Rules:
- Replies short rakho — real WhatsApp jaisi (1-3 lines max)
- Roman Urdu freely use karo (yaar, bhai, yrr, kya baat, achi baat etc)
- Har reply mein thoda fun hona chahiye
- Context yaad rakho chat history se
- Aaj ki date: ${new Date().toLocaleDateString()}
- Is waqt baat ho rahi hai: ${getName(phone)} se`
        },
        ...history
      ],
    },
    {
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data.choices[0].message.content;
}

// ── Webhook ────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const data = req.body;
    const msg = data?.data;
    if (!msg) { log("⚠️ No msg.data found"); return; }
    if (!msg.body) { log("⚠️ No msg.body found"); return; }
    if (msg.fromMe) { log("⚠️ fromMe=true, skipping"); return; }

    const from = msg.from;
    const text = msg.body;
    const name = msg.pushname || from;

    contacts[from] = name;

    log(`📥 From ${name}: ${text}`);
    log(`🤖 agentEnabled = ${agentEnabled}`);
    addMessage(from, "user", text);

    if (agentEnabled) {
      log(`🔄 Getting AI reply...`);
      const reply = await getAIReply(from, text);
      log(`✅ AI reply: ${reply.slice(0, 100)}`);
      await sendMessage(from, reply);
      addMessage(from, "assistant", reply);
    } else {
      log(`👤 Manual mode — no auto reply`);
    }

  } catch (err) {
    log(`❌ Error: ${err.message}`);
  }
});

// ── Dashboard APIs ──────────────────────────────────────
app.get("/api/status", (req, res) => res.json({
  agentEnabled,
  totalContacts: Object.keys(contacts).length,
  totalMessages: Object.values(chatHistory).reduce((s, h) => s + h.length, 0),
}));

app.post("/api/toggle", (req, res) => {
  agentEnabled = !agentEnabled;
  log(`🔄 Agent is now ${agentEnabled ? "ON (AI)" : "OFF (Manual)"}`);
  res.json({ agentEnabled });
});

app.get("/api/contacts", (req, res) => {
  const result = Object.entries(contacts).map(([phone, name]) => {
    const h = chatHistory[phone] || [];
    const last = h[h.length - 1];
    return {
      phone, name,
      messageCount: h.length,
      lastMessage: last?.content?.slice(0, 60) || "",
      lastTime: last?.timestamp || null,
    };
  }).sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
  res.json(result);
});

app.get("/api/chat/:phone", (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  res.json({
    contact: { phone, name: getName(phone) },
    messages: chatHistory[phone] || [],
  });
});

app.post("/api/send", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message)
    return res.status(400).json({ error: "phone and message required" });
  await sendMessage(phone, message);
  addMessage(phone, "assistant", message);
  res.json({ success: true });
});

// ── Start ───────────────────────────────────────────────
loadHistory();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`🚀 Server running at http://localhost:${PORT}`);
  log(`🔑 ENV CHECK - ULTRA_INSTANCE: ${process.env.ULTRA_INSTANCE}`);
});

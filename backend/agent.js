const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");
const { Boom } = require("@hapi/boom");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../dashboard"), { index: "welcome.html" }));

// ── State ──────────────────────────────────────────────
let agentEnabled = true;
let waConnected = false;
let currentQR = null;
let sock = null;
let clearedForCurrentQR = false;
const chatHistory = {};
const contacts = {};
const contactSettings = {}; // { [phone]: personaKey }

// ── Helpers ────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

function getName(phone) {
  return contacts[phone] || phone;
}

// ── Personas ─────────────────────────────────────────
const PERSONAS = {
  ali: {
    label: "Ali - Funny (default)",
    prompt: `Tera naam Ali hai. Tu ek super friendly aur funny WhatsApp chatbot hai.

Teri personality:
- Tu bahut funny aur entertaining hai — jokes aur memes wali language use karta hai
- Tu Urdu aur English dono mein baat karta hai (Hinglish/Roman Urdu style)
- Tu har message pe energetically respond karta hai
- Tu kabhi boring nahi hota
- Tu saamne wale ko hamesha khush rakhta hai
- Agar koi sad ho toh tu unhe cheer up karta hai
- Tu chhoti chhoti baaton pe bhi mazaak karta hai
- Tu bahut caring bhi hai`,
  },
  professional: {
    label: "Professional",
    prompt: `Tera naam Ali hai. Tu ek professional, polite aur seedhe tareeqe se baat karne wala WhatsApp assistant hai.

Teri personality:
- Tu formal aur respectful tone use karta hai
- Tu seedha point pe aata hai, waqt zaya nahi karta
- Tu clear aur helpful jawab deta hai
- Tu emotional ya casual language avoid karta hai
- Tu hamesha polite rehta hai`,
  },
  caring: {
    label: "Caring / Supportive",
    prompt: `Tera naam Ali hai. Tu ek warm, caring aur supportive WhatsApp dost hai.

Teri personality:
- Tu bahut caring aur samajhdar hai
- Tu saamne wale ki baat ghor se sunta hai aur unhe support karta hai
- Tu gentle aur soft tone use karta hai
- Agar koi pareshan ho to tu unhe sukoon deta hai
- Tu casual Roman Urdu use karta hai lekin bohot respectful tareeqe se`,
  },
};

function getPersonaPrompt(phone) {
  const key = contactSettings[phone] || "ali";
  return (PERSONAS[key] || PERSONAS.ali).prompt;
}

const DATA_FILE = path.join(__dirname, "data.json");

function saveData() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ chatHistory, contacts, contactSettings }, null, 2)
    );
  } catch (err) {
    log(`⚠️ Failed to save data: ${err.message}`);
  }
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      Object.assign(chatHistory, raw.chatHistory || {});
      Object.assign(contacts, raw.contacts || {});
      Object.assign(contactSettings, raw.contactSettings || {});
      log(`📂 Loaded saved history: ${Object.keys(contacts).length} contacts`);
    }
  } catch (err) {
    log(`⚠️ Failed to load data: ${err.message}`);
  }
}

function addMessage(phone, role, content) {
  if (!chatHistory[phone]) chatHistory[phone] = [];
  chatHistory[phone].push({ role, content, timestamp: Date.now() });
  if (chatHistory[phone].length > 50) chatHistory[phone].shift();
  saveData();
}

// ── Clear everything on real logout ───────────────────
function clearSessionData() {
  try {
    fs.rmSync(path.join(__dirname, "auth_info"), {
      recursive: true,
      force: true,
    });
    log("🗑️ auth_info folder deleted");
  } catch (err) {
    log(`⚠️ auth_info delete nahi ho saka: ${err.message}`);
  }

  for (const key of Object.keys(chatHistory)) delete chatHistory[key];
  for (const key of Object.keys(contacts)) delete contacts[key];
  for (const key of Object.keys(contactSettings)) delete contactSettings[key];
  saveData();
  log("🗑️ Purani chats/contacts/personas clear kar diye gaye");
}

// ── Groq AI: Generate Reply ───────────────────────────
async function getAIReply(phone, incomingText) {
  const history = (chatHistory[phone] || []).map((h) => ({
    role: h.role,
    content: h.content,
  }));

  history.push({ role: "user", content: incomingText });

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "openai/gpt-oss-120b",
      max_tokens: 700,
      reasoning_effort: "low",
      messages: [
        {
          role: "system",
          content: `${getPersonaPrompt(phone)}

Rules:
- Replies BOHOT short rakho — 1 line, zyada se zyada 2 chhoti lines
- Koi emoji use NAHI karna, kabhi bhi
- Roman Urdu freely use karo (yaar, bhai, yrr, kya baat, achi baat etc)
- Har reply mein thoda fun hona chahiye lekin seedha point pe rehna
- Context yaad rakho chat history se
- Aaj ki date: ${new Date().toLocaleDateString()}
- Is waqt baat ho rahi hai: ${getName(phone)} se`,
        },
        ...history,
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data.choices[0].message.content;
}

// ── Baileys: WhatsApp Connection ────────────────────────
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(__dirname, "auth_info")
  );
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = await QRCode.toDataURL(qr);
      if (!clearedForCurrentQR) {
        clearedForCurrentQR = true;
        for (const key of Object.keys(chatHistory)) delete chatHistory[key];
        for (const key of Object.keys(contacts)) delete contacts[key];
        for (const key of Object.keys(contactSettings)) delete contactSettings[key];
        saveData();
        log("🗑️ Naya QR generate hua — purani chats/contacts clear kar diye gaye");
      }
      log("📱 QR code ready — open the dashboard (http://localhost:3000) to scan it");
    }

    if (connection === "close") {
      waConnected = false;
      const statusCode =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : null;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      log(`⚠️ Connection closed. Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        // Normal disconnect (network drop, restart, etc.) — reuse saved session, no QR needed
        startWhatsApp();
      } else {
        // Real logout from phone — old session is dead, clean up and auto-generate fresh QR
        log("🔒 Logged out from phone — auth_info aur purani chats clear ho rahi hain, naya QR ban raha hai...");
        clearSessionData();
        startWhatsApp();
      }
    } else if (connection === "open") {
      waConnected = true;
      currentQR = null;
      clearedForCurrentQR = false;
      log("✅ WhatsApp connected!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    if (!from || from.endsWith("@g.us") || from === "status@broadcast") return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";
    if (!text) return;

    const name = msg.pushName || from;
    contacts[from] = name;
    saveData();

    log(`📥 From ${name}: ${text}`);
    addMessage(from, "user", text);

    if (agentEnabled) {
      try {
        log("🔄 Getting AI reply...");
        const reply = await getAIReply(from, text);
        await sock.sendMessage(from, { text: reply });
        log(`✅ AI reply sent: ${reply.slice(0, 100)}`);
        addMessage(from, "assistant", reply);
      } catch (err) {
        log(`❌ AI reply error: ${err.message}`);
      }
    } else {
      log("👤 Manual mode — no auto reply");
    }
  });
}

// ── Dashboard APIs ──────────────────────────────────────
app.get("/api/qr", (req, res) => {
  res.json({ qr: currentQR, connected: waConnected });
});

app.get("/api/personas", (req, res) => {
  const list = Object.entries(PERSONAS).map(([key, p]) => ({ key, label: p.label }));
  res.json(list);
});

app.get("/api/contact-settings/:phone", (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  res.json({ persona: contactSettings[phone] || "ali" });
});

app.post("/api/contact-settings", (req, res) => {
  const { phone, persona } = req.body;
  if (!phone || !persona || !PERSONAS[persona])
    return res.status(400).json({ error: "valid phone and persona required" });
  contactSettings[phone] = persona;
  saveData();
  log(`🎭 Persona for ${getName(phone)} set to: ${persona}`);
  res.json({ success: true, persona });
});

app.get("/api/status", (req, res) =>
  res.json({
    agentEnabled,
    waConnected,
    totalContacts: Object.keys(contacts).length,
    totalMessages: Object.values(chatHistory).reduce((s, h) => s + h.length, 0),
  })
);

app.post("/api/toggle", (req, res) => {
  agentEnabled = !agentEnabled;
  log(`🔄 Agent is now ${agentEnabled ? "ON (AI)" : "OFF (Manual)"}`);
  res.json({ agentEnabled });
});

app.get("/api/contacts", (req, res) => {
  const result = Object.entries(contacts)
    .map(([phone, name]) => {
      const h = chatHistory[phone] || [];
      const last = h[h.length - 1];
      return {
        phone,
        name,
        messageCount: h.length,
        lastMessage: last?.content?.slice(0, 60) || "",
        lastTime: last?.timestamp || null,
      };
    })
    .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
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
  if (!sock || !waConnected)
    return res.status(503).json({ error: "WhatsApp not connected yet" });

  await sock.sendMessage(phone, { text: message });
  addMessage(phone, "assistant", message);
  res.json({ success: true });
});

// ── Start ───────────────────────────────────────────────
loadData();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`🚀 Dashboard running at http://localhost:${PORT}`);
  startWhatsApp();
});

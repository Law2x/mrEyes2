// index.js
import express from "express";
import fetchPkg from "node-fetch";
const fetchFn = typeof fetch !== "undefined" ? fetch : fetchPkg;
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { generateReceiptPNG } from "./lib/ereceipt.js";
import { db, kvGet, kvSet } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ───────── CONFIG ─────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);
const HOST_URL = process.env.HOST_URL;
const PORT = process.env.PORT || 3000;
const ADMIN_IDS = process.env.ADMIN_IDS
  ? process.env.ADMIN_IDS.split(",").map((id) => Number(id.trim()))
  : [];
const ADMIN_DASH_PASSWORD = process.env.ADMIN_DASH_PASSWORD || "change-me";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing.");
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ───────── PRICE LIST ─────────
const PRICE_LIST = {
  sachet: [
    { label: "₱500 — 0.028", callback: "amt:₱500" },
    { label: "₱700 — 0.042", callback: "amt:₱700" },
    { label: "₱1,000 — 0.056", callback: "amt:₱1000" },
    { label: "₱2,000 — Half", callback: "amt:₱2000" },
    { label: "₱3,800 — 8", callback: "amt:₱3800" },
  ],
  syringe: [
    { label: "₱500 — 12 units", callback: "amt:₱500" },
    { label: "₱700 — 20 units", callback: "amt:₱700" },
    { label: "₱1,000 — 30 units", callback: "amt:₱1000" },
  ],
};

// ───────── STATE ─────────
const sessions = new Map();
let SHOP_OPEN = kvGet("shop_open") === "1";

// ───────── EXPRESS ─────────
const app = express();
app.use(express.json());
app.use("/static", express.static("public"));

// ───────── HELPERS ─────────
async function tgSendMessage(chatId, text, extra = {}) {
  return fetchFn(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
}
async function tgEditMessageText(chatId, msgId, text, extra = {}) {
  return fetchFn(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: msgId, text, ...extra }),
  });
}

// Always use local QR file only
async function sendPaymentQR(chatId) {
  try {
    const filePath = path.join(__dirname, "public", "qrph.jpg");
    const buf = await fs.readFile(filePath);

    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    fd.append("caption", "💰 Scan to pay (QRPh / GCash).");
    fd.append("photo", new Blob([buf], { type: "image/jpeg" }), "qrph.jpg");

    const r = await fetchFn(`${TELEGRAM_API}/sendPhoto`, {
      method: "POST",
      body: fd,
    });

    const j = await r.json().catch(() => null);
    if (j?.ok) return true;
    throw new Error("Telegram rejected upload");
  } catch (err) {
    console.error("QR upload failed:", err);
    await tgSendMessage(
      chatId,
      "⚠️ Unable to attach the QR image. Please proceed with payment using your saved QR and send a screenshot. 🙏"
    );
    return false;
  }
}

// ───────── SESSION ─────────
function getSession(chatId) {
  const now = Date.now();
  let s = sessions.get(chatId);
  if (!s) {
    s = { lastActive: now, cart: [] };
    sessions.set(chatId, s);
  } else s.lastActive = now;
  return s;
}
function ensureCart(s) {
  if (!s.cart) s.cart = [];
}

// ───────── UI HELPERS ─────────
function buildAmountKeyboard(s) {
  const inline_keyboard = [];
  if (!s.category) {
    inline_keyboard.push([
      { text: "💧 Sachet", callback_data: "cat:sachet" },
      { text: "💉 Syringe", callback_data: "cat:syringe" },
    ]);
    return { inline_keyboard };
  }

  const priceOptions = PRICE_LIST[s.category] || [];
  for (let i = 0; i < priceOptions.length; i += 2) {
    inline_keyboard.push(
      priceOptions.slice(i, i + 2).map((p) => ({
        text: p.label,
        callback_data: p.callback,
      }))
    );
  }

  inline_keyboard.push([
    { text: "📂 Categories", callback_data: "cat:menu" },
    { text: "🧾 View Cart", callback_data: "cart:view" },
  ]);
  inline_keyboard.push([{ text: "✅ Checkout", callback_data: "cart:checkout" }]);
  return { inline_keyboard };
}

// ───────── HANDLERS ─────────
async function handleCallbackQuery(cbq) {
  const data = cbq.data;
  const chatId = cbq.message.chat.id;
  const msgId = cbq.message.message_id;
  const s = getSession(chatId);

  if (!SHOP_OPEN) {
    await tgSendMessage(chatId, "🏪 The shop is closed.");
    return;
  }

  if (data.startsWith("cat:")) {
    if (data === "cat:menu") {
      delete s.category;
      delete s.selectedAmount;
      await tgEditMessageText(chatId, msgId, "🧊 Choose a product type 👇", {
        reply_markup: buildAmountKeyboard(s),
      });
      return;
    }

    s.category = data.slice(4);
    await tgEditMessageText(chatId, msgId, `🧊 ${s.category} selected`, {
      reply_markup: buildAmountKeyboard(s),
    });
    return;
  }

  if (data.startsWith("amt:")) {
    const amount = data.slice(4);
    s.selectedAmount = amount;
    ensureCart(s);
    s.cart.push({ category: s.category, amount });
    await tgSendMessage(chatId, `🛒 Added: ${s.category} — ${amount}`);
    await tgEditMessageText(
      chatId,
      msgId,
      `🧊 ${s.category} • Select more or Checkout`,
      { reply_markup: buildAmountKeyboard(s) }
    );
    return;
  }

  if (data === "cart:view") {
    ensureCart(s);
    const txt = s.cart.length
      ? s.cart.map((x, i) => `${i + 1}. ${x.category} — ${x.amount}`).join("\n")
      : "🧺 Cart empty.";
    await tgSendMessage(chatId, txt);
    return;
  }

  if (data === "cart:checkout") {
    if (!s.cart.length) {
      await tgSendMessage(chatId, "🧺 Your cart is empty.");
      return;
    }
    s.step = "ask_name";
    await tgSendMessage(chatId, "📝 Please enter your name:");
    return;
  }

  if (data === "order:confirm") {
    s.step = "await_payment_proof";
    await tgSendMessage(chatId, "📸 Please upload your payment screenshot.");
    return;
  }
}

// ───────── MESSAGE HANDLER ─────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || "";
  const s = getSession(chatId);

  if (text === "/start" || text === "/restart") {
    if (!SHOP_OPEN) {
      await tgSendMessage(chatId, "🏪 The shop is closed.");
      return;
    }
    sessions.set(chatId, { step: "choose_category", cart: [] });
    await tgSendMessage(chatId, "🧊 Welcome!\nChoose a product type 👇", {
      reply_markup: buildAmountKeyboard({}),
    });
    return;
  }

  if (s.step === "ask_name") {
    s.name = text;
    s.step = "request_phone";
    await tgSendMessage(chatId, "📱 Please share your phone number:", {
      reply_markup: {
        keyboard: [[{ text: "📱 Share Phone", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
    return;
  }

  await tgSendMessage(chatId, "Please use /start to begin ordering.");
}

async function handleContact(msg) {
  const chatId = msg.chat.id;
  if (!SHOP_OPEN) {
    await tgSendMessage(chatId, "🏪 The shop is closed.");
    return;
  }
  const s = getSession(chatId);
  if (s.step === "request_phone") {
    s.phone = msg.contact.phone_number;
    s.step = "request_location";
    await tgSendMessage(chatId, "📍 Please share your delivery location:", {
      reply_markup: {
        keyboard: [[{ text: "📍 Share Location", request_location: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }
}

async function handleLocation(msg) {
  const chatId = msg.chat.id;
  if (!SHOP_OPEN) {
    await tgSendMessage(chatId, "🏪 The shop is closed.");
    return;
  }
  const s = getSession(chatId);
  if (s.step !== "request_location") return;
  s.coords = msg.location;
  s.step = "confirm";

  const summary = `
📋 *Order Summary*

👤 Name: ${s.name}
📱 Phone: ${s.phone}
🧺 Items:
${s.cart.map((x, i) => `${i + 1}. ${x.category} — ${x.amount}`).join("\n")}

💰 *Payment Instructions:*
Scan the QR (QRPh / GCash) below, then tap *Payment Processed* and upload your proof.
  `.trim();

  await tgSendMessage(chatId, summary, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💰 Payment Processed", callback_data: "order:confirm" }],
      ],
    },
  });

  await sendPaymentQR(chatId);
}

async function handlePhotoOrDocument(msg) {
  const chatId = msg.chat.id;
  if (!SHOP_OPEN) {
    await tgSendMessage(chatId, "🏪 The shop is closed.");
    return;
  }
  const s = getSession(chatId);
  if (s.step !== "await_payment_proof") return;
  s.paymentProof = msg.photo?.pop()?.file_id || msg.document?.file_id;
  s.status = "complete";
  await tgSendMessage(
    chatId,
    "✅ Thank you! Payment screenshot received. Your order is being processed. 🛵"
  );
}

// ───────── WEBHOOK ─────────
const pathWebhook = `/telegraf/${BOT_TOKEN}`;
app.post(pathWebhook, async (req, res) => {
  const u = req.body;
  try {
    if (u.message) {
      const m = u.message;
      if (m.contact) await handleContact(m);
      else if (m.location) await handleLocation(m);
      else if (m.photo || m.document) await handlePhotoOrDocument(m);
      else await handleMessage(m);
    } else if (u.callback_query) {
      await handleCallbackQuery(u.callback_query);
    }
  } catch (err) {
    console.error("❌ Update error:", err);
  }
  res.sendStatus(200);
});

// ───────── HEALTH & STARTUP ─────────
app.get("/health", (_, r) =>
  r.json({ ok: true, shop_open: SHOP_OPEN, active_sessions: sessions.size })
);

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  if (HOST_URL) {
    const webhook = `${HOST_URL}${pathWebhook}`;
    try {
      await fetchFn(`${TELEGRAM_API}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhook }),
      });
      console.log(`✅ Webhook set to: ${webhook}`);
    } catch (err) {
      console.error("❌ Failed to set webhook:", err);
    }
  } else {
    console.warn("⚠️ HOST_URL not set — please set webhook manually.");
  }
});

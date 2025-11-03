import express from "express";
import fetchPkg from "node-fetch";
const fetchFn = typeof fetch !== "undefined" ? fetch : fetchPkg;

// ───────── CONFIG ─────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);
const HOST_URL = process.env.HOST_URL;
const PORT = process.env.PORT || 3000;
const ADMIN_IDS = process.env.ADMIN_IDS
  ? process.env.ADMIN_IDS.split(",").map((id) => Number(id.trim()))
  : [];

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing.");
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ───────── STATE ─────────
const sessions = new Map();
const adminMessageMap = new Map();
const loggedInAdmins = new Set();
const orders = [];
let orderCounter = 1;
let SHOP_OPEN = true;

// ───────── EXPRESS APP ─────────
const app = express();
app.use(express.json());
app.use("/static", express.static("public")); // qrph.jpg and receipt.jpg

// ───────── HELPERS ─────────
function getSession(chatId) {
  const now = Date.now();
  let s = sessions.get(chatId);
  if (!s) {
    s = { lastActive: now, status: "idle" };
    sessions.set(chatId, s);
  } else {
    s.lastActive = now;
  }
  return s;
}
function ensureCart(s) {
  if (!s.cart) s.cart = [];
}

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
async function tgSendLocation(chatId, lat, lon) {
  return fetchFn(`${TELEGRAM_API}/sendLocation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, latitude: lat, longitude: lon }),
  });
}
function addSupportRow(kb) {
  const support = [{ text: "🧑‍💼 Connect to Admin", callback_data: "support:connect" }];
  return { inline_keyboard: [...kb.inline_keyboard, support] };
}

// ───────── UI KEYBOARDS ─────────
function buildAmountKeyboard(s) {
  const inline_keyboard = [];

  // Category selection
  if (!s.category) {
    inline_keyboard.push([
      { text: "💧 Sachet", callback_data: "cat:sachet" },
      { text: "💉 Syringe", callback_data: "cat:syringe" },
    ]);
    return addSupportRow({ inline_keyboard });
  }

  // Header label
  if (s.category === "sachet") {
    inline_keyboard.push([{ text: "💧 Sachet — Choose Amount", callback_data: "noop" }]);
  } else {
    inline_keyboard.push([{ text: "💉 Syringe — Choose Amount", callback_data: "noop" }]);
  }

  // Price grid
  if (s.category === "sachet") {
    inline_keyboard.push(
      [
        { text: "₱500", callback_data: "amt:₱500" },
        { text: "₱700", callback_data: "amt:₱700" },
      ],
      [
        { text: "₱1,000", callback_data: "amt:₱1,000" },
        { text: "Half G", callback_data: "amt:Half G" },
      ],
      [{ text: "1 G", callback_data: "amt:1 G" }]
    );
  } else {
    inline_keyboard.push(
      [
        { text: "₱500", callback_data: "amt:₱500" },
        { text: "₱700", callback_data: "amt:₱700" },
      ],
      [{ text: "₱1,000", callback_data: "amt:₱1,000" }]
    );
  }

  // Cart actions
  inline_keyboard.push([
    { text: "🛒 Add to Cart", callback_data: "cart:add" },
    { text: "🧾 View Cart", callback_data: "cart:view" },
  ]);
  inline_keyboard.push([{ text: "✅ Checkout", callback_data: "cart:checkout" }]);

  return addSupportRow({ inline_keyboard });
}

async function reverseGeocode(lat, lon) {
  try {
    const r = await fetchFn(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
      { headers: { "User-Agent": "IceOrderBot/1.0" } }
    );
    const j = await r.json();
    return j.display_name || `${lat}, ${lon}`;
  } catch {
    return `${lat}, ${lon}`;
  }
}

// ───────── ADMIN NOTIFICATION ─────────
async function sendOrderToAdmin(s, from) {
  const ts = new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" });
  const items = s.cart?.length
    ? s.cart.map((i) => `${i.category} — ${i.amount}`).join("\n")
    : `${s.category || "N/A"} — ${s.selectedAmount || "N/A"}`;
  const coords = s.coords ? `${s.coords.latitude}, ${s.coords.longitude}` : "N/A";
  const id = orderCounter++;

  orders.unshift({
    id,
    customerChatId: from.id,
    name: s.name,
    phone: s.phone,
    address: s.address,
    coords: s.coords,
    items: s.cart || [],
    createdAt: ts,
  });
  if (orders.length > 100) orders.pop();

  const text = `
🧊 NEW ORDER (#${id})

🧺 Items:
${items}

👤 ${s.name}
📱 ${s.phone}
📍 ${s.address}
🗺️ ${coords}

💰 Payment proof: ${s.paymentProof ? "✅ Received" : "❌ None"}
⏰ ${ts}

🛵 *Note:* Customer was informed that a Grab delivery link will be generated and sent shortly.
`.trim();

  const r = await tgSendMessage(ADMIN_CHAT_ID, text);
  const j = await r.json().catch(() => null);
  if (j?.ok) adminMessageMap.set(j.result.message_id, { customerChatId: from.id });

  if (s.coords) await tgSendLocation(ADMIN_CHAT_ID, s.coords.latitude, s.coords.longitude);

  if (s.paymentProof) {
    await fetchFn(`${TELEGRAM_API}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        photo: s.paymentProof,
        caption: `💰 GCash/QRPh screenshot for order #${id}`,
      }),
    });
  }
}

// ───────── MESSAGE HANDLER ─────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const s = getSession(chatId);

  if (!SHOP_OPEN && !ADMIN_IDS.includes(chatId))
    return tgSendMessage(chatId, "🏪 The shop is currently closed. Please check back later!");

  // ADMIN replying to a forwarded message
  if (chatId === ADMIN_CHAT_ID && msg.reply_to_message) {
    const info = adminMessageMap.get(msg.reply_to_message.message_id);
    if (!info) return tgSendMessage(chatId, "⚠️ Cannot map reply.");

    // Send message to customer
    await tgSendMessage(info.customerChatId, `🧑‍💼 Admin:\n${text}`);

    // Smart delivery link detection
    const deliveryRegex = /(grab|delivery|courier|tracking|link|https?:\/\/\S+)/i;
    if (deliveryRegex.test(text)) {
      const kb = {
        inline_keyboard: [
          [{ text: "📦 Mark as Received", callback_data: "order:received" }],
        ],
      };
      await tgSendMessage(
        info.customerChatId,
        "🛵 Your order is on the way!\nOnce you receive it, please tap below 👇",
        { reply_markup: kb }
      );
    }

    return tgSendMessage(chatId, "✅ Sent to customer.");
  }

  if (text === "/start" || text === "/restart") {
    sessions.set(chatId, { step: "choose_category", cart: [], status: "ordering", lastActive: Date.now() });
    return tgSendMessage(chatId, "🧊 Welcome!\nChoose a product type 👇", {
      reply_markup: buildAmountKeyboard({}),
    });
  }

  if (s.step === "ask_name") {
    s.name = text.trim();
    s.step = "request_phone";
    return tgSendMessage(chatId, "📱 Please share your phone number:", {
      reply_markup: {
        keyboard: [[{ text: "📱 Share Phone", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
  }

  return tgSendMessage(chatId, "Please /start to begin.");
}

async function handleContact(msg) {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (s.step !== "request_phone") return;
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

async function handleLocation(msg) {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (s.step !== "request_location") return;
  const { latitude, longitude } = msg.location;
  s.coords = { latitude, longitude };
  s.address = await reverseGeocode(latitude, longitude);
  s.step = "confirm";

  const items = s.cart?.length
    ? s.cart.map((it, i) => `${i + 1}. ${it.category} — ${it.amount}`).join("\n")
    : `${s.category || "N/A"} — ${s.selectedAmount || "N/A"}`;

  const summary = `
📋 *Order Summary*

🧺 Items:
${items}

👤 ${s.name}
📱 ${s.phone}
📍 ${s.address}

💰 *Payment Instructions:*
Scan the QR below to pay via *QRPh / GCash (Mrs Eyes)*.
After payment, tap *Payment Processed* and upload your proof.
`.trim();

  if (HOST_URL) {
    const qr = `${HOST_URL}/static/qrph.jpg`;
    await fetchFn(`${TELEGRAM_API}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: qr, caption: "💰 Scan to pay (QRPh / GCash)." }),
    });
  }

  await tgSendMessage(chatId, summary, {
    parse_mode: "Markdown",
    reply_markup: addSupportRow({
      inline_keyboard: [
        [{ text: "💰 Payment Processed", callback_data: "order:confirm" }],
        [{ text: "❌ Cancel", callback_data: "order:cancel" }],
      ],
    }),
  });
}

async function handlePhotoOrDocument(msg) {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (s.step !== "await_payment_proof") return;
  const file = msg.photo ? msg.photo.pop().file_id : msg.document?.file_id;
  if (!file) return tgSendMessage(chatId, "⚠️ Please upload an image or PDF.");
  s.paymentProof = file;
  await sendOrderToAdmin(s, msg.from);
  s.status = "complete";
  await tgSendMessage(
    chatId,
    "✅ *Thank you!* Payment screenshot received.\n🛵 Your Grab delivery link will be generated shortly.\n⏳ Please keep this chat open.",
    { parse_mode: "Markdown" }
  );
}

// ───────── CALLBACKS ─────────
async function handleCallbackQuery(cbq) {
  const data = cbq.data;
  const chatId = cbq.message.chat.id;
  const msgId = cbq.message.message_id;
  const s = getSession(chatId);

  if (!SHOP_OPEN && !ADMIN_IDS.includes(chatId))
    return tgSendMessage(chatId, "🏪 Shop closed. Please check back later!");

  if (data === "order:received") {
    s.status = "delivered";
    await tgSendMessage(chatId, "✅ Thank you for confirming!\nWe’re glad your order arrived safely. 💙");

    if (HOST_URL) {
      const receipt = `${HOST_URL}/static/receipt.jpg`;
      await fetchFn(`${TELEGRAM_API}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          photo: receipt,
          caption: "🧾 Official Receipt — Thank you for your purchase!",
        }),
      });
    }

    await tgSendMessage(
      ADMIN_CHAT_ID,
      `📦 Customer *${s.name || "N/A"}* confirmed they received their order.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (data.startsWith("cat:")) {
    s.category = data.slice(4);
    s.step = "choose_amount";
    s.status = "ordering";
    ensureCart(s);
    return tgEditMessageText(chatId, msgId, `🧊 ${s.category} selected.`, {
      reply_markup: buildAmountKeyboard(s),
    });
  }

  if (data.startsWith("amt:")) {
    s.selectedAmount = data.slice(4);
    return tgEditMessageText(chatId, msgId, `💸 Selected ${s.selectedAmount}`, {
      reply_markup: buildAmountKeyboard(s),
    });
  }

  if (data === "cart:add") {
    ensureCart(s);
    if (!s.category || !s.selectedAmount)
      return tgSendMessage(chatId, "⚠️ Select a category and amount first.");
    s.cart.push({ category: s.category, amount: s.selectedAmount });
    return tgSendMessage(chatId, `🛒 Added: ${s.category} — ${s.selectedAmount}`);
  }

  if (data === "cart:view") {
    ensureCart(s);
    const txt = s.cart.length
      ? s.cart.map((x, i) => `${i + 1}. ${x.category} — ${x.amount}`).join("\n")
      : "🧺 Cart is empty.";
    return tgSendMessage(chatId, txt);
  }

  if (data === "cart:checkout") {
    ensureCart(s);
    if (!s.cart.length && s.category && s.selectedAmount)
      s.cart.push({ category: s.category, amount: s.selectedAmount });
    if (!s.cart.length) return tgSendMessage(chatId, "🧺 Cart empty.");
    s.step = "ask_name";
    return tgSendMessage(chatId, "📝 Please enter your name:");
  }

  if (data === "order:confirm") {
    s.step = "await_payment_proof";
    s.status = "await_payment";
    return tgSendMessage(chatId, "📸 Please upload your payment screenshot.");
  }

  if (data === "order:cancel") {
    sessions.set(chatId, { status: "idle" });
    return tgEditMessageText(chatId, msgId, "❌ Order canceled.");
  }
}

// ───────── SERVER + CLEANUP ─────────
const path = `/telegraf/${BOT_TOKEN}`;
app.post(path, async (req, res) => {
  const u = req.body;
  try {
    if (u.message) {
      const m = u.message;
      if (m.contact) await handleContact(m);
      else if (m.location) await handleLocation(m);
      else if (m.photo || m.document) await handlePhotoOrDocument(m);
      else await handleMessage(m);
    } else if (u.callback_query) await handleCallbackQuery(u.callback_query);
  } catch (err) {
    console.error("❌ Update error:", err);
  }
  res.sendStatus(200);
});

// Auto cleanup
setInterval(() => {
  const now = Date.now();
  const TTL = 3 * 60 * 60 * 1000; // 3h
  for (const [chatId, s] of sessions) {
    if (s.status === "complete" && now - (s.lastActive || 0) > 5 * 60 * 1000) {
      sessions.delete(chatId);
      console.log(`✅ Cleared completed session for ${chatId}`);
    } else if (s.status === "delivered" && now - (s.lastActive || 0) > 10 * 60 * 1000) {
      sessions.delete(chatId);
      console.log(`📦 Cleared delivered session for ${chatId}`);
    } else if (now - (s.lastActive || 0) > TTL) {
      sessions.delete(chatId);
      console.log(`🕒 Cleared inactive session for ${chatId}`);
    }
  }
}, 10 * 60 * 1000);

// Health
app.get("/", (_, r) => r.send("🧊 IceOrderBot running (webhook mode)."));
app.get("/health", (_, r) =>
  r.json({ ok: true, shop_open: SHOP_OPEN, active_sessions: sessions.size, uptime: process.uptime() })
);

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  if (HOST_URL) {
    const webhook = `${HOST_URL}/telegraf/${BOT_TOKEN}`;
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

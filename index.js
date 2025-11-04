// index.js
import express from "express";
import fetchPkg from "node-fetch";
const fetchFn = typeof fetch !== "undefined" ? fetch : fetchPkg;
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ────────── CONFIG ──────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);
const HOST_URL = process.env.HOST_URL;
const PORT = process.env.PORT || 3000;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing.");
if (!ADMIN_CHAT_ID) console.warn("⚠️ ADMIN_CHAT_ID missing or 0.");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ────────── PRICE LIST (UPDATED) ──────────
const PRICE_LIST = {
  sachet: [
    { label: "₱500 — 0.028",  callback: "amt:₱500"  },
    { label: "₱700 — 0.042",  callback: "amt:₱700"  },
    { label: "₱1,000 — 0.056",callback: "amt:₱1000" },
    { label: "₱2,000 — Half", callback: "amt:₱2000" },
    { label: "₱3,800 — G",    callback: "amt:₱3800" },
  ],
  syringe: [
    { label: "₱500 — 12 units",  callback: "amt:₱500"  },
    { label: "₱700 — 20 units",  callback: "amt:₱700"  },
    { label: "₱1,000 — 30 units",callback: "amt:₱1000" },
  ],
};

// ────────── STATE ──────────
let SHOP_OPEN = true;
const sessions = new Map();               // chatId -> {cart, step, ...}
const adminMessageMap = new Map();        // adminMsgId -> { customerChatId }
const orders = [];                         // in-memory orders
let nextOrderId = 1;

const adminState = {
  mode: null,               // 'broadcast' | 'await_delivery_link'
  deliveryOrderId: null,    // used when awaiting link
};

// ────────── EXPRESS ──────────
const app = express();
app.use(express.json());
app.use("/static", express.static("public"));

// ────────── TG HELPERS ──────────
async function tgSendMessage(chatId, text, extra = {}) {
  return fetchFn(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
}
async function tgEditMessageText(chatId, message_id, text, extra = {}) {
  return fetchFn(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id, text, ...extra }),
  });
}
async function tgSendLocation(chatId, lat, lon) {
  return fetchFn(`${TELEGRAM_API}/sendLocation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, latitude: lat, longitude: lon }),
  });
}
async function tgSendPhotoByFileId(chatId, file_id, caption = "") {
  return fetchFn(`${TELEGRAM_API}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: file_id, caption }),
  });
}

// Always upload local QR image and stick the "Payment Processed" button under it
async function sendPaymentQR(chatId) {
  try {
    const filePath = path.join(__dirname, "public", "qrph.jpg");
    const buf = await fs.readFile(filePath);

    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    fd.append("caption", "💰 Scan to pay (QRPh / GCash).");
    fd.append(
      "reply_markup",
      JSON.stringify({
        inline_keyboard: [[{ text: "💰 Payment Processed", callback_data: "order:confirm" }]],
      })
    );
    fd.append("photo", new Blob([buf], { type: "image/jpeg" }), "qrph.jpg");

    const r = await fetchFn(`${TELEGRAM_API}/sendPhoto`, { method: "POST", body: fd });
    const j = await r.json().catch(() => null);
    if (!j?.ok) throw new Error("Telegram rejected upload");
    return true;
  } catch (err) {
    console.error("QR upload failed:", err);
    await tgSendMessage(
      chatId,
      "⚠️ Unable to attach the QR image. Please proceed with payment using your saved QR and send a screenshot. 🙏"
    );
    return false;
  }
}

// ────────── UTIL ──────────
function getSession(chatId) {
  const now = Date.now();
  let s = sessions.get(chatId);
  if (!s) {
    s = { lastActive: now, cart: [], status: "idle" };
    sessions.set(chatId, s);
  } else s.lastActive = now;
  return s;
}
function ensureCart(s) { if (!s.cart) s.cart = []; }
function itemsToText(items) {
  return items.map((i, idx) => `${idx + 1}. ${i.category} — ${i.amount}`).join("\n");
}
async function reverseGeocode(lat, lon) {
  try {
    const r = await fetchFn(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
      { headers: { "User-Agent": "MrsEyesBot/1.0" } }
    );
    const j = await r.json();
    return j.display_name || `${lat}, ${lon}`;
  } catch { return `${lat}, ${lon}`; }
}

// ────────── KEYBOARDS ──────────
function buildCategoryKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "💧 Sachet", callback_data: "cat:sachet" },
        { text: "💉 Syringe", callback_data: "cat:syringe" },
      ],
    ],
  };
}
function buildAmountKeyboard(s) {
  const inline_keyboard = [];
  const list = PRICE_LIST[s.category] || [];
  for (let i = 0; i < list.length; i += 2) {
    inline_keyboard.push(
      list.slice(i, i + 2).map((p) => ({ text: p.label, callback_data: p.callback }))
    );
  }
  inline_keyboard.push([
    { text: "📂 Categories", callback_data: "cat:menu" },
    { text: "🧾 View Cart", callback_data: "cart:view" },
  ]);
  inline_keyboard.push([{ text: "✅ Checkout", callback_data: "cart:checkout" }]);
  return { inline_keyboard };
}

// ────────── ADMIN CENTER (Telegram) ──────────
function adminPanelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: SHOP_OPEN ? "🔴 Close Shop" : "🟢 Open Shop", callback_data: "admin:toggle" }],
      [{ text: "📋 View Orders", callback_data: "admin:orders" }],
      [{ text: "📢 Broadcast", callback_data: "admin:broadcast" }],
    ],
  };
}
async function openAdminCenter() {
  return tgSendMessage(ADMIN_CHAT_ID, "👑 *Admin Center*", {
    parse_mode: "Markdown",
    reply_markup: adminPanelKeyboard(),
  });
}
function findOrder(id) { return orders.find((o) => o.id === id); }
function orderSummaryText(o) {
  const lines = [
    `🧾 Order #${o.id}`,
    "",
    `👤 ${o.name}`,
    `📱 ${o.phone}`,
    `📍 ${o.address || "N/A"}`,
    "",
    "🧺 Items:",
    itemsToText(o.items),
    "",
    `💰 Payment proof: ${o.paymentProof ? "✅" : "❌"}`,
    `📦 Status: ${o.status}`,
    "",
  ];
  return lines.join("\n");
}
async function listOrders(chatId) {
  if (!orders.length) {
    await tgSendMessage(chatId, "— No orders yet —");
    return;
  }
  const latest = [...orders].slice(-10).reverse();
  for (const o of latest) {
    const kb = {
      inline_keyboard: [
        [{ text: "➡️ View", callback_data: `admin:order:${o.id}` }],
        [{ text: "🚚 Send Delivery Link", callback_data: `admin:sendlink:${o.id}` }],
        [{ text: "✅ Mark Completed", callback_data: `admin:done:${o.id}` }],
        [{ text: "❌ Cancel", callback_data: `admin:cancel:${o.id}` }],
      ],
    };
    await tgSendMessage(chatId, orderSummaryText(o), { reply_markup: kb });
  }
}

// ────────── ADMIN NOTIFY + REPLY BRIDGE ──────────
async function notifyAdminNewOrder(order, from) {
  const text = orderSummaryText(order);
  const r = await tgSendMessage(ADMIN_CHAT_ID, text);
  const j = await r.json().catch(() => null);
  if (j?.ok) {
    adminMessageMap.set(j.result.message_id, { customerChatId: from.id });
  }
  if (order.coords) {
    await tgSendLocation(ADMIN_CHAT_ID, order.coords.latitude, order.coords.longitude);
  }
  if (order.paymentProof) {
    await tgSendPhotoByFileId(
      ADMIN_CHAT_ID,
      order.paymentProof,
      `💰 Payment screenshot for Order #${order.id}`
    );
  }
}

// ────────── CALLBACKS ──────────
async function handleCallbackQuery(cbq) {
  const chatId = cbq.message.chat.id;
  const msgId = cbq.message.message_id;
  const data = cbq.data;
  const s = getSession(chatId);

  // ADMIN CALLBACKS
  if (data.startsWith("admin:")) {
    if (chatId !== ADMIN_CHAT_ID) {
      await tgSendMessage(chatId, "⛔ Unauthorized.");
      return;
    }
    const [, action, arg] = data.split(":"); // admin:action[:id]
    switch (action) {
      case "toggle":
        SHOP_OPEN = !SHOP_OPEN;
        await tgEditMessageText(
          chatId,
          msgId,
          "👑 *Admin Center*",
          { parse_mode: "Markdown", reply_markup: adminPanelKeyboard() }
        );
        break;
      case "orders":
        await tgSendMessage(chatId, "🧾 Recent orders:");
        await listOrders(chatId);
        break;
      case "order": {
        const id = Number(arg);
        const o = findOrder(id);
        if (!o) return tgSendMessage(chatId, "Order not found.");
        const kb = {
          inline_keyboard: [
            [{ text: "🚚 Send Delivery Link", callback_data: `admin:sendlink:${o.id}` }],
            [{ text: "✅ Mark Completed", callback_data: `admin:done:${o.id}` }],
            [{ text: "❌ Cancel", callback_data: `admin:cancel:${o.id}` }],
          ],
        };
        await tgSendMessage(chatId, orderSummaryText(o), { reply_markup: kb });
        break;
      }
      case "sendlink": {
        const id = Number(arg);
        adminState.mode = "await_delivery_link";
        adminState.deliveryOrderId = id;
        await tgSendMessage(chatId, `✍️ Reply with the delivery/tracking link for Order #${id}.`);
        break;
      }
      case "done": {
        const id = Number(arg);
        const o = findOrder(id);
        if (!o) return tgSendMessage(chatId, "Order not found.");
        o.status = "completed";
        await tgSendMessage(chatId, `✅ Order #${id} marked completed.`);
        await tgSendMessage(o.customerChatId, "✅ Your order has been marked *Completed*. Thank you!", { parse_mode: "Markdown" });
        break;
      }
      case "cancel": {
        const id = Number(arg);
        const o = findOrder(id);
        if (!o) return tgSendMessage(chatId, "Order not found.");
        o.status = "canceled";
        await tgSendMessage(chatId, `❌ Order #${id} canceled.`);
        await tgSendMessage(o.customerChatId, "❌ Your order has been *canceled*. If this is a mistake, please /start again.", { parse_mode: "Markdown" });
        break;
      }
    }
    return;
  }

  // CUSTOMER CALLBACKS (block if closed)
  if (!SHOP_OPEN) {
    await tgSendMessage(chatId, "🏪 The shop is closed.");
    return;
  }

  if (data === "cat:menu") {
    delete s.category;
    delete s.selectedAmount;
    await tgEditMessageText(chatId, msgId, "🧊 Choose a product type 👇", {
      reply_markup: buildCategoryKeyboard(),
    });
    return;
  }

  if (data.startsWith("cat:")) {
    s.category = data.slice(4);
    await tgEditMessageText(chatId, msgId, `🧊 ${s.category} selected`, {
      reply_markup: buildAmountKeyboard(s),
    });
    return;
  }

  if (data.startsWith("amt:")) {
    const amount = data.slice(4);
    ensureCart(s);
    s.selectedAmount = amount;
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
    const txt = s.cart.length ? itemsToText(s.cart) : "🧺 Cart empty.";
    await tgSendMessage(chatId, txt);
    return;
  }

  if (data === "cart:checkout") {
    if (!s.cart.length) return tgSendMessage(chatId, "🧺 Your cart is empty.");
    s.step = "ask_name";
    await tgSendMessage(chatId, "📝 Please enter your name:");
    return;
  }

  if (data === "order:confirm") {
    s.step = "await_payment_proof";
    await tgSendMessage(chatId, "📸 Please upload your payment screenshot.");
    return;
  }

  if (data === "order:received") {
    // sent after admin shared delivery link
    s.status = "delivered";
    const o = orders.find((x) => x.customerChatId === chatId && x.status !== "canceled");
    if (o) o.status = "delivered";
    await tgSendMessage(chatId, "✅ Thank you for confirming! We’re glad your order arrived safely. 💙");
    await tgSendMessage(ADMIN_CHAT_ID, `📦 Customer *${s.name || chatId}* marked the order as *Received*.`, { parse_mode: "Markdown" });
    return;
  }
}

// ────────── MESSAGE HANDLER ──────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const s = getSession(chatId);

  // ADMIN: reply-bridge (replying to order summary in admin chat)
  if (chatId === ADMIN_CHAT_ID && msg.reply_to_message) {
    const info = adminMessageMap.get(msg.reply_to_message.message_id);
    if (!info) return tgSendMessage(chatId, "⚠️ Cannot map reply to a customer.");
    await tgSendMessage(info.customerChatId, `🧑‍💼 Admin:\n${text}`);
    if (/(grab|delivery|courier|tracking|https?:\/\/\S+)/i.test(text)) {
      await tgSendMessage(
        info.customerChatId,
        "🛵 Your order is on the way! Once you receive it, tap below:",
        { reply_markup: { inline_keyboard: [[{ text: "📦 Mark as Received", callback_data: "order:received" }]] } }
      );
    }
    return;
  }

  // ADMIN: receive typed delivery link after pressing "Send Delivery Link"
  if (chatId === ADMIN_CHAT_ID && adminState.mode === "await_delivery_link") {
    const id = adminState.deliveryOrderId;
    const o = findOrder(id);
    if (!o) {
      adminState.mode = null;
      adminState.deliveryOrderId = null;
      return tgSendMessage(chatId, "⚠️ Order not found.");
    }
    adminState.mode = null;
    adminState.deliveryOrderId = null;

    await tgSendMessage(
      o.customerChatId,
      `🛵 Delivery link:\n${text}\n\nTap below once you receive your order.`,
      { reply_markup: { inline_keyboard: [[{ text: "📦 Mark as Received", callback_data: "order:received" }]] } }
    );
    await tgSendMessage(chatId, `✅ Delivery link sent to customer for Order #${id}.`);
    o.status = "out_for_delivery";
    return;
  }

  // ADMIN: broadcast
  if (chatId === ADMIN_CHAT_ID && adminState.mode === "broadcast") {
    adminState.mode = null;
    let count = 0;
    for (const [cid] of sessions) {
      if (cid === ADMIN_CHAT_ID) continue;
      try { await tgSendMessage(cid, `📢 *Admin Broadcast:*\n${text}`, { parse_mode: "Markdown" }); count++; }
      catch {}
    }
    await tgSendMessage(chatId, `✅ Broadcast sent to ${count} chats.`);
    return;
  }

  // /admin command panel
  if (text === "/admin") {
    if (chatId !== ADMIN_CHAT_ID) return tgSendMessage(chatId, "⛔ This command is for admin only.");
    await openAdminCenter();
    return;
  }

  // Admin quick toggles
  if (text === "/open")  { SHOP_OPEN = true;  return tgSendMessage(chatId, "🟢 Shop is now OPEN."); }
  if (text === "/close") { SHOP_OPEN = false; return tgSendMessage(chatId, "🔴 Shop is now CLOSED."); }

  // Customer flow
  if (text === "/start" || text === "/restart") {
    if (!SHOP_OPEN) return tgSendMessage(chatId, "🏪 The shop is closed.");
    sessions.set(chatId, { lastActive: Date.now(), cart: [], status: "ordering" });
    await tgSendMessage(chatId, "🧊 Welcome!\nChoose a product type 👇", {
      reply_markup: buildCategoryKeyboard(),
    });
    return;
  }

  if (s.step === "ask_name") {
    s.name = text;
    s.step = "request_phone";
    await tgSendMessage(chatId, "📱 Please share your phone number:", {
      reply_markup: {
        keyboard: [[{ text: "📱 Share Phone", request_contact: true }]],
        resize_keyboard: true, one_time_keyboard: true,
      },
    });
    return;
  }

  await tgSendMessage(chatId, "Please use /start to begin ordering.");
}

// ────────── CONTACT (phone) ──────────
async function handleContact(msg) {
  const chatId = msg.chat.id;
  if (!SHOP_OPEN) return tgSendMessage(chatId, "🏪 The shop is closed.");
  const s = getSession(chatId);
  if (s.step !== "request_phone") return;
  s.phone = msg.contact.phone_number;
  s.step = "request_location";
  await tgSendMessage(chatId, "📍 Please share your delivery location:", {
    reply_markup: {
      keyboard: [[{ text: "📍 Share Location", request_location: true }]],
      resize_keyboard: true, one_time_keyboard: true,
    },
  });
}

// ────────── LOCATION (address) ──────────
async function handleLocation(msg) {
  const chatId = msg.chat.id;
  if (!SHOP_OPEN) return tgSendMessage(chatId, "🏪 The shop is closed.");
  const s = getSession(chatId);
  if (s.step !== "request_location") return;

  const { latitude, longitude } = msg.location;
  s.coords = { latitude, longitude };
  s.address = await reverseGeocode(latitude, longitude);
  s.step = "confirm";

  const itemsTxt = s.cart.length ? itemsToText(s.cart) : "—";
  const summary = `
📋 *Order Summary*

👤 Name: ${s.name}
📱 Phone: ${s.phone}
📍 Address: ${s.address}

🧺 Items:
${itemsTxt}

💰 *Payment Instructions:*
Scan the QR (QRPh / GCash) below, then tap *Payment Processed* and upload your proof.
`.trim();

  await tgSendMessage(chatId, summary, { parse_mode: "Markdown" });
  await sendPaymentQR(chatId);
}

// ────────── PAYMENT PROOF (photo/document) ──────────
async function handlePhotoOrDocument(msg) {
  const chatId = msg.chat.id;
  if (!SHOP_OPEN) return tgSendMessage(chatId, "🏪 The shop is closed.");
  const s = getSession(chatId);
  if (s.step !== "await_payment_proof") return;

  s.paymentProof = msg.photo ? msg.photo.pop().file_id : msg.document?.file_id;

  // Create an order record
  const order = {
    id: nextOrderId++,
    customerChatId: chatId,
    name: s.name,
    phone: s.phone,
    address: s.address,
    coords: s.coords,
    items: [...(s.cart || [])],
    paymentProof: s.paymentProof || null,
    status: "paid",
    createdAt: new Date().toISOString(),
  };
  orders.push(order);

  // Notify admin
  await notifyAdminNewOrder(order, msg.from);

  // Ack customer
  s.status = "complete";
  await tgSendMessage(
    chatId,
    "✅ Thank you! Payment screenshot received.\n🛵 Your delivery link will be sent shortly.\nPlease keep this chat open."
  );
}

// ────────── WEBHOOK ──────────
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
  } catch (e) {
    console.error("❌ Update error:", e);
  }
  res.sendStatus(200);
});

// ────────── HEALTH + STARTUP ──────────
app.get("/health", (_, r) =>
  r.json({ ok: true, shop_open: SHOP_OPEN, active_sessions: sessions.size, orders: orders.length })
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

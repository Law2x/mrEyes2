// index.js
import express from "express";
import fetchPkg from "node-fetch";
const fetchFn = typeof fetch !== "undefined" ? fetch : fetchPkg;
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ───────── CONFIG ─────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);
const HOST_URL = process.env.HOST_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing.");
if (!ADMIN_CHAT_ID) console.warn("⚠️ ADMIN_CHAT_ID missing or 0.");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ───────── PRICE LIST ─────────
const PRICE_LIST = {
  sachet: [
    { label: "₱500 — 0.028",   callback: "amt:₱500" },
    { label: "₱700 — 0.042",   callback: "amt:₱700" },
    { label: "₱1,000 — 0.056", callback: "amt:₱1000" },
    { label: "₱2,000 — Half",  callback: "amt:₱2000" },
    { label: "₱3,800 — G",     callback: "amt:₱3800" },
  ],
  syringe: [
    { label: "₱500 — 12 units",  callback: "amt:₱500" },
    { label: "₱700 — 20 units",  callback: "amt:₱700" },
    { label: "₱1,000 — 30 units",callback: "amt:₱1000" },
  ],
  // Poppers top level
  poppers: [
    { label: "⚡ Fast-acting",  callback: "cat:poppers_fast" },
    { label: "🌿 Smooth blend", callback: "cat:poppers_smooth" },
    { label: "💎 Premium",      callback: "cat:poppers_premium" },
  ],
  // Poppers subgroups (₱700 each). Items can appear in multiple groups.
  poppers_fast: [
    { label: "Rush Ultra Strong (Yellow) — ₱700", callback: "amt:Rush Ultra Strong (Yellow)" },
    { label: "Iron Horse — ₱700",                 callback: "amt:Iron Horse" },
    { label: "Jungle Juice Platinum — ₱700",      callback: "amt:Jungle Juice Platinum" }, // also premium
  ],
  poppers_smooth: [
    { label: "Blue Boy — ₱700",        callback: "amt:Blue Boy" },
    { label: "Cannabis — ₱700",        callback: "amt:Cannabis" },
    { label: "Pink Amsterdam — ₱700",  callback: "amt:Pink Amsterdam" },
    { label: "Manscent — ₱700",        callback: "amt:Manscent" }, // also premium
  ],
  poppers_premium: [
    { label: "Jungle Juice Platinum — ₱700", callback: "amt:Jungle Juice Platinum" }, // also fast
    { label: "Manscent — ₱700",              callback: "amt:Manscent" },              // also smooth
  ],
};

// ───────── STATE ─────────
let SHOP_OPEN = true;
const sessions = new Map();        // chatId -> { cart, step, ... }
const adminMessageMap = new Map(); // adminMsgId -> { customerChatId }
const orders = [];                 // in-memory orders
let nextOrderId = 1;

const adminState = { mode: null, deliveryOrderId: null }; // 'broadcast' | 'await_delivery_link'

// ───────── EXPRESS ─────────
const app = express();
app.use(express.json());
app.use("/static", express.static("public"));

// ───────── TG HELPERS ─────────
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

// ───────── CONTACT ADMIN FLOW ─────────
async function startContactAdmin(chatId) {
  const s = getSession(chatId);
  s.step = "contact_admin";
  await tgSendMessage(
    chatId,
    "🧑‍💼 *Contact Admin*\nPlease type your message. We'll forward it to our admin now.",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "⬅️ Back to Categories", callback_data: "contact:cancel" }]],
      },
    }
  );
}
async function forwardCustomerMessageToAdmin(chatId, text) {
  const s = getSession(chatId);
  const header =
    `✉️ *Customer message*\n` +
    `• Chat ID: ${chatId}\n` +
    (s.name ? `• Name: ${s.name}\n` : "") +
    (s.phone ? `• Phone: ${s.phone}\n` : "") +
    (s.address ? `• Address: ${s.address}\n` : "") +
    `\n${text}`;

  const r = await tgSendMessage(ADMIN_CHAT_ID, header, { parse_mode: "Markdown" });
  const j = await r.json().catch(() => null);
  if (j?.ok) adminMessageMap.set(j.result.message_id, { customerChatId: chatId });
  await tgSendMessage(chatId, "✅ Sent to admin. We’ll reply here as soon as possible.");
}

// ───────── QR (with Payment + Contact Admin) ─────────
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
        inline_keyboard: [
          [
            { text: "💰 Payment Processed", callback_data: "order:confirm" },
            { text: "🧑‍💼 Contact Admin",  callback_data: "contact:admin"  },
          ],
        ],
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

// ───────── UTIL ─────────
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
      { headers: { "User-Agent": "YeloSpotBot/1.0" } }
    );
    const j = await r.json();
    return j.display_name || `${lat}, ${lon}`;
  } catch { return `${lat}, ${lon}`; }
}

// ───────── KEYBOARDS (persistent Contact Admin) ─────────
function buildCategoryKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "💧 Sachet",  callback_data: "cat:sachet" },
        { text: "💉 Syringe", callback_data: "cat:syringe" },
      ],
      [
        { text: "🧪 Poppers", callback_data: "cat:poppers" },
      ],
      [
        { text: "🧑‍💼 Contact Admin", callback_data: "contact:admin" },
      ],
    ],
  };
}
function buildAmountKeyboard(s) {
  const inline_keyboard = [];
  const list = PRICE_LIST[s.category] || [];
  for (let i = 0; i < list.length; i += 2) {
    inline_keyboard.push(list.slice(i, i + 2).map(p => ({
      text: p.label, callback_data: p.callback
    })));
  }
  inline_keyboard.push([
    { text: "📂 Categories", callback_data: "cat:menu" },
    { text: "🧾 View Cart",  callback_data: "cart:view" },
  ]);
  inline_keyboard.push([{ text: "✅ Checkout", callback_data: "cart:checkout" }]);
  inline_keyboard.push([{ text: "🧑‍💼 Contact Admin", callback_data: "contact:admin" }]);
  return { inline_keyboard };
}

// ───────── ADMIN CENTER ─────────
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
  return tgSendMessage(ADMIN_CHAT_ID, "👑 *Admin Center — Yelo🟡Spot*", {
    parse_mode: "Markdown",
    reply_markup: adminPanelKeyboard(),
  });
}
function findOrder(id) { return orders.find(o => o.id === id); }
function orderSummaryText(o) {
  const lines = [
    `🧾 Order #${o.id}`,
    "",
    `👤 ${o.name || "N/A"}`,
    `📱 ${o.phone || "N/A"}`,
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
  if (!orders.length) return tgSendMessage(chatId, "— No orders yet —");
  const latest = [...orders].slice(-10).reverse();
  for (const o of latest) {
    const kb = {
      inline_keyboard: [
        [{ text: "➡️ View",               callback_data: `admin:order:${o.id}` }],
        [{ text: "🚚 Send Delivery Link", callback_data: `admin:sendlink:${o.id}` }],
        [{ text: "✅ Mark Completed",     callback_data: `admin:done:${o.id}` }],
        [{ text: "❌ Cancel",             callback_data: `admin:cancel:${o.id}` }],
      ],
    };
    await tgSendMessage(chatId, orderSummaryText(o), { reply_markup: kb });
  }
}

// Notify admin & map replies to customer
async function notifyAdminNewOrder(order, from) {
  const text = orderSummaryText(order);
  const r = await tgSendMessage(ADMIN_CHAT_ID, text);
  const j = await r.json().catch(() => null);
  if (j?.ok) adminMessageMap.set(j.result.message_id, { customerChatId: from.id });

  if (order.coords) await tgSendLocation(ADMIN_CHAT_ID, order.coords.latitude, order.coords.longitude);
  if (order.paymentProof) {
    await tgSendPhotoByFileId(
      ADMIN_CHAT_ID,
      order.paymentProof,
      `💰 Payment screenshot for Order #${order.id}`
    );
  }
}

// ───────── CALLBACKS ─────────
async function handleCallbackQuery(cbq) {
  const chatId = cbq.message.chat.id;
  const msgId = cbq.message.message_id;
  const data = cbq.data;
  const s = getSession(chatId);

  // TERMS & CONDITIONS
  if (data === "terms:agree") {
    s.step = "ordering";
    await tgEditMessageText(chatId, msgId, "✅ Thank you for agreeing. Let's begin!", {
      reply_markup: buildCategoryKeyboard(),
    });
    return;
  }
  if (data === "terms:decline") {
    await tgEditMessageText(
      chatId,
      msgId,
      "❌ You must be at least 18 years old and agree to the Terms & Conditions to continue.\nType /start again if you change your mind."
    );
    sessions.delete(chatId);
    return;
  }

  // CONTACT ADMIN
  if (data === "contact:admin") { await startContactAdmin(chatId); return; }
  if (data === "contact:cancel") {
    s.step = "ordering";
    await tgEditMessageText(chatId, msgId, "📂 Back to Categories", {
      reply_markup: buildCategoryKeyboard(),
    });
    return;
  }

  // ADMIN CALLBACKS
  if (data.startsWith("admin:")) {
    if (chatId !== ADMIN_CHAT_ID) { await tgSendMessage(chatId, "⛔ Unauthorized."); return; }
    const [, action, arg] = data.split(":");
    switch (action) {
      case "toggle":
        SHOP_OPEN = !SHOP_OPEN;
        await tgEditMessageText(chatId, msgId, "👑 *Admin Center — Yelo🟡Spot*", {
          parse_mode: "Markdown",
          reply_markup: adminPanelKeyboard(),
        });
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
            [{ text: "✅ Mark Completed",     callback_data: `admin:done:${o.id}` }],
            [{ text: "❌ Cancel",             callback_data: `admin:cancel:${o.id}` }],
          ],
        };
        await tgSendMessage(chatId, orderSummaryText(o), { reply_markup: kb });
        break;
      }
      case "sendlink":
        adminState.mode = "await_delivery_link";
        adminState.deliveryOrderId = Number(arg);
        await tgSendMessage(chatId, `✍️ Reply with the delivery/tracking link for Order #${arg}.`);
        break;
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

  // CUSTOMER CALLBACKS (guard if closed)
  if (!SHOP_OPEN) { await tgSendMessage(chatId, "🏪 The shop is closed."); return; }

  if (data === "cat:menu") {
    delete s.category;
    delete s.selectedAmount;
    await tgEditMessageText(chatId, msgId, "🧊 Choose a product type 👇", {
      reply_markup: buildCategoryKeyboard(),
    });
    return;
  }

  if (data.startsWith("cat:")) {
    s.category = data.slice(4); // sachet | syringe | poppers | poppers_fast | ...
    const text = s.category === "poppers"
      ? "🧪 Poppers — choose a style 👇"
      : `🧊 ${s.category} selected`;
    await tgEditMessageText(
      chatId,
      msgId,
      text,
      s.category === "poppers"
        ? {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "⚡ Fast-acting",  callback_data: "cat:poppers_fast" },
                  { text: "🌿 Smooth blend", callback_data: "cat:poppers_smooth" },
                ],
                [
                  { text: "💎 Premium",      callback_data: "cat:poppers_premium" },
                ],
                [
                  { text: "📂 Categories",   callback_data: "cat:menu" },
                  { text: "🧑‍💼 Contact Admin", callback_data: "contact:admin" },
                ],
              ],
            },
          }
        : { reply_markup: buildAmountKeyboard(s) }
    );
    return;
  }

  if (data.startsWith("amt:")) {
    const amount = data.slice(4);         // peso amount or poppers brand label
    ensureCart(s);
    s.selectedAmount = amount;
    const itemLabel = (s.category?.startsWith("poppers")) ? `₱700 • ${amount}` : amount;
    s.cart.push({ category: s.category, amount: itemLabel });
    await tgSendMessage(chatId, `🛒 Added: ${s.category} — ${itemLabel}`);
    await tgEditMessageText(
      chatId, msgId,
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
    s.status = "delivered";
    const o = orders.find(x => x.customerChatId === chatId && x.status !== "canceled");
    if (o) o.status = "delivered";
    await tgSendMessage(chatId, "✅ Thank you for confirming! We’re glad your order arrived safely. 💙");
    await tgSendMessage(ADMIN_CHAT_ID, `📦 Customer *${s.name || chatId}* marked the order as *Received*.`, { parse_mode: "Markdown" });
    return;
  }
}

// ───────── MESSAGES ─────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const s = getSession(chatId);

  // Admin reply bridge
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

  // Admin typed delivery link after "Send Delivery Link"
  if (chatId === ADMIN_CHAT_ID && adminState.mode === "await_delivery_link") {
    const id = adminState.deliveryOrderId;
    const o = findOrder(id);
    adminState.mode = null;
    adminState.deliveryOrderId = null;
    if (!o) return tgSendMessage(chatId, "⚠️ Order not found.");
    await tgSendMessage(
      o.customerChatId,
      `🛵 Delivery link:\n${text}\n\nTap below once you receive your order.`,
      { reply_markup: { inline_keyboard: [[{ text: "📦 Mark as Received", callback_data: "order:received" }]] } }
    );
    await tgSendMessage(chatId, `✅ Delivery link sent to customer for Order #${id}.`);
    o.status = "out_for_delivery";
    return;
  }

  // Admin broadcast
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

  // Admin command
  if (text === "/admin") {
    if (chatId !== ADMIN_CHAT_ID) return tgSendMessage(chatId, "⛔ This command is for admin only.");
    await openAdminCenter();
    return;
  }
  if (text === "/open")  { SHOP_OPEN = true;  return tgSendMessage(chatId, "🟢 Shop is now OPEN."); }
  if (text === "/close") { SHOP_OPEN = false; return tgSendMessage(chatId, "🔴 Shop is now CLOSED."); }

  // Public commands (menu support)
  if (text === "/menu") {
    if (!SHOP_OPEN) return tgSendMessage(chatId, "🏪 The shop is closed.");
    return tgSendMessage(chatId, "🧊 Choose a product type 👇", { reply_markup: buildCategoryKeyboard() });
  }
  if (text === "/help") {
    return tgSendMessage(chatId, "ℹ️ Use /start to begin, tap a category, then checkout. Need help? Tap “Contact Admin”.");
  }
  if (text === "/faq") {
    return tgSendMessage(chatId, "❓ FAQ:\n• Payment via QRPh/GCash\n• Share location for delivery\n• Tap 'Payment Processed' then upload proof.");
  }
  if (text === "/viewcart") {
    const txt = s.cart?.length ? itemsToText(s.cart) : "🧺 Cart empty.";
    return tgSendMessage(chatId, txt);
  }
  if (text === "/checkout") {
    if (!s.cart?.length) return tgSendMessage(chatId, "🧺 Your cart is empty.");
    s.step = "ask_name";
    return tgSendMessage(chatId, "📝 Please enter your name:");
  }
  if (text === "/contact") return startContactAdmin(chatId);

  // Start (Terms & Conditions gate + Yelo🟡Spot welcome)
  if (text === "/start" || text === "/restart") {
    if (!SHOP_OPEN) return tgSendMessage(chatId, "🏪 The shop is closed.");
    const s0 = { lastActive: Date.now(), cart: [], step: "terms" };
    sessions.set(chatId, s0);

    const termsText = `
👋 Welcome to *Yelo🟡Spot*!

❄️ Chill deals. Fast service.  
Before we begin, please read and agree to our Terms & Conditions:

⚠️ *Terms & Conditions*  
• You confirm that you are *18 years old and above*.  
• You understand and accept full responsibility for your order.  
• No refunds once the order has been confirmed.  
• Please use responsibly and comply with all applicable laws.

Tap below to proceed.
`.trim();

    await tgSendMessage(chatId, termsText, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ I Agree (18+)", callback_data: "terms:agree" },
            { text: "❌ I Disagree",    callback_data: "terms:decline" },
          ],
          [
            { text: "🧑‍💼 Contact Admin", callback_data: "contact:admin" },
          ]
        ],
      },
    });
    return;
  }

  // Contact Admin typing mode
  if (s.step === "contact_admin") {
    if (!text) return; // ignore non-text here
    await forwardCustomerMessageToAdmin(chatId, text);
    s.step = "ordering"; // return to normal flow
    return;
  }

  // Name → phone
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

  // Fallback
  await tgSendMessage(chatId, "Please use /start to begin ordering.");
}

// ───────── CONTACT (phone) ─────────
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

// ───────── LOCATION (address & summary) ─────────
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
📋 *Order Summary (Yelo🟡Spot)*

👤 Name: ${s.name}
📱 Phone: ${s.phone}
📍 Address: ${s.address}

🧺 Items:
${itemsTxt}

💰 *Payment Instructions:*
Scan the QR (QRPh / GCash) below, then tap *Payment Processed* and upload your proof.
`.trim();

  await tgSendMessage(chatId, summary, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "🧑‍💼 Contact Admin", callback_data: "contact:admin" }]] }
  });
  await sendPaymentQR(chatId);
}

// ───────── PAYMENT PROOF (photo/document) ─────────
async function handlePhotoOrDocument(msg) {
  const chatId = msg.chat.id;
  if (!SHOP_OPEN) return tgSendMessage(chatId, "🏪 The shop is closed.");
  const s = getSession(chatId);
  if (s.step !== "await_payment_proof") return;

  s.paymentProof = msg.photo ? msg.photo.pop().file_id : msg.document?.file_id;

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

  await notifyAdminNewOrder(order, msg.from);

  s.status = "complete";
  await tgSendMessage(
    chatId,
    "✅ Thank you! Payment screenshot received.\n🛵 Your delivery link will be sent shortly.\nPlease keep this chat open.",
    { reply_markup: { inline_keyboard: [[{ text: "🧑‍💼 Contact Admin", callback_data: "contact:admin" }]] } }
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
  } catch (e) {
    console.error("❌ Update error:", e);
  }
  res.sendStatus(200);
});

// ───────── HEALTH + STARTUP ─────────
app.get("/health", (_, r) =>
  r.json({ ok: true, shop_open: SHOP_OPEN, active_sessions: sessions.size, orders: orders.length })
);

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // Set webhook
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

  // ---- PERSISTENT MENU COMMANDS ----
  try {
    await fetchFn(`${TELEGRAM_API}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "start",    description: "Start ordering" },
          { command: "restart",  description: "Restart session" },
          { command: "menu",     description: "Show categories" },
          { command: "viewcart", description: "View your cart" },
          { command: "checkout", description: "Checkout order" },
          { command: "contact",  description: "Contact admin" },
          { command: "help",     description: "How to use Yelo🟡Spot" },
          { command: "faq",      description: "FAQs" },
          { command: "status",   description: "Check order status" },
          // NOTE: We keep /admin hidden from menu; still works if admin types it.
        ],
      }),
    });
    console.log("✅ Telegram menu commands registered.");
  } catch (e) {
    console.error("❌ Failed to set menu commands:", e);
  }
});

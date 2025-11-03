// index.js
import express from "express";
import fetchPkg from "node-fetch";
const fetchFn = typeof fetch !== "undefined" ? fetch : fetchPkg;
import { generateReceiptPNG } from "./lib/ereceipt.js";

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
const sessions = new Map();         // chatId -> session
const adminMessageMap = new Map();  // adminMsgId -> { customerChatId }
const loggedInAdmins = new Set();
const orders = [];                  // in-memory order log
let orderCounter = 1;
let SHOP_OPEN = true;

// ───────── EXPRESS ─────────
const app = express();
app.use(express.json());
app.use("/static", express.static("public")); // serve qrph.jpg if you use it

// ───────── BASIC TG HELPERS ─────────
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
async function tgSendPhotoBuffer(chatId, buffer, filename, caption = "") {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  if (caption) fd.append("caption", caption);
  fd.append("photo", new Blob([buffer], { type: "image/png" }), filename);
  return fetch(`${TELEGRAM_API}/sendPhoto`, { method: "POST", body: fd });
}

// ───────── SESSION HELPERS ─────────
function getSession(chatId) {
  const now = Date.now();
  let s = sessions.get(chatId);
  if (!s) {
    s = { lastActive: now, status: "idle" };
    sessions.set(chatId, s);
  } else s.lastActive = now;
  return s;
}
function ensureCart(s) { if (!s.cart) s.cart = []; }

// ───────── UI HELPERS ─────────
function addSupportRow(kb) {
  const support = [{ text: "🧑‍💼 Connect to Admin", callback_data: "support:connect" }];
  return { inline_keyboard: [...kb.inline_keyboard, support] };
}
function buildAmountKeyboard(s) {
  const inline_keyboard = [];
  if (!s.category) {
    inline_keyboard.push([
      { text: "💧 Sachet", callback_data: "cat:sachet" },
      { text: "💉 Syringe", callback_data: "cat:syringe" },
    ]);
    return addSupportRow({ inline_keyboard });
  }
  inline_keyboard.push([
    { text: `${s.category === "sachet" ? "💧 Sachet" : "💉 Syringe"} — Choose Amount`, callback_data: "noop" },
  ]);
  if (s.category === "sachet") {
    inline_keyboard.push(
      [{ text: "₱500", callback_data: "amt:₱500" }, { text: "₱700", callback_data: "amt:₱700" }],
      [{ text: "₱1,000", callback_data: "amt:₱1,000" }, { text: "Half G", callback_data: "amt:Half G" }],
      [{ text: "1 G", callback_data: "amt:1 G" }]
    );
  } else {
    inline_keyboard.push(
      [{ text: "₱500", callback_data: "amt:₱500" }, { text: "₱700", callback_data: "amt:₱700" }],
      [{ text: "₱1,000", callback_data: "amt:₱1,000" }]
    );
  }
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
  } catch { return `${lat}, ${lon}`; }
}

// ───────── ADMIN NOTIFY ─────────
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
    name: s.name, phone: s.phone,
    address: s.address, coords: s.coords,
    items: s.cart || [], createdAt: ts,
  });
  if (orders.length > 200) orders.pop();

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
  await refreshAllAdminPanels();
}

// ───────── ADMIN CENTER (LIVE) ─────────
const adminPanels = new Map(); // adminChatId -> message_id

function adminPanelText() {
  const openIcon = SHOP_OPEN ? "🟢 OPEN" : "🔴 CLOSED";
  const active = sessions.size;
  const totalOrders = orders.length;
  return [
    "🧑‍💼 *Admin Center*",
    `🏪 Shop: *${openIcon}*`,
    `👥 Active sessions: *${active}*`,
    `🧾 Orders (last 24h): *${totalOrders}*`,
    "",
    "Use the buttons below to manage the shop.",
  ].join("\n");
}
function adminPanelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🧾 View Orders", callback_data: "admin:view_orders" }],
      [{ text: SHOP_OPEN ? "🔴 Close Shop" : "🟢 Open Shop", callback_data: "admin:toggle_shop" }],
      [{ text: "📢 Broadcast", callback_data: "admin:broadcast" }],
      [{ text: "🔐 Logout", callback_data: "admin:logout" }],
    ],
  };
}
async function renderAdminPanel(chatId) {
  const existingId = adminPanels.get(chatId);
  const opts = { parse_mode: "Markdown", reply_markup: adminPanelKeyboard() };
  if (existingId) {
    await tgEditMessageText(chatId, existingId, adminPanelText(), opts);
  } else {
    const res = await tgSendMessage(chatId, adminPanelText(), opts);
    const j = await res.json().catch(() => null);
    if (j?.ok) adminPanels.set(chatId, j.result.message_id);
  }
}
async function refreshAllAdminPanels() {
  for (const adminId of loggedInAdmins) {
    await renderAdminPanel(adminId);
  }
}

// ───────── COMMAND DISPATCH ─────────
const PUBLIC_COMMANDS = ["start","restart","help","faq","menu","contact","checkout","status"];
const ADMIN_ONLY_COMMANDS = ["admin"]; // other admin actions are only in Admin Center

function sendCommandMenu(chatId, isAdmin = false) {
  const userCmds = PUBLIC_COMMANDS.map(c => "/" + c).join(", ");
  const adminCmds = isAdmin ? "\nAdmin: /admin" : "";
  return tgSendMessage(chatId, `🤖 Available commands:\nUser: ${userCmds}${adminCmds}`);
}

async function handleCommand(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const s = getSession(chatId);
  if (!text.startsWith("/")) return false;

  const [rawCmd] = text.split(/\s+/);
  const cmd = rawCmd.slice(1).toLowerCase();
  const isAdmin = ADMIN_IDS.includes(chatId);
  const known = new Set([...PUBLIC_COMMANDS, ...ADMIN_ONLY_COMMANDS]);

  if (!known.has(cmd)) {
    await tgSendMessage(chatId, `❓ Unknown command: /${cmd}`);
    await sendCommandMenu(chatId, isAdmin);
    return true;
  }

  // USER COMMANDS
  switch (cmd) {
    case "start":
    case "restart":
      sessions.set(chatId, { step: "choose_category", cart: [], status: "ordering", lastActive: Date.now() });
      await tgSendMessage(chatId, "🧊 Welcome!\nChoose a product type 👇", {
        reply_markup: buildAmountKeyboard({}),
      });
      return true;
    case "help":
    case "menu":
      await sendCommandMenu(chatId, isAdmin);
      return true;
    case "faq":
      await tgSendMessage(chatId, "❓ Pay via QRPh/GCash then upload screenshot. We'll send a Grab link and a receipt.");
      return true;
    case "contact":
      s.prevStep = s.step || null;
      s.step = "support_wait_message";
      await tgSendMessage(chatId, "🧑‍💼 Please type your message for the admin:");
      return true;
    case "checkout":
      ensureCart(s);
      if (!s.cart?.length && s.category && s.selectedAmount)
        s.cart.push({ category: s.category, amount: s.selectedAmount });
      if (!s.cart?.length) return tgSendMessage(chatId, "🧺 Cart empty.");
      s.step = "ask_name";
      await tgSendMessage(chatId, "📝 Please enter your name:");
      return true;
    case "status":
      await tgSendMessage(chatId, `ℹ️ Status: ${s.status || "idle"} • Step: ${s.step || "-"}`);
      return true;
  }

  // ADMIN ENTRY POINT
  if (cmd === "admin") {
    if (!isAdmin) { await tgSendMessage(chatId, "🚫 Access denied. Admin only."); return true; }
    loggedInAdmins.add(chatId);
    await renderAdminPanel(chatId);
    return true;
  }
  return true;
}

// ───────── MESSAGE HANDLER ─────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const s = getSession(chatId);

  // route slash commands first
  const routed = await handleCommand(msg);
  if (routed) return;

  if (!SHOP_OPEN && !ADMIN_IDS.includes(chatId))
    return tgSendMessage(chatId, "🏪 The shop is currently closed. Please check back later!");

  // ADMIN reply relay
  if (chatId === ADMIN_CHAT_ID && msg.reply_to_message) {
    const info = adminMessageMap.get(msg.reply_to_message.message_id);
    if (!info) return tgSendMessage(chatId, "⚠️ Cannot map reply.");
    await tgSendMessage(info.customerChatId, `🧑‍💼 Admin:\n${text}`);

    // detect delivery/tracking/link → attach "Mark as Received"
    const deliveryRegex = /(grab|delivery|courier|tracking|link|https?:\/\/\S+)/i;
    if (deliveryRegex.test(text)) {
      const kb = { inline_keyboard: [[{ text: "📦 Mark as Received", callback_data: "order:received" }]] };
      await tgSendMessage(
        info.customerChatId,
        "🛵 Your order is on the way!\nOnce you receive it, please tap below 👇",
        { reply_markup: kb }
      );
    }
    await tgSendMessage(chatId, "✅ Sent to customer.");
    return;
  }

  // broadcast input step (if you later add it back)
  if (s.step === "admin_broadcast" && loggedInAdmins.has(chatId)) {
    s.step = null;
    for (const [cid] of sessions) if (cid !== chatId)
      await tgSendMessage(cid, `📢 *Admin Broadcast:*\n${text}`, { parse_mode: "Markdown" });
    await tgSendMessage(chatId, "✅ Broadcast sent.");
    await refreshAllAdminPanels();
    return;
  }

  // support message body
  if (s.step === "support_wait_message" && text) {
    const support = `🆘 *Support Request*\nFrom: ${msg.from.first_name || "Customer"} (ID:${msg.from.id})\n\n${text}`;
    const r = await tgSendMessage(ADMIN_CHAT_ID, support, { parse_mode: "Markdown" });
    const j = await r.json().catch(() => null);
    if (j?.ok) adminMessageMap.set(j.result.message_id, { customerChatId: chatId });
    s.step = s.prevStep || null; s.prevStep = null;
    await tgSendMessage(chatId, "✅ Sent to admin. Please wait for a reply here.");
    return;
  }

  // name collection
  if (s.step === "ask_name") {
    s.name = text.trim();
    s.step = "request_phone";
    await tgSendMessage(chatId, "📱 Please share your phone number:", {
      reply_markup: {
        keyboard: [[{ text: "📱 Share Phone", request_contact: true }]],
        resize_keyboard: true, one_time_keyboard: true,
      },
    });
    return;
  }

  await tgSendMessage(chatId, "Please /start to begin.");
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
      resize_keyboard: true, one_time_keyboard: true,
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

  const itemsTxt = s.cart?.length
    ? s.cart.map((it, i) => `${i + 1}. ${it.category} — ${it.amount}`).join("\n")
    : `${s.category || "N/A"} — ${s.selectedAmount || "N/A"}`;

  const summary = `
📋 *Order Summary*

🧺 Items:
${itemsTxt}

👤 ${s.name}
📱 ${s.phone}
📍 ${s.address}

💰 *Payment Instructions:*
Scan the QR (QRPh/GCash) if provided.
After payment, tap *Payment Processed* and upload your proof.
`.trim();

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

  // Admin center
  if (data.startsWith("admin:")) {
    if (!loggedInAdmins.has(chatId)) return tgSendMessage(chatId, "🚫 You are not logged in as admin.");
    if (data === "admin:view_orders") {
      if (!orders.length) return tgSendMessage(chatId, "🧾 No orders yet.");
      const list = orders
        .slice(0, 10)
        .map(o => `#${o.id} ${o.name} — ${o.items.map(i=>i.amount).join(", ")} (${o.createdAt})`)
        .join("\n");
      await tgSendMessage(chatId, `📋 Recent Orders:\n${list}`);
      return;
    }
    if (data === "admin:broadcast") {
      s.step = "admin_broadcast";
      await tgSendMessage(chatId, "📢 Send the message to broadcast to all active users.");
      return;
    }
    if (data === "admin:toggle_shop") {
      SHOP_OPEN = !SHOP_OPEN;
      await refreshAllAdminPanels();
      return;
    }
    if (data === "admin:logout") {
      loggedInAdmins.delete(chatId);
      adminPanels.delete(chatId);
      await tgSendMessage(chatId, "🔐 Logged out.");
      return;
    }
  }

  // Support quick access
  if (data === "support:connect") {
    s.prevStep = s.step || null;
    s.step = "support_wait_message";
    await tgSendMessage(chatId, "🧑‍💼 Please type your message for the admin:");
    return;
  }

  // Customer: delivery received → dynamic e-receipt
  if (data === "order:received") {
    s.status = "delivered";
    await tgSendMessage(chatId, "✅ Thank you for confirming! We’re glad your order arrived safely. 💙");

    const order = {
      id: orderCounter, // or your persisted id
      name: s.name, phone: s.phone, address: s.address,
      items: s.cart?.length ? s.cart : [{ category: s.category, amount: s.selectedAmount }],
      ts: new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }),
    };
    const png = await generateReceiptPNG(order);
    await tgSendPhotoBuffer(chatId, png, `receipt_${order.id}.png`, "🧾 Official Receipt — Thank you for your purchase!");

    await tgSendMessage(
      ADMIN_CHAT_ID,
      `📦 Customer *${s.name || "N/A"}* confirmed they received their order.`,
      { parse_mode: "Markdown" }
    );
    await refreshAllAdminPanels();
    return;
  }

  // Product flow
  if (data.startsWith("cat:")) {
    s.category = data.slice(4);
    s.step = "choose_amount";
    s.status = "ordering";
    ensureCart(s);
    await tgEditMessageText(chatId, msgId, `🧊 ${s.category} selected.`, { reply_markup: buildAmountKeyboard(s) });
    return;
  }
  if (data.startsWith("amt:")) {
    s.selectedAmount = data.slice(4);
    await tgEditMessageText(chatId, msgId, `💸 Selected ${s.selectedAmount}`, { reply_markup: buildAmountKeyboard(s) });
    return;
  }
  if (data === "cart:add") {
    ensureCart(s);
    if (!s.category || !s.selectedAmount) { await tgSendMessage(chatId, "⚠️ Select a category and amount first."); return; }
    s.cart.push({ category: s.category, amount: s.selectedAmount });
    await tgSendMessage(chatId, `🛒 Added: ${s.category} — ${s.selectedAmount}`);
    return;
  }
  if (data === "cart:view") {
    ensureCart(s);
    const txt = s.cart.length
      ? s.cart.map((x, i) => `${i + 1}. ${x.category} — ${x.amount}`).join("\n")
      : "🧺 Cart is empty.";
    await tgSendMessage(chatId, txt);
    return;
  }
  if (data === "cart:checkout") {
    ensureCart(s);
    if (!s.cart.length && s.category && s.selectedAmount)
      s.cart.push({ category: s.category, amount: s.selectedAmount });
    if (!s.cart.length) { await tgSendMessage(chatId, "🧺 Cart empty."); return; }
    s.step = "ask_name";
    await tgSendMessage(chatId, "📝 Please enter your name:");
    return;
  }
  if (data === "order:confirm") {
    s.step = "await_payment_proof";
    s.status = "await_payment";
    await tgSendMessage(chatId, "📸 Please upload your payment screenshot.");
    return;
  }
  if (data === "order:cancel") {
    sessions.set(chatId, { status: "idle" });
    await tgEditMessageText(chatId, msgId, "❌ Order canceled.");
    return;
  }
}

// ───────── WEBHOOK ROUTE ─────────
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
    } else if (u.callback_query) {
      await handleCallbackQuery(u.callback_query);
    }
  } catch (err) {
    console.error("❌ Update error:", err);
  }
  res.sendStatus(200);
});

// ───────── AUTO CLEANUP ─────────
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

// ───────── HEALTH + STARTUP ─────────
app.get("/", (_, r) => r.send("🧊 IceOrderBot running (webhook mode)."));
app.get("/health", (_, r) =>
  r.json({ ok: true, shop_open: SHOP_OPEN, active_sessions: sessions.size, uptime: process.uptime() })
);

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // Clean public command menu (admin actions only via Admin Center)
  try {
    await fetchFn(`${TELEGRAM_API}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "start", description: "Begin new order" },
          { command: "help", description: "Show help info" },
          { command: "menu", description: "Main menu" },
          { command: "contact", description: "Connect to admin" },
          { command: "checkout", description: "Complete your order" },
          { command: "status", description: "Check order status" },
          { command: "admin", description: "Open Admin Center" }
        ],
      }),
    });
  } catch (err) { console.error("setMyCommands error:", err); }

  if (HOST_URL) {
    const webhook = `${HOST_URL}${path}`;
    try {
      await fetchFn(`${TELEGRAM_API}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhook }),
      });
      console.log(`✅ Webhook set to: ${webhook}`);
    } catch (err) { console.error("❌ Failed to set webhook:", err); }
  } else {
    console.warn("⚠️ HOST_URL not set — please set webhook manually.");
  }
});

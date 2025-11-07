// index.js
import express from "express";
import fetchPkg from "node-fetch";
const fetchFn = typeof fetch !== "undefined" ? fetch : fetchPkg;
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

import {
  dbInit,
  createOrder,
  listRecentOrders,
  getOrderById,
  updateOrderStage,
  setDeliveryLink,
  markReceivedByChat,
  latestActiveOrderByChatId,
  createMessage,
  listMessages,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const BOT_TOKEN = process.env.BOT_TOKEN;
const HOST_URL  = process.env.HOST_URL;
const PORT      = process.env.PORT || 3000;

const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map(s => Number(s.trim()))
  .filter(n => Number.isFinite(n));

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing.");
if (ADMIN_IDS.length === 0) console.warn("⚠️ No ADMIN_IDS configured.");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const PRICE_LIST = {
  sachet: [
    { label: "₱500 — 0.028",   callback: "amt:₱500 — 0.028" },
    { label: "₱700 — 0.042",   callback: "amt:₱700 — 0.042" },
    { label: "₱1,000 — 0.056", callback: "amt:₱1,000 — 0.056" },
    { label: "₱2,000 — Half",  callback: "amt:₱2,000 — Half" },
    { label: "₱3,800 — 8",     callback: "amt:₱3,800 — 8" },
  ],
  syringe: [
    { label: "₱500 — 12 units",   callback: "amt:₱500 — 12 units" },
    { label: "₱700 — 20 units",   callback: "amt:₱700 — 20 units" },
    { label: "₱1,000 — 30 units", callback: "amt:₱1,000 — 30 units" },
  ],
  poppers: [
    { label: "⚡ Fast-acting",  callback: "cat:poppers_fast" },
    { label: "🌿 Smooth blend", callback: "cat:poppers_smooth" },
    { label: "💎 Premium",      callback: "cat:poppers_premium" },
  ],
  poppers_fast: [
    { label: "Rush Ultra Strong (Yellow) — ₱700", callback: "amt:Rush Ultra Strong (Yellow)" },
    { label: "Iron Horse — ₱700",                 callback: "amt:Iron Horse" },
    { label: "Jungle Juice Platinum — ₱700",      callback: "amt:Jungle Juice Platinum" },
  ],
  poppers_smooth: [
    { label: "Blue Boy — ₱700",        callback: "amt:Blue Boy" },
    { label: "Cannabis — ₱700",        callback: "amt:Cannabis" },
    { label: "Pink Amsterdam — ₱700",  callback: "amt:Pink Amsterdam" },
    { label: "Manscent — ₱700",        callback: "amt:Manscent" },
  ],
  poppers_premium: [
    { label: "Jungle Juice Platinum — ₱700", callback: "amt:Jungle Juice Platinum" },
    { label: "Manscent — ₱700",              callback: "amt:Manscent" },
  ],
};

let SHOP_OPEN = true;
const sessions         = new Map();
const adminMessageMap  = new Map();
const adminState       = { mode: null, deliveryOrderId: null };

const app = express();
app.use(express.json());
app.use("/static", express.static("public"));
app.use("/admin-app", express.static(path.join(__dirname, "public", "admin-app")));

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

const isAdmin = (id) => ADMIN_IDS.includes(id);

function getSession(chatId) {
  const now = Date.now();
  let s = sessions.get(chatId);
  if (!s) {
    s = { lastActive: now, cart: [], status: "idle" };
    sessions.set(chatId, s);
  } else {
    s.lastActive = now;
  }
  return s;
}
function ensureCart(s) { if (!s.cart) s.cart = []; }
function itemsToText(items) { return (items || []).map((i, idx) => `${idx+1}. ${i.category} — ${i.amount}`).join("\n"); }
async function reverseGeocode(lat, lon) {
  try {
    const r = await fetchFn(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
      { headers: { "User-Agent": "YeloSpotBot/1.0" } }
    );
    const j = await r.json();
    return j.display_name || `${lat}, ${lon}`;
  } catch {
    return `${lat}, ${lon}`;
  }
}

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
async function forwardCustomerMessageToAdmins(chatId, text) {
  const s = getSession(chatId);
  const header =
    `✉️ *Customer message*\n` +
    `• Chat ID: ${chatId}\n` +
    (s.name ? `• Name: ${s.name}\n` : "") +
    (s.phone ? `• Phone: ${s.phone}\n` : "") +
    (s.address ? `• Address: ${s.address}\n` : "") +
    `\n${text}`;

  for (const adminId of ADMIN_IDS) {
    const r = await tgSendMessage(adminId, header, { parse_mode: "Markdown" });
    const j = await r.json().catch(() => null);
    if (j?.ok) adminMessageMap.set(j.result.message_id, { customerChatId: chatId });
  }
  await tgSendMessage(chatId, "✅ Sent to admin. We’ll reply here as soon as possible.");
}

async function sendPaymentQR(chatId) {
  try {
    const url = `${HOST_URL?.replace(/\/+$/, "")}/static/qrph.jpg`;
    const r   = await fetchFn(`${TELEGRAM_API}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: url,
        caption: "💰 Scan to pay (QRPh / GCash).",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "💰 Payment Processed", callback_data: "order:confirm" },
              { text: "🧑‍💼 Contact Admin",  callback_data: "contact:admin"  },
            ],
          ],
        },
      }),
    });
    const j = await r.json().catch(() => null);
    if (!j?.ok) throw new Error("Telegram rejected QR photo");
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

function buildCategoryKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "💧 Sachet",  callback_data: "cat:sachet" },
        { text: "💉 Syringe", callback_data: "cat:syringe" },
      ],
      [{ text: "🧪 Poppers", callback_data: "cat:poppers" }],
      [{ text: "🧑‍💼 Contact Admin", callback_data: "contact:admin" }],
    ],
  };
}
function buildAmountKeyboard(s) {
  const inline_keyboard = [];
  const listKey = s.category;
  const list    = PRICE_LIST[listKey] || [];
  for (let i = 0; i < list.length; i += 2) {
    inline_keyboard.push(list.slice(i, i+2).map(p => ({
      text: p.label, callback_data: p.callback
    })));
  }
  inline_keyboard.push([
    { text: "📂 Categories", callback_data: "cat:menu" },
    { text: "🧾 View Cart",   callback_data: "cart:view" },
  ]);
  inline_keyboard.push([{ text: "✅ Checkout", callback_data: "cart:checkout" }]);
  inline_keyboard.push([{ text: "🧑‍💼 Contact Admin", callback_data: "contact:admin" }]);
  return { inline_keyboard };
}

function adminPanelKeyboard() {
  const kb = {
    inline_keyboard: [
      [{ text: SHOP_OPEN ? "🔴 Close Shop" : "🟢 Open Shop", callback_data: "admin:toggle" }],
      [{ text: "📋 View Orders", callback_data: "admin:orders" }],
      [{ text: "📢 Broadcast", callback_data: "admin:broadcast" }],
    ],
  };
  if (HOST_URL) {
    kb.inline_keyboard.push([{ text: "🖥️ Open Dashboard", web_app: { url: `${HOST_URL}/admin-app` } }]);
  }
  return kb;
}
async function openAdminCenter(forAdminId) {
  return tgSendMessage(forAdminId, "👑 *Admin Center — Yelo🟡Spot*", {
    parse_mode: "Markdown",
    reply_markup: adminPanelKeyboard(),
  });
}
function orderSummaryText(o) {
  const lines = [
    `🧾 Order #${o.id}`, "", `👤 ${o.name || "N/A"}`, `📱 ${o.phone || "N/A"}`, `📍 ${o.address || "N/A"}`, "",
    "🧺 Items:", itemsToText(o.items || []), "", `💰 Payment proof: ${o.paymentProof ? "✅" : "❌"}`, `📦 Status: ${o.status}`, "",
  ];
  return lines.join("\n");
}
async function listOrders(chatId) {
  const latest = await listRecentOrders(10);
  if (!latest.length) return tgSendMessage(chatId, "— No orders yet —");
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
async function notifyAdminsNewOrder(order, from) {
  const text = orderSummaryText(order);
  for (const adminId of ADMIN_IDS) {
    const r = await tgSendMessage(adminId, text);
    const j = await r.json().catch(() => null);
    if (j?.ok) adminMessageMap.set(j.result.message_id, { customerChatId: from.id });
    if (order.coords) await tgSendLocation(adminId, order.coords.latitude, order.coords.longitude);
    if (order.paymentProof) {
      await tgSendPhotoByFileId(
        adminId,
        order.paymentProof,
        `💰 Payment screenshot for Order #${order.id}`
      );
    }
  }
}

function getWebAppSecretKey(botToken) {
  // ✅ correct secret per Telegram WebApp spec
  return crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
}
function checkWebAppInitData(initDataRaw) {
  if (!initDataRaw || typeof initDataRaw !== "string") return { ok: false, reason: "missing initData" };
  const url = new URLSearchParams(initDataRaw);
  const hash = url.get("hash");
  if (!hash) return { ok: false, reason: "missing hash" };

  const pairs = [];
  for (const [k, v] of url.entries()) {
    if (k !== "hash") pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = getWebAppSecretKey(BOT_TOKEN);
  const calc      = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (calc !== hash) return { ok: false, reason: "bad hash" };

  const userStr = url.get("user");
  let user = null;
  try { user = userStr ? JSON.parse(userStr) : null; } catch {}
  if (!user?.id) return { ok: false, reason: "no user" };

  return { ok: true, user };
}
function requireAdminWebApp(req, res, next) {
  const headerInit =
    req.get("X-Telegram-Init-Data") ||
    req.get("x-telegram-init-data") ||
    req.headers["x-telegram-init-data"];

  const initData = headerInit || req.body?.initData || req.query?.initData;
  if (!initData) return res.status(401).json({ ok: false, error: "missing initData" });

  const v = checkWebAppInitData(initData);
  if (!v.ok) return res.status(401).json({ ok: false, error: v.reason || "unauthorized" });
  if (!ADMIN_IDS.includes(v.user.id)) return res.status(403).json({ ok: false, error: "forbidden" });

  req.tgAdmin = v.user;
  next();
}

// ───────── DEBUG ROUTES ─────────
app.get("/debug/init", (req, res) => {
  res.json({
    header: req.get("X-Telegram-Init-Data") || req.get("x-telegram-init-data"),
    hasHeader: !!(req.get("X-Telegram-Init-Data") || req.get("x-telegram-init-data")),
    queryInit: req.query?.initData || null
  });
});
app.get("/api/admin/whoami", requireAdminWebApp, (req, res) => {
  res.json({ ok: true, user: req.tgAdmin });
});

// ───────── ADMIN API ─────────
app.get("/api/admin/orders", requireAdminWebApp, async (_req, res) => {
  try {
    const latest = await listRecentOrders(100);
    res.json({
      ok: true,
      orders: latest.map(o => ({
        id: o.id,
        customerChatId: o.customerChatId,
        name: o.name,
        phone: o.phone,
        address: o.address,
        status: o.status,
        statusStage:
          o.statusStage ??
          (o.status === "completed"   ? 2
            : o.status === "out_for_delivery" ? 1
            : o.status === "canceled"    ? -1
            : 0),
        items: o.items,
        createdAt: o.createdAt
      }))
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

app.post("/api/admin/orders/:id/stage", requireAdminWebApp, async (req, res) => {
  const id    = Number(req.params.id);
  const { stage } = req.body || {};
  if (![ -1, 0, 1, 2 ].includes(Number(stage))) {
    return res.status(400).json({ ok: false, error: "invalid_stage" });
  }
  try {
    await updateOrderStage(id, Number(stage));
    const o = await getOrderById(id);
    if (o?.customerChatId) {
      const stageText = (s => s === 1 ? "Out for delivery" : s === 2 ? "Delivered" : s === -1 ? "Canceled" : "Preparing")(Number(stage));
      await tgSendMessage(o.customerChatId, `📦 *Status update*: Your order is now *${stageText}*.`, { parse_mode: "Markdown" });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

app.post("/api/admin/orders/:id/sendlink", requireAdminWebApp, async (req, res) => {
  const id   = Number(req.params.id);
  const { link } = req.body || {};
  if (!link) return res.status(400).json({ ok: false, error: "missing_link" });

  try {
    const o = await getOrderById(id);
    if (!o) return res.status(404).json({ ok: false, error: "not_found" });

    await tgSendMessage(
      o.customerChatId,
      `🛵 Delivery link:\n${link}\n\nTap below once you receive your order.`,
      { reply_markup: { inline_keyboard: [[{ text: "📦 Mark as Received", callback_data: "order:received" }]] } }
    );
    await setDeliveryLink(id, link);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

app.post("/api/admin/shop", requireAdminWebApp, async (req, res) => {
  try {
    const { open } = req.body || {};
    if (typeof open !== "boolean") return res.status(400).json({ ok: false, error: "bad_open_flag" });
    SHOP_OPEN = open;
    res.json({ ok: true, open: SHOP_OPEN });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/admin/orders/:id/messages", requireAdminWebApp, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const msgs = await listMessages(id, 500);
    res.json({ ok: true, messages: msgs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});
app.post("/api/admin/orders/:id/messages", requireAdminWebApp, async (req, res) => {
  const id      = Number(req.params.id);
  const { message } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ ok: false, error: "empty_message" });
  }
  try {
    await createMessage(id, "admin", message.trim());
    const o = await getOrderById(id);
    if (o?.customerChatId) {
      await tgSendMessage(o.customerChatId, `💬 *Admin*: ${message}`, { parse_mode: "Markdown" });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

async function handleCallbackQuery(cbq) {
  const chatId = cbq.message.chat.id;
  const msgId  = cbq.message.message_id;
  const data   = cbq.data;
  const s      = getSession(chatId);

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
  if (data === "contact:admin") return startContactAdmin(chatId);
  if (data === "contact:cancel") {
    s.step = "ordering";
    await tgEditMessageText(chatId, msgId, "📂 Back to Categories", {
      reply_markup: buildCategoryKeyboard(),
    });
    return;
  }

  if (data.startsWith("admin:")) {
    if (!isAdmin(chatId)) { await tgSendMessage(chatId, "⛔ Unauthorized."); return; }
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
        const o  = await getOrderById(id);
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
        adminState.mode           = "await_delivery_link";
        adminState.deliveryOrderId = Number(arg);
        await tgSendMessage(chatId, `✍️ Reply with the delivery/tracking link for Order #${arg}.`);
        break;
      case "done": {
        const id = Number(arg);
        const o  = await getOrderById(id);
        if (!o) return tgSendMessage(chatId, "Order not found.");
        await updateOrderStage(id, 2);
        await tgSendMessage(chatId, `✅ Order #${id} marked completed.`);
        await tgSendMessage(o.customerChatId, "✅ Your order has been marked *Completed*. Thank you!", { parse_mode: "Markdown" });
        break;
      }
      case "cancel": {
        const id = Number(arg);
        const o  = await getOrderById(id);
        if (!o) return tgSendMessage(chatId, "Order not found.");
        await updateOrderStage(id, -1);
        await tgSendMessage(chatId, `❌ Order #${id} canceled.`);
        await tgSendMessage(o.customerChatId, "❌ Your order has been *canceled*. If this is a mistake, please /start again.", { parse_mode: "Markdown" });
        break;
      }
      case "broadcast":
        adminState.mode = "broadcast";
        await tgSendMessage(chatId, "📢 Send the message to broadcast to all recent chats.");
        break;
    }
    return;
  }

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
    s.category = data.slice(4);
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
                  { text: "⚡ Fast-acting",   callback_data: "cat:poppers_fast" },
                  { text: "🌿 Smooth blend", callback_data: "cat:poppers_smooth" },
                ],
                [{ text: "💎 Premium",      callback_data: "cat:poppers_premium" }],
                [{ text: "📂 Categories",   callback_data: "cat:menu" },
                 { text: "🧑‍💼 Contact Admin", callback_data: "contact:admin" }],
              ],
            },
          }
        : { reply_markup: buildAmountKeyboard(s) }
    );
    return;
  }

  if (data.startsWith("amt:")) {
    const amount = data.slice(4);
    ensureCart(s);
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
    await markReceivedByChat(chatId);
    await tgSendMessage(chatId, "✅ Thank you for confirming! We’re glad your order arrived safely. 💙");
    for (const adminId of ADMIN_IDS) {
      await tgSendMessage(adminId, `📦 Customer *${s.name || chatId}* marked the order as *Received*.`, { parse_mode: "Markdown" });
    }
    return;
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const fromId = msg.from?.id;
  const text   = (msg.text || "").trim();
  const s      = getSession(chatId);

  if (isAdmin(chatId) && msg.reply_to_message) {
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

  if (isAdmin(chatId) && adminState.mode === "await_delivery_link") {
    const id = adminState.deliveryOrderId;
    const o  = await getOrderById(id);
    adminState.mode           = null;
    adminState.deliveryOrderId = null;
    if (!o) return tgSendMessage(chatId, "⚠️ Order not found.");
    await tgSendMessage(
      o.customerChatId,
      `🛵 Delivery link:\n${text}\n\nTap below once you receive your order.`,
      { reply_markup: { inline_keyboard: [[{ text: "📦 Mark as Received", callback_data: "order:received" }]] } }
    );
    await tgSendMessage(chatId, `✅ Delivery link sent to customer for Order #${id}.`);
    await updateOrderStage(id, 1);
    return;
  }

  if (isAdmin(chatId) && adminState.mode === "broadcast") {
    adminState.mode = null;
    let count = 0;
    for (const [cid] of sessions) {
      if (isAdmin(cid)) continue;
      try { await tgSendMessage(cid, `📢 *Admin Broadcast:*\n${text}`, { parse_mode: "Markdown" }); count++; }
      catch {}
    }
    await tgSendMessage(chatId, `✅ Broadcast sent to ${count} chats.`);
    return;
  }

  if (text === "/admin")      { if (!isAdmin(fromId)) return tgSendMessage(chatId, "⛔ For admin only."); await openAdminCenter(chatId); return; }
  if (text === "/open")       { if (!isAdmin(fromId)) return; SHOP_OPEN = true;  return tgSendMessage(chatId, "🟢 Shop is now OPEN."); }
  if (text === "/close")      { if (!isAdmin(fromId)) return; SHOP_OPEN = false; return tgSendMessage(chatId, "🔴 Shop is now CLOSED."); }
  if (text === "/orders")     { if (!isAdmin(fromId)) return; await listOrders(chatId); return; }
  if (text === "/broadcast")  { if (!isAdmin(fromId)) return; adminState.mode = "broadcast"; return tgSendMessage(chatId, "📢 Send the message to broadcast to all recent chats."); }

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
  if (text === "/status") {
    try {
      const latest = await listRecentOrders(200);
      const lastOrder = latest.find(o => o.customerChatId === chatId);
      if (!lastOrder) return tgSendMessage(chatId, "📦 No orders found yet.");
      return tgSendMessage(
        chatId,
        `📦 Latest order:\n• ID: #${lastOrder.id}\n• Status: ${lastOrder.status}\n• Items:\n${itemsToText(lastOrder.items || [])}`
      );
    } catch {
      return tgSendMessage(chatId, "⚠️ Unable to fetch your orders right now.");
    }
  }

  if (!isAdmin(chatId) && text && !text.startsWith("/")) {
    try {
      const o = await latestActiveOrderByChatId(chatId);
      if (o) {
        await createMessage(o.id, "customer", text);
        for (const adminId of ADMIN_IDS) {
          await tgSendMessage(
            adminId,
            `💬 New message on *Order #${o.id}* from ${s.name || chatId}:\n${text}`,
            { parse_mode: "Markdown" }
          );
        }
        return;
      }
    } catch (e) {
      console.error("chat capture failed:", e);
    }
  }

  await tgSendMessage(chatId, "Please use /start to begin ordering.");
}

async function handleContact(msg) {
  const chatId = msg.chat.id;
  if (!SHOP_OPEN) return tgSendMessage(chatId, "🏪 The shop is closed.");
  const s = getSession(chatId);
  if (s.step !== "request_phone") return;
  s.phone = msg.contact.phone_number;
  s.step  = "request_location";
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
  if (!SHOP_OPEN) return tgSendMessage(chatId, "🏪 The shop is closed.");
  const s = getSession(chatId);
  if (s.step !== "request_location") return;

  const { latitude, longitude } = msg.location;
  s.coords = { latitude, longitude };
  s.address = await reverseGeocode(latitude, longitude);
  s.step    = "confirm";

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
async function handlePhotoOrDocument(msg) {
  const chatId = msg.chat.id;
  if (!SHOP_OPEN) return tgSendMessage(chatId, "🏪 The shop is closed.");
  const s = getSession(chatId);
  if (s.step !== "await_payment_proof") return;

  s.paymentProof = msg.photo ? msg.photo.pop().file_id : msg.document?.file_id;

  const newId = await createOrder({
    customerChatId: chatId,
    name: s.name,
    phone: s.phone,
    address: s.address,
    coords: s.coords,
    items: [...(s.cart || [])],
    paymentProof: s.paymentProof || null,
  });

  const order = {
    id: newId,
    customerChatId: chatId,
    name: s.name,
    phone: s.phone,
    address: s.address,
    coords: s.coords,
    items: [...(s.cart || [])],
    paymentProof: s.paymentProof || null,
    status: "paid",
    statusStage: 0,
    createdAt: new Date().toISOString(),
  };
  await notifyAdminsNewOrder(order, msg.from);

  s.status = "complete";
  await tgSendMessage(
    chatId,
    "✅ Thank you! Payment screenshot received.\n🛵 Your delivery link will be sent shortly.\nPlease keep this chat open.",
    { reply_markup: { inline_keyboard: [[{ text: "🧑‍💼 Contact Admin", callback_data: "contact:admin" }]] } }
  );
}

const pathWebhook = `/telegraf/${BOT_TOKEN}`;
app.post(pathWebhook, async (req, res) => {
  const u = req.body;
  try {
    if (u.message) {
      const m = u.message;
      if (m.contact)       await handleContact(m);
      else if (m.location) await handleLocation(m);
      else if (m.photo || m.document) await handlePhotoOrDocument(m);
      else                  await handleMessage(m);
    } else if (u.callback_query) {
      await handleCallbackQuery(u.callback_query);
    }
  } catch (e) {
    console.error("❌ Update error:", e);
  }
  res.sendStatus(200);
});

app.get("/health", async (_req, r) => {
  r.json({ ok: true, shop_open: SHOP_OPEN, active_sessions: sessions.size });
});

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  try { await dbInit(); console.log("✅ DB ready"); }
  catch (e) { console.error("❌ DB init failed:", e); }

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
        ],
        scope: { type: "all_private_chats" },
      }),
    });
    console.log("✅ Public menu commands registered.");
  } catch (e) {
    console.error("❌ Failed to set public menu commands:", e);
  }

  for (const adminId of ADMIN_IDS) {
    try {
      await fetchFn(`${TELEGRAM_API}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commands: [
            { command: "admin",     description: "Open Admin Center" },
            { command: "open",      description: "Open shop" },
            { command: "close",     description: "Close shop" },
            { command: "orders",    description: "List recent orders" },
            { command: "broadcast", description: "Broadcast a message" },
          ],
          scope: { type: "chat", chat_id: adminId },
        }),
      });
    } catch (e) {
      console.error(`❌ Failed to set admin menu for ${adminId}:`, e);
    }
  }
});

// index.js
import express from "express";
import fetchPkg from "node-fetch";

const fetchFn = typeof fetch !== "undefined" ? fetch : fetchPkg;

// ───────── CONFIG ─────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = Number(process.env.ADMIN_CHAT_ID || 0);
const HOST_URL = process.env.HOST_URL; // e.g. https://your-app.onrender.com
const PORT = process.env.PORT || 3000;

const ADMIN_IDS = process.env.ADMIN_IDS
  ? process.env.ADMIN_IDS.split(",").map((id) => Number(id.trim()))
  : [];

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required");
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const BOT_COMMANDS = [
  { command: "start", description: "Start new order" },
  { command: "restart", description: "Restart order" },
  { command: "help", description: "Help" },
  { command: "faq", description: "FAQ" },
  { command: "admin", description: "Admin control" },
];

// ───────── MEMORY STATE ─────────
const sessions = new Map();          // chatId -> session
const adminMessageMap = new Map();   // adminMsgId -> { customerChatId, orderId }
const loggedInAdmins = new Set();    // chatIds currently logged in as admin
const orders = [];                   // memory-only order list
let orderCounter = 1;
let SHOP_OPEN = true;                // admin can toggle

// ───────── EXPRESS APP ─────────
const app = express();
app.use(express.json());

// serve /public as /static - THIS is where qrph.jpg lives
app.use("/static", express.static("public"));

// ───────── HELPERS ─────────
function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, {});
  return sessions.get(chatId);
}

function ensureCart(session) {
  if (!session.cart) session.cart = [];
}

async function tgSendMessage(chatId, text, extra = {}) {
  return fetchFn(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...extra,
    }),
  });
}

async function tgEditMessageText(chatId, messageId, text, extra = {}) {
  return fetchFn(`${TELEGRAM_API}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      ...extra,
    }),
  });
}

async function tgSendLocation(chatId, lat, lon) {
  return fetchFn(`${TELEGRAM_API}/sendLocation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      latitude: lat,
      longitude: lon,
    }),
  });
}

function buildAmountKeyboard(session) {
  const cat = session.category;
  const baseActions = [
    [{ text: "🛒 Add to cart", callback_data: "cart:add" }],
    [{ text: "🧾 View cart", callback_data: "cart:view" }],
    [{ text: "✅ Checkout", callback_data: "cart:checkout" }],
  ];

  if (cat === "sachet") {
    return {
      inline_keyboard: [
        [
          { text: "₱500", callback_data: "amt:₱500" },
          { text: "₱700", callback_data: "amt:₱700" },
        ],
        [
          { text: "₱1,000", callback_data: "amt:₱1,000" },
          { text: "Half G", callback_data: "amt:2,000" },
        ],
        [{ text: "1G", callback_data: "amt:3,800" }],
        ...baseActions,
      ],
    };
  }

  if (cat === "syringe") {
    return {
      inline_keyboard: [
        [
          { text: "₱500", callback_data: "amt:₱500" },
          { text: "₱700", callback_data: "amt:₱700" },
        ],
        [{ text: "₱1,000", callback_data: "amt:₁,000" }], // note: we’ll fix this to plain text below
        ...baseActions,
      ],
    };
  }

  // default: choose category
  return {
    inline_keyboard: [
      [
        { text: "💧 Sachet", callback_data: "cat:sachet" },
        { text: "💉 Syringe", callback_data: "cat:syringe" },
      ],
    ],
  };
}

// tiny fix: that above line has a weird ₁,000 – let's correct the function:
function buildAmountKeyboardFixed(session) {
  const cat = session.category;
  const baseActions = [
    [{ text: "🛒 Add to cart", callback_data: "cart:add" }],
    [{ text: "🧾 View cart", callback_data: "cart:view" }],
    [{ text: "✅ Checkout", callback_data: "cart:checkout" }],
  ];
  if (cat === "sachet") {
    return {
      inline_keyboard: [
        [
          { text: "₱500", callback_data: "amt:₱500" },
          { text: "₱700", callback_data: "amt:₱700" },
        ],
        [
          { text: "₱1,000", callback_data: "amt:₱1,000" },
          { text: "Half G", callback_data: "amt:2,000" },
        ],
        [{ text: "1G", callback_data: "amt:3,800" }],
        ...baseActions,
      ],
    };
  }
  if (cat === "syringe") {
    return {
      inline_keyboard: [
        [
          { text: "₱500", callback_data: "amt:₱500" },
          { text: "₱700", callback_data: "amt:₱700" },
        ],
        [{ text: "₱1,000", callback_data: "amt:₱1,000" }],
        ...baseActions,
      ],
    };
  }
  return {
    inline_keyboard: [
      [
        { text: "💧 Sachet", callback_data: "cat:sachet" },
        { text: "💉 Syringe", callback_data: "cat:syringe" },
      ],
    ],
  };
}

async function reverseGeocode(lat, lon) {
  try {
    const res = await fetchFn(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
      { headers: { "User-Agent": "IceOrderBot/1.0" } }
    );
    const data = await res.json();
    return data.display_name || `${lat}, ${lon}`;
  } catch (err) {
    console.error("Geocoding error", err);
    return `${lat}, ${lon}`;
  }
}

async function sendOrderToAdmin(session, from) {
  const ts = new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" });
  const itemsText = session.cart?.length
    ? session.cart.map((it) => `${it.category} — ${it.amount}`).join("\n")
    : `${session.category || "N/A"} — ${session.selectedAmount || "N/A"}`;
  const coordsText = session.coords
    ? `${session.coords.latitude}, ${session.coords.longitude}`
    : "N/A";

  const orderId = orderCounter++;

  orders.unshift({
    id: orderId,
    customerChatId: from.id,
    name: session.name,
    phone: session.phone,
    address: session.address,
    coords: session.coords,
    items: session.cart || [],
    createdAt: ts,
  });
  if (orders.length > 100) orders.pop();

  const adminText =
    `🧊 NEW ORDER (#${orderId})\n\n` +
    `🧺 Items:\n${itemsText}\n\n` +
    `👤 ${session.name}\n` +
    `📱 ${session.phone}\n` +
    `📍 ${session.address}\n` +
    `🗺️ ${coordsText}\n\n` +
    `💰 Payment proof: ${session.paymentProof ? "✅ Received" : "❌ None"}\n` +
    `⏰ ${ts}`;

  const r = await tgSendMessage(ADMIN_CHAT_ID, adminText);
  const jr = await r.json().catch(() => null);
  if (jr?.ok) {
    adminMessageMap.set(jr.result.message_id, {
      customerChatId: from.id,
      orderId,
    });
  }

  if (session.coords) {
    await tgSendLocation(
      ADMIN_CHAT_ID,
      session.coords.latitude,
      session.coords.longitude
    );
  }

  if (session.paymentProof) {
    await fetchFn(`${TELEGRAM_API}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        photo: session.paymentProof,
        caption: `💰 GCash screenshot for order #${orderId}`,
      }),
    });
  }
}

// ───────── HANDLERS ─────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const session = getSession(chatId);

  // if shop is closed, block non-admin
  if (!SHOP_OPEN && !ADMIN_IDS.includes(chatId)) {
    await tgSendMessage(
      chatId,
      "🏪 The shop is currently closed.\nPlease check back later."
    );
    return;
  }

  // admin reply-to message (swipe to reply in Telegram)
  if (chatId === ADMIN_CHAT_ID && msg.reply_to_message) {
    const info = adminMessageMap.get(msg.reply_to_message.message_id);
    if (!info) {
      await tgSendMessage(chatId, "⚠️ I can't find the customer for this reply.");
      return;
    }
    await tgSendMessage(
      info.customerChatId,
      `🚚 Update for your order #${info.orderId}:\n${text}`
    );
    await tgSendMessage(chatId, "✅ Update sent to customer.");
    return;
  }

  // commands
  if (text === "/start" || text === "/restart") {
    sessions.set(chatId, { step: "choose_category", cart: [] });
    await tgSendMessage(chatId, "🧊 IceOrderBot\nChoose product type 👇", {
      reply_markup: buildAmountKeyboardFixed({}),
    });
    return;
  }

  if (text === "/help") {
    await tgSendMessage(
      chatId,
      "🆘 How to use:\n1) /start\n2) choose product\n3) checkout\n4) pay via QR\n5) upload payment."
    );
    return;
  }

  if (text === "/faq") {
    await tgSendMessage(
      chatId,
      "❓ FAQ:\n• You can /restart anytime.\n• Admin confirms orders manually.\n• Location is only sent to admin."
    );
    return;
  }

  if (text === "/admin") {
    if (!ADMIN_IDS.includes(chatId)) {
      await tgSendMessage(chatId, "🚫 Access denied.");
      return;
    }
    loggedInAdmins.add(chatId);
    await tgSendMessage(chatId, "🧠 Admin Control Panel", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🧾 View Orders", callback_data: "admin:view_orders" }],
          [{ text: "📢 Broadcast", callback_data: "admin:broadcast" }],
          [{ text: "📊 Analytics", callback_data: "admin:analytics" }],
          [
            {
              text: SHOP_OPEN ? "🔴 Close Shop" : "🟢 Open Shop",
              callback_data: "admin:toggle_shop",
            },
          ],
          [{ text: "🔐 Logout", callback_data: "admin:logout" }],
        ],
      },
    });
    return;
  }

  // admin broadcast text step
  if (loggedInAdmins.has(chatId) && session.step === "await_broadcast") {
    const allUsers = Array.from(sessions.keys()).filter(
      (id) => id !== ADMIN_CHAT_ID
    );
    for (const u of allUsers) {
      await tgSendMessage(u, `📢 Announcement:\n${text}`);
    }
    session.step = null;
    await tgSendMessage(
      chatId,
      `✅ Broadcast sent to ${allUsers.length} users.`
    );
    return;
  }

  // user typed name
  if (session.step === "ask_name") {
    session.name = text.trim();
    session.step = "request_phone";
    await tgSendMessage(chatId, "📱 Please share your phone number:", {
      reply_markup: {
        keyboard: [[{ text: "📱 Share Phone", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
    return;
  }

  // if user types during await_payment_proof
  if (session.step === "await_payment_proof") {
    await tgSendMessage(
      chatId,
      "📸 Please upload your GCash / QRPh payment screenshot."
    );
    return;
  }

  // fallback
  await tgSendMessage(chatId, "Please /start to begin.");
}

async function handleContact(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (session.step !== "request_phone") return;
  session.phone = msg.contact.phone_number;
  session.step = "request_location";
  await tgSendMessage(chatId, "📍 Send your delivery location:", {
    reply_markup: {
      keyboard: [[{ text: "📍 Share Location", request_location: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

async function handleLocation(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (session.step !== "request_location") return;

  const { latitude, longitude } = msg.location;
  session.coords = { latitude, longitude };
  session.address = await reverseGeocode(latitude, longitude);
  session.step = "confirm";

  const itemsText = session.cart?.length
    ? session.cart.map((it, i) => `${i + 1}. ${it.category} — ${it.amount}`).join("\n")
    : `${session.category || "N/A"} — ${session.selectedAmount || "N/A"}`;

  const summary =
    `📋 *Order Summary*\n\n` +
    `🧺 Items:\n${itemsText}\n\n` +
    `👤 ${session.name}\n` +
    `📱 ${session.phone}\n` +
    `📍 ${session.address}\n\n` +
    `💰 *Payment Instructions:*\n` +
    `Scan the QR (above) to pay via QRPh / GCash.\n` +
    `After payment, tap *Payment Processed* and upload your proof.`;

  // 1) send QR from /public/qrph.jpg
  if (HOST_URL) {
    const qrUrl = `${HOST_URL}/static/qrph.jpg`;
    await fetchFn(`${TELEGRAM_API}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: qrUrl,
        caption: "💰 Scan to pay (QRPh / GCash).",
      }),
    });
  }

  // 2) then send the summary with buttons
  await tgSendMessage(chatId, summary, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💰 Payment Processed", callback_data: "order:confirm" }],
        [{ text: "❌ Cancel", callback_data: "order:cancel" }],
      ],
    },
  });

  // remove reply keyboard
  await tgSendMessage(chatId, " ", {
    reply_markup: { remove_keyboard: true },
  });
}

async function handlePhotoOrDocument(msg) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  if (session.step !== "await_payment_proof") return;

  const fileId = msg.photo
    ? msg.photo[msg.photo.length - 1].file_id
    : msg.document?.file_id;

  if (!fileId) {
    await tgSendMessage(chatId, "⚠️ Please upload an image or PDF.");
    return;
  }

  session.paymentProof = fileId;
  await sendOrderToAdmin(session, msg.from);
  sessions.set(chatId, {});
  await tgSendMessage(
    chatId,
    "✅ Thank you! Payment screenshot received. Your order is being processed."
  );
}

async function handleCallbackQuery(cbq) {
  const data = cbq.data;
  const chatId = cbq.message.chat.id;
  const msgId = cbq.message.message_id;
  const session = getSession(chatId);

  // shop closed for customers
  if (!SHOP_OPEN && !ADMIN_IDS.includes(chatId)) {
    await tgSendMessage(chatId, "🏪 Shop is closed. Please check back later.");
    return;
  }

  // ADMIN actions
  if (data.startsWith("admin:")) {
    if (!ADMIN_IDS.includes(chatId) || !loggedInAdmins.has(chatId)) {
      await tgSendMessage(chatId, "🚫 Unauthorized.");
      return;
    }

    const action = data.split(":")[1];

    if (action === "toggle_shop") {
      SHOP_OPEN = !SHOP_OPEN;
      await tgSendMessage(
        chatId,
        SHOP_OPEN ? "🟢 Shop is now OPEN." : "🔴 Shop is now CLOSED."
      );
      return;
    }

    if (action === "view_orders") {
      if (!orders.length) {
        await tgSendMessage(chatId, "🧾 No orders yet.");
        return;
      }
      const list = orders
        .slice(0, 10)
        .map(
          (o) =>
            `#${o.id} ${o.name} — ${o.items
              .map((i) => i.amount)
              .join(", ")} (${o.createdAt})`
        )
        .join("\n");
      await tgSendMessage(chatId, `🧾 Recent Orders:\n${list}`);
      return;
    }

    if (action === "broadcast") {
      session.step = "await_broadcast";
      await tgSendMessage(chatId, "📢 Send the message to broadcast to all users.");
      return;
    }

    if (action === "analytics") {
      const total = orders.length;
      const counts = {};
      for (const o of orders) {
        for (const it of o.items) {
          counts[it.category] = (counts[it.category] || 0) + 1;
        }
      }
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      await tgSendMessage(
        chatId,
        `📊 Total orders: ${total}\nTop item: ${
          top ? `${top[0]} (${top[1]})` : "N/A"
        }`
      );
      return;
    }

    if (action === "logout") {
      loggedInAdmins.delete(chatId);
      await tgSendMessage(chatId, "🔐 Logged out.");
      return;
    }
  }

  // CUSTOMER actions
  if (data.startsWith("cat:")) {
    session.category = data.slice(4);
    session.step = "choose_amount";
    ensureCart(session);
    await tgEditMessageText(
      chatId,
      msgId,
      `🧊 ${session.category} selected.\nPick amount or use cart 👇`,
      {
        reply_markup: buildAmountKeyboardFixed(session),
      }
    );
    return;
  }

  if (data.startsWith("amt:")) {
    session.selectedAmount = data.slice(4);
    await tgEditMessageText(
      chatId,
      msgId,
      `💸 Selected ${session.selectedAmount}`,
      {
        reply_markup: buildAmountKeyboardFixed(session),
      }
    );
    return;
  }

  if (data === "cart:add") {
    const s = getSession(chatId);
    ensureCart(s);
    if (!s.category || !s.selectedAmount) {
      await tgSendMessage(chatId, "⚠️ Please select category and amount first.");
      return;
    }
    s.cart.push({
      category: s.category,
      amount: s.selectedAmount,
      addedAt: Date.now(),
    });
    await tgSendMessage(
      chatId,
      `🛒 Added: ${s.category} — ${s.selectedAmount}`
    );
    await tgSendMessage(chatId, "You can add more or checkout 👇", {
      reply_markup: buildAmountKeyboardFixed(s),
    });
    return;
  }

  if (data === "cart:view") {
    ensureCart(session);
    const txt = session.cart.length
      ? session.cart
          .map((x, i) => `${i + 1}. ${x.category} — ${x.amount}`)
          .join("\n")
      : "🧺 Cart is empty.";
    await tgSendMessage(chatId, txt);
    return;
  }

  if (data === "cart:checkout") {
    ensureCart(session);
    if (!session.cart.length && session.category && session.selectedAmount) {
      session.cart.push({
        category: session.category,
        amount: session.selectedAmount,
      });
    }
    if (!session.cart.length) {
      await tgSendMessage(chatId, "🧺 Cart is empty.");
      return;
    }
    session.step = "ask_name";
    await tgSendMessage(chatId, "📝 Enter your name:");
    return;
  }

  if (data === "order:confirm") {
    session.step = "await_payment_proof";
    await tgSendMessage(
      chatId,
      "📸 Please upload a screenshot/photo of your payment."
    );
    return;
  }

  if (data === "order:cancel") {
    sessions.set(chatId, {});
    await tgEditMessageText(chatId, msgId, "❌ Order canceled.");
    return;
  }
}

// ───────── TELEGRAM WEBHOOK ROUTE ─────────
const secretPath = `/telegraf/${BOT_TOKEN}`;

app.post(secretPath, async (req, res) => {
  const update = req.body;
  try {
    if (update.message) {
      const m = update.message;
      if (m.contact) {
        await handleContact(m);
      } else if (m.location) {
        await handleLocation(m);
      } else if (m.photo || m.document) {
        await handlePhotoOrDocument(m);
      } else {
        await handleMessage(m);
      }
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  } catch (err) {
    console.error("Update error:", err);
  }
  res.sendStatus(200);
});

// health + ping
app.get("/", (req, res) => {
  res.send("IceOrderBot is running (webhook mode).");
});
app.get("/ping", (req, res) => {
  res.send("pong");
});
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    shop_open: SHOP_OPEN,
    total_orders: orders.length,
    uptime: process.uptime(),
  });
});

// ───────── START SERVER ─────────
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // set Telegram /menu commands
  try {
    await fetchFn(`${TELEGRAM_API}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
  } catch (err) {
    console.error("setMyCommands error:", err);
  }

  if (HOST_URL) {
    const webhookUrl = `${HOST_URL}${secretPath}`;
    try {
      await fetchFn(`${TELEGRAM_API}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: webhookUrl }),
      });
      console.log("✅ Webhook set to:", webhookUrl);
    } catch (err) {
      console.error("Failed to set webhook:", err);
    }
  } else {
    console.warn("⚠️ HOST_URL is not set — set webhook manually in BotFather.");
  }
});

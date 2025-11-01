// index.js
import express from 'express';
import { Telegraf, Markup, session } from 'telegraf';
import fetchPkg from 'node-fetch';

const fetchFn = (typeof fetch !== 'undefined') ? fetch : fetchPkg;

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : NaN;
const HOST_URL = process.env.HOST_URL; // e.g. https://your-app.onrender.com
const PORT = process.env.PORT || 3000;

// basic checks
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required');
}
if (!HOST_URL) {
  console.warn('⚠️ HOST_URL is not set. Webhook URL will not be set automatically.');
}

const bot = new Telegraf(BOT_TOKEN);

// your amounts
const AMOUNTS = ['₱500', '₱700', '₱1,000', 'Half G', '1G'];

// inline keyboard builders
function amountInlineKeyboard() {
  return Markup.inlineKeyboard(
    AMOUNTS.map(a => [Markup.button.callback(a, `amt:${a}`)])
  );
}
function nameInlineKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('👤 Use my Telegram name', 'name:auto')],
    [Markup.button.callback('⌨️ I will type my name', 'name:manual')]
  ]);
}
function confirmInlineKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Confirm', 'order:confirm'),
      Markup.button.callback('❌ Cancel', 'order:cancel'),
    ]
  ]);
}
function restartInlineKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔁 Start new order', 'order:restart')]
  ]);
}

bot.use(session());

// /start
bot.start(async (ctx) => {
  if (ctx.chat && ctx.chat.type !== 'private') {
    return ctx.reply('Please DM me to order 🙂');
  }

  ctx.session = { step: 'choose_amount' };

  return ctx.reply(
    '🧊 Welcome to IceOrderBot!\n\nPlease select an amount:',
    amountInlineKeyboard()
  );
});

// callback_query (inline)
bot.on('callback_query', async (ctx) => {
  try {
    ctx.session = ctx.session || {};
    const data = ctx.callbackQuery.data || '';

    // amount chosen
    if (data.startsWith('amt:')) {
      const amount = data.slice(4);
      ctx.session.amount = amount;
      ctx.session.step = 'ask_name';

      await ctx.editMessageText(
        `Amount selected: ${amount}\n\nHow should I get your name?`,
        nameInlineKeyboard()
      );
      return ctx.answerCbQuery();
    }

    // name from telegram
    if (data === 'name:auto')) {
      const from = ctx.from || {};
      const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim()
        || from.username
        || 'Customer';

      ctx.session.name = fullName;
      ctx.session.step = 'request_phone';

      await ctx.editMessageText(`Name: ${fullName}\n\nNow please share your phone number:`);
      await ctx.reply(
        'Tap the button to share your phone:',
        Markup.keyboard([
          Markup.button.contactRequest('📱 Share Phone Number')
        ])
          .oneTime()
          .resize()
      );
      return ctx.answerCbQuery('Name set ✅');
    }

    // name manual
    if (data === 'name:manual') {
      ctx.session.step = 'wait_name_text';
      await ctx.editMessageText('Okay, please type your name 👇');
      return ctx.answerCbQuery('Type your name');
    }

    // confirm
    if (data === 'order:confirm') {
      await sendOrderToAdmin(ctx);
      ctx.session = {};
      await ctx.editMessageText(
        '✅ Thank you! Your order was sent to the admin.',
        restartInlineKeyboard()
      );
      return ctx.answerCbQuery('Order sent ✅');
    }

    // cancel
    if (data === 'order:cancel') {
      ctx.session = {};
      await ctx.editMessageText(
        '❌ Order canceled. You can start again anytime.',
        restartInlineKeyboard()
      );
      return ctx.answerCbQuery('Canceled');
    }

    // restart
    if (data === 'order:restart') {
      ctx.session = { step: 'choose_amount' };
      await ctx.editMessageText(
        '🧊 New order — please select an amount:',
        amountInlineKeyboard()
      );
      return ctx.answerCbQuery();
    }

  } catch (err) {
    console.error('callback_query error:', err);
    try { await ctx.answerCbQuery('Error, try again'); } catch {}
  }
});

// text (for manual name etc.)
bot.on('text', async (ctx) => {
  ctx.session = ctx.session || {};
  const step = ctx.session.step;
  const text = ctx.message.text;

  if (step === 'wait_name_text') {
    ctx.session.name = text.trim();
    ctx.session.step = 'request_phone';

    await ctx.reply(`Thanks, ${ctx.session.name}! Now please share your phone:`);
    await ctx.reply(
      'Tap the button to share your phone:',
      Markup.keyboard([
        Markup.button.contactRequest('📱 Share Phone Number')
      ])
        .oneTime()
        .resize()
    );
    return;
  }

  if (step === 'confirm') {
    return ctx.reply('Please tap the buttons (✅ / ❌) above to finish.');
  }

  if (!step || step === 'choose_amount') {
    return ctx.reply('Please pick an amount:', amountInlineKeyboard());
  }

  return ctx.reply('Please follow the steps or /start to begin again.');
});

// contact
bot.on('contact', async (ctx) => {
  ctx.session = ctx.session || {};
  if (ctx.session.step !== 'request_phone') return;

  const contact = ctx.message.contact;
  if (!contact || !contact.phone_number) {
    return ctx.reply('No phone number received. Please try again.');
  }

  ctx.session.phone = contact.phone_number;
  ctx.session.step = 'request_location';

  await ctx.reply(
    'Great 👍 Now share your delivery location:',
    Markup.keyboard([
      Markup.button.locationRequest('📍 Share Location')
    ])
      .oneTime()
      .resize()
  );
});

// location
bot.on('location', async (ctx) => {
  ctx.session = ctx.session || {};
  if (ctx.session.step !== 'request_location') return;

  const loc = ctx.message.location;
  if (!loc) {
    return ctx.reply('Location not received, please try again.');
  }

  const { latitude, longitude } = loc;
  ctx.session.coords = { latitude, longitude };

  const address = await reverseGeocode(latitude, longitude);
  ctx.session.address = address;
  ctx.session.step = 'confirm';

  const summary = `
📋 Order Summary:

💰 Amount: ${ctx.session.amount || 'N/A'}
👤 Name: ${ctx.session.name || 'N/A'}
📱 Phone: ${ctx.session.phone || 'N/A'}
📍 Address: ${address}
🗺️ Coordinates: ${latitude}, ${longitude}
  `.trim();

  await ctx.reply(summary, confirmInlineKeyboard());
  await ctx.reply('Please confirm above 👆', Markup.removeKeyboard());
});

// helpers
async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;
    const res = await fetchFn(url, {
      headers: { 'User-Agent': 'IceOrderBot/1.0 (mailto:you@example.com)' }
    });
    if (!res.ok) return `${lat}, ${lon}`;
    const data = await res.json();
    return data.display_name || `${lat}, ${lon}`;
  } catch (err) {
    console.error('Geocoding error:', err);
    return `${lat}, ${lon}`;
  }
}

async function sendOrderToAdmin(ctx) {
  if (!ADMIN_CHAT_ID || Number.isNaN(ADMIN_CHAT_ID)) {
    console.error('ADMIN_CHAT_ID not configured, cannot send to admin.');
    return;
  }

  const s = ctx.session || {};
  const user = ctx.from || {};
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' });

  const coordsText = s.coords
    ? `${s.coords.latitude}, ${s.coords.longitude}`
    : 'N/A';

  const msg = `
🧊 NEW ORDER

💰 Amount: ${s.amount || 'N/A'}
👤 Name: ${s.name || 'N/A'}
📱 Phone: ${s.phone || 'N/A'}
📍 Address: ${s.address || 'N/A'}
🗺️ Coords: ${coordsText}

👤 Telegram:
- ID: ${user.id || 'N/A'}
- Username: ${user.username ? '@' + user.username : 'N/A'}
- Name: ${[user.first_name, user.last_name].filter(Boolean).join(' ')}

⏰ ${timestamp}
  `.trim();

  await ctx.telegram.sendMessage(ADMIN_CHAT_ID, msg);

  if (s.coords) {
    await ctx.telegram.sendLocation(
      ADMIN_CHAT_ID,
      s.coords.latitude,
      s.coords.longitude
    );
  }
}

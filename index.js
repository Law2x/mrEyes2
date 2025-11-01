import { Telegraf, Markup, session } from 'telegraf';
import fetchPkg from 'node-fetch';

const fetchFn = (typeof fetch !== 'undefined') ? fetch : fetchPkg;

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : NaN;

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required');
}

const bot = new Telegraf(BOT_TOKEN);

// your original amounts
const AMOUNTS = ['₱500', '₱700', '₱1,000', 'Half G', '1G'];

// helpers to build inline keyboards
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
      Markup.button.callback('❌ Cancel', 'order:cancel')
    ]
  ]);
}

function restartInlineKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔁 Start new order', 'order:restart')]
  ]);
}

bot.use(session());

// /start handler
bot.start(async (ctx) => {
  // we recommend private chat
  if (ctx.chat && ctx.chat.type !== 'private') {
    return ctx.reply('Please start a private chat with me to order 🙂');
  }

  ctx.session = {
    step: 'choose_amount'
  };

  return ctx.reply(
    '🧊 Welcome to IceOrderBot!\n\nPlease select an amount:',
    amountInlineKeyboard()
  );
});

// handle inline button presses
bot.on('callback_query', async (ctx) => {
  try {
    ctx.session = ctx.session || {};
    const data = ctx.callbackQuery.data || '';

    // 1) amount selected
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

    // 2) name choice
    if (data === 'name:auto') {
      const from = ctx.from || {};
      const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || from.username || 'Customer';
      ctx.session.name = fullName;
      ctx.session.step = 'request_phone';

      await ctx.editMessageText(
        `Name: ${fullName}\n\nNow please share your phone number:`
      );

      // show reply keyboard for contact
      await ctx.reply(
        'Tap the button to share your phone:',
        Markup.keyboard([
          Markup.button.contactRequest('📱 Share Phone Number')
        ])
          .oneTime()
          .resize()
      );

      return ctx.answerCbQuery('Name set from Telegram ✅');
    }

    if (data === 'name:manual') {
      ctx.session.step = 'wait_name_text';
      await ctx.editMessageText(
        'Okay, please type your name 👇'
      );
      return ctx.answerCbQuery('Type your name');
    }

    // 3) confirm order
    if (data === 'order:confirm') {
      await sendOrderToAdmin(ctx);
      ctx.session = {}; // clear
      await ctx.editMessageText(
        '✅ Thank you! Your order was sent to the admin.',
        restartInlineKeyboard()
      );
      return ctx.answerCbQuery('Sent to admin ✅');
    }

    // 4) cancel order
    if (data === 'order:cancel') {
      ctx.session = {};
      await ctx.editMessageText(
        '❌ Order canceled. You can start again anytime.',
        restartInlineKeyboard()
      );
      return ctx.answerCbQuery('Canceled');
    }

    // 5) restart
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
    try {
      await ctx.answerCbQuery('Error, please try again.');
    } catch (_) {}
  }
});

// handle text messages (for manual name)
bot.on('text', async (ctx) => {
  ctx.session = ctx.session || {};
  const step = ctx.session.step;
  const text = ctx.message.text;

  // user is typing their name
  if (step === 'wait_name_text') {
    ctx.session.name = text.trim();
    ctx.session.step = 'request_phone';

    await ctx.reply(`Thanks, ${ctx.session.name}! Now please share your phone number:`);
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

  // if we're in confirm step but user typed something random
  if (step === 'confirm') {
    // we prefer inline here, so just remind
    return ctx.reply('Please tap ✅ Confirm or ❌ Cancel on the buttons above.');
  }

  // fallback
  if (!step || step === 'choose_amount') {
    return ctx.reply(
      'Please pick an amount:',
      amountInlineKeyboard()
    );
  }

  return ctx.reply('Please follow the steps or /start to begin again.');
});

// handle contact (reply keyboard)
bot.on('contact', async (ctx) => {
  ctx.session = ctx.session || {};
  if (ctx.session.step !== 'request_phone') {
    return;
  }

  const contact = ctx.message.contact;
  if (!contact || !contact.phone_number) {
    return ctx.reply('No phone number received, please try again.');
  }

  ctx.session.phone = contact.phone_number;
  ctx.session.step = 'request_location';

  // ask for location (must be reply keyboard again)
  await ctx.reply(
    'Great 👍 Now share your delivery location:',
    Markup.keyboard([
      Markup.button.locationRequest('📍 Share Location')
    ])
      .oneTime()
      .resize()
  );
});

// handle location (reply keyboard)
bot.on('location', async (ctx) => {
  ctx.session = ctx.session || {};
  if (ctx.session.step !== 'request_location') return;

  const loc = ctx.message.location;
  if (!loc) return ctx.reply('Location not received. Please try again.');

  const { latitude, longitude } = loc;
  ctx.session.coords = { latitude, longitude };

  // reverse geocode
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

  // show inline Confirm/Cancel
  await ctx.reply(
    summary,
    confirmInlineKeyboard()
  );

  // remove reply keyboard now
  await ctx.reply('Please confirm your order above 👆', Markup.removeKeyboard());
});

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
    console.error('ADMIN_CHAT_ID is not configured.');
    return;
  }
  const s = ctx.session || {};
  const user = ctx.from || {};
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' });

  const coordsText = s.coords ? `${s.coords.latitude}, ${s.coords.longitude}` : 'N/A';

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

bot.launch()
  .then(() => console.log('🧊 Inline-first IceOrderBot is running...'))
  .catch((err) => {
    console.error('Bot failed to start:', err);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

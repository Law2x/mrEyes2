import { Telegraf, Markup } from 'telegraf';
import { session } from 'telegraf/session';
import fetch from 'node-fetch';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = 123456789;

const bot = new Telegraf(BOT_TOKEN);

const AMOUNTS = ['₱500', '₱700', '₱1,000', 'Half G', '1G'];

bot.use(session());

bot.start((ctx) => {
  ctx.session = { step: 'choose_amount' };

  return ctx.reply(
    '🧊 Welcome to IceOrderBot!\n\nPlease select an amount:',
    Markup.keyboard(AMOUNTS.map(amount => [amount]))
      .oneTime()
      .resize()
  );
});

bot.on('text', async (ctx) => {
  const session = ctx.session || {};
  const text = ctx.message.text;

  if (session.step === 'choose_amount' && AMOUNTS.includes(text)) {
    ctx.session = {
      step: 'ask_name',
      amount: text
    };
    return ctx.reply('Please enter your name:', Markup.removeKeyboard());
  }

  if (session.step === 'ask_name') {
    ctx.session.name = text;
    ctx.session.step = 'request_phone';
    return ctx.reply(
      'Please share your phone number:',
      Markup.keyboard([
        Markup.button.contactRequest('📱 Share Phone Number')
      ])
        .oneTime()
        .resize()
    );
  }

  if (session.step === 'confirm') {
    if (text.toLowerCase() === 'confirm') {
      await sendOrderToAdmin(ctx);
      ctx.session = {};
      return ctx.reply(
        '✅ Thank you! Your order has been confirmed and sent to our admin.',
        Markup.removeKeyboard()
      );
    } else if (text.toLowerCase() === 'cancel') {
      ctx.session = {};
      return ctx.reply(
        'Order canceled. You can /start again anytime.',
        Markup.removeKeyboard()
      );
    }
  }

  return ctx.reply('Please use the provided buttons or follow the instructions.');
});

bot.on('contact', async (ctx) => {
  const session = ctx.session || {};

  if (session.step === 'request_phone') {
    ctx.session.phone = ctx.message.contact.phone_number;
    ctx.session.step = 'request_location';
    return ctx.reply(
      'Please share your location:',
      Markup.keyboard([
        Markup.button.locationRequest('📍 Share Location')
      ])
        .oneTime()
        .resize()
    );
  }
});

bot.on('location', async (ctx) => {
  const session = ctx.session || {};

  if (session.step === 'request_location') {
    const { latitude, longitude } = ctx.message.location;

    ctx.session.coords = { latitude, longitude };

    const address = await reverseGeocode(latitude, longitude);
    ctx.session.address = address;

    ctx.session.step = 'confirm';

    const summary = `
📋 Order Summary:

💰 Amount: ${session.amount}
👤 Name: ${session.name}
📱 Phone: ${session.phone}
📍 Address: ${address}
🗺️ Coordinates: ${latitude}, ${longitude}

Please type "Confirm" to place your order or "Cancel" to cancel.
    `.trim();

    return ctx.reply(
      summary,
      Markup.keyboard([['Confirm', 'Cancel']])
        .oneTime()
        .resize()
    );
  }
});

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'IceOrderBot/1.0'
      }
    });
    const data = await response.json();
    return data.display_name || `${lat}, ${lon}`;
  } catch (error) {
    console.error('Geocoding error:', error);
    return `${lat}, ${lon}`;
  }
}

async function sendOrderToAdmin(ctx) {
  const session = ctx.session;
  const user = ctx.from;
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' });

  const orderMessage = `
🧊 NEW ICE ORDER

💰 Amount: ${session.amount}
👤 Name: ${session.name}
📱 Phone: ${session.phone}
📍 Address: ${session.address}
🗺️ Coordinates: ${session.coords.latitude}, ${session.coords.longitude}

👥 User Info:
- Telegram ID: ${user.id}
- Username: ${user.username ? '@' + user.username : 'N/A'}
- First Name: ${user.first_name || 'N/A'}
- Last Name: ${user.last_name || 'N/A'}

⏰ Timestamp: ${timestamp}
  `.trim();

  try {
    await ctx.telegram.sendMessage(ADMIN_CHAT_ID, orderMessage);

    await ctx.telegram.sendLocation(
      ADMIN_CHAT_ID,
      session.coords.latitude,
      session.coords.longitude
    );
  } catch (error) {
    console.error('Error sending to admin:', error);
  }
}

bot.launch();

console.log('🧊 IceOrderBot is running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

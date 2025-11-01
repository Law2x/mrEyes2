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

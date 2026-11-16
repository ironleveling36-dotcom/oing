const TelegramBot = require('node-telegram-bot-api');
const Account = require('./models/Account');
const SwiggyService = require('./services/swiggyService');

function initBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[Bot] TELEGRAM_BOT_TOKEN not set, skipping bot startup');
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });
  console.log('[Bot] Telegram bot polling started');

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      'Commands:\n/otp <phone> - Send OTP (new device)\n/spoof <phone> - Force new Device ID & send OTP\n/verify <phone> <otp> - Verify OTP + full sync\n/sync <phone> - Sync cart + address + payment + claim\n/proxy <phone> <proxy_url> - Set proxy for account'
    );
  });

  bot.onText(/\/spoof\s+(\d{10})/, async (msg, match) => {
    const phone = match[1];
    try {
      let acc = await Account.findOne({ phone });
      if (!acc) acc = await Account.create({ phone, ...Account.generateFingerprint() });
      const res = await SwiggyService.sendOtp(acc, true);
      bot.sendMessage(msg.chat.id, `New Device: ${res.deviceId}\nStatus: ${res.message}`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/otp\s+(\d{10})/, async (msg, match) => {
    const phone = match[1];
    try {
      let acc = await Account.findOne({ phone });
      if (!acc) acc = await Account.create({ phone, ...Account.generateFingerprint() });
      const res = await SwiggyService.sendOtp(acc, true); // always new
      bot.sendMessage(msg.chat.id, `Device: ${res.deviceId}\nStatus: ${res.message}`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/verify\s+(\d{10})\s+(\d{4,6})/, async (msg, match) => {
    const [, phone, otp] = match;
    try {
      const acc = await Account.findOne({ phone });
      if (!acc) return bot.sendMessage(msg.chat.id, 'Request OTP first');
      const res = await SwiggyService.verifyOtp(acc, otp);
      if (res.ok) {
        await Promise.allSettled([
          SwiggyService.syncCart(acc),
          SwiggyService.syncAddresses(acc),
          SwiggyService.syncPaymentStatus(acc),
          SwiggyService.syncClaims(acc)
        ]);
      }
      bot.sendMessage(msg.chat.id, `Verify: ${res.message}`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/sync\s+(\d{10})/, async (msg, match) => {
    const phone = match[1];
    try {
      const acc = await Account.findOne({ phone });
      if (!acc || !acc.isLoggedIn) return bot.sendMessage(msg.chat.id, 'Account not logged in');
      await Promise.allSettled([
        SwiggyService.syncCart(acc),
        SwiggyService.syncAddresses(acc),
        SwiggyService.syncPaymentStatus(acc),
        SwiggyService.syncClaims(acc)
      ]);
      bot.sendMessage(msg.chat.id, 'Full sync completed (cart, address, payment, claim)');
    } catch (e) {
      bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/proxy\s+(\d{10})\s+(.+)/, async (msg, match) => {
    const [, phone, proxyUrl] = match;
    try {
      const acc = await Account.findOne({ phone });
      if (!acc) return bot.sendMessage(msg.chat.id, 'Account not found');
      acc.proxy = proxyUrl.trim();
      await acc.save();
      bot.sendMessage(msg.chat.id, `Proxy set for ${phone}`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/place\s+(\d{10})(?:\s+(\S+))?/, async (msg, match) => {
    const [, phone, paymentMethod = 'Cash'] = match;
    try {
      const acc = await Account.findOne({ phone });
      if (!acc || !acc.isLoggedIn) return bot.sendMessage(msg.chat.id, 'Not logged in');
      const res = await SwiggyService.placeOrder(acc, { paymentMethod });
      bot.sendMessage(msg.chat.id, `Order: ${res.ok ? 'placed' : 'failed'}\nID: ${res.orderId || '-'}\n${res.raw?.statusMessage || ''}`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
    }
  });

  bot.onText(/\/track\s+(\d{10})(?:\s+(\S+))?/, async (msg, match) => {
    const [, phone, orderId] = match;
    try {
      const acc = await Account.findOne({ phone });
      if (!acc) return bot.sendMessage(msg.chat.id, 'Account not found');
      const res = await SwiggyService.trackOrder(acc, orderId);
      bot.sendMessage(msg.chat.id, `Track ${res.orderId}: ${res.status}\nETA: ${res.eta || '-'}`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
    }
  });

  return bot;
}

module.exports = initBot;

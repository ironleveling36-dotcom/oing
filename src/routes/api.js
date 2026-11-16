const express = require('express');
const router = express.Router();
const Account = require('../models/Account');
const SwiggyService = require('../services/swiggyService');

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

async function getOrCreateAccount(phone) {
  const cleanPhone = normalizePhone(phone);
  if (cleanPhone.length !== 10) {
    throw new Error('Valid 10-digit phone number required');
  }
  let account = await Account.findOne({ phone: cleanPhone });
  if (!account) {
    const fp = Account.generateFingerprint();
    account = await Account.create({
      phone: cleanPhone,
      ...fp
    });
  }
  return account;
}

async function runLiveSync(account) {
  await SwiggyService.syncCart(account);
  await SwiggyService.syncAddresses(account);
  await SwiggyService.syncPaymentStatus(account);
  await SwiggyService.syncClaims(account);
  const fresh = await Account.findOne({ phone: account.phone });
  if (fresh?.paymentState?.orderId) {
    await SwiggyService.trackOrder(fresh);
  }
  return Account.findOne({ phone: account.phone });
}

router.get('/health', (req, res) => {
  res.json({ ok: true, status: 'UP', timestamp: Date.now() });
});

router.get('/accounts', async (req, res) => {
  try {
    const accounts = await Account.find().sort({ updatedAt: -1 });
    res.json({ ok: true, accounts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/auth/spoof-device', async (req, res) => {
  try {
    const account = await getOrCreateAccount(req.body.phone);
    account.rotateDevice();
    await account.save();
    await SwiggyService.warmSession(account);

    res.json({
      ok: true,
      phone: account.phone,
      deviceId: account.deviceId,
      swuid: account.swuid,
      userAgent: account.userAgent,
      tid: account.tid
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/auth/send-otp', async (req, res) => {
  try {
    const { phone, spoofDevice = true, lat, lng, proxy } = req.body;
    const account = await getOrCreateAccount(phone);
    if (lat) account.lat = String(lat);
    if (lng) account.lng = String(lng);
    if (proxy) account.proxy = String(proxy);
    await account.save();

    const result = await SwiggyService.sendOtp(account, Boolean(spoofDevice));
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!otp) return res.status(400).json({ ok: false, error: 'OTP required' });

    const account = await getOrCreateAccount(phone);
    const result = await SwiggyService.verifyOtp(account, otp);

    if (result.ok) {
      await runLiveSync(account);
    } else if (result.isMultipleDeviceError) {
      account.rotateDevice();
      await account.save();
      await SwiggyService.warmSession(account);
      result.newDeviceIdGenerated = account.deviceId;
    }

    const fresh = await Account.findOne({ phone: account.phone });
    res.json({
      ...result,
      account: fresh || account
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/cart/sync', async (req, res) => {
  try {
    const { phone, cartPayload = null } = req.body;
    const account = await getOrCreateAccount(phone);
    const result = await SwiggyService.syncCart(account, cartPayload);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/address/sync', async (req, res) => {
  try {
    const { phone } = req.body;
    const account = await getOrCreateAccount(phone);
    const result = await SwiggyService.syncAddresses(account);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/payment/sync', async (req, res) => {
  try {
    const { phone, orderId = null } = req.body;
    const account = await getOrCreateAccount(phone);
    const result = await SwiggyService.syncPaymentStatus(account, orderId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/claim/sync', async (req, res) => {
  try {
    const { phone } = req.body;
    const account = await getOrCreateAccount(phone);
    const result = await SwiggyService.syncClaims(account);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/order/place', async (req, res) => {
  try {
    const { phone, addressId, paymentMethod = 'Cash', couponCode = '', note = '' } = req.body;
    const account = await getOrCreateAccount(phone);
    if (!account.isLoggedIn) return res.json({ ok: false, reason: 'NOT_LOGGED_IN' });
    const result = await SwiggyService.placeOrder(account, { addressId, paymentMethod, couponCode, note });
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/order/track', async (req, res) => {
  try {
    const { phone, orderId } = req.body;
    const account = await getOrCreateAccount(phone);
    const result = await SwiggyService.trackOrder(account, orderId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/payment/options', async (req, res) => {
  try {
    const { phone, addressId } = req.body;
    const account = await getOrCreateAccount(phone);
    const result = await SwiggyService.getPaymentOptions(account, addressId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/sync/all', async (req, res) => {
  try {
    const { phone } = req.body;
    const account = await getOrCreateAccount(phone);
    if (!account.isLoggedIn) {
      return res.json({ ok: false, reason: 'NOT_LOGGED_IN' });
    }

    const fresh = await runLiveSync(account);
    res.json({
      ok: true,
      cartState: fresh?.cartState,
      addressState: fresh?.addressState,
      paymentState: fresh?.paymentState,
      claimState: fresh?.claimState
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get('/live/:phone', async (req, res) => {
  const cleanPhone = normalizePhone(req.params.phone);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  let ticking = false;
  let timer = null;

  const writeEvent = (payload) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const pushUpdate = async () => {
    if (closed || ticking) return;
    ticking = true;
    try {
      const account = await Account.findOne({ phone: cleanPhone });
      if (!account || !account.isLoggedIn) {
        writeEvent({ ok: false, reason: 'NOT_LOGGED_IN' });
        return;
      }

      const fresh = await runLiveSync(account);
      if (!fresh) return;

      writeEvent({
        ok: true,
        phone: fresh.phone,
        deviceId: fresh.deviceId,
        swuid: fresh.swuid,
        cartState: fresh.cartState,
        addressState: fresh.addressState,
        paymentState: fresh.paymentState,
        claimState: fresh.claimState,
        timestamp: Date.now()
      });
    } catch (e) {
      writeEvent({ ok: false, error: e.message });
    } finally {
      ticking = false;
    }
  };

  const schedule = () => {
    if (closed) return;
    timer = setTimeout(async () => {
      await pushUpdate();
      schedule();
    }, 5000);
  };

  await pushUpdate();
  schedule();

  req.on('close', () => {
    closed = true;
    if (timer) clearTimeout(timer);
  });
});

module.exports = router;

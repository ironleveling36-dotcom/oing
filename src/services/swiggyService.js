const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const SWIGGY_BASE = 'https://www.swiggy.com';
const PROFILE_BASE = 'https://profile.swiggy.com';

class SwiggyService {
  static getAxiosConfig(account) {
    const config = {
      timeout: 20000,
      validateStatus: () => true
    };

    if (account.proxy) {
      try {
        config.httpsAgent = new HttpsProxyAgent(account.proxy);
        config.proxy = false; // disable axios default proxy handling
      } catch (e) {
        console.error('[Proxy] Invalid proxy URL:', account.proxy, e.message);
      }
    }

    return config;
  }

  static async notifyAdmin(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (!token || !adminChatId) return;

    try {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: adminChatId,
        text: `⚠️ Swiggy Bot Alert:\n${message}`,
        parse_mode: 'HTML'
      }, { timeout: 10000 });
    } catch (e) {
      console.error('[Notify] Failed to send Telegram alert:', e.message);
    }
  }

  static parseSetCookie(setCookieArray = [], existingCookies = {}) {
    const bag = { ...(existingCookies || {}) };
    if (!Array.isArray(setCookieArray)) return bag;

    for (const raw of setCookieArray) {
      const firstPart = String(raw).split(';')[0];
      const eqIdx = firstPart.indexOf('=');
      if (eqIdx > 0) {
        const k = firstPart.slice(0, eqIdx).trim();
        const v = firstPart.slice(eqIdx + 1).trim();
        bag[k] = v;
      }
    }
    return bag;
  }

  static serializeCookies(account) {
    const baseCookies = {
      _device_id: account.deviceId,
      _swuid: account.swuid,
      _guest_tid: account.tid || '',
      _sid: account.sid || '',
      ...(account.cookies || {})
    };
    return Object.entries(baseCookies)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  static buildHeaders(account, isMutation = false) {
    const headers = {
      'User-Agent': account.userAgent || 'Swiggy-Android/4.52.0 (SM-S918B; Android 13; SDK 33)',
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'X-Device-Id': account.deviceId,
      'deviceId': account.deviceId,
      'swuid': account.swuid,
      'tid': account.tid || 'null',
      'sid': account.sid || 'null',
      'version-code': '1165',
      'app-version': '4.52.0',
      'os-version': '13',
      'pl-name': 'Android',
      'Origin': SWIGGY_BASE,
      'Referer': `${SWIGGY_BASE}/`,
      'Cookie': this.serializeCookies(account)
    };

    if (isMutation && account.csrfToken) {
      headers['csrf-token'] = account.csrfToken;
      headers['x-csrf-token'] = account.csrfToken;
    }
    return headers;
  }

  static async captureSessionMeta(account, response) {
    if (!response || !response.headers) return;

    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
      account.cookies = this.parseSetCookie(setCookie, account.cookies);
      if (account.cookies._sid) account.sid = account.cookies._sid;
      if (account.cookies._guest_tid && !account.tid) account.tid = account.cookies._guest_tid;
    }

    const body = response.data;
    if (body && typeof body === 'object') {
      if (body.tid) account.tid = body.tid;
      if (body.sid) account.sid = body.sid;
      if (body.csrfToken) account.csrfToken = body.csrfToken;
    }

    account.markModified('cookies');
    await account.save();
  }

  static async warmSession(account) {
    const config = this.getAxiosConfig(account);
    try {
      const res = await axios.get(`${SWIGGY_BASE}/dapi/restaurants/list/v5`, {
        ...config,
        params: {
          lat: account.lat || '13.0827',
          lng: account.lng || '80.2707',
          'is-seo-homepage-enabled': true,
          page_type: 'DESKTOP_WEB_LISTING'
        },
        headers: this.buildHeaders(account, false)
      });

      await this.captureSessionMeta(account, res);
      if (!account.csrfToken && res.data?.csrfToken) {
        account.csrfToken = res.data.csrfToken;
        await account.save();
      }
      return account;
    } catch (e) {
      if (this.isProxyError(e)) {
        await this.notifyAdmin(`Proxy error during warmSession for ${account.phone}: ${e.message}`);
      }
      throw e;
    }
  }

  static isProxyError(err) {
    const msg = (err.message || '').toLowerCase();
    return msg.includes('proxy') || msg.includes('econnreset') || msg.includes('tunnel') ||
           msg.includes('407') || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
  }

  static async sendOtp(account, forceNewDevice = true) {
    // Always create a fresh device clone for every OTP login attempt
    if (forceNewDevice || !account.deviceId || !account.swuid) {
      account.rotateDevice();
      await account.save();
    }

    if (!account.tid || !account.csrfToken) {
      await this.warmSession(account);
    }

    const payload = {
      mobile: account.phone,
      _csrf: account.csrfToken || undefined
    };

    const config = this.getAxiosConfig(account);
    try {
      const res = await axios.post(
        `${SWIGGY_BASE}/dapi/auth/sms-otp`,
        payload,
        {
          ...config,
          headers: this.buildHeaders(account, true)
        }
      );

      await this.captureSessionMeta(account, res);

      const statusCode = res.data?.statusCode;
      const statusMessage = res.data?.statusMessage || '';

      if (
        statusCode !== 0 &&
        /multiple|device|limit|exceeded|too many/i.test(statusMessage)
      ) {
        // Force another fresh device and retry once
        account.rotateDevice();
        await account.save();
        return this.sendOtp(account, false);
      }

      return {
        ok: statusCode === 0,
        statusCode,
        message: statusMessage || (statusCode === 0 ? 'OTP sent' : 'OTP send failed'),
        deviceId: account.deviceId,
        swuid: account.swuid,
        raw: res.data
      };
    } catch (e) {
      if (this.isProxyError(e)) {
        await this.notifyAdmin(`Proxy error during sendOtp for ${account.phone}: ${e.message}`);
      }
      throw e;
    }
  }

  static async verifyOtp(account, otp) {
    const payload = {
      otp: String(otp).trim(),
      _csrf: account.csrfToken || undefined
    };

    const config = this.getAxiosConfig(account);
    try {
      const res = await axios.post(
        `${SWIGGY_BASE}/dapi/auth/otp-verify`,
        payload,
        {
          ...config,
          headers: this.buildHeaders(account, true)
        }
      );

      await this.captureSessionMeta(account, res);

      const statusCode = res.data?.statusCode;
      const statusMessage = res.data?.statusMessage || '';

      if (statusCode === 0) {
        account.isLoggedIn = true;
        if (res.data?.data?.name) account.name = res.data.data.name;
        if (res.data?.data?.email) account.email = res.data.data.email;
        await account.save();
      }

      return {
        ok: statusCode === 0,
        statusCode,
        message: statusMessage || (statusCode === 0 ? 'Logged in' : 'OTP verification failed'),
        deviceId: account.deviceId,
        isMultipleDeviceError: /multiple|device|limit|session|too many/i.test(statusMessage),
        raw: res.data
      };
    } catch (e) {
      if (this.isProxyError(e)) {
        await this.notifyAdmin(`Proxy error during verifyOtp for ${account.phone}: ${e.message}`);
      }
      throw e;
    }
  }

  static async syncCart(account, cartPayload = null) {
    const url = `${SWIGGY_BASE}/dapi/cart`;
    const config = this.getAxiosConfig(account);

    try {
      const res = cartPayload
        ? await axios.post(url, { ...cartPayload, _csrf: account.csrfToken }, {
            ...config,
            headers: this.buildHeaders(account, true)
          })
        : await axios.get(url, {
            ...config,
            headers: this.buildHeaders(account, false)
          });

      await this.captureSessionMeta(account, res);

      const cartData = res.data?.data?.cartMeta || res.data?.data || {};
      const rawItems = cartData.cart_items || cartData.items || [];

      account.cartState = {
        cartId: String(cartData.cart_id || cartData.cartId || ''),
        items: rawItems.map(item => ({
          itemId: item.item_id || item.id,
          name: item.name || 'Item',
          quantity: Number(item.quantity || 1),
          total: Number(item.total || item.final_price || item.price || 0)
        })),
        totalAmount: Number(cartData.cart_total || cartData.order_total || 0),
        restaurantName: cartData.restaurant_details?.name || cartData.restaurant_name || '',
        updatedAt: new Date()
      };

      account.markModified('cartState');
      await account.save();

      return {
        ok: res.data?.statusCode === 0,
        cartState: account.cartState,
        raw: res.data
      };
    } catch (e) {
      if (this.isProxyError(e)) {
        await this.notifyAdmin(`Proxy error during syncCart for ${account.phone}: ${e.message}`);
      }
      throw e;
    }
  }

  static async syncAddresses(account) {
    const config = this.getAxiosConfig(account);
    try {
      // Try profile endpoint first
      const res = await axios.get(`${PROFILE_BASE}/api/v2/user/profile`, {
        ...config,
        headers: this.buildHeaders(account, false)
      });

      await this.captureSessionMeta(account, res);

      const addresses = res.data?.data?.addresses || [];
      const defaultAddr = addresses.find(a => a.default === 1 || a.default === true) || addresses[0];

      account.addressState = {
        addresses: addresses.map(a => ({
          id: a.id,
          name: a.name || '',
          address: a.address || '',
          area: a.area || '',
          city: a.city || '',
          lat: a.lat || '',
          lng: a.lng || '',
          isDefault: !!(a.default === 1 || a.default === true)
        })),
        defaultAddressId: defaultAddr?.id || '',
        updatedAt: new Date()
      };

      account.markModified('addressState');
      await account.save();

      return {
        ok: res.data?.statusCode === 0,
        addressState: account.addressState,
        raw: res.data
      };
    } catch (e) {
      if (this.isProxyError(e)) {
        await this.notifyAdmin(`Proxy error during syncAddresses for ${account.phone}: ${e.message}`);
      }
      // Fallback or return empty
      return { ok: false, error: e.message, addressState: account.addressState };
    }
  }

  static async syncPaymentStatus(account, orderId = null) {
    const targetOrderId = orderId || account.paymentState?.orderId;
    const url = targetOrderId
      ? `${SWIGGY_BASE}/dapi/order/track?order_id=${encodeURIComponent(targetOrderId)}`
      : `${SWIGGY_BASE}/dapi/order/all`;

    const config = this.getAxiosConfig(account);
    try {
      const res = await axios.get(url, {
        ...config,
        headers: this.buildHeaders(account, false)
      });

      await this.captureSessionMeta(account, res);

      const data = res.data?.data || {};
      const latestOrder = targetOrderId
        ? (data.orders?.[0] || data)
        : (data.orders?.[0] || null);

      if (latestOrder && (latestOrder.order_id || targetOrderId)) {
        const rawStatus = String(
          latestOrder.payment_txn_status ||
          latestOrder.order_status ||
          latestOrder.post_status ||
          'PENDING'
        ).toUpperCase();

        let normalizedStatus = 'PENDING';
        if (/SUCCESS|PAID|CONFIRMED|DELIVERED|PROCESSING/.test(rawStatus)) {
          normalizedStatus = 'SUCCESS';
        } else if (/FAIL|CANCEL|ABORT|EXPIRE/.test(rawStatus)) {
          normalizedStatus = 'FAILED';
        }

        account.paymentState = {
          orderId: String(latestOrder.order_id || targetOrderId || ''),
          transactionId: String(latestOrder.payment_txn_id || latestOrder.pg_response_time || ''),
          status: normalizedStatus,
          paymentMethod: latestOrder.payment_method || account.paymentState?.paymentMethod || '',
          amount: Number(latestOrder.order_total || latestOrder.net_total || 0),
          upiIntentUrl: latestOrder.upi_intent_url || account.paymentState?.upiIntentUrl || '',
          updatedAt: new Date()
        };

        account.markModified('paymentState');
        await account.save();
      }

      return {
        ok: res.data?.statusCode === 0,
        paymentState: account.paymentState,
        raw: res.data
      };
    } catch (e) {
      if (this.isProxyError(e)) {
        await this.notifyAdmin(`Proxy error during syncPaymentStatus for ${account.phone}: ${e.message}`);
      }
      throw e;
    }
  }

  static async syncClaims(account) {
    // Placeholder for offer/claim sync - extend with real endpoint if available
    // Example: check available offers or claim history
    account.claimState = {
      offers: [],
      claimed: [],
      updatedAt: new Date()
    };
    account.markModified('claimState');
    await account.save();

    return {
      ok: true,
      claimState: account.claimState,
      message: 'Claim sync stub - implement specific offer/claim endpoint as needed'
    };
  }

  static async getPaymentOptions(account, addressId = null) {
    const config = this.getAxiosConfig(account);
    try {
      const res = await axios.post(
        `${SWIGGY_BASE}/dapi/payment/options`,
        { address_id: addressId || account.addressState?.defaultAddressId, _csrf: account.csrfToken },
        { ...config, headers: this.buildHeaders(account, true) }
      );
      await this.captureSessionMeta(account, res);
      return { ok: res.data?.statusCode === 0, options: res.data?.data || {}, raw: res.data };
    } catch (e) {
      if (this.isProxyError(e)) await this.notifyAdmin(`Proxy error getPaymentOptions ${account.phone}: ${e.message}`);
      throw e;
    }
  }

  static async placeOrder(account, { addressId, paymentMethod = 'Cash', couponCode = '', note = '' } = {}) {
    const addrId = addressId || account.addressState?.defaultAddressId;
    if (!addrId) throw new Error('No addressId available — sync addresses first');

    const config = this.getAxiosConfig(account);
    const payload = {
      address_id: addrId,
      payment_method: paymentMethod,
      coupon_code: couponCode || undefined,
      note: note || undefined,
      _csrf: account.csrfToken
    };

    try {
      const res = await axios.post(
        `${SWIGGY_BASE}/dapi/order/place`,
        payload,
        { ...config, headers: this.buildHeaders(account, true) }
      );

      await this.captureSessionMeta(account, res);

      const data = res.data?.data || {};
      if (data.order_id || data.orderId) {
        account.paymentState.orderId = String(data.order_id || data.orderId);
        account.paymentState.status = 'PLACED';
        account.paymentState.updatedAt = new Date();
        account.markModified('paymentState');
        await account.save();
      }

      return {
        ok: res.data?.statusCode === 0,
        orderId: data.order_id || data.orderId,
        status: data.status || 'PENDING',
        raw: res.data
      };
    } catch (e) {
      if (this.isProxyError(e)) await this.notifyAdmin(`Proxy error placeOrder ${account.phone}: ${e.message}`);
      throw e;
    }
  }

  static async trackOrder(account, orderId) {
    const oid = orderId || account.paymentState?.orderId;
    if (!oid) throw new Error('No orderId to track');

    const config = this.getAxiosConfig(account);
    try {
      const res = await axios.get(
        `${SWIGGY_BASE}/dapi/order/track?order_id=${encodeURIComponent(oid)}`,
        { ...config, headers: this.buildHeaders(account, false) }
      );

      await this.captureSessionMeta(account, res);
      const data = res.data?.data || {};
      const riderRaw = data.delivery_partner || data.rider || null;
      const rider = riderRaw && typeof riderRaw === 'object'
        ? (riderRaw.name || riderRaw.delivery_boy_name || '')
        : (riderRaw || '');

      account.paymentState = {
        ...(account.paymentState?.toObject ? account.paymentState.toObject() : account.paymentState),
        orderId: oid,
        status: data.order_status || data.status || account.paymentState?.status || 'UNKNOWN',
        eta: String(data.eta || data.delivery_time || data.sla_time || ''),
        rider: String(rider || ''),
        updatedAt: new Date()
      };
      account.markModified('paymentState');
      await account.save();

      return {
        ok: res.data?.statusCode === 0,
        orderId: oid,
        status: account.paymentState.status,
        eta: account.paymentState.eta || null,
        rider: account.paymentState.rider || null,
        raw: data
      };
    } catch (e) {
      if (this.isProxyError(e)) await this.notifyAdmin(`Proxy error trackOrder ${account.phone}: ${e.message}`);
      throw e;
    }
  }
}

module.exports = SwiggyService;

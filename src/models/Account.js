const mongoose = require('mongoose');
const crypto = require('crypto');

const ANDROID_MODELS = [
  { build: 'SM-S918B; Build/TP1A.220624.014', ua: 'Swiggy-Android/4.52.0 (SM-S918B; Android 13; SDK 33)' },
  { build: 'Pixel 7 Pro; Build/TQ3A.230805.001', ua: 'Swiggy-Android/4.52.0 (Pixel 7 Pro; Android 13; SDK 33)' },
  { build: 'OnePlus 11 5G; Build/SKQ1.221119.001', ua: 'Swiggy-Android/4.52.0 (CPH2447; Android 13; SDK 33)' },
  { build: '2210132G; Build/TKQ1.220829.002', ua: 'Swiggy-Android/4.52.0 (2210132G; Android 13; SDK 33)' },
  { build: 'SM-A546E; Build/TP1A.220624.014', ua: 'Swiggy-Android/4.52.0 (SM-A546E; Android 13; SDK 33)' },
  { build: 'SM-G998B; Build/SP1A.210812.016', ua: 'Swiggy-Android/4.52.0 (SM-G998B; Android 12; SDK 31)' },
  { build: 'Pixel 6; Build/SP2A.220505.008', ua: 'Swiggy-Android/4.52.0 (Pixel 6; Android 12; SDK 31)' }
];

function generateDeviceFingerprint() {
  const model = ANDROID_MODELS[Math.floor(Math.random() * ANDROID_MODELS.length)];
  const deviceId = crypto.randomUUID();
  const swuid = crypto.randomBytes(8).toString('hex');
  return {
    deviceId,
    swuid,
    userAgent: model.ua,
    deviceModel: model.build
  };
}

const AccountSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: '' },
  email: { type: String, default: '' },

  // Persistent device fingerprint - always rotated on new login attempt
  deviceId: { type: String, required: true },
  swuid: { type: String, required: true },
  userAgent: { type: String, required: true },
  deviceModel: { type: String, default: '' },

  // Swiggy session tokens
  tid: { type: String, default: '' },
  sid: { type: String, default: '' },
  csrfToken: { type: String, default: '' },
  cookies: { type: Object, default: {} },
  isLoggedIn: { type: Boolean, default: false },

  // Coordinates
  lat: { type: String, default: '13.0827' },
  lng: { type: String, default: '80.2707' },

  // Proxy for this account (optional, format: http://user:pass@host:port)
  proxy: { type: String, default: '' },

  // Live Cart State
  cartState: {
    cartId: { type: String, default: '' },
    items: { type: Array, default: [] },
    totalAmount: { type: Number, default: 0 },
    restaurantName: { type: String, default: '' },
    updatedAt: { type: Date, default: null }
  },

  // Live Address State
  addressState: {
    addresses: { type: Array, default: [] },
    defaultAddressId: { type: String, default: '' },
    updatedAt: { type: Date, default: null }
  },

  // Live Payment State
  paymentState: {
    orderId: { type: String, default: '' },
    transactionId: { type: String, default: '' },
    status: { type: String, default: 'IDLE' },
    paymentMethod: { type: String, default: '' },
    amount: { type: Number, default: 0 },
    upiIntentUrl: { type: String, default: '' },
    eta: { type: String, default: '' },
    rider: { type: String, default: '' },
    updatedAt: { type: Date, default: null }
  },

  // Claim / Offer State
  claimState: {
    offers: { type: Array, default: [] },
    claimed: { type: Array, default: [] },
    updatedAt: { type: Date, default: null }
  }
}, { timestamps: true });

AccountSchema.statics.generateFingerprint = generateDeviceFingerprint;

AccountSchema.methods.rotateDevice = function () {
  const fp = generateDeviceFingerprint();
  this.deviceId = fp.deviceId;
  this.swuid = fp.swuid;
  this.userAgent = fp.userAgent;
  this.deviceModel = fp.deviceModel;
  this.tid = '';
  this.sid = '';
  this.csrfToken = '';
  this.cookies = {};
  this.isLoggedIn = false;
  return this;
};

module.exports = mongoose.model('Account', AccountSchema);

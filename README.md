# Toing Bot (Updated)

Swiggy OTP login with **always-fresh device fingerprint** (fixes multiple-device errors), live cart / address / payment / claim sync, proxy support with admin notifications.

## Key Fixes
- Every OTP login attempt rotates to a brand-new device clone.
- Proxy errors (connection, auth, timeout) are reported to Telegram admin.
- Added address sync and claim state tracking.
- Production-ready error handling and session capture.

## Setup
1. Copy `.env.example` to `.env` and fill:
   - `MONGODB_URI`
   - `TELEGRAM_BOT_TOKEN` (optional)
   - `TELEGRAM_ADMIN_CHAT_ID` (for proxy alerts)
2. `npm install`
3. `npm start`

## Telegram Commands
- `/otp <phone>` - Send OTP (always new device)
- `/spoof <phone>` - Force new device + OTP
- `/verify <phone> <otp>` - Verify and sync all states
- `/sync <phone>` - Manual full sync (cart + address + payment + claim)

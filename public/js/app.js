let liveSource = null;
let fallbackInterval = null;

function getPhone() {
  return document.getElementById('phone-input').value.replace(/\D/g, '').slice(-10);
}

function logAuth(msg) {
  document.getElementById('auth-log').textContent = msg;
}

function setSyncStatus(msg) {
  document.getElementById('sync-status').textContent = msg;
}

async function requestOtp(spoofDevice = false) {
  const phone = getPhone();
  if (phone.length !== 10) return logAuth('Enter a valid 10-digit phone number.');

  logAuth(spoofDevice ? 'Generating new Device ID and sending OTP...' : 'Sending OTP...');
  const res = await fetch('/api/auth/send-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, spoofDevice })
  });
  const data = await res.json();

  if (data.deviceId) {
    document.getElementById('active-device-id').textContent = data.deviceId;
  }
  logAuth(data.ok ? `OTP sent on Device ${data.deviceId}` : `Error: ${data.message || data.error}`);
}

async function verifyOtp() {
  const phone = getPhone();
  const otp = document.getElementById('otp-input').value.trim();
  if (phone.length !== 10 || !otp) return logAuth('Phone and OTP are required.');

  logAuth('Verifying OTP on locked device fingerprint...');
  const res = await fetch('/api/auth/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, otp })
  });
  const data = await res.json();

  if (data.ok) {
    logAuth(`Logged in! Device locked: ${data.deviceId}`);
    document.getElementById('active-device-id').textContent = data.deviceId;
    startLiveSync(phone);
  } else if (data.isMultipleDeviceError) {
    logAuth(`Multiple-device error hit. Rotated to new Device ${data.newDeviceIdGenerated}. Requesting clean OTP...`);
    document.getElementById('active-device-id').textContent = data.newDeviceIdGenerated || '-';
    await requestOtp(false);
  } else {
    logAuth(`Verify failed: ${data.message || data.error}`);
  }
}

function renderLiveState(payload) {
  if (!payload || !payload.ok) return;

  if (payload.deviceId) {
    document.getElementById('active-device-id').textContent = payload.deviceId;
  }

  const cartEl = document.getElementById('live-cart-box');
  if (cartEl && payload.cartState) {
    const items = payload.cartState.items || [];
    const itemsHtml = items.length
      ? items.map(i => `<div class="item-line"><span>${i.name} x${i.quantity}</span><span>₹${i.total}</span></div>`).join('')
      : '<div class="meta">Cart is empty</div>';

    cartEl.innerHTML = `
      <div><strong>${payload.cartState.restaurantName || 'Active Cart'}</strong></div>
      <div style="margin: 6px 0;">Total: <strong>₹${payload.cartState.totalAmount || 0}</strong></div>
      ${itemsHtml}
    `;
  }

  const payEl = document.getElementById('live-payment-box');
  if (payEl && payload.paymentState) {
    const st = payload.paymentState.status || 'IDLE';
    payEl.innerHTML = `
      <div>Order ID: <strong>${payload.paymentState.orderId || '-'}</strong></div>
      <div style="margin: 6px 0;">Status: <span class="badge ${st}">${st}</span></div>
      <div>Amount: <strong>₹${payload.paymentState.amount || 0}</strong></div>
      <div class="meta">Method: ${payload.paymentState.paymentMethod || '-'}</div>
      <div class="meta">ETA: ${payload.paymentState.eta || '-'}</div>
      <div class="meta">Rider: ${payload.paymentState.rider || '-'}</div>
    `;
  }
}

function startLiveSync(phone) {
  stopLiveSync();
  const cleanPhone = String(phone).replace(/\D/g, '').slice(-10);
  setSyncStatus('Live (SSE)');

  if (window.EventSource) {
    liveSource = new EventSource(`/api/live/${cleanPhone}`);
    liveSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.ok) renderLiveState(data);
      } catch (_) {}
    };
    liveSource.onerror = () => {
      liveSource.close();
      liveSource = null;
      startPollingFallback(cleanPhone);
    };
  } else {
    startPollingFallback(cleanPhone);
  }
}

function startPollingFallback(phone) {
  if (fallbackInterval) clearInterval(fallbackInterval);
  setSyncStatus('Live (Polling)');
  fallbackInterval = setInterval(async () => {
    try {
      const [cartRes, payRes] = await Promise.all([
        fetch('/api/cart/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone })
        }).then(r => r.json()),
        fetch('/api/payment/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone })
        }).then(r => r.json())
      ]);
      renderLiveState({
        ok: true,
        cartState: cartRes.cartState,
        paymentState: payRes.paymentState
      });
    } catch (_) {}
  }, 4000);
}

function stopLiveSync() {
  if (liveSource) {
    liveSource.close();
    liveSource = null;
  }
  if (fallbackInterval) {
    clearInterval(fallbackInterval);
    fallbackInterval = null;
  }
  setSyncStatus('Idle');
}

document.getElementById('btn-spoof-otp').addEventListener('click', () => requestOtp(true));
document.getElementById('btn-send-otp').addEventListener('click', () => requestOtp(false));
document.getElementById('btn-verify-otp').addEventListener('click', verifyOtp);

document.getElementById('btn-manual-cart').addEventListener('click', async () => {
  const phone = getPhone();
  if (phone.length !== 10) return;
  const res = await fetch('/api/cart/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone })
  }).then(r => r.json());
  renderLiveState({ ok: true, cartState: res.cartState });
});

document.getElementById('btn-manual-payment').addEventListener('click', async () => {
  const phone = getPhone();
  if (phone.length !== 10) return;
  const res = await fetch('/api/payment/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone })
  }).then(r => r.json());
  renderLiveState({ ok: true, paymentState: res.paymentState });
});

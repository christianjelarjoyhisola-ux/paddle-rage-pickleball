(function () {
  'use strict';
  let state, registration, subscription, device, loading = false, pushError = '';
  const $ = id => document.getElementById(id);
  // Test the registration's pushManager, not the optional global constructor.
  const supported = () => 'serviceWorker' in navigator && 'Notification' in window;
  const permission = () => window.Notification?.permission || 'unavailable';
  function bounded(promise, message) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 15000); })]).finally(() => clearTimeout(timer));
  }
  function phoneError(error) {
    if (error?.name === 'NotAllowedError' || permission() === 'denied') return 'Notifications are blocked. On iPhone, open Settings → Notifications → Paddle Rage and turn on Allow Notifications. Return to this app and tap Refresh.';
    if (error?.name === 'InvalidStateError') return 'This device has an older notification subscription. Turn notifications off in your device settings, turn them back on, then reopen Paddle Rage and retry.';
    return error?.message || 'Unable to enable phone notifications. Refresh and try again.';
  }
  const iosBrowser = () => (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) && !window.matchMedia('(display-mode: standalone)').matches && !navigator.standalone;
  // Check for click-routing updates whenever the admin app opens, even if the
  // owner does not visit Notifications. This does not request permission.
  if (supported() && !iosBrowser()) navigator.serviceWorker.register('/notifications-sw.js', {scope:'/',updateViaCache:'none'}).catch(() => {});
  async function api(action, body = {}) {
    return _invokeEdgeFunction('review-notifications', { action, ...body }, { preferDirect: true, retryDirect: false });
  }
  function feedback(message, error = false) { $('notificationFeedback').textContent = message; $('notificationFeedback').dataset.error = String(error); }
  function lastDelivery(target) {
    if (target?.last_error) return target.last_error;
    return target?.last_sent_at ? 'Latest alert accepted by the provider: ' + new Date(target.last_sent_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : 'No alerts sent yet.';
  }
  async function endpointKey(endpoint) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))), b => b.toString(16).padStart(2, '0')).join('');
  }
  function keyBytes(key) { const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4)); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
  async function refresh() {
    state = await api('status');
    device = null;
    pushError = '';
    if (supported() && !iosBrowser()) {
      try {
      await bounded(navigator.serviceWorker.register('/notifications-sw.js', { scope: '/', updateViaCache: 'none' }), 'Phone setup timed out. Tap Refresh to retry.');
      registration = await bounded(navigator.serviceWorker.ready, 'Phone setup timed out. Tap Refresh to retry.');
      if (!registration.pushManager?.subscribe) throw new Error('Push notifications are not available in this browser.');
      subscription = await bounded(registration.pushManager.getSubscription(), 'Phone setup timed out. Tap Refresh to retry.');
      if (subscription) { const key = await endpointKey(subscription.endpoint); device = state.devices.find(d => d.target_key === key); }
      } catch (_) { registration = null; pushError = 'Unable to prepare phone notifications in this browser. Refresh to retry; email alerts remain available.'; }
    }
    const email = state.email;
    $('notificationEmail').textContent = email?.destination?.email || 'No verified recipient yet';
    $('notificationEmailState').textContent = email?.enabled ? 'On' : 'Off';
    $('notificationEmailState').dataset.on = String(!!email?.enabled);
    $('notificationEmailToggle').hidden = !email;
    $('notificationEmailToggle').textContent = email?.enabled ? 'Turn off email alerts' : 'Turn on email alerts';
    $('notificationEmailTest').disabled = !email?.enabled || !state.emailReady;
    $('notificationEmailDelivery').textContent = state.emailReady ? lastDelivery(email) : 'Email delivery is not configured.';
    if (!email) $('notificationEmailDetails').open = true;
    const enabled = !!device?.enabled && permission() === 'granted';
    $('notificationPhoneState').textContent = enabled ? 'On this device' : permission() === 'denied' ? 'Blocked by device' : 'Off this device';
    $('notificationPhoneState').dataset.on = String(enabled);
    $('notificationPhoneToggle').textContent = enabled ? 'Turn off this device' : 'Enable notifications';
    // Keep setup help actionable instead of leaving an unexplained disabled button.
    $('notificationPhoneToggle').disabled = false;
    $('notificationPhoneTest').disabled = !enabled;
    $('notificationPhoneHelp').textContent = iosBrowser() ? 'On iPhone or iPad, add Paddle Rage to your Home Screen with Open as Web App enabled. Open that app, sign in, then enable notifications here (iOS 16.4 or later).' : !supported() ? 'This browser does not support push notifications. Use a current version of Chrome, Edge, Firefox or the installed iPhone web app.' : permission() === 'denied' ? phoneError({name:'NotAllowedError'}) : !state.pushReady ? 'Phone notification delivery is not configured yet.' : 'Choose Enable notifications, then Allow when your device asks. This setting applies only to this browser or installed app.';
    $('notificationPhoneDelivery').textContent = lastDelivery(device);
    if (pushError) $('notificationPhoneHelp').textContent = pushError;
    $('notificationUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila' });
  }
  async function run(task, message) {
    if (loading) return;
    loading = true;
    const buttons = [...$('sec-notifications').querySelectorAll('button')];
    const states = buttons.map(b => b.disabled);
    buttons.forEach(b => b.disabled = true);
    try { await task(); feedback(message); }
    catch (e) { feedback(e.message || 'Unable to update notifications.', true); }
    finally {
      buttons.forEach((b, i) => b.disabled = states[i]);
      try { await refresh(); } catch (e) { feedback(e.message || 'Unable to refresh settings.', true); }
      loading = false;
    }
  }
  function mount() {
    const root = $('sec-notifications');
    if (root.dataset.mounted) return;
    root.dataset.mounted = 'true';
    root.innerHTML = `<div class="toolbar"><div><h2>Notifications</h2><p class="notification-intro">Stay informed, on your terms.</p></div><button class="btn btn-g" id="notificationRefresh">Refresh</button></div>
      <p id="notificationUpdated" class="notification-footnote"></p>
      <h3>Payment review needed</h3><p class="notification-intro">Get an alert only when a payment needs manual verification. Automatically approved payments do not send review alerts. New alerts are checked every minute; reminders repeat hourly until reviewed. Covers court bookings, host balances and Open Play payments.</p>
      <div class="notification-grid">
        <article class="notification-card"><header><h3><span aria-hidden="true">✉</span> Email alerts</h3><span class="notification-state" id="notificationEmailState">Loading</span></header><p>Send payment-review alerts to the email address you choose and verify.</p>
          <div class="notification-detail"><small>Verified recipient</small><strong id="notificationEmail">Loading…</strong><small>Only this address receives your email alerts.</small></div>
          <details id="notificationEmailDetails"><summary>Set or change email address</summary><form id="notificationEmailForm"><label for="notificationEmailInput">Notification email</label><input id="notificationEmailInput" type="email" autocomplete="email" maxlength="254" required><button class="btn btn-g" type="submit">Send verification code</button></form><form id="notificationCodeForm" hidden><label for="notificationCode">Six-digit verification code</label><input id="notificationCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required><button class="btn btn-p" type="submit">Verify &amp; enable alerts</button></form></details>
          <div class="notification-actions"><button class="btn btn-g" id="notificationEmailToggle" hidden>Turn on email alerts</button><button class="btn btn-g" id="notificationEmailTest" disabled>Test email</button></div><p id="notificationEmailDelivery"></p></article>
        <article class="notification-card"><header><h3><span aria-hidden="true">📱</span> Phone notifications</h3><span class="notification-state" id="notificationPhoneState">Loading</span></header><p>A quick alert on this device, even when the app is closed.</p><div class="notification-detail"><strong>This device only</strong><small id="notificationPhoneHelp">Checking device support…</small></div>
          <div class="notification-actions"><button class="btn btn-p" id="notificationPhoneToggle" disabled>Enable notifications</button><button class="btn btn-g" id="notificationPhoneTest" disabled>Test phone</button></div><p id="notificationPhoneDelivery"></p></article>
      </div><p class="notification-feedback" id="notificationFeedback" role="status" aria-live="polite"></p><p class="notification-footnote">Phone alerts hide player and payment details. Sign in to review receipts securely. Existing Telegram reminders continue separately. Delivery can be delayed by your device’s notification or battery settings.</p>`;
    $('notificationRefresh').onclick = () => run(async () => {}, 'Settings refreshed.');
    $('notificationEmailForm').onsubmit = event => { event.preventDefault(); run(async () => { await api('verify_email_start', { email: $('notificationEmailInput').value }); $('notificationCodeForm').hidden = false; $('notificationCode').focus(); }, 'Verification code sent. Check your inbox and spam folder; it expires in 10 minutes.'); };
    $('notificationCodeForm').onsubmit = event => { event.preventDefault(); run(async () => { await api('verify_email_finish', { code: $('notificationCode').value }); $('notificationCodeForm').hidden = true; $('notificationCode').value = ''; }, 'Email verified. Payment-review email alerts are now on.'); };
    $('notificationEmailToggle').onclick = () => run(() => api('toggle', { id: state.email.id, enabled: !state.email.enabled }), 'Email preference saved.');
    $('notificationEmailTest').onclick = () => run(() => api('test', { id: state.email.id }), 'Test email accepted by the email provider. Check your inbox.');
    $('notificationPhoneTest').onclick = () => run(() => api('test', { id: device.id }), 'Test alert accepted by the push provider. Check this device.');
    $('notificationPhoneToggle').onclick = () => {
      if (loading) return;
      if (device?.enabled && permission() === 'granted') { run(() => api('toggle', { id: device.id, enabled: false }), 'Notifications turned off for this device.'); return; }
      if (iosBrowser() || !supported() || permission() === 'denied' || !state?.pushReady || pushError || !registration?.pushManager) {
        feedback($('notificationPhoneHelp').textContent, true);
        $('notificationPhoneHelp').scrollIntoView({block:'center',behavior:'smooth'});
        return;
      }
      // Safari requires subscribe() itself to run in the tap handler. Do not
      // precede it with requestPermission(), getSubscription(), or an API await.
      try {
        const pending = subscription && permission() === 'granted' ? Promise.resolve(subscription) : registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(state.publicKey) });
        run(async () => {
          try { subscription = await pending; }
          catch (e) { throw new Error(phoneError(e)); }
          await api('subscribe', { subscription: subscription.toJSON() });
        }, 'Notifications enabled on this device. Tap Test phone to check delivery.');
      } catch (e) { feedback(phoneError(e), true); }
    };
  }
  window.PaddleNotifications = { async render() { mount(); try { await refresh(); } catch(e) { feedback(e.message || 'Unable to load notification settings.', true); } } };
})();

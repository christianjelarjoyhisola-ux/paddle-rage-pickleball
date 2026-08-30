(function hostBalanceAdminModule(global) {
  'use strict';

  const state = {
    payments: [],
    loadedAt: 0,
    loading: null,
    current: null,
    receiptLoaded: false,
    busy: false,
    lastFocus: null,
    originalRenderPaymentReview: null,
    loadToken: 0,
    expectedPaymentId: '',
    loadState: 'idle',
    generation: 0,
  };
  const byId = id => document.getElementById(id);

  function paymentId(payment) {
    return String(payment?.paymentId || payment?.payment_id || payment?.id || '').trim();
  }

  function normalizedBookingRef(value) {
    return String(value || '').trim().toUpperCase();
  }

  function bookingRefs(booking) {
    const refs = new Set();
    const add = value => {
      const ref = normalizedBookingRef(value);
      if (ref) refs.add(ref);
    };
    if (typeof booking === 'string') add(booking);
    else if (booking) {
      [booking.ref, booking.primaryRef, booking.primary_ref, booking.groupRef,
        booking.group_ref, booking.displayRef, booking.display_ref,
        booking.bookingKey, booking.booking_key].forEach(add);
      for (const collection of [booking.items, booking.allItems, booking.bookingRefs, booking.booking_refs]) {
        if (!Array.isArray(collection)) continue;
        collection.forEach(item => typeof item === 'string' ? add(item) : add(item?.ref));
      }
    }
    return refs;
  }

  function paymentRefs(payment) {
    const refs = new Set();
    const add = value => {
      const ref = normalizedBookingRef(value);
      if (ref) refs.add(ref);
    };
    [payment?.bookingKey, payment?.booking_key, payment?.bookingRef,
      payment?.booking_ref, payment?.bookingGroupRef, payment?.booking_group_ref]
      .forEach(add);
    for (const collection of [payment?.bookingRefs, payment?.booking_refs]) {
      if (Array.isArray(collection)) collection.forEach(add);
    }
    return refs;
  }

  function pendingForBooking(booking) {
    const candidates = bookingRefs(booking);
    if (!candidates.size) return null;
    return state.payments.find(payment => {
      for (const ref of paymentRefs(payment)) if (candidates.has(ref)) return true;
      return false;
    }) || null;
  }

  function statusForBooking(booking) {
    if (pendingForBooking(booking)) return 'pending';
    return state.loadState === 'ready' ? 'clear' : 'unknown';
  }

  function money(value) {
    const amount = Number(value || 0);
    return `₱${Number.isFinite(amount) ? amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'}`;
  }

  function when(value) {
    const date = new Date(String(value || ''));
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('en-PH', {
      timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  }

  function role() {
    try { return String(global.Auth?.getSession?.()?.role || '').toLowerCase(); }
    catch (_) { return ''; }
  }

  function canDecide() {
    return ['owner', 'court_owner'].includes(role());
  }

  function notify(message, kind) {
    if (typeof global.toast === 'function') global.toast(message, kind);
  }

  function supabaseClient() {
    if (global._supabase?.functions?.invoke) return global._supabase;
    try { if (typeof _sb !== 'undefined' && _sb?.functions?.invoke) return _sb; }
    catch (_) {}
    return null;
  }

  function apiCall(action, payload = {}) {
    const api = global.HostBalancePayment;
    if (!api?.invoke) throw new Error('Host balance payment service is unavailable. Refresh this page.');
    return api.invoke(supabaseClient(), { action, ...payload });
  }

  function addStyles() {
    if (byId('hostBalanceAdminStyles')) return;
    const style = document.createElement('style');
    style.id = 'hostBalanceAdminStyles';
    style.textContent = `
      .hba-panel{margin-bottom:14px;overflow:hidden;border-color:rgba(201,207,67,.18)}
      .hba-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:17px 19px;border-bottom:1px solid var(--border);background:linear-gradient(135deg,rgba(201,207,67,.055),transparent 70%)}
      .hba-head h3{margin:0;font-size:1rem;color:var(--text)}
      .hba-kicker{margin-bottom:4px;color:var(--pickle-lime);font-size:.61rem;font-weight:900;letter-spacing:.09em;text-transform:uppercase}
      .hba-sub{color:var(--muted);font-size:.75rem;line-height:1.45}
      .hba-list{display:grid;gap:10px;padding:14px}
      .hba-card{border:1px solid var(--border);border-radius:13px;padding:14px;background:linear-gradient(145deg,var(--input),rgba(201,207,67,.025))}
      .hba-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .hba-name{font-weight:850;color:var(--text)}
      .hba-ref{margin-top:3px;color:var(--muted);font-size:.72rem;overflow-wrap:anywhere}
      .hba-amount{font-weight:950;color:var(--pickle-lime);font-size:1rem;white-space:nowrap}
      .hba-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;margin-top:12px;font-size:.76rem;color:var(--text2)}
      .hba-meta b,.hba-summary b{display:block;margin-bottom:2px;color:var(--muted);font-size:.62rem;text-transform:uppercase;letter-spacing:.07em}
      .hba-bottom{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:13px;padding-top:11px;border-top:1px solid var(--border)}
      .hba-status{font-size:.71rem;font-weight:850;color:var(--yellow)}
      .hba-booking-pending{display:inline-flex;align-items:center;gap:5px;margin-top:6px;padding:4px 8px;border:1px solid rgba(255,193,7,.3);border-radius:999px;background:rgba(255,193,7,.1);color:var(--yellow);font-size:.68rem;font-weight:900;line-height:1.2}
      .hba-empty{padding:24px;text-align:center;color:var(--muted);font-size:.82rem;line-height:1.5}
      .hba-overlay{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(2,8,5,.84);backdrop-filter:blur(8px)}
      .hba-overlay[hidden]{display:none}
      .hba-modal{width:min(620px,100%);max-height:min(90dvh,820px);overflow:auto;border:1px solid rgba(201,207,67,.24);border-radius:19px;background:var(--surface);box-shadow:0 28px 90px rgba(0,0,0,.58)}
      .hba-modal-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--border);background:var(--surface)}
      .hba-modal-head h3{margin:0;font-size:1rem}
      .hba-close{width:40px;height:40px;border:1px solid var(--border);border-radius:11px;background:var(--input);color:var(--text);font-size:1.2rem;cursor:pointer}
      .hba-modal-body{padding:18px}
      .hba-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-bottom:14px}
      .hba-summary>div{padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--input);font-size:.77rem;overflow-wrap:anywhere}
      .hba-explainer{margin:0 0 14px;padding:11px 12px;border:1px solid rgba(201,207,67,.22);border-radius:11px;background:rgba(201,207,67,.07);color:var(--text2);font-size:.75rem;line-height:1.5}
      .hba-explainer strong{color:var(--pickle-lime)}
      .hba-proof{min-height:220px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:12px;background:#050a07;overflow:hidden}
      .hba-proof img{display:none;width:100%;max-height:420px;object-fit:contain}
      .hba-proof-status{padding:20px;color:var(--muted);font-size:.8rem;text-align:center}
      .hba-flags{margin-top:10px;color:var(--muted);font-size:.72rem;line-height:1.5;overflow-wrap:anywhere}
      .hba-reason{width:100%;min-height:72px;margin-top:14px;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--input);color:var(--text);resize:vertical}
      .hba-modal-actions{display:grid;grid-template-columns:1fr 1.45fr;gap:10px;margin-top:12px}
      .hba-modal-actions button{min-height:44px;justify-content:center}
      @media(max-width:560px){
        .hba-head,.hba-card-top,.hba-bottom{align-items:stretch;flex-direction:column}
        .hba-meta,.hba-summary,.hba-modal-actions{grid-template-columns:1fr}
        .hba-overlay{align-items:flex-end;padding:0}
        .hba-modal{width:100%;max-height:94dvh;border-radius:20px 20px 0 0;padding-bottom:env(safe-area-inset-bottom)}
      }
    `;
    document.head.appendChild(style);
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function appendSummary(container, label, value) {
    const cell = make('div');
    cell.append(make('b', '', label), document.createTextNode(String(value || '—')));
    container.appendChild(cell);
  }

  function ensurePanel() {
    const section = byId('sec-payreview');
    if (!section) return null;
    let panel = byId('hostBalanceAdminPanel');
    if (panel) return panel;
    addStyles();
    panel = make('section', 'pr-panel hba-panel');
    panel.id = 'hostBalanceAdminPanel';
    panel.setAttribute('aria-labelledby', 'hostBalanceAdminTitle');
    const head = make('div', 'hba-head');
    const heading = make('div');
    heading.append(make('div', 'hba-kicker', 'Host court balances'));
    const title = make('h3', '', 'Balance Payment Review');
    title.id = 'hostBalanceAdminTitle';
    heading.append(title, make('div', 'hba-sub', 'Review only the new receipt and reference for the exact remaining balance.'));
    const refresh = make('button', 'btn btn-g btn-sm', 'Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', () => render(true));
    head.append(heading, refresh);
    const list = make('div', 'hba-list');
    list.id = 'hostBalanceAdminList';
    list.setAttribute('aria-live', 'polite');
    list.appendChild(make('div', 'hba-empty', 'Loading host balance payments…'));
    panel.append(head, list);
    const firstPanel = section.querySelector('.pr-panel');
    if (firstPanel) section.insertBefore(panel, firstPanel);
    else section.appendChild(panel);
    return panel;
  }

  function syncActions() {
    const reason = String(byId('hostBalanceReviewReason')?.value || '').trim();
    const locked = state.busy || !canDecide() || !state.receiptLoaded;
    const approve = byId('hostBalanceApproveBtn');
    const reject = byId('hostBalanceRejectBtn');
    if (approve) approve.disabled = locked;
    if (reject) reject.disabled = locked || reason.length < 3;
  }

  function ensureModal() {
    let overlay = byId('hostBalanceReviewModal');
    if (overlay) return overlay;
    overlay = make('div', 'hba-overlay');
    overlay.id = 'hostBalanceReviewModal';
    overlay.hidden = true;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'hostBalanceReviewTitle');
    const modal = make('div', 'hba-modal');
    const head = make('div', 'hba-modal-head');
    const title = make('h3', '', 'Review Host Balance Receipt');
    title.id = 'hostBalanceReviewTitle';
    const close = make('button', 'hba-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close host balance review');
    close.addEventListener('click', closeModal);
    head.append(title, close);
    const body = make('div', 'hba-modal-body');
    const summary = make('div', 'hba-summary');
    summary.id = 'hostBalanceReviewSummary';
    const explainer = make('div', 'hba-explainer');
    explainer.innerHTML = '<strong>Court already reserved.</strong> The deposit confirmed the reservation. Approving this new receipt marks only the remaining balance fully paid.';
    const proof = make('div', 'hba-proof');
    const proofStatus = make('div', 'hba-proof-status', 'Loading receipt proof…');
    proofStatus.id = 'hostBalanceProofStatus';
    const image = document.createElement('img');
    image.id = 'hostBalanceProofImage';
    image.alt = 'New host balance payment receipt';
    image.referrerPolicy = 'no-referrer';
    proof.append(proofStatus, image);
    const flags = make('div', 'hba-flags');
    flags.id = 'hostBalanceReviewFlags';
    const reason = document.createElement('textarea');
    reason.id = 'hostBalanceReviewReason';
    reason.className = 'hba-reason';
    reason.placeholder = 'Reason required to reject (at least 3 characters)';
    reason.setAttribute('aria-label', 'Balance payment review reason');
    reason.addEventListener('input', syncActions);
    const actions = make('div', 'hba-modal-actions');
    const reject = make('button', 'btn btn-d', 'Reject Receipt');
    reject.id = 'hostBalanceRejectBtn';
    reject.type = 'button';
    reject.addEventListener('click', () => decide('reject'));
    const approve = make('button', 'btn btn-p', 'Approve & Mark Fully Paid');
    approve.id = 'hostBalanceApproveBtn';
    approve.type = 'button';
    approve.addEventListener('click', () => decide('approve'));
    actions.append(reject, approve);
    body.append(summary, explainer, proof, flags, reason, actions);
    modal.append(head, body);
    overlay.appendChild(modal);
    overlay.addEventListener('mousedown', event => { if (event.target === overlay) closeModal(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !overlay.hidden) closeModal();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  async function openModal(payment, trigger) {
    if (state.busy) return;
    const expectedId = paymentId(payment);
    const loadToken = ++state.loadToken;
    state.current = payment;
    state.expectedPaymentId = expectedId;
    state.receiptLoaded = false;
    state.lastFocus = trigger || document.activeElement;
    const overlay = ensureModal();
    const summary = byId('hostBalanceReviewSummary');
    summary.replaceChildren();
    appendSummary(summary, 'Host', payment.customerName || payment.customer_name);
    appendSummary(summary, 'Booking', payment.bookingGroupRef || payment.booking_group_ref || payment.bookingRef || payment.booking_ref || payment.bookingKey);
    appendSummary(summary, 'Exact balance', money(payment.balanceAmount || payment.balance_amount || payment.expectedAmount || payment.expected_amount));
    appendSummary(summary, 'New payment', `${String(payment.paymentProvider || payment.payment_provider || '—').toUpperCase()} · ${payment.paymentReference || payment.payment_reference || '—'}`);
    appendSummary(summary, 'Schedule', payment.scheduleLabel || payment.schedule_label || payment.bookingDate || payment.booking_date);
    appendSummary(summary, 'Submitted', when(payment.submittedAt || payment.submitted_at || payment.createdAt || payment.created_at));
    const flags = payment.receiptFlags || payment.receipt_flags || [];
    byId('hostBalanceReviewFlags').textContent = Array.isArray(flags) && flags.length
      ? `Verification flags: ${flags.join(', ')}` : 'Verification flags: none';
    byId('hostBalanceReviewReason').value = '';
    const oldImage = byId('hostBalanceProofImage');
    const image = document.createElement('img');
    image.id = 'hostBalanceProofImage';
    image.alt = 'New host balance payment receipt';
    image.referrerPolicy = 'no-referrer';
    image.style.display = 'none';
    image.addEventListener('load', () => {
      if (loadToken !== state.loadToken || expectedId !== state.expectedPaymentId) return;
      state.receiptLoaded = true;
      image.style.display = 'block';
      status.style.display = 'none';
      syncActions();
    });
    image.addEventListener('error', () => {
      if (loadToken !== state.loadToken || expectedId !== state.expectedPaymentId) return;
      state.receiptLoaded = false;
      image.removeAttribute('src');
      image.style.display = 'none';
      status.style.display = '';
      status.textContent = 'Receipt image could not be loaded. Approval remains disabled.';
      syncActions();
    });
    oldImage?.replaceWith(image);
    const status = byId('hostBalanceProofStatus');
    status.style.display = '';
    status.textContent = 'Loading receipt proof…';
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    syncActions();
    overlay.querySelector('.hba-close')?.focus();
    try {
      const result = await apiCall('receipt_url', { paymentId: expectedId });
      if (loadToken !== state.loadToken || expectedId !== state.expectedPaymentId) return;
      const rawUrl = result?.url || result?.data?.url;
      const url = new URL(String(rawUrl || ''));
      if (url.protocol !== 'https:') throw new Error('Receipt link is not secure.');
      image.src = url.href;
    } catch (error) {
      if (loadToken !== state.loadToken || expectedId !== state.expectedPaymentId) return;
      status.textContent = error?.message || 'Receipt proof is unavailable.';
      syncActions();
    }
  }

  function closeModal() {
    const overlay = byId('hostBalanceReviewModal');
    if (!overlay || overlay.hidden || state.busy) return;
    state.loadToken += 1;
    state.expectedPaymentId = '';
    overlay.hidden = true;
    document.body.style.overflow = '';
    byId('hostBalanceProofImage')?.removeAttribute('src');
    state.current = null;
    state.receiptLoaded = false;
    state.lastFocus?.focus?.();
    state.lastFocus = null;
  }

  async function decide(decision) {
    const payment = state.current;
    if (!payment || paymentId(payment) !== state.expectedPaymentId || state.busy || !canDecide() || !state.receiptLoaded) return;
    const reason = String(byId('hostBalanceReviewReason')?.value || '').trim();
    if (decision === 'reject' && reason.length < 3) {
      notify('Enter a reason before rejecting the receipt.', 'err');
      return;
    }
    if (decision === 'approve' && !global.confirm(`Approve ${money(payment.balanceAmount || payment.balance_amount || payment.expectedAmount || payment.expected_amount)} and mark every booking row fully paid?`)) return;
    if (decision === 'reject' && !global.confirm(
      `Reject ${money(payment.balanceAmount || payment.balance_amount || payment.expectedAmount || payment.expected_amount)} for ${payment.bookingGroupRef || payment.booking_group_ref || payment.bookingRef || payment.booking_ref || 'this booking'}?\n\nReference: ${payment.paymentReference || payment.payment_reference || '—'}\nReason: ${reason}`
    )) return;
    state.busy = true;
    const button = byId(decision === 'approve' ? 'hostBalanceApproveBtn' : 'hostBalanceRejectBtn');
    const idleText = button?.textContent || '';
    if (button) button.textContent = decision === 'approve' ? 'Approving…' : 'Rejecting…';
    syncActions();
    try {
      await apiCall('review', { paymentId: paymentId(payment), decision, reason });
      notify(decision === 'approve' ? 'Host balance approved. The booking is fully paid.' : 'Host balance receipt rejected.', decision === 'approve' ? 'ok' : 'inf');
      state.busy = false;
      closeModal();
      await render(true);
      if (state.originalRenderPaymentReview) await state.originalRenderPaymentReview();
      if (byId('sec-bookings')?.classList.contains('on') && typeof global.renderBookings === 'function') {
        await global.renderBookings();
      }
    } catch (error) {
      notify(error?.message || 'Could not save the host balance decision.', 'err');
    } finally {
      state.busy = false;
      if (button?.isConnected) button.textContent = idleText;
      syncActions();
    }
  }

  function renderCards() {
    const list = byId('hostBalanceAdminList');
    if (!list) return;
    list.replaceChildren();
    if (!state.payments.length) {
      list.appendChild(make('div', 'hba-empty', 'No host balance receipts are waiting for review.'));
      return;
    }
    state.payments.forEach(payment => {
      const card = make('article', 'hba-card');
      const top = make('div', 'hba-card-top');
      const identity = make('div');
      identity.append(
        make('div', 'hba-name', payment.customerName || payment.customer_name || 'Host booking'),
        make('div', 'hba-ref', payment.bookingGroupRef || payment.booking_group_ref || payment.bookingRef || payment.booking_ref || payment.bookingKey || '—'),
      );
      top.append(identity, make('div', 'hba-amount', money(payment.balanceAmount || payment.balance_amount || payment.expectedAmount || payment.expected_amount)));
      const meta = make('div', 'hba-meta');
      appendSummary(meta, 'Schedule', payment.scheduleLabel || payment.schedule_label || payment.bookingDate || payment.booking_date);
      appendSummary(meta, 'Court', payment.courtLabel || payment.court_label);
      appendSummary(meta, 'Method', String(payment.paymentProvider || payment.payment_provider || '—').toUpperCase());
      appendSummary(meta, 'New reference', payment.paymentReference || payment.payment_reference);
      const bottom = make('div', 'hba-bottom');
      bottom.appendChild(make('div', 'hba-status', 'Waiting for owner review'));
      const review = make('button', 'btn btn-p btn-sm', 'Review Receipt');
      review.type = 'button';
      review.addEventListener('click', event => openModal(payment, event.currentTarget));
      bottom.appendChild(review);
      card.append(top, meta, bottom);
      list.appendChild(card);
    });
  }

  function load(force) {
    if (!canDecide()) {
      state.payments = [];
      state.loadedAt = 0;
      state.loadState = 'forbidden';
      return Promise.resolve(state.payments);
    }
    if (global.PB_USE_LOCAL_DATA) {
      state.payments = [];
      state.loadedAt = Date.now();
      state.loadState = 'ready';
      return Promise.resolve(state.payments);
    }
    if (!force && state.loadedAt && Date.now() - state.loadedAt < 15000) return Promise.resolve(state.payments);
    if (state.loading) return state.loading;
    state.loadState = 'loading';
    state.loading = (async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const generation = state.generation;
          const payments = [];
          let offset = 0;
          for (let page = 0; page < 1000; page += 1) {
            const result = await apiCall('list_pending', { limit: 100, offset });
            const rows = result?.payments || result?.data?.payments || [];
            if (!Array.isArray(rows)) throw new Error('Pending balance response is invalid.');
            payments.push(...rows);
            const nextOffset = result?.nextOffset ?? result?.data?.nextOffset;
            if (nextOffset == null) break;
            if (!Number.isSafeInteger(Number(nextOffset)) || Number(nextOffset) <= offset) {
              throw new Error('Pending balance pagination is invalid.');
            }
            offset = Number(nextOffset);
            if (page === 999) throw new Error('Pending balance queue is too large to load safely.');
          }
          if (generation !== state.generation) continue;
          state.payments = payments;
          state.loadedAt = Date.now();
          state.loadState = 'ready';
          return state.payments;
        }
        throw new Error('Pending balances changed while loading. Refresh and try again.');
      } catch (error) {
        state.payments = [];
        state.loadedAt = 0;
        state.loadState = 'error';
        throw error;
      }
    })().finally(() => { state.loading = null; });
    return state.loading;
  }

  function render(force) {
    ensurePanel();
    const list = byId('hostBalanceAdminList');
    if (!canDecide()) {
      list?.replaceChildren(make('div', 'hba-empty', 'Only the System Owner or Court Owner can review host balance payments.'));
      return Promise.resolve([]);
    }
    if (list) list.replaceChildren(make('div', 'hba-empty', 'Loading host balance payments…'));
    return load(force).then(payments => {
      renderCards();
      return payments;
    }).catch(error => {
      list?.replaceChildren(make('div', 'hba-empty', error?.message || 'Could not load host balance payments.'));
      return [];
    });
  }

  async function reviewForBooking(booking, trigger) {
    if (!canDecide()) {
      notify('Only the System Owner or Court Owner can review host balance payments.', 'err');
      return false;
    }
    let payment = pendingForBooking(booking);
    if (!payment) {
      try { await load(true); }
      catch (error) {
        notify(error?.message || 'Could not load the pending balance receipt.', 'err');
        return false;
      }
      payment = pendingForBooking(booking);
    }
    if (!payment) {
      notify('This booking no longer has a balance receipt waiting for review.', 'inf');
      if (typeof global.renderBookings === 'function') global.renderBookings();
      return false;
    }
    await openModal(payment, trigger);
    return true;
  }

  function invalidate() {
    state.generation += 1;
    state.loadedAt = 0;
    if (state.loadState === 'ready') state.loadState = 'idle';
  }

  function install() {
    addStyles();
    ensurePanel();
    ensureModal();
    if (typeof global.renderPaymentReview === 'function' && !state.originalRenderPaymentReview) {
      state.originalRenderPaymentReview = global.renderPaymentReview;
      global.renderPaymentReview = async function wrappedPaymentReview() {
        const result = await state.originalRenderPaymentReview.apply(this, arguments);
        await render(false);
        return result;
      };
    }
  }

  global.HostBalanceAdmin = Object.freeze({
    install,
    load,
    render,
    invalidate,
    pendingForBooking,
    statusForBooking,
    reviewForBooking,
    open: openModal,
    close: closeModal,
  });
  install();
})(window);

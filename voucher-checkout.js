/* Server-authoritative voucher prices for existing atomic booking holds. */
(function () {
  'use strict';
  let quote = null;
  let busy = false;
  const el = id => document.getElementById(id);
  const contact = () => ({ name: el('bName').value.trim(), email: el('bEmail').value.trim(), phone: el('bPhone').value.trim() });
  function current() { return quote && quote.ref === _reservedRef ? quote : null; }
  function summary() {
    const q = current();
    return q?.code ? `<div class="pbs-price-row"><span>Original price</span><strong>${fmt(q.originalTotal)}</strong></div><div class="pbs-price-row"><span>Voucher savings</span><strong>−${fmt(q.discount)}</strong></div>` : '';
  }
  function render() {
    const q = current();
    el('voucherMessage').textContent = q?.code ? `${q.code} applied. You save ${fmt(q.discount)}. Total ${fmt(q.total)}.` : 'One voucher per booking. No additional booking fees.';
    el('voucherRemove').hidden = !q?.code;
    el('voucherApply').disabled = busy || !!q?.code;
    el('voucherRemove').disabled = busy;
    el('voucherCode').disabled = busy || !!q?.code;
    for (const id of ['bName','bEmail','bPhone']) el(id).readOnly = !!q?.code;
    if (typeof updateWiz3Summary === 'function') updateWiz3Summary();
    if (typeof updatePrice === 'function') updatePrice();
  }
  async function action(name) {
    if (busy) return;
    busy = true; render();
    try {
      quote = await DB.bookingVoucher(name, _reservedRef, el('voucherCode').value, contact());

      render();
    } catch (error) { el('voucherMessage').textContent = error.message || 'Could not apply voucher.'; }
    finally {
      busy = false;
      el('voucherApply').disabled = !!current()?.code;
      el('voucherRemove').disabled = false;
      el('voucherCode').disabled = !!current()?.code;
    }
  }
  function free() { return !!current()?.code && Number(current().total) === 0; }
  function payment() {
    if (!free()) return false;
    el('bPay').value = 'voucher';
    for (const id of ['gcashBox','pnbBox']) el(id)?.classList.remove('show');
    for (const id of ['gcashRefWrap','cashNote']) if (el(id)) el(id).style.display = 'none';
    el('voucherFreeNotice').hidden = false;
    el('bookingPolicyText').textContent = 'I agree to the booking rules. This complimentary voucher is used when the booking is confirmed and is not restored after cancellation or a no-show.';
    return true;
  }
  async function confirm() {
    if (busy || _bookingSubmissionInFlight) return;
    if (!el('bookingPolicyAgree').checked) { toast('Please agree to the booking rules.', 'err'); return; }
    busy = true; _bookingSubmissionInFlight = true;
    el('wizNextBtn').disabled = true;
    try {
      const q = await DB.bookingVoucher('confirm', _reservedRef);
      if (!q.complimentary) throw new Error('Booking confirmation could not be verified.');
      const identity = contact();
      const items = activeBookingItems().map(item => ({ ...item, ...hostBookingIdentity(), fullName: identity.name, email: identity.email,
        contactNumber: identity.phone, status: 'confirmed', paymentStatus: 'complimentary', paymentMethod: 'voucher', downpayment: 0,
        voucherCode: q.code, voucherOriginalTotal: item.voucherOriginalTotal, voucherDiscount: item.voucherDiscount }));
      const booking = { ...items[0], groupItems: items, total: 0, downpayment: 0,
        courtName: bookingItemsCourtLabel(items), timeLabel: bookingItemsTimeLabel(items), duration: bookingItemsDuration(items),
        voucherOriginalTotal: q.originalTotal, voucherDiscount: q.discount };
      stopSlotCountdown();
      showInvoice(booking);
      sendCustomerConfirmationEmail(booking);
      resetForm({ preserveReceiptEvidence: true });
      await refreshBookingItemViews(items);
      toast('Complimentary booking confirmed.', 'ok');
    } catch (error) { toast(error.message || 'Could not confirm complimentary booking.', 'err'); }
    finally { busy = false; _bookingSubmissionInFlight = false; el('wizNextBtn').disabled = false; }
  }
  window.VoucherCheckout = {
    summary, free, payment, confirm,
    async sync() {
      if (busy) throw new Error('Please wait for the voucher request to finish.');
      if (!_reservedRef) return;
      const q = await DB.bookingVoucher('status', _reservedRef);
      quote = q;
      render();
    },
    reset() { quote = null; el('voucherFreeNotice').hidden = true; el('voucherCode').value = ''; render(); },
    priceItems(items) {
      const q = current();
      if (!q) return items;
      return items.map(item => {
        const price = q.items.find(row => row.ref === item.ref);
        if (!price) return item;
        const coveredFee = Number(price.serviceFee ?? Math.min(Number(item.serviceFee || 0), price.total));
        return { ...item, total: price.total, courtFee: Math.max(0, price.total - coveredFee), serviceFee: coveredFee,
          voucherCode: q.code, voucherOriginalTotal: price.originalTotal, voucherDiscount: price.discount, voucherDue: price.due };
      });
    },
  };
  el('voucherApply').addEventListener('click', () => action('apply'));
  el('voucherRemove').addEventListener('click', () => action('remove'));
  el('voucherCode').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); action('apply'); } });
})();

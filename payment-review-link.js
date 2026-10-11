(function (root) {
  'use strict';
  const kinds = ['booking', 'host_balance', 'open_play', 'host_session'];
  function target(value) {
    return value && kinds.includes(value.kind) && typeof value.subject_id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value.subject_id)
      ? { kind: value.kind, subject_id: value.subject_id } : null;
  }
  function fromSearch(search) {
    const p = new URLSearchParams(search);
    return target({kind:p.get('review_kind'),subject_id:p.get('review_id')});
  }
  function path(value) {
    const p = target(value);
    return '/admin' + (p ? '?review_kind=' + encodeURIComponent(p.kind) + '&review_id=' + encodeURIComponent(p.subject_id) : '') + '#payreview';
  }
  async function open(value, {resolve, openers, notify}) {
    const p=target(value);
    if (!p) return false;
    const result=await resolve(p);
    if (!result.pending) { notify('This payment is no longer awaiting manual review. It may already have been confirmed, rejected, or automatically approved.'); return true; }
    if (result.kind !== p.kind || !target({kind:result.kind,subject_id:result.id}) || !openers[result.kind]) throw new Error('The payment could not be opened. Refresh and try again.');
    await openers[result.kind](result.id);
    return true;
  }
  const api=Object.freeze({target,fromSearch,path,open});
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.PaymentReviewLink=api;
})(typeof self!=='undefined'?self:globalThis);

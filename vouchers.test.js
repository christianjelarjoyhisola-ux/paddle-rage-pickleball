const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const finance = require('./finance-core.js');
const base = { ref:'TEST', total:0, downpayment:0, status:'confirmed', paymentStatus:'complimentary',
  voucherCode:'FREE-TEST',voucherOriginalTotal:1200,voucherDiscount:1200,
  bookingFeeAmountSnapshot:30,bookingFeeEarnedAt:'2026-09-22T08:00:00Z',duration:1 };

test('complimentary booking keeps a fee obligation without fabricating cash revenue',()=>{
  const m=finance.bookingMetrics(base);
  assert.equal(m.paid,0);assert.equal(m.outstanding,0);assert.equal(m.feeEarned,30);
  assert.equal(m.feeCollected,0);assert.equal(m.ownerFundedFee,30);assert.equal(m.netAfterFeeObligation,-30);
  assert.equal(m.originalTotal,1200);assert.equal(m.discount,1200);
  const r=finance.build({transactions:[base]});
  assert.equal(r.summary.collected,0);assert.equal(r.summary.platformFeesEarned,30);
  assert.equal(r.summary.ownerFundedFees,30);
  assert.equal(r.breakdowns.stream.find(x=>x.label==='Platform booking fees').collected,0);
});
test('ordinary discounts preserve fee once; below-fee totals expose only owner shortfall',()=>{
  for(const [total,discount,ownerFunded,net] of [[1080,120,0,1050],[20,1180,10,-10]]){
    const m=finance.bookingMetrics({...base,total,downpayment:total,paymentStatus:'paid',voucherDiscount:discount});
    assert.equal(m.feeCharged,30);assert.equal(m.ownerFundedFee,ownerFunded);assert.equal(m.netAfterFeeObligation,net);
  }
});
test('grouped vouchers aggregate original prices, discounts and fee obligations',()=>{
  const m=finance.bookingMetrics({...base,total:0,items:[base,{...base,ref:'SECOND',bookingFeeAmountSnapshot:20}]});
  assert.equal(m.originalTotal,2400);assert.equal(m.discount,2400);assert.equal(m.feeEarned,50);assert.equal(m.ownerFundedFee,50);
});
test('checkout applies server values and restores original amounts after removal or resume',async()=>{
  const elements=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,{value:'',readOnly:false,hidden:false,disabled:false,textContent:'',addEventListener(){}});return elements.get(id);};
  let response={ref:'TEST',code:'FREE-TEST',total:0,originalTotal:1200,discount:1200,items:[{ref:'TEST',total:0,originalTotal:1200,discount:1200,serviceFee:0,due:0}]};
  const context={window:{},document:{getElementById:element},_reservedRef:'TEST',DB:{bookingVoucher:async()=>response},fmt:String,updateWiz3Summary(){},updatePrice(){}};
  vm.runInNewContext(fs.readFileSync('voucher-checkout.js','utf8'),context);
  const api=context.window.VoucherCheckout;
  await api.sync();assert.equal(api.free(),true);
  let p=api.priceItems([{ref:'TEST',total:1200,serviceFee:30}])[0];assert.equal(p.total,0);assert.equal(p.serviceFee,0);assert.equal(p.voucherDiscount,1200);
  assert.equal(element('bEmail').readOnly,true);
  response={ref:'TEST',code:null,total:1200,items:[{ref:'TEST',total:1200,originalTotal:1200,discount:0,serviceFee:30,due:1200}]};
  await api.sync();p=api.priceItems([{ref:'TEST',total:0,serviceFee:0}])[0];assert.equal(p.total,1200);assert.equal(p.serviceFee,30);assert.equal(api.free(),false);
  context._reservedRef='OTHER';assert.equal(api.priceItems([{ref:'OTHER',total:500}])[0].total,500);
});

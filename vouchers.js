(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(n || 0));
  let state;
  const notice = text => { $('notice').textContent = text; };
  function assignments() {
    const allowed = state.assignments.filter(x => x.user_id === $('authorityOwner').value).map(x => x.court_id);
    $('authorityCourts').innerHTML = state.courts.map(c => `<label><input type="checkbox" name="courtIds" value="${esc(c.id)}" ${allowed.includes(c.id)?'checked':''}>${esc(c.name)}</label>`).join('');
  }
  async function load() {
    state = await DB.manageVouchers();
    $('workspace').hidden = false;
    const selected = [...$('courtOptions').querySelectorAll('input:checked')].map(x => x.value);
    $('courtOptions').innerHTML = state.courts.map(c => `<label><input type="checkbox" name="courtIds" value="${esc(c.id)}" ${selected.includes(c.id)?'checked':''}>${esc(c.name)}</label>`).join('') || '<p>No courts assigned. Ask the system owner to assign voucher funding permissions.</p>';
    $('authority').hidden = !state.owners.length;
    $('authorityOwner').innerHTML = state.owners.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
    assignments();
    $('campaigns').innerHTML = state.campaigns.map(c => `<article><h2>${esc(c.name)}</h2><p>${c.kind==='percent'?`${Number(c.value)}%`:money(c.value)} off · ${esc(c.state)} · ${c.used}/${c.max_uses} used · ${c.reserved} reserved · ${money(c.discounts)} redeemed discounts</p><p class="muted">${esc(new Date(c.starts_at).toLocaleString('en-PH',{timeZone:'Asia/Manila'}))} – ${esc(new Date(c.ends_at).toLocaleString('en-PH',{timeZone:'Asia/Manila'}))} PH</p><details><summary>${c.codes.length} voucher code(s)</summary><textarea readonly aria-label="Voucher codes">${esc(c.codes.join('\n'))}</textarea><button type="button" class="secondary" data-copy="${esc(c.id)}">Copy codes</button></details><details><summary>Bookings and redemption history</summary><div class="scroll"><table><thead><tr><th>Booking</th><th>Status</th><th>Discount</th></tr></thead><tbody>${c.redemptions.map(r=>`<tr><td>${esc(r.booking)}</td><td>${esc(r.state)}</td><td>${money(r.discount)}</td></tr>`).join('') || '<tr><td colspan="3">No redemptions yet.</td></tr>'}</tbody></table></div></details><div class="actions"><button type="button" class="secondary" data-state="${c.state==='active'?'paused':'active'}" data-id="${esc(c.id)}">${c.state==='active'?'Pause':'Activate'}</button>${c.state!=='archived'?`<button type="button" class="secondary" data-state="archived" data-id="${esc(c.id)}">Archive</button>`:''}</div></article>`).join('') || '<p>No voucher campaigns yet.</p>';
  }
  $('weekdays').innerHTML = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d,i)=>`<label><input type="checkbox" name="weekdays" value="${i}" checked>${d}</label>`).join('');
  const phDate = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()).replace(' ','T');
  const fields = $('campaignForm').elements;
  const hourLabel = hour => hour === 24 ? 'Midnight · next day' : (hour % 12 || 12) + (hour < 12 ? ' AM' : ' PM');
  function hourOptions(start, end) { return Array.from({length:end-start+1},(_,i)=>{const hour=start+i;return '<option value="'+hour+'">'+hourLabel(hour)+'</option>';}).join(''); }
  for (const name of ['startHour','endHour','hourFrom']) fields[name].innerHTML = hourOptions(0,23);
  fields.hourTo.innerHTML = hourOptions(1,24);
  fields.startsAt.value = phDate.slice(0,10);
  fields.startHour.value = String(Number(phDate.slice(11,13)));
  fields.endHour.value = '23';
  fields.hourTo.value = '24';
  fields.mode.addEventListener('change',()=>{
    const single=fields.mode.value==='single';
    $('batchSizeField').hidden=!single;
    $('customCodeField').hidden=single;
    if(single) fields.code.value='';
  });
  $('campaignForm').addEventListener('submit', async event => {
    event.preventDefault(); const form=event.currentTarget; const button=form.querySelector('button[type=submit]'); button.disabled=true;
    try {
      const fd=new FormData(form), data=Object.fromEntries(fd);
      data.courtIds=fd.getAll('courtIds'); data.bookingTypes=fd.getAll('bookingTypes'); data.weekdays=fd.getAll('weekdays').map(Number);
      data.startsAt += 'T'+String(data.startHour).padStart(2,'0')+':00:00+08:00';
      data.endsAt += 'T'+String(data.endHour).padStart(2,'0')+':00:00+08:00';
      if(data.endsAt<=data.startsAt) throw new Error('End date and time must be after the start.');
      data.acceptOwnerFees=fd.has('acceptOwnerFees'); data.singleUse=data.mode==='single';
      if (!data.singleUse) data.batchSize=1;
      if (data.kind==='percent' && Number(data.value)>100) throw new Error('Percentage discounts cannot exceed 100%.');
      if (!data.courtIds.length || !data.bookingTypes.length || !data.weekdays.length) throw new Error('Choose courts, booking types and weekdays.');
      const result=await DB.manageVouchers('create',data); await load(); notice(`Campaign created with ${result.codes.length} code(s). Original booking fees remain payable by the court owner.`);
    } catch(e) { notice(e.message); } finally { button.disabled=false; }
  });
  $('campaigns').addEventListener('click',async event=>{
    const button=event.target.closest('button'); if(!button)return; button.disabled=true;
    try {
      if(button.dataset.copy){const c=state.campaigns.find(c=>c.id===button.dataset.copy);await navigator.clipboard.writeText(c.codes.join('\n'));notice('Codes copied.');}
      else {await DB.manageVouchers('state',{id:button.dataset.id,state:button.dataset.state});await load();notice('Campaign updated. Existing reservations are honored.');}
    }catch(e){notice(e.message);}finally{button.disabled=false;}
  });
  $('authorityOwner').addEventListener('change',assignments);
  $('authorityForm').addEventListener('submit',async event=>{event.preventDefault();try{await DB.manageVouchers('assign',{userId:$('authorityOwner').value,courtIds:[...$('authorityCourts').querySelectorAll('input:checked')].map(x=>x.value)});await load();notice('Funding permissions saved.');}catch(e){notice(e.message);}});
  $('refresh').addEventListener('click',()=>load().then(()=>notice('Updated.')).catch(e=>notice(e.message)));
  load().then(()=>notice('')).catch(e=>notice(`${e.message || 'Owner sign-in required.'} Sign in through the dashboard to manage vouchers.`));
})();

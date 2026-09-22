(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = n => new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(n || 0));
  let state;
  let courtsInitialized = false;
  const notice = text => { $('notice').textContent = text; };
  function assignments() {
    const allowed = state.assignments.filter(x => x.user_id === $('authorityOwner').value).map(x => x.court_id);
    $('authorityCourts').innerHTML = state.courts.map(c => `<label><input type="checkbox" name="courtIds" value="${esc(c.id)}" ${allowed.includes(c.id)?'checked':''}>${esc(c.name)}</label>`).join('');
  }
  async function load() {
    state = await DB.manageVouchers();
    $('workspace').hidden = false;
    const selected = [...$('courtOptions').querySelectorAll('input:checked')].map(x => x.value);
    $('courtOptions').innerHTML = state.courts.map(c => `<label><input type="checkbox" name="courtIds" value="${esc(c.id)}" ${(!courtsInitialized || selected.includes(c.id))?'checked':''}>${esc(c.name)}</label>`).join('') || '<p>No courts assigned. Ask the system owner to assign voucher funding permissions.</p>';
    courtsInitialized = true;
    $('authority').hidden = !state.owners.length;
    $('authorityOwner').innerHTML = state.owners.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('');
    assignments();
    $('campaigns').innerHTML = state.campaigns.map(c => `<article><div class="campaign-top"><div><h2>${esc(c.name)}</h2><p><span class="state-pill">${esc(c.state)}</span> · ${c.used}/${c.max_uses} used</p></div><span class="discount-badge">${c.kind==='percent'?`${Number(c.value)}%`:money(c.value)}<small style="font-size:12px;letter-spacing:0;margin-left:4px">off</small></span></div><p class="muted">${esc(new Date(c.starts_at).toLocaleString('en-PH',{timeZone:'Asia/Manila',month:'short',day:'numeric',year:'numeric',hour:'numeric',hour12:true}))} – ${esc(new Date(c.ends_at).toLocaleString('en-PH',{timeZone:'Asia/Manila',month:'short',day:'numeric',year:'numeric',hour:'numeric',hour12:true}))} PH</p><details><summary>${c.codes.length} voucher code(s)</summary><textarea readonly aria-label="Voucher codes">${esc(c.codes.join('\n'))}</textarea><button type="button" class="secondary" data-copy="${esc(c.id)}">Copy codes</button></details><details><summary>Usage</summary><p class="muted">${c.reserved} reserved · ${money(c.discounts)} savings</p><div class="scroll"><table><thead><tr><th>Booking</th><th>Status</th><th>Discount</th></tr></thead><tbody>${c.redemptions.map(r=>`<tr><td>${esc(r.booking)}</td><td>${esc(r.state)}</td><td>${money(r.discount)}</td></tr>`).join('') || '<tr><td colspan="3">No redemptions yet.</td></tr>'}</tbody></table></div></details><div class="actions"><button type="button" class="secondary" data-state="${c.state==='active'?'paused':'active'}" data-id="${esc(c.id)}">${c.state==='active'?'Pause':'Activate'}</button>${c.state!=='archived'?`<button type="button" class="secondary" data-state="archived" data-id="${esc(c.id)}">Archive</button>`:''}</div></article>`).join('') || '<div class="empty">Your vouchers will appear here.</div>';
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
  const dateText = value => new Intl.DateTimeFormat('en-PH',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z'));
  const isoDate = date => date.toISOString().slice(0,10);
  const nextWeek = new Date(fields.startsAt.value+'T12:00:00Z'); nextWeek.setUTCDate(nextWeek.getUTCDate()+7);
  fields.endsAt.value = isoDate(nextWeek);
  let dateTarget = null, calendarYear, calendarMonth;
  function renderDateLabels() {
    document.querySelectorAll('[data-date]').forEach(button=>{
      const value=fields[button.dataset.date].value;
      button.textContent=value?dateText(value):'Any date';
      button.setAttribute('aria-label',({startsAt:'Start date',endsAt:'Expiry date',playFrom:'Play from',playTo:'Play until'})[button.dataset.date]+': '+button.textContent);
    });
  }
  function renderCalendar() {
    const first=new Date(Date.UTC(calendarYear,calendarMonth,1));
    const days=new Date(Date.UTC(calendarYear,calendarMonth+1,0)).getUTCDate();
    $('calendarMonth').textContent=new Intl.DateTimeFormat('en-PH',{month:'long',year:'numeric',timeZone:'UTC'}).format(first);
    let html=['S','M','T','W','T','F','S'].map(d=>'<span aria-hidden="true">'+d+'</span>').join('');
    html+='<span aria-hidden="true"></span>'.repeat(first.getUTCDay());
    for(let day=1;day<=days;day++) {
      const value=isoDate(new Date(Date.UTC(calendarYear,calendarMonth,day)));
      html+='<button type="button" data-day="'+value+'" aria-label="'+dateText(value)+'" aria-pressed="'+(fields[dateTarget].value===value)+'">'+day+'</button>';
    }
    $('calendarDays').innerHTML=html;
  }
  document.querySelectorAll('[data-date]').forEach(button=>button.addEventListener('click',()=>{
    dateTarget=button.dataset.date;
    const current=new Date((fields[dateTarget].value||fields.startsAt.value)+'T12:00:00Z');
    calendarYear=current.getUTCFullYear();calendarMonth=current.getUTCMonth();
    $('clearDate').hidden=!['playFrom','playTo'].includes(dateTarget);
    renderCalendar();$('dateDialog').showModal();
  }));
  for(const [id,step] of [['monthPrev',-1],['monthNext',1]]) $(id).addEventListener('click',()=>{
    const next=new Date(Date.UTC(calendarYear,calendarMonth+step,1));calendarYear=next.getUTCFullYear();calendarMonth=next.getUTCMonth();renderCalendar();
  });
  $('calendarDays').addEventListener('click',event=>{
    const button=event.target.closest('button[data-day]');if(!button)return;
    fields[dateTarget].value=button.dataset.day;renderDateLabels();$('dateDialog').close();
  });
  $('clearDate').addEventListener('click',()=>{fields[dateTarget].value='';renderDateLabels();$('dateDialog').close();});
  $('closeDate').addEventListener('click',()=>$('dateDialog').close());
  renderDateLabels();
  $('offerPresets').addEventListener('click',event=>{
    const button=event.target.closest('[data-offer]');if(!button)return;
    const custom=button.dataset.offer==='custom';
    $('customOffer').hidden=!custom;
    if(!custom){fields.kind.value='percent';fields.value.value=button.dataset.offer;}
    $('offerPresets').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
    if(custom)fields.value.focus();
  });
  function syncCodeFields() {
    const single=fields.mode.value==='single';
    const batch=single && Number(fields.batchSize.value)>1;
    $('batchSizeField').hidden=!single;
    $('customCodeField').hidden=batch;
    fields.code.disabled=batch;
  }
  fields.mode.addEventListener('change',syncCodeFields);
  fields.batchSize.addEventListener('input',syncCodeFields);
  syncCodeFields();
  $('campaignForm').addEventListener('submit', async event => {
    event.preventDefault(); const form=event.currentTarget; const button=form.querySelector('button[type=submit]'); button.disabled=true;
    try {
      const fd=new FormData(form), data=Object.fromEntries(fd);
      data.courtIds=fd.getAll('courtIds'); data.bookingTypes=fd.getAll('bookingTypes'); data.weekdays=fd.getAll('weekdays').map(Number);
      if(!data.startsAt || !data.endsAt) throw new Error('Choose the start and expiry dates.');
      data.startsAt += 'T'+String(data.startHour).padStart(2,'0')+':00:00+08:00';
      data.endsAt += 'T'+String(data.endHour).padStart(2,'0')+':00:00+08:00';
      if(data.endsAt<=data.startsAt) throw new Error('End date and time must be after the start.');
      data.acceptOwnerFees=fd.has('acceptOwnerFees'); data.singleUse=data.mode==='single';
      if (!data.singleUse) data.batchSize=1;
      if (data.kind==='percent' && Number(data.value)>100) throw new Error('Percentage discounts cannot exceed 100%.');
      if (!data.courtIds.length || !data.bookingTypes.length || !data.weekdays.length) throw new Error('Choose courts, booking types and weekdays.');
      const result=await DB.manageVouchers('create',data); await load(); notice(`Voucher created · ${result.codes.length} code(s).`);
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

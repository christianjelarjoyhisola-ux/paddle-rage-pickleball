(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.PaidScheduleEditor=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const key=s=>`${s.courtId}|${s.date}|${s.hour}`;
  function blocks(slots){
    const sorted=[...slots].sort((a,b)=>a.date.localeCompare(b.date)||a.courtId.localeCompare(b.courtId)||a.hour-b.hour);
    const result=[];
    for(const s of sorted){
      const last=result[result.length-1];
      if(last&&last.courtId===s.courtId&&last.date===s.date&&last.end===s.hour) last.end++;
      else result.push({courtId:s.courtId,date:s.date,start:s.hour,end:s.hour+1});
    }
    return result;
  }
  function initialSlots(item){return item.slots.map(h=>({courtId:item.courtId,date:item.date,hour:Number(h)}));}
  function validate(items,selections){
    const occupied=new Set(); let count=0,changed=false;
    for(const item of items){
      const slots=selections[item.bookingRef]||[];
      if(slots.length!==Number(item.duration)) return `Select exactly ${item.duration} paid hours for ${item.courtName} (${item.bookingRef}).`;
      for(const s of slots){
        if(!s.courtId||!/^\d{4}-\d{2}-\d{2}$/.test(s.date)||!Number.isInteger(s.hour)||s.hour<0||s.hour>23) return 'Choose valid hourly slots.';
        if(occupied.has(key(s))) return 'A court/time slot is selected more than once.';
        occupied.add(key(s));
      }
      count+=blocks(slots).length;
      if(JSON.stringify(slots.map(key).sort())!==JSON.stringify(initialSlots(item).map(key).sort())) changed=true;
    }
    if(count>8) return 'Choose at most eight continuous court/time portions for this reservation.';
    if(!changed) return 'Choose a different court or time before saving.';
    return '';
  }
  function changes(items,selections){return items.map(i=>({bookingRef:i.bookingRef,expectedDate:i.date,
    expectedCourtId:i.courtId,expectedSlots:i.slots,expectedTotal:Number(i.total),slots:selections[i.bookingRef].map(s=>({...s}))}));}
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const hour=h=>`${h%12||12}:00 ${h%24<12?'AM':'PM'}`;
  let active=null,opening=false;
  async function open(ref,options){
    if(active||opening) return;
    const trigger=document.activeElement, today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Manila'});
    let data;opening=true;
    try{data=await options.load(ref,today);}finally{opening=false;}
    const state={ref,options,items:data.items,courts:data.courts,selected:{},index:0,date:today,sequence:0,loading:false,ready:false,saving:false,review:false,trigger};
    data.items.forEach(i=>{state.selected[i.bookingRef]=initialSlots(i);});
    const firstDate=data.items[0]?.date;
    if(firstDate&&firstDate>=today) state.date=firstDate;
    const overlay=document.createElement('div'); overlay.className='pse-overlay';
    overlay.innerHTML=`<section class="pse-modal" role="dialog" aria-modal="true" aria-labelledby="pseTitle" tabindex="-1">
      <header><div><h2 id="pseTitle">Change court & time slots</h2><p>${escape(data.fullName)} · ${escape(data.bookingRef)}</p></div><button type="button" data-action="close" aria-label="Close schedule editor">×</button></header>
      <div class="pse-body"><p class="pse-policy">Keep all ${data.items.reduce((n,i)=>n+Number(i.duration),0)} paid court-hours. Your total payment stays the same. Select hourly slots across courts and dates; consecutive slots are combined. Up to 8 schedule portions.</p>
      <div class="pse-edit"><label>Paid booking portion<select id="pseItem">${data.items.map((i,n)=>`<option value="${n}">${escape(i.courtName)} · ${escape(i.date)} · ${escape(i.startTime)}–${escape(i.endTime)}</option>`).join('')}</select></label>
      <p id="pseOriginal"></p><div class="pse-tools"><label>Choose date<input id="pseDate" type="date" min="${today}" value="${state.date}"></label><button type="button" data-action="clear">Clear this portion’s selection</button></div>
      <div id="pseLoading" role="status"></div><div id="pseGrid" class="pse-grid"></div></div>
      <div id="pseSummary"></div><label>Note to customer<textarea id="pseNote" maxlength="1200" rows="2" placeholder="Optional reason for the change"></textarea></label>
      <p id="pseStatus" role="status"></p><p id="pseError" role="alert" hidden></p></div>
      <footer><button type="button" data-action="back">Cancel</button><button type="button" data-action="save" class="pse-primary">Review changes</button></footer></section>`;
    state.el=overlay;state.priorOverflow=document.body.style.overflow;active=state;
    document.body.append(overlay);document.body.style.overflow='hidden';
    const $=id=>overlay.querySelector('#'+id);state.$=$;
    $('pseItem').addEventListener('change',()=>{state.index=Number($('pseItem').value);render(state);});
    $('pseDate').addEventListener('change',()=>{state.date=$('pseDate').value;void load(state);});
    overlay.addEventListener('click',e=>{
      const button=e.target.closest('button');if(!button||state.saving)return;
      const action=button.dataset.action;
      if(action==='close')close(state);
      if(action==='back'){if(state.review){state.review=false;render(state);}else close(state);}
      if(action==='clear'){state.selected[state.items[state.index].bookingRef]=[];render(state);}
      if(action==='retry')void load(state);
      if(action==='slot'){
        const item=state.items[state.index], s={courtId:button.dataset.court,date:state.date,hour:Number(button.dataset.hour)};
        const list=state.selected[item.bookingRef],n=list.findIndex(x=>key(x)===key(s));
        if(n>=0)list.splice(n,1);else if(list.length<Number(item.duration))list.push(s);
        render(state);
        const replacement=[...overlay.querySelectorAll('[data-action="slot"]')].find(el=>el.dataset.court===s.courtId&&Number(el.dataset.hour)===s.hour);
        if(replacement&&!replacement.disabled)replacement.focus();
      }
      if(action==='same'){
        const item=state.items[state.index],court=state.courts.find(c=>c.id===button.dataset.court);
        state.selected[item.bookingRef]=item.slots.map(h=>({courtId:court.id,date:state.date,hour:Number(h)}));render(state);
      }
      if(action==='save')void save(state);
    });
    overlay.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&!state.saving){e.preventDefault();close(state);}
      if(e.key==='Tab'){
        const targets=[...overlay.querySelectorAll('button,input,select,textarea')].filter(x=>!x.disabled&&x.getClientRects().length);
        const first=targets[0],last=targets[targets.length-1];
        if(e.shiftKey&&(document.activeElement===first||!targets.includes(document.activeElement))){e.preventDefault();last?.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
      }
    });
    overlay.querySelector('section').focus();render(state);await load(state);
  }
  function close(s){if(s.saving)return;s.sequence++;s.el.remove();document.body.style.overflow=s.priorOverflow;active=null;if(s.trigger?.isConnected)s.trigger.focus();}
  function render(s){
    const $=s.$,item=s.items[s.index],list=s.selected[item.bookingRef];
    const other=new Set(s.items.filter(i=>i!==item).flatMap(i=>s.selected[i.bookingRef].map(key)));
    const visibleHours=s.courts.flatMap(c=>c.hours).concat(s.items.flatMap(i=>s.selected[i.bookingRef].filter(x=>x.date===s.date).map(x=>x.hour)));
    const firstHour=visibleHours.length?Math.min(...visibleHours):8,lastHour=visibleHours.length?Math.max(...visibleHours):23;
    $('pseOriginal').textContent=`Original: ${item.courtName} · ${item.date} · ${item.startTime}–${item.endTime}. Selected ${list.length} / ${item.duration} paid hours.`;
    s.el.querySelector('.pse-edit').hidden=s.review;
    $('pseGrid').innerHTML=s.loading?'':s.courts.map(c=>{
      const same=item.slots.every(h=>c.hours.includes(Number(h))&&!other.has(key({courtId:c.id,date:s.date,hour:Number(h)})));
      return `<section><h3>${escape(c.name)}</h3><button type="button" data-action="same" data-court="${escape(c.id)}" ${same?'':'disabled'}>Use original times here</button><div class="pse-hours">${Array.from({length:lastHour-firstHour+1},(_,offset)=>{ const h=offset+firstHour;
        const k=key({courtId:c.id,date:s.date,hour:h}),selected=list.some(x=>key(x)===k);
        const unavailable=!c.hours.includes(h)||other.has(k);const disabled=unavailable||(!selected&&list.length>=Number(item.duration));
        return `<button type="button" data-action="slot" data-court="${escape(c.id)}" data-hour="${h}" aria-pressed="${selected}" ${disabled?'disabled':''} title="${unavailable?'Unavailable':selected?'Selected':'Available'}">${hour(h)}–${hour(h+1)}${selected?' ✓':''}</button>`;
      }).join('')}</div></section>`;
    }).join('');
    const courtName=id=>s.courts.find(c=>c.id===id)?.name||s.items.find(i=>i.courtId===id)?.courtName||id;
    $('pseSummary').innerHTML=`<h3>${s.review?'Review changes':'Selected schedule'}</h3>${s.items.map(i=>`<div class="pse-summary-item">${s.review?`<p><strong>From:</strong> ${escape(i.courtName)} · ${escape(i.date)} · ${escape(i.startTime)}–${escape(i.endTime)}</p>`:''}<ul>${blocks(s.selected[i.bookingRef]).map(b=>`<li>${escape(courtName(b.courtId))} · ${escape(b.date)} · ${hour(b.start)}–${hour(b.end)}</li>`).join('')||'<li>No slots selected</li>'}</ul></div>`).join('')}<p><strong>Payment unchanged: ₱${s.items.reduce((n,i)=>n+Number(i.total),0).toLocaleString('en-PH',{minimumFractionDigits:2})}</strong></p>`;
    const error=validate(s.items,s.selected);
    $('pseStatus').textContent=error||(s.review?'All paid hours preserved. Saving will update the reservation and email the customer.':'All paid hours selected. Review the new courts and times before saving.');
    s.el.querySelector('[data-action="save"]').textContent=s.saving?'Saving…':s.review?'Save changes & notify':'Review changes';
    s.el.querySelector('[data-action="back"]').textContent=s.review?'Back to slots':'Cancel';
    s.el.querySelectorAll('button,input,select,textarea').forEach(el=>{if(s.saving)el.disabled=true;});
    s.el.querySelector('[data-action="save"]').disabled=s.saving||s.loading||!s.ready||Boolean(error);
  }
  async function load(s){
    const seq=++s.sequence;s.loading=true;s.ready=false;s.$('pseError').hidden=true;s.$('pseLoading').textContent='Checking available courts and hours…';render(s);
    try{
      const data=await s.options.load(s.ref,s.date);
      if(active!==s||seq!==s.sequence)return;
      if(JSON.stringify(data.items)!==JSON.stringify(s.items))throw new Error('The booking changed. Close and reopen this editor before saving.');
      s.courts=data.courts;s.ready=true;s.$('pseLoading').textContent='Tap slots to select or deselect. Grey slots are unavailable or your paid-hour limit is reached.';
    }catch(e){if(active!==s||seq!==s.sequence)return;s.courts=[];s.$('pseLoading').innerHTML='Availability could not be loaded. <button type="button" data-action="retry">Retry</button>';s.$('pseError').textContent=e.message;s.$('pseError').hidden=false;}
    finally{if(active===s&&seq===s.sequence){s.loading=false;render(s);}}
  }
  async function save(s){
    if(s.saving||s.loading||!s.ready||validate(s.items,s.selected))return;
    if(!s.review){s.review=true;render(s);s.el.querySelector('.pse-body').scrollTop=0;return;}
    s.saving=true;s.$('pseError').hidden=true;const note=s.$('pseNote').value;render(s);
    try{
      const result=await s.options.save(s.ref,changes(s.items,s.selected),note);
      s.saving=false;close(s);await s.options.saved(result);
    }catch(e){s.saving=false;s.el.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=false);s.review=false;await load(s);s.$('pseError').textContent=e.message||'Nothing was changed. Please retry.';s.$('pseError').hidden=false;}
  }
  return {open,blocks,validate,changes,initialSlots};
});

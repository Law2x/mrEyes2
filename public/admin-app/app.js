// ===== Helpers =====
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(s=''){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function pillForStatus(status){
  switch(status){
    case 'paid': return `<span class="pill accent">Confirmed</span>`;
    case 'out_for_delivery': return `<span class="pill warn">Out for delivery</span>`;
    case 'completed': return `<span class="pill ok">Delivered</span>`;
    case 'canceled': return `<span class="pill danger">Canceled</span>`;
    default: return `<span class="pill">${escapeHtml(status||'—')}</span>`;
  }
}
function pillForStage(stage){
  const map = { "-1":"Canceled","0":"Confirmed","1":"Out for delivery","2":"Delivered" };
  const cls = stage===-1?'danger':stage===0?'accent':stage===1?'warn':'ok';
  return `<span class="pill ${cls}">${map[String(stage)]||'—'}</span>`;
}

function toast(msg, t=1800){
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  setTimeout(()=>{ el.hidden = true; }, t);
}

// ===== Telegram WebApp initData header =====
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.expand(); // fullscreen feel inside Telegram
}
const INIT_DATA = tg?.initData || "";
const BASE_HEADERS = {
  "Content-Type": "application/json",
  "X-Telegram-Init-Data": INIT_DATA
};

// ===== State =====
let ALL = [];
let FILTER = "all"; // "all" | -1 | 0 | 1 | 2

// ===== Rendering =====
function renderStats(list){
  const all = list.length;
  const c0 = list.filter(o => o.statusStage === 0).length;
  const c1 = list.filter(o => o.statusStage === 1).length;
  const c2 = list.filter(o => o.statusStage === 2).length;
  const cX = list.filter(o => o.statusStage === -1).length;
  $('#statAll').textContent = all;
  $('#statConfirmed').textContent = c0;
  $('#statOutForDelivery').textContent = c1;
  $('#statDelivered').textContent = c2;
  $('#statCanceled').textContent = cX;
}

function renderOrders(){
  const wrap = $('#orders');
  const list = FILTER === "all" ? ALL : ALL.filter(o => o.statusStage === Number(FILTER));
  if (!list.length){
    wrap.innerHTML = `<div class="card" style="opacity:.8">No orders${FILTER==='all'?'':' in this filter'}.</div>`;
    return;
  }
  wrap.innerHTML = list.map(renderOrderCard).join("");
  bindOrderActions();
}

function renderOrderCard(o) {
  const items = (o.items || []).map(i => `• ${escapeHtml(i.category)} — ${escapeHtml(i.amount)}`).join("<br>");
  const disabled = (o.statusStage === 2 || o.statusStage === -1) ? "disabled" : "";
  return `
  <div class="card" data-id="${o.id}">
    <div class="card-head">
      <div class="left">
        <span class="pill">#${o.id}</span>
        <small class="timestamp">📅 Received from customer: ${fmtDate(o.createdAt)}</small>
      </div>
      <div class="right">
        ${pillForStatus(o.status)} ${pillForStage(o.statusStage)}
      </div>
    </div>

    <div class="card-title">${escapeHtml(o.name || "—")} • ${escapeHtml(o.phone || "—")}</div>
    <div class="card-sub">${escapeHtml(o.address || "—")}</div>

    <div class="items">
      ${items || "—"}
    </div>

    <div class="actions">
      <button class="btn" data-action="sendlink" data-id="${o.id}" ${disabled}>Send link</button>
      <div class="select-wrap">
        <select data-action="stage" data-id="${o.id}" ${disabled} title="Update status">
          <option value="0" ${o.statusStage===0?"selected":""}>Order confirmed</option>
          <option value="1" ${o.statusStage===1?"selected":""}>Out for delivery</option>
          <option value="2" ${o.statusStage===2?"selected":""}>Delivered</option>
          <option value="-1" ${o.statusStage===-1?"selected":""}>Canceled</option>
        </select>
      </div>
      <button class="btn danger" data-action="cancel" data-id="${o.id}" ${disabled}>Cancel</button>
    </div>
  </div>`;
}

function bindOrderActions(){
  // filter by clicking counters
  $$('.stat-card').forEach(btn=>{
    btn.onclick = ()=>{
      FILTER = btn.dataset.filter || "all";
      renderOrders();
    };
  });

  // per-card actions
  $$('#orders [data-action="sendlink"]').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = Number(btn.dataset.id);
      const link = prompt("Paste delivery/tracking link:");
      if (!link) return;
      btn.disabled = true;
      try{
        const r = await fetch(`/api/admin/orders/${id}/sendlink`, {
          method: "POST",
          headers: BASE_HEADERS,
          body: JSON.stringify({ link })
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || "Failed");
        toast("Link sent to customer");
        await load(); // refresh
      }catch(e){ console.error(e); toast("Failed to send link"); }
      btn.disabled = false;
    };
  });

  $$('#orders [data-action="stage"]').forEach(sel=>{
    sel.onchange = async ()=>{
      const id = Number(sel.dataset.id);
      const stage = Number(sel.value); // -1 | 0 | 1 | 2
      sel.disabled = true;
      try{
        const r = await fetch(`/api/admin/orders/${id}/stage`, {
          method: "POST",
          headers: BASE_HEADERS,
          body: JSON.stringify({ stage })
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || "Failed");
        toast("Status updated");
        await load(); // refresh
      }catch(e){ console.error(e); toast("Failed to update"); }
      sel.disabled = false;
    };
  });

  $$('#orders [data-action="cancel"]').forEach(btn=>{
    btn.onclick = async ()=>{
      const id = Number(btn.dataset.id);
      if (!confirm(`Cancel order #${id}?`)) return;
      btn.disabled = true;
      try{
        const r = await fetch(`/api/admin/orders/${id}/stage`, {
          method: "POST",
          headers: BASE_HEADERS,
          body: JSON.stringify({ stage: -1 })
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || "Failed");
        toast("Order canceled");
        await load();
      }catch(e){ console.error(e); toast("Failed to cancel"); }
      btn.disabled = false;
    };
  });
}

// ===== Data load =====
async function load(){
  try{
    const r = await fetch("/api/admin/orders", { headers: BASE_HEADERS });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error||"Failed");
    ALL = (j.orders || []).map(o => ({
      ...o,
      statusStage: Number(o.statusStage)
    }));
    renderStats(ALL);
    renderOrders();
    $('#lastUpdated').textContent = `Last updated: ${fmtDate(new Date().toISOString())}`;
  }catch(e){
    console.error(e);
    toast("Failed to load orders");
  }
}

$('#refreshBtn').onclick = load;
load();

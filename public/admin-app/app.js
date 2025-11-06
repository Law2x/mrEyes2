// app.js
const $ = (s, el=document) => el.querySelector(s);
const $$ = (s, el=document) => [...el.querySelectorAll(s)];

let ORDERS = [];
let ACTIVE = "all"; // all | confirmed | out | delivered | canceled

// Map stage -> chip
const stageChip = (s) =>
  s === 2 ? ["Delivered","ok"] :
  s === 1 ? ["Out for delivery","warn"] :
  s === -1 ? ["Canceled","bad"] : ["Confirmed","warn"];

const peso = n => `₱${Number(n||0).toLocaleString()}`;

// parse "₱700 ..." etc from item.amount
function parseItemPeso(txt=""){
  let sum=0, m; const re=/₱\s*([\d,]+)/g;
  while((m=re.exec(txt))) sum += Number(m[1].replace(/,/g,""));
  return sum;
}
function orderTotal(o){
  if(!Array.isArray(o.items)) return 0;
  return o.items.reduce((t, it)=> t + parseItemPeso(it.amount||""), 0);
}

function startOfToday(){ const d=new Date(); d.setHours(0,0,0,0); return d; }
function startOfWeek(){ const d=startOfToday(); const wd=(d.getDay()+6)%7; d.setDate(d.getDate()-wd); return d; } // Monday
function startOfMonth(){ const d=startOfToday(); d.setDate(1); return d; }

function filterLabel(v){
  return v==="all"?"All orders":
         v==="confirmed"?"Order confirmed":
         v==="out"?"Out for delivery":
         v==="delivered"?"Delivered":
         v==="canceled"?"Canceled":"All orders";
}

// Render top two cards
function renderTop(){
  // orders count for current filter
  let list=[...ORDERS];
  if (ACTIVE==="confirmed") list=list.filter(o=>o.statusStage===0);
  if (ACTIVE==="out") list=list.filter(o=>o.statusStage===1);
  if (ACTIVE==="delivered") list=list.filter(o=>o.statusStage===2);
  if (ACTIVE==="canceled") list=list.filter(o=>o.statusStage===-1);
  $("#ordersCount").textContent = String(list.length);

  // sales
  const range = $("#salesRange").value;
  const from =
    range==="today" ? startOfToday() :
    range==="week" ? startOfWeek() :
    range==="month" ? startOfMonth() : new Date(0);

  const sales = ORDERS
    .filter(o=>o.statusStage===2 && new Date(o.createdAt)>=from)
    .reduce((s,o)=>s+orderTotal(o),0);

  $("#salesValue").textContent = peso(sales);
  $("#activeFilter").textContent = filterLabel(ACTIVE);
}

// Render list
function renderList(){
  const wrap=$("#ordersList");
  wrap.innerHTML="";
  let list=[...ORDERS];
  if (ACTIVE==="confirmed") list=list.filter(o=>o.statusStage===0);
  if (ACTIVE==="out") list=list.filter(o=>o.statusStage===1);
  if (ACTIVE==="delivered") list=list.filter(o=>o.statusStage===2);
  if (ACTIVE==="canceled") list=list.filter(o=>o.statusStage===-1);

  const tpl=$("#orderCardTmpl");
  list.forEach(o=>{
    const node=tpl.content.cloneNode(true);

    $(".badge.id",node).textContent = `#${o.id}`;

    const dt=new Date(o.createdAt);
    $(".rcvdtxt",node).textContent =
      dt.toLocaleString(undefined,{month:"short",day:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});

    const [txt,klass]=stageChip(o.statusStage);
    const chip=document.createElement("span");
    chip.className=`chip ${klass}`;
    chip.textContent=txt;
    $(".chips",node).appendChild(chip);

    $(".title",node).textContent = `${o.name || "Customer"} • ${o.phone || "—"}`;
    $(".addr",node).textContent = o.address || "—";
    $(".items",node).innerHTML = (o.items||[]).map(it=>`• ${it.category} — ${it.amount}`).join("<br>");

    // actions
    const sel=$(".stage",node);
    sel.value=String(o.statusStage);
    sel.addEventListener("change", async ()=>{
      const stage=Number(sel.value);
      await fetch(`/api/admin/orders/${o.id}/stage`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({stage})
      });
      await load();
    });

    $(".send-link",node).addEventListener("click", async ()=>{
      const link=prompt("Paste delivery/tracking link:");
      if(!link) return;
      await fetch(`/api/admin/orders/${o.id}/sendlink`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({link})
      });
      await load();
    });

    $(".cancel",node).addEventListener("click", async ()=>{
      if(!confirm("Cancel this order?")) return;
      await fetch(`/api/admin/orders/${o.id}/stage`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({stage:-1})
      });
      await load();
    });

    wrap.appendChild(node);
  });
}

async function load(){
  const initData = window.Telegram?.WebApp?.initData || "";
  const r = await fetch("/api/admin/orders",{
    headers:{"X-Telegram-Init-Data":initData}
  });
  const j = await r.json();
  if(!j.ok){ alert("Auth/DB error loading orders"); return; }
  ORDERS = j.orders || [];
  $("#lastUpdated").textContent = `Last updated: ${new Date().toLocaleString()}`;
  renderTop();
  renderList();
}

function bindUI(){
  $("#btnRefresh").addEventListener("click",load);

  $("#ordersFilter").addEventListener("change", (e)=>{
    ACTIVE = e.target.value;
    renderTop();
    renderList();
  });

  $("#salesRange").addEventListener("change", renderTop);

  // Telegram polish
  try{
    const tg = window.Telegram?.WebApp;
    tg?.expand();
    tg?.MainButton?.hide();
  }catch{}
}

bindUI();
load();

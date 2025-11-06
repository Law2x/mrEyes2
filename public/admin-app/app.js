// app.js
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

let ORDERS = [];
let ACTIVE = "all"; // all | confirmed | out | delivered | canceled

const stageToChip = (s) =>
  s === 2 ? ["Delivered", "ok"] :
  s === 1 ? ["Out for delivery", "warn"] :
  s === -1 ? ["Canceled", "bad"] : ["Confirmed", "warn"];

function peso(n){ return `₱${Number(n || 0).toLocaleString()}`; }

// Pull a peso amount from an item.amount string (e.g. "₱700 • Iron Horse")
function parseItemPeso(txt=""){
  let sum = 0;
  const re = /₱\s*([\d,]+)/g;
  let m;
  while((m = re.exec(txt))){ sum += Number(m[1].replace(/,/g,'')); }
  return sum;
}
function orderTotal(o){
  if (!Array.isArray(o.items)) return 0;
  return o.items.reduce((t, it) => t + parseItemPeso(it.amount || ""), 0);
}

// Date range helpers for Sales Tracker
function startOfToday(){ const d=new Date(); d.setHours(0,0,0,0); return d; }
function startOfWeek(){ const d=startOfToday(); const wd=(d.getDay()+6)%7; d.setDate(d.getDate()-wd); return d; } // Mon
function startOfMonth(){ const d=startOfToday(); d.setDate(1); return d; }

// UI render
function setActiveFilter(name){
  ACTIVE = name;
  const label =
    name==="all" ? "All orders" :
    name==="confirmed" ? "Order confirmed" :
    name==="out" ? "Out for delivery" :
    name==="delivered" ? "Delivered" :
    name==="canceled" ? "Canceled" : "All orders";
  $("#activeFilter").textContent = label;
  renderList();
}

function renderStats(){
  const all = ORDERS.length;
  const confirmed = ORDERS.filter(o => o.statusStage === 0).length;
  const out = ORDERS.filter(o => o.statusStage === 1).length;
  const delivered = ORDERS.filter(o => o.statusStage === 2).length;
  const canceled = ORDERS.filter(o => o.statusStage === -1).length;

  $("#statAll").textContent = all;
  $("#statConfirmed").textContent = confirmed;
  $("#statOut").textContent = out;
  $("#statDelivered").textContent = delivered;
  $("#statCanceled").textContent = canceled;

  // Sales tracker
  const range = $("#salesRange").value;
  const from =
    range==="today" ? startOfToday() :
    range==="week" ? startOfWeek() :
    range==="month" ? startOfMonth() : new Date(0);

  const sales = ORDERS
    .filter(o => o.statusStage === 2 && new Date(o.createdAt) >= from)
    .reduce((sum, o) => sum + orderTotal(o), 0);

  $("#statSales").textContent = peso(sales);
}

function renderList(){
  const wrap = $("#ordersList");
  wrap.innerHTML = "";

  let list = [...ORDERS];
  if (ACTIVE === "confirmed") list = list.filter(o => o.statusStage === 0);
  if (ACTIVE === "out") list = list.filter(o => o.statusStage === 1);
  if (ACTIVE === "delivered") list = list.filter(o => o.statusStage === 2);
  if (ACTIVE === "canceled") list = list.filter(o => o.statusStage === -1);

  const tmpl = $("#orderCardTmpl");

  list.forEach((o, idx) => {
    const node = tmpl.content.cloneNode(true);
    $(".badge.id", node).textContent = `#${o.id}`;

    // Received timestamp
    const dt = new Date(o.createdAt);
    $(".rcvdtxt", node).textContent =
      dt.toLocaleString(undefined, { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

    // Chips
    const [chipText, chipClass] = stageToChip(o.statusStage);
    const chips = $(".chips", node);
    const chip = document.createElement("span");
    chip.className = `chip ${chipClass}`;
    chip.textContent = chipText;
    chips.appendChild(chip);

    $(".title", node).textContent = `${o.name || "Customer"} • ${o.phone || "—"}`;
    $(".addr", node).textContent = o.address || "—";

    const items = $(".items", node);
    items.innerHTML = (o.items || []).map(it => `• ${it.category} — ${it.amount}`).join("<br>");

    // Controls
    const sel = $(".stage", node);
    sel.value = String(o.statusStage);
    sel.addEventListener("change", async () => {
      const stage = Number(sel.value);
      await fetch(`/api/admin/orders/${o.id}/stage`, {
        method: "POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ stage })
      });
      await load(); // refresh counts + list
    });

    $(".send-link", node).addEventListener("click", async () => {
      const link = prompt("Paste delivery/tracking link:");
      if (!link) return;
      await fetch(`/api/admin/orders/${o.id}/sendlink`, {
        method: "POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ link })
      });
      await load();
    });

    $(".cancel", node).addEventListener("click", async () => {
      if (!confirm("Cancel this order?")) return;
      await fetch(`/api/admin/orders/${o.id}/stage`, {
        method: "POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ stage: -1 })
      });
      await load();
    });

    wrap.appendChild(node);
  });
}

async function load(){
  const initData = window.Telegram?.WebApp?.initData || "";
  const res = await fetch("/api/admin/orders", {
    headers: {
      "Content-Type":"application/json",
      "X-Telegram-Init-Data": initData
    }
  });
  const j = await res.json();
  if (!j.ok) { alert("Auth/DB error loading orders"); return; }

  ORDERS = j.orders || [];
  $("#lastUpdated").textContent = `Last updated: ${new Date().toLocaleString()}`;

  renderStats();
  renderList();
}

function bindUI(){
  $("#btnRefresh").addEventListener("click", load);
  $$("#statsRow .stat-card[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => setActiveFilter(btn.dataset.filter));
  });
  $("#salesRange").addEventListener("change", renderStats);

  // Telegram UI polish
  try {
    const tg = window.Telegram?.WebApp;
    tg?.expand();
    tg?.MainButton?.hide();
    tg?.HeaderColor?.setColorScheme?.("secondary_bg_color");
  } catch {}
}

bindUI();
load();

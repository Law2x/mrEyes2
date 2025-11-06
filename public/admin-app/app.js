/* Admin Mini-App (vanilla JS)
   - Fetch orders from /api/admin/orders
   - Clickable counters filter the list
   - Per-card status dropdown (Confirmed/Preparing/Out for delivery/Delivered/Canceled)
   - Send-link flow with inline textbox
   - Auto-refresh support if you want to enable later
*/
const qs = (s, el = document) => el.querySelector(s);
const qsa = (s, el = document) => [...el.querySelectorAll(s)];
const listEl = qs("#list");
const lastUpdatedEl = qs("#lastUpdated");
const refreshBtn = qs("#refreshBtn");

const STAGES = [
  { value: 0, label: "Preparing" },
  { value: 1, label: "Out for delivery" },
  { value: 2, label: "Delivered" },
  { value: -1, label: "Canceled" }
];
// Optional “Confirmed” presentation (maps to 0 under the hood)
const SELECT_OPTIONS = [
  { value: "0c", label: "Confirmed" }, // treated as 0 when saving
  ...STAGES.map(s => ({ value: String(s.value), label: s.label })),
];

let state = {
  orders: [],
  filter: "all", // all | -1 | 0 | 1 | 2
};

function formatItems(items = []) {
  return items.map((it, i) => `${i + 1}. ${it.category} — ${it.amount}`).join("\n");
}
function fmtTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch { return ts || "—"; }
}

function setCounts() {
  const totals = {
    "-1": 0, "0": 0, "1": 0, "2": 0, all: state.orders.length
  };
  state.orders.forEach(o => {
    const k = String(o.statusStage ?? 0);
    if (totals[k] !== undefined) totals[k]++;
  });
  qs("#count-prep").textContent   = totals["0"];
  qs("#count-way").textContent    = totals["1"];
  qs("#count-done").textContent   = totals["2"];
  qs("#count-cancel").textContent = totals["-1"];
  qs("#count-all").textContent    = totals.all;
}

function render() {
  setCounts();
  lastUpdatedEl.textContent = `Last updated • ${new Date().toLocaleTimeString()}`;

  qsa(".chip").forEach(ch => ch.classList.toggle("active", ch.dataset.filter === String(state.filter)));

  const rows = state.orders
    .filter(o => state.filter === "all" ? true : String(o.statusStage ?? 0) === String(state.filter))
    .map(o => renderCard(o))
    .join("");

  listEl.innerHTML = rows || `<div class="glass card"><div>No orders yet.</div></div>`;
}

function stageBadge(o) {
  const st = Number(o.statusStage ?? 0);
  const label = STAGES.find(s => s.value === st)?.label || "Preparing";
  return `<span class="badge stage-${st}">${label}</span>`;
}

function renderCard(o) {
  const disabled = (o.statusStage === 2 || o.statusStage === -1) ? "disabled" : "";
  const sendLinkBlock = `
    <div class="row">
      <div class="input"><input type="url" placeholder="Paste delivery / tracking link…" id="link-${o.id}"></div>
      <button class="btn good" onclick="sendLink(${o.id})">Send link</button>
    </div>
  `;

  const selectOptions = SELECT_OPTIONS.map(opt => {
    // treat "0c" (Confirmed) as selected when stage is 0 (initial)
    const selected = (opt.value === "0c" && (o.statusStage ?? 0) === 0)
                  || (String(o.statusStage) === opt.value);
    return `<option value="${opt.value}" ${selected ? "selected" : ""}>${opt.label}</option>`;
  }).join("");

  return `
  <div class="glass card ${disabled}" id="card-${o.id}">
    <div class="card-head">
      <span class="badge id">#${o.id}</span>
      <span class="badge">${o.status || "paid"}</span>
      ${stageBadge(o)}
    </div>
    <div class="card-body">
      <div><strong>${o.name || "—"}</strong> • ${o.phone || ""}</div>
      <div>${o.address || "—"}</div>
      <div class="item-list">${formatItems(o.items)}</div>
      <div style="margin-top:8px;color:#9fb0c7;font-size:12px">Created: ${fmtTime(o.createdAt)}</div>
    </div>

    <div class="actions">
      <select class="select" id="sel-${o.id}" onchange="changeStage(${o.id})" ${disabled ? "disabled" : ""}>
        ${selectOptions}
      </select>
      <button class="btn warn" onclick="markOut(${o.id})" ${disabled ? "disabled" : ""}>Out for delivery</button>
      <button class="btn good" onclick="markDelivered(${o.id})" ${disabled ? "disabled" : ""}>Delivered</button>
      <button class="btn danger" onclick="cancelOrder(${o.id})" ${disabled ? "disabled" : ""}>Cancel</button>
    </div>

    ${disabled ? "" : sendLinkBlock}
  </div>`;
}

// ————— API —————
async function api(path, opts = {}) {
  // The backend verifies the Telegram WebApp init data.
  const initData = window.Telegram?.WebApp?.initData || "";
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": initData
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function load() {
  refreshBtn.disabled = true;
  try {
    const data = await api("/api/admin/orders");
    state.orders = data.orders || [];
    render();
  } catch (e) {
    console.error(e);
    alert("Failed to load orders. Make sure you open this from Telegram (Admin Center → Open Dashboard).");
  } finally {
    refreshBtn.disabled = false;
  }
}

// ——— Actions ———
window.sendLink = async function(id){
  const el = qs(`#link-${id}`);
  const link = el?.value?.trim();
  if (!link) return alert("Paste a delivery / tracking link first.");
  try {
    await api(`/api/admin/orders/${id}/sendlink`, { method:"POST", body:{ link } });
    el.value = "";
    await load();
  } catch (e) { console.error(e); alert("Failed to send link."); }
};

window.markOut = async function(id){
  try { await api(`/api/admin/orders/${id}/stage`, { method:"POST", body:{ stage:1 } }); await load(); }
  catch(e){ console.error(e); alert("Failed to update stage."); }
};
window.markDelivered = async function(id){
  try { await api(`/api/admin/orders/${id}/stage`, { method:"POST", body:{ stage:2 } }); await load(); }
  catch(e){ console.error(e); alert("Failed to update stage."); }
};
window.cancelOrder = async function(id){
  if (!confirm("Cancel this order?")) return;
  try { await api(`/api/admin/orders/${id}/stage`, { method:"POST", body:{ stage:-1 } }); await load(); }
  catch(e){ console.error(e); alert("Failed to cancel."); }
};

window.changeStage = async function(id){
  const val = qs(`#sel-${id}`).value;
  // “0c” (Confirmed) maps to 0, others are direct
  const stage = (val === "0c") ? 0 : Number(val);
  try {
    await api(`/api/admin/orders/${id}/stage`, { method:"POST", body:{ stage } });
    await load();
  } catch(e) {
    console.error(e);
    alert("Failed to update status.");
  }
};

// ——— Filters ———
qsa(".chip").forEach(ch => ch.addEventListener("click", () => {
  state.filter = ch.dataset.filter;
  render();
}));

refreshBtn.addEventListener("click", load);

// Auto-expand in Telegram
if (window.Telegram?.WebApp) {
  Telegram.WebApp.expand();
  Telegram.WebApp.ready();
}

// Initial load
load();

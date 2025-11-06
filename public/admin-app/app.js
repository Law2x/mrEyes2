/* Yelo🟡Spot admin dashboard (compact 2-card layout) */
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.expand?.();
  tg.disableVerticalSwipes?.();
}

const initData = tg?.initData || ""; // used for auth
const headers = {
  "Content-Type": "application/json",
  "X-Telegram-Init-Data": initData,
};

const els = {
  error: document.getElementById("errorBanner"),
  ordersCount: document.getElementById("ordersCount"),
  salesTotal: document.getElementById("salesTotal"),
  ordersFilter: document.getElementById("ordersFilter"),
  salesRange: document.getElementById("salesRange"),
  listTitle: document.getElementById("listTitle"),
  updatedAt: document.getElementById("updatedAt"),
  list: document.getElementById("ordersList"),
  refresh: document.getElementById("refreshBtn"),
  shopToggle: document.getElementById("shopToggle"),
  toast: document.getElementById("toast"),
};

let ALL_ORDERS = [];
let AUTO_TIMER = null;

/* —— Helpers —— */
const money = (n) =>
  "₱" + (Math.round(n).toLocaleString("en-PH"));

const showToast = (msg) => {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  setTimeout(() => els.toast.classList.remove("show"), 1200);
  tg?.HapticFeedback?.impactOccurred?.("light");
};

const showError = (msg) => {
  els.error.textContent = msg;
  els.error.classList.remove("hidden");
};

const clearError = () => els.error.classList.add("hidden");

const fmtTime = (iso) => {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return ""; }
};

const parsePesoFromItem = (item) => {
  // handles "₱1,000 — 0.056" or "₱700 • Brand"
  const m = (item.amount || "").match(/₱\s*([\d,]+)/);
  return m ? Number(m[1].replace(/,/g, "")) : 0;
};

const orderStageToBadge = (st) => {
  if (st === 2) return `<span class="badge green">Delivered</span>`;
  if (st === 1) return `<span class="badge yellow">Out for delivery</span>`;
  if (st === -1) return `<span class="badge red">Canceled</span>`;
  return `<span class="badge gray">Confirmed</span>`;
};

const stageFromSelect = (value) => {
  switch (value) {
    case "confirmed":
    case "preparing": return 0;
    case "out": return 1;
    case "delivered": return 2;
    case "canceled": return -1;
    default: return 0;
  }
};

const listTitleFromFilter = (f) => {
  switch (f) {
    case "confirmed": return "Order confirmed";
    case "out": return "Out for delivery";
    case "delivered": return "Delivered";
    case "canceled": return "Canceled";
    default: return "All orders";
  }
};

const visibleOrders = () => {
  const f = els.ordersFilter.value;
  return ALL_ORDERS.filter(o => {
    if (f === "all") return true;
    if (f === "confirmed") return (o.statusStage ?? 0) === 0;
    if (f === "out") return o.statusStage === 1;
    if (f === "delivered") return o.statusStage === 2;
    if (f === "canceled") return o.statusStage === -1;
    return true;
  });
};

const salesSum = () => {
  const range = els.salesRange.value;
  const now = new Date();
  const floor = (d)=>{ d.setHours(0,0,0,0); return d; };
  let start = new Date(0);
  if (range === "today") start = floor(new Date());
  if (range === "week") {
    const d = floor(new Date());
    const day = d.getDay(); // 0 Sun
    d.setDate(d.getDate() - day);
    start = d;
  }
  if (range === "month") {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    start = d;
  }
  const eligible = ALL_ORDERS.filter(o => {
    if ((o.statusStage ?? 0) !== 2) return false; // delivered only
    const t = new Date(o.createdAt || o.receivedAt || o.updatedAt || o.created_at || Date.now());
    return t >= start;
  });
  let sum = 0;
  for (const o of eligible) {
    for (const it of (o.items || [])) sum += parsePesoFromItem(it);
  }
  return sum;
};

/* —— API —— */
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

async function loadOrders() {
  try {
    clearError();
    const j = await api("/api/admin/orders");
    if (!j.ok) throw new Error("bad");
    ALL_ORDERS = j.orders || [];
    render();
    els.updatedAt.textContent = `• Updated ${new Date().toLocaleTimeString()}`;
  } catch {
    showError("Auth/DB error loading orders");
  }
}

async function getShop() {
  try {
    const j = await api("/api/admin/shop");
    if (j?.ok) els.shopToggle.checked = !!j.open;
  } catch {}
}

async function setShop(open) {
  try {
    await api("/api/admin/shop", {
      method: "POST",
      body: JSON.stringify({ open })
    });
    showToast(open ? "Shop opened" : "Shop closed");
  } catch {
    showError("Failed to update shop state");
    els.shopToggle.checked = !open; // rollback
  }
}

async function postStage(id, stage) {
  await api(`/api/admin/orders/${id}/stage`, {
    method: "POST",
    body: JSON.stringify({ stage })
  });
}

async function postLink(id, link) {
  await api(`/api/admin/orders/${id}/sendlink`, {
    method: "POST",
    body: JSON.stringify({ link })
  });
}

/* —— Render —— */
function render() {
  // metrics
  const v = visibleOrders();
  els.ordersCount.textContent = v.length;
  els.salesTotal.textContent = money(salesSum());
  els.listTitle.textContent = listTitleFromFilter(els.ordersFilter.value);

  // list
  els.list.innerHTML = "";
  for (const o of v) {
    const created = fmtTime(o.createdAt);
    const badge = orderStageToBadge(o.statusStage ?? 0);
    const items = (o.items || []).map(it => `<div class="bullet">• ${it.category?.replace(/_/g," ")} — ${it.amount}</div>`).join("");

    const idLine = `#${o.id}`;
    const userLink = `tg://user?id=${o.customerChatId}`;

    const card = document.createElement("div");
    card.className = "order";
    card.innerHTML = `
      <div class="head">
        <div class="id">${idLine}</div>
        <div class="meta">${badge}</div>
        <div class="meta">${created}</div>
      </div>
      <div class="name"><a href="${userLink}" style="color:inherit;text-decoration:none">${o.name || "—"} • ${o.phone || ""}</a></div>
      <div class="addr">${o.address || "—"}</div>
      <div class="items">${items}</div>
      <div class="controls">
        <button class="btn icon" data-act="send" data-id="${o.id}" title="Send delivery link"><span class="icon">🛵</span><span>Send link</span></button>

        <select class="select compact" data-act="stage" data-id="${o.id}">
          <option value="confirmed" ${(o.statusStage??0)===0?"selected":""}>Order confirmed</option>
          <option value="out" ${o.statusStage===1?"selected":""}>Out for delivery</option>
          <option value="delivered" ${o.statusStage===2?"selected":""}>Delivered</option>
          <option value="canceled" ${o.statusStage===-1?"selected":""}>Canceled</option>
        </select>

        <button class="btn icon" data-act="cancel" data-id="${o.id}" title="Cancel order"><span class="icon">🗑</span><span>Cancel</span></button>
      </div>
    `;
    els.list.appendChild(card);
  }
}

/* —— Events —— */
els.refresh.addEventListener("click", () => {
  tg?.HapticFeedback?.impactOccurred?.("light");
  loadOrders();
});

els.ordersFilter.addEventListener("change", render);
els.salesRange.addEventListener("change", render);

els.shopToggle.addEventListener("change", (e) => {
  setShop(e.target.checked);
});

els.list.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button,select");
  if (!btn) return;

  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;

  if (act === "send") {
    const link = prompt("Paste delivery / tracking link:");
    if (!link) return;
    try {
      await postLink(id, link);
      showToast("Delivery link sent");
    } catch { showError("Failed to send link"); }
  }

  if (act === "cancel") {
    if (!confirm("Cancel this order?")) return;
    try {
      await postStage(id, -1);
      const o = ALL_ORDERS.find(x=>x.id===id);
      if (o) o.statusStage = -1;
      render();
      showToast("Order canceled");
    } catch { showError("Failed to cancel"); }
  }
});

els.list.addEventListener("change", async (ev) => {
  const sel = ev.target.closest('select[data-act="stage"]');
  if (!sel) return;
  const id = Number(sel.dataset.id);
  const stage = stageFromSelect(sel.value);
  // optimistic
  const o = ALL_ORDERS.find(x=>x.id===id);
  const prev = o?.statusStage ?? 0;
  if (o) o.statusStage = stage;
  render();
  try {
    await postStage(id, stage);
    showToast("Status updated");
  } catch {
    if (o) o.statusStage = prev; // rollback
    render();
    showError("Failed to update status");
  }
});

/* —— Auto-refresh (visible only) —— */
const startAuto = () => {
  if (AUTO_TIMER) return;
  AUTO_TIMER = setInterval(() => {
    if (document.visibilityState === "visible") loadOrders();
  }, 60000);
};
const stopAuto = () => { clearInterval(AUTO_TIMER); AUTO_TIMER=null; };
document.addEventListener("visibilitychange", () => {
  document.visibilityState === "visible" ? startAuto() : stopAuto();
});

/* Init */
await getShop();
await loadOrders();
startAuto();

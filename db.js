// db.js
import pkgPg from "pg";
const { Pool } = pkgPg;

/**
 * Pool
 * - Uses DATABASE_URL
 * - SSL optional via PGSSLMODE env (e.g. "require")
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : undefined,
});

/**
 * Initialize DB schema
 * - orders: main order table
 * - order_messages: threaded chat per order (admin/customer)
 */
export async function dbInit() {
  await pool.query(`
    create table if not exists orders (
      id serial primary key,
      customer_chat_id bigint not null,
      name text,
      phone text,
      address text,
      coords_lat double precision,
      coords_lon double precision,
      items jsonb not null default '[]',
      payment_proof text,
      status text not null default 'paid',
      status_stage int not null default 0,
      delivery_link text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create index if not exists idx_orders_created_at on orders (created_at desc);
    create index if not exists idx_orders_customer on orders (customer_chat_id);

    create table if not exists order_messages (
      id serial primary key,
      order_id int not null references orders(id) on delete cascade,
      sender text not null check (sender in ('customer','admin')),
      message text not null,
      created_at timestamptz not null default now()
    );

    create index if not exists idx_order_messages_order_time on order_messages (order_id, created_at);
  `);
}

/* ───────────────────────── MAP ROW HELPERS ───────────────────────── */

const mapOrderRow = (r) => ({
  id: r.id,
  customerChatId: r.customer_chat_id,
  name: r.name,
  phone: r.phone,
  address: r.address,
  coords: (r.coords_lat == null || r.coords_lon == null)
    ? null
    : { latitude: r.coords_lat, longitude: r.coords_lon },
  items: Array.isArray(r.items) ? r.items : (r.items ? JSON.parse(r.items) : []),
  paymentProof: r.payment_proof,
  status: r.status,
  statusStage: r.status_stage,
  deliveryLink: r.delivery_link,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapMsgRow = (r) => ({
  id: r.id,
  orderId: r.order_id,
  sender: r.sender,          // 'customer' | 'admin'
  message: r.message,
  createdAt: r.created_at,
});

/* ───────────────────────── ORDER CRUD ───────────────────────── */

export async function createOrder({
  customerChatId, name, phone, address, coords, items, paymentProof,
}) {
  const res = await pool.query(
    `insert into orders
      (customer_chat_id, name, phone, address, coords_lat, coords_lon, items, payment_proof, status, status_stage)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'paid',0)
     returning id`,
    [
      customerChatId,
      name || null,
      phone || null,
      address || null,
      coords?.latitude ?? null,
      coords?.longitude ?? null,
      JSON.stringify(items || []),
      paymentProof || null,
    ]
  );
  return res.rows[0].id;
}

export async function listRecentOrders(limit = 50) {
  const r = await pool.query(
    `select id, customer_chat_id, name, phone, address,
            coords_lat, coords_lon, items, payment_proof,
            status, status_stage, delivery_link, created_at, updated_at
     from orders
     order by created_at desc
     limit $1`,
    [limit]
  );
  return r.rows.map(mapOrderRow);
}

export async function getOrderById(id) {
  const r = await pool.query(
    `select id, customer_chat_id, name, phone, address,
            coords_lat, coords_lon, items, payment_proof,
            status, status_stage, delivery_link, created_at, updated_at
     from orders where id = $1`,
    [id]
  );
  if (r.rowCount === 0) return null;
  return mapOrderRow(r.rows[0]);
}

/**
 * Find latest active order for a chat.
 * "Active" = not canceled (status_stage <> -1). You can narrow further if needed.
 */
export async function latestActiveOrderByChatId(customerChatId) {
  const r = await pool.query(
    `select id, customer_chat_id, name, phone, address,
            coords_lat, coords_lon, items, payment_proof,
            status, status_stage, delivery_link, created_at, updated_at
     from orders
     where customer_chat_id = $1
       and status_stage <> -1
     order by created_at desc
     limit 1`,
    [customerChatId]
  );
  if (r.rowCount === 0) return null;
  return mapOrderRow(r.rows[0]);
}

export async function updateOrderStage(id, stage) {
  await pool.query(
    `update orders set
       status_stage = $1,
       status = case
         when $1 = -1 then 'canceled'
         when $1 = 0  then 'paid'
         when $1 = 1  then 'out_for_delivery'
         when $1 = 2  then 'completed'
       end,
       updated_at = now()
     where id = $2`,
    [stage, id]
  );
}

export async function setDeliveryLink(id, link) {
  await pool.query(
    `update orders
       set delivery_link = $1,
           status_stage = 1,
           status = 'out_for_delivery',
           updated_at = now()
     where id = $2`,
    [link, id]
  );
}

export async function markReceivedByChat(customerChatId) {
  await pool.query(
    `update orders
       set status_stage = 2,
           status = 'completed',
           updated_at = now()
     where customer_chat_id = $1
       and status_stage <> -1`,
    [customerChatId]
  );
}

/* ───────────────────────── CHAT THREADS ───────────────────────── */

export async function createMessage(orderId, sender, message) {
  // sender must be 'customer' or 'admin'
  await pool.query(
    `insert into order_messages (order_id, sender, message)
     values ($1, $2, $3)`,
    [orderId, sender, message]
  );
}

export async function listMessages(orderId, limit = 200) {
  const r = await pool.query(
    `select id, order_id, sender, message, created_at
     from order_messages
     where order_id = $1
     order by created_at asc
     limit $2`,
    [orderId, limit]
  );
  return r.rows.map(mapMsgRow);
}

// db.js — Supabase/Postgres using explicit IPv4 host (fixes ENETUNREACH on Render)
import pkgPg from "pg";
import dns from "dns/promises";
const { Pool } = pkgPg;

const dbUrl = new URL(process.env.DATABASE_URL);

// Resolve the Supabase hostname to IPv4 once at boot
const { address: host4 } = await dns.lookup(dbUrl.hostname, { family: 4, all: false });

// Create pool using explicit IPv4 host (not the connectionString)
export const pool = new Pool({
  host: host4,
  port: Number(dbUrl.port || 5432),
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  database: dbUrl.pathname.replace(/^\//, ""),
  ssl: { rejectUnauthorized: false }, // Supabase requires SSL
  keepAlive: true,
});

// Optional quick DB probe
export async function pingDb() {
  await pool.query("SELECT 1");
}

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
    create index if not exists idx_orders_created_at on orders(created_at desc);
  `);
}

const mapRow = (r) => ({
  id: r.id,
  customerChatId: r.customer_chat_id,
  name: r.name,
  phone: r.phone,
  address: r.address,
  coordsLat: r.coords_lat,
  coordsLon: r.coords_lon,
  items: Array.isArray(r.items) ? r.items : (r.items ? JSON.parse(r.items) : []),
  paymentProof: r.payment_proof,
  status: r.status,
  statusStage: r.status_stage,
  deliveryLink: r.delivery_link,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function createOrder({ customerChatId, name, phone, address, coords, items, paymentProof }) {
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
  return r.rows.map(mapRow);
}

export async function getOrderById(id) {
  const r = await pool.query(
    `select id, customer_chat_id, name, phone, address,
            coords_lat, coords_lon, items, payment_proof,
            status, status_stage, delivery_link, created_at, updated_at
     from orders where id=$1`,
    [id]
  );
  if (r.rowCount === 0) return null;
  return mapRow(r.rows[0]);
}

export async function updateOrderStage(id, stage) {
  await pool.query(
    `update orders set
       status_stage=$1,
       status=case
         when $1 = -1 then 'canceled'
         when $1 = 0  then 'paid'
         when $1 = 1  then 'out_for_delivery'
         when $1 = 2  then 'completed'
       end,
       updated_at=now()
     where id=$2`,
    [stage, id]
  );
}

export async function setDeliveryLink(id, link) {
  await pool.query(
    `update orders set delivery_link=$1, status_stage=1, status='out_for_delivery', updated_at=now()
     where id=$2`,
    [link, id]
  );
}

export async function markReceivedByChat(customerChatId) {
  await pool.query(
    `update orders
       set status_stage=2, status='completed', updated_at=now()
     where customer_chat_id=$1
       and status_stage <> -1`,
    [customerChatId]
  );
}

// Clean shutdown (optional)
process.on("SIGTERM", () => { pool.end().catch(() => {}); });
process.on("SIGINT",  () => { pool.end().catch(() => {}); });

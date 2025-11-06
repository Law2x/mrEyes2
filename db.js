// db.js — Supabase/Postgres, IPv4-first with safe fallback (no top-level await)
import pkgPg from "pg";
import dns from "dns";
import dnsAsync from "dns/promises";
const { Pool } = pkgPg;

// IPv4-first lookup passed to pg so connections prefer A records.
const ipv4Lookup = (hostname, options, cb) =>
  dns.lookup(hostname, { ...options, family: 4, hints: dns.ADDRCONFIG }, cb);

let pool;

// Build a pool in two phases: (1) normal connString + ipv4 lookup,
// (2) on first failure, resolve IPv4 and reconnect using discrete fields.
async function buildPool() {
  if (pool) return pool;

  const conn = process.env.DATABASE_URL;
  if (!conn) throw new Error("DATABASE_URL is not set");

  // Attempt 1: normal connection string but force IPv4 via lookup
  try {
    pool = new Pool({
      connectionString: conn,
      ssl: { rejectUnauthorized: false },
      keepAlive: true,
      lookup: ipv4Lookup,
    });
    // quick probe
    await pool.query("SELECT 1");
    return pool;
  } catch (e1) {
    // Fall back to explicit IPv4 host if IPv6 or DNS resolution causes issues
    try {
      const u = new URL(conn);
      const { address: host4 } = await dnsAsync.lookup(u.hostname, { family: 4 });
      pool = new Pool({
        host: host4,
        port: Number(u.port || 5432),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: u.pathname.replace(/^\//, ""),
        ssl: { rejectUnauthorized: false },
        keepAlive: true,
      });
      await pool.query("SELECT 1");
      return pool;
    } catch (e2) {
      // surface the original + fallback errors
      const err = new Error(`DB connect failed (primary & fallback): ${e1?.code || e1} | ${e2?.code || e2}`);
      err.first = e1;
      err.second = e2;
      throw err;
    }
  }
}

export async function pingDb() {
  const p = await buildPool();
  await p.query("SELECT 1");
}

export async function dbInit() {
  const p = await buildPool();
  await p.query(`
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

// Row mapper
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
  const p = await buildPool();
  const res = await p.query(
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
  const p = await buildPool();
  const r = await p.query(
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
  const p = await buildPool();
  const r = await p.query(
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
  const p = await buildPool();
  await p.query(
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
  const p = await buildPool();
  await p.query(
    `update orders set delivery_link=$1, status_stage=1, status='out_for_delivery', updated_at=now()
     where id=$2`,
    [link, id]
  );
}

export async function markReceivedByChat(customerChatId) {
  const p = await buildPool();
  await p.query(
    `update orders
       set status_stage=2, status='completed', updated_at=now()
     where customer_chat_id=$1
       and status_stage <> -1`,
    [customerChatId]
  );
}

// Nice-to-have: clean shutdown
process.on("SIGTERM", () => { if (pool) pool.end().catch(() => {}); });
process.on("SIGINT",  () => { if (pool) pool.end().catch(() => {}); });

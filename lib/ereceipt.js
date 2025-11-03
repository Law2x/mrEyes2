// lib/ereceipt.js
import bwipjs from "bwip-js";
import { createCanvas, loadImage } from "@napi-rs/canvas";

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
function pesosToNumber(txt) {
  const n = Number(String(txt ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Generate a dynamic "e-receipt" PNG buffer (phone-friendly, clean layout)
 * order = { id, name, phone, address, items:[{category,amount}], ts }
 */
export async function generateReceiptPNG(order) {
  const WIDTH = 1080;
  const PADDING = 60;
  let height = 1800;

  // barcode from order id
  const barcodePng = await bwipjs.toBuffer({
    bcid: "code128",
    text: String(order.id ?? "0000"),
    scale: 3,
    height: 20,
    includetext: false,
    backgroundcolor: "FFFFFF",
  });

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");

  // background
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, WIDTH, height);

  // header banner
  const bannerX = PADDING;
  const bannerY = PADDING;
  const bannerW = WIDTH - PADDING * 2;
  const bannerH = 180;

  ctx.fillStyle = "#f2f2f2";
  roundRect(ctx, bannerX, bannerY, bannerW, bannerH, 20);
  ctx.fill();

  ctx.fillStyle = "#111";
  ctx.font = "bold 48px Arial";
  ctx.textAlign = "center";
  ctx.fillText("Mrs Eyes e-Receipt", WIDTH / 2, bannerY + 80);

  ctx.fillStyle = "#666";
  ctx.font = "28px Arial";
  ctx.fillText("Thank you for your purchase!", WIDTH / 2, bannerY + 130);
  ctx.textAlign = "left";

  // order meta
  let y = bannerY + bannerH + 60;
  ctx.fillStyle = "#000";
  ctx.font = "32px Arial";
  ctx.fillText(`🆔 Order #: ${order.id}`, PADDING, y);
  ctx.fillText(`⏰ ${order.ts}`, WIDTH / 2, y);

  // barcode
  y += 30;
  const barcodeImg = await loadImage(barcodePng);
  const bcW = WIDTH - PADDING * 2 - 120;
  const bcH = 160;
  ctx.drawImage(barcodeImg, PADDING + 60, y, bcW, bcH);
  y += bcH + 30;

  // section title
  ctx.fillStyle = "#111";
  ctx.font = "bold 34px Arial";
  ctx.fillText("SALE TRANSACTION", PADDING, y);
  y += 50;

  // table box
  const boxX = PADDING;
  const boxW = WIDTH - PADDING * 2;
  const rowH = 56;
  let rowY = y;

  // header row
  ctx.fillStyle = "#f7f7f7";
  ctx.fillRect(boxX, rowY, boxW, rowH);
  ctx.fillStyle = "#333";
  ctx.font = "bold 28px Arial";
  ctx.fillText("Item", boxX + 24, rowY + 38);
  ctx.fillText("Price", boxX + boxW - 160, rowY + 38);
  rowY += rowH;

  // items
  ctx.font = "28px Arial";
  let total = 0;
  for (const it of order.items || []) {
    const price = pesosToNumber(it.amount);
    total += price;

    ctx.fillStyle = "#000";
    ctx.fillText(`${it.category} — ${it.amount}`, boxX + 24, rowY + 38);
    ctx.textAlign = "right";
    ctx.fillText(`₱${price.toLocaleString()}`, boxX + boxW - 24, rowY + 38);
    ctx.textAlign = "left";

    ctx.strokeStyle = "#eee";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(boxX, rowY + rowH);
    ctx.lineTo(boxX + boxW, rowY + rowH);
    ctx.stroke();

    rowY += rowH;
  }

  // payment + total row
  rowY += 10;
  ctx.fillStyle = "#444";
  ctx.fillText("Payment Method: QRPh / GCash", boxX + 24, rowY + 38);

  ctx.textAlign = "right";
  ctx.fillStyle = "#000";
  ctx.font = "bold 30px Arial";
  ctx.fillText(`TOTAL: ₱${total.toLocaleString()}`, boxX + boxW - 24, rowY + 38);
  ctx.textAlign = "left";
  rowY += rowH + 20;

  // box border
  ctx.strokeStyle = "#ddd";
  ctx.lineWidth = 2;
  ctx.strokeRect(boxX, y, boxW, rowY - y);

  // customer block
  y = rowY + 40;
  ctx.fillStyle = "#111";
  ctx.font = "bold 32px Arial";
  ctx.fillText("CUSTOMER", PADDING, y);
  y += 40;

  ctx.font = "28px Arial";
  ctx.fillStyle = "#000";
  ctx.fillText(`👤 ${order.name || "N/A"}`, PADDING, y); y += 36;
  ctx.fillText(`📱 ${order.phone || "N/A"}`, PADDING, y); y += 36;
  ctx.fillText(`📍 ${order.address || "N/A"}`, PADDING, y); y += 56;

  // footer note
  const footerH = 160;
  roundRect(ctx, PADDING, y, WIDTH - PADDING * 2, footerH, 16);
  ctx.fillStyle = "#f8f8f8";
  ctx.fill();

  ctx.fillStyle = "#333";
  ctx.font = "28px Arial";
  ctx.textAlign = "center";
  ctx.fillText("Please keep this receipt for confirmation.", WIDTH / 2, y + 58);
  ctx.fillText("Delivery fulfilled by Grab.", WIDTH / 2, y + 100);
  ctx.textAlign = "left";

  const finalH = y + footerH + 80;
  if (finalH > height) {
    const tmp = createCanvas(WIDTH, finalH);
    tmp.getContext("2d").drawImage(canvas, 0, 0);
    return tmp.toBuffer("image/png");
  }
  return canvas.toBuffer("image/png");
}

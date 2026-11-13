// Wrap! license service. Runs as a Cloudflare Worker with one KV namespace called LICENSES.
//
// What it does
//   1. The app asks it to activate a member key on a computer. Each key allows maxDevices computers (2 to start).
//   2. iPhone and iPad never take a seat. They only check the key is real and turned on.
//   3. Lemon Squeezy tells it when someone pays. A normal order makes a new key and emails it.
//      An "extra computer" order adds one more computer to the buyer's key (matched by the buyer's email).
//   4. You can make, turn off, or reset keys yourself with the admin calls at the bottom.
//
// Settings (set in Cloudflare, never in this file)
//   Secrets:   LS_SIGNING_SECRET, RESEND_API_KEY, ADMIN_TOKEN
//   Variables: FROM_EMAIL (for example "Wrap! <keys@wrapfilmassistant.com>"),
//              ADMIN_EMAIL (where you want problem alerts sent),
//              EXTRA_VARIANT_ID (the Lemon Squeezy variant id of the "Extra computer" product, leave empty until it exists),
//              START_DEVICES (optional, default 2),
//              DOWNLOAD_BASE (optional, default https://download.wrapfilmassistant.com)

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0, O, 1, I, L
const enc = new TextEncoder();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

export const newBody = () => {
  let out = "";
  while (out.length < 12) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    for (const n of bytes) {
      if (n >= 248) continue; // 248 = 31 * 8, keeps every letter equally likely
      out += ALPHABET[n % 31];
      if (out.length === 12) break;
    }
  }
  return out;
};
export const pretty = (b) => `WRAP-${b.slice(0, 4)}-${b.slice(4, 8)}-${b.slice(8, 12)}`;
export const bodyOf = (text) => {
  let s = String(text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.startsWith("WRAP") && s.length === 16) s = s.slice(4);
  return /^[A-Z0-9]{12}$/.test(s) ? s : null;
};

const getLic = async (env, body) => {
  const raw = await env.LICENSES.get(`lic:${body}`);
  return raw ? JSON.parse(raw) : null;
};
const putLic = (env, body, lic) => env.LICENSES.put(`lic:${body}`, JSON.stringify(lic));

async function createKey(env, { maxDevices, email = "", note = "", orderId = "" }) {
  const body = newBody();
  const lic = { createdAt: Date.now(), maxDevices, devices: [], revoked: false, email: email.toLowerCase(), note, orderId };
  await putLic(env, body, lic);
  if (email) {
    const k = `email:${email.toLowerCase()}`;
    const list = JSON.parse((await env.LICENSES.get(k)) ?? "[]");
    list.push(body);
    await env.LICENSES.put(k, JSON.stringify(list));
  }
  return body;
}

const publicDevices = (lic) => lic.devices.map((d) => ({ id: d.id, name: d.name, platform: d.platform, at: d.at }));

/* ------------------------------ app calls ------------------------------ */
async function handleApp(path, req, env) {
  let data;
  try { data = await req.json(); } catch { return json({ status: "bad_request" }, 400); }
  const body = bodyOf(data.key);
  if (!body) return json({ status: "invalid" });
  const lic = await getLic(env, body);
  if (!lic) return json({ status: "invalid" });
  if (lic.revoked) return json({ status: "revoked" });

  const deviceId = String(data.deviceId ?? "").slice(0, 80);
  const name = String(data.name ?? "Computer").slice(0, 60);
  const mobile = data.platform === "mobile";
  const summary = () => ({ maxDevices: lic.maxDevices, used: lic.devices.length, devices: publicDevices(lic), issued: lic.createdAt });

  if (path === "/activate") {
    if (mobile) return json({ status: "ok", ...summary() }); // phones and tablets never take a seat
    if (!deviceId) return json({ status: "bad_request" }, 400);
    const existing = lic.devices.find((d) => d.id === deviceId);
    if (existing) {
      if (existing.name !== name) { existing.name = name; await putLic(env, body, lic); }
      return json({ status: "ok", ...summary() });
    }
    if (lic.devices.length >= lic.maxDevices) return json({ status: "full", ...summary() });
    lic.devices.push({ id: deviceId, name, platform: "desktop", at: Date.now() });
    await putLic(env, body, lic);
    return json({ status: "ok", ...summary() });
  }

  if (path === "/devices") return json({ status: "ok", ...summary() });

  if (path === "/deactivate") {
    // The key holder may free any of their own seats, for example from an old laptop.
    const target = String(data.removeId ?? deviceId);
    lic.devices = lic.devices.filter((d) => d.id !== target);
    await putLic(env, body, lic);
    return json({ status: "ok", ...summary() });
  }
  return json({ status: "not_found" }, 404);
}

/* ------------------------------ email ------------------------------ */
async function sendEmail(env, to, subject, text, replyTo) {
  if (!env.RESEND_API_KEY || !to) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.FROM_EMAIL, to, subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  return res.ok;
}

const keyEmail = (env, name, keys) => {
  const dl = env.DOWNLOAD_BASE || "https://download.wrapfilmassistant.com";
  return `Hi ${name || "there"},\n\nThank you for buying Wrap! Film Production Assistant.\n\n` +
  `Your member key${keys.length > 1 ? "s" : ""}:\n\n${keys.map(pretty).join("\n")}\n\n` +
  `1. Download Wrap! for your computer:\n` +
  `   Mac with Apple Silicon (M1 or newer): ${dl}/mac-silicon\n` +
  `   Mac with Intel: ${dl}/mac-intel\n` +
  `   Windows 10 or 11: ${dl}/windows\n` +
  `   (Not sure which Mac you have? Apple menu, then About This Mac. M1 or higher means Apple Silicon.)\n` +
  `2. Open it and paste the key when asked.\n` +
  `3. On iPhone or iPad, install the free Wrap! app and paste the same key. Phones and tablets do not count toward your computer limit.\n\n` +
  `Each key works on ${env.START_DEVICES || 2} computers. If you need more, you can add extra computers at wrapfilmassistant.com.\n\n` +
  `Keep this email. If you lose the key, reply and we will help.\n`;
};

/* ------------------------------ Lemon Squeezy ------------------------------ */
async function validSignature(body, header, secret) {
  if (!header || !secret) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === header;
}

async function handleWebhook(req, env) {
  const text = await req.text();
  if (!(await validSignature(text, req.headers.get("X-Signature"), env.LS_SIGNING_SECRET))) return new Response("bad signature", { status: 401 });
  const event = JSON.parse(text);
  if (event.meta?.event_name !== "order_created") return new Response("ignored");
  const attrs = event.data?.attributes ?? {};
  if (attrs.status !== "paid") return new Response("not paid");

  const orderId = String(event.data?.id ?? attrs.identifier ?? "");
  if (orderId && (await env.LICENSES.get(`order:${orderId}`))) return new Response("already handled"); // Lemon Squeezy may retry
  const email = String(attrs.user_email ?? "").toLowerCase();
  const item = attrs.first_order_item ?? {};
  const qty = Math.max(1, Math.min(20, Number(item.quantity) || 1));
  const startDevices = Number(env.START_DEVICES) || 2;
  const isExtra = env.EXTRA_VARIANT_ID && String(item.variant_id) === String(env.EXTRA_VARIANT_ID);

  if (isExtra) {
    const bodies = JSON.parse((await env.LICENSES.get(`email:${email}`)) ?? "[]");
    const body = bodies[bodies.length - 1];
    const lic = body ? await getLic(env, body) : null;
    if (!lic) {
      // No key found for this email. Tell the owner so it can be fixed by hand.
      await sendEmail(env, env.ADMIN_EMAIL, "Wrap! extra computer order needs attention",
        `${email} bought ${qty} extra computer(s) (order ${orderId}) but no key was found for that email.\nAdd the seat by hand with the admin call /admin/addseat.`);
      await sendEmail(env, email, "Your Wrap! extra computer", "Thank you. We could not find a member key for this email address, so we are checking by hand and will email you shortly.");
    } else {
      lic.maxDevices += qty;
      await putLic(env, body, lic);
      await sendEmail(env, email, "Your Wrap! extra computer is ready",
        `Thank you. Your key ${pretty(body)} now works on ${lic.maxDevices} computers.\n`);
    }
  } else {
    const keys = [];
    for (let i = 0; i < qty; i++) keys.push(await createKey(env, { maxDevices: startDevices, email, orderId }));
    const sent = await sendEmail(env, email, "Your Wrap! member key", keyEmail(env, attrs.user_name, keys));
    if (!sent) await sendEmail(env, env.ADMIN_EMAIL, "Wrap! key email failed", `Could not email ${email}. Keys: ${keys.map(pretty).join(", ")}`);
  }
  if (orderId) await env.LICENSES.put(`order:${orderId}`, "1");
  return new Response("ok");
}

/* ------------------------------ contact form ------------------------------ */
// The website form posts here. The message is emailed to ADMIN_EMAIL, with the visitor as the reply address.
// The visitor's email address is never shown on the site, and nothing is sent back to them (so it cannot be abused to email strangers).
async function handleContact(req, env) {
  const data = await req.json().catch(() => null);
  if (!data) return json({ status: "bad_request" }, 400);
  if (data.website) return json({ status: "ok" }); // hidden field that only bots fill in
  const name = String(data.name ?? "").trim().slice(0, 100);
  const email = String(data.email ?? "").trim().slice(0, 200);
  const message = String(data.message ?? "").trim().slice(0, 5000);
  if (!name || message.length < 5 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ status: "invalid" }, 400);
  // At most 5 messages an hour from one address.
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const rk = `rate:contact:${ip}:${Math.floor(Date.now() / 3600000)}`;
  const n = Number((await env.LICENSES.get(rk)) ?? 0);
  if (n >= 5) return json({ status: "slow_down" }, 429);
  await env.LICENSES.put(rk, String(n + 1), { expirationTtl: 7200 });
  const sent = await sendEmail(env, env.ADMIN_EMAIL, `Wrap! website message from ${name}`, `From: ${name} <${email}>\n\n${message}\n`, email);
  return sent ? json({ status: "ok" }) : json({ status: "error" }, 502);
}

/* ------------------------------ admin ------------------------------ */
async function handleAdmin(path, req, env) {
  const auth = req.headers.get("Authorization") ?? "";
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ status: "unauthorized" }, 401);
  const data = await req.json().catch(() => ({}));
  if (path === "/admin/mint") {
    const count = Math.max(1, Math.min(200, Number(data.count) || 1));
    const maxDevices = Math.max(1, Math.min(50, Number(data.maxDevices) || Number(env.START_DEVICES) || 2));
    const keys = [];
    for (let i = 0; i < count; i++) keys.push(pretty(await createKey(env, { maxDevices, email: data.email ?? "", note: String(data.note ?? "").slice(0, 200) })));
    return json({ status: "ok", keys });
  }
  const body = bodyOf(data.key);
  const lic = body ? await getLic(env, body) : null;
  if (!lic) return json({ status: "invalid" });
  if (path === "/admin/revoke") lic.revoked = true;
  else if (path === "/admin/restore") lic.revoked = false;
  else if (path === "/admin/reset") lic.devices = [];
  else if (path === "/admin/addseat") lic.maxDevices += Math.max(1, Number(data.count) || 1);
  else if (path === "/admin/info") return json({ status: "ok", key: pretty(body), ...lic });
  else return json({ status: "not_found" }, 404);
  await putLic(env, body, lic);
  return json({ status: "ok", key: pretty(body), maxDevices: lic.maxDevices, used: lic.devices.length, revoked: lic.revoked });
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const path = new URL(req.url).pathname;
    if (req.method !== "POST") return new Response("Wrap! license service", { headers: CORS });
    try {
      if (path === "/webhook") return await handleWebhook(req, env);
      if (path === "/contact") return await handleContact(req, env);
      if (path.startsWith("/admin/")) return await handleAdmin(path, req, env);
      return await handleApp(path, req, env);
    } catch (e) {
      return json({ status: "error", message: String(e?.message ?? e) }, 500);
    }
  },
};

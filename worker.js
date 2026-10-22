/* A T L DATA Worker (buy-v3)
   Cloudflare secret needed: FIREBASE_SA (service account JSON).
   Everything else (vendor, base URL, tokens, prices, charges, BillStack) is read from the admin panel (Firestore config/*). */

const PROJECT = "a-t-l-data";
const ADMIN_EMAIL = "lawanahmadt03@gmail.com";
const SERVICE_IDS = { mtn: 87, airtel: 159, glo: 157, "9mobile": 252 };   // VTUGate
const AIRTIME_IDS = { mtn: 58, airtel: 312, glo: 243, "9mobile": 244 };   // VTUGate
const ST_NET = { mtn: 1, airtel: 2, glo: 3, "9mobile": 4 };               // Smartteck network ids
const DISCOS = { 1: "Ikeja Electric", 2: "Eko Electric", 3: "Abuja Electric", 4: "Kano Electric", 5: "Enugu Electric", 6: "Port Harcourt Electric", 7: "Ibadan Electric", 8: "Kaduna Electric", 9: "Jos Electric", 10: "Benin Electric", 11: "Yola Electric" };
const BANK_CODES = { "9PSB Bank": "9PSB", "9PSB WAAS": "9PSB" };          // add more only after BillStack confirms the codes
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
const VTUGATE_BASE = "https://api.vtugate.com";
const BILLSTACK_BASE = "https://api.billstack.co/v2";
const DOCS = `projects/${PROJECT}/databases/(default)/documents`;
const FS = `https://firestore.googleapis.com/v1/${DOCS}`;
let gCache = { t: "", exp: 0 };
const GENERIC_FAIL = "The service could not complete this purchase. Your money has been returned.";
const BUSY_FAIL = "The network is busy. Please try again shortly. Your money has been returned.";

export default {
  async fetch(request, env) {
    const url = new URL(request.url), p = url.pathname, m = request.method;
    if (m === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      if (p === "/health") return json({ ok: true, message: "A T L DATA Worker is running", version: "buy-v3" });
      if (p === "/debug/networks") return await debugNetworks(env);
      if (p === "/debug/plans") return await debugPlans(env, url.searchParams.get("network") || "mtn", url.searchParams.get("src") || "filtered");
      if (p === "/admin/plans") return await adminPlans(request, env, (url.searchParams.get("network") || "mtn").toLowerCase());
      if (p === "/vtu/data-services" && m === "GET") {
        const r = await vtugateRaw(env, "/api/v1/fetchallservices", new URLSearchParams({ service_type: "data" }));
        return r.ok ? json(r.data, r.httpStatus) : json({ status: false, message: "Unable to fetch data services", error: r.error }, r.httpStatus || 502);
      }
      if (p === "/vtu/airtime-services" && m === "GET") {
        const r = await vtugateRaw(env, "/api/v1/fetchallservices", new URLSearchParams({ service_type: "airtime" }));
        return r.ok ? json(r.data, r.httpStatus) : json({ status: false, message: "Unable to fetch airtime services", error: r.error }, r.httpStatus || 502);
      }
      if (p.startsWith("/test-plans/") && m === "GET") return await getPlans(env, decodeURIComponent(p.slice(12)).trim().toLowerCase());
      if (p === "/vtu/data-plans" && m === "POST") {
        const b = await request.json().catch(() => null);
        if (!b) return json({ status: false, message: "Invalid JSON request" }, 400);
        let n = String(b.network || "").trim().toLowerCase();
        if (!n && b.service_id) n = Object.keys(SERVICE_IDS).find((k) => SERVICE_IDS[k] === Number(b.service_id)) || "";
        if (!n) return json({ status: false, message: "Network or service_id is required" }, 400);
        return await getPlans(env, n);
      }
      if (p === "/admin/vtu-balance" && m === "GET") {
        const tk = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
        const au = tk ? await verifyIdToken(tk).catch(() => null) : null;
        if (!au || au.email_verified !== true || String(au.email || "").toLowerCase() !== ADMIN_EMAIL) return json({ status: false, message: "Not allowed" }, 403);
        let sec2; try { sec2 = await fsGet(env, "config/security"); } catch { sec2 = null; }
        if (sec2 && sec2.ipWhitelist === true) {
          const allowed = String(sec2.ips || "").split(",").map((x) => x.trim()).filter(Boolean);
          const ip = request.headers.get("CF-Connecting-IP") || "";
          if (allowed.length && !allowed.includes(ip)) return json({ status: false, message: "Not allowed" }, 403);
        }
        const r = await vtugateRaw(env, "/api/v1/accountdetails", new URLSearchParams());
        const d = r.data && r.data.data;
        if (!r.ok || !d) return json({ status: false, message: "Unable to fetch VTUGate balance" }, r.httpStatus || 502);
        return json({ status: true, wallet_balance: Number(d.wallet_balance || 0), account_status: d.account_status || "" });
      }
      if (p === "/account/create" && m === "POST") return await createDepositAccount(request, env);
      if (p === "/webhooks/billstack" && m === "POST") return await billstackWebhook(request, env);
      if (p === "/webhooks/smartteck" && m === "POST") return await smartteckWebhook(request, env);
      if (p === "/buy-airtime" && m === "POST") return await buyAirtime(request, env);
      if (p === "/buy-data" && m === "POST") return await buyData(request, env);
      if (p === "/electricity/validate" && m === "GET") return await validateMeterRoute(request, env, url);
      if (p === "/buy-electricity" && m === "POST") return await buyElectricity(request, env);

      return json({ status: false, message: "Endpoint not found" }, 404);
    } catch (e) {
      console.error(e);
      // plain Response (does not depend on any helper) so the real reason is visible instead of Error 1101
      return new Response(JSON.stringify({ status: false, message: "Server error. Please check your Transactions.", detail: String((e && e.message) || e).slice(0, 120) }),
        { status: 500, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });
    }
  }
};

/* ---------- SETTINGS (all from the admin panel) ---------- */
async function settings(env) {
  const names = ["txapi", "payment", "charges", "discounts", "services", "general", "pricing"];
  let err = "";
  const r = await Promise.all(names.map((n) => fsGet(env, "config/" + n).catch((e) => { err = err || String((e && e.message) || e).slice(0, 80); return null; })));
  const s = {}; names.forEach((n, i) => (s[n] = r[i] || {}));
  s.__err = err;
  return s;
}
const toNum = (v) => Number(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")) || 0;
const pkey = (c) => String(c).replace(/[.\/]/g, "_");
const normNet = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const newTxId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);

/* ---------- SMARTTECK (vendor 1) ---------- */
function stCfg(s) {
  const t = s.txapi || {}, base = String(t.baseUrl || "").trim().replace(/\/+$/, "");
  return { base: /^https:\/\//i.test(base) ? base : "", token: String(t.token || "").trim() };
}
function stWhy(s) {   // why Smartteck is on/off (no secrets shown)
  const t = s.txapi || {};
  if (!Object.keys(t).length) return "config/txapi not found";
  if (String(t.vendor || "smartteck") === "vtugate") return "vendor is set to vtugate";
  if (!stCfg(s).base) return "baseUrl missing or does not start with https://";
  if (!stCfg(s).token) return "token is empty";
  return "on";
}
const useST = (s) => String((s.txapi || {}).vendor || "smartteck") !== "vtugate" && !!stCfg(s).base && !!stCfg(s).token;

async function stCall(s, method, path, body) {
  const { base, token } = stCfg(s);
  if (!base || !token) return { ok: false, httpStatus: 500, error: "Vendor is not configured" };
  try {
    const r = await fetch(base + path, {
      method,
      headers: { Accept: "application/json", Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25000)
    });
    const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch {}
    return { ok: r.ok, httpStatus: r.status, data };
  } catch (e) { return { ok: false, httpStatus: 0, error: String((e && e.message) || e) }; }
}

function vendorMessage(d, t) {
  const er = d && d.errors;
  if (er && typeof er === "object") { for (const k of Object.keys(er)) { const v = Array.isArray(er[k]) ? er[k][0] : er[k]; if (typeof v === "string") return v; } }
  return String((d && d.message) || (t && t.api_response) || "");
}
// Clear failure (refund) vs unknown (stay pending until the webhook says so).
// (stOutcome is defined at the end of this file)
function vtuOutcome(r) {
  const res = r && r.data, d = res && res.data;
  const o = { outcome: "pending", ref: String((d && d.external_reference) || ""), vid: String((d && d.transaction_id) || ""), cost: 0, token: "", message: String((res && res.message) || "") };
  if (res && res.status === true && d && d.provider_status === true) o.outcome = "success";
  else if (res && res.status === false && r.httpStatus < 500) o.outcome = "failed";
  return o;
}
// Customers never see vendor wallet / KYC / limit messages.
function customerFail(o) {
  if (o.busy) return BUSY_FAIL;
  if (!o.authIssue && /selected plan is invalid|mobile number|network field|meter|smart card/i.test(o.message)) return "The details were rejected. Please check them and try again. Your money has been returned.";
  return GENERIC_FAIL;
}

/* ---------- PLANS & PRICES ---------- */
async function listPlans(env, s, network) {
  if (useST(s)) {
    if (!ST_NET[network]) return { ok: false, code: 400, message: "Unsupported network" };
    const r = await stCall(s, "GET", "/api/data_plans"); if (r.ok && r.data && Array.isArray(r.data.mobile_networks)) r.data = r.data.mobile_networks.filter((n) => n.data_active !== 0 && canonNet(n.name) === network).flatMap((n) => (n.plan_types || []).filter((t) => t.active !== 0).flatMap((t) => (t.data_plans || []).filter((p) => p.active !== 0).map((p) => ({ ...p, network, type: t.name, netId: vendorNetId(n) || numOr(p.network_id, p.mobile_network_id) }))));
    if (r.ok) { const l = collectPlans(r.data, { net: "", type: "" }, []); r.error = l.length ? "" : "shape " + shapeOf(r.data); r.data = l.length ? l : null; }
    const raw = Array.isArray(r.data) ? r.data : Array.isArray(r.data && r.data.data) ? r.data.data : null;
    if (!r.ok || !raw) return { ok: false, code: r.httpStatus >= 400 ? r.httpStatus : 502, message: "Plans are unavailable right now.", reason: "Smartteck " + (r.httpStatus || "no response") + (r.error ? " " + r.error : "") };
    const flat = raw.flatMap((x) => Array.isArray(x.plans) ? x.plans.map((q) => ({ network: x.name || x.code, ...q })) : [x]);
    const key = (x) => typeof x.network === "number" ? Object.keys(ST_NET).find((k) => ST_NET[k] === x.network) : normNet(x.network);
    const plans = flat.filter((x) => key(x) === network && x.active !== false && Number(x.amount) > 0).map((x) => ({
      code: String(x.id), name: [String(x.network).toUpperCase(), x.type, String(x.size || "") + String(x.volume || ""), x.validity].filter(Boolean).join(" "),
      cost: Number(x.amount), validity: x.validity || "", type: x.type || "", netId: typeof x.network === "number" ? x.network : (Number(x.netId) || 0) }));
    return { ok: true, vendor: "smartteck", plans };
  }
  const sid = SERVICE_IDS[network];
  if (!sid) return { ok: false, code: 400, message: "Unsupported network" };
  const r = await vtugateRaw(env, "/api/v1/fetchdataplans", new URLSearchParams({ service_id: String(sid) }));
  const arr = r.ok && r.data && r.data.data && r.data.data.data_plans;
  if (!Array.isArray(arr)) return { ok: false, code: r.httpStatus || 502, message: "Plans are unavailable right now.", reason: r.error ? String(r.error).slice(0, 80) : "VTUGate " + r.httpStatus };
  return { ok: true, vendor: "vtugate", plans: arr.map((x) => ({ code: String(x.code), name: x.name, cost: Number(x.price), validity: x.validity || "", type: "", service_id: x.service_id })) };
}
// Your price from admin (config/pricing) or cost + data charge. Hidden plans return null. Never below cost.
function basePrice(s, network, plan) {
  const e = ((s.pricing || {})[network] || {})[pkey(plan.code)];
  if (e && e.enabled === false) return null;
  const cost = Math.ceil(plan.cost);
  if (e && typeof e.price === "number" && e.price > 0) return Math.max(Math.ceil(e.price), cost);
  return Math.ceil(plan.cost + Number((s.charges || {}).data || 0));
}
async function getPlans(env, network) {
  if (!SERVICE_IDS[network]) return json({ status: false, message: "Unsupported network", supported_networks: Object.keys(SERVICE_IDS) }, 400);
  const s = await settings(env), lp = await listPlans(env, s, network);
  if (!lp.ok) return json({ status: false, network, plans: [], message: lp.message, reason: (s.__err ? "Firestore: " + s.__err + ". " : "") + (lp.reason || "") }, lp.code || 502);
  const plans = lp.plans.map((p) => ({ p, price: basePrice(s, network, p) })).filter((x) => x.price != null)
    .map(({ p, price }) => ({ code: p.code, name: p.name, price, validity: p.validity, type: p.type })).sort((a, b) => a.price - b.price);
  return json({ status: true, network, source: lp.vendor, smartteck: stWhy(s), plans });
}

/* ---------- COMMON PURCHASE GATE & FINISH ---------- */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function checkPin(user, uid, pin) {
  if (!user.pinHash) return { ok: false, message: "Please set a transaction PIN first (My Account)." };
  if (!/^\d{4}$/.test(String(pin || ""))) return { ok: false, message: "Enter your 4-digit transaction PIN." };
  const h = await sha256Hex(String(pin) + uid);
  if (h !== user.pinHash) return { ok: false, message: "Incorrect PIN." };
  return { ok: true };
}
async function authUser(request) {
  const tk = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const u = tk ? await verifyIdToken(tk).catch(() => null) : null;
  return u && u.email_verified === true ? u : null;
}
async function gate(request, env, s, svc, pin) {
  const u = await authUser(request);
  if (!u) return { res: json({ status: false, message: "Please login again." }, 401) };
  const user = await fsGet(env, "users/" + u.sub);
  if (!user) return { res: json({ status: false, message: "Account not found." }, 404) };
  if (user.isBlocked === true) return { res: json({ status: false, message: "Your account is restricted. Please contact support." }, 403) };
  const pc = await checkPin(user, u.sub, pin);
  if (!pc.ok) return { res: json({ status: false, message: pc.message }, 401) };
  if (s.services[svc] === false) return { res: json({ status: false, message: "This service is currently unavailable." }, 503) };
  if (s.general.maintenance === true) return { res: json({ status: false, message: "We are under maintenance. Please try again later." }, 503) };
  const rl = await checkRateLimit(env, u.sub);
  if (!rl.ok) return { res: json({ status: false, message: rl.message }, 429) };
  return { u, user };
}
// Refund ONLY on a clear failure; anything unclear stays "pending" until the vendor webhook (or you) settles it.
async function finish(env, uid, txPath, sell, held, o, label, vendor, estCost) {
  if (o.outcome === "success") {
    const cost = o.cost > 0 ? o.cost : estCost;
    await commitWrites(env, [upd(txPath, { status: "success", providerRef: o.ref, providerTxId: o.vid, vendor, cost, profit: sell - cost, ...(o.token ? { token: o.token } : {}) })]);
    return json({ status: true, message: label + " successful.", new_balance: held.after, transaction_id: txPath.slice(13), ...(o.token ? { token: o.token } : {}) });
  }
  if (o.outcome === "failed") {
    console.error(vendor + " failure: " + o.message);
    await changeBalance(env, uid, sell, [upd(txPath, { status: "failed", providerMessage: String(o.message).slice(0, 200), vendor })]);
    return json({ status: false, message: customerFail(o) }, 400);
  }
  await commitWrites(env, [upd(txPath, { status: "pending", providerRef: o.ref, providerTxId: o.vid, vendor, providerMessage: String(o.message || "").slice(0, 300) })]);
  return json({ status: true, pending: true, message: "Your purchase is processing. Please check Transactions shortly.", new_balance: held.after }, 202);
}
const PENDING = { outcome: "pending", ref: "", vid: "", cost: 0, token: "", message: "" };

/* ---------- BUY DATA ---------- */
async function buyData(request, env) {
  const b = await request.json().catch(() => null);
  if (!b) return json({ status: false, message: "Invalid request." }, 400);
  const network = String(b.network || "").toLowerCase(), code = String(b.plan_code || ""), phone = String(b.phone || "").trim();
  if (!SERVICE_IDS[network] || !code || !/^0[789][01]\d{8}$/.test(phone)) return json({ status: false, message: "Invalid network, plan or phone number." }, 400);
  const s = await settings(env);
  const g = await gate(request, env, s, "data", b.pin); if (g.res) return g.res;
  const { u, user } = g;

  // Price is always decided here (admin prices), never taken from the browser.
  const lp = await listPlans(env, s, network);
  const plan = lp.ok && lp.plans.find((x) => x.code === code);
  const base = plan ? basePrice(s, network, plan) : null;
  if (!plan || base == null) return json({ status: false, message: "Plan not available. Please reload plans." }, 400);
  const disc = Number((s.discounts || {})[user.tier || "basic"] || 0);
  let sell = Math.ceil(base * (1 - disc / 100));
  if (sell < Math.ceil(plan.cost)) sell = Math.ceil(plan.cost);

  const txId = newTxId(), txPath = "transactions/" + txId;
  const held = await changeBalance(env, u.sub, -sell, [create(txPath, {
    uid: u.sub, type: "Data", amount: sell, cost: plan.cost, profit: sell - plan.cost, status: "processing",
    description: plan.name + " to " + phone, network, phone, planCode: code, vendor: lp.vendor })]);
  if (!held.ok) return json({ status: false, message: held.message }, held.code);

  let o = PENDING;
  try {
    if (lp.vendor === "smartteck") o = stOutcome(await stCall(s, "POST", "/api/data", { plan: Number(code), mobile_number: phone, network: plan.netId || await stNetId(s, network) }));
    else o = vtuOutcome(await vtugateRaw(env, "/api/v1/buydata", new URLSearchParams({ service_id: String(plan.service_id), phone_number: phone, amount: String(plan.cost), plan_code: code })));
  } catch (e) { console.error(e); }
  return await finish(env, u.sub, txPath, sell, held, o, "Data purchase", lp.vendor, plan.cost);
}

/* ---------- BUY AIRTIME ---------- */
async function buyAirtime(request, env) {
  const b = await request.json().catch(() => null);
  if (!b) return json({ status: false, message: "Invalid request." }, 400);
  const network = String(b.network || "").toLowerCase(), phone = String(b.phone || "").trim(), amount = Number(b.amount);
  const s = await settings(env), vendor = useST(s) ? "smartteck" : "vtugate", max = vendor === "smartteck" ? 5000 : 50000;
  if (!AIRTIME_IDS[network] || !/^0[789][01]\d{8}$/.test(phone) || !Number.isInteger(amount) || amount < 50 || amount > max)
    return json({ status: false, message: "Invalid network, phone number or amount (50 to " + max.toLocaleString("en-US") + ")." }, 400);
  const g = await gate(request, env, s, "airtime", b.pin); if (g.res) return g.res;
  const { u } = g;

  const fee = Math.ceil(Number((s.charges || {}).airtime || 0)), sell = amount + fee;
  const txId = newTxId(), txPath = "transactions/" + txId;
  const held = await changeBalance(env, u.sub, -sell, [create(txPath, {
    uid: u.sub, type: "Airtime", amount: sell, cost: amount, profit: fee, status: "processing",
    description: network.toUpperCase() + " airtime " + amount + " to " + phone, network, phone, vendor })]);
  if (!held.ok) return json({ status: false, message: held.message }, held.code);

  let o = PENDING;
  try {
    if (vendor === "smartteck") o = stOutcome(await stCall(s, "POST", "/api/topup/" + txId, { amount, mobile_number: phone, network: await stNetId(s, network) }));
    else o = vtuOutcome(await vtugateRaw(env, "/api/v1/buyairtime", new URLSearchParams({ service_id: String(AIRTIME_IDS[network]), phone_number: phone, amount: String(amount) })));
  } catch (e) { console.error(e); }
  return await finish(env, u.sub, txPath, sell, held, o, "Airtime purchase", vendor, amount);
}

/* ---------- ELECTRICITY (Smartteck only) ---------- */
const discoSlug = (id) => String(DISCOS[id] || "").toLowerCase().replace(/\s+/g, "-");
async function validateMeter(s, discoId, meterNo, type) {
  const q = "?meter_number=" + encodeURIComponent(meterNo) + "&disco_name=" + encodeURIComponent(discoSlug(discoId)) + "&meter_type=" + encodeURIComponent(type);
  const r = await stCall(s, "GET", "/api/validate_meter" + q);
  const d = r.data || {};
  return r.ok && d.status === "success" && d.name ? { ok: true, name: String(d.name), address: String(d.address || "") } : { ok: false };
}
function meterInput(x) {
  const id = Number(x.disco_id), no = String(x.meter_number || "").trim(), type = String(x.meter_type || "").toLowerCase();
  return DISCOS[id] && /^\d{6,13}$/.test(no) && (type === "prepaid" || type === "postpaid") ? { id, no, type } : null;
}
async function validateMeterRoute(request, env, url) {
  if (!(await authUser(request))) return json({ status: false, message: "Please login again." }, 401);
  const s = await settings(env);
  if (!useST(s)) return json({ status: false, message: "Electricity is not available right now." }, 503);
  const m = meterInput(Object.fromEntries(url.searchParams));
  if (!m) return json({ status: false, message: "Enter a valid meter number, type and distributor." }, 400);
  const v = await validateMeter(s, m.id, m.no, m.type);
  return v.ok ? json({ status: true, name: v.name, address: v.address }) : json({ status: false, message: "Could not verify this meter. Check the number and meter type." }, 400);
}
async function buyElectricity(request, env) {
  const b = await request.json().catch(() => null);
  if (!b) return json({ status: false, message: "Invalid request." }, 400);
  const m = meterInput(b), amount = Number(b.amount), phone = String(b.phone || "").trim();
  if (!m || !Number.isInteger(amount) || amount < 1000 || amount > 100000 || !/^0[789][01]\d{8}$/.test(phone))
    return json({ status: false, message: "Enter a valid meter, phone number and amount (minimum 1,000)." }, 400);
  const s = await settings(env);
  if (!useST(s)) return json({ status: false, message: "Electricity is not available right now." }, 503);
  const g = await gate(request, env, s, "electricity", b.pin); if (g.res) return g.res;
  const { u } = g;
  const v = await validateMeter(s, m.id, m.no, m.type);       // re-checked on the server; the registered name is used
  if (!v.ok) return json({ status: false, message: "Could not verify this meter. Check the number and meter type." }, 400);

  const fee = Math.ceil(Number((s.charges || {}).electricity || 0)), sell = amount + fee;
  const txId = newTxId(), txPath = "transactions/" + txId;
  const held = await changeBalance(env, u.sub, -sell, [create(txPath, {
    uid: u.sub, type: "Electricity", amount: sell, cost: amount, profit: fee, status: "processing",
    description: DISCOS[m.id] + " " + m.type + " " + m.no + " (" + v.name + ")", meterNumber: m.no, phone, vendor: "smartteck" })]);
  if (!held.ok) return json({ status: false, message: held.message }, held.code);

  let o = PENDING;
  try {
    o = stOutcome(await stCall(s, "POST", "/api/electricity_bill_payments", { meter_type: m.type, phone_number: phone, name: v.name, meter_number: m.no, electricity_distributor_id: m.id, amount }));
  } catch (e) { console.error(e); }
  return await finish(env, u.sub, txPath, sell, held, o, "Electricity payment", "smartteck", amount);
}

/* ---------- SMARTTECK WEBHOOK (settles pending purchases) ---------- */
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function fsGetMeta(env, path) {
  const r = await fetch(FS + "/" + path, { headers: { Authorization: "Bearer " + (await gToken(env)) } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Firestore " + r.status);
  const j = await r.json();
  return { data: fromFS(j.fields), updateTime: j.updateTime };
}
const updWhen = (p, o, ut) => ({ ...upd(p, o), currentDocument: { updateTime: ut } });

async function smartteckWebhook(request, env) {
  const OK = () => json({ status: true, message: "ok" });
  const raw = await request.text();
  const ts = request.headers.get("X-Webhook-Timestamp") || "", sig = (request.headers.get("X-Webhook-Signature") || "").toLowerCase();
  const cfgd = (await fsGet(env, "config/txapi").catch(() => null)) || {};
  const secret = String(cfgd.webhookSecret || "").trim();
  if (!secret || !ts || !sig) return json({ status: false, message: "Rejected." }, 401);
  if (!safeEq("sha256=" + (await hmacHex(secret, ts + "." + raw)), sig)) return json({ status: false, message: "Invalid signature." }, 401);

  let body; try { body = JSON.parse(raw); } catch { return OK(); }
  const d = body.data || {}, ref = String(d.reference || ""), st = String(d.status || "").toLowerCase();
  const final = st === "success" || st === "successful" ? "success" : st === "failed" || st === "refunded" ? "failed" : "";
  if (!ref || !final) return OK();
  try {
    const hit = await fsQueryOne(env, "transactions", "providerRef", ref);
    if (!hit) { console.log("smartteck webhook: no transaction for " + ref); return OK(); }
    const path = "transactions/" + hit.id, meta = await fsGetMeta(env, path);
    if (!meta || !["Data", "Airtime", "Electricity"].includes(meta.data.type)) return OK();
    const t = meta.data;
    if (t.status !== "pending" && t.status !== "processing") {            // already settled: never act twice
      if (t.status === "success" && st === "refunded") await commitWrites(env, [upd(path, { needsReview: true })]).catch(() => {});
      return OK();
    }
    if (final === "success") { await commitWrites(env, [updWhen(path, { status: "success" }, meta.updateTime)]); return OK(); }
    const reason = String((body.metadata && (body.metadata.failure_reason || body.metadata.refund_reason)) || "Vendor reported failure").slice(0, 200);
    const held = await changeBalance(env, t.uid, Number(t.amount), [updWhen(path, { status: "failed", providerMessage: reason }, meta.updateTime)]);
    if (!held.ok) {
      const again = await fsGet(env, path).catch(() => null);
      if (again && again.status !== "pending" && again.status !== "processing") return OK();
      return json({ status: false, message: "Retry later." }, 500);        // 5xx = vendor retries
    }
    return OK();
  } catch (e) { console.error("smartteckWebhook error: " + (e && e.stack ? e.stack : e)); return json({ status: false, message: "Internal error." }, 500); }
}


/* ---------- BILLSTACK KEYS (admin Payment Gateway first, then older locations) ---------- */
async function getBillstackKeys(env) {
  const out = [], add = (v) => { v = String(v || "").trim(); if (v && !out.includes(v)) out.push(v); };
  try { const p = await fsGet(env, "config/payment"); add(p && p.billstack && p.billstack.secretKey); } catch {}
  try { const k = await fsGet(env, "config/keys"); add(k && k.billstackApiKey); } catch {}
  try { const s = await fsGet(env, "config/security"); add(s && s.billstackApiKey); } catch {}
  add(env.BILLSTACK_SECRET_KEY);
  return out;
}
async function getBillstackKey(env) { return (await getBillstackKeys(env))[0] || ""; }

/* ---------- DEPOSIT ACCOUNTS (BillStack reserved virtual accounts, one per bank) ---------- */
const BS_BANKS = { "9PSB": "9PSB Bank", SAFEHAVEN: "Safehaven MFB", PROVIDUS: "Providus Bank", PALMPAY: "PalmPay" };
const slug = (v) => String(v || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
// Banks come from the admin panel > Wallet Funding (config/payment.fundingMethods). Nothing to edit here when the admin changes them.
const FUND_MAP = { billStack9psb: "9PSB", palmpayBillStack: "PALMPAY", safeHavenBillStack: "SAFEHAVEN" };
function enabledBanks(payCfg) {
  const fm = payCfg.fundingMethods;
  let list = [];
  if (fm && typeof fm === "object") list = Object.keys(FUND_MAP).filter((k) => fm[k] === true).map((k) => FUND_MAP[k]);
  else {                                                   // older setting: billstack.banks
    const b = (payCfg.billstack || {}).banks;
    list = (Array.isArray(b) ? b : typeof b === "string" ? b.split(",") : []).map((x) => String(x).trim().toUpperCase()).filter((x) => BS_BANKS[x]);
  }
  if (!list.length) list = [BANK_CODES[payCfg.defaultBank] || "9PSB"];
  return [...new Set(list)];
}
async function bsCreate(bsKey, user, uid, bank, id) {
  const name = String(user.name || "Customer User").trim().split(/\s+/);
  const body = {
    reference: uid + "_" + bank.toLowerCase() + "_" + crypto.randomUUID().slice(0, 6), email: user.email || "",
    phone: String(user.phone || "08000000000").replace(/\D/g, "").slice(0, 11) || "08000000000",
    firstName: name[0] || "Customer", lastName: name.slice(1).join(" ") || "User", bank
  };
  if (bank === "PALMPAY") { body.idType = id.type; body.idNumber = id.number; }
  let d;
  try {
    const r = await fetch(BILLSTACK_BASE + "/thirdparty/generateVirtualAccount/", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + bsKey }, body: JSON.stringify(body) });
    d = await r.json().catch(() => null);
  } catch (e) { return { ok: false, message: "Could not reach the deposit provider." }; }
  const acc = d && d.status && d.data && d.data.account && d.data.account[0];
  if (!acc) return { ok: false, message: String((d && d.message) || "Could not create the account.").slice(0, 160) };
  const ref = String((d.data && d.data.reference) || acc.reference || acc.account_reference || acc.customer_reference || "");
  return { ok: true, reqRef: body.reference, ref, acc: { bank_id: String(acc.bank_id || bank), bank_name: String(acc.bank_name || BS_BANKS[bank]), account_number: String(acc.account_number), account_name: String(acc.account_name || ""), reference: ref } };
}
async function bsKyc(bsKey, email, bvn) {   // best effort: ties the BVN to every account of this customer
  try { await fetch(BILLSTACK_BASE + "/thirdparty/upgradeVirtualAccount/", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + bsKey }, body: JSON.stringify({ customer: email, bvn }) }); } catch {}
}
async function createDepositAccount(request, env) {
  const tk = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const u = tk ? await verifyIdToken(tk).catch(() => null) : null;
  if (!u || u.email_verified !== true) return json({ status: false, message: "Please login again." }, 401);
  const user = await fsGet(env, "users/" + u.sub);
  if (!user) return json({ status: false, message: "Account not found." }, 404);

  const payCfg = (await fsGet(env, "config/payment").catch(() => null)) || {};
  const banks = enabledBanks(payCfg);

  // accounts the customer already has (older customers only have the single legacy account)
  let accounts = Array.isArray(user.virtualAccounts) ? user.virtualAccounts.filter((a) => a && a.account_number) : [];
  if (!accounts.length && user.baAccountNumber) accounts = [{ bank_id: String(user.baBankId || "9PSB"), bank_name: String(user.baBankName || ""), account_number: String(user.baAccountNumber), account_name: String(user.baAccountName || ""), reference: String(user.baReference || "") }];

  // NIN / BVN (needed only for PalmPay). It is sent to BillStack and never saved or logged here.
  const b = await request.json().catch(() => ({})) || {};
  const idType = String(b.idType || "").toLowerCase(), idNumber = String(b.idNumber || "").replace(/\D/g, "");
  const haveId = (idType === "nin" || idType === "bvn") && /^\d{11}$/.test(idNumber);
  if (b.idNumber && !haveId) return json({ status: false, message: "Enter a valid 11-digit " + (idType === "bvn" ? "BVN" : "NIN") + "." }, 400);

  const missing = banks.filter((x) => !accounts.some((a) => a.bank_id === x));
  const errors = {}; let needsId = false, newOnes = [], writes = [];
  const recent = user.baTried && Date.now() - Number(user.baTried) < 60000 && !haveId;      // don't hammer BillStack on every page view

  if (missing.length && !recent) {
    if ((payCfg.billstack || {}).enabled === false) { if (!accounts.length) return json({ status: false, message: "Deposits are temporarily unavailable. Please try again later." }, 503); }
    else {
      const bsKey = await getBillstackKey(env);
      if (!bsKey) { if (!accounts.length) return json({ status: false, message: "Deposit service is not configured yet." }, 500); }
      else {
        for (const bank of missing) {
          if (bank === "PALMPAY" && !haveId) { needsId = true; continue; }
          const r = await bsCreate(bsKey, user, u.sub, bank, { type: idType, number: idNumber });
          if (!r.ok) { errors[bank] = r.message; continue; }
          newOnes.push(r.acc); accounts.push(r.acc);
          for (const k of [slug(r.ref), slug(r.reqRef)]) if (k) writes.push(put("baRefs/" + k, { uid: u.sub, bank }));
        }
        if (haveId && idType === "bvn" && accounts.length && user.email) await bsKyc(bsKey, user.email, idNumber);
      }
    }
  } else if (missing.includes("PALMPAY")) needsId = true;

  if (newOnes.length || Object.keys(errors).length) {
    const f = accounts[0];
    writes.push(upd("users/" + u.sub, {
      ...(newOnes.length ? { virtualAccounts: accounts, baAccountNumber: f.account_number, baAccountName: f.account_name, baBankName: f.bank_name, baBankId: f.bank_id, baReference: f.reference } : {}),
      ...(haveId && newOnes.length ? { kycType: idType, kycSubmitted: true } : {}),
      ...(Object.keys(errors).length ? { baTried: Date.now() } : {})
    }));
    await commitWrites(env, writes);
  }
  if (!accounts.length) return json({ status: false, message: Object.values(errors)[0] || "Could not create your deposit account." }, 502);
  const f = accounts[0];
  return json({ status: true, message: "Accounts ready.", data: {
    account_number: f.account_number, account_name: f.account_name, bank_name: f.bank_name,      // (older app versions read these)
    accounts: accounts.map((a) => ({ bank_id: a.bank_id, bank_name: a.bank_name, account_number: a.account_number, account_name: a.account_name })),
    needs_id: needsId, errors, banks
  } });
}


async function billstackWebhook(request, env) {
  const raw = await request.text();
  const ts = request.headers.get("x-wiaxy-timestamp") || "";
  const sig = request.headers.get("x-wiaxy-signature-256") || "";
  const whKeys = await getBillstackKeys(env);
  if (!whKeys.length || !ts || !sig) return json({ status: false, message: "Rejected." }, 401);
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return json({ status: false, message: "Stale event." }, 401);

  let valid = false;
  for (const wk of whKeys) { if (safeEq(await hmacHex(wk, ts + "." + raw), sig.toLowerCase())) { valid = true; break; } }
  if (!valid) return json({ status: false, message: "Invalid signature." }, 401);

  let body;
  try { body = JSON.parse(raw); } catch { return json({ status: true, message: "successful" }); }
  if (body.event !== "PAYMENT_NOTIFICATION") return json({ status: true, message: "successful" });

  try {
    const d = body.data || {};
    const refValue = String(d.reference || d.merchant_reference || d.account_reference || d.customer_reference || (d.account && d.account.reference) || (d.virtual_account && d.virtual_account.reference) || "");
    const amount = Math.floor(Number(d.amount || 0));
    const ref = String(d.transaction_ref || d.wiaxy_ref || "");
    if (!refValue || !(amount > 0) || !ref) return json({ status: true, message: "successful" });

    let uid = "";
    const mapped = slug(refValue) ? await fsGet(env, "baRefs/" + slug(refValue)).catch(() => null) : null;
    if (mapped && mapped.uid) uid = String(mapped.uid);
    const direct = uid ? null : await fsGet(env, "users/" + refValue).catch(() => null);
    if (uid) { /* found through baRefs */ }
    else if (direct) uid = refValue;
    else {
      const match = await fsQueryOne(env, "users", "baReference", refValue).catch((e) => { console.error("fsQueryOne error: " + (e && e.stack || e)); return null; });
      if (match) uid = match.id;
    }
    if (!uid && refValue.indexOf("_") > 0) { const pre = refValue.split("_")[0]; const u2 = await fsGet(env, "users/" + pre).catch(() => null); if (u2) uid = pre; }
    console.log("DEBUG billstack: refValue=" + refValue + " resolvedUid=" + (uid || "NONE_FOUND"));
    if (!uid) { console.error("BillStack credit failed: no user matches reference " + refValue); return json({ status: false, message: "User not found." }, 500); }

    const safeRef = ref.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60) || crypto.randomUUID();
    const txPath = "transactions/billstack_" + safeRef;

    const existing = await fsGet(env, txPath).catch(() => undefined);
    if (existing) return json({ status: true, message: "successful" }); // already credited, ack without double-crediting

    // Your charge settings (admin > Payment Gateway): percentage or flat, with an optional cap.
    const bs = ((await fsGet(env, "config/payment").catch(() => null)) || {}).billstack || {};
    let fee = 0; const cv = Number(bs.chargeValue || 0);
    if (cv > 0) { fee = bs.chargeType === "flat" ? cv : (amount * cv) / 100; const cap = Number(bs.maxCap || 0); if (cap > 0) fee = Math.min(fee, cap); fee = Math.ceil(fee); }
    if (fee >= amount) fee = 0;
    const credit = amount - fee;
    const held = await changeBalance(env, uid, credit, [create(txPath, {
      uid, type: "Deposit", amount: credit, fee, grossAmount: amount, status: "success",
      description: fee > 0 ? "Automatic deposit via BillStack (charge N" + fee + ")" : "Automatic deposit via BillStack",
      providerRef: ref, payerName: (d.payer && ((d.payer.first_name || "") + " " + (d.payer.last_name || ""))) || ""
    })]);
    if (!held.ok) {
      console.error("BillStack credit failed:", held.message);
      return json({ status: false, message: "Could not credit account." }, 500); // let BillStack retry
    }
    return json({ status: true, message: "successful" });
  } catch (e) {
    console.error("billstackWebhook internal error: " + (e && e.stack ? e.stack : String(e)));
    return json({ status: false, message: "Internal error." }, 500);
  }
}


/* ---------- NETWORK IDS (taken from the vendor's own list; ST_NET is only a fallback) ---------- */
const NET_ALIAS = { etisalat: "9mobile", "9mobile": "9mobile", ninemobile: "9mobile" };
const canonNet = (n) => { const k = normNet(n); return NET_ALIAS[k] || k; };
const numOr = (...v) => { for (const x of v) { const n = Number(x); if (x !== null && x !== undefined && x !== "" && Number.isFinite(n) && n > 0) return n; } return 0; };
const vendorNetId = (n) => numOr(n && n.id, n && n.network_id, n && n.mobile_network_id, n && n.network_code);
let netCache = { t: 0, ids: null };
async function stNetIds(s) {
  if (netCache.ids && Date.now() - netCache.t < 600000) return netCache.ids;
  const r = await stCall(s, "GET", "/api/data_plans");
  const ids = {};
  if (r.ok && r.data && Array.isArray(r.data.mobile_networks)) for (const n of r.data.mobile_networks) { const k = canonNet(n.name), id = vendorNetId(n); if (ST_NET[k] && id) ids[k] = id; }
  if (Object.keys(ids).length) netCache = { t: Date.now(), ids };
  return ids;
}
async function stNetId(s, network) { const ids = await stNetIds(s).catch(() => ({})); return ids[network] || ST_NET[network]; }
// TEMPORARY check: shows the network names/ids the vendor reports (no keys, no prices)
async function debugNetworks(env) {
  const s = await settings(env);
  if (!useST(s)) return json({ vendor: "not smartteck" });
  const r = await stCall(s, "GET", "/api/data_plans");
  const list = r.ok && r.data && Array.isArray(r.data.mobile_networks)
    ? r.data.mobile_networks.map((n) => ({ name: n.name, id: vendorNetId(n) || null, data_active: n.data_active, code: n.code, api_network_id: n.api_network_id, fields: Object.keys(n).filter((k) => typeof n[k] !== "object").slice(0, 12) })) : [];
  return json({ http: r.httpStatus, vendor_networks: list, built_in_fallback: ST_NET, in_use: await stNetIds(s).catch(() => ({})) });
}

/* ---------- FIRESTORE (REST, service account) ---------- */
const create = (p, o) => ({ update: { name: DOCS + "/" + p, fields: toFS(o) }, updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: false } });
const upd = (p, o) => ({ update: { name: DOCS + "/" + p, fields: toFS(o) }, updateMask: { fieldPaths: Object.keys(o) }, updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: true } });

function fv(v) {
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return fromFS(v.mapValue.fields);
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fv);
  return null;
}
function toV(v) {
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.filter((x) => x !== undefined && x !== null).map(toV) } };
  if (v && typeof v === "object") return { mapValue: { fields: toFS(v) } };
  return { stringValue: String(v) };
}
function toFS(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, toV(v)]));
}
const put = (p, o) => ({ update: { name: DOCS + "/" + p, fields: toFS(o) } });
function fromFS(f) { return Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, fv(v)])); }
async function fsPost(env, path, body) {
  const r = await fetch(FS + path, { method: "POST", headers: { Authorization: "Bearer " + (await gToken(env)), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}
async function fsQueryOne(env, collection, field, value) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: String(value) } } },
      limit: 1
    }
  };
  const r = await fsPost(env, ":runQuery", body);
  const rows = Array.isArray(r.data) ? r.data : [];
  const hit = rows.find((x) => x.document);
  if (!hit) return null;
  const id = hit.document.name.split("/").pop();
  return { id, ...fromFS(hit.document.fields) };
}

async function fsGet(env, path) {
  const r = await fetch(FS + "/" + path, { headers: { Authorization: "Bearer " + (await gToken(env)) } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Firestore " + r.status);
  return fromFS((await r.json()).fields);
}
async function commitWrites(env, writes) {
  const r = await fsPost(env, ":commit", { writes });
  if (!r.ok) throw new Error("Commit failed " + r.status);
}
// Atomic balance change (read + write in one Firestore transaction). Negative delta checks funds.
async function changeBalance(env, uid, delta, extra) {
  const upath = DOCS + "/users/" + uid;
  for (let i = 0; i < 3; i++) {
    const tx = (await fsPost(env, ":beginTransaction", {})).data.transaction;
    const g = await fsPost(env, ":batchGet", { documents: [upath], transaction: tx });
    const f = Array.isArray(g.data) && g.data[0] && g.data[0].found ? g.data[0].found.fields : null;
    if (!f) return { ok: false, code: 404, message: "Account not found." };
    const bal = f.balance ? Number(f.balance.integerValue ?? f.balance.doubleValue ?? 0) : 0, after = bal + delta;
    if (delta < 0 && after < 0) return { ok: false, code: 402, message: "Insufficient balance. Please fund your wallet." };
    const c = await fsPost(env, ":commit", {
      transaction: tx,
      writes: [{ update: { name: upath, fields: { balance: { doubleValue: after } } }, updateMask: { fieldPaths: ["balance"] }, updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: true } }, ...extra]
    });
    if (c.ok) return { ok: true, before: bal, after };
    if (c.status !== 409) return { ok: false, code: 500, message: "Could not process right now. Please try again." };
  }
  return { ok: false, code: 409, message: "System busy. Please try again." };
}

/* ---------- RATE LIMIT (per user, config/security.rateLimit purchases per minute) ---------- */
async function checkRateLimit(env, uid) {
  let sec;
  try { sec = await fsGet(env, "config/security"); } catch { sec = null; }
  const limit = Number((sec || {}).rateLimit || 0);
  if (!limit || limit <= 0) return { ok: true }; // not configured = no limit

  const path = DOCS + "/rateLimits/" + uid;
  for (let i = 0; i < 2; i++) {
    const tx = (await fsPost(env, ":beginTransaction", {})).data.transaction;
    const g = await fsPost(env, ":batchGet", { documents: [path], transaction: tx });
    const f = Array.isArray(g.data) && g.data[0] && g.data[0].found ? g.data[0].found.fields : null;
    const now = Date.now();
    const windowStart = f && f.windowStart ? Number(f.windowStart.integerValue || 0) : 0;
    const count = f && f.count ? Number(f.count.integerValue || 0) : 0;
    const fresh = now - windowStart > 60000;
    const nextCount = fresh ? 1 : count + 1;
    if (!fresh && count >= limit) {
      await fsPost(env, ":commit", { transaction: tx, writes: [] }); // release
      return { ok: false, message: "Too many purchases. Please wait a moment and try again." };
    }
    const c = await fsPost(env, ":commit", {
      transaction: tx,
      writes: [{ update: { name: path, fields: { windowStart: { integerValue: String(fresh ? now : windowStart) }, count: { integerValue: String(nextCount) } } }, updateTransforms: [] }]
    });
    if (c.ok) return { ok: true };
    if (c.status !== 409) return { ok: true }; // fail open on infra errors, never block a good sale
  }
  return { ok: true };
}

/* ---------- AUTH ---------- */
const b64u = (d) => { const a = typeof d === "string" ? new TextEncoder().encode(d) : new Uint8Array(d); let s = ""; a.forEach((x) => (s += String.fromCharCode(x))); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function gToken(env) {
  if (gCache.t && gCache.exp > Date.now() + 60000) return gCache.t;
  const sa = JSON.parse(env.FIREBASE_SA), now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const p = b64u(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const key = await crypto.subtle.importKey("pkcs8", unb64u(sa.private_key.replace(/-----[^-]+-----|\s/g, "")), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(h + "." + p));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: h + "." + p + "." + b64u(sig) }) });
  const j = await r.json();
  if (!j.access_token) throw new Error("Google token error");
  gCache = { t: j.access_token, exp: Date.now() + 3500000 };
  return gCache.t;
}

async function verifyIdToken(token) {
  const [h, p, s] = token.split(".");
  const hd = JSON.parse(new TextDecoder().decode(unb64u(h))), pl = JSON.parse(new TextDecoder().decode(unb64u(p)));
  const keys = (await (await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com", { cf: { cacheTtl: 3600, cacheEverything: true } })).json()).keys;
  const jwk = keys.find((k) => k.kid === hd.kid);
  if (!jwk || hd.alg !== "RS256") return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(s), new TextEncoder().encode(h + "." + p));
  if (!ok || pl.aud !== PROJECT || pl.iss !== "https://securetoken.google.com/" + PROJECT || pl.exp < Date.now() / 1000 || !pl.sub) return null;
  return pl;
}

/* ---------- VTUGATE ---------- */
async function getVtuKey(env) {
  try { const k = await fsGet(env, "config/keys"); if (k && k.vtugateApiKey) return k.vtugateApiKey; } catch {}
  try { const s = await fsGet(env, "config/security"); if (s && s.vtugateApiKey) return s.vtugateApiKey; } catch {} // legacy location
  return env.VTUGATE_API_KEY || "";
}

async function vtugateRaw(env, endpoint, form) {
  const key = await getVtuKey(env);
  if (!key) return { ok: false, httpStatus: 500, error: "VTUGATE_API_KEY secret is missing" };
  try {
    const response = await fetch(VTUGATE_BASE + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Bearer " + key },
      body: form.toString()
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false, httpStatus: response.status, error: "Invalid JSON response from VTUGATE" }; }
    return { ok: response.ok, httpStatus: response.status, data };
  } catch (error) {
    return { ok: false, httpStatus: 502, error: error?.message || "Connection to VTUGATE failed" };
  }
}


function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });
}

/* ---------- tolerant reader for the vendor's plan list (accepts every documented shape) ---------- */
function collectPlans(d, ctx, out) {
  if (Array.isArray(d)) { for (const x of d) collectPlans(x, ctx, out); return out; }
  if (!d || typeof d !== "object") return out;
  if ("id" in d && ("amount" in d || "price" in d) && ("size" in d || "volume" in d || "validity" in d)) {
    out.push({ ...d, amount: d.amount != null ? d.amount : d.price, network: d.network != null && d.network !== "" ? d.network : ctx.net, type: d.type || ctx.type });
    return out;
  }
  const me = { net: ctx.net, type: ctx.type }, nm = typeof d.name === "string" ? normNet(d.name) : "", cd = typeof d.code === "string" ? normNet(d.code) : "";
  if (ST_NET[nm]) me.net = nm; else if (ST_NET[cd]) me.net = cd; else if (typeof d.name === "string" && "plans" in d) me.type = d.name;
  for (const [k, v] of Object.entries(d)) collectPlans(v, { net: ST_NET[normNet(k)] ? normNet(k) : me.net, type: me.type }, out);
  return out;
}
function shapeOf(d) { return d == null ? "non-JSON" : Array.isArray(d) ? "array(" + d.length + ")" : typeof d === "object" ? "keys " + Object.keys(d).slice(0, 8).join(",") : typeof d; }

/* ---------- TEMPORARY: structure of the vendor plan list (field names only, no prices) ---------- */
function skeleton(d, depth) {
  depth = depth || 0;
  if (Array.isArray(d)) return d.length ? ["items:" + d.length, skeleton(d[0], depth + 1)] : [];
  if (d && typeof d === "object") return depth > 6 ? "{...}" : Object.fromEntries(Object.entries(d).slice(0, 30).map(([k, v]) => [k, skeleton(v, depth + 1)]));
  return typeof d;
}
async function debugPlans(env, net, src) {
  const s = await settings(env), plain = src === "plain";
  const r = await stCall(s, "GET", plain ? "/api/data_plans" : "/api/data-plans-prices/filtered?mobile_network=" + (ST_NET[net] || 1));
  const got = collectPlans(r.data, { net: "", type: "" }, []);
  return json({ endpoint: plain ? "plain" : "filtered", http: r.httpStatus, error: r.error || "", collected: got.length, types: [...new Set(got.map((p) => String(p.type || "")))], structure: skeleton(r.data) });
}

/* ---------- ADMIN ONLY: plans with your real cost (used by admin > Data Prices) ---------- */
async function adminPlans(request, env, network) {
  const u = await authUser(request);
  if (!u || String(u.email || "").toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return json({ status: false, message: "Admin only." }, 403);
  if (!SERVICE_IDS[network]) return json({ status: false, message: "Unsupported network" }, 400);
  const s = await settings(env), lp = await listPlans(env, s, network);
  if (!lp.ok) return json({ status: false, plans: [], message: lp.message, reason: lp.reason || "" }, lp.code || 502);
  return json({ status: true, network, source: lp.vendor, plans: lp.plans.map((p) => ({ code: p.code, name: p.name, type: p.type, validity: p.validity, cost: p.cost })) });
}

/* ---------- vendor reply reader (finds status / reference / amount / token wherever the vendor puts them) ---------- */
function deepFind(d, keys, ok, depth) {
  depth = depth || 0;
  if (!d || typeof d !== "object" || depth > 5) return undefined;
  if (!Array.isArray(d)) for (const k of keys) if (ok(d[k])) return d[k];
  for (const v of Array.isArray(d) ? d : Object.values(d)) { const x = deepFind(v, keys, ok, depth + 1); if (x !== undefined) return x; }
  return undefined;
}
const isStr = (v) => typeof v === "string" && v.trim() !== "", isScalar = (v) => isStr(v) || typeof v === "number";
function stOutcome(r) {
  const hs = r.httpStatus, d = r.data || {};
  const st = String(deepFind(d, ["Status", "status", "transaction_status", "state"], isStr) || "").trim().toLowerCase();
  const t = d.data && typeof d.data === "object" && !Array.isArray(d.data) ? d.data : d;
  const o = { outcome: "pending", ref: String(deepFind(d, ["ident", "reference", "ref", "transaction_reference"], isScalar) || ""), vid: String(deepFind(d, ["id", "transaction_id"], isScalar) || ""),
    cost: toNum(deepFind(d, ["amount"], isScalar)), token: String(deepFind(d, ["token"], isStr) || ""), message: "", busy: hs === 429, authIssue: hs === 401 || hs === 403 };
  if (/^(success|successful|completed|delivered)$/.test(st)) o.outcome = "success";
  else if (/^(fail|failed|failure|error|reversed|refunded)$/.test(st) || hs === 422 || hs === 429 || hs === 401 || hs === 403) o.outcome = "failed";
  if (o.outcome === "failed") o.message = vendorMessage(d, t);
  else if (o.outcome === "pending" && hs < 300 && !st) o.message = "unrecognized reply " + JSON.stringify(skeleton(r.data)).slice(0, 280);
  return o;
}


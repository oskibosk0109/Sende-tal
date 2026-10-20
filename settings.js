// Gemmer og henter data i Redis. Kræver APP_PASSWORD samt Redis-forbindelse fra Vercel:
//   enten KV_REST_API_URL + KV_REST_API_TOKEN / UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//   eller REDIS_URL
//
//   /api/settings                   → indstillinger (medarbejdere, navnekobling, felter, budget, salgslinje-regler)
//   /api/settings?k=salgslinje      → hvem der var på salgslinjen (kun navne), slettes automatisk efter 14 dage
const crypto = require("crypto");
const KEY = "statusgen:settings";
const HKEY = "statusgen:salgslinje";
const MAX_BYTES = 200 * 1024;
const KEEP_DAYS = 14;
const TTL_SECONDS = 30 * 24 * 3600; // sikkerhedsnet: nøglen forsvinder af sig selv, hvis den ikke bruges

function safeEqual(a, b) {
  const x = crypto.createHash("sha256").update(String(a || "")).digest();
  const y = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(x, y);
}

const restUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const restToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function rest(cmd) {
  const r = await fetch(restUrl, {
    method: "POST",
    headers: { Authorization: "Bearer " + restToken, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

let tcp;
async function tcpClient() {
  if (tcp && tcp.isOpen) return tcp;
  const { createClient } = require("redis");
  tcp = createClient({ url: process.env.REDIS_URL });
  tcp.on("error", () => {});
  await tcp.connect();
  return tcp;
}

async function rget(k) {
  if (restUrl && restToken) return rest(["GET", k]);
  if (process.env.REDIS_URL) return (await tcpClient()).get(k);
  throw new Error("Redis er ikke forbundet til projektet");
}
async function rset(k, v, ttl) {
  if (restUrl && restToken) return rest(ttl ? ["SET", k, v, "EX", ttl] : ["SET", k, v]);
  if (process.env.REDIS_URL) return (await tcpClient()).set(k, v, ttl ? { EX: ttl } : undefined);
  throw new Error("Redis er ikke forbundet til projektet");
}

// ---------- Salgslinje-historik (kun navne, 14 dage) ----------
function cutoff() {
  const d = new Date();
  d.setDate(d.getDate() - KEEP_DAYS);
  return d.toISOString().slice(0, 10);
}
function prune(list) {
  const c = cutoff();
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && typeof e.to === "string" && e.to >= c)
    .sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0))
    .slice(0, 40);
}
function cleanEntry(e) {
  const D = /^\d{4}-\d{2}-\d{2}$/;
  if (!e || !D.test(e.from) || !D.test(e.to) || !Array.isArray(e.names)) return null;
  return {
    id: e.from + "|" + e.to,
    from: e.from,
    to: e.to,
    label: String(e.label || "").slice(0, 40),
    names: e.names.slice(0, 60).map((n) => String(n).slice(0, 100)),
    saved: Date.now(),
  };
}
async function loadHist() {
  const raw = await rget(HKEY);
  const o = raw ? JSON.parse(raw) : {};
  return prune(o.entries);
}
async function saveHist(entries) {
  await rset(HKEY, JSON.stringify({ entries, updated: Date.now() }), TTL_SECONDS);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (!process.env.APP_PASSWORD) return res.status(500).send("APP_PASSWORD mangler i Vercel");
  if (!safeEqual(req.headers["x-pass"], process.env.APP_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 600));
    return res.status(401).send("Forkert adgangskode");
  }
  try {
    const k = new URL(req.url, "http://x").searchParams.get("k");
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");

    if (k === "salgslinje") {
      if (req.method === "GET") return res.status(200).json({ entries: await loadHist() });
      if (req.method === "POST") {
        let entries = await loadHist();
        if (body && typeof body.remove === "string") {
          entries = entries.filter((e) => e.id !== body.remove);
        } else {
          const e = cleanEntry(body && body.entry);
          if (!e) return res.status(400).send("Ugyldig salgslinje");
          entries = entries.filter((x) => x.id !== e.id).concat([e]);
        }
        entries = prune(entries);
        await saveHist(entries);
        return res.status(200).json({ ok: true, entries });
      }
      res.setHeader("Allow", "GET, POST");
      return res.status(405).send("Metode ikke tilladt");
    }

    if (req.method === "GET") {
      const raw = await rget(KEY);
      const o = raw ? JSON.parse(raw) : {};
      return res.status(200).json({ settings: o.settings || null, updated: o.updated || null });
    }
    if (req.method === "POST") {
      if (!body || typeof body !== "object" || !Array.isArray(body.team) || !Array.isArray(body.fields))
        return res.status(400).send("Ugyldige indstillinger");
      const allowed = ["title", "team", "alias", "fields", "budget", "yel", "sl"];
      const settings = {};
      allowed.forEach((key) => { if (body[key] !== undefined) settings[key] = body[key]; });
      const data = JSON.stringify({ settings, updated: Date.now() });
      if (Buffer.byteLength(data) > MAX_BYTES) return res.status(413).send("For store indstillinger");
      await rset(KEY, data);
      return res.status(200).json({ ok: true, updated: JSON.parse(data).updated });
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).send("Metode ikke tilladt");
  } catch (e) {
    return res.status(500).send(String(e.message || e));
  }
};

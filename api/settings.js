// Gemmer og henter indstillinger (medarbejdere, navnekobling, felter, budget) i Redis.
// Kræver miljøvariablen APP_PASSWORD samt Redis-forbindelse fra Vercel:
//   enten KV_REST_API_URL + KV_REST_API_TOKEN / UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//   eller REDIS_URL
const crypto = require("crypto");
const KEY = "statusgen:settings";
const MAX_BYTES = 200 * 1024;

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
async function rset(k, v) {
  if (restUrl && restToken) return rest(["SET", k, v]);
  if (process.env.REDIS_URL) return (await tcpClient()).set(k, v);
  throw new Error("Redis er ikke forbundet til projektet");
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
    if (req.method === "GET") {
      const raw = await rget(KEY);
      const o = raw ? JSON.parse(raw) : {};
      return res.status(200).json({ settings: o.settings || null, updated: o.updated || null });
    }
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") body = JSON.parse(body || "{}");
      if (!body || typeof body !== "object" || !Array.isArray(body.team) || !Array.isArray(body.fields))
        return res.status(400).send("Ugyldige indstillinger");
      const allowed = ["title", "team", "alias", "fields", "budget", "yel"];
      const settings = {};
      allowed.forEach((k) => { if (body[k] !== undefined) settings[k] = body[k]; });
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

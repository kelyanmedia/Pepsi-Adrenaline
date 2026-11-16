/**
 * Adrenaline Rush Cyber Fest — бэкенд заявок (Vercel Function).
 *
 *   POST /api/registrations  { action: "register", type, team, players[], lang }
 *        → сохраняет заявку, выдаёт номер участника (атомарный счётчик)
 *   POST /api/registrations  { action: "list", login, password }
 *        → заявки и игроки для админки /admin (только по логину и паролю)
 *
 * Хранилище: Upstash Redis из Vercel Marketplace (Storage → Upstash for Redis → Connect Project).
 * Vercel сам добавит переменные KV_REST_API_URL и KV_REST_API_TOKEN.
 */
const crypto = require("crypto");

const ADMIN_LOGIN = "admin";
// SHA-256 хеш пароля админки (сам пароль в коде не хранится)
const ADMIN_PASSWORD_SHA256 = "0eba393e80338601945f5f8549c11b5562954654d67c6d78bb991493f165a60a";
const KEY_SEQ = "cyberfest:seq";
const KEY_APPS = "cyberfest:applications";

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(...commands) {
  const r = await fetch(REDIS_URL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(commands)
  });
  if (!r.ok) throw new Error("redis " + r.status);
  const out = await r.json();
  return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const sha256 = t => crypto.createHash("sha256").update(t, "utf8").digest("hex");
function safeEq(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function tashkentNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "long"
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.day}.${p.month}.${p.year}`, day: p.weekday, time: `${p.hour}:${p.minute}:${p.second}` };
}

async function register(d) {
  const type = d.type === "solo" ? "solo" : "team";
  const lang = d.lang === "uz" ? "uz" : "ru";
  const team = type === "team" ? clean(d.team, 60) : "";
  const raw = Array.isArray(d.players) && d.players.length ? d.players : [{ name: d.name, phone: d.phone, nick: d.nick }];
  const players = raw.slice(0, type === "solo" ? 1 : 5).map((p, k) => ({
    role: type === "solo" ? "Соло" : k === 0 ? "Капитан" : `Игрок ${k + 1}`,
    name: clean(p && p.name, 60), nick: clean(p && p.nick, 40), phone: clean(p && p.phone, 20)
  }));
  const bad = players.some(p => p.name.length < 2 || p.phone.replace(/\D/g, "").length !== 12);
  if (bad || (type === "team" && (team.length < 2 || players.length !== 5))) return { status: 400, body: { ok: false, error: "invalid" } };

  const [number] = await redis(["INCR", KEY_SEQ]);
  const rec = { number, ...tashkentNow(), type: type === "solo" ? "Соло" : "Команда", team, lang, players };
  await redis(["RPUSH", KEY_APPS, JSON.stringify(rec)]);
  return { status: 200, body: { ok: true, number, date: rec.date, day: rec.day, time: rec.time, notified: false } };
}

async function list(d) {
  const ok = safeEq(String(d.login || ""), ADMIN_LOGIN) && safeEq(sha256(String(d.password || "")), ADMIN_PASSWORD_SHA256);
  if (!ok) {
    await new Promise(r => setTimeout(r, 800));                       // тормозим подбор пароля
    return { status: 401, body: { ok: false, error: "auth" } };
  }
  const [rows] = await redis(["LRANGE", KEY_APPS, "0", "-1"]);
  const recs = (rows || []).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
  const applications = recs.map(r => ({
    number: r.number, date: r.date, day: r.day, time: r.time, type: r.type, team: r.team,
    name: r.players[0].name, phone: r.players[0].phone, nick: r.players[0].nick, count: r.players.length, lang: r.lang
  }));
  const players = recs.flatMap(r => r.players.map(p => ({ number: r.number, date: r.date, type: r.type, team: r.team, role: p.role, name: p.name, nick: p.nick, phone: p.phone })));
  return { status: 200, body: { ok: true, applications, players } };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(200).json({ ok: true, service: "adrenaline-registration", storage: !!(REDIS_URL && REDIS_TOKEN) });
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(503).json({ ok: false, error: "storage_not_connected" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") return res.status(400).json({ ok: false, error: "bad_request" });
  try {
    const out = body.action === "register" ? await register(body)
      : body.action === "list" ? await list(body)
      : { status: 400, body: { ok: false, error: "unknown_action" } };
    res.status(out.status).json(out.body);
  } catch (e) {
    res.status(500).json({ ok: false, error: "server" });
  }
};

/**
 * Adrenaline Rush Cyber Fest — бэкенд заявок (Vercel Function), без внешних баз данных.
 *
 *   POST /api/registrations { action: "register", type, team, players[], lang } → номер участника
 *   POST /api/registrations { action: "list", login, password }               → данные для /admin
 *
 * Где хранятся заявки: в Telegram-группе организаторов — одно закреплённое сообщение-файл
 * «База заявок», которое бот обновляет при каждой заявке. Каждая заявка зашифрована
 * открытым ключом админки (X25519 + AES-256-GCM); расшифровать можно только паролем админки,
 * поэтому файл бесполезен без пароля даже тому, у кого есть токен бота.
 */
const crypto = require("crypto");

const BOT_TOKEN = "9056095540:AAHis1R2BVMf5Zgxrx_r-NzyhfBrTguC0EY";
const CHAT_ID = "-1004434135380";
const TG = process.env.TG_API_BASE || "https://api.telegram.org";       // переопределяется только в локальных тестах

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD_SHA256 = "0eba393e80338601945f5f8549c11b5562954654d67c6d78bb991493f165a60a";
const ADMIN_PUBLIC_KEY = "WA7YIGwQfOuz58N//Ujbttbd89J5ayKWiKDLMsFIq0M=";  // X25519, из пароля через PBKDF2
const KDF_SALT = "adrenaline-cyberfest-2026", KDF_ITER = 200000;
const POINTER_LANG = "eo";               // служебное описание бота (язык, которого нет у участников) хранит id сообщения-базы
const DB_CAPTION = "📦 База заявок сайта adrenalinefest.uz (зашифрована). Не удаляйте и не открепляйте — из неё работает админка.";

/* ---------------- Telegram ---------------- */
async function tg(method, params, file) {
  let body, headers;
  if (file) {
    body = new FormData();
    for (const [k, v] of Object.entries(params)) body.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    body.append(file.field, new Blob([file.data], { type: "application/json" }), file.name);
  } else {
    body = JSON.stringify(params); headers = { "Content-Type": "application/json" };
  }
  const r = await fetch(`${TG}/bot${BOT_TOKEN}/${method}`, { method: "POST", headers, body });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}
const dbFile = db => ({ field: "db", name: "cyberfest-db.json", data: JSON.stringify(db) });

async function dbMessageId(create) {
  const d = await tg("getMyDescription", { language_code: POINTER_LANG });
  const m = /^db:(\d+)$/.exec((d && d.description) || "");
  if (m) return Number(m[1]);
  if (!create) return 0;
  const msg = await tg("sendDocument", { chat_id: CHAT_ID, caption: DB_CAPTION, disable_notification: true },
    { ...dbFile({ v: 1, records: [] }), field: "document" });
  await tg("pinChatMessage", { chat_id: CHAT_ID, message_id: msg.message_id, disable_notification: true });
  await tg("setMyDescription", { description: "db:" + msg.message_id, language_code: POINTER_LANG });
  return msg.message_id;
}

async function readDb(create) {
  const id = await dbMessageId(create);
  if (!id) return { id: 0, db: { v: 1, records: [] } };
  let chat = await tg("getChat", { chat_id: CHAT_ID });
  if (!chat.pinned_message || chat.pinned_message.message_id !== id) {      // кто-то закрепил другое — возвращаем базу наверх
    await tg("pinChatMessage", { chat_id: CHAT_ID, message_id: id, disable_notification: true });
    chat = await tg("getChat", { chat_id: CHAT_ID });
  }
  const doc = chat.pinned_message && chat.pinned_message.document;
  if (!doc) throw new Error("db message has no document");
  const f = await tg("getFile", { file_id: doc.file_id });
  const r = await fetch(`${TG}/file/bot${BOT_TOKEN}/${f.file_path}`);
  return { id, db: JSON.parse(await r.text()) };
}

async function writeDb(id, db) {
  await tg("editMessageMedia", {
    chat_id: CHAT_ID, message_id: id,
    media: { type: "document", media: "attach://db", caption: `${DB_CAPTION}\nЗаявок: ${db.records.length}` }
  }, dbFile(db));
}

/* ---------------- шифрование ---------------- */
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
function encrypt(obj) {
  const adminPub = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, Buffer.from(ADMIN_PUBLIC_KEY, "base64")]), format: "der", type: "spki" });
  const eph = crypto.generateKeyPairSync("x25519");
  const ephPub = eph.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const key = crypto.createHash("sha256").update(Buffer.concat([crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: adminPub }), ephPub])).digest();
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final(), c.getAuthTag()]);
  return { e: ephPub.toString("base64"), i: iv.toString("base64"), c: data.toString("base64") };
}
function decryptor(password) {
  const seed = crypto.pbkdf2Sync(password, KDF_SALT, KDF_ITER, 32, "sha256");
  const priv = crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8, seed]), format: "der", type: "pkcs8" });
  return rec => {
    const ephPub = Buffer.from(rec.e, "base64");
    const pub = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, ephPub]), format: "der", type: "spki" });
    const key = crypto.createHash("sha256").update(Buffer.concat([crypto.diffieHellman({ privateKey: priv, publicKey: pub }), ephPub])).digest();
    const raw = Buffer.from(rec.c, "base64"), d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(rec.i, "base64"));
    d.setAuthTag(raw.subarray(-16));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(0, -16)), d.final()]).toString("utf8"));
  };
}

/* ---------------- логика ---------------- */
const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function safeEq(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function tashkentNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "long"
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.day}.${p.month}.${p.year}`, day: p.weekday, time: `${p.hour}:${p.minute}:${p.second}` };
}

async function register(d) {
  const type = d.type === "solo" ? "solo" : "team";
  const team = type === "team" ? clean(d.team, 60) : "";
  const raw = Array.isArray(d.players) && d.players.length ? d.players : [{ name: d.name, phone: d.phone, nick: d.nick }];
  const players = raw.slice(0, type === "solo" ? 1 : 5).map((p, k) => ({
    role: type === "solo" ? "Соло" : k === 0 ? "Капитан" : `Игрок ${k + 1}`,
    name: clean(p && p.name, 60), nick: clean(p && p.nick, 40), phone: clean(p && p.phone, 20)
  }));
  if (players.some(p => p.name.length < 2 || p.phone.replace(/\D/g, "").length !== 12) || (type === "team" && (team.length < 2 || players.length !== 5)))
    return { status: 400, body: { ok: false, error: "invalid" } };

  const when = tashkentNow();
  const payload = enc => ({ ...enc, ...when });
  const secret = encrypt({ type: type === "solo" ? "Соло" : "Команда", team, lang: d.lang === "uz" ? "uz" : "ru", players, ...when });
  const rid = crypto.randomUUID();

  // запись с проверкой: если параллельная заявка затёрла нашу — дописываем заново
  for (let attempt = 0; attempt < 5; attempt++) {
    const { id, db } = await readDb(true);
    let mine = db.records.find(r => r.id === rid);
    if (!mine) {
      const number = db.records.reduce((m, r) => Math.max(m, r.n), 0) + 1;
      mine = { id: rid, n: number, ...payload(secret) };
      db.records.push(mine);
      await writeDb(id, db);
    }
    await sleep(1500 + Math.random() * 700);
    const check = await readDb(false);
    const saved = check.db.records.find(r => r.id === rid);
    const dup = saved && check.db.records.some(r => r.id !== rid && r.n === saved.n);
    if (saved && !dup) return { status: 200, body: { ok: true, number: saved.n, ...when, notified: false } };
    if (saved && dup) {                                                 // одинаковый номер у двух заявок — берём новый
      check.db.records = check.db.records.filter(r => r.id !== rid);
      await writeDb(check.id, check.db);
    }
  }
  throw new Error("could not store record");
}

async function list(d) {
  const pass = String(d.password || "");
  const ok = safeEq(String(d.login || ""), ADMIN_LOGIN) && safeEq(crypto.createHash("sha256").update(pass, "utf8").digest("hex"), ADMIN_PASSWORD_SHA256);
  if (!ok) { await sleep(800); return { status: 401, body: { ok: false, error: "auth" } }; }
  const { db } = await readDb(false);
  const dec = decryptor(pass);
  const recs = db.records.map(r => { try { return { n: r.n, ...dec(r) }; } catch (e) { return null; } }).filter(Boolean).sort((a, b) => a.n - b.n);
  const applications = recs.map(r => ({
    number: r.n, date: r.date, day: r.day, time: r.time, type: r.type, team: r.team,
    name: r.players[0].name, phone: r.players[0].phone, nick: r.players[0].nick, count: r.players.length, lang: r.lang
  }));
  const players = recs.flatMap(r => r.players.map(p => ({ number: r.n, date: r.date, type: r.type, team: r.team, role: p.role, name: p.name, nick: p.nick, phone: p.phone })));
  return { status: 200, body: { ok: true, applications, players } };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(200).json({ ok: true, service: "adrenaline-registration" });
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  else if (body && typeof body === "object" && !body.action) {          // form-urlencoded: JSON пришёл ключом
    const k = Object.keys(body)[0];
    try { body = JSON.parse(k); } catch (e) { /* оставляем как есть */ }
  }
  if (!body || typeof body !== "object") return res.status(400).json({ ok: false, error: "bad_request" });
  try {
    const out = body.action === "register" ? await register(body)
      : body.action === "list" ? await list(body)
      : { status: 400, body: { ok: false, error: "unknown_action" } };
    res.status(out.status).json(out.body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server", detail: String(e && e.message || e).slice(0, 200) });
  }
};

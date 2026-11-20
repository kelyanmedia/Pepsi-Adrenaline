/**
 * Adrenaline Rush Cyber Fest — бэкенд заявок (Vercel Function), без внешних баз данных.
 *
 *   POST /api/registrations { action: "register", type, team, players[], lang } → номер участника
 *   POST /api/registrations { action: "list", login, password }               → данные для /admin
 *   POST /api/registrations { action: "setReg", login, password, open }      → открыть / закрыть регистрацию вручную
 *   POST /api/registrations { action: "dupDelete"|"dupMerge"|"dupIgnore", numbers, keep, login, password } → чистка дублей в админке
 *   GET  /api/registrations                                                   → { open } — идёт ли сейчас регистрация
 *
 * Регистрация закрывается автоматически в REG_END (28.11, 20:00 по Ташкенту). Админ может закрыть её
 * раньше или открыть снова — ручной режим хранится в служебном описании бота (язык REG_LANG).
 *
 * Где хранятся заявки: в Telegram-группе организаторов — одно сообщение-файл
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
const REG_LANG = "ia";                 // служебное описание бота с ручным режимом регистрации: "reg:open" / "reg:closed"
const REG_END = Date.parse("2026-11-28T20:00:00+05:00");
const DB_CAPTION = "📦 База заявок сайта adrenalinefest.uz (зашифрована). Не удаляйте это сообщение — из него работает админка.";

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

// Указатель на базу хранится в служебном описании бота: "db:<message_id>:<file_id>"
async function pointer() {
  const d = await tg("getMyDescription", { language_code: POINTER_LANG });
  const m = /^db:(\d+):(.+)$/.exec((d && d.description) || "");
  return m ? { id: Number(m[1]), file: m[2] } : null;
}
const setPointer = (id, file) => tg("setMyDescription", { description: `db:${id}:${file}`, language_code: POINTER_LANG });

async function readDb(create) {
  let ptr = await pointer();
  if (!ptr) {
    if (!create) return { id: 0, db: { v: 1, records: [] } };
    const msg = await tg("sendDocument", { chat_id: CHAT_ID, caption: DB_CAPTION, disable_notification: true },
      { ...dbFile({ v: 1, records: [] }), field: "document" });
    ptr = { id: msg.message_id, file: msg.document.file_id };
    await setPointer(ptr.id, ptr.file);
  }
  const f = await tg("getFile", { file_id: ptr.file });
  const r = await fetch(`${TG}/file/bot${BOT_TOKEN}/${f.file_path}`);
  return { id: ptr.id, file: ptr.file, db: JSON.parse(await r.text()) };
}

async function writeDb(id, db) {
  const msg = await tg("editMessageMedia", {
    chat_id: CHAT_ID, message_id: id,
    media: { type: "document", media: "attach://db", caption: `${DB_CAPTION}\nЗаявок: ${db.records.length}` }
  }, dbFile(db));
  await setPointer(id, msg.document.file_id);
  return msg.document.file_id;
}

/* ---------------- статус регистрации ---------------- */
let regCache = null;                     // { mode, at } — чтобы не дёргать Telegram на каждый запрос
async function regMode(fresh) {
  if (!fresh && regCache && Date.now() - regCache.at < 10000) return regCache.mode;
  const d = await tg("getMyDescription", { language_code: REG_LANG });
  const m = /^reg:(open|closed)$/.exec((d && d.description) || "");
  regCache = { mode: m ? m[1] : "auto", at: Date.now() };
  return regCache.mode;
}
async function regStatus(fresh) {
  const mode = await regMode(fresh);
  const open = mode === "open" ? true : mode === "closed" ? false : Date.now() < REG_END;
  return { open, mode, regEnd: new Date(REG_END).toISOString() };
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
  const players = raw.slice(0, type === "solo" ? 1 : 6).map((p, k) => ({
    role: type === "solo" ? "Соло" : k === 0 ? "Капитан" : k === 5 ? "Запасной" : `Игрок ${k + 1}`,
    name: clean(p && p.name, 60), nick: clean(p && p.nick, 40), steam: clean(p && p.steam, 80), phone: clean(p && p.phone, 20)
  }));
  if (players.some(p => p.name.length < 2 || p.phone.replace(/\D/g, "").length !== 12) || (type === "team" && (team.length < 2 || players.length < 5)))
    return { status: 400, body: { ok: false, error: "invalid" } };

  if (!(await regStatus(true)).open) return { status: 403, body: { ok: false, error: "closed" } };

  const when = tashkentNow();
  const payload = enc => ({ ...enc, ...when });
  const secret = encrypt({ type: type === "solo" ? "Соло" : "Команда", team, lang: d.lang === "uz" ? "uz" : "ru", players, ...when });
  const rid = crypto.randomUUID();

  // запись с проверкой: перед записью сверяем, что базу никто не обновил; после — что наша заявка на месте
  for (let attempt = 0; attempt < 8; attempt++) {
    const { id, file, db } = await readDb(true);
    let mine = db.records.find(r => r.id === rid), written = null;
    if (!mine) {
      const number = db.records.reduce((m, r) => Math.max(m, r.n), db.seq || 0) + 1;
      mine = { id: rid, n: number, ...payload(secret) };
      db.records.push(mine);
      const now = await pointer();
      if (now && now.file !== file) { await sleep(80 + Math.random() * 200); continue; }   // кто-то успел записать — перечитываем
      written = await writeDb(id, db);
    }
    await sleep(200 + Math.random() * 200);
    // быстрая проверка: если база всё ещё наша версия — заявка точно сохранена
    if (written) { const p = await pointer(); if (p && p.file === written) return { status: 200, body: { ok: true, number: mine.n, ...when, notified: false } }; }
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

const isAdmin = d => safeEq(String(d.login || ""), ADMIN_LOGIN) &&
  safeEq(crypto.createHash("sha256").update(String(d.password || ""), "utf8").digest("hex"), ADMIN_PASSWORD_SHA256);

// Ручное управление: «закрыть» — всегда закрыто; «открыть» до дедлайна — снова авторежим (закроется сам в 20:00 28.11),
// после дедлайна — открыто, пока админ не закроет.
async function setReg(d) {
  if (!isAdmin(d)) { await sleep(800); return { status: 401, body: { ok: false, error: "auth" } }; }
  const desc = d.open ? (Date.now() < REG_END ? "" : "reg:open") : "reg:closed";
  await tg("setMyDescription", { description: desc, language_code: REG_LANG });
  regCache = null;
  return { status: 200, body: { ok: true, reg: await regStatus(true) } };
}

/* ---------------- дубли: удалить / объединить / «не дубль» ---------------- */
const phoneKey = v => { const x = String(v || "").replace(/\D/g, ""); return x.length >= 9 ? x.slice(-9) : ""; };
function steamKey(v) {
  let s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  let m = /(7656119\d{10})/.exec(s); if (m) return m[1];
  m = /steamcommunity\.com\/id\/([^\/?#\s]+)/.exec(s); if (m) return m[1];
  s = s.replace(/^https?:\/\/(www\.)?/, "").replace(/[\/\s]+$/, "");
  return s.length >= 5 ? s : "";
}
const nums = a => [...new Set((Array.isArray(a) ? a : []).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 60);

// чтение → изменение → запись; если за это время базу обновил кто-то другой — повторяем
async function mutateDb(fn) {
  for (let a = 0; a < 6; a++) {
    const { id, file, db } = await readDb(false);
    if (!id) return { status: 404, body: { ok: false, error: "empty" } };
    const res = fn(db);
    if (res && res.error) return { status: 400, body: { ok: false, error: res.error } };
    const now = await pointer();
    if (now && now.file !== file) { await sleep(100 + Math.random() * 250); continue; }
    await writeDb(id, db);
    return { status: 200, body: { ok: true, ...(res || {}) } };
  }
  return { status: 503, body: { ok: false, error: "busy" } };
}
const bumpSeq = db => { db.seq = db.records.reduce((m, r) => Math.max(m, r.n), db.seq || 0); };

async function dupAction(d) {
  if (!isAdmin(d)) { await sleep(800); return { status: 401, body: { ok: false, error: "auth" } }; }
  const list = nums(d.numbers);
  if (!list.length) return { status: 400, body: { ok: false, error: "bad_request" } };

  if (d.action === "dupIgnore") {                       // пометка «это не дубль» (хранятся только номера заявок)
    const key = list.slice().sort((a, b) => a - b).join(",");
    return mutateDb(db => {
      const set = new Set(db.ignored || []);
      d.undo ? set.delete(key) : set.add(key);
      db.ignored = [...set];
    });
  }
  if (d.action === "dupDelete") {
    return mutateDb(db => {
      const del = db.records.filter(r => list.includes(r.n));
      if (!del.length) return { error: "not_found" };
      bumpSeq(db);
      db.records = db.records.filter(r => !list.includes(r.n));
      return { deleted: del.length };
    });
  }
  // dupMerge: заявки из numbers вливаются в keep; игроки с тем же телефоном / Steam ID склеиваются, пустые поля дополняются
  const keep = Number(d.keep);
  const others = list.filter(n => n !== keep);
  if (!keep || !others.length) return { status: 400, body: { ok: false, error: "bad_request" } };
  const dec = decryptor(String(d.password || ""));
  return mutateDb(db => {
    const kr = db.records.find(r => r.n === keep), ors = others.map(n => db.records.find(r => r.n === n));
    if (!kr || ors.some(r => !r)) return { error: "not_found" };
    let kd, ods;
    try { kd = dec(kr); ods = ors.map(dec); } catch (e) { return { error: "decrypt" }; }
    const players = kd.players.map(p => ({ ...p }));
    let team = kd.team;
    for (const od of ods) {
      if (!team && od.team) team = od.team;
      for (const p of od.players) {
        const pk = phoneKey(p.phone), sk = steamKey(p.steam);
        const hit = players.find(x => (pk && phoneKey(x.phone) === pk) || (sk && steamKey(x.steam) === sk));
        if (hit) { for (const f of ["name", "nick", "steam", "phone"]) if (!hit[f] && p[f]) hit[f] = p[f]; }
        else players.push({ ...p });
      }
    }
    const solo = kd.type === "Соло";
    if (players.length > (solo ? 1 : 6)) return { error: "too_many" };
    players.forEach((p, k) => { p.role = solo ? "Соло" : k === 0 ? "Капитан" : k === 5 ? "Запасной" : `Игрок ${k + 1}`; });
    Object.assign(kr, encrypt({ ...kd, team, players }));
    bumpSeq(db);
    db.records = db.records.filter(r => !others.includes(r.n));
    return { merged: others.length, players: players.length };
  });
}

async function list(d) {
  const pass = String(d.password || "");
  if (!isAdmin(d)) { await sleep(800); return { status: 401, body: { ok: false, error: "auth" } }; }
  const { db } = await readDb(false);
  const dec = decryptor(pass);
  const recs = db.records.map(r => { try { return { n: r.n, ...dec(r) }; } catch (e) { return null; } }).filter(Boolean).sort((a, b) => a.n - b.n);
  const applications = recs.map(r => ({
    number: r.n, date: r.date, day: r.day, time: r.time, type: r.type, team: r.team,
    name: r.players[0].name, phone: r.players[0].phone, nick: r.players[0].nick, steam: r.players[0].steam || "", count: r.players.length, lang: r.lang
  }));
  const players = recs.flatMap(r => r.players.map(p => ({ number: r.n, date: r.date, type: r.type, team: r.team, role: p.role, name: p.name, nick: p.nick, steam: p.steam || "", phone: p.phone })));
  return { status: 200, body: { ok: true, applications, players, ignored: db.ignored || [], reg: await regStatus(true) } };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    let reg = null;
    try { reg = await regStatus(false); } catch (e) { reg = { open: Date.now() < REG_END, mode: "auto", regEnd: new Date(REG_END).toISOString() }; }
    return res.status(200).json({ ok: true, service: "adrenaline-registration", ...reg });
  }
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
      : body.action === "setReg" ? await setReg(body)
      : /^dup(Delete|Merge|Ignore)$/.test(body.action) ? await dupAction(body)
      : { status: 400, body: { ok: false, error: "unknown_action" } };
    res.status(out.status).json(out.body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server", detail: String(e && e.message || e).slice(0, 200) });
  }
};

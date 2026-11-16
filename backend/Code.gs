/**
 * Adrenaline Rush Cyber Fest — бэкенд заявок (Google Apps Script).
 *
 * Что делает:
 *   • register — сохраняет заявку в Google Таблицу, присваивает номер участника,
 *                шлёт уведомление в Telegram-группу, возвращает номер сайту;
 *   • list     — отдаёт всех участников админке (только по логину и паролю).
 *
 * Логин, пароль и токен бота НЕ хранятся в коде: они лежат в «Свойствах скрипта».
 * Как подключить — см. backend/SETUP.md
 */

const SHEET_NAME = "Участники";
const TZ = "Asia/Tashkent";
const HEADERS = ["№", "Дата", "День", "Время", "Тип", "Имя", "Телефон", "Команда", "Ник", "Язык"];
const DAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

/** Запустите ОДИН раз: впишите свои значения и нажмите «Выполнить» → setup */
function setup() {
  PropertiesService.getScriptProperties().setProperties({
    ADMIN_LOGIN: "admin",
    ADMIN_PASSWORD: "ПРИДУМАЙТЕ_ПАРОЛЬ",
    BOT_TOKEN: "ТОКЕН_БОТА",
    CHAT_ID: "-1004434135380"
  });
}

function doGet() {
  return json({ ok: true, service: "adrenaline-registration" });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: "bad_request" }); }
  if (body.action === "register") return register(body);
  if (body.action === "list") return list(body);
  return json({ ok: false, error: "unknown_action" });
}

/* ---------------- регистрация ---------------- */
function register(d) {
  const name = clean(d.name, 60), team = clean(d.team, 60), nick = clean(d.nick, 40);
  const phone = clean(d.phone, 20);
  const type = d.type === "solo" ? "solo" : "team";
  const lang = d.lang === "uz" ? "uz" : "ru";
  if (name.length < 2 || phone.replace(/\D/g, "").length !== 12 || (type === "team" && team.length < 2)) {
    return json({ ok: false, error: "invalid" });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let row;
  try {
    const sh = sheet();
    const number = Math.max(sh.getLastRow(), 1);               // строка 1 — заголовки
    const now = new Date();
    const date = Utilities.formatDate(now, TZ, "dd.MM.yyyy");
    const time = Utilities.formatDate(now, TZ, "HH:mm:ss");
    const day = DAYS[Number(Utilities.formatDate(now, TZ, "u")) % 7];
    row = { number: number, date: date, day: day, time: time, type: type, name: name, phone: phone, team: type === "solo" ? "" : team, nick: nick, lang: lang };
    const r = sh.getLastRow() + 1;
    sh.getRange(r, 1, 1, HEADERS.length).setNumberFormat("@")
      .setValues([[row.number, row.date, row.day, row.time, row.type === "solo" ? "Соло" : "Команда", row.name, row.phone, row.team, row.nick, row.lang]]);
  } finally {
    lock.releaseLock();
  }

  try { notify(row); } catch (err) { /* заявка уже сохранена — Telegram не должен её ломать */ }
  return json({ ok: true, number: row.number, date: row.date, day: row.day, time: row.time });
}

function notify(r) {
  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty("BOT_TOKEN"), chat = p.getProperty("CHAT_ID");
  if (!token || !chat) return;
  const solo = r.type === "solo";
  const text = [
    "🏆 <b>Участник #" + r.number + "</b>",
    "🔥 <b>Новая заявка</b> — " + (solo ? "СОЛО игрок" : "КОМАНДА"),
    "",
    "🗓 <b>Дата:</b> " + r.date + ", " + r.day,
    "🕒 <b>Время:</b> " + r.time.slice(0, 5) + " (Ташкент)",
    "",
    "👤 <b>Имя:</b> " + esc(r.name),
    "📞 <b>Телефон:</b> " + esc(r.phone),
    solo ? null : "🛡 <b>Команда:</b> " + esc(r.team),
    "🎮 <b>Ник:</b> " + (r.nick ? esc(r.nick) : "—"),
    "🌐 <b>Язык сайта:</b> " + (r.lang === "uz" ? "O‘zbekcha" : "Русский")
  ].filter(function (l) { return l !== null; }).join("\n");
  UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    payload: JSON.stringify({ chat_id: chat, text: text, parse_mode: "HTML", disable_web_page_preview: true })
  });
}

/* ---------------- список для админки ---------------- */
function list(d) {
  const p = PropertiesService.getScriptProperties();
  const okLogin = safeEq(String(d.login || ""), p.getProperty("ADMIN_LOGIN") || "");
  const okPass = safeEq(String(d.password || ""), p.getProperty("ADMIN_PASSWORD") || "");
  if (!okLogin || !okPass || !p.getProperty("ADMIN_PASSWORD")) {
    Utilities.sleep(800);                                        // тормозим подбор пароля
    return json({ ok: false, error: "auth" });
  }
  const sh = sheet();
  const last = sh.getLastRow();
  const rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, HEADERS.length).getDisplayValues().map(function (v) {
    return { number: Number(v[0]), date: v[1], day: v[2], time: v[3], type: v[4], name: v[5], phone: v[6], team: v[7], nick: v[8], lang: v[9] };
  });
  return json({ ok: true, rows: rows, serverTime: Utilities.formatDate(new Date(), TZ, "HH:mm:ss") });
}

/* ---------------- утилиты ---------------- */
function sheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold").setBackground("#d9b25f");
    sh.setFrozenRows(1);
  }
  return sh;
}
function clean(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max); }
function esc(v) { return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function pad(n) { return ("0000" + n).slice(-4); }
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

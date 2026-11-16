/**
 * Adrenaline Rush Cyber Fest — бэкенд заявок (Google Apps Script).
 *
 *   • register — сохраняет заявку (команда 5x5 или соло) в Google Таблицу, присваивает номер участника,
 *                возвращает номер сайту (Telegram-уведомление с номером отправляет сам сайт);
 *   • list     — отдаёт заявки и игроков админке (только по логину и паролю).
 *
 * Листы таблицы:
 *   «Заявки» — одна строка на заявку (команда или соло-игрок);
 *   «Игроки» — одна строка на каждого игрока (капитан, игроки 2–5, соло).
 *
 * Как подключить — backend/SETUP.md
 */

const TZ = "Asia/Tashkent";
const APPS = "Заявки";
const PLAYERS = "Игроки";
const APP_HEADERS = ["№", "Дата", "День", "Время", "Тип", "Команда", "Капитан / игрок", "Телефон", "Ник", "Игроков", "Язык"];
const PLAYER_HEADERS = ["№ заявки", "Дата", "Тип", "Команда", "Роль", "Имя", "Ник", "Телефон"];
const DAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

/** Логин админки и SHA-256 хеш пароля (сам пароль в коде не хранится).
 *  Сменить пароль: посчитайте SHA-256 нового пароля и замените строку ниже. */
const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD_SHA256 = "0eba393e80338601945f5f8549c11b5562954654d67c6d78bb991493f165a60a";

/** Необязательно: создаёт листы заранее (иначе они создадутся при первой заявке). */
function setup() {
  sheet(APPS, APP_HEADERS); sheet(PLAYERS, PLAYER_HEADERS);
  Logger.log("Готово: листы «" + APPS + "» и «" + PLAYERS + "» созданы, логин админки = " + ADMIN_LOGIN);
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
  const type = d.type === "solo" ? "solo" : "team";
  const lang = d.lang === "uz" ? "uz" : "ru";
  const team = type === "team" ? clean(d.team, 60) : "";
  const raw = Array.isArray(d.players) && d.players.length ? d.players
    : [{ name: d.name, phone: d.phone, nick: d.nick }];                    // старый формат формы
  const players = raw.slice(0, type === "solo" ? 1 : 5).map(function (p, k) {
    return {
      role: type === "solo" ? "Соло" : (k === 0 ? "Капитан" : "Игрок " + (k + 1)),
      name: clean(p && p.name, 60), nick: clean(p && p.nick, 40), phone: clean(p && p.phone, 20)
    };
  });
  const bad = players.some(function (p) { return p.name.length < 2 || p.phone.replace(/\D/g, "").length !== 12; });
  if (bad || (type === "team" && (team.length < 2 || players.length !== 5))) return json({ ok: false, error: "invalid" });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let res;
  try {
    const apps = sheet(APPS, APP_HEADERS), pl = sheet(PLAYERS, PLAYER_HEADERS);
    const number = apps.getLastRow();                                       // строка 1 — заголовки
    const now = new Date();
    const date = Utilities.formatDate(now, TZ, "dd.MM.yyyy");
    const time = Utilities.formatDate(now, TZ, "HH:mm:ss");
    const day = DAYS[Number(Utilities.formatDate(now, TZ, "u")) % 7];
    const typeRu = type === "solo" ? "Соло" : "Команда";
    const cap = players[0];
    apps.getRange(apps.getLastRow() + 1, 1, 1, APP_HEADERS.length).setNumberFormat("@")
      .setValues([[number, date, day, time, typeRu, team, cap.name, cap.phone, cap.nick, players.length, lang]]);
    pl.getRange(pl.getLastRow() + 1, 1, players.length, PLAYER_HEADERS.length).setNumberFormat("@")
      .setValues(players.map(function (p) { return [number, date, typeRu, team, p.role, p.name, p.nick, p.phone]; }));
    res = { ok: true, number: number, date: date, day: day, time: time, notified: false };
  } finally {
    lock.releaseLock();
  }
  return json(res);
}

/* ---------------- данные для админки ---------------- */
function list(d) {
  const okLogin = safeEq(String(d.login || ""), ADMIN_LOGIN);
  const okPass = safeEq(sha256(String(d.password || "")), ADMIN_PASSWORD_SHA256);
  if (!okLogin || !okPass) {
    Utilities.sleep(800);                                                   // тормозим подбор пароля
    return json({ ok: false, error: "auth" });
  }
  const read = function (name, headers) {
    const sh = sheet(name, headers), last = sh.getLastRow();
    return last < 2 ? [] : sh.getRange(2, 1, last - 1, headers.length).getDisplayValues();
  };
  const apps = read(APPS, APP_HEADERS).map(function (v) {
    return { number: Number(v[0]), date: v[1], day: v[2], time: v[3], type: v[4], team: v[5], name: v[6], phone: v[7], nick: v[8], count: Number(v[9]) || 1, lang: v[10] };
  });
  const players = read(PLAYERS, PLAYER_HEADERS).map(function (v) {
    return { number: Number(v[0]), date: v[1], type: v[2], team: v[3], role: v[4], name: v[5], nick: v[6], phone: v[7] };
  });
  return json({ ok: true, applications: apps, players: players });
}

/* ---------------- утилиты ---------------- */
function sheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold").setBackground("#d9b25f");
    sh.setFrozenRows(1);
  }
  return sh;
}
function sha256(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) { return ("0" + (b & 255).toString(16)).slice(-2); }).join("");
}
function clean(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max); }
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

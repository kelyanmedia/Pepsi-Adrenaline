/**
 * Приём заявок с register.html в Google Таблицу.
 *
 * 1. Создайте Google Таблицу → Расширения → Apps Script → вставьте этот код.
 * 2. Развернуть → Новое развёртывание → тип «Веб-приложение»:
 *    выполнять от имени «Меня», доступ — «Все».
 * 3. Скопируйте URL веб-приложения (https://script.google.com/macros/s/.../exec)
 *    и вставьте в register.html → CONFIG.endpoint.
 */
const SHEET = "Заявки";
const HEADERS = ["Дата", "Тип", "Имя", "Телефон", "Команда", "Ник", "Язык"];

function doPost(e) {
  const p = e.parameter || {};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET) || ss.insertSheet(SHEET);
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  sh.appendRow([
    new Date(),
    p.type === "solo" ? "Соло" : "Команда",
    p.name || "", "'" + (p.phone || ""), p.team || "", p.nick || "", p.lang || ""
  ]);
  return ContentService.createTextOutput("ok");
}

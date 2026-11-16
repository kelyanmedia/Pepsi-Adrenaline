/* Общие настройки сайта (форма регистрации и админка).
   api — адрес веб-приложения Google Apps Script (см. backend/SETUP.md).
   Пока api пустой, форма шлёт заявку напрямую в Telegram (без номера участника), а админка не работает. */
window.APP_CONFIG = {
  api: "",
  thanksPage: "thanks.html",
  telegram: {                                   // запасной путь, пока не подключён api
    botToken: "9056095540:AAHis1R2BVMf5Zgxrx_r-NzyhfBrTguC0EY",
    chatId: "-1004434135380"
  }
};

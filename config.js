/* Общие настройки сайта (форма регистрации и админка).
   api — бэкенд заявок на Vercel (api/registrations.js): номер участника, хранение, админка /admin.
   Пока к проекту Vercel не подключено хранилище (см. ADMIN.md), форма шлёт заявки напрямую в Telegram. */
window.APP_CONFIG = {
  api: "/api/registrations",
  thanksPage: "/thanks",
  telegram: {
    botToken: "9056095540:AAHis1R2BVMf5Zgxrx_r-NzyhfBrTguC0EY",
    chatId: "-1004434135380"
  }
};

import type { TKey } from "./en";

export const ru: Partial<Record<TKey, string>> = {
  "settings.serverUrl.name": "Адрес сервера",
  "settings.serverUrl.desc": "ws:// или wss://",
  "settings.vaultToken.name": "Токен vault",
  "settings.reconnect.button": "Переподключиться",
  "settings.confirmMerge.name": "Подтвердить слияние",
  "settings.confirmMerge.desc":
    "Разрешить объединить этот непустой vault с непустым серверным — только если это один и тот же vault.",
  "setup.title": "Подключить сервер синхронизации?",
  "setup.message":
    "Для этого vault будет установлен сервер {server}, текущий токен будет заменён. Продолжайте, только если открыли эту ссылку или QR-код из настройки собственного сервера.",
  "setup.confirm": "Подключить",
  "setup.cancel": "Отмена",
  "setup.applied": "Notabeam: подключено к {server}.",
  "setup.invalid": "Notabeam: некорректная setup-ссылка.",
  "onboarding.title": "Как начать",
  "onboarding.intro":
    "Этот vault ещё не подключён. Запустите свой сервер синхронизации одной командой на любом Linux-сервере:",
  "onboarding.link":
    "Мастер настройки напечатает setup-ссылку и QR-код — кликните ссылку на компьютере или отсканируйте QR с телефона, и плагин настроится сам. Можно также ввести адрес сервера и токен вручную ниже.",
  "onboarding.guide": "Полный гайд по self-hosting (Docker, Kubernetes, LAN) →",
  "binding.mismatch":
    "Notabeam: синхронизация остановлена. Этот vault привязан к {bound}…, а сервер сообщил {server}…. Похоже, указан не тот сервер/токен.",
  "binding.needConfirm":
    "Notabeam: и этот vault, и серверный непустые. Чтобы объединить их, включите «Подтвердить слияние» в настройках Notabeam — только если это один и тот же vault.",
  "binding.invalid":
    "Notabeam: синхронизация остановлена. Сервер не идентифицировал vault. Подключение отклонено в целях безопасности — проверьте адрес сервера и токен.",
  "attachment.tooLarge":
    "Notabeam: «{path}» ({size} МБ) превышает лимит {max} МБ и не синхронизировано.",
  "file.synced": "Синхронизировано",
  "file.pending": "Синхронизация…",
  "file.error": "Не синхронизировано — ошибка",
  "status.disabled": "Notabeam: не настроено",
  "status.connecting": "Notabeam: подключение…",
  "status.synced": "Notabeam: синхронизировано",
  "status.offline": "Notabeam: оффлайн, переподключение…",
  "status.error": "Notabeam: ошибка — проверьте настройки",
};

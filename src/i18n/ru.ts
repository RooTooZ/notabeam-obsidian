import type { TKey } from "./en";

export const ru: Partial<Record<TKey, string>> = {
  "settings.serverUrl.name": "Адрес сервера",
  "settings.serverUrl.desc": "ws:// или wss://",
  "settings.vaultToken.name": "Токен vault",
  "settings.reconnect.button": "Переподключиться",
  "settings.confirmMerge.name": "Подтвердить слияние",
  "settings.confirmMerge.desc":
    "Разрешить объединить этот непустой vault с непустым серверным — только если это один и тот же vault.",
  "binding.mismatch":
    "Notabeam: синхронизация остановлена. Этот vault привязан к {bound}…, а сервер сообщил {server}…. Похоже, указан не тот сервер/токен.",
  "binding.needConfirm":
    "Notabeam: и этот vault, и серверный непустые. Чтобы объединить их, включите «Подтвердить слияние» в настройках Notabeam — только если это один и тот же vault.",
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

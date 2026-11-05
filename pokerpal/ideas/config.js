// Настройки доски. Токены — из CloudKit Console → Settings → Tokens & Keys → API Tokens, у каждого окружения свой.
// Они публичные по замыслу Apple: дают только то, что разрешено всем, и работают лишь с доменов из своих настроек.
window.IDEAS_CONFIG = {
  appName: "PokerPal",
  containerIdentifier: "iCloud.com.mikemailyan.PokerPal",
  apiTokens: {
    development: "1c9a49fbc9f9fe95b05ad51c36b59f8b88ad39b2a86ef4f957fcade393856945",
    production: "",
  },
};

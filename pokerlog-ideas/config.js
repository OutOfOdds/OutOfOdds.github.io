// Настройки доски. Токены — из CloudKit Console → Settings → Tokens & Keys → API Tokens, у каждого окружения свой.
// Они публичные по замыслу Apple: дают только то, что разрешено всем, и работают лишь с доменов из своих настроек.
window.IDEAS_CONFIG = {
  appName: "PokerLog",
  containerIdentifier: "iCloud.com.mikemailyan.PokerLog",
  apiTokens: {
    development: "02b31f1faa2ff737ecf1d0739d133dce64f003f4b9938ba151b238eef950530c",
    production: "ff44567ec3ab80e56b7483e6c1499bfe252461884452e9871dc2cd9cbc1dd05d",
  },
};

require("dotenv").config();

module.exports = {
  // Discord Bot
  botToken: process.env.DISCORD_BOT_TOKEN || "",
  clientId: process.env.CLIENT_ID || "",

  // User account token used to fetch the official quests from Discord API
  userToken: process.env.DISCORD_USER_TOKEN || "",

  // Channel where the quest embed will be sent
  notificationChannelId: process.env.NOTIFICATION_CHANNEL_ID || "1414963290391707779",

  // Role ID to mention when a new quest is published (optional)
  notificationRoleId: process.env.NOTIFICATION_ROLE_ID || "",

  // Links
  websiteUrl: process.env.WEBSITE_URL || "https://quester-service.vercel.app/quests",
  supportServerUrl: process.env.SUPPORT_SERVER_URL || "https://discord.gg/Yeb9bRX7Qf",

  // Custom server emojis per task type (falls back to a plain emoji if missing)
  taskEmojis: {
    WATCH_VIDEO: "<:WATCH_VIDEO:1574203472146866176>",
    WATCH_VIDEO_ON_MOBILE: "<:WATCH_VIDEO:1574203472146866176>",
    PLAY_ON_DESKTOP: "<:PLAY_ON_DESKTOP:1574203536462319708>",
    PLAY_ON_PLAYSTATION: "<:PLAY_ON_PLAYSTATION:1574203647229825094>",
    PLAY_ON_XBOX: "<:PLAY_ON_XBOX:1574203710106640415>",
  },

  // Check interval cron expression (default: every 5 minutes)
  cronInterval: process.env.CRON_INTERVAL || "*/5 * * * *",
};


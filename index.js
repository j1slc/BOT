require("dotenv").config();
const axios = require("axios");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require("discord.js");
const cron = require("node-cron");
const config = require("./config");
const { checkNewQuests, fetchDiscordQuests, sendQuestEmbed } = require("./notifier");
const { HeadlessDiscordClient } = require("./streamer");

/**
 * Validate a Discord user token before starting a stream session
 */
async function validateDiscordUserToken(token) {
  if (!token) return { valid: false, error: "لم يتم تقديم التوكن (فارغ)" };
  const clean = token.trim().replace(/^["']|["']$/g, "");
  try {
    const res = await axios.get("https://discord.com/api/v9/users/@me", {
      headers: {
        Authorization: clean,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      timeout: 8000,
    });
    if (res.status === 200 && res.data?.id) {
      const u = res.data;
      const tag =
        u.discriminator && u.discriminator !== "0"
          ? `${u.username}#${u.discriminator}`
          : `@${u.username}`;
      return { valid: true, user: u, tag };
    }
    return { valid: false, error: "التوكن غير صالح" };
  } catch (err) {
    if (err.response?.status === 401) {
      return { valid: false, error: "التوكن غير صالح أو منتهي الصلاحية (401 Unauthorized)" };
    }
    if (err.response?.status === 403) {
      return { valid: false, error: "الحساب مقيد أو يحتاج إلى تأكيد أمني برقم هاتف (403 Forbidden)" };
    }
    return { valid: false, error: err.message || "تعذر فحص التوكن" };
  }
}

if (!config.botToken) {
  console.error("❌ برجاء وضع DISCORD_BOT_TOKEN في ملف .env");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// Active streaming sessions map
const activeStreamSessions = new Map();

// ── SLASH COMMANDS DEFINITION ────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("stream")
    .setDescription("تشغيل أو إيقاف جلسة البث والمشاهدة التلقائية لتجميع ساعات شارة البث (Phenomenon)")
    .addSubcommand((sub) =>
      sub
        .setName("start")
        .setDescription("بدء جلسة البث والمشاهدة التلقائية")
        .addStringOption((opt) =>
          opt
            .setName("token")
            .setDescription("توكن حسابك الأساسي الذي سيبث (Streamer Token)")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("guild_id")
            .setDescription("معرف السيرفر (Server ID)")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("channel_id")
            .setDescription("معرف الروم الصوتي (Voice Channel ID)")
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("viewer_token")
            .setDescription("توكن حساب المشاهد (حساب فرعي أو صديق) لاحتساب الساعات")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("stop")
        .setDescription("إيقاف جلسة البث والمشاهدة النشطة")
    ),

  new SlashCommandBuilder()
    .setName("checkquests")
    .setDescription("فحص المهام الجديدة ونشرها في الروم فوراً (Admin)"),
].map((cmd) => cmd.toJSON());

// ── BOT READY ────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`====================================================`);
  console.log(`🤖 تم تشغيل بوت Quester بنجاح كـ: ${client.user.tag}`);
  console.log(`📢 روم إشعارات المهام: ${config.notificationChannelId}`);
  console.log(`====================================================`);

  // Register Slash commands if clientId is available
  if (config.clientId) {
    try {
      const rest = new REST({ version: "10" }).setToken(config.botToken);
      console.log("جاري تسجيل أوامر السلاش (Slash Commands)...");
      await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
      console.log("✅ تم تسجيل أوامر السلاش بنجاح!");
    } catch (err) {
      console.error("فشل تسجيل أوامر السلاش:", err.message);
    }
  }

  // 1. Initial check for new quests upon startup
  checkNewQuests(client).catch((err) => console.error("Initial quest check failed:", err));

  // 2. Schedule recurring quest checks (every 5 minutes by default)
  cron.schedule(config.cronInterval, () => {
    checkNewQuests(client).catch((err) => console.error("Cron quest check failed:", err));
  });
  console.log(`⏱️ تم تفعيل المجدول الدوري لفحص المهام بنمط: ${config.cronInterval}`);
});

// ── INTERACTIONS HANDLER ─────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // 1. Command: /checkquests
  if (interaction.commandName === "checkquests") {
    await interaction.deferReply({ ephemeral: true });
    try {
      await checkNewQuests(client);
      await interaction.editReply({
        content: "✅ تم فحص المهام ونشر الجديد منها بنجاح في روم الإشعارات!",
      });
    } catch (err) {
      await interaction.editReply({
        content: `❌ حدث خطأ أثناء فحص المهام: ${err.message}`,
      });
    }
  }

  // 2. Command: /stream
  if (interaction.commandName === "stream") {
    const subcommand = interaction.options.getSubcommand();
    const discordUserId = interaction.user.id;

    if (subcommand === "start") {
      await interaction.deferReply({ ephemeral: true });

      if (activeStreamSessions.has(discordUserId)) {
        return interaction.editReply({
          content: "⚠️ لديك جلسة بث نشطة بالفعل! يمكنك إيقافها أولاً باستخدام أمر `/stream stop`.",
        });
      }

      const streamerToken = interaction.options.getString("token").trim();
      const guildId = interaction.options.getString("guild_id").trim();
      const channelId = interaction.options.getString("channel_id").trim();
      const viewerToken = interaction.options.getString("viewer_token")?.trim() || "";

      // ── 1. فحص توكن صاحب البث (Streamer Token) ──
      const streamerCheck = await validateDiscordUserToken(streamerToken);
      if (!streamerCheck.valid) {
        return interaction.editReply({
          content: `❌ **توكن البث (Streamer Token) غير صالح!**\n> السبب: ${streamerCheck.error}\nيرجى التأكد من نسخ التوكن بشكل صحيح.`,
        });
      }

      // ── 2. فحص توكن المشاهد إذا تم إدخاله (Viewer Token) ──
      let viewerCheck = null;
      if (viewerToken) {
        viewerCheck = await validateDiscordUserToken(viewerToken);
        if (!viewerCheck.valid) {
          return interaction.editReply({
            content: `❌ **توكن المشاهد (Viewer Token) غير صالح!**\n> السبب: ${viewerCheck.error}\nيرجى التأكد من توكن الحساب الفرعي أو تركه فارغاً.`,
          });
        }
      }

      const startEmbed = new EmbedBuilder()
        .setTitle("🚀 بدء تشغيل جلسة البث والمشاهدة التلقائية")
        .setDescription("تم التحقق من التوكنات بنجاح ✓ جاري الاتصال بسيرفرات ديسكورد وبدء البث...")
        .setColor(0x5865f2)
        .addFields(
          { name: "حساب البث", value: `✅ ${streamerCheck.tag}`, inline: true },
          {
            name: "حساب المشاهد",
            value: viewerCheck ? `✅ ${viewerCheck.tag}` : "⚪ غير مفعل (يُنصح بوجود مشاهد)",
            inline: true,
          },
          { name: "السيرفر", value: guildId, inline: true },
          { name: "الروم الصوتي", value: channelId, inline: true }
        )
        .setFooter({ text: "ملاحظة: يمكنك إغلاق ديسكورد بالكامل والجلسة ستظل مستمرة في السيرفر." });

      await interaction.editReply({ embeds: [startEmbed] });

      const logHandler = (entry) => {
        console.log(`[User ${interaction.user.tag}] [${entry.source}] ${entry.message}`);
      };

      const streamerBot = new HeadlessDiscordClient(
        streamerToken,
        guildId,
        channelId,
        true,
        logHandler
      );

      let viewerBot = null;
      if (viewerToken) {
        viewerBot = new HeadlessDiscordClient(
          viewerToken,
          guildId,
          channelId,
          false,
          logHandler
        );
      }

      activeStreamSessions.set(discordUserId, {
        streamer: streamerBot,
        viewer: viewerBot,
        startTime: Date.now(),
      });

      await streamerBot.start();

      if (viewerBot) {
        setTimeout(async () => {
          await viewerBot.start();
          setTimeout(() => {
            if (streamerBot.streamKey) {
              viewerBot.watchStream(streamerBot.streamKey);
            }
          }, 3000);
        }, 4000);
      }
    }

    if (subcommand === "stop") {
      await interaction.deferReply({ ephemeral: true });

      const session = activeStreamSessions.get(discordUserId);
      if (!session) {
        return interaction.editReply({
          content: "❌ لا توجد أي جلسة بث نشطة لحسابك حالياً.",
        });
      }

      session.streamer.stop();
      if (session.viewer) session.viewer.stop();
      activeStreamSessions.delete(discordUserId);

      const durationMin = Math.round((Date.now() - session.startTime) / 60000);

      const stopEmbed = new EmbedBuilder()
        .setTitle("⏹️ تم إيقاف جلسة البث والمشاهدة بنجاح")
        .setDescription(`تم إنهاء الاتصال بنجاح. استمرت الجلسة لمدة تقارب **${durationMin} دقيقة**.`)
        .setColor(0xed4245)
        .setFooter({ text: "تحديث شارات ديسكورد ومزامنتها يستغرق عادة من 24 إلى 48 ساعة." });

      await interaction.editReply({ embeds: [stopEmbed] });
    }
  }
});

client.login(config.botToken);


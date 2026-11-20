const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const config = require("./config");

const DATA_DIR = path.join(__dirname, "data");
const SENT_FILE = path.join(DATA_DIR, "sent_quests.json");

function getSentQuestIds() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(SENT_FILE)) {
      const content = fs.readFileSync(SENT_FILE, "utf-8");
      return new Set(JSON.parse(content || "[]"));
    }
  } catch {}
  return new Set();
}

function saveSentQuestId(questId) {
  try {
    const ids = getSentQuestIds();
    ids.add(questId);
    fs.writeFileSync(SENT_FILE, JSON.stringify(Array.from(ids), null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save sent quest ID:", err);
  }
}

/**
 * Fetch current quests from Discord API using user token
 */
async function fetchDiscordQuests(userToken) {
  if (!userToken) return [];

  const headers = {
    Authorization: userToken.trim().replace(/^["']|["']$/g, ""),
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9253 Chrome/148.0.7778.280 Electron/42.7.1 Safari/537.36",
    "Content-Type": "application/json",
  };

  try {
    const res = await axios.get("https://discord.com/api/v9/quests/@me", {
      headers,
      timeout: 10000,
    });
    return res.data?.quests || [];
  } catch (err) {
    console.error("❌ خطأ أثناء جلب المهام من ديسكورد:", err.response?.data || err.message);
    return [];
  }
}

/**
 * Format and send the quest embed to the notification channel
 */
async function sendQuestEmbed(client, quest) {
  const channelId = config.notificationChannelId;
  let channel = client.channels.cache.get(channelId);
  if (!channel) {
    channel = await client.channels.fetch(channelId).catch((err) => {
      console.error(`❌ تعذر جلب الروم (${channelId}):`, err.message);
      return null;
    });
  }

  if (!channel || !channel.isTextBased()) {
    console.error(`❌ تعذر العثور على الروم أو الروم ليس كتابياً (ID: ${channelId})`);
    return false;
  }

  const qConfig = quest.config || {};
  const messages = qConfig.messages || {};
  const gameTitle = messages.game_title || qConfig.application?.name || "لعبة معتمدة";
  const questName = messages.quest_name || "مهمة ديسكورد جديدة";
  const gamePublisher = messages.game_publisher || "";

  // Rewards parsing
  const rewardsList = qConfig.rewards_config?.rewards || [];
  const rewardNames = rewardsList
    .map((r) => {
      const name = r.messages?.name_with_article || r.messages?.name || "مكافأة حصرية";
      return `🎁 **${name}**`;
    })
    .join("\n");

  // Task descriptions
  let taskText = "العب اللعبة لمدة 15 دقيقة أو قم ببثها لصديقك في روم صوتي";
  if (qConfig.task_config?.tasks) {
    const taskKeys = Object.keys(qConfig.task_config.tasks);
    if (taskKeys.includes("WATCH_VIDEO")) {
      taskText = "مشاهدة فيديو ترويجي لمدة دقيقة واحدة";
    } else if (taskKeys.includes("STREAM_ON_DESKTOP")) {
      taskText = "بث اللعبة لصديقك في روم صوتي لمدة 15 دقيقة";
    } else if (taskKeys.includes("PLAY_ON_DESKTOP") || taskKeys.includes("PLAY_ACTIVITY")) {
      taskText = "تشغيل اللعبة واللعب لمدة 15 دقيقة على الكمبيوتر";
    }
  }

  // Dates
  const expiresAt = qConfig.expires_at ? new Date(qConfig.expires_at) : null;
  const expireTimestamp = expiresAt ? Math.floor(expiresAt.getTime() / 1000) : null;

  // Colors
  const primaryColorHex = (qConfig.colors?.primary || "#5865F2").replace("#", "");
  const embedColor = parseInt(primaryColorHex, 16) || 0x5865f2;

  // Images
  const heroAsset = qConfig.assets?.hero;
  const heroImageUrl = heroAsset
    ? `https://cdn.discordapp.com/assets/quests/${quest.id}/${heroAsset}.png`
    : null;

  const appIcon = qConfig.application?.icon;
  const iconUrl = appIcon
    ? `https://cdn.discordapp.com/app-icons/${qConfig.application.id}/${appIcon}.png`
    : null;

  // Build the embed
  const embed = new EmbedBuilder()
    .setTitle(`🎮 مهمة ديسكورد جديدة: ${gameTitle}`)
    .setDescription(
      `نزل حدث ومهمة جديدة في ديسكورد! تفقد التفاصيل وأنجزها للحصول على جائزتك.\n\n` +
        `📝 **اسم المهمة:** ${questName}\n` +
        (gamePublisher ? `🏢 **الناشر:** ${gamePublisher}\n\n` : "\n") +
        `### 🏆 الجوائز المتاحة:\n${rewardNames || "🎁 جائزة حصرية للبروفايل"}\n\n` +
        `### 🎯 المطلوب لإنجاز المهمة:\n- ${taskText}\n\n` +
        (expireTimestamp
          ? `⏳ **تاريخ الانتهاء:** <t:${expireTimestamp}:F> (<t:${expireTimestamp}:R>)\n`
          : "")
    )
    .setColor(embedColor)
    .setTimestamp();

  if (heroImageUrl) embed.setImage(heroImageUrl);
  if (iconUrl) embed.setThumbnail(iconUrl);

  embed.setFooter({
    text: `Quester Notifier • ${qConfig.application?.name || "Discord Quest"}`,
    iconURL: iconUrl || undefined,
  });

  // Action Buttons
  const buttonsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("عرض المهمة في ديسكورد")
      .setEmoji("🔗")
      .setURL(`https://discord.com/quests/${quest.id}`),

    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("حل المهمة تلقائياً عبر Quester")
      .setEmoji("🚀")
      .setURL(config.websiteUrl),

    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("سيرفر الدعم")
      .setEmoji("💬")
      .setURL(config.supportServerUrl)
  );

  let content = "";
  if (config.notificationRoleId) {
    const r = config.notificationRoleId.trim();
    if (r === "everyone" || r === "@everyone") {
      content = "@everyone";
    } else if (r === "here" || r === "@here") {
      content = "@here";
    } else {
      content = `<@&${r.replace(/[^0-9]/g, "")}>`;
    }
  }

  try {
    const msg = await channel.send({
      content: content || undefined,
      embeds: [embed],
      components: [buttonsRow],
      allowedMentions: { parse: ["everyone", "roles", "users"] },
    });

    // Crosspost (publish) if announcement channel
    if (msg.crosspostable) {
      await msg.crosspost().catch(() => {});
    }

    console.log(`✅ [NOTIFIER] تم إرسال إشعار المهمة الجديدة بنجاح: ${questName} (ID: ${quest.id})`);
    return true;
  } catch (err) {
    console.error(`❌ فشل إرسال رسالة الإشعار للمهمة ${quest.id}:`, err);
    return false;
  }
}

/**
 * Check for new quests and notify channel
 */
async function checkNewQuests(client) {
  if (!config.userToken) {
    console.log("ℹ️ [NOTIFIER] لم يتم تعيين DISCORD_USER_TOKEN في ملف .env (تنبيهات المهام غير مفعلة)");
    return;
  }

  console.log("🔍 [NOTIFIER] جاري فحص المهام الجديدة من ديسكورد...");
  const quests = await fetchDiscordQuests(config.userToken);
  if (!quests || quests.length === 0) {
    console.log("ℹ️ [NOTIFIER] لا توجد مهام حالياً.");
    return;
  }

  const sentIds = getSentQuestIds();
  let newCount = 0;

  for (const quest of quests) {
    const qId = quest.id;
    if (!sentIds.has(qId)) {
      // It's a brand new quest!
      const sent = await sendQuestEmbed(client, quest);
      if (sent) {
        saveSentQuestId(qId);
        newCount++;
      }
    }
  }

  if (newCount > 0) {
    console.log(`🎉 [NOTIFIER] تم إرسال ${newCount} مهمة جديدة إلى الروم!`);
  } else {
    console.log("✓ [NOTIFIER] جميع المهام الحالية تم إرسالها مسبقاً، لا توجد مهام جديدة.");
  }
}

module.exports = {
  checkNewQuests,
  fetchDiscordQuests,
  sendQuestEmbed,
};


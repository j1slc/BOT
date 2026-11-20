const WebSocket = require("ws");

const DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=9&encoding=json";

class HeadlessDiscordClient {
  constructor(token, guildId, channelId, isStreamer, logCallback) {
    this.token = token.trim();
    this.guildId = guildId.trim();
    this.channelId = channelId.trim();
    this.isStreamer = isStreamer;
    this.logCallback = logCallback;

    this.running = false;
    this.ws = null;
    this.voiceWs = null;
    this.streamWs = null;

    this.userId = null;
    this.username = null;
    this.sessionId = null;
    this.streamKey = null;

    this.hbTimer = null;
    this.voiceHbTimer = null;
    this.streamHbTimer = null;
  }

  log(message) {
    const entry = {
      timestamp: new Date().toLocaleTimeString("ar-EG"),
      source: this.isStreamer ? "STREAMER" : "VIEWER",
      message,
    };
    if (this.logCallback) {
      this.logCallback(entry);
    }
  }

  async start() {
    this.running = true;
    this.log(`جاري الاتصال بـ Discord Gateway (${this.isStreamer ? "حساب البث" : "حساب المشاهد"})...`);

    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(DISCORD_GATEWAY);

        this.ws.on("open", () => {
          this.log("تم فتح قناة الاتصال الرئيسية مع سيرفرات ديسكورد.");
        });

        this.ws.on("message", async (data) => {
          try {
            const msg = JSON.parse(data.toString());
            const { op, t, d } = msg;

            if (op === 10) {
              const interval = d.heartbeat_interval;
              this.startHeartbeat(interval);

              const identify = {
                op: 2,
                d: {
                  token: this.token,
                  capabilities: 16381,
                  properties: {
                    os: "Windows",
                    browser: "Discord Client",
                    release_channel: "stable",
                    client_version: "1.0.9253",
                    os_version: "10.0.26200",
                  },
                  presence: {
                    status: "online",
                    since: 0,
                    activities: [],
                    afk: false,
                  },
                },
              };
              this.ws.send(JSON.stringify(identify));
              this.log("تم إرسال إشارة الدخول والتعريف (Identify)...");
            }

            if (t === "READY") {
              this.userId = d.user.id;
              this.username = `${d.user.username}`;
              this.sessionId = d.session_id;
              this.log(`تم تسجيل الدخول بنجاح كـ: ${this.username} (${this.userId}) ✓`);

              this.joinVoiceChannel();
            }

            if (t === "VOICE_SERVER_UPDATE") {
              this.connectToVoiceGateway(d);
            }

            if (t === "STREAM_CREATE") {
              if (d && d.stream_key) {
                this.streamKey = d.stream_key;
                this.log(`تم إنشاء مفتاح البث الرسمي بنجاح: ${this.streamKey}`);
              }
            }

            if (t === "STREAM_SERVER_UPDATE") {
              this.connectToStreamGateway(d);
            }
          } catch (err) {
            this.log(`خطأ في معالجة إشارة Gateway: ${err.message}`);
          }
        });

        this.ws.on("error", (err) => {
          this.log(`خطأ في اتصال Gateway: ${err.message}`);
        });

        this.ws.on("close", (code) => {
          this.log(`انقطع اتصال Gateway (كود: ${code})`);
          this.cleanup();
        });

        resolve();
      } catch (err) {
        this.log(`تعذر إنشاء اتصال WebSocket: ${err.message}`);
        resolve();
      }
    });
  }

  startHeartbeat(interval) {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: null }));
      }
    }, interval);
  }

  joinVoiceChannel() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.log(`جاري الانضمام إلى الروم الصوتي (${this.channelId}) في السيرفر (${this.guildId})...`);

    const voiceStateUpdate = {
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: this.channelId,
        self_mute: false,
        self_deaf: false,
        self_video: false,
      },
    };
    this.ws.send(JSON.stringify(voiceStateUpdate));
  }

  connectToVoiceGateway(data) {
    const endpoint = data.endpoint;
    const token = data.token;
    if (!endpoint) return;

    const voiceWssUrl = `wss://${endpoint.split(":")[0]}/?v=8`;
    this.log(`جاري الاتصال بـ Voice Gateway: ${voiceWssUrl}...`);

    try {
      this.voiceWs = new WebSocket(voiceWssUrl);

      this.voiceWs.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          const { op, d } = msg;

          if (op === 8) {
            const interval = d.heartbeat_interval;
            if (this.voiceHbTimer) clearInterval(this.voiceHbTimer);
            this.voiceHbTimer = setInterval(() => {
              if (this.voiceWs && this.voiceWs.readyState === WebSocket.OPEN) {
                this.voiceWs.send(JSON.stringify({ op: 3, d: Date.now() }));
              }
            }, interval);

            const voiceIdentify = {
              op: 0,
              d: {
                server_id: this.guildId,
                user_id: this.userId,
                session_id: this.sessionId,
                token: token,
                video: true,
                streams: [{ type: "video", rid: "100", quality: 100 }],
              },
            };
            this.voiceWs.send(JSON.stringify(voiceIdentify));
            this.log("تم الدخول إلى الروم الصوتي بنجاح وتجهيز قنوات الصوت والصورة ✓");

            if (this.isStreamer) {
              setTimeout(() => {
                this.publishStream();
              }, 1500);
            }
          }

          if (op === 2) {
            this.log("تمت مصادقة اتصال الصوت بنجاح (Voice Ready) ✓");
          }
        } catch {}
      });
    } catch (err) {
      this.log(`فشل الاتصال بـ Voice Gateway: ${err.message}`);
    }
  }

  publishStream() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.log("🚀 جاري بدء بث الشاشة التلقائي (Go Live Broadcast)...");

    const streamCreate = {
      op: 18,
      d: {
        type: "guild",
        guild_id: this.guildId,
        channel_id: this.channelId,
        preferred_region: null,
      },
    };
    this.ws.send(JSON.stringify(streamCreate));

    const gamePresence = {
      op: 3,
      d: {
        status: "online",
        since: 0,
        activities: [
          {
            name: "Valorant",
            type: 0,
            application_id: "700136079560441856",
            details: "Competitive Match",
            state: "In Game",
            timestamps: { start: Date.now() },
          },
        ],
        afk: false,
      },
    };
    this.ws.send(JSON.stringify(gamePresence));
    this.log("تم تعيين نشاط البث المعتمد (Game Presence: Valorant) لاحتساب الساعات بنجاح 🎮");
  }

  connectToStreamGateway(data) {
    const endpoint = data.endpoint;
    const token = data.token;
    if (!endpoint) return;

    const streamWssUrl = `wss://${endpoint.split(":")[0]}/?v=8`;

    try {
      this.streamWs = new WebSocket(streamWssUrl);

      this.streamWs.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          const { op, d } = msg;

          if (op === 8) {
            const interval = d.heartbeat_interval;
            if (this.streamHbTimer) clearInterval(this.streamHbTimer);
            this.streamHbTimer = setInterval(() => {
              if (this.streamWs && this.streamWs.readyState === WebSocket.OPEN) {
                this.streamWs.send(JSON.stringify({ op: 3, d: Date.now() }));
              }
            }, interval);

            const streamIdentify = {
              op: 0,
              d: {
                server_id: this.streamKey,
                user_id: this.userId,
                session_id: this.sessionId,
                token: token,
                video: true,
                streams: [{ type: "video", rid: "100", quality: 100 }],
              },
            };
            this.streamWs.send(JSON.stringify(streamIdentify));
            this.log(
              this.isStreamer
                ? "🟢 البث مباشر ونشط الآن في الروم الصوتي! جاري إرسال بيانات الفيديو لاحتساب الساعات..."
                : "👁️ المشاهد متصل الآن ويشاهد البث بنجاح! ديسكورد يقوم باحتساب الساعات حالياً."
            );
          }
        } catch {}
      });
    } catch (err) {
      this.log(`فشل الاتصال بـ Stream Gateway: ${err.message}`);
    }
  }

  watchStream(streamKey) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.log(`المشاهد يرسل طلب متابعة البث (Watch Stream: ${streamKey})...`);
    const streamWatch = {
      op: 19,
      d: { stream_key: streamKey },
    };
    this.ws.send(JSON.stringify(streamWatch));
  }

  stop() {
    this.running = false;
    this.log("جاري إنهاء الجلسة وإغلاق الاتصالات...");
    this.cleanup();
  }

  cleanup() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.voiceHbTimer) clearInterval(this.voiceHbTimer);
    if (this.streamHbTimer) clearInterval(this.streamHbTimer);

    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            op: 4,
            d: { guild_id: null, channel_id: null, self_mute: true, self_deaf: true, self_video: false },
          })
        );
        this.ws.close();
      }
    } catch {}

    try {
      if (this.voiceWs) this.voiceWs.close();
    } catch {}
    try {
      if (this.streamWs) this.streamWs.close();
    } catch {}

    this.ws = null;
    this.voiceWs = null;
    this.streamWs = null;
  }
}

module.exports = { HeadlessDiscordClient };


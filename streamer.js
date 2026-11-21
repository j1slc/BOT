const WebSocket = require("ws");

const DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=9&encoding=json";

class HeadlessDiscordClient {
  constructor(token, guildId, channelId, isStreamer, logCallback) {
    this.token = token.trim();
    this.guildId = String(guildId).trim();
    this.channelId = String(channelId).trim();
    this.isStreamer = Boolean(isStreamer);
    this.logCallback = logCallback;

    this.running = false;
    this.ws = null;
    this.voiceWs = null;
    this.streamWs = null;

    this.userId = null;
    this.username = null;
    this.sessionId = null;
    this.voiceSessionId = null;

    this.voiceEndpoint = null;
    this.voiceToken = null;
    this.streamKey = null;
    this.streamEndpoint = null;
    this.streamToken = null;

    this.hbTimer = null;
    this.voiceHbTimer = null;
    this.streamHbTimer = null;
    this.reconnectTimer = null;
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
    this.connectGateway();
  }

  connectGateway() {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(DISCORD_GATEWAY);

      this.ws.on("open", () => {
        this.log("تم فتح قناة الاتصال الرئيسية مع سيرفرات ديسكورد.");
      });

      this.ws.on("message", async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          const { op, t, d } = msg;

          // 1. Hello (op: 10)
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

          // 2. Ready (t: READY)
          if (t === "READY") {
            this.userId = d.user?.id;
            this.username = d.user?.username || "Unknown";
            this.sessionId = d.session_id;
            this.voiceSessionId = this.sessionId;
            this.log(`تم تسجيل الدخول بنجاح كـ: @${this.username} (${this.userId}) ✓`);

            // Clean previous session then join cleanly
            this.joinVoiceChannelClean();
          }

          // 3. VOICE_STATE_UPDATE (get actual voice session id)
          if (t === "VOICE_STATE_UPDATE") {
            if (d && d.user_id === this.userId) {
              if (d.session_id) {
                this.voiceSessionId = d.session_id;
              }
            }
          }

          // 4. VOICE_SERVER_UPDATE
          if (t === "VOICE_SERVER_UPDATE") {
            this.voiceEndpoint = d.endpoint;
            this.voiceToken = d.token;
            if (this.voiceEndpoint && this.voiceToken) {
              this.connectToVoiceGateway(this.voiceEndpoint, this.voiceToken);
            }
          }

          // 5. STREAM_CREATE (Streamer only)
          if (t === "STREAM_CREATE") {
            if (d && d.stream_key) {
              this.streamKey = d.stream_key;
              this.log(`تم إنشاء مفتاح البث الرسمي بنجاح: ${this.streamKey}`);
            }
          }

          // 6. STREAM_SERVER_UPDATE
          if (t === "STREAM_SERVER_UPDATE") {
            this.streamEndpoint = d.endpoint;
            this.streamToken = d.token;
            this.streamKey = d.stream_key || this.streamKey;
            if (this.streamEndpoint && this.streamToken && this.streamKey) {
              this.connectToStreamGateway(this.streamEndpoint, this.streamToken, this.streamKey);
            }
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
        this.cleanupVoiceAndStream();

        if (this.running) {
          this.log("جاري إعادة الاتصال تلقائياً بـ Gateway بعد 5 ثوانٍ...");
          this.reconnectTimer = setTimeout(() => {
            this.connectGateway();
          }, 5000);
        }
      });
    } catch (err) {
      this.log(`تعذر إنشاء اتصال WebSocket: ${err.message}`);
      if (this.running) {
        this.reconnectTimer = setTimeout(() => this.connectGateway(), 5000);
      }
    }
  }

  startHeartbeat(interval) {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: null }));
      }
    }, interval);
  }

  joinVoiceChannelClean() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // First leave to clear any ghost sessions
    try {
      this.ws.send(
        JSON.stringify({
          op: 4,
          d: {
            guild_id: this.guildId,
            channel_id: null,
            self_mute: true,
            self_deaf: true,
          },
        })
      );
    } catch { }

    setTimeout(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.log(`جاري الانضمام إلى الروم الصوتي (${this.channelId}) في السيرفر (${this.guildId})...`);

      const voiceJoin = {
        op: 4,
        d: {
          guild_id: this.guildId,
          channel_id: this.channelId,
          self_mute: !this.isStreamer,
          self_deaf: !this.isStreamer,
          self_video: false,
        },
      };
      this.ws.send(JSON.stringify(voiceJoin));

      if (this.isStreamer) {
        setTimeout(() => {
          this.publishStream();
        }, 1500);
      }
    }, 1000);
  }

  connectToVoiceGateway(endpoint, token) {
    if (!endpoint || !token) return;

    if (this.voiceWs) {
      try {
        this.voiceWs.close();
      } catch { }
      this.voiceWs = null;
    }
    if (this.voiceHbTimer) {
      clearInterval(this.voiceHbTimer);
      this.voiceHbTimer = null;
    }

    const cleanEp = endpoint.split(":")[0];
    const voiceWssUrl = `wss://${cleanEp}/?v=7`;
    this.log(`جاري الاتصال بـ Voice Gateway: ${voiceWssUrl}...`);

    try {
      this.voiceWs = new WebSocket(voiceWssUrl);

      this.voiceWs.on("open", () => {
        this.log("قناة الصوت متصلة بمخدم الصوت الرسمي.");
      });

      this.voiceWs.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          const { op, d } = msg;

          // Hello (op: 8)
          if (op === 8) {
            const interval = d.heartbeat_interval || 20000;
            if (this.voiceHbTimer) clearInterval(this.voiceHbTimer);
            this.voiceHbTimer = setInterval(() => {
              if (this.voiceWs && this.voiceWs.readyState === WebSocket.OPEN) {
                this.voiceWs.send(JSON.stringify({ op: 3, d: Date.now() }));
              }
            }, interval);

            const activeSid = this.voiceSessionId || this.sessionId;
            const voiceIdentify = {
              op: 0,
              d: {
                server_id: String(this.guildId),
                user_id: String(this.userId),
                session_id: String(activeSid),
                token: String(token),
                video: this.isStreamer,
                streams: this.isStreamer ? [{ type: "screen", rid: "100", quality: 100 }] : [],
              },
            };
            this.voiceWs.send(JSON.stringify(voiceIdentify));
            this.log("تم إرسال بيانات المصادقة لقناة الصوت (Voice Identify)...");
          }

          // Ready (op: 2) -> CRITICAL: Select Protocol + Speaking
          if (op === 2) {
            const ip = d.ip;
            const port = d.port;
            const modes = d.modes || ["xsalsa20_poly1305"];
            const chosenMode = modes.includes("xsalsa20_poly1305_lite")
              ? "xsalsa20_poly1305_lite"
              : modes[0];

            // Op 1: Select Protocol
            const selectPayload = {
              op: 1,
              d: {
                protocol: "udp",
                data: {
                  address: ip,
                  port: port,
                  mode: chosenMode,
                },
              },
            };
            this.voiceWs.send(JSON.stringify(selectPayload));

            // Op 5: Speaking
            const ssrc = d.ssrc || 1;
            this.voiceWs.send(
              JSON.stringify({
                op: 5,
                d: { speaking: 0, delay: 0, ssrc: ssrc },
              })
            );

            this.log("تمت مصادقة اتصال الصوت وتفعيل البروتوكول بنجاح (Voice Protocol Selected) ✓");
          }
        } catch (err) {
          this.log(`خطأ في Voice Gateway: ${err.message}`);
        }
      });

      this.voiceWs.on("error", (err) => {
        this.log(`خطأ في Voice Gateway: ${err.message}`);
      });

      this.voiceWs.on("close", (code) => {
        this.log(`انقطع اتصال Voice Gateway (كود: ${code})`);
        if (this.voiceHbTimer) clearInterval(this.voiceHbTimer);

        // 4006: Session no longer valid -> re-request voice state
        if (code === 4006 && this.running && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.log("جلسة الصوت بحاجة للتحديث (4006)، جاري طلب جلسة صوتية جديدة...");
          this.ws.send(
            JSON.stringify({
              op: 4,
              d: {
                guild_id: this.guildId,
                channel_id: this.channelId,
                self_mute: !this.isStreamer,
                self_deaf: !this.isStreamer,
                self_video: false,
              },
            })
          );
        }
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

  connectToStreamGateway(endpoint, token, streamKey) {
    if (!endpoint || !token || !streamKey) return;

    if (this.streamWs) {
      try {
        this.streamWs.close();
      } catch { }
      this.streamWs = null;
    }
    if (this.streamHbTimer) {
      clearInterval(this.streamHbTimer);
      this.streamHbTimer = null;
    }

    const cleanEp = endpoint.split(":")[0];
    const streamWssUrl = `wss://${cleanEp}/?v=7`;
    this.log(`جاري الاتصال بـ Stream Media Gateway: ${streamWssUrl}...`);

    try {
      this.streamWs = new WebSocket(streamWssUrl);

      this.streamWs.on("open", () => {
        this.log("قناة البث متصلة بمخدم الميديا.");
      });

      this.streamWs.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          const { op, d } = msg;

          // Hello (op: 8)
          if (op === 8) {
            const interval = d.heartbeat_interval || 20000;
            if (this.streamHbTimer) clearInterval(this.streamHbTimer);
            this.streamHbTimer = setInterval(() => {
              if (this.streamWs && this.streamWs.readyState === WebSocket.OPEN) {
                this.streamWs.send(JSON.stringify({ op: 3, d: Date.now() }));
              }
            }, interval);

            const activeSid = this.voiceSessionId || this.sessionId;
            const streamIdentify = {
              op: 0,
              d: {
                server_id: String(streamKey),
                user_id: String(this.userId),
                session_id: String(activeSid),
                token: String(token),
                video: true,
                streams: [{ type: "screen", rid: "100", quality: 100 }],
              },
            };
            this.streamWs.send(JSON.stringify(streamIdentify));
            this.log("تم إرسال بيانات مصادقة البث (Stream Identify)...");
          }

          // Ready (op: 2) -> CRITICAL: Select Protocol + Speaking (priority 2 = video/soundshare)
          if (op === 2) {
            const ip = d.ip;
            const port = d.port;
            const modes = d.modes || ["xsalsa20_poly1305"];
            const chosenMode = modes.includes("xsalsa20_poly1305_lite")
              ? "xsalsa20_poly1305_lite"
              : modes[0];

            // Op 1: Select Protocol
            const selectPayload = {
              op: 1,
              d: {
                protocol: "udp",
                data: {
                  address: ip,
                  port: port,
                  mode: chosenMode,
                },
              },
            };
            this.streamWs.send(JSON.stringify(selectPayload));

            // Op 5: Speaking with priority 2 (Voice + Screen)
            const ssrc = d.ssrc || 1;
            this.streamWs.send(
              JSON.stringify({
                op: 5,
                d: { speaking: 2, delay: 0, ssrc: ssrc },
              })
            );

            this.log(
              this.isStreamer
                ? "🟢 البث مباشر ونشط الآن في الروم الصوتي! تم تفعيل بروتوكول البث بنجاح."
                : "👁️ المشاهد متصل الآن ويشاهد البث بنجاح! ديسكورد يقوم باحتساب الساعات حالياً."
            );
          }
        } catch (err) {
          this.log(`خطأ في Stream Gateway: ${err.message}`);
        }
      });

      this.streamWs.on("error", (err) => {
        this.log(`خطأ في Stream Gateway: ${err.message}`);
      });

      this.streamWs.on("close", (code) => {
        this.log(`انقطع اتصال Stream Gateway (كود: ${code})`);
        if (this.streamHbTimer) clearInterval(this.streamHbTimer);

        // 4006: Session no longer valid -> refresh stream via Op 18
        if (code === 4006 && this.running && this.isStreamer && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.log("جلسة البث بحاجة للتحديث (4006)، جاري طلب تجديد البث تلقائياً...");
          this.ws.send(
            JSON.stringify({
              op: 18,
              d: {
                type: "guild",
                guild_id: this.guildId,
                channel_id: this.channelId,
                preferred_region: null,
              },
            })
          );
        }
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.cleanup();
  }

  cleanupVoiceAndStream() {
    if (this.voiceHbTimer) clearInterval(this.voiceHbTimer);
    if (this.streamHbTimer) clearInterval(this.streamHbTimer);

    try {
      if (this.voiceWs) this.voiceWs.close();
    } catch { }
    try {
      if (this.streamWs) this.streamWs.close();
    } catch { }

    this.voiceWs = null;
    this.streamWs = null;
  }

  cleanup() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.cleanupVoiceAndStream();

    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        if (this.isStreamer && this.streamKey) {
          try {
            this.ws.send(JSON.stringify({ op: 19, d: { stream_key: this.streamKey } }));
          } catch { }
        }
        this.ws.send(
          JSON.stringify({
            op: 4,
            d: { guild_id: this.guildId, channel_id: null, self_mute: true, self_deaf: true, self_video: false },
          })
        );
        this.ws.close();
      }
    } catch { }

    this.ws = null;
  }
}

module.exports = { HeadlessDiscordClient };

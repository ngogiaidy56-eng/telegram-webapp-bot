const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 1. KẾT NỐI WEBSOCKET CHO REAL-TIME UPDATE SỐ DƯ
    if (url.pathname === "/ws") {
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();

      server.addEventListener("message", async (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "register" && data.user_id) {
            // Lưu trữ phiên kết nối của user (Trong thực tế Cloudflare Worker, có thể dùng Durable Objects để scale tốt hơn)
            server.userId = data.user_id;
            let user = await env.DB.prepare("SELECT balance FROM users WHERE user_id = ?").bind(data.user_id).first();
            server.send(JSON.stringify({ type: "balance_update", balance: user ? user.balance : 0.0 }));
          }
        } catch (e) {
          console.error(e);
        }
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. API LẤY LỊCH SỬ GIAO DỊCH
    if (url.pathname === "/api/user-history") {
      const userId = url.searchParams.get("user_id");
      if (!userId) return new Response(JSON.stringify({ error: "Missing user_id" }), { status: 400, headers: corsHeaders });

      let user = await env.DB.prepare("SELECT balance FROM users WHERE user_id = ?").bind(userId).first();
      let balance = user ? user.balance : 0.0;

      let { results: history } = await env.DB.prepare(
        "SELECT amount, reference_code as code, created_at as time FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 10"
      ).bind(userId).all();

      return new Response(JSON.stringify({ balance, history }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 3. WEBHOOK NGÂN HÀNG TỰ ĐỘNG CỘNG TIỀN & BẮN WEBSOCKET
    if (url.pathname === "/webhook/bank" && request.method === "POST") {
      try {
        const data = await request.json();
        const content = (data.content || "").toUpperCase();
        const amount = data.amountIn || 0;
        const refCode = data.referenceCode || "N/A";

        if (content.includes("NAP")) {
          const parts = content.split(" ");
          for (let part of parts) {
            if (!isNaN(part) && part.length > 5) {
              const userId = parseInt(part);

              await env.DB.prepare(
                "INSERT INTO users (user_id, balance) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + ?"
              ).bind(userId, amount, amount).run();

              await env.DB.prepare(
                "INSERT INTO transactions (user_id, amount, reference_code, created_at) VALUES (?, ?, ?, datetime('now', '+7 hours'))"
              ).bind(userId, amount, refCode).run();

              let user = await env.DB.prepare("SELECT balance FROM users WHERE user_id = ?").bind(userId).first();

              // Gửi thông báo qua Telegram Bot (Sử dụng env.BOT_TOKEN bảo mật)
              await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  chat_id: userId,
                  text: `🎉 *NẠP TIỀN THÀNH CÔNG!*\n\n• Số tiền nhận: \`+${amount.toLocaleString()} VNĐ\`\n• Mã giao dịch: \`${refCode}\`\n• Số dư mới: \`${user.balance.toLocaleString()} VNĐ\``,
                  parse_mode: "Markdown"
                })
              });
              break;
            }
          }
        }
        return new Response(JSON.stringify({ status: "success" }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
      } catch (err) {
        return new Response(JSON.stringify({ status: "error", message: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // 4. WEBHOOK TELEGRAM BOT
    if (url.pathname === "/" && request.method === "POST") {
      const update = await request.json();
      ctx.waitUntil(handleTelegramUpdate(update, env));
      return new Response("OK");
    }

    return new Response("Cloudflare Worker WebSocket Bot is running!", { status: 200 });
  }
};

async function handleTelegramUpdate(update, env) {
  if (update.message && update.message.text === "/start") {
    const chatId = update.message.chat.id;
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "👋 Chào mừng bạn đến với hệ thống!\nBấm vào nút bên dưới để mở menu đầy đủ màu sắc:",
        reply_markup: {
          inline_keyboard: [[
            { text: "🎨 MỞ BẢNG ĐIỀU KHIỂN DỊCH VỤ", web_app: { url: env.WEBAPP_URL } }
          ]]
        }
      })
    });
  } else if (update.message && update.message.web_app_data) {
    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    try {
      const data = JSON.parse(update.message.web_app_data.data);
      if (data.action === "select_deposit") {
        const amount = data.amount || 50000;
        const content = `NAP ${userId}`;
        const qrUrl = `https://img.vietqr.io/image/VCB-1234567899-compact2.png?amount=${amount}&addInfo=${content}&accountName=NGUYEN+VAN+A`;

        await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            photo: qrUrl,
            caption: `🏦 *QUÉT MÃ QR ĐỂ NẠP TIỀN TỰ ĐỘNG*\n\n• Số tiền: \`${amount.toLocaleString()} VNĐ\`\n• Nội dung: \`${content}\`\n\n⚠️ Hệ thống sẽ tự động cộng tiền khi nhận được chuyển khoản.`,
            parse_mode: "Markdown"
          })
        });
      }
    } catch (e) {
      console.error(e);
    }
  }
}

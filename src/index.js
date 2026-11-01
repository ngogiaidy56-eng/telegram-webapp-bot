const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

function createResponse(body, status = 200, contentType = "application/json") {
  const headers = {
    "Content-Type": contentType,
    ...corsHeaders,
    ...securityHeaders,
  };
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 1. API TRẢ VỀ SỐ DƯ VÀ LỊCH SỬ CHO TRUNG TÂM KHÁCH HÀNG
    if (url.pathname === "/api/user-history") {
      const userId = url.searchParams.get("user_id");
      if (!userId) return createResponse({ error: "Missing user_id" }, 400);

      try {
        let user = await env.DB.prepare("SELECT balance FROM users WHERE user_id = ?").bind(userId).first();
        let balance = user ? user.balance : 0.0;

        let { results: history } = await env.DB.prepare(
          "SELECT amount, reference_code as code, created_at as time FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 10"
        ).bind(userId).all();

        return createResponse({ balance, history });
      } catch (err) {
        return createResponse({ error: err.message }, 500);
      }
    }

    // 2. WEBHOOK NGÂN HÀNG TỰ ĐỘNG CỘNG TIỀN
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
        return createResponse({ status: "success" });
      } catch (err) {
        return createResponse({ status: "error", message: err.message }, 500);
      }
    }

    // 3. WEBHOOK TELEGRAM BOT
    if (url.pathname === "/" && request.method === "POST") {
      const update = await request.json();
      ctx.waitUntil(handleTelegramUpdate(update, env));
      return new Response("OK", { headers: securityHeaders });
    }

    return createResponse("Telegram Bot Worker is running successfully!", 200, "text/plain");
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

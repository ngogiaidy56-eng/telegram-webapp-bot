import json
import logging
import os
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo, Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes, MessageHandler, filters

logging.basicConfig(format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO)

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# Lấy Token từ biến môi trường hoặc điền trực tiếp
BOT_TOKEN = os.getenv("BOT_TOKEN", "YOUR_BOT_TOKEN_HERE")
# URL khi deploy lên Cloud (Ví dụ: https://ten-ung-dung.onrender.com/static/index.html)
WEBAPP_URL = os.getenv("WEBAPP_URL", "https://domain-cua-ban.com/static/index.html")

telegram_app = ApplicationBuilder().token(BOT_TOKEN).build()

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    keyboard = [
        [
            InlineKeyboardButton(
                "🎨 MỞ BẢNG ĐIỀU KHIỂN DỊCH VỤ",
                web_app=WebAppInfo(url=WEBAPP_URL)
            )
        ]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text(
        "👋 Chào mừng bạn đến với hệ thống!\nBấm vào nút bên dưới để mở menu đầy đủ màu sắc:",
        reply_markup=reply_markup
    )

async def handle_web_app_data(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message and update.message.web_app_data:
        try:
            data = json.loads(update.message.web_app_data.data)
            action = data.get("action")
            name = data.get("name")
            await update.message.reply_text(f"✅ Bạn vừa chọn: *{name}* (Mã lệnh: `{action}`)", parse_mode="Markdown")
        except Exception as e:
            await update.message.reply_text("⚠️ Đã xảy ra lỗi khi xử lý dữ liệu từ Web App.")

telegram_app.add_handler(CommandHandler("start", start))
telegram_app.add_handler(MessageHandler(filters.StatusUpdate.WEB_APP_DATA, handle_web_app_data))

@app.on_event("startup")
async def startup_event():
    await telegram_app.initialize()
    await telegram_app.start()
    await telegram_app.updater.start_polling()

@app.on_event("shutdown")
async def shutdown_event():
    await telegram_app.updater.stop()
    await telegram_app.stop()
    await telegram_app.shutdown()

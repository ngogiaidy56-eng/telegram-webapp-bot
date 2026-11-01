import json
import logging
import os
import sqlite3
from datetime import datetime
from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo, Update
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    CallbackQueryHandler,
    filters,
)

logging.basicConfig(format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO)

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# Token bot và cấu hình URL
BOT_TOKEN = "8884608128:AAHonVl55GIxT9i6Y0_W7tqrWMcGVVrv088"
WEBAPP_URL = os.getenv("WEBAPP_URL", "https://1b8fc54e.telegram-webapp-bot-7ym.pages.dev/static/index.html")

# --- CƠ SỞ DỮ LIỆU SQLITE ---
def init_db():
    conn = sqlite3.connect("bot_database.db")
    cursor = conn.cursor()
    # Bảng lưu số dư người dùng
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            balance REAL DEFAULT 0.0
        )
    """)
    # Bảng lưu lịch sử giao dịch nạp tiền
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            amount REAL,
            reference_code TEXT,
            created_at TEXT
        )
    """)
    conn.commit()
    conn.close()

init_db()

def get_or_create_user(user_id: int):
    conn = sqlite3.connect("bot_database.db")
    cursor = conn.cursor()
    cursor.execute("SELECT balance FROM users WHERE user_id = ?", (user_id,))
    row = cursor.fetchone()
    if not row:
        cursor.execute("INSERT INTO users (user_id, balance) VALUES (?, ?)", (user_id, 0.0))
        conn.commit()
        balance = 0.0
    else:
        balance = row[0]
    conn.close()
    return balance

def update_user_balance(user_id: int, amount: float):
    conn = sqlite3.connect("bot_database.db")
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET balance = balance + ? WHERE user_id = ?", (amount, user_id))
    conn.commit()
    conn.close()

def log_transaction(user_id: int, amount: float, ref_code: str):
    conn = sqlite3.connect("bot_database.db")
    cursor = conn.cursor()
    time_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute(
        "INSERT INTO transactions (user_id, amount, reference_code, created_at) VALUES (?, ?, ?, ?)",
        (user_id, amount, ref_code, time_str)
    )
    conn.commit()
    conn.close()

# --- HÀM TẠO VIETQR ĐỘNG ---
def generate_vietqr_url(amount: float, content: str) -> str:
    BANK_ID = "VCB"              # Mã ngân hàng của bạn
    ACCOUNT_NO = "1234567899"    # Số tài khoản nhận tiền
    ACCOUNT_NAME = "NGUYEN VAN A"  # Tên chủ tài khoản
    return (
        f"https://img.vietqr.io/image/{BANK_ID}-{ACCOUNT_NO}-compact2.png"
        f"?amount={int(amount)}&addInfo={content}&accountName={ACCOUNT_NAME}"
    )

# --- API BACKEND CHO MINI APP ---
@app.get("/api/user-history")
async def get_user_history(user_id: int):
    balance = get_or_create_user(user_id)
    conn = sqlite3.connect("bot_database.db")
    cursor = conn.cursor()
    cursor.execute(
        "SELECT amount, reference_code, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 10",
        (user_id,)
    )
    txs = cursor.fetchall()
    conn.close()
    history_list = [{"amount": tx[0], "code": tx[1], "time": tx[2]} for tx in txs]
    return {"balance": balance, "history": history_list}

# --- WEBHOOK NHẬN TIỀN TỰ ĐỘNG TỪ NGÂN HÀNG ---
class BankTransaction(BaseModel):
    gateway: str
    transactionDate: str
    amountIn: float
    content: str
    referenceCode: str

@app.post("/webhook/bank")
async def bank_webhook(transaction: BankTransaction):
    try:
        content = transaction.content.upper()
        amount = transaction.amountIn
        if "NAP" in content:
            parts = content.split(" ")
            for part in parts:
                if part.isdigit():
                    telegram_user_id = int(part)
                    # Ghi log và cộng tiền vào SQLite
                    log_transaction(telegram_user_id, amount, transaction.referenceCode)
                    update_user_balance(telegram_user_id, amount)
                    new_balance = get_or_create_user(telegram_user_id)
                    
                    # Bắn thông báo trực tiếp về Telegram cho user
                    success_text = (
                        f"🎉 **NẠP TIỀN THÀNH CÔNG!**\n\n"
                        f"• Số tiền nhận: `+{amount:,.0f} VNĐ`\n"
                        f"• Mã giao dịch: `{transaction.referenceCode}`\n"
                        f"• Số dư mới: `{new_balance:,.0f} VNĐ`"
                    )
                    await telegram_app.bot.send_message(
                        chat_id=telegram_user_id,
                        text=success_text,
                        parse_mode="Markdown"
                    )
                    break
        return {"status": "success"}
    except Exception as e:
        logging.error(f"Lỗi Webhook: {e}")
        return {"status": "error", "message": str(e)}

# --- KHỞI TẠO TELEGRAM BOT ---
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
            user_id = update.message.from_user.id
            
            # Xử lý khi user chọn mốc nạp tiền từ Mini App
            if action == "select_deposit":
                amount = data.get("amount", 50000)
                content = f"NAP {user_id}"
                qr_url = generate_vietqr_url(amount, content)
                
                keyboard = [
                    [InlineKeyboardButton("🔄 Kiểm tra giao dịch", callback_data="check_status")],
                    [InlineKeyboardButton("❌ Hủy giao dịch", callback_data="cancel_transaction")]
                ]
                reply_markup = InlineKeyboardMarkup(keyboard)
                
                caption = (
                    f"🏦 **QUÉT MÃ QR ĐỂ NẠP TIỀN TỰ ĐỘNG**\n\n"
                    f"• Số tiền: `{amount:,.0f} VNĐ`\n"
                    f"• Nội dung: `{content}`\n\n"
                    f"⚠️ Hệ thống sẽ tự động cộng tiền khi nhận được chuyển khoản."
                )
                await update.message.reply_photo(photo=qr_url, caption=caption, parse_mode="Markdown", reply_markup=reply_markup)
            else:
                name = data.get("name", "Chức năng")
                await update.message.reply_text(f"✅ Bạn vừa chọn: *{name}* (Mã: `{action}`)", parse_mode="Markdown")
        except Exception as e:
            logging.error(f"Lỗi xử lý dữ liệu từ Web App: {e}")
            await update.message.reply_text("⚠️ Đã xảy ra lỗi khi xử lý dữ liệu.")

async def button_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    data = query.data
    user_id = query.from_user.id

    if data == "check_status":
        balance = get_or_create_user(user_id)
        await query.answer(f"Số dư hiện tại của bạn là: {balance:,.0f} VNĐ", show_alert=True)
    elif data == "cancel_transaction":
        await query.message.delete()

# Đăng ký handlers
telegram_app.add_handler(CommandHandler("start", start))
telegram_app.add_handler(MessageHandler(filters.StatusUpdate.WEB_APP_DATA, handle_web_app_data))
telegram_app.add_handler(CallbackQueryHandler(button_callback_handler))

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

// Bot Telegram Pembuat Grup WhatsApp
// Menggunakan @whiskeysockets/baileys untuk WhatsApp dan node-telegram-bot-api untuk Telegram

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const logger = pino({ level: 'silent' });
const crypto = require('crypto');
//
global.crypto = crypto;

// Ganti dengan token bot Telegram kamu
const token = '7641668767:AAEDQW8wDXBIcY7SeOcSjSrSsQSb8yrI3xc';
const bot = new TelegramBot(token, { polling: true });

// Folder untuk menyimpan sesi WhatsApp
const sessionDir = path.join(__dirname, 'wa-sessions');
if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir);
}

// Simpan sesi aktif pengguna
const activeUsers = new Map();

// Fungsi untuk membuat koneksi WhatsApp
async function connectToWhatsApp(userId) {
  const userSessionDir = path.join(sessionDir, userId.toString());
  
  if (!fs.existsSync(userSessionDir)) {
    fs.mkdirSync(userSessionDir, { recursive: true });
  }
  
  const { state, saveCreds } = await useMultiFileAuthState(userSessionDir);
  
  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    logger: logger
  });
  
  // Simpan koneksi untuk penggunaan nanti
  activeUsers.set(userId, {
    sock,
    saveCreds,
    qrMessageId: null
  });
  
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      // Generate QR code sebagai gambar
      const qrPath = path.join(userSessionDir, 'qr.png');
      await qrcode.toFile(qrPath, qr);
      
      // Kirim QR code ke pengguna Telegram
      const userData = activeUsers.get(userId);
      const inlineKeyboard = {
        inline_keyboard: [
          [{ text: '❌ Batalkan', callback_data: `cancel_qr_${userId}` }]
        ]
      };
      
      try {
        // Hapus QR code lama jika ada
        if (userData.qrMessageId) {
          await bot.deleteMessage(userId, userData.qrMessageId);
        }
        
        const sent = await bot.sendPhoto(userId, qrPath, {
          caption: '🔄 *Scan QR Code ini dengan WhatsApp kamu!*\n\nQR akan update otomatis tiap 20 detik. Kalo udah selesai nanti notif lagi ya.',
          parse_mode: 'Markdown',
          reply_markup: JSON.stringify(inlineKeyboard)
        });
        
        userData.qrMessageId = sent.message_id;
        activeUsers.set(userId, userData);
      } catch (error) {
        console.log('Error kirim QR:', error);
      }
    }
    
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) && 
        lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
      
      if (shouldReconnect) {
        // Koneksi terputus, tapi bukan karena logout
        bot.sendMessage(userId, '⚠️ Koneksi WhatsApp terputus! Coba lagi dengan /connect');
      } else {
        // User logout
        bot.sendMessage(userId, '✅ Kamu berhasil logout dari WhatsApp');
        
        // Hapus file sesi
        if (fs.existsSync(userSessionDir)) {
          fs.rmSync(userSessionDir, { recursive: true, force: true });
        }
        
        // Hapus dari daftar pengguna aktif
        activeUsers.delete(userId);
      }
    }
    
    if (connection === 'open') {
      const userData = activeUsers.get(userId);
      
      // Berhasil terhubung
      if (userData.qrMessageId) {
        try {
          // Hapus pesan QR
          await bot.deleteMessage(userId, userData.qrMessageId);
        } catch (error) {
          console.log('Error hapus QR:', error);
        }
      }
      
      const phoneNumber = sock.user.id.split(':')[0];
      
      // Kirim pesan sukses
      bot.sendMessage(
        userId,
        `🎉 *Koneksi Berhasil!*\n\n` +
        `📱 Nomor: +${phoneNumber}\n` +
        `👤 Nama: ${sock.user.name}\n\n` +
        `Sekarang kamu bisa buat grup dengan perintah:\n` +
        `/buat [nama grup] [jumlah]`,
        { parse_mode: 'Markdown' }
      );
    }
  });
  
  sock.ev.on('creds.update', saveCreds);
  
  return sock;
}

// Fungsi untuk membuat grup WhatsApp
async function createWhatsAppGroups(userId, groupName, count) {
  const userData = activeUsers.get(userId);
  if (!userData || !userData.sock) {
    return {
      success: false,
      message: '❌ Kamu belum terhubung ke WhatsApp! Gunakan /connect dulu ya.'
    };
  }
  
  const { sock } = userData;
  const createdGroups = [];
  
  try {
    // Kirim pesan proses
    const processingMsg = await bot.sendMessage(
      userId,
      `⚙️ *Memproses Permintaan...*\n\nSabar ya, lagi bikin grup nih...`,
      { parse_mode: 'Markdown' }
    );
    
    for (let i = 1; i <= count; i++) {
      const fullGroupName = `${groupName} ${i}`;
      
      // Update pesan proses
      await bot.editMessageText(
        `⚙️ *Memproses Permintaan...*\n\n` +
        `📊 Progress: ${i}/${count}\n` +
        `🔄 Lagi bikin: *${fullGroupName}*\n\n` +
        `_Jangan khawatir, ini butuh waktu dikit..._`,
        {
          chat_id: userId,
          message_id: processingMsg.message_id,
          parse_mode: 'Markdown'
        }
      );
      
      // Buat grup baru
      const group = await sock.groupCreate(fullGroupName, []);
      
      // Generate link invite
      const inviteCode = await sock.groupInviteCode(group.id);
      const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
      
      createdGroups.push({
        name: fullGroupName,
        link: inviteLink
      });
      
      // Tunggu sebentar agar tidak terlalu cepat
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    
    // Update pesan terakhir ke hasil akhir
    let resultMessage = `✅ *${count} Grup WhatsApp Berhasil Dibuat!*\n\n`;
    
    createdGroups.forEach((group, index) => {
      resultMessage += `*${index + 1}. ${group.name}*\n${group.link}\n\n`;
    });
    
    resultMessage += `_Untuk membuat grup lagi, gunakan /buat [nama] [jumlah]_`;
    
    await bot.editMessageText(resultMessage, {
      chat_id: userId,
      message_id: processingMsg.message_id,
      parse_mode: 'Markdown'
    });
    
    return {
      success: true,
      groups: createdGroups
    };
  } catch (error) {
    console.error('Error membuat grup:', error);
    bot.sendMessage(
      userId,
      `❌ *Gagal membuat grup!*\n\nError: ${error.message}\n\nCoba connect ulang dengan /connect`,
      { parse_mode: 'Markdown' }
    );
    
    return {
      success: false,
      message: error.message
    };
  }
}

// Menangani perintah /start
bot.onText(/\/start/, (msg) => {
  const userId = msg.from.id;
  
  bot.sendMessage(
    userId,
    `Halo *${msg.from.first_name}* 👋\n\n` +
    `Gue adalah bot pembuat grup WhatsApp otomatis! Bisa bikin banyak grup sekaligus, mantep kan?\n\n` +
    `*Perintah yang tersedia:*\n` +
    `🔹 /connect - Hubungkan WhatsApp kamu\n` +
    `🔹 /buat [nama grup] [jumlah] - Buat grup WhatsApp\n` +
    `🔹 /logout - Putuskan koneksi WhatsApp\n` +
    `🔹 /status - Cek status koneksi\n\n` +
    `_Made with ❤️ by @ZOWIV0_`,
    { parse_mode: 'Markdown' }
  );
});

// Menangani perintah /connect
bot.onText(/\/connect/, async (msg) => {
  const userId = msg.from.id;
  
  // Cek apakah sudah terhubung
  if (activeUsers.has(userId) && activeUsers.get(userId).sock) {
    const userData = activeUsers.get(userId);
    const sock = userData.sock;
    
    if (sock.user) {
      // Sudah terhubung
      bot.sendMessage(
        userId,
        `⚠️ *Kamu sudah terhubung ke WhatsApp!*\n\n` +
        `📱 Nomor: +${sock.user.id.split(':')[0]}\n` +
        `👤 Nama: ${sock.user.name}\n\n` +
        `Untuk disconnect, gunakan /logout terlebih dahulu.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
  }
  
  bot.sendMessage(
    userId,
    `🔄 *Menghubungkan ke WhatsApp...*\n\n` +
    `Tunggu bentar ya, lagi nyiapin QR code nih...`,
    { parse_mode: 'Markdown' }
  );
  
  try {
    await connectToWhatsApp(userId);
  } catch (error) {
    console.error('Error connect:', error);
    bot.sendMessage(
      userId,
      `❌ *Gagal terhubung ke WhatsApp!*\n\nError: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Menangani perintah /logout
bot.onText(/\/logout/, async (msg) => {
  const userId = msg.from.id;
  
  if (!activeUsers.has(userId)) {
    bot.sendMessage(
      userId,
      `⚠️ Kamu belum terhubung ke WhatsApp! Gunakan /connect dulu ya.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  try {
    const userData = activeUsers.get(userId);
    const { sock } = userData;
    
    await sock.logout();
    
    // Hapus file sesi
    const userSessionDir = path.join(sessionDir, userId.toString());
    if (fs.existsSync(userSessionDir)) {
      fs.rmSync(userSessionDir, { recursive: true, force: true });
    }
    
    // Hapus dari daftar pengguna aktif
    activeUsers.delete(userId);
    
    bot.sendMessage(
      userId,
      `✅ *Berhasil logout dari WhatsApp!*\n\n` +
      `Kamu bisa connect lagi kapan aja dengan /connect`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Error logout:', error);
    bot.sendMessage(
      userId,
      `❌ *Gagal logout!*\n\nError: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Menangani perintah /status
bot.onText(/\/status/, (msg) => {
  const userId = msg.from.id;
  
  if (!activeUsers.has(userId) || !activeUsers.get(userId).sock || !activeUsers.get(userId).sock.user) {
    bot.sendMessage(
      userId,
      `⚠️ *Status Koneksi: Tidak Terhubung*\n\n` +
      `Kamu belum terhubung ke WhatsApp.\n` +
      `Gunakan /connect untuk menghubungkan.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  const userData = activeUsers.get(userId);
  const sock = userData.sock;
  
  bot.sendMessage(
    userId,
    `✅ *Status Koneksi: Terhubung*\n\n` +
    `📱 Nomor: +${sock.user.id.split(':')[0]}\n` +
    `👤 Nama: ${sock.user.name}\n` +
    `🔢 Jumlah Chat: ${Object.keys(sock.chats).length}\n\n` +
    `Kamu bisa membuat grup dengan /buat [nama] [jumlah]`,
    { parse_mode: 'Markdown' }
  );
});

// Menangani perintah /buat
bot.onText(/\/buat (.+)/, async (msg, match) => {
  const userId = msg.from.id;
  const params = match[1].trim().split(' ');
  
  if (params.length < 2) {
    bot.sendMessage(
      userId,
      `⚠️ *Format Salah!*\n\n` +
      `Format yang bener: /buat [nama grup] [jumlah]\n` +
      `Contoh: /buat Geng Gamers 5`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Ambil jumlah grup (parameter terakhir)
  const count = parseInt(params.pop());
  
  if (isNaN(count) || count <= 0 || count > 50) {
    bot.sendMessage(
      userId,
      `⚠️ *Jumlah Grup Tidak Valid!*\n\n` +
      `Jumlah grup harus angka antara 1-50.\n` +
      `Contoh: /buat Geng Gamers 5`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Gabungkan sisa parameter sebagai nama grup
  const groupName = params.join(' ');
  
  if (!groupName || groupName.length < 3) {
    bot.sendMessage(
      userId,
      `⚠️ *Nama Grup Terlalu Pendek!*\n\n` +
      `Nama grup minimal 3 karakter.\n` +
      `Contoh: /buat Geng Gamers 5`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Cek apakah sudah terhubung
  if (!activeUsers.has(userId) || !activeUsers.get(userId).sock || !activeUsers.get(userId).sock.user) {
    bot.sendMessage(
      userId,
      `❌ *Kamu belum terhubung ke WhatsApp!*\n\n` +
      `Gunakan /connect dulu ya buat scan QR code.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  try {
    await createWhatsAppGroups(userId, groupName, count);
  } catch (error) {
    console.error('Error buat grup:', error);
    bot.sendMessage(
      userId,
      `❌ *Gagal membuat grup!*\n\nError: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Menangani callback tombol cancel QR
bot.on('callback_query', async (callbackQuery) => {
  const action = callbackQuery.data;
  const userId = callbackQuery.from.id;
  
  if (action.startsWith('cancel_qr_')) {
    const userData = activeUsers.get(userId);
    
    if (userData && userData.qrMessageId) {
      try {
        // Hapus pesan QR
        await bot.deleteMessage(userId, userData.qrMessageId);
        
        // Hapus dari daftar pengguna aktif
        activeUsers.delete(userId);
        
        // Hapus file sesi
        const userSessionDir = path.join(sessionDir, userId.toString());
        if (fs.existsSync(userSessionDir)) {
          fs.rmSync(userSessionDir, { recursive: true, force: true });
        }
        
        // Kirim pesan dibatalkan
        bot.sendMessage(
          userId,
          `✅ *Permintaan connect dibatalkan!*\n\n` +
          `Kamu bisa connect lagi kapan aja dengan /connect`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.log('Error cancel QR:', error);
      }
    }
    
    // Akhiri callback query
    bot.answerCallbackQuery(callbackQuery.id);
  }
});

// Mulai bot
console.log('Bot Telegram pembuat grup WhatsApp telah aktif! 🚀');

// Tambahkan file package.json
/**
 * Untuk package.json:
 * 
 * {
 *   "name": "telegram-wa-group-creator",
 *   "version": "1.0.0",
 *   "description": "Bot Telegram untuk membuat grup WhatsApp",
 *   "main": "index.js",
 *   "scripts": {
 *     "start": "node index.js"
 *   },
 *   "dependencies": {
 *     "@hapi/boom": "^10.0.1",
 *     "@whiskeysockets/baileys": "^6.5.0",
 *     "node-telegram-bot-api": "^0.64.0",
 *     "pino": "^8.16.0",
 *     "qrcode": "^1.5.3"
 *   }
 * }
 */

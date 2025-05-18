//
//
//
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
const axios = require('axios'); // Tambahkan axios untuk download foto
//
global.crypto = crypto;

// Ganti dengan token bot Telegram kamu
const token = '7641668767:AAEDQW8wDXBIcY7SeOcSjSrSsQSb8yrI3xc';
const bot = new TelegramBot(token, { polling: true });

// Folder untuk menyimpan sesi WhatsApp dan foto profil
const sessionDir = path.join(__dirname, 'wa-sessions');
const profilePicsDir = path.join(__dirname, 'profile-pics');
if (!fs.existsSync(sessionDir)) {
  fs.mkdirSync(sessionDir);
}
if (!fs.existsSync(profilePicsDir)) {
  fs.mkdirSync(profilePicsDir);
}

// Simpan sesi aktif pengguna
const activeUsers = new Map();

// Fungsi untuk membuat koneksi WhatsApp dengan retry
async function connectToWhatsApp(userId, retryCount = 0) {
  const MAX_RETRIES = 3;
  const userSessionDir = path.join(sessionDir, userId.toString());
  
  if (!fs.existsSync(userSessionDir)) {
    fs.mkdirSync(userSessionDir, { recursive: true });
  }
  
  try {
    const { state, saveCreds } = await useMultiFileAuthState(userSessionDir);
    
    // Hapus sesi sebelumnya jika ada
    const userData = activeUsers.get(userId);
    if (userData && userData.sock) {
      try {
        userData.sock.ev.removeAllListeners();
      } catch (err) {
        console.log('Error removing listeners:', err);
      }
    }
    
    // Buat socket baru
    const sock = makeWASocket({
      printQRInTerminal: true,
      auth: state,
      logger: logger,
      connectTimeoutMs: 60000, // Tambahkan timeout 60 detik
      browser: ['Bot WA Grup Maker', 'Safari', '10.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      keepAliveIntervalMs: 10000, // Keep-alive setiap 10 detik
    });
    
    // Simpan koneksi untuk penggunaan nanti
    activeUsers.set(userId, {
      sock,
      saveCreds,
      qrMessageId: userData?.qrMessageId || null,
      retryCount: 0,
      qrTimeout: null,
      profilePic: userData?.profilePic || null // Simpan path foto profil jika ada
    });
    
    // Handler untuk update koneksi
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const userData = activeUsers.get(userId);
      
      // Reset QR timeout jika ada
      if (userData && userData.qrTimeout) {
        clearTimeout(userData.qrTimeout);
        userData.qrTimeout = null;
        activeUsers.set(userId, userData);
      }
      
      if (qr) {
        // Generate QR code sebagai gambar
        const qrPath = path.join(userSessionDir, 'qr.png');
        await qrcode.toFile(qrPath, qr);
        
        // Kirim QR code ke pengguna Telegram
        const inlineKeyboard = {
          inline_keyboard: [
            [{ text: '❌ Batalkan', callback_data: `cancel_qr_${userId}` }]
          ]
        };
        
        try {
          // Hapus QR code lama jika ada
          if (userData.qrMessageId) {
            try {
              await bot.deleteMessage(userId, userData.qrMessageId);
            } catch (err) {
              console.log('Error saat hapus QR lama:', err);
            }
          }
          
          const sent = await bot.sendPhoto(userId, qrPath, {
            caption: '🔄 *Scan QR Code ini dengan WhatsApp kamu!*\n\nQR akan update otomatis tiap 20 detik. Kalo udah selesai nanti notif lagi ya.',
            parse_mode: 'Markdown',
            reply_markup: JSON.stringify(inlineKeyboard)
          });
          
          userData.qrMessageId = sent.message_id;
          
          // Set timeout untuk QR code - beri waktu 2 menit untuk scan
          userData.qrTimeout = setTimeout(async () => {
            try {
              // Coba hapus pesan QR jika belum terhubung
              await bot.deleteMessage(userId, userData.qrMessageId);
              bot.sendMessage(
                userId, 
                '⌛ *Waktu scan QR habis!*\n\nKamu gak scan QR dalam 2 menit. Coba lagi dengan /connect',
                { parse_mode: 'Markdown' }
              );
              
              // Bersihkan sesi
              try {
                sock.ev.removeAllListeners();
                sock.logout();
              } catch (err) {
                console.log('Error saat cleanup:', err);
              }
              
              // Hapus dari active users
              activeUsers.delete(userId);
            } catch (err) {
              console.log('Error saat timeout QR:', err);
            }
          }, 120000); // 2 menit
          
          activeUsers.set(userId, userData);
        } catch (error) {
          console.log('Error kirim QR:', error);
          bot.sendMessage(
            userId,
            `❌ *Gagal generate QR!*\n\nError: ${error.message}\n\nCoba lagi dengan /connect`,
            { parse_mode: 'Markdown' }
          );
        }
      }
      
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = (lastDisconnect?.error instanceof Boom) && 
          statusCode !== DisconnectReason.loggedOut;
        
        console.log(`Koneksi terputus dengan status: ${statusCode}`);
        
        if (shouldReconnect) {
          // Koneksi terputus, tapi bukan karena logout - coba reconnect
          const curRetry = (userData?.retryCount || 0) + 1;
          console.log(`Mencoba reconnect untuk user ${userId}, percobaan ke-${curRetry}`);
          
          if (curRetry <= MAX_RETRIES) {
            // Update retry count
            activeUsers.set(userId, {
              ...userData,
              retryCount: curRetry
            });
            
            // Kasih tahu user
            bot.sendMessage(
              userId, 
              `⚠️ *Koneksi WhatsApp terputus!*\n\nMencoba menghubungkan kembali... (${curRetry}/${MAX_RETRIES})`,
              { parse_mode: 'Markdown' }
            );
            
            // Tunggu sebentar sebelum reconnect
            setTimeout(() => {
              connectToWhatsApp(userId, curRetry);
            }, 3000);
          } else {
            // Sudah mencoba berkali-kali tapi tetap gagal
            bot.sendMessage(
              userId, 
              `❌ *Gagal menghubungkan ke WhatsApp!*\n\nSudah mencoba ${MAX_RETRIES} kali tapi tetap gagal. Coba lagi nanti dengan /connect`,
              { parse_mode: 'Markdown' }
            );
            
            // Hapus sesi
            if (fs.existsSync(userSessionDir)) {
              fs.rmSync(userSessionDir, { recursive: true, force: true });
            }
            
            // Hapus dari active users
            activeUsers.delete(userId);
          }
        } else if (statusCode === DisconnectReason.loggedOut) {
          // User logout
          bot.sendMessage(userId, '✅ *Kamu berhasil logout dari WhatsApp*');
          
          // Hapus file sesi
          if (fs.existsSync(userSessionDir)) {
            fs.rmSync(userSessionDir, { recursive: true, force: true });
          }
          
          // Hapus dari daftar pengguna aktif
          activeUsers.delete(userId);
        } else {
          // Error lain
          bot.sendMessage(
            userId, 
            `❌ *Koneksi terputus!*\n\nError code: ${statusCode}\n\nCoba lagi dengan /connect`,
            { parse_mode: 'Markdown' }
          );
          
          // Hapus dari active users
          activeUsers.delete(userId);
        }
      }
      
      if (connection === 'open') {
        const userData = activeUsers.get(userId);
        
        // Reset retry count
        userData.retryCount = 0;
        activeUsers.set(userId, userData);
        
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
          `/buat [nama grup] [jumlah]\n\n` +
          `Atau kirim foto dengan caption: /buat [nama grup] [jumlah] untuk menggunakan foto sebagai profil grup`,
          { parse_mode: 'Markdown' }
        );
      }
    });
    
    // Handle update credentials
    sock.ev.on('creds.update', saveCreds);
    
    return sock;
  } catch (error) {
    console.error('Error saat connect:', error);
    
    if (retryCount < MAX_RETRIES) {
      console.log(`Percobaan ulang ${retryCount + 1}/${MAX_RETRIES}...`);
      // Tunggu 3 detik sebelum retry
      await new Promise(resolve => setTimeout(resolve, 3000));
      return connectToWhatsApp(userId, retryCount + 1);
    } else {
      bot.sendMessage(
        userId,
        `❌ *Gagal terhubung ke WhatsApp!*\n\nError: ${error.message}\n\nCoba lagi nanti.`,
        { parse_mode: 'Markdown' }
      );
      
      // Hapus sesi jika error parah
      if (fs.existsSync(userSessionDir)) {
        fs.rmSync(userSessionDir, { recursive: true, force: true });
      }
      
      // Hapus dari active users
      activeUsers.delete(userId);
      throw error;
    }
  }
}

// Fungsi untuk mendownload foto dari Telegram
async function downloadTelegramPhoto(fileId, userId) {
  try {
    // Dapatkan path file
    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    
    // Buat folder khusus untuk user jika belum ada
    const userProfileDir = path.join(profilePicsDir, userId.toString());
    if (!fs.existsSync(userProfileDir)) {
      fs.mkdirSync(userProfileDir, { recursive: true });
    }
    
    // Nama file dengan timestamp untuk menghindari cache
    const timestamp = Date.now();
    const filePath = path.join(userProfileDir, `profile_${timestamp}.jpg`);
    
    // Download file
    const response = await axios({
      method: 'GET',
      url: fileUrl,
      responseType: 'stream'
    });
    
    // Simpan ke file
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filePath));
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Error download foto:', error);
    throw error;
  }
}

// Fungsi untuk set foto profil grup WhatsApp - UPDATED
// Fungsi untuk set foto profil grup WhatsApp - FIXED
async function setGroupProfilePicture(sock, groupId, imagePath) {
  try {
    // Baca file gambar
    const imageBuffer = fs.readFileSync(imagePath);
    
    // Gunakan method yang benar: groupUpdatePicture
    await sock.groupUpdatePicture(groupId, imageBuffer);
    
    // Tambahkan delay setelah update foto
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log(`Berhasil set foto profil untuk grup ${groupId}`);
    return true;
  } catch (error) {
    console.error(`Error set profil grup ${groupId}:`, error);
    return false;
  }
}

// Fungsi untuk membuat grup WhatsApp
async function createWhatsAppGroups(userId, groupName, count, profilePicPath = null) {
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
    // Verifikasi koneksi aktif
    if (!sock.user) {
      throw new Error('Koneksi WhatsApp tidak aktif! Coba connect ulang.');
    }
    
    // Kirim pesan proses
    const processingMsg = await bot.sendMessage(
      userId,
      `⚙️ *Memproses Permintaan...*\n\nSabar ya, lagi bikin grup nih...`,
      { parse_mode: 'Markdown' }
    );
    
    // Set the total retries per group
    const MAX_GROUP_RETRIES = 3;
    
    for (let i = 1; i <= count; i++) {
      const fullGroupName = `${groupName} ${i}`;
      let createdGroup = null;
      let retryCount = 0;
      
      // Retry loop for each group
      while (!createdGroup && retryCount < MAX_GROUP_RETRIES) {
        try {
          // Update pesan proses
          await bot.editMessageText(
            `⚙️ *Memproses Permintaan...*\n\n` +
            `📊 Progress: ${i}/${count}\n` +
            `🔄 Lagi bikin: *${fullGroupName}*\n` +
            (retryCount > 0 ? `🔁 Percobaan ke-${retryCount + 1}...\n` : '') +
            (profilePicPath ? `🖼️ Dengan foto profil\n` : '') +
            `\n_Jangan khawatir, ini butuh waktu dikit..._`,
            {
              chat_id: userId,
              message_id: processingMsg.message_id,
              parse_mode: 'Markdown'
            }
          );
          
          // Buat grup baru
          const group = await sock.groupCreate(fullGroupName, []);
          
          // Set foto profil grup jika ada
          if (profilePicPath) {
            await bot.editMessageText(
              `⚙️ *Memproses Permintaan...*\n\n` +
              `📊 Progress: ${i}/${count}\n` +
              `🔄 Grup *${fullGroupName}* dibuat\n` +
              `🖼️ Mengatur foto profil grup...\n` +
              `\n_Jangan khawatir, ini butuh waktu dikit..._`,
              {
                chat_id: userId,
                message_id: processingMsg.message_id,
                parse_mode: 'Markdown'
              }
            );
            
            // Tunggu lebih lama sebelum set foto profil (3 detik)
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Set foto profil dengan mencoba beberapa kali jika gagal
            let setPicSuccess = false;
            for (let attempt = 1; attempt <= 3 && !setPicSuccess; attempt++) {
              console.log(`Mencoba set profil grup ${fullGroupName} (percobaan ${attempt})`);
              setPicSuccess = await setGroupProfilePicture(sock, group.id, profilePicPath);
              
              if (!setPicSuccess && attempt < 3) {
                // Tunggu sebelum mencoba lagi
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
            
            if (!setPicSuccess) {
              console.log(`Gagal set profil untuk grup ${fullGroupName} setelah beberapa percobaan`);
            }
          }
          
          // Generate link invite
          const inviteCode = await sock.groupInviteCode(group.id);
          const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
          
          createdGroups.push({
            name: fullGroupName,
            link: inviteLink,
            id: group.id
          });
          
          createdGroup = group;
        } catch (error) {
          console.error(`Error saat membuat grup '${fullGroupName}'`, error);
          retryCount++;
          
          if (retryCount >= MAX_GROUP_RETRIES) {
            // Gagal setelah beberapa percobaan
            await bot.editMessageText(
              `⚠️ *Gagal membuat grup "${fullGroupName}" setelah ${MAX_GROUP_RETRIES} percobaan*\n\n` +
              `Melanjutkan ke grup berikutnya...`,
              {
                chat_id: userId,
                message_id: processingMsg.message_id,
                parse_mode: 'Markdown'
              }
            );
            
            // Tunggu sebentar sebelum lanjut
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            // Tunggu sebentar sebelum coba lagi
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
      }
      
      // Tunggu sebentar agar tidak terlalu cepat
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    
    // Update pesan terakhir ke hasil akhir
    let resultMessage = `✅ *${createdGroups.length} dari ${count} Grup WhatsApp Berhasil Dibuat!*\n\n`;
    
    if (createdGroups.length === 0) {
      resultMessage = `❌ *Gagal membuat grup WhatsApp!*\n\n` +
                     `Kemungkinan ada masalah dengan koneksi WhatsApp kamu.\n` +
                     `Coba connect ulang dengan /logout lalu /connect.`;
    } else {
      if (profilePicPath) {
        resultMessage += `🖼️ *Semua grup menggunakan foto profil yang kamu kirim*\n\n`;
      }
      
      createdGroups.forEach((group, index) => {
        resultMessage += `*${index + 1}. ${group.name}*\n${group.link}\n\n`;
      });
      
      resultMessage += `_Untuk membuat grup lagi, gunakan /buat [nama] [jumlah]_\n`;
      resultMessage += `_Atau kirim foto dengan caption untuk menggunakan sebagai foto profil_`;
    }
    
    await bot.editMessageText(resultMessage, {
      chat_id: userId,
      message_id: processingMsg.message_id,
      parse_mode: 'Markdown'
    });
    
    return {
      success: createdGroups.length > 0,
      groups: createdGroups
    };
  } catch (error) {
    console.error('Error membuat grup:', error);
    bot.sendMessage(
      userId,
      `❌ *Gagal membuat grup!*\n\nError: ${error.message}\n\nCoba connect ulang dengan /logout lalu /connect`,
      { parse_mode: 'Markdown' }
    );
    
    return {
      success: false,
      message: error.message
    };
  }
}

// Helper untuk force reconnect jika koneksi tidak stabil
async function forceReconnect(userId) {
  try {
    const userData = activeUsers.get(userId);
    if (userData && userData.sock) {
      // Hapus listener untuk menghindari memory leak
      userData.sock.ev.removeAllListeners();
    }
    
    // Hapus user dari activeUsers
    activeUsers.delete(userId);
    
    // Reconnect
    await connectToWhatsApp(userId);
    
    return true;
  } catch (error) {
    console.error('Error saat force reconnect:', error);
    return false;
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
    `🔹 /status - Cek status koneksi\n` +
    `🔹 /reconnect - Paksa reconnect jika ada masalah\n\n` +
    `*Fitur Baru:* Kirim foto dengan caption /buat [nama grup] [jumlah] untuk menggunakan foto sebagai profil grup\n\n` +
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
      `❌ *Gagal terhubung ke WhatsApp!*\n\nError: ${error.message}\n\nCoba lagi nanti.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Menangani perintah /reconnect (tambahan)
bot.onText(/\/reconnect/, async (msg) => {
  const userId = msg.from.id;
  
  bot.sendMessage(
    userId,
    `🔄 *Mencoba menghubungkan ulang ke WhatsApp...*\n\n` +
    `Proses ini akan menutup sesi lama dan memulai yang baru.`,
    { parse_mode: 'Markdown' }
  );
  
  try {
    // Force logout dulu
    if (activeUsers.has(userId)) {
      const userData = activeUsers.get(userId);
      try {
        await userData.sock.logout();
      } catch (e) {
        // Ignore error, still proceed with reconnect
        console.log('Error saat logout untuk reconnect:', e);
      }
    }
    
    // Hapus sesi
    const userSessionDir = path.join(sessionDir, userId.toString());
    if (fs.existsSync(userSessionDir)) {
      fs.rmSync(userSessionDir, { recursive: true, force: true });
    }
    
    // Hapus dari daftar pengguna aktif
    activeUsers.delete(userId);
    
    // Reconnect
    await connectToWhatsApp(userId);
  } catch (error) {
    console.error('Error reconnect:', error);
    bot.sendMessage(
      userId,
      `❌ *Gagal reconnect!*\n\nError: ${error.message}\n\nCoba lagi nanti.`,
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
    
    try {
      await sock.logout();
    } catch (e) {
      console.log('Error saat logout, tapi tetap lanjut:', e);
    }
    
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
    
    // Force cleanup
    const userSessionDir = path.join(sessionDir, userId.toString());
    if (fs.existsSync(userSessionDir)) {
      fs.rmSync(userSessionDir, { recursive: true, force: true });
    }
    activeUsers.delete(userId);
    
    bot.sendMessage(
      userId,
      `✅ *Logout berhasil dipaksa!*\n\nAda error: ${error.message}\nTapi kamu sudah berhasil logout.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Menangani perintah /status
bot.onText(/\/status/, async (msg) => {
  const userId = msg.from.id;
  
  if (!activeUsers.has(userId) || !activeUsers.get(userId).sock) {
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
  
  try {
    // Verifikasi koneksi aktif dengan ping
    let isConnected = false;
    try {
      if (sock.user) {
        isConnected = true;
      }
    } catch (e) {
      console.log('Error saat cek koneksi:', e);
      isConnected = false;
    }
    
    if (!isConnected) {
      bot.sendMessage(
        userId,
        `⚠️ *Status Koneksi: Bermasalah*\n\n` +
        `Koneksi WhatsApp mungkin terputus.\n` +
        `Coba reconnect dengan /reconnect`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    bot.sendMessage(
      userId,
      `✅ *Status Koneksi: Terhubung*\n\n` +
      `📱 Nomor: +${sock.user.id.split(':')[0]}\n` +
      `👤 Nama: ${sock.user.name}\n` +
      `🔢 Jumlah Chat: ${Object.keys(sock.chats).length}\n\n` +
      `Kamu bisa membuat grup dengan /buat [nama] [jumlah]\n` +
      `Atau kirim foto dengan caption untuk menggunakan sebagai foto profil grup`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.log('Error cek status:', error);
    bot.sendMessage(
      userId,
      `⚠️ *Status Koneksi: Bermasalah*\n\n` +
      `Error: ${error.message}\n` +
      `Coba reconnect dengan /reconnect`,
      { parse_mode: 'Markdown' }
    );
  }
});

// Menangani perintah /buat baik dari text command atau caption foto
async function handleCreateGroupCommand(msg, match, photoPath = null) {
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
    // Cek koneksi aktif
    const userData = activeUsers.get(userId);
    const sock = userData.sock;
    
    try {
      if (!sock.user) {
        throw new Error('Koneksi WhatsApp tidak aktif!');
      }
    } catch (e) {
      // Koneksi bermasalah, coba reconnect
      bot.sendMessage(
        userId,
        `⚠️ *Koneksi WhatsApp bermasalah!*\n\n` +
        `Mencoba menghubungkan ulang sebelum membuat grup...`,
        { parse_mode: 'Markdown' }
      );
      
      // Reconnect dan tunggu
      const success = await forceReconnect(userId);
      if (!success) {
        throw new Error('Gagal reconnect sebelum membuat grup. Coba /connect lagi.');
      }
      
      // Tunggu sebentar setelah reconnect
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // Simpan path foto di userData jika ada
    if (photoPath) {
      userData.profilePic = photoPath;
      activeUsers.set(userId, userData);
    }
    
    // Buat grup dengan foto profil jika ada
    await createWhatsAppGroups(userId, groupName, count, photoPath);
  } catch (error) {
    console.error('Error buat grup:', error);
    bot.sendMessage(
      userId,
      `❌ *Gagal membuat grup!*\n\nError: ${error.message}\n\nCoba connect ulang dengan /logout lalu /connect`,
      { parse_mode: 'Markdown' }
    );
  }
}

// Menangani perintah /buat (text command)
bot.onText(/\/buat (.+)/, async (msg, match) => {
  // Ini hanya untuk perintah text, bukan caption foto
  if (msg.photo) return;
  
  await handleCreateGroupCommand(msg, match);
});

// Menangani foto dengan caption /buat
bot.on('photo', async (msg) => {
  const caption = msg.caption;
  if (!caption) return;
  
  // Cek apakah caption dimulai dengan /buat
  const match = caption.match(/^\/buat (.+)/);
  if (!match) return;
  
  const userId = msg.from.id;
  
  try {
    // Pilih foto dengan resolusi tertinggi
    const photoId = msg.photo[msg.photo.length - 1].file_id;
    
    // Kirim pesan sedang memproses
    bot.sendMessage(
      userId,
      `🖼️ *Foto diterima!*\n\nSedang memproses foto...\nTunggu sebentar ya.`,
      { parse_mode: 'Markdown' }
    );
    
    // Download foto dari Telegram
    const photoPath = await downloadTelegramPhoto(photoId, userId);
    
    // Proses perintah pembuatan grup dengan foto
    await handleCreateGroupCommand(msg, match, photoPath);
  } catch (error) {
    console.error('Error proses foto:', error);
    bot.sendMessage(
      userId,
      `❌ *Gagal memproses foto!*\n\nError: ${error.message}\n\nCoba lagi nanti.`,
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

// Bersihkan foto profil yang tidak terpakai (setiap 1 jam)
setInterval(() => {
  try {
    // Hapus foto yang lebih dari 1 jam (3600000 ms)
    const timeThreshold = Date.now() - 3600000;
    
    // Cek setiap folder user
    if (fs.existsSync(profilePicsDir)) {
      fs.readdirSync(profilePicsDir).forEach(userId => {
        const userDir = path.join(profilePicsDir, userId);
        
        if (fs.statSync(userDir).isDirectory()) {
          fs.readdirSync(userDir).forEach(file => {
            const filePath = path.join(userDir, file);
            
            // Cek apakah ini file gambar (bukan folder)
            if (fs.statSync(filePath).isFile() && 
                (file.endsWith('.jpg') || file.endsWith('.png') || file.endsWith('.jpeg'))) {
              
              // Cek waktu modifikasi
              const fileStats = fs.statSync(filePath);
              if (fileStats.mtimeMs < timeThreshold) {
                // File lebih dari 1 jam, hapus
                try {
                  fs.unlinkSync(filePath);
                  console.log(`Hapus foto lama: ${filePath}`);
                } catch (e) {
                  console.log(`Error hapus foto lama ${filePath}:`, e);
                }
              }
            }
          });
          
          // Hapus folder jika kosong
          try {
            const files = fs.readdirSync(userDir);
            if (files.length === 0) {
              fs.rmdirSync(userDir);
              console.log(`Hapus folder kosong: ${userDir}`);
            }
          } catch (e) {
            console.log(`Error hapus folder kosong ${userDir}:`, e);
          }
        }
      });
    }
  } catch (error) {
    console.log('Error bersihkan foto:', error);
  }
}, 3600000); // Setiap 1 jam

// Tambahkan ping interval untuk menjaga koneksi
setInterval(() => {
  // Ping semua koneksi aktif
  for (const [userId, userData] of activeUsers.entries()) {
    try {
      if (userData.sock && userData.sock.user) {
        // Ping koneksi untuk menjaga tetap aktif
        userData.sock.sendPresenceUpdate('available');
      }
    } catch (error) {
      console.log(`Error saat ping koneksi user ${userId}:`, error);
    }
  }
}, 30000); // Ping setiap 30 detik

// Mulai bot
console.log('Bot Telegram pembuat grup WhatsApp telah aktif! 🚀');

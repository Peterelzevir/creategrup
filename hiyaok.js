// ═════════════════════════════════════════════════════════════
// 📱 𝗪𝗵𝗮𝘁𝘀𝗔𝗽𝗽 𝗠𝗮𝗻𝗮𝗴𝗲𝗺𝗲𝗻𝘁 𝗧𝗲𝗹𝗲𝗴𝗿𝗮𝗺 𝗕𝗼𝘁 
// ═════════════════════════════════════════════════════════════

const { Telegraf } = require('telegraf');
const { message } = require('telegraf/filters');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');

// Bot configuration
const BOT_TOKEN = '8070819656:AAFL4uYsyIG2i1ZlqvskDe6663IlT-t6w8Y';
const bot = new Telegraf(BOT_TOKEN);

// Create sessions directory if it doesn't exist
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR);
}

// Create data directory if it doesn't exist
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

// Admin and premium user data file
const USER_FILE = path.join(DATA_DIR, 'users.json');
if (!fs.existsSync(USER_FILE)) {
  fs.writeFileSync(USER_FILE, JSON.stringify({
    admins: [/* Your Telegram User ID as a number */],
    premium: []
  }));
}

// WhatsApp connections storage by user
const waConnections = {};

// User to WhatsApp session mapping
const userSessions = {};

// Group data storage
const GROUP_DATA_FILE = path.join(DATA_DIR, 'groups.json');
if (!fs.existsSync(GROUP_DATA_FILE)) {
  fs.writeFileSync(GROUP_DATA_FILE, JSON.stringify({}));
}

// Read user data
const getUserData = () => {
  const data = JSON.parse(fs.readFileSync(USER_FILE, 'utf8'));
  return {
    admins: data.admins || [],
    premium: data.premium || []
  };
};

// Save user data
const saveUserData = (data) => {
  fs.writeFileSync(USER_FILE, JSON.stringify(data));
};

// Read group data
const getGroupData = () => {
  return JSON.parse(fs.readFileSync(GROUP_DATA_FILE, 'utf8'));
};

// Save group data
const saveGroupData = (data) => {
  fs.writeFileSync(GROUP_DATA_FILE, JSON.stringify(data));
};

// Check if user is admin
const isAdmin = (userId) => {
  return getUserData().admins.includes(userId);
};

// Check if user is premium
const isPremium = (userId) => {
  return getUserData().premium.includes(userId);
};

// Get user WhatsApp sessions
const getUserSessions = (userId) => {
  return userSessions[userId] || [];
};

// Add session to user
const addUserSession = (userId, sessionId) => {
  if (!userSessions[userId]) {
    userSessions[userId] = [];
  }
  
  if (!userSessions[userId].includes(sessionId)) {
    userSessions[userId].push(sessionId);
  }
};

// Create a QR code image
const generateQRCode = async (text) => {
  const qrPath = path.join(SESSIONS_DIR, `qr_${Date.now()}.png`);
  await qrcode.toFile(qrPath, text);
  return qrPath;
};

// Helper function to sanitize phone number
const sanitizePhone = (phone) => {
  return phone.replace(/[^0-9]/g, '');
};

// Connect to WhatsApp with QR Code
const connectToWhatsApp = async (sessionId, ctx) => {
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  
  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    defaultQueryTimeoutMs: 60000
  });
  
  // Store connection
  waConnections[sessionId] = {
    sock,
    groups: []
  };
  
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      // Generate and send QR code
      const qrPath = await generateQRCode(qr);
      await ctx.replyWithPhoto({ source: qrPath }, { 
        caption: '🔄 *Silahkan scan QR Code untuk login WhatsApp*\n\n_QR akan hilang setelah berhasil terhubung_',
        parse_mode: 'Markdown'
      });
      
      // Delete QR file after sending
      fs.unlinkSync(qrPath);
    }
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      
      if (shouldReconnect) {
        await ctx.reply('⚠️ *Koneksi terputus, mencoba menyambung kembali...*', { parse_mode: 'Markdown' });
        connectToWhatsApp(sessionId, ctx);
      } else {
        await ctx.reply('❌ *WhatsApp telah logout.*', { parse_mode: 'Markdown' });
        // Remove session files
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        delete waConnections[sessionId];
      }
    } else if (connection === 'open') {
      await ctx.reply('✅ *WhatsApp berhasil terhubung!*', { parse_mode: 'Markdown' });
    }
  });
  
  sock.ev.on('creds.update', saveCreds);
};

// Connect to WhatsApp with Pairing Code
const connectWithPairingCode = async (sessionId, ctx) => {
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  
  // Create socket with QR disabled
  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    defaultQueryTimeoutMs: 60000
  });
  
  // Store connection
  waConnections[sessionId] = {
    sock,
    groups: []
  };
  
  // Handle connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      
      if (shouldReconnect) {
        await ctx.reply('⚠️ *Koneksi terputus, mencoba menyambung kembali...*', { parse_mode: 'Markdown' });
        connectWithPairingCode(sessionId, ctx);
      } else {
        await ctx.reply('❌ *WhatsApp telah logout.*', { parse_mode: 'Markdown' });
        // Remove session files
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        delete waConnections[sessionId];
      }
    } else if (connection === 'open') {
      await ctx.reply('✅ *WhatsApp berhasil terhubung!*', { parse_mode: 'Markdown' });
    }
  });
  
  // Save credentials when updated
  sock.ev.on('creds.update', saveCreds);
  
  // Check if already registered (in case session already exists)
  if (state?.creds?.registered === false) {
    try {
      // Request pairing code with the phone number
      const formattedNumber = sessionId.startsWith('62') 
        ? sessionId 
        : `62${sessionId.replace(/^0+/, '')}`;
      
      // Send info message
      await ctx.reply('🔄 *Meminta Pairing Code dari server WhatsApp...*\nMohon tunggu sebentar.', {
        parse_mode: 'Markdown'
      });
      
      // Request pairing code
      const pairingCode = await sock.requestPairingCode(formattedNumber);
      
      if (pairingCode) {
        await ctx.reply(`🔑 *Kode Pairing Anda:*\n\n*${pairingCode}*\n\n_Masukkan kode ini di aplikasi WhatsApp Anda untuk menyelesaikan koneksi._`, {
          parse_mode: 'Markdown'
        });
      }
    } catch (error) {
      console.error('Error requesting pairing code:', error);
      await ctx.reply(`❌ *Gagal mendapatkan Pairing Code:* ${error.message}\n\nSilakan coba lagi atau gunakan metode QR Code.`, {
        parse_mode: 'Markdown'
      });
    }
  } else {
    await ctx.reply('✅ *Sesi sudah ada. WhatsApp sudah terhubung!*', {
      parse_mode: 'Markdown'
    });
  }
};

// Get available sessions
const getAvailableSessions = () => {
  return fs.readdirSync(SESSIONS_DIR)
    .filter(dir => fs.statSync(path.join(SESSIONS_DIR, dir)).isDirectory());
};

// Create WhatsApp group
const createWhatsAppGroup = async (sock, groupName) => {
  try {
    const group = await sock.groupCreate(groupName, []);
    return { 
      id: group.id,
      name: groupName,
      invite: null
    };
  } catch (error) {
    console.error('Error creating group:', error);
    throw error;
  }
};

// Get group invite link
const getGroupInviteLink = async (sock, groupId) => {
  try {
    return await sock.groupInviteCode(groupId);
  } catch (error) {
    console.error('Error getting invite link:', error);
    return null;
  }
};

// Leave WhatsApp group
const leaveWhatsAppGroup = async (sock, groupId) => {
  try {
    await sock.groupLeave(groupId);
    return true;
  } catch (error) {
    console.error('Error leaving group:', error);
    return false;
  }
};

// Middleware to check user access
bot.use(async (ctx, next) => {
  if (ctx.from) {
    const userId = ctx.from.id;
    ctx.isAdmin = isAdmin(userId);
    ctx.isPremium = isPremium(userId);
    ctx.hasAccess = ctx.isAdmin || ctx.isPremium;
  }
  await next();
});

// Start command
bot.start(async (ctx) => {
  const welcomeMsg = '🌟 *Welcome to WhatsApp Management Bot* 🌟\n\n';
  
  if (ctx.isAdmin) {
    await ctx.replyWithMarkdown(
      welcomeMsg +
      'Sebagai Admin Bot, Anda dapat:\n' +
      '• Menghubungkan akun WhatsApp\n' +
      '• Membuat grup WhatsApp secara massal\n' +
      '• Mengelola grup yang telah dibuat\n' +
      '• Mengelola user premium\n\n' +
      'Gunakan /help untuk melihat daftar perintah'
    );
  } else if (ctx.isPremium) {
    await ctx.replyWithMarkdown(
      welcomeMsg +
      'Sebagai User Premium, Anda dapat:\n' +
      '• Menghubungkan akun WhatsApp\n' +
      '• Membuat grup WhatsApp secara massal\n' +
      '• Mengelola grup yang telah dibuat\n\n' +
      'Gunakan /help untuk melihat daftar perintah'
    );
  } else {
    await ctx.replyWithMarkdown(
      welcomeMsg +
      'Anda belum memiliki akses premium untuk menggunakan bot ini.\n' +
      'Silakan hubungi admin untuk mendapatkan akses premium.'
    );
  }
});

// Help command
bot.help(async (ctx) => {
  if (!ctx.hasAccess) {
    return await ctx.reply('⛔ Akses ditolak. Hanya admin dan user premium yang dapat menggunakan bot ini.');
  }
  
  let helpText = '📚 *Daftar Perintah* 📚\n\n' +
    '/connect - Hubungkan akun WhatsApp baru\n' +
    '/sessions - Lihat daftar akun WhatsApp yang terhubung\n' +
    '/creategroup - Buat grup WhatsApp secara massal\n' +
    '/keluarall - Keluar dari semua grup yang dibuat\n';
    
  // Admin-only commands
  if (ctx.isAdmin) {
    helpText += '\n*Perintah Admin:*\n' +
      '/addadmin - Tambahkan admin baru\n' +
      '/admins - Lihat daftar admin bot\n' +
      '/addprem - Tambahkan user premium\n' +
      '/premlist - Lihat daftar user premium\n';
  }
  
  await ctx.replyWithMarkdown(helpText);
});

// Connect command
bot.command('connect', async (ctx) => {
  if (!ctx.hasAccess) {
    return await ctx.reply('⛔ Akses ditolak. Hanya admin dan user premium yang dapat menggunakan bot ini.');
  }
  
  // Pilihan metode koneksi: QR Code atau Pairing Code
  await ctx.reply('📱 *Pilih metode koneksi WhatsApp:*', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📷 QR Code", callback_data: "connect_method:qr" },
          { text: "🔢 Pairing Code", callback_data: "connect_method:pairing" }
        ]
      ]
    }
  });
});

// Callback untuk pilihan metode koneksi
bot.action(/connect_method:(.+)/, async (ctx) => {
  const method = ctx.match[1];
  const userId = ctx.from.id;
  
  await ctx.answerCbQuery();
  
  // Hapus tombol setelah diklik
  await ctx.editMessageText('📱 *Pilih metode koneksi WhatsApp:*\n\n' + 
    (method === 'qr' ? '✅ Metode QR Code dipilih' : '✅ Metode Pairing Code dipilih'), {
    parse_mode: 'Markdown'
  });
  
  // Simpan metode koneksi dan user ID dalam session
  ctx.session = {
    ...ctx.session,
    connectionMethod: method,
    connectingUserId: userId
  };
  
  const phoneNumber = await ctx.reply('📱 *Masukkan nomor WhatsApp* (contoh: 628123456789):', {
    parse_mode: 'Markdown',
    reply_markup: {
      force_reply: true
    }
  });
  
  bot.on(message('text'), async (replyCtx) => {
    if (replyCtx.message.reply_to_message?.message_id !== phoneNumber.message_id) {
      return;
    }
    
    // Pastikan yang mereply adalah user yang sama
    if (replyCtx.from.id !== userId) {
      return await replyCtx.reply('❌ *Anda tidak memiliki hak untuk melanjutkan setup ini.*', {
        parse_mode: 'Markdown'
      });
    }
    
    const phone = sanitizePhone(replyCtx.message.text);
    
    if (!phone || phone.length < 10) {
      return await replyCtx.reply('❌ *Nomor tidak valid.* Silakan coba lagi dengan format yang benar.', {
        parse_mode: 'Markdown'
      });
    }
    
    // Buat session ID yang unik per user
    const sessionId = `${phone}_${userId}`;
    
    // Simpan session untuk user ini
    addUserSession(userId, sessionId);
    
    const method = replyCtx.session?.connectionMethod || 'qr';
    
    if (method === 'qr') {
      await replyCtx.reply(`🔄 *Memulai proses koneksi QR untuk nomor ${phone}...*\n\nSilakan tunggu QR Code muncul.`, {
        parse_mode: 'Markdown'
      });
      
      // Start WhatsApp connection with QR
      await connectToWhatsApp(sessionId, replyCtx);
    } else {
      await replyCtx.reply(`🔄 *Memulai proses koneksi dengan Pairing Code untuk nomor ${phone}...*\n\nSilakan tunggu Pairing Code muncul.`, {
        parse_mode: 'Markdown'
      });
      
      // Start WhatsApp connection with Pairing Code
      await connectWithPairingCode(sessionId, replyCtx);
    }
    
    // Remove listener
    bot.off(message('text'));
  });
});

// List sessions command
bot.command('sessions', async (ctx) => {
  if (!ctx.hasAccess) {
    return await ctx.reply('⛔ Akses ditolak. Hanya admin dan user premium yang dapat menggunakan bot ini.');
  }
  
  const userId = ctx.from.id;
  let sessions;
  
  if (ctx.isAdmin) {
    // Admin dapat melihat semua sesi atau sesi mereka sendiri
    const text = ctx.message.text;
    const showAll = text.includes('all') && ctx.isAdmin;
    
    if (showAll) {
      sessions = getAvailableSessions();
    } else {
      sessions = getUserSessions(userId);
    }
  } else {
    // User premium hanya dapat melihat sesi mereka sendiri
    sessions = getUserSessions(userId);
  }
  
  if (!sessions || sessions.length === 0) {
    return await ctx.reply('❌ *Tidak ada akun WhatsApp yang terhubung.*', {
      parse_mode: 'Markdown'
    });
  }
  
  let message = '📱 *Daftar Akun WhatsApp Terhubung*\n\n';
  sessions.forEach((session, index) => {
    const isActive = waConnections[session] ? '✅ Active' : '❌ Inactive';
    message += `${index + 1}. *${session}* - ${isActive}\n`;
  });
  
  if (ctx.isAdmin) {
    message += '\n_Tip: Gunakan /sessions all untuk melihat semua sesi_';
  }
  
  await ctx.replyWithMarkdown(message);
});

// Create group command
bot.command('creategroup', async (ctx) => {
  if (!ctx.hasAccess) {
    return await ctx.reply('⛔ Akses ditolak. Hanya admin dan user premium yang dapat menggunakan bot ini.');
  }
  
  const userId = ctx.from.id;
  let sessions;
  
  if (ctx.isAdmin) {
    const text = ctx.message.text;
    const showAll = text.includes('all') && ctx.isAdmin;
    
    if (showAll) {
      sessions = getAvailableSessions();
    } else {
      sessions = getUserSessions(userId);
    }
  } else {
    sessions = getUserSessions(userId);
  }
  
  if (!sessions || sessions.length === 0) {
    return await ctx.reply('❌ *Tidak ada akun WhatsApp yang terhubung.*\nGunakan /connect untuk menghubungkan akun.', {
      parse_mode: 'Markdown'
    });
  }
  
  // Create inline keyboard with available sessions
  const keyboard = sessions.map((session, index) => {
    return [{ text: `📱 ${session}`, callback_data: `create_group:${session}` }];
  });
  
  const msg = '📊 *Pilih akun WhatsApp untuk membuat grup:*';
  const replyMsg = ctx.isAdmin ? 
    `${msg}\n\n_Tip: Gunakan /creategroup all untuk melihat semua sesi_` : 
    msg;
  
  await ctx.reply(replyMsg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
});

// Callback handler for group creation
bot.action(/create_group:(.+)/, async (ctx) => {
  const sessionId = ctx.match[1];
  
  // Hapus tombol setelah diklik
  await ctx.editMessageText(`📊 *Pilih akun WhatsApp untuk membuat grup:*\n\n✅ Akun *${sessionId}* dipilih`, {
    parse_mode: 'Markdown'
  });
  
  // Check if session exists and is connected
  if (!waConnections[sessionId] || !waConnections[sessionId].sock) {
    await ctx.reply(`🔄 *Menghubungkan ke akun ${sessionId}...*\nSilakan tunggu sebentar.`, {
      parse_mode: 'Markdown'
    });
    await connectToWhatsApp(sessionId, ctx);
    
    // Store session for later use
    ctx.session = {
      ...ctx.session,
      pendingGroupCreation: sessionId
    };
    
    return;
  }
  
  await ctx.answerCbQuery();
  
  // Ask for group name
  const message = await ctx.reply('✏️ *Masukkan nama grup yang akan dibuat:*', {
    parse_mode: 'Markdown',
    reply_markup: {
      force_reply: true
    }
  });
  
  ctx.session = {
    ...ctx.session,
    pendingGroupCreation: sessionId,
    groupNameMessageId: message.message_id
  };
});

// Handle group name input
bot.on(message('text'), async (ctx) => {
  if (!ctx.session?.pendingGroupCreation || !ctx.message.reply_to_message) {
    return;
  }
  
  if (ctx.session.groupNameMessageId === ctx.message.reply_to_message.message_id) {
    const groupName = ctx.message.text.trim();
    
    if (!groupName) {
      return await ctx.reply('❌ *Nama grup tidak valid.* Silakan coba lagi.', {
        parse_mode: 'Markdown'
      });
    }
    
    ctx.session.groupName = groupName;
    
    // Ask for number of groups to create
    const message = await ctx.reply('🔢 *Masukkan jumlah grup yang ingin dibuat:*', {
      parse_mode: 'Markdown',
      reply_markup: {
        force_reply: true
      }
    });
    
    ctx.session.groupCountMessageId = message.message_id;
    return;
  }
  
  if (ctx.session.groupCountMessageId === ctx.message.reply_to_message.message_id) {
    const count = parseInt(ctx.message.text.trim());
    
    if (isNaN(count) || count < 1 || count > 50) {
      return await ctx.reply('❌ *Jumlah tidak valid.* Silakan masukkan angka antara 1-50.', {
        parse_mode: 'Markdown'
      });
    }
    
    const sessionId = ctx.session.pendingGroupCreation;
    const groupName = ctx.session.groupName;
    
    await ctx.reply(`🔄 *Proses pembuatan ${count} grup dengan nama "${groupName}" dimulai...*\nMohon tunggu sebentar.`, {
      parse_mode: 'Markdown'
    });
    
    const sock = waConnections[sessionId].sock;
    const groups = [];
    const groupData = getGroupData();
    
    if (!groupData[sessionId]) {
      groupData[sessionId] = [];
    }
    
    for (let i = 0; i < count; i++) {
      try {
        const fullGroupName = count > 1 ? `${groupName} ${i + 1}` : groupName;
        
        await ctx.reply(`🔄 *Membuat grup "${fullGroupName}" (${i + 1}/${count})...*`, {
          parse_mode: 'Markdown'
        });
        
        const group = await createWhatsAppGroup(sock, fullGroupName);
        
        // Get invite link
        const inviteCode = await getGroupInviteLink(sock, group.id);
        const inviteLink = inviteCode ? `https://chat.whatsapp.com/${inviteCode}` : null;
        
        group.invite = inviteLink;
        groups.push(group);
        
        // Save group data
        groupData[sessionId].push(group);
        saveGroupData(groupData);
        
        // Store in connection
        if (!waConnections[sessionId].groups) {
          waConnections[sessionId].groups = [];
        }
        waConnections[sessionId].groups.push(group);
      } catch (error) {
        console.error(`Error creating group ${i + 1}:`, error);
        await ctx.reply(`❌ *Error saat membuat grup ${i + 1}:* ${error.message}`, {
          parse_mode: 'Markdown'
        });
      }
    }
    
    // Send results
    if (groups.length > 0) {
      let message = `✅ *${groups.length} grup berhasil dibuat!*\n\n`;
      
      groups.forEach((group, index) => {
        message += `${index + 1}. *${group.name}*\n`;
        if (group.invite) {
          message += `   🔗 ${group.invite}\n\n`;
        } else {
          message += `   ❌ Tidak dapat membuat link undangan\n\n`;
        }
      });
      
      await ctx.replyWithMarkdown(message, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🚪 Keluar dari semua grup", callback_data: `exit_all:${sessionId}` }
            ]
          ]
        }
      });
    } else {
      await ctx.reply('❌ *Tidak ada grup yang berhasil dibuat.*', {
        parse_mode: 'Markdown'
      });
    }
    
    // Clear session
    delete ctx.session.pendingGroupCreation;
    delete ctx.session.groupName;
    delete ctx.session.groupNameMessageId;
    delete ctx.session.groupCountMessageId;
  }
});

// Exit all groups command
bot.command('keluarall', async (ctx) => {
  if (!ctx.hasAccess) {
    return await ctx.reply('⛔ Akses ditolak. Hanya admin dan user premium yang dapat menggunakan bot ini.');
  }
  
  const userId = ctx.from.id;
  let sessions;
  
  if (ctx.isAdmin) {
    const text = ctx.message.text;
    const showAll = text.includes('all') && ctx.isAdmin;
    
    if (showAll) {
      sessions = getAvailableSessions();
    } else {
      sessions = getUserSessions(userId);
    }
  } else {
    sessions = getUserSessions(userId);
  }
  
  if (!sessions || sessions.length === 0) {
    return await ctx.reply('❌ *Tidak ada akun WhatsApp yang terhubung.*', {
      parse_mode: 'Markdown'
    });
  }
  
  // Create inline keyboard with available sessions
  const keyboard = sessions.map((session, index) => {
    return [{ text: `📱 ${session}`, callback_data: `exit_all:${session}` }];
  });
  
  const msg = '📊 *Pilih akun WhatsApp untuk keluar dari semua grup:*';
  const replyMsg = ctx.isAdmin ? 
    `${msg}\n\n_Tip: Gunakan /keluarall all untuk melihat semua sesi_` : 
    msg;
  
  await ctx.reply(replyMsg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
});

// Callback handler for exiting all groups
bot.action(/exit_all:(.+)/, async (ctx) => {
  const sessionId = ctx.match[1];
  
  await ctx.answerCbQuery();
  
  // Hapus tombol setelah diklik jika dari perintah /keluarall
  if (ctx.callbackQuery.message.text.includes('Pilih akun WhatsApp untuk keluar dari semua grup')) {
    await ctx.editMessageText(`📊 *Pilih akun WhatsApp untuk keluar dari semua grup:*\n\n✅ Akun *${sessionId}* dipilih`, {
      parse_mode: 'Markdown'
    });
  }
  
  // Check if session exists and is connected
  if (!waConnections[sessionId] || !waConnections[sessionId].sock) {
    await ctx.reply(`🔄 *Menghubungkan ke akun ${sessionId}...*\nSilakan tunggu sebentar.`, {
      parse_mode: 'Markdown'
    });
    await connectToWhatsApp(sessionId, ctx);
    return;
  }
  
  // Confirm exit
  await ctx.reply(`⚠️ *Anda yakin ingin keluar dari semua grup yang dibuat oleh ${sessionId}?*`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Ya, Keluar", callback_data: `confirm_exit_all:${sessionId}` },
          { text: "❌ Batal", callback_data: "cancel_exit" }
        ]
      ]
    }
  });
});

bot.action('cancel_exit', async (ctx) => {
  await ctx.answerCbQuery();
  // Hapus tombol setelah batal
  await ctx.editMessageText('⚠️ *Anda yakin ingin keluar dari semua grup?*\n\n❌ *Operasi dibatalkan.*', {
    parse_mode: 'Markdown'
  });
});

bot.action(/confirm_exit_all:(.+)/, async (ctx) => {
  const sessionId = ctx.match[1];
  
  await ctx.answerCbQuery();
  
  // Hapus tombol konfirmasi setelah diklik
  await ctx.editMessageText(`⚠️ *Anda yakin ingin keluar dari semua grup yang dibuat oleh ${sessionId}?*\n\n✅ *Mengonfirmasi keluar dari semua grup...*`, {
    parse_mode: 'Markdown'
  });
  
  const groupData = getGroupData();
  const groups = groupData[sessionId] || [];
  
  if (groups.length === 0) {
    return await ctx.reply('❌ *Tidak ada grup yang perlu ditinggalkan.*', {
      parse_mode: 'Markdown'
    });
  }
  
  await ctx.reply(`🔄 *Proses keluar dari ${groups.length} grup dimulai...*\nMohon tunggu sebentar.`, {
    parse_mode: 'Markdown'
  });
  
  const sock = waConnections[sessionId].sock;
  let successCount = 0;
  let failCount = 0;
  
  for (const group of groups) {
    try {
      const success = await leaveWhatsAppGroup(sock, group.id);
      
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    } catch (error) {
      console.error(`Error leaving group ${group.name}:`, error);
      failCount++;
    }
  }
  
  // Clear group data
  groupData[sessionId] = [];
  saveGroupData(groupData);
  
  if (waConnections[sessionId]) {
    waConnections[sessionId].groups = [];
  }
  
  await ctx.reply(`✅ *Proses selesai!*\n\n✅ Berhasil keluar dari: ${successCount} grup\n❌ Gagal keluar dari: ${failCount} grup`, {
    parse_mode: 'Markdown'
  });
});

// Add admin command
bot.command('addadmin', async (ctx) => {
  if (!ctx.isAdmin) {
    return await ctx.reply('⛔ Akses ditolak. Hanya admin yang dapat menggunakan fitur ini.');
  }
  
  const message = await ctx.reply('👤 *Kirim User ID Telegram yang ingin dijadikan admin:*\n_(Forward pesan dari user atau masukkan ID secara manual)_', {
    parse_mode: 'Markdown',
    reply_markup: {
      force_reply: true
    }
  });
  
  ctx.session = {
    ...ctx.session,
    addAdminMessageId: message.message_id
  };
});

// Handle add admin reply
bot.on(message('text'), async (ctx) => {
  if (!ctx.session?.addAdminMessageId || !ctx.message.reply_to_message) {
    return;
  }
  
  if (ctx.session.addAdminMessageId === ctx.message.reply_to_message.message_id) {
    const userId = parseInt(ctx.message.text.trim());
    
    if (isNaN(userId)) {
      return await ctx.reply('❌ *User ID tidak valid.* Silakan masukkan angka.', {
        parse_mode: 'Markdown'
      });
    }
    
    const userData = getUserData();
    
    if (userData.admins.includes(userId)) {
      return await ctx.reply('⚠️ *User sudah menjadi admin.*', {
        parse_mode: 'Markdown'
      });
    }
    
    userData.admins.push(userId);
    saveUserData(userData);
    
    await ctx.reply(`✅ *User ID ${userId} berhasil ditambahkan sebagai admin!*`, {
      parse_mode: 'Markdown'
    });
    
    // Clear session
    delete ctx.session.ad

// Session middleware
bot.use((ctx, next) => {
  if (!ctx.session) ctx.session = {};
  return next();
});

// Launch bot
bot.launch().then(() => {
  console.log('🚀 Bot is running...');
}).catch(err => {
  console.error('Error starting bot:', err);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ═════════════════════════════════════════════════════════════
// 📱 𝗪𝗵𝗮𝘁𝘀𝗔𝗽𝗽 𝗠𝗮𝗻𝗮𝗴𝗲𝗺𝗲𝗻𝘁 𝗧𝗲𝗹𝗲𝗴𝗿𝗮𝗺 𝗕𝗼𝘁 
// ═════════════════════════════════════════════════════════════

const { Telegraf, Scenes, session } = require('telegraf');
const LocalSession = require('telegraf-session-local');
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
    admins: [5988451717], // Replace with your Telegram ID or add yours to this array
    premium: []
  }));
}

// Group data storage
const GROUP_DATA_FILE = path.join(DATA_DIR, 'groups.json');
if (!fs.existsSync(GROUP_DATA_FILE)) {
  fs.writeFileSync(GROUP_DATA_FILE, JSON.stringify({}));
}

// WhatsApp connections storage by user
const waConnections = {};

// User to WhatsApp session mapping
const userSessions = {};

// Active message listeners
const activeListeners = {};

// Save sessions to file on startup and changes
const SESSION_MAPPING_FILE = path.join(DATA_DIR, 'session_mapping.json');

// Load session mappings
const loadSessionMappings = () => {
  if (fs.existsSync(SESSION_MAPPING_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SESSION_MAPPING_FILE, 'utf8'));
      return data;
    } catch (error) {
      console.error('Error loading session mappings:', error);
      return {};
    }
  }
  return {};
};

// Save session mappings
const saveSessionMappings = () => {
  fs.writeFileSync(SESSION_MAPPING_FILE, JSON.stringify(userSessions));
};

// Initialize session mappings
const initialMappings = loadSessionMappings();
Object.assign(userSessions, initialMappings);

// Periodically save session mappings
setInterval(saveSessionMappings, 60000); // Save every minute

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
  
  // Save immediately after adding
  saveSessionMappings();
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

// Format phone number for WhatsApp
const formatPhoneForWhatsApp = (phone) => {
  phone = sanitizePhone(phone);
  
  // If starts with '62', keep it that way
  if (phone.startsWith('62')) {
    return phone;
  }
  
  // If starts with '0', replace with '62'
  if (phone.startsWith('0')) {
    return '62' + phone.substring(1);
  }
  
  // Otherwise, add '62' prefix
  return '62' + phone;
};

// Connect to WhatsApp with QR Code
const connectToWhatsApp = async (sessionId, ctx) => {
  try {
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
    
    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        try {
          // Generate and send QR code
          const qrPath = await generateQRCode(qr);
          await ctx.replyWithPhoto({ source: qrPath }, { 
            caption: '🔄 *Silahkan scan QR Code untuk login WhatsApp*\n\n_QR akan hilang setelah berhasil terhubung_',
            parse_mode: 'Markdown'
          });
          
          // Delete QR file after sending
          fs.unlinkSync(qrPath);
        } catch (error) {
          console.error("Error sending QR code:", error);
          await ctx.reply('❌ *Error generating QR code. Please try again.*', { 
            parse_mode: 'Markdown' 
          });
        }
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
    
    return true;
  } catch (error) {
    console.error("Error connecting to WhatsApp:", error);
    await ctx.reply(`❌ *Error connecting to WhatsApp:* ${error.message}`, { 
      parse_mode: 'Markdown' 
    });
    return false;
  }
};

// Connect to WhatsApp with Pairing Code
const connectWithPairingCode = async (sessionId, phoneNumber, ctx) => {
  try {
    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    // Send info message
    const statusMsg = await ctx.reply('🔄 *Meminta Pairing Code dari server WhatsApp...*\nMohon tunggu sebentar.', {
      parse_mode: 'Markdown'
    });
    
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
          connectWithPairingCode(sessionId, phoneNumber, ctx);
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
        
        // Try to delete status message
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
        } catch (error) {
          console.log('Could not delete status message:', error.message);
        }
      }
    });
    
    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);
    
    // Check if already registered (in case session already exists)
    if (state?.creds?.registered === false) {
      try {
        // Format phone number correctly for WhatsApp
        const formattedNumber = formatPhoneForWhatsApp(phoneNumber);
        
        // Request pairing code
        const pairingCode = await sock.requestPairingCode(formattedNumber);
        
        if (pairingCode) {
          // Try to delete status message
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
          } catch (error) {
            console.log('Could not delete status message:', error.message);
          }
          
          await ctx.reply(`🔑 *Kode Pairing Anda:*\n\n*${pairingCode}*\n\n_Masukkan kode ini di aplikasi WhatsApp Anda untuk menyelesaikan koneksi._`, {
            parse_mode: 'Markdown'
          });
          
          return true;
        }
      } catch (error) {
        console.error('Error requesting pairing code:', error);
        
        // Try to delete status message
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
        } catch (err) {
          console.log('Could not delete status message:', err.message);
        }
        
        await ctx.reply(`❌ *Gagal mendapatkan Pairing Code:* ${error.message}\n\nSilakan coba lagi atau gunakan metode QR Code.`, {
          parse_mode: 'Markdown'
        });
        
        return false;
      }
    } else {
      // Try to delete status message
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } catch (error) {
        console.log('Could not delete status message:', error.message);
      }
      
      await ctx.reply('✅ *Sesi sudah ada. WhatsApp sudah terhubung!*', {
        parse_mode: 'Markdown'
      });
      
      return true;
    }
  } catch (error) {
    console.error("Error connecting with pairing code:", error);
    await ctx.reply(`❌ *Error connecting to WhatsApp:* ${error.message}`, { 
      parse_mode: 'Markdown' 
    });
    return false;
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

// Register a message listener that can be cleaned up
const registerMessageListener = (userId, messageId, callback) => {
  const listenerId = `${userId}_${messageId}`;
  
  if (activeListeners[listenerId]) {
    bot.off(message('text'), activeListeners[listenerId]);
  }
  
  const handler = (ctx) => {
    if (ctx.message.reply_to_message?.message_id !== messageId || ctx.from.id !== userId) {
      return;
    }
    
    callback(ctx);
    
    // Auto-cleanup after successful handling
    bot.off(message('text'), activeListeners[listenerId]);
    delete activeListeners[listenerId];
  };
  
  activeListeners[listenerId] = handler;
  bot.on(message('text'), handler);
  
  // Set timeout to automatically clean up listener after 5 minutes
  setTimeout(() => {
    if (activeListeners[listenerId]) {
      bot.off(message('text'), activeListeners[listenerId]);
      delete activeListeners[listenerId];
    }
  }, 5 * 60 * 1000);
  
  return listenerId;
};

// Clean up a specific message listener
const cleanupMessageListener = (listenerId) => {
  if (activeListeners[listenerId]) {
    bot.off(message('text'), activeListeners[listenerId]);
    delete activeListeners[listenerId];
  }
};

// Clean up all message listeners for a user
const cleanupUserListeners = (userId) => {
  Object.keys(activeListeners)
    .filter(id => id.startsWith(`${userId}_`))
    .forEach(id => {
      bot.off(message('text'), activeListeners[id]);
      delete activeListeners[id];
    });
};

// Setup local session storage that persists to file
const localSession = new LocalSession({
  database: path.join(DATA_DIR, 'session_db.json'),
  storage: LocalSession.storageMemory,
  format: {
    serialize: (obj) => JSON.stringify(obj, null, 2),
    deserialize: (str) => JSON.parse(str)
  }
});

// Session middleware must be set up first, before other middleware
bot.use(localSession.middleware());

// Middleware to check user access
bot.use(async (ctx, next) => {
  if (ctx.from) {
    const userId = ctx.from.id;
    ctx.isAdmin = isAdmin(userId);
    ctx.isPremium = isPremium(userId);
    ctx.hasAccess = ctx.isAdmin || ctx.isPremium;
  }
  
  // Ensure session exists
  if (!ctx.session) ctx.session = {};
  
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
  
  // Clean up any existing listeners for this user
  cleanupUserListeners(ctx.from.id);
  
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
  
  // Clean up any existing listeners
  cleanupUserListeners(userId);
  
  // Store method in session (with fallback if session is undefined)
  if (!ctx.session) ctx.session = {};
  ctx.session.connectionMethod = method;
  
  const phoneMessage = await ctx.reply('📱 *Masukkan nomor WhatsApp* (contoh: 628123456789):', {
    parse_mode: 'Markdown',
    reply_markup: {
      force_reply: true
    }
  });
  
  // Register a message listener for the phone number reply
  registerMessageListener(userId, phoneMessage.message_id, async (replyCtx) => {
    const phone = sanitizePhone(replyCtx.message.text);
    
    if (!phone || phone.length < 10) {
      return await replyCtx.reply('❌ *Nomor tidak valid.* Silakan coba lagi dengan format yang benar.', {
        parse_mode: 'Markdown'
      });
    }
    
    // Create a unique session ID for this user and phone
    const sessionId = `${phone}_${userId}`;
    
    // Add session to user's list
    addUserSession(userId, sessionId);
    
    // Ensure session exists and grab connection method
    if (!replyCtx.session) replyCtx.session = {};
    const method = replyCtx.session.connectionMethod || 'qr';
    
    if (method === 'qr') {
      await replyCtx.reply(`🔄 *Memulai proses koneksi QR untuk nomor ${phone}...*\n\nSilakan tunggu QR Code muncul.`, {
        parse_mode: 'Markdown'
      });
      
      // Start WhatsApp connection with QR
      await connectToWhatsApp(sessionId, replyCtx);
    } else {
      // Start WhatsApp connection with Pairing Code
      await connectWithPairingCode(sessionId, phone, replyCtx);
    }
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
  const userId = ctx.from.id;
  
  // Clean up any existing listeners
  cleanupUserListeners(userId);
  
  await ctx.answerCbQuery();
  
  // Store in session
  ctx.session.pendingGroupCreation = sessionId;
  
  // Hapus tombol setelah diklik
  await ctx.editMessageText(`📊 *Pilih akun WhatsApp untuk membuat grup:*\n\n✅ Akun *${sessionId}* dipilih`, {
    parse_mode: 'Markdown'
  });
  
  // Check if session exists and is connected
  if (!waConnections[sessionId] || !waConnections[sessionId].sock) {
    const statusMsg = await ctx.reply(`🔄 *Menghubungkan ke akun ${sessionId}...*\nSilakan tunggu sebentar.`, {
      parse_mode: 'Markdown'
    });
    
    const success = await connectToWhatsApp(sessionId, ctx);
    
    if (!success) {
      return await ctx.reply('❌ *Gagal menghubungkan ke WhatsApp.* Silakan coba lagi nanti.', {
        parse_mode: 'Markdown'
      });
    }
    
    // Try to delete status message
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch (error) {
      console.log('Could not delete status message:', error.message);
    }
  }
  
  // Ask for group name
  const message = await ctx.reply('✏️ *Masukkan nama grup yang akan dibuat:*', {
    parse_mode: 'Markdown',
    reply_markup: {
      force_reply: true
    }
  });
  
  // Register listener for group name
  registerMessageListener(userId, message.message_id, async (replyCtx) => {
    const groupName = replyCtx.message.text.trim();
    
    if (!groupName) {
      return await replyCtx.reply('❌ *Nama grup tidak valid.* Silakan coba lagi.', {
        parse_mode: 'Markdown'
      });
    }
    
    replyCtx.session.groupName = groupName;
    
    // Ask for number of groups to create
    const countMessage = await replyCtx.reply('🔢 *Masukkan jumlah grup yang ingin dibuat:*', {
      parse_mode: 'Markdown',
      reply_markup: {
        force_reply: true
      }
    });
    
    // Register listener for group count
    registerMessageListener(userId, countMessage.message_id, async (countCtx) => {
      const count = parseInt(countCtx.message.text.trim());
      
      if (isNaN(count) || count < 1 || count > 50) {
        return await countCtx.reply('❌ *Jumlah tidak valid.* Silakan masukkan angka antara 1-50.', {
          parse_mode: 'Markdown'
        });
      }
      
      const sessionId = countCtx.session.pendingGroupCreation;
      const groupName = countCtx.session.groupName;
      
      const statusMsg = await countCtx.reply(`🔄 *Proses pembuatan ${count} grup dengan nama "${groupName}" dimulai...*\nMohon tunggu sebentar.`, {
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
          
          const progressMsg = await countCtx.reply(`🔄 *Membuat grup "${fullGroupName}" (${i + 1}/${count})...*`, {
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
          
          // Try to delete progress message
          try {
            await countCtx.telegram.deleteMessage(countCtx.chat.id, progressMsg.message_id);
          } catch (error) {
            console.log('Could not delete progress message:', error.message);
          }
        } catch (error) {
          console.error(`Error creating group ${i + 1}:`, error);
          await countCtx.reply(`❌ *Error saat membuat grup ${i + 1}:* ${error.message}`, {
            parse_mode: 'Markdown'
          });
        }
      }
      
      // Try to delete status message
      try {
        await countCtx.telegram.deleteMessage(countCtx.chat.id, statusMsg.message_id);
      } catch (error) {
        console.log('Could not delete status message:', error.message);
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
        
        await countCtx.replyWithMarkdown(message, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🚪 Keluar dari semua grup", callback_data: `exit_all:${sessionId}` }
              ]
            ]
          }
        });
      } else {
        await countCtx.reply('❌ *Tidak ada grup yang berhasil dibuat.*', {
          parse_mode: 'Markdown'
        });
      }
      
      // Clear session
      delete countCtx.session.pendingGroupCreation;
      delete countCtx.session.groupName;
    });
  });
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
  if (ctx.callbackQuery.message.text && ctx.callbackQuery.message.text.includes('Pilih akun WhatsApp untuk keluar dari semua grup')) {
    await ctx.editMessageText(`📊 *Pilih akun WhatsApp untuk keluar dari semua grup:*\n\n✅ Akun *${sessionId}* dipilih`, {
      parse_mode: 'Markdown'
    });
  }
  
  // Check if session exists and is connected
  if (!waConnections[sessionId] || !waConnections[sessionId].sock) {
    const statusMsg = await ctx.reply(`🔄 *Menghubungkan ke akun ${sessionId}...*\nSilakan tunggu sebentar.`, {
      parse_mode: 'Markdown'
    });
    
    const success = await connectToWhatsApp(sessionId, ctx);
    
    if (!success) {
      return await ctx.reply('❌ *Gagal menghubungkan ke WhatsApp.* Silakan coba lagi nanti.', {
        parse_mode: 'Markdown'
      });
    }
    
    // Try to delete status message
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch (error) {
      console.log('Could not delete status message:', error.message);
    }
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
  
  const statusMsg = await ctx.reply(`🔄 *Proses keluar dari ${groups.length} grup dimulai...*\nMohon tunggu sebentar.`, {
    parse_mode: 'Markdown'
  });
  
  const sock = waConnections[sessionId].sock;
  let successCount = 0;
  let failCount = 0;
  
  for (const group of groups) {
    try {
      const progressMsg = await ctx.reply(`🔄 *Keluar dari grup "${group.name}"...*`, {
        parse_mode: 'Markdown'
      });
      
      const success = await leaveWhatsAppGroup(sock, group.id);
      
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
      
      // Try to delete progress message
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id);
      } catch (error) {
        console.log('Could not delete progress message:', error.message);
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
  
  // Try to delete status message
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
  } catch (error) {
    console.log('Could not delete status message:', error.message);
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
  
  // Clean up any existing listeners
  cleanupUserListeners(ctx.from.id);
  
  const message = await ctx.reply('👤 *Kirim User ID Telegram yang ingin dijadikan admin:*\n_(Forward pesan dari user atau masukkan ID secara manual)_', {
    parse_mode: 'Markdown',
    reply_markup: {
      force_reply: true
    }
  });
  
  // Register listener for admin ID
  registerMessageListener(ctx.from.id, message.message_id, async (replyCtx) => {
    const userId = parseInt(replyCtx.message.text.trim());
    
    if (isNaN(userId)) {
      return await replyCtx.reply('❌ *User ID tidak valid.* Silakan masukkan angka.', {
        parse_mode: 'Markdown'
      });
    }
    
    const userData = getUserData();
    
    if (userData.admins.includes(userId)) {
      return await replyCtx.reply('⚠️ *User sudah menjadi admin.*', {
        parse_mode: 'Markdown'
      });
    }
    
    userData.admins.push(userId);
    saveUserData(userData);
    
    await replyCtx.reply(`✅ *User ID ${userId} berhasil ditambahkan sebagai admin!*`, {
      parse_mode: 'Markdown'
    });
  });
});

// List admins command
bot.command('admins', async (ctx) => {
  if (!ctx.isAdmin) {
    return await ctx.reply('⛔ Akses ditolak. Hanya admin yang dapat menggunakan fitur ini.');
  }
  
  const userData = getUserData();
  const admins = userData.admins;
  
  if (admins.length === 0) {
    return await ctx.reply('❌ *Tidak ada admin yang terdaftar.*', {
      parse_mode: 'Markdown'
    });
  }
  
  let message = '👑 *Daftar Admin Bot*\n\n';
  admins.forEach((admin, index) => {
    message += `${index + 1}. \`${admin}\`\n`;
  });
  
  await ctx.replyWithMarkdown(message);
});

// Add premium user command
bot.command('addprem', async (ctx) => {
  if (!ctx.isAdmin) {
    return await ctx.reply('⛔ Akses ditolak. Hanya admin yang dapat menggunakan fitur ini.');
  }
  
  // Clean up any existing listeners
  cleanupUserListeners(ctx.from.id);
  
  const message = await ctx.reply('👤 *Kirim User ID Telegram yang ingin dijadikan user premium:*\n_(Forward pesan dari user atau masukkan ID secara manual)_', {
    parse_mode: 'Markdown',
    reply_markup: {
      force_reply: true
    }
  });
  
  // Register listener for premium ID
  registerMessageListener(ctx.from.id, message.message_id, async (replyCtx) => {
    const userId = parseInt(replyCtx.message.text.trim());
    
    if (isNaN(userId)) {
      return await replyCtx.reply('❌ *User ID tidak valid.* Silakan masukkan angka.', {
        parse_mode: 'Markdown'
      });
    }
    
    const userData = getUserData();
    
    if (userData.premium.includes(userId)) {
      return await replyCtx.reply('⚠️ *User sudah menjadi premium.*', {
        parse_mode: 'Markdown'
      });
    }
    
    userData.premium.push(userId);
    saveUserData(userData);
    
    await replyCtx.reply(`✅ *User ID ${userId} berhasil ditambahkan sebagai user premium!*`, {
      parse_mode: 'Markdown'
    });
    
    // Notify user
    try {
      await bot.telegram.sendMessage(userId, 
        '🌟 *Selamat!* Anda telah ditambahkan sebagai *User Premium* WhatsApp Management Bot.\n\n' +
        'Anda sekarang dapat menggunakan fitur-fitur premium seperti:\n' +
        '• Menghubungkan akun WhatsApp\n' +
        '• Membuat grup WhatsApp secara massal\n' +
        '• Mengelola grup yang telah dibuat\n\n' +
        'Gunakan /start untuk memulai!', 
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.log(`Failed to notify user ${userId}: ${error.message}`);
    }
  });
});

// List premium users command
bot.command('premlist', async (ctx) => {
  if (!ctx.isAdmin) {
    return await ctx.reply('⛔ Akses ditolak. Hanya admin yang dapat menggunakan fitur ini.');
  }
  
  const userData = getUserData();
  const premiumUsers = userData.premium;
  
  if (premiumUsers.length === 0) {
    return await ctx.reply('❌ *Tidak ada user premium yang terdaftar.*', {
      parse_mode: 'Markdown'
    });
  }
  
  let message = '⭐ *Daftar User Premium*\n\n';
  premiumUsers.forEach((user, index) => {
    message += `${index + 1}. \`${user}\`\n`;
  });
  
  await ctx.replyWithMarkdown(message);
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

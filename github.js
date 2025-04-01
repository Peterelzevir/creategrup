const { Telegraf, Markup, Scenes, session } = require('telegraf');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { Octokit } = require('@octokit/rest');
const puppeteer = require('puppeteer');
const crypto = require('crypto');

// Inisialisasi bot dengan token
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '7332933814:AAG9VvU6jri2PPMMrsyPwqi2L2Y670zruCg');

// List admin yang diizinkan menggunakan bot
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id)) : [5988451717]; // Default admin ID

// Simpan session login sementara (seharusnya pakai database untuk produksi)
const userSessions = {};

// Middleware untuk memeriksa apakah pengguna adalah admin
const adminMiddleware = (ctx, next) => {
  if (ADMIN_IDS.includes(ctx.from.id)) {
    return next();
  }
  return ctx.reply('❌ Lu siapa sih? Cuma admin yang bisa pake bot ini! 🔒');
};

// Tambahkan middleware admin ke bot
bot.use(adminMiddleware);

// Inisialisasi session untuk menyimpan data pengguna
bot.use(session());

// Scene untuk login GitHub
const loginGithubScene = new Scenes.WizardScene(
  'loginGithub',
  // Step 1: Minta username GitHub
  async (ctx) => {
    await ctx.reply('🔑 Login dulu ke GitHub!\n\nKasih username GitHub lu:', 
      Markup.inlineKeyboard([
        Markup.button.callback('❌ Batal', 'cancel')
      ])
    );
    ctx.wizard.state.sessionId = crypto.randomUUID();
    return ctx.wizard.next();
  },
  // Step 2: Minta password GitHub
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) {
      await ctx.reply('❌ Text doang bro, gak usah aneh-aneh!');
      return;
    }
    
    ctx.wizard.state.username = ctx.message.text;
    await ctx.reply(`👤 Username: *${ctx.wizard.state.username}*\n\nSekarang, kasih password GitHub lu (tenang, gak akan disimpan):`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        Markup.button.callback('❌ Batal', 'cancel')
      ])
    });
    return ctx.wizard.next();
  },
  // Step 3: Proses login
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) {
      await ctx.reply('❌ Text doang bro, gak usah aneh-aneh!');
      return;
    }
    
    const password = ctx.message.text;
    const loadingMsg = await ctx.reply('⏳ Sabar ya, lagi login ke GitHub...');
    
    try {
      // Lakukan login ke GitHub dengan puppeteer
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      
      const page = await browser.newPage();
      
      // Pergi ke halaman login GitHub
      await page.goto('https://github.com/login');
      
      // Isi form login
      await page.type('#login_field', ctx.wizard.state.username);
      await page.type('#password', password);
      
      // Klik tombol login
      await Promise.all([
        page.waitForNavigation(),
        page.click('input[type="submit"]')
      ]);
      
      // Periksa apakah login berhasil
      const isLoggedIn = await page.evaluate(() => {
        return document.querySelector('.avatar') !== null;
      });
      
      if (!isLoggedIn) {
        await browser.close();
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          null,
          '❌ Login gagal! Username atau password salah.'
        );
        return ctx.scene.leave();
      }
      
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        '✅ Login berhasil! Lagi ambil token akses...'
      );
      
      // Generate token akses
      await page.goto('https://github.com/settings/tokens/new');
      
      // Isi nama token
      await page.type('#oauth_access_description', 'TelegramRepoBot ' + new Date().toISOString());
      
      // Pilih scope repo
      await page.click('#scopes_repo');
      
      // Klik Generate token
      await Promise.all([
        page.waitForNavigation(),
        page.click('button.btn-primary')
      ]);
      
      // Ambil token yang dihasilkan
      const token = await page.evaluate(() => {
        return document.getElementById('new-oauth-token').innerText;
      });
      
      // Simpan token di session
      userSessions[ctx.wizard.state.sessionId] = {
        username: ctx.wizard.state.username,
        token: token,
        browser: browser
      };
      
      // Simpan session di context
      ctx.session.githubSessionId = ctx.wizard.state.sessionId;
      
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        '🔐 Login berhasil! Token akses udah dibuat otomatis.\n\nSekarang lu bisa bikin repo pake /createrepo atau upload file ZIP.'
      );
      
      return ctx.scene.leave();
    } catch (error) {
      console.error('Error login to GitHub:', error);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        `❌ Waduh, error nih bro: ${error.message}`
      );
      return ctx.scene.leave();
    }
  }
);

// Scene untuk membuat repository baru
const createRepoScene = new Scenes.WizardScene(
  'createRepo',
  // Step 1: Periksa apakah sudah login
  async (ctx) => {
    // Periksa apakah user sudah login GitHub
    if (!ctx.session.githubSessionId || !userSessions[ctx.session.githubSessionId]) {
      await ctx.reply('❌ Lu belum login! Login dulu pake /login');
      return ctx.scene.leave();
    }
    
    await ctx.reply('📝 Kasih nama repo yang mau lu bikin dong!', 
      Markup.inlineKeyboard([
        Markup.button.callback('❌ Batal', 'cancel')
      ])
    );
    return ctx.wizard.next();
  },
  // Step 2: Minta deskripsi repository
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) {
      await ctx.reply('❌ Text doang bro, gak usah aneh-aneh!');
      return;
    }
    
    ctx.wizard.state.repoName = ctx.message.text;
    await ctx.reply(`🔥 Oke, nama repo: *${ctx.wizard.state.repoName}*\n\nSekarang, kasih deskripsi repo lu:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        Markup.button.callback('❌ Batal', 'cancel')
      ])
    });
    return ctx.wizard.next();
  },
  // Step 3: Konfirmasi pembuatan repository
  async (ctx) => {
    if (!ctx.message || !ctx.message.text) {
      await ctx.reply('❌ Text doang bro, gak usah aneh-aneh!');
      return;
    }
    
    ctx.wizard.state.repoDescription = ctx.message.text;
    await ctx.reply(
      `🚀 Ready untuk bikin repo nih!\n\n*Nama:* ${ctx.wizard.state.repoName}\n*Deskripsi:* ${ctx.wizard.state.repoDescription}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Gas bikin!', 'confirm')],
          [Markup.button.callback('❌ Batal', 'cancel')]
        ])
      }
    );
    return ctx.wizard.next();
  },
  // Step 4: Proses pembuatan repository
  async (ctx) => {
    if (!ctx.update.callback_query || ctx.update.callback_query.data !== 'confirm') {
      return;
    }
    
    const loadingMsg = await ctx.reply('⏳ Sabar ya, lagi bikin repo...');
    
    try {
      // Ambil data GitHub dari session
      const sessionData = userSessions[ctx.session.githubSessionId];
      
      // Buat repository di GitHub
      const octokit = new Octokit({ auth: sessionData.token });
      const response = await octokit.repos.createForAuthenticatedUser({
        name: ctx.wizard.state.repoName,
        description: ctx.wizard.state.repoDescription,
        private: false,
        auto_init: true
      });
      
      // Update pesan loading dengan hasil
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        `✅ Repo berhasil dibuat!\n\n🔗 Link: ${response.data.html_url}\n\n🤙 Sekarang lu bisa kirim file ZIP untuk di-upload ke repo ini.`
      );
      
      // Simpan data repository ke session pengguna
      ctx.session.currentRepo = {
        name: ctx.wizard.state.repoName,
        url: response.data.html_url,
        owner: sessionData.username
      };
      
      // Keluar dari scene
      return ctx.scene.leave();
    } catch (error) {
      console.error('Error creating repository:', error);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        `❌ Waduh, error nih bro: ${error.message}`
      );
      return ctx.scene.leave();
    }
  }
);

// Scene untuk meng-upload file ZIP ke repository
const uploadZipScene = new Scenes.WizardScene(
  'uploadZip',
  // Step 1: Proses file ZIP
  async (ctx) => {
    // Periksa apakah user sudah login GitHub
    if (!ctx.session.githubSessionId || !userSessions[ctx.session.githubSessionId]) {
      await ctx.reply('❌ Lu belum login! Login dulu pake /login');
      return ctx.scene.leave();
    }
    
    if (!ctx.message || !ctx.message.document || !ctx.message.document.file_name.endsWith('.zip')) {
      await ctx.reply('❌ Woy, file ZIP dong! Yang bener ya.');
      return ctx.scene.leave();
    }
    
    const fileId = ctx.message.document.file_id;
    const fileName = ctx.message.document.file_name;
    
    // Jika tidak ada repository aktif, minta untuk membuat repo dulu
    if (!ctx.session.currentRepo) {
      await ctx.reply('❌ Lu belum bikin repo! Bikin dulu pake /createrepo');
      return ctx.scene.leave();
    }
    
    const loadingMsg = await ctx.reply('⏳ Lagi download file ZIP lu...');
    
    try {
      // Dapatkan link file dari Telegram
      const fileLink = await ctx.telegram.getFileLink(fileId);
      
      // Buat direktori temp jika belum ada
      const tempDir = path.join(__dirname, 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
      }
      
      // Buat direktori unik untuk file ini
      const fileDir = path.join(tempDir, `${Date.now()}`);
      fs.mkdirSync(fileDir);
      
      // Path untuk file ZIP
      const zipFilePath = path.join(fileDir, fileName);
      
      // Download file ZIP
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        '⏳ Downloading ZIP file... 10%'
      );
      
      // Download file dengan axios
      const response = await axios({
        method: 'GET',
        url: fileLink.href,
        responseType: 'arraybuffer'
      });
      
      // Simpan file ZIP
      fs.writeFileSync(zipFilePath, response.data);
      
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        '⏳ File downloaded! Lagi extract... 30%'
      );
      
      // Extract ZIP file
      const extractDir = path.join(fileDir, 'extracted');
      fs.mkdirSync(extractDir);
      
      const zip = new AdmZip(zipFilePath);
      zip.extractAllTo(extractDir, true);
      
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        '⏳ File dah di-extract! Lagi push ke GitHub... 60%'
      );
      
      // Ambil data GitHub dari session
      const sessionData = userSessions[ctx.session.githubSessionId];
      
      // Push ke GitHub
      const octokit = new Octokit({ auth: sessionData.token });
      
      // Dapatkan semua file dari direktori yang di-extract
      const uploadFiles = async (dir, baseDir = '') => {
        const files = fs.readdirSync(dir);
        
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stats = fs.statSync(filePath);
          
          if (stats.isDirectory()) {
            await uploadFiles(filePath, path.join(baseDir, file));
          } else {
            const content = fs.readFileSync(filePath);
            const relativePath = path.join(baseDir, file);
            
            try {
              // Upload file ke GitHub
              await octokit.repos.createOrUpdateFileContents({
                owner: sessionData.username,
                repo: ctx.session.currentRepo.name,
                path: relativePath,
                message: `Add ${relativePath} via Telegram Bot`,
                content: content.toString('base64')
              });
            } catch (error) {
              console.error(`Error uploading file ${relativePath}:`, error);
            }
          }
        }
      };
      
      await uploadFiles(extractDir);
      
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        '⏳ Hampir selesai... 90%'
      );
      
      // Cleanup temp files
      fs.rmSync(fileDir, { recursive: true, force: true });
      
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        `✅ Mantap! File lu udah di-upload ke repo!\n\n🔗 Cek di sini: ${ctx.session.currentRepo.url}`
      );
      
      return ctx.scene.leave();
    } catch (error) {
      console.error('Error uploading ZIP file:', error);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        null,
        `❌ Waduh, error nih bro: ${error.message}`
      );
      return ctx.scene.leave();
    }
  }
);

// Scene untuk logout
const logoutScene = new Scenes.WizardScene(
  'logout',
  // Step 1: Konfirmasi logout
  async (ctx) => {
    // Periksa apakah user sudah login GitHub
    if (!ctx.session.githubSessionId || !userSessions[ctx.session.githubSessionId]) {
      await ctx.reply('❌ Lu belum login kok mau logout?');
      return ctx.scene.leave();
    }
    
    await ctx.reply(
      '❓ Beneran mau logout dari GitHub?',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Ya, Logout', 'confirm')],
          [Markup.button.callback('❌ Gak jadi', 'cancel')]
        ])
      }
    );
    return ctx.wizard.next();
  },
  // Step 2: Proses logout
  async (ctx) => {
    if (!ctx.update.callback_query) return;
    
    if (ctx.update.callback_query.data === 'cancel') {
      await ctx.reply('👍 Oke, gak jadi logout.');
      return ctx.scene.leave();
    }
    
    if (ctx.update.callback_query.data === 'confirm') {
      const loadingMsg = await ctx.reply('⏳ Lagi proses logout...');
      
      try {
        // Logout dan revoke token
        const sessionData = userSessions[ctx.session.githubSessionId];
        
        // Close browser jika masih terbuka
        if (sessionData.browser) {
          await sessionData.browser.close();
        }
        
        // Revoke token dengan Octokit
        const octokit = new Octokit({ auth: sessionData.token });
        await octokit.auth({
          type: 'token',
          token: sessionData.token,
          tokenType: 'oauth'
        }).then(auth => {
          if (auth.token) {
            return octokit.request('DELETE /applications/{client_id}/grant', {
              client_id: 'Iv1.8a61f9b3a7aba766',
              access_token: auth.token
            });
          }
        }).catch(err => {
          console.error('Error revoking token:', err);
        });
        
        // Hapus session
        delete userSessions[ctx.session.githubSessionId];
        delete ctx.session.githubSessionId;
        delete ctx.session.currentRepo;
        
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          null,
          '✅ Logout berhasil! Token akses udah diapus.'
        );
        
        return ctx.scene.leave();
      } catch (error) {
        console.error('Error logging out:', error);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          null,
          `❌ Waduh, error nih bro: ${error.message}`
        );
        return ctx.scene.leave();
      }
    }
  }
);

// Handler untuk tombol cancel
loginGithubScene.action('cancel', async (ctx) => {
  await ctx.reply('❌ Oke, gak jadi login!');
  return ctx.scene.leave();
});

createRepoScene.action('cancel', async (ctx) => {
  await ctx.reply('❌ Oke, gak jadi bikin repo!');
  return ctx.scene.leave();
});

// Buat stage
const stage = new Scenes.Stage([loginGithubScene, createRepoScene, uploadZipScene, logoutScene]);
bot.use(stage.middleware());

// Command untuk mulai bot
bot.start((ctx) => {
  ctx.reply(
    `🚀 *Yo, selamat datang di RepoBot!*\n\nGw bot yang bisa bantu lu bikin repo di GitHub dan upload file ZIP ke sana.\n\nCommand yang bisa lu pake:\n/login - Login ke GitHub\n/createrepo - Bikin repo baru\n/logout - Logout dari GitHub\n/help - Bantuan`,
    { parse_mode: 'Markdown' }
  );
});

// Command untuk bantuan
bot.help((ctx) => {
  ctx.reply(
    `🤖 *RepoBot - Your GitHub Companion*\n\nCommand yang bisa lu pake:\n\n/login - Login ke GitHub\n/createrepo - Bikin repo baru di GitHub\n/logout - Logout dari GitHub\n\nSetelah bikin repo, lu bisa langsung kirim file ZIP untuk di-upload ke repo tersebut.`,
    { parse_mode: 'Markdown' }
  );
});

// Command untuk login GitHub
bot.command('login', (ctx) => {
  ctx.scene.enter('loginGithub');
});

// Command untuk membuat repository baru
bot.command('createrepo', (ctx) => {
  ctx.scene.enter('createRepo');
});

// Command untuk logout
bot.command('logout', (ctx) => {
  ctx.scene.enter('logout');
});

// Handler untuk file dokumen (ZIP)
bot.on('document', (ctx) => {
  if (ctx.message.document.file_name.endsWith('.zip')) {
    ctx.scene.enter('uploadZip');
  } else {
    ctx.reply('❌ Woy, file ZIP dong! Yang bener ya.');
  }
});

// Handler untuk pesan yang tidak dikenali
bot.on('text', (ctx) => {
  ctx.reply('🤔 Gak ngerti perintah lu. Coba /help untuk liat command yang bisa dipake.');
});

// Error handler
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply(`❌ Waduh, error nih bro: ${err.message}`);
});

// Clean up function untuk membersihkan resource saat shutdown
const cleanupResources = async () => {
  console.log('Cleaning up resources...');
  
  // Tutup semua browser yang masih terbuka
  for (const sessionId in userSessions) {
    if (userSessions[sessionId].browser) {
      try {
        await userSessions[sessionId].browser.close();
      } catch (error) {
        console.error(`Error closing browser for session ${sessionId}:`, error);
      }
    }
  }
  
  // Hapus direktori temp jika ada
  const tempDir = path.join(__dirname, 'temp');
  if (fs.existsSync(tempDir)) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.error('Error removing temp directory:', error);
    }
  }
};

// Start bot
bot.launch().then(() => {
  console.log('Bot is running!');
}).catch((err) => {
  console.error('Failed to start bot:', err);
});

// Graceful stop
process.once('SIGINT', async () => {
  await cleanupResources();
  bot.stop('SIGINT');
});
process.once('SIGTERM', async () => {
  await cleanupResources();
  bot.stop('SIGTERM');
});

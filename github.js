const { Telegraf, Markup, Scenes, session } = require('telegraf');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { Octokit } = require('@octokit/rest');
const config = require('./config');

// Inisialisasi bot dengan token dari config
const bot = new Telegraf(config.telegramToken);

// List admin yang diizinkan menggunakan bot
const ADMIN_IDS = config.adminIds; // array of admin user IDs

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

// Scene untuk membuat repository baru
const createRepoScene = new Scenes.WizardScene(
  'createRepo',
  // Step 1: Minta nama repository
  async (ctx) => {
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
      // Buat repository di GitHub
      const octokit = new Octokit({ auth: config.githubToken });
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
        owner: config.githubUsername
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

// Handler untuk tombol cancel
createRepoScene.action('cancel', async (ctx) => {
  await ctx.reply('❌ Oke, gak jadi bikin repo!');
  return ctx.scene.leave();
});

// Scene untuk meng-upload file ZIP ke repository
const uploadZipScene = new Scenes.WizardScene(
  'uploadZip',
  // Step 1: Proses file ZIP
  async (ctx) => {
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
      
      // Push ke GitHub
      const octokit = new Octokit({ auth: config.githubToken });
      
      // Dapatkan semua file dari direktori yang di-extract
      const uploadFiles = (dir, baseDir = '') => {
        const files = fs.readdirSync(dir);
        
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stats = fs.statSync(filePath);
          
          if (stats.isDirectory()) {
            uploadFiles(filePath, path.join(baseDir, file));
          } else {
            const content = fs.readFileSync(filePath);
            const relativePath = path.join(baseDir, file);
            
            // Upload file ke GitHub
            octokit.repos.createOrUpdateFileContents({
              owner: config.githubUsername,
              repo: ctx.session.currentRepo.name,
              path: relativePath,
              message: `Add ${relativePath} via Telegram Bot`,
              content: content.toString('base64')
            });
          }
        }
      };
      
      uploadFiles(extractDir);
      
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

// Buat stage
const stage = new Scenes.Stage([createRepoScene, uploadZipScene]);
bot.use(stage.middleware());

// Command untuk mulai bot
bot.start((ctx) => {
  ctx.reply(
    `🚀 *Yo, selamat datang di RepoBot!*\n\nGw bot yang bisa bantu lu bikin repo di GitHub dan upload file ZIP ke sana.\n\nCommand yang bisa lu pake:\n/createrepo - Bikin repo baru\n/help - Bantuan`,
    { parse_mode: 'Markdown' }
  );
});

// Command untuk bantuan
bot.help((ctx) => {
  ctx.reply(
    `🤖 *RepoBot - Your GitHub Companion*\n\nCommand yang bisa lu pake:\n\n/createrepo - Bikin repo baru di GitHub\n\nSetelah bikin repo, lu bisa langsung kirim file ZIP untuk di-upload ke repo tersebut.`,
    { parse_mode: 'Markdown' }
  );
});

// Command untuk membuat repository baru
bot.command('createrepo', (ctx) => {
  ctx.scene.enter('createRepo');
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

// Start bot
bot.launch().then(() => {
  console.log('Bot is running!');
}).catch((err) => {
  console.error('Failed to start bot:', err);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

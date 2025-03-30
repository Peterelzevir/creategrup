// hiyaok.js
const { default: makeWASocket, useMultiFileAuthState, makeInMemoryStore, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');

// Ensure crypto is available globally (fixes the baileys issue)
global.crypto = crypto;

// Create logs directory if it doesn't exist
if (!fs.existsSync('./logs')) {
  fs.mkdirSync('./logs');
}

// Create logs file with current date and time
const date = new Date();
const logFileName = `./logs/bot-${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}.log`;
fs.writeFileSync(logFileName, '');

// Store object to save chat history and other data
const store = makeInMemoryStore({ 
  logger: pino().child({ level: 'silent', stream: 'store' }) 
});
store.readFromFile('./baileys_store.json');
setInterval(() => {
  store.writeToFile('./baileys_store.json');
}, 10000);

// Function to create and manage WhatsApp connection
async function connectToWhatsApp() {
  // Authenticate using saved credentials or create new ones
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  
  // Simple logger without pino-pretty
  const logger = pino({ level: 'silent' });

  // Create WhatsApp socket connection
  const sock = makeWASocket({
    logger,
    printQRInTerminal: false, // We're using pairing code instead of QR
    auth: state,
    browser: ['WhatsApp Group Creator Bot', 'Chrome', '103.0.5060.114'],
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

  // Connect store to socket
  store.bind(sock.ev);

  // Handle connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    // If connection is open, we're connected
    if (connection === 'open') {
      console.log('\n\x1b[32m[System]\x1b[0m WhatsApp connection established!');
      console.log('\x1b[32m[System]\x1b[0m Bot is ready to use.');
      fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Connection established\n`);
    }
    
    // If connection closed, try to reconnect
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut
        : true;

      if (shouldReconnect) {
        console.log('\n\x1b[33m[System]\x1b[0m Connection closed, reconnecting...');
        fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Connection closed, reconnecting...\n`);
        connectToWhatsApp();
      } else {
        console.log('\n\x1b[31m[System]\x1b[0m Connection closed. You are logged out.');
        fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Connection closed. Logged out.\n`);
        process.exit(0);
      }
    }
    
    // If the connection is connecting, show status
    if (connection === 'connecting') {
      console.log('\n\x1b[33m[System]\x1b[0m Connecting to WhatsApp...');
    }

    // Handle pairing code if we're not authenticated yet
    if (!connection && !sock.authState.creds.registered && !qr) {
      // Request pairing code
      const phoneNumber = await askForPhoneNumber();
      const code = await sock.requestPairingCode(phoneNumber);
      console.log('\n\x1b[33m[System]\x1b[0m Your pairing code: \x1b[37m\x1b[1m' + code + '\x1b[0m');
      console.log('\x1b[33m[System]\x1b[0m Enter this code on your WhatsApp app to pair your device.');
      fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Pairing code requested for: ${phoneNumber}\n`);
    }
  });

  // Handle messages
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      // Get the message
      const msg = messages[0];
      if (!msg) return;
      
      // Skip if the message is a status or not from a chat
      if (msg.key.remoteJid === 'status@broadcast' || !msg.message) return;
      
      // Get sender ID, message content, and chat type
      const senderId = msg.key.remoteJid;
      const messageType = Object.keys(msg.message)[0];
      const isGroupChat = senderId.endsWith('@g.us');
      
      // Forward only if it's a text message
      if (messageType !== 'conversation' && messageType !== 'extendedTextMessage') return;
      
      // Get the text content
      let textMessage = messageType === 'conversation' 
        ? msg.message.conversation 
        : msg.message.extendedTextMessage.text;
      
      // Log the message
      console.log(`\n\x1b[36m[${new Date().toLocaleString()}]\x1b[0m Message from ${senderId}: ${textMessage}`);
      fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Message from ${senderId}: ${textMessage}\n`);
      
      // Process commands
      if (textMessage.startsWith('/')) {
        // Extract command and parameters
        const [command, ...params] = textMessage.trim().split(' ');
        
        // Handle creategroup command
        if (command.toLowerCase() === '/creategroup') {
          const fullParams = params.join(' ');
          
          // Parse parameters (using regex to handle the | separator properly)
          const paramMatches = fullParams.match(/([^|]+)(?:\|([^|]+))?(?:\|([^|]+))?(?:\|([^|]+))?(?:\|([^|]+))?(?:\|([^|]+))?/);
          
          if (!paramMatches) {
            await sock.sendMessage(senderId, { text: '❌ Invalid format. Use: /creategroup <adminNumber> | <GroupNameCounter> | <GroupCount> | [Timer (days)] | [GroupInfo (on/off)] | [SendMessage (on/off)]' });
            return;
          }
          
          // Extract parameters and trim whitespace
          const adminNumber = (paramMatches[1] || '').trim().replace(/\s+/g, '');
          const groupNamePattern = (paramMatches[2] || '').trim();
          const groupCount = parseInt((paramMatches[3] || '').trim()) || 1;
          const timerDays = parseInt((paramMatches[4] || '').trim()) || 0;
          const groupInfoEnabled = ((paramMatches[5] || '').trim().toLowerCase() === 'on');
          const sendMessageEnabled = ((paramMatches[6] || '').trim().toLowerCase() === 'on');
          
          // Validate admin number
          if (!adminNumber || !adminNumber.match(/^[0-9]+$/)) {
            await sock.sendMessage(senderId, { text: '❌ Invalid admin number. Please provide a valid number without + or country code (e.g., 628123456789)' });
            return;
          }
          
          // Validate group name
          if (!groupNamePattern) {
            await sock.sendMessage(senderId, { text: '❌ Invalid group name. Please provide a valid group name pattern.' });
            return;
          }
          
          // Check if group count is valid
          if (groupCount <= 0 || groupCount > 100) {
            await sock.sendMessage(senderId, { text: '❌ Invalid group count. Please provide a number between 1 and 100.' });
            return;
          }
          
          // Inform user that the process is starting
          await sock.sendMessage(senderId, { text: `✅ Creating ${groupCount} groups with admin ${adminNumber}...\n\nGroup Name Pattern: ${groupNamePattern}\nTimer: ${timerDays} days\nGroup Info: ${groupInfoEnabled ? 'ON' : 'OFF'}\nSend Message: ${sendMessageEnabled ? 'ON' : 'OFF'}\n\nPlease wait...` });
          
          // Create groups
          await createMultipleGroups(sock, senderId, adminNumber, groupNamePattern, groupCount, timerDays, groupInfoEnabled, sendMessageEnabled);
        }
      }
    } catch (error) {
      console.error('\x1b[31m[Error]\x1b[0m Error processing message:', error);
      fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Error processing message: ${error.message}\n`);
    }
  });

  return sock;
}

// Function to create multiple groups
async function createMultipleGroups(sock, senderId, adminNumber, groupNamePattern, groupCount, timerDays, groupInfoEnabled, sendMessageEnabled) {
  try {
    const successfulGroups = [];
    const failedGroups = [];
    
    // Format admin number to ensure it has @s.whatsapp.net
    const formattedAdminNumber = formatPhoneNumber(adminNumber);
    
    // Loop to create groups
    for (let i = 1; i <= groupCount; i++) {
      try {
        // Create group name with counter
        const groupName = groupNamePattern.replace(/\d+$/, (match) => {
          const num = parseInt(match);
          return (num + i - 1).toString();
        });
        
        // If no number pattern found, append the counter
        const finalGroupName = groupNamePattern.match(/\d+$/) ? groupName : `${groupNamePattern} ${i}`;
        
        // Send status update
        await sock.sendMessage(senderId, { text: `🔄 Creating group ${i}/${groupCount}: "${finalGroupName}"` });
        fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Creating group ${i}/${groupCount}: "${finalGroupName}"\n`);
        
        // Create the group with admin
        const group = await sock.groupCreate(finalGroupName, [formattedAdminNumber]);
        const groupId = group.id;
        const groupInviteUrl = group.url || 'No URL available';
        
        // Set group info if enabled
        if (groupInfoEnabled) {
          try {
            const info = `Group created by WhatsApp Group Creator Bot\nAdmin: ${adminNumber}\nCreated: ${new Date().toLocaleString()}\n${timerDays > 0 ? `Auto-delete in ${timerDays} days` : 'No auto-delete timer'}`;
            await sock.groupUpdateDescription(groupId, info);
          } catch (error) {
            console.error('\x1b[31m[Error]\x1b[0m Error setting group description:', error);
            fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Error setting group description for "${finalGroupName}": ${error.message}\n`);
          }
        }
        
        // Send welcome message if enabled
        if (sendMessageEnabled) {
          try {
            const welcomeMsg = `*Group Created Successfully*\n\n*Name:* ${finalGroupName}\n*Admin:* @${adminNumber.split('@')[0]}\n*Created:* ${new Date().toLocaleString()}\n${timerDays > 0 ? `\n_This group will be deleted after ${timerDays} days_` : ''}`;
            await sock.sendMessage(groupId, { 
              text: welcomeMsg,
              mentions: [formattedAdminNumber]
            });
          } catch (error) {
            console.error('\x1b[31m[Error]\x1b[0m Error sending welcome message:', error);
            fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Error sending welcome message to "${finalGroupName}": ${error.message}\n`);
          }
        }
        
        // Make user an admin
        try {
          await sock.groupParticipantsUpdate(groupId, [formattedAdminNumber], 'promote');
        } catch (error) {
          console.error('\x1b[31m[Error]\x1b[0m Error promoting admin:', error);
          fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Error promoting admin in "${finalGroupName}": ${error.message}\n`);
        }
        
        // Add a small delay to avoid rate limiting
        await delay(2000);
        
        // Leave the group
        try {
          await sock.groupLeave(groupId);
        } catch (error) {
          console.error('\x1b[31m[Error]\x1b[0m Error leaving group:', error);
          fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Error leaving "${finalGroupName}": ${error.message}\n`);
        }
        
        // Add to successful groups
        successfulGroups.push({
          name: finalGroupName,
          id: groupId,
          url: groupInviteUrl
        });
        
        // Log success
        console.log(`\x1b[32m[Success]\x1b[0m Created group: ${finalGroupName}`);
        fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Successfully created group: "${finalGroupName}"\n`);
        
        // Add another delay between group creations
        await delay(3000);
      } catch (error) {
        console.error(`\x1b[31m[Error]\x1b[0m Failed to create group ${i}:`, error);
        fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Failed to create group ${i}: ${error.message}\n`);
        failedGroups.push(i);
        
        // Add a longer delay after an error
        await delay(5000);
      }
    }
    
    // Send summary
    let summaryText = `✅ *Group Creation Summary*\n\n`;
    summaryText += `Total Requested: ${groupCount}\n`;
    summaryText += `Successfully Created: ${successfulGroups.length}\n`;
    summaryText += `Failed: ${failedGroups.length}\n\n`;
    
    if (successfulGroups.length > 0) {
      summaryText += `*Successfully Created Groups:*\n`;
      successfulGroups.forEach((group, index) => {
        summaryText += `${index + 1}. ${group.name}\n`;
        if (group.url && group.url !== 'No URL available') {
          summaryText += `   Link: ${group.url}\n`;
        }
      });
    }
    
    if (failedGroups.length > 0) {
      summaryText += `\n*Failed Groups:* ${failedGroups.join(', ')}`;
    }
    
    await sock.sendMessage(senderId, { text: summaryText });
    fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Group creation summary: ${successfulGroups.length} created, ${failedGroups.length} failed\n`);
  } catch (error) {
    console.error('\x1b[31m[Error]\x1b[0m Error in createMultipleGroups:', error);
    fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Error in createMultipleGroups: ${error.message}\n`);
    await sock.sendMessage(senderId, { text: `❌ Error creating groups: ${error.message}` });
  }
}

// Function to ask for phone number
function askForPhoneNumber() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('\n\x1b[33m[System]\x1b[0m Enter your phone number with country code (e.g., 628123456789): ', (answer) => {
      rl.close();
      // Remove any non-digit characters
      const phoneNumber = answer.replace(/[^0-9]/g, '');
      resolve(phoneNumber);
    });
  });
}

// Function to format phone number
function formatPhoneNumber(phoneNumber) {
  // Remove any non-digit characters and ensure it doesn't have @s.whatsapp.net already
  const cleanNumber = phoneNumber.replace(/[^0-9]/g, '').replace(/@s\.whatsapp\.net$/, '');
  return `${cleanNumber}@s.whatsapp.net`;
}

// Simple delay function
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Start the bot
console.log('\x1b[35m╔════════════════════════════════════════╗');
console.log('║       WhatsApp Group Creator Bot       ║');
console.log('╚════════════════════════════════════════╝\x1b[0m');
console.log('\n\x1b[36m[Info]\x1b[0m Starting bot...');
console.log('\x1b[36m[Info]\x1b[0m Bot will use pairing code method to connect');

// Make sure auth_info directory exists
if (!fs.existsSync('./auth_info')) {
  fs.mkdirSync('./auth_info');
}

fs.appendFileSync(logFileName, `[${new Date().toLocaleString()}] Bot started\n`);
connectToWhatsApp();

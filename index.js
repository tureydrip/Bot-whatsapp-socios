const TelegramBot = require('node-telegram-bot-api');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, set, onValue } = require('firebase/database');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ==========================================
// CONFIGURACIÓN PRINCIPAL
// ==========================================
const token = '8891784070:AAGmrY8It4BNt6FfMEuY8fJg-HBJRIn0ZL8';
const bot = new TelegramBot(token, { polling: true });
const SUPER_ADMIN_ID = 7710633235; 

const firebaseConfig = {
    apiKey: "AIzaSyDoIGXJQ2NEgeUXCDHLSFc7YDA6EtDYUSg",
    authDomain: "socios666-7056e.firebaseapp.com",
    projectId: "socios666-7056e",
    storageBucket: "socios666-7056e.firebasestorage.app",
    messagingSenderId: "328433251001",
    appId: "1:328433251001:web:141a5bf56127e323afe168",
    databaseURL: "https://socios666-7056e-default-rtdb.firebaseio.com"
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Estado para la interacción de Telegram
const userStates = {};
let waSock = null;

// ==========================================
// SISTEMA DE RESTAURACIÓN DE SESIÓN (FIREBASE)
// ==========================================
const sessionDir = './auth_info_baileys';
const credsPath = path.join(sessionDir, 'creds.json');

async function restaurarSesionFirebase() {
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    if (!fs.existsSync(credsPath)) {
        console.log('[SISTEMA] Verificando respaldo de sesión en Firebase...');
        const snap = await get(ref(db, 'whatsapp_control/backup_session'));
        if (snap.exists()) {
            fs.writeFileSync(credsPath, JSON.stringify(snap.val()));
            console.log('[SISTEMA] Sesión restaurada desde Firebase exitosamente.');
        } else {
            console.log('[SISTEMA] No se encontró respaldo. Se requerirá vinculación (Pairing Code).');
        }
    }
}

// ==========================================
// MÓDULO DE WHATSAPP BOT (BAILEYS)
// ==========================================
async function iniciarWhatsApp() {
    // 1. Intentar restaurar desde Firebase antes de iniciar
    await restaurarSesionFirebase();

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    waSock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), // Evita saturar los logs de Railway
        printQRInTerminal: false,
        auth: state,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    // 2. Guardar sesión y sincronizar automáticamente con Firebase
    waSock.ev.on('creds.update', async () => {
        await saveCreds();
        if (fs.existsSync(credsPath)) {
            try {
                const rawData = fs.readFileSync(credsPath, 'utf8');
                const credsObj = JSON.parse(rawData);
                await set(ref(db, 'whatsapp_control/backup_session'), credsObj);
            } catch(e) {
                console.error('[ERROR] Fallo al respaldar sesión en Firebase:', e.message);
            }
        }
    });

    // 3. Manejo de conexión
    waSock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('WhatsApp: Conexión cerrada, reconectando...', shouldReconnect);
            if (shouldReconnect) iniciarWhatsApp();
        } else if (connection === 'open') {
            console.log('WhatsApp: Conectado exitosamente y blindado.');
        }
    });
}

// ==========================================
// SISTEMA DE VINCULACIÓN VÍA WEB (FIREBASE)
// ==========================================
onValue(ref(db, 'whatsapp_control/command'), async (snapshot) => {
    const cmd = snapshot.val();
    if (cmd && cmd.action === 'request_code') {
        try {
            if (waSock && waSock.authState.creds.registered) {
                await set(ref(db, 'whatsapp_control/code'), { code: 'EL BOT YA ESTÁ VINCULADO', timestamp: Date.now() });
                return;
            }
            
            console.log(`[SISTEMA] Solicitando código WA para la web: ${cmd.number}`);
            const code = await waSock.requestPairingCode(cmd.number);
            
            await set(ref(db, 'whatsapp_control/code'), { code: code, timestamp: Date.now() });
            await set(ref(db, 'whatsapp_control/command'), null);
            
        } catch (error) {
            console.error('Error generando código WA:', error.message);
            await set(ref(db, 'whatsapp_control/code'), { code: 'ERROR: ' + error.message, timestamp: Date.now() });
        }
    }
});

// ==========================================
// PANEL DE VINCULACIÓN VÍA TELEGRAM
// ==========================================
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const tgId = msg.from.id;

    if (tgId !== SUPER_ADMIN_ID) return;
    userStates[chatId] = null; 

    const kb = {
        inline_keyboard: [
            [{ text: '[ Vincular WhatsApp por Telegram ]', callback_data: 'walinkadmin_menu' }]
        ]
    };

    bot.sendMessage(chatId, 'Panel de Control - Vinculación de Sesión', { reply_markup: kb });
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const tgId = query.from.id;
    const data = query.data;

    bot.answerCallbackQuery(query.id);

    if (tgId !== SUPER_ADMIN_ID) return;

    if (data === 'walinkadmin_menu') {
        const kb = {
            inline_keyboard: [
                [{text: 'Colombia (+57)', callback_data: 'walinkadmin|57'}, {text: 'México (+52)', callback_data: 'walinkadmin|52'}],
                [{text: 'Otro País (Escribir código)', callback_data: 'walinkadmin|otro'}]
            ]
        };
        return bot.editMessageText('VINCULAR BOT A WHATSAPP\n\nSeleccione el país del número destino que alojará el bot:', {chat_id: chatId, message_id: query.message.message_id, reply_markup: kb});
    }

    if (data.startsWith('walinkadmin|')) {
        const codPais = data.split('|')[1];
        if (codPais === 'otro') {
            userStates[chatId] = { step: 'ADMIN_WA_CUSTOM_COUNTRY', data: {} };
            return bot.editMessageText('Escriba el Código de País del Bot (solo números, ej: 51):', {chat_id: chatId, message_id: query.message.message_id});
        } else {
            userStates[chatId] = { step: 'ADMIN_WA_NUMBER', data: { countryCode: codPais } };
            return bot.editMessageText(`País seleccionado (+${codPais}).\n\nEscriba el número del Bot de WhatsApp (sin el código de país):`, {chat_id: chatId, message_id: query.message.message_id});
        }
    }
});

bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/start')) return;

    const chatId = msg.chat.id;
    const tgId = msg.from.id;
    const text = msg.text || '';

    if (tgId !== SUPER_ADMIN_ID) return;
    if (!text) return;

    if (userStates[chatId]) {
        const state = userStates[chatId];

        if (state.step === 'ADMIN_WA_CUSTOM_COUNTRY') {
            const code = text.replace('+', '').trim();
            if (isNaN(code)) return bot.sendMessage(chatId, 'Error: Escriba solo números (Ej: 51)');
            state.data.countryCode = code;
            state.step = 'ADMIN_WA_NUMBER';
            return bot.sendMessage(chatId, `Código +${code} guardado.\n\nEscriba el número que se convertirá en el Bot de WhatsApp sin el código de país:`);
        }

        if (state.step === 'ADMIN_WA_NUMBER') {
            const num = text.trim();
            if (isNaN(num)) return bot.sendMessage(chatId, 'Error: Escriba solo números.');
            const fullNumber = `${state.data.countryCode}${num}`;

            bot.sendMessage(chatId, `Solicitando Código a WhatsApp para el número +${fullNumber}... Por favor espere.`);

            try {
                if (waSock && waSock.authState.creds.registered) {
                    userStates[chatId] = null;
                    return bot.sendMessage(chatId, 'El bot de WhatsApp ya se encuentra registrado. Cierre sesión primero desde la app de WhatsApp si desea cambiar de número.');
                }
                
                // Pequeño delay para asegurar que el socket está listo
                setTimeout(async () => {
                    try {
                        const code = await waSock.requestPairingCode(fullNumber);
                        bot.sendMessage(chatId, `Código de vinculación para WhatsApp:\n\n\`${code}\`\n\nIngrese este código en "Dispositivos Vinculados" > "Vincular con el número de teléfono" en su WhatsApp destino.`, { parse_mode: 'Markdown' });
                    } catch(err) {
                        bot.sendMessage(chatId, 'Error al solicitar código: ' + err.message);
                    }
                }, 3000);
            } catch (error) {
                bot.sendMessage(chatId, 'Error al solicitar código: ' + error.message);
            }
            userStates[chatId] = null;
            return;
        }
    }
});

// Arrancar el socket de WhatsApp
iniciarWhatsApp();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('Bot inicializado y esperando instrucciones...');

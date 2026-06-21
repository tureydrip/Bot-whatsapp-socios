const TelegramBot = require('node-telegram-bot-api');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, set, update, push, remove, onValue } = require('firebase/database');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ==========================================
// CONFIGURACIÓN PRINCIPAL
// ==========================================
const token = '8891784070:AAGmrY8It4BNt6FfMEuY8fJg-HBJRIn0ZL8'; // Token de tu panel admin en TG
const bot = new TelegramBot(token, { polling: true });
const SUPER_ADMIN_TG_ID = 7710633235; // Tu ID para vincular en Telegram
const SUPER_ADMIN_WA = '573142369516'; // Tu WhatsApp para el menú admin en WA

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

// Estados para interacción
const tgAdminStates = {}; // Para el panel de vinculación en TG
const waStates = {}; // Para la navegación con números en WA
let waSock = null;

// ==========================================
// 1. SISTEMA DE RESTAURACIÓN (CÓDIGO 1)
// ==========================================
const sessionDir = './auth_info_baileys';
const credsPath = path.join(sessionDir, 'creds.json');

async function restaurarSesionFirebase() {
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    
    if (!fs.existsSync(credsPath)) {
        console.log('[SISTEMA] Verificando respaldo de sesión en Firebase...');
        const snap = await get(ref(db, 'whatsapp_control/backup_session'));
        if (snap.exists()) {
            fs.writeFileSync(credsPath, JSON.stringify(snap.val()));
            console.log('[SISTEMA] Sesión restaurada desde Firebase exitosamente.');
        } else {
            console.log('[SISTEMA] No se encontró respaldo. Usa Telegram para vincular.');
        }
    }
}

// ==========================================
// 2. PANEL DE VINCULACIÓN VÍA TELEGRAM (CÓDIGO 1)
// ==========================================
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    if (msg.from.id !== SUPER_ADMIN_TG_ID) return;
    tgAdminStates[chatId] = null; 

    const kb = {
        inline_keyboard: [[{ text: '[ Vincular WhatsApp por Telegram ]', callback_data: 'walinkadmin_menu' }]]
    };
    bot.sendMessage(chatId, 'Panel de Control - Vinculación de Sesión SociosXit', { reply_markup: kb });
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    if (query.from.id !== SUPER_ADMIN_TG_ID) return;
    const data = query.data;

    bot.answerCallbackQuery(query.id);

    if (data === 'walinkadmin_menu') {
        const kb = {
            inline_keyboard: [
                [{text: 'Colombia (+57)', callback_data: 'walinkadmin|57'}, {text: 'México (+52)', callback_data: 'walinkadmin|52'}],
                [{text: 'Otro País', callback_data: 'walinkadmin|otro'}]
            ]
        };
        return bot.editMessageText('VINCULAR BOT A WHATSAPP\nSeleccione país:', {chat_id: chatId, message_id: query.message.message_id, reply_markup: kb});
    }

    if (data.startsWith('walinkadmin|')) {
        const codPais = data.split('|')[1];
        if (codPais === 'otro') {
            tgAdminStates[chatId] = { step: 'ADMIN_WA_CUSTOM_COUNTRY', data: {} };
            return bot.editMessageText('Escriba el Código de País (ej: 51):', {chat_id: chatId, message_id: query.message.message_id});
        } else {
            tgAdminStates[chatId] = { step: 'ADMIN_WA_NUMBER', data: { countryCode: codPais } };
            return bot.editMessageText(`País (+${codPais}).\nEscriba el número del Bot de WhatsApp (sin el código):`, {chat_id: chatId, message_id: query.message.message_id});
        }
    }
});

bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/start')) return;
    const chatId = msg.chat.id;
    if (msg.from.id !== SUPER_ADMIN_TG_ID || !msg.text || !tgAdminStates[chatId]) return;

    const state = tgAdminStates[chatId];
    const text = msg.text.trim();

    if (state.step === 'ADMIN_WA_CUSTOM_COUNTRY') {
        state.data.countryCode = text.replace('+', '');
        state.step = 'ADMIN_WA_NUMBER';
        return bot.sendMessage(chatId, `Código +${state.data.countryCode} guardado.\nEscriba el número:`);
    }

    if (state.step === 'ADMIN_WA_NUMBER') {
        const fullNumber = `${state.data.countryCode}${text}`;
        bot.sendMessage(chatId, `Solicitando código para +${fullNumber}...`);

        try {
            if (waSock && waSock.authState.creds.registered) {
                tgAdminStates[chatId] = null;
                return bot.sendMessage(chatId, 'El bot ya está registrado. Cierre sesión primero.');
            }
            setTimeout(async () => {
                try {
                    const code = await waSock.requestPairingCode(fullNumber);
                    bot.sendMessage(chatId, `Código de vinculación:\n\n\`${code}\``, { parse_mode: 'Markdown' });
                } catch(err) { bot.sendMessage(chatId, 'Error: ' + err.message); }
            }, 3000);
        } catch (error) { bot.sendMessage(chatId, 'Error: ' + error.message); }
        tgAdminStates[chatId] = null;
    }
});

// Peticiones desde la web (Código 1)
onValue(ref(db, 'whatsapp_control/command'), async (snapshot) => {
    const cmd = snapshot.val();
    if (cmd && cmd.action === 'request_code') {
        try {
            if (waSock && waSock.authState.creds.registered) {
                await set(ref(db, 'whatsapp_control/code'), { code: 'YA VINCULADO', timestamp: Date.now() });
                return;
            }
            const code = await waSock.requestPairingCode(cmd.number);
            await set(ref(db, 'whatsapp_control/code'), { code: code, timestamp: Date.now() });
            await set(ref(db, 'whatsapp_control/command'), null);
        } catch (error) {
            await set(ref(db, 'whatsapp_control/code'), { code: 'ERROR', timestamp: Date.now() });
        }
    }
});


// ==========================================
// 3. MÓDULO WHATSAPP (NÚMEROS Y AUTH WEB)
// ==========================================
async function iniciarWhatsApp() {
    await restaurarSesionFirebase();

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    waSock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    waSock.ev.on('creds.update', async () => {
        await saveCreds();
        if (fs.existsSync(credsPath)) {
            const rawData = fs.readFileSync(credsPath, 'utf8');
            await set(ref(db, 'whatsapp_control/backup_session'), JSON.parse(rawData));
        }
    });

    waSock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) iniciarWhatsApp();
        } else if (connection === 'open') {
            console.log('WhatsApp: Conectado y blindado.');
        }
    });

    waSock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const numero = sender.split('@')[0];
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const t = text.trim().toLowerCase();

        // ---------------------------------------------------------
        // SISTEMA DE AUTENTICACIÓN (Lee de telegram_auth en la web)
        // ---------------------------------------------------------
        // El usuario pone su número de WA en la web en el campo del ID.
        const authSnap = await get(ref(db, `telegram_auth/${numero}`));
        
        if (!authSnap.exists()) {
            // Ignora a los que no han puesto su número de WhatsApp en la web
            return;
        }

        const webUid = authSnap.val();
        const userSnap = await get(ref(db, `users/${webUid}`));
        if (!userSnap.exists()) return;
        const webUser = userSnap.val();

        const isAdmin = numero === SUPER_ADMIN_WA;

        // CANCELAR ACCIÓN GLOBAL
        if (t === '00' || t === 'cancelar') {
            waStates[numero] = null;
            return enviarMensajeWA(numero, '✅ *Acción cancelada.*\nEscribe cualquier cosa para volver al menú principal.');
        }

        // MOSTRAR MENÚ PRINCIPAL
        if (!waStates[numero]) {
            let menu = `🌌 *SOCIOSXIT - MENÚ PRINCIPAL*\nBienvenido, *${webUser.username}*\n\nResponde con el *número* de la opción:\n\n`;
            menu += `*1.* 🛒 Tienda\n`;
            menu += `*2.* 👤 Mi Perfil\n`;
            menu += `*3.* 💳 Recargas\n`;
            menu += `*4.* 🔄 Resetear Key\n`;
            menu += `*5.* 🔄 Solicitar Reembolso\n`;
            
            if (isAdmin) menu += `\n*0.* ⚙️ Panel Administrador`;
            menu += `\n\n_Escribe *00* para cancelar en cualquier momento._`;

            waStates[numero] = { step: 'MAIN_MENU', webUid: webUid, webUser: webUser };
            return enviarMensajeWA(numero, menu);
        }

        const state = waStates[numero];

        // ---------------------------------------------------------
        // MÁQUINA DE ESTADOS NUMÉRICA
        // ---------------------------------------------------------
        if (state.step === 'MAIN_MENU') {
            
            // --- 1. TIENDA ---
            if (t === '1') {
                const pSnap = await get(ref(db, 'products'));
                let kbText = `🛒 *TIENDA SOCIOSXIT*\n\nResponde con el *NÚMERO* del producto:\n\n`;
                let pList = [];
                let i = 1;
                
                if (pSnap.exists()) {
                    pSnap.forEach(c => {
                        const p = c.val();
                        if (!p.durations && p.price !== undefined) {
                            p.durations = { 'legacy_var': { duration: p.duration||'Única', price: p.price, keys: p.keys||{} } };
                        }
                        kbText += `*${i}.* ⚡️ ${p.name}\n`;
                        pList.push({ id: c.key, name: p.name, durations: p.durations });
                        i++;
                    });
                }

                if (pList.length === 0) return enviarMensajeWA(numero, `❌ La tienda está vacía.`);
                waStates[numero] = { step: 'SHOP_SELECT_PROD', pList };
                return enviarMensajeWA(numero, kbText);
            }

            // --- 2. PERFIL ---
            if (t === '2') {
                waStates[numero] = null;
                const saldoUSD = parseFloat(webUser.balance || 0).toFixed(2);
                return enviarMensajeWA(numero, `👤 *PERFIL SOCIOSXIT*\n\n*Usuario:* ${webUser.username}\n💰 *Saldo:* $${saldoUSD} USD\n📱 *Número WA:* ${numero}`);
            }

            // --- 0. PANEL ADMIN ---
            if (t === '0' && isAdmin) {
                let adminMenu = `⚙️ *PANEL ADMINISTRADOR*\n\n`;
                adminMenu += `*11.* 📢 Enviar Mensaje Global (WhatsApp)\n`;
                adminMenu += `*12.* 💰 Añadir Saldo a Usuario\n`;
                
                waStates[numero] = { step: 'ADMIN_MENU' };
                return enviarMensajeWA(numero, adminMenu);
            }
            
            return enviarMensajeWA(numero, '❌ Opción inválida. Usa los números del menú o escribe *00* para reiniciar.');
        }

        // ==============================
        // FLUJOS SECUNDARIOS (TIENDA)
        // ==============================
        if (state.step === 'SHOP_SELECT_PROD') {
            const idx = parseInt(t) - 1;
            if (isNaN(idx) || idx < 0 || idx >= state.pList.length) return enviarMensajeWA(numero, `❌ Opción inválida.`);
            
            const prod = state.pList[idx];
            let dText = `📦 *${prod.name}*\n\nSelecciona la duración respondiendo con su *NÚMERO*:\n\n`;
            let dList = []; let dIdx = 1;
            
            Object.keys(prod.durations).forEach(dId => {
                const dur = prod.durations[dId];
                const stock = dur.keys ? Object.keys(dur.keys).length : 0;
                if (stock > 0) {
                    dText += `*${dIdx}.* ⏱️ ${dur.duration} - *$${dur.price} USD* _(${stock} disp)_\n`;
                    dList.push({ dId, ...dur });
                    dIdx++;
                }
            });
            
            if (dList.length === 0) {
                waStates[numero] = null;
                return enviarMensajeWA(numero, `❌ Variantes agotadas para este producto.`);
            }
            
            waStates[numero] = { step: 'SHOP_SELECT_DUR', prodId: prod.id, dList, prodName: prod.name, webUid: state.webUid };
            return enviarMensajeWA(numero, dText);
        }

        if (state.step === 'SHOP_SELECT_DUR') {
            const idx = parseInt(t) - 1;
            if (isNaN(idx) || idx < 0 || idx >= state.dList.length) return enviarMensajeWA(numero, `❌ Opción inválida.`);
            
            const dur = state.dList[idx];
            waStates[numero] = { step: 'SHOP_CONFIRM', prodId: state.prodId, durId: dur.dId, durInfo: dur, prodName: state.prodName, webUid: state.webUid };
            return enviarMensajeWA(numero, `⚠️ *CONFIRMAR COMPRA*\n\n🛍️ *Producto:* ${state.prodName} (${dur.duration})\n💵 *Precio:* $${dur.price} USD\n\n👉 Escribe *1* para COMPRAR\n👉 Escribe *00* para CANCELAR`);
        }

        if (state.step === 'SHOP_CONFIRM') {
            if (t === '1') {
                const { prodId, durId, durInfo, prodName, webUid } = state;
                const fPrice = durInfo.price;
                const cSnap = await get(ref(db, `users/${webUid}/balance`));
                let cB = parseFloat(cSnap.val() || 0);
                
                if (cB < fPrice) {
                     waStates[numero] = null;
                     return enviarMensajeWA(numero, `❌ *Saldo insuficiente.*\nTienes $${cB.toFixed(2)} USD y requieres $${fPrice.toFixed(2)} USD.`);
                }

                const pSnapLive = await get(ref(db, `products/${prodId}`));
                const prLive = pSnapLive.val();
                let realDur = (durId === 'legacy_var') ? { keys: prLive.keys } : prLive.durations[durId];

                if (realDur && realDur.keys && Object.keys(realDur.keys).length > 0) {
                    const kId = Object.keys(realDur.keys)[0];
                    const kD = realDur.keys[kId];
                    let kP = (durId === 'legacy_var') ? `products/${prodId}/keys/${kId}` : `products/${prodId}/durations/${durId}/keys/${kId}`;

                    const u = { [kP]: null, [`users/${webUid}/balance`]: cB - fPrice };
                    u[`users/${webUid}/history/${push(ref(db)).key}`] = { product: `${prodName} - ${durInfo.duration}`, key: kD, price: fPrice, date: Date.now() };

                    await update(ref(db), u);
                    enviarMensajeWA(numero, `✅ *¡COMPRA EXITOSA!*\n\n📦 *Producto:* ${prodName}\n⏱️ *Duración:* ${durInfo.duration}\n\n🔑 *Tu Key es:*\n${kD}`);
                } else {
                    enviarMensajeWA(numero, `❌ El producto se agotó justo en este momento.`);
                }
                waStates[numero] = null;
                return;
            }
            return enviarMensajeWA(numero, `❌ Responde 1 para confirmar o 00 para cancelar.`);
        }
    });
}

// ==========================================
// 4. COLA ANTI-BAN WA (INTACTO)
// ==========================================
const waQueue = [];
let isProcessingWaQueue = false;

async function processWaQueue() {
    if (isProcessingWaQueue || waQueue.length === 0) return;
    isProcessingWaQueue = true;

    while (waQueue.length > 0) {
        const { numero, mensaje, delayAfter } = waQueue.shift();
        if (waSock && waSock.authState.creds.registered) {
            try {
                const jid = `${numero}@s.whatsapp.net`;
                await waSock.sendPresenceUpdate('composing', jid);
                const typingMs = Math.min(Math.max(mensaje.length * 20, 1500), 4000);
                await new Promise(resolve => setTimeout(resolve, typingMs));
                await waSock.sendPresenceUpdate('paused', jid);
                await waSock.sendMessage(jid, { text: mensaje });
            } catch (error) { console.error('Error WA:', error.message); }
        }
        if (waQueue.length > 0) await new Promise(resolve => setTimeout(resolve, delayAfter));
    }
    isProcessingWaQueue = false;
}

function enviarMensajeWA(numero, mensaje, isMasivo = false) {
    const delay = isMasivo ? 60000 : 3000;
    waQueue.push({ numero, mensaje, delayAfter: delay });
    processWaQueue();
}

// Iniciar procesos
iniciarWhatsApp();
console.log('Bot iniciado. Esperando conexión a WhatsApp y peticiones de Telegram...');


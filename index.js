const TelegramBot = require('node-telegram-bot-api');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get, set, update, push, onValue, remove } = require('firebase/database');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ==========================================
// CONFIGURACIÓN PRINCIPAL
// ==========================================
const token = '8891784070:AAGmrY8It4BNt6FfMEuY8fJg-HBJRIn0ZL8';
const bot = new TelegramBot(token, { polling: true });
const SUPER_ADMIN_ID = 7710633235; // Admin de Telegram
const SUPER_ADMIN_WA = ['573142369516', '99983063805960']; 


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

// Estados para la interacción
const userStates = {}; // Telegram (Panel vinculación)
const waStates = {};   // WhatsApp (Menús numéricos)
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
        logger: pino({ level: 'silent' }), // Evita saturar los logs
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

    // ==========================================
    // 4. MOTOR NUMÉRICO DE WHATSAPP (SOCIOSXIT)
    // ==========================================
    waSock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        
        // Ignorar mensajes que vengan de grupos
        if (sender.includes('@g.us')) return;

        // LA SOLUCIÓN: Limpiamos el número de cualquier ID de dispositivo que WhatsApp agregue internamente (ej: :2)
        const numero = sender.split('@')[0].split(':')[0];
        
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const t = text.trim().toLowerCase();

        console.log(`[WHATSAPP] Mensaje recibido -> De: ${numero} | Texto: ${text}`);

        // ---------------------------------------------------------
        // SISTEMA DE AUTENTICACIÓN Y BYPASS ADMIN
        // ---------------------------------------------------------
        const isAdmin = SUPER_ADMIN_WA.includes(numero);

        let webUid = null;
        let webUser = null;

        if (isAdmin) {
            // Intenta buscar el perfil del admin en la web, si no existe, le crea uno maestro en memoria
            const authSnap = await get(ref(db, `telegram_auth/${numero}`));
            if (authSnap.exists()) {
                webUid = authSnap.val();
                const userSnap = await get(ref(db, `users/${webUid}`));
                if (userSnap.exists()) webUser = userSnap.val();
            }
            if (!webUser) {
                webUid = 'admin_master';
                webUser = { username: 'Creador SebasXit', balance: 999999 };
            }
        } else {
            // Usuario normal: Verificación estricta en la web
            const authSnap = await get(ref(db, `telegram_auth/${numero}`));
            if (!authSnap.exists()) {
                console.log(`[BLOQUEO] Usuario ${numero} ignorado (No está registrado en la web)`);
                return; 
            }
            
            webUid = authSnap.val();
            const userSnap = await get(ref(db, `users/${webUid}`));
            if (!userSnap.exists()) return;
            webUser = userSnap.val();
        }

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
        // NAVEGACIÓN PRINCIPAL
        // ---------------------------------------------------------
        if (state.step === 'MAIN_MENU') {
            
            // --- 1. TIENDA ---
            if (t === '1') {
                const pSnap = await get(ref(db, 'products'));
                let kbText = `🛒 *TIENDA SOCIOSXIT*\n\nResponde con el *NÚMERO* del producto:\n\n`;
                let pList = []; let i = 1;
                
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

        // ---------------------------------------------------------
        // FLUJOS SECUNDARIOS (TIENDA Y COMPRA)
        // ---------------------------------------------------------
        if (state.step === 'SHOP_SELECT_PROD') {
            const idx = parseInt(t) - 1;
            if (isNaN(idx) || idx < 0 || idx >= state.pList.length) return enviarMensajeWA(numero, `❌ Opción inválida.`);
            
            const prod = state.pList[idx];
            let dText = `📦 *${prod.name}*\n\nSelecciona la duración respondiendo con su *NÚMERO*:\n\n`;
            let dList = []; let dIdx = 1;
            
            Object.keys(prod.durations).forEach(dId => {
                const dur = prod.durations[dId];
                const stock = dur.keys ? Object.keys(dur.keys).length : 0;
                if (stock > 0 || isAdmin) { 
                    const txtStock = stock > 0 ? `(${stock} disp)` : `(AGOTADO)`;
                    dText += `*${dIdx}.* ⏱️ ${dur.duration} - *$${dur.price} USD* _${txtStock}_\n`;
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
                
                let cB = 999999;
                if (!isAdmin) {
                    const cSnap = await get(ref(db, `users/${webUid}/balance`));
                    cB = parseFloat(cSnap.val() || 0);
                }
                
                if (cB < fPrice) {
                     waStates[numero] = null;
                     return enviarMensajeWA(numero, `❌ *Saldo insuficiente.*\nTienes $${cB.toFixed(2)} USD y requieres $${fPrice.toFixed(2)} USD.`);
                }

                const pSnapLive = await get(ref(db, `products/${prodId}`));
                if (!pSnapLive.exists()) return enviarMensajeWA(numero, `❌ El producto ya no existe.`);
                const prLive = pSnapLive.val();
                let realDur = (durId === 'legacy_var') ? { keys: prLive.keys } : prLive.durations[durId];

                if (realDur && realDur.keys && Object.keys(realDur.keys).length > 0) {
                    const kId = Object.keys(realDur.keys)[0];
                    const kD = realDur.keys[kId];
                    let kP = (durId === 'legacy_var') ? `products/${prodId}/keys/${kId}` : `products/${prodId}/durations/${durId}/keys/${kId}`;

                    const u = { [kP]: null };
                    if (!isAdmin) {
                        u[`users/${webUid}/balance`] = cB - fPrice;
                        u[`users/${webUid}/history/${push(ref(db)).key}`] = { product: `${prodName} - ${durInfo.duration}`, key: kD, price: fPrice, date: Date.now() };
                    }

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
// SISTEMA ANTI-BAN WA (SOCIOSXIT)
// ==========================================
const waQueue = [];
let isProcessingWaQueue = false;

async function processWaQueue() {
    if (isProcessingWaQueue || waQueue.length === 0) return;
    isProcessingWaQueue = true;

    while (waQueue.length > 0) {
        const { numero, mensaje, delayAfter } = waQueue.shift();
        if (waSock) { // Evitamos trabas de sesión si el socket existe
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

// ==========================================
// SISTEMA DE VINCULACIÓN VÍA WEB (FIREBASE)
// ==========================================
onValue(ref(db, 'whatsapp_control/command'), async (snapshot) => {
    const cmd = snapshot.val();
    if (cmd && cmd.action === 'request_code') {
        try {
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
            [{ text: '📱 Vincular WhatsApp por Telegram', callback_data: 'walinkadmin_menu' }],
            [{ text: '🔴 Cerrar Sesión Activa de WA', callback_data: 'cerrar_sesion_wa' }]
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

    // --- LÓGICA DE CIERRE DE SESIÓN PROFUNDO ---
    if (data === 'cerrar_sesion_wa') {
        bot.editMessageText('🔄 *Cerrando sesión en WhatsApp y limpiando base de datos...*', { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
        
        try {
            if (waSock) {
                await waSock.logout('Cierre manual por el Administrador');
            }
        } catch (e) {
            console.log('Error haciendo logout en WA:', e.message);
        }
        
        try {
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }
            await remove(ref(db, 'whatsapp_control/backup_session'));
            waSock = null;
            
            bot.editMessageText('✅ *SESIÓN CERRADA Y PURGADA CON ÉXITO.*\n\nLa base de datos y los archivos locales han sido limpiados. El bot está 100% limpio y listo para recibir un nuevo número.\n\nEscribe /start para volver a vincular.', { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
            
            iniciarWhatsApp();
        } catch (error) {
            bot.sendMessage(chatId, '❌ Error al borrar archivos de sesión: ' + error.message);
        }
        return;
    }

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


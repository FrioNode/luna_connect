import express from 'express';
import fs from 'fs';
import pino from 'pino';
import crypto from 'crypto';
import { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { Session } from './mongo.js';
const router = express.Router();

// ---------- Function to remove files ----------
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
        return true;
    } catch (e) {
        console.error('Error removing file:', e);
        return false;
    }
}

// ---------- Main route ----------
router.get('/', async (req, res) => {
    const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const dirs = `./qr_sessions/session_${sessionId}`;

    if (!fs.existsSync('./qr_sessions')) fs.mkdirSync('./qr_sessions', { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(dirs);

    try {
        const { version } = await fetchLatestBaileysVersion();
        let qrGenerated = false;
        let responseSent = false;

        // Generate QR and send to frontend
        const handleQRCode = async (qr) => {
            if (qrGenerated || responseSent) return;
            qrGenerated = true;

            const qrDataURL = await QRCode.toDataURL(qr, {
                errorCorrectionLevel: 'M',
                type: 'image/png',
                quality: 0.92,
                margin: 1,
                color: { dark: '#000000', light: '#FFFFFF' }
            });

            if (!responseSent) {
                responseSent = true;
                res.send({
                    qr: qrDataURL,
                    message: 'QR Code Generated! Scan it with your WhatsApp app.',
                    instructions: [
                        '1. Open WhatsApp on your phone',
                        '2. Go to Settings > Linked Devices',
                        '3. Tap "Link a Device"',
                        '4. Scan the QR code above'
                    ]
                });
            }
        };

        const socketConfig = {
            version,
            logger: pino({ level: 'silent' }),
            browser: Browsers.windows('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 250,
            maxRetries: 5,
        };

        let sock = makeWASocket(socketConfig);
        let reconnectAttempts = 0;
        const maxReconnectAttempts = 3;

        const handleConnectionUpdate = async (update) => {
            const { connection, lastDisconnect, qr } = update;
            console.log(`🔄 Connection update: ${connection || 'undefined'}`);

            if (qr && !qrGenerated) await handleQRCode(qr);

            if (connection === 'open') {
                console.log('✅ Connected successfully! Waiting 5s to ensure session is valid...');
                reconnectAttempts = 0;

                // Wait a few seconds to ensure WhatsApp finalizes device registration
                setTimeout(async () => {
                    try {
                        const credsFile = fs.readFileSync(dirs + '/creds.json', 'utf-8');
                        const base64Data = Buffer.from(credsFile).toString('base64');
                        const token = `LUNA~${crypto.randomBytes(5).toString('hex')}`;

                        // Save session to MongoDB
                        await Session.create({ key: token, value: base64Data });

                        // Send token back via HTTP
                        if (!responseSent) {
                            responseSent = true;
                            res.json({ message: 'Session paired successfully!', token });
                        }

                        // Send token to WhatsApp user
                        const userJid = sock.authState.creds.me?.id;
                        if (userJid) {
                            await sock.sendMessage(userJid, { text: `🟢 Your session is paired!\nToken: ${token}` });
                            console.log("📄 Session token sent to WhatsApp user");
                        }

                        // Cleanup local session folder after 1 minute
                        setTimeout(() => {
                            console.log('🧹 Cleaning up session folder...');
                            removeFile(dirs);
                        }, 60000);
                    } catch (err) {
                        console.error('❌ Error saving session or sending token:', err);
                        if (!responseSent) {
                            responseSent = true;
                            res.status(500).json({ error: 'Failed to save session or notify user' });
                        }
                    }
                }, 5000); // wait 5s
            }

            if (connection === 'close') {
                console.log('❌ Connection closed');
                if (lastDisconnect?.error) console.log('❗ Last Disconnect Error:', lastDisconnect.error);

                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === 401) removeFile(dirs);
                else if (statusCode === 515 || statusCode === 503) {
                    reconnectAttempts++;
                    if (reconnectAttempts <= maxReconnectAttempts) {
                        setTimeout(() => {
                            try {
                                sock = makeWASocket(socketConfig);
                                sock.ev.on('connection.update', handleConnectionUpdate);
                                sock.ev.on('creds.update', saveCreds);
                            } catch (err) { console.error('Failed to reconnect:', err); }
                        }, 5000);
                    } else if (!responseSent) {
                        responseSent = true;
                        res.status(503).send({ code: 'Connection failed after multiple attempts' });
                    }
                }
            }
        };

        sock.ev.on('connection.update', handleConnectionUpdate);
        sock.ev.on('creds.update', saveCreds);

        // Timeout to prevent hanging if QR not generated
        setTimeout(() => {
            if (!responseSent) {
                responseSent = true;
                res.status(408).send({ code: 'QR generation timeout' });
                removeFile(dirs);
            }
        }, 30000);

    } catch (err) {
        console.error('Error initializing session:', err);
        if (!res.headersSent) res.status(503).send({ code: 'Service Unavailable' });
        removeFile(dirs);
    }
});

process.on('uncaughtException', (err) => {
    const e = String(err);
    if (['conflict','not-authorized','Socket connection timeout','rate-overlimit','Connection Closed','Timed Out','Value not found','Stream Errored','Stream Errored (restart required)','statusCode: 515','statusCode: 503'].some(msg => e.includes(msg))) return;
    console.log('Caught exception: ', err);
});

export default router;
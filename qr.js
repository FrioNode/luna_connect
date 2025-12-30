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

    console.log('GET /qr - sessionId:', sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(dirs);

    try {
        const { version } = await fetchLatestBaileysVersion();
        let qrGenerated = false;
        let responseSent = false;
        // Token reserved for this pairing session; generated when QR is created so frontend sees both QR and token together
        let sessionToken = null;

        // Generate QR and send to frontend
        const handleQRCode = async (qr) => {
            console.log('handleQRCode invoked - qr present:', !!qr);
            if (qrGenerated || responseSent) {
                console.log('handleQRCode skipped - qrGenerated:', qrGenerated, 'responseSent:', responseSent);
                return;
            }
            qrGenerated = true;

            let qrDataURL;
            try {
                qrDataURL = await QRCode.toDataURL(qr, {
                    errorCorrectionLevel: 'M',
                    type: 'image/png',
                    quality: 0.92,
                    margin: 1,
                    color: { dark: '#000000', light: '#FFFFFF' }
                });
            } catch (err) {
                console.error('❌ Failed to convert QR to DataURL:', err);
                if (!responseSent) {
                    responseSent = true;
                    res.status(500).json({ error: 'Failed to generate QR image' });
                }
                return;
            }

            // Generate a short session token now so frontend can display it alongside the QR
            sessionToken = sessionToken || `LUNA~${crypto.randomBytes(5).toString('hex')}`;

            if (!responseSent) {
                    responseSent = true;
                    console.log('Sending QR DataURL length:', qrDataURL.length);
                    res.send({
                        qr: qrDataURL,
                        token: sessionToken,
                        message: 'QR Code Generated! Scan it with your WhatsApp app and note the token.',
                        instructions: [
                            '1. Open WhatsApp on your phone',
                            '2. Go to Settings > Linked Devices',
                            '3. Tap "Link a Device"',
                            '4. Scan the QR code above'
                        ]
                    });
                    console.log('🔑 Generated token and sent with QR:', sessionToken);
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
            // Increased timeouts for cloud deployments (e.g., Render)
            defaultQueryTimeoutMs: 120000, // 2 minutes
            connectTimeoutMs: 120000, // 2 minutes
            keepAliveIntervalMs: 60000, // 1 minute
            retryRequestDelayMs: 500,
            maxRetries: 10,
        };

        let sock = makeWASocket(socketConfig);
        let reconnectAttempts = 0;
        const maxReconnectAttempts = 3;

        const handleConnectionUpdate = async (update) => {
            const { connection, lastDisconnect, qr } = update;
            console.log(`🔄 Connection update: ${connection || 'undefined'}`, qr ? `(qr len ${typeof qr === 'string' ? qr.length : 'n/a'})` : '(no qr)');

            if (qr && !qrGenerated) await handleQRCode(qr);

            if (connection === 'open') {
                console.log('✅ Connected successfully! Waiting 5s to ensure session is valid...');
                reconnectAttempts = 0;

                // Wait a few seconds to ensure WhatsApp finalizes device registration
                setTimeout(async () => {
                    try {
                        const credsFile = fs.readFileSync(dirs + '/creds.json', 'utf-8');
                        const base64Data = Buffer.from(credsFile).toString('base64');

                        // Ensure token was generated earlier at QR generation time. DO NOT generate a new token here.
                        if (!sessionToken) {
                            console.error('❌ Missing session token: token must be generated when QR was created. Aborting persist.');
                            if (!responseSent) {
                                responseSent = true;
                                res.status(500).json({ error: 'Missing session token. Please regenerate the QR and try again.' });
                            }
                            // Cleanup session folder
                            removeFile(dirs);
                            return;
                        }

                        const token = sessionToken;

                        // Save session to MongoDB
                        await Session.create({ key: token, value: base64Data });

                        let messageSent = false;

                        // Attempt to send token to WhatsApp user (best-effort). Log any errors for debugging.
                        try {
                            const userJid = sock.authState.creds.me?.id;
                            console.log('Attempting to send token to WhatsApp user JID:', userJid);
                            if (userJid) {
                                await sock.sendMessage(userJid, { text: `✅ Pairing successful!\n\n🔑 SESSION TOKEN:\n${token}\n\n⚠️ Keep this token safe` });
                                await sock.sendMessage(userJid, { text: `${token}` });
                                messageSent = true;
                                console.log("📄 Session token sent to WhatsApp user");
                            } else {
                                console.log('No userJid available to send token to.');
                            }
                        } catch (err) {
                            console.error('❌ Failed to send token message to WhatsApp user (QR flow):', err);
                        }

                        // Update session record to mark notification if message was sent to user
                        if (messageSent) {
                            try {
                                await Session.updateOne({ key: token }, { $set: { notified: true, notifiedAt: new Date() } });
                                console.log('✅ Session record updated with notification status (QR flow)');
                            } catch (err) {
                                console.error('❌ Failed to update session notification status (QR flow):', err);
                            }
                        }

                        // Send token back via HTTP including messageSent if possible
                        if (!responseSent) {
                            responseSent = true;
                            res.json({ message: 'Session paired successfully!', token, messageSent });
                        } else {
                            console.log('Response already sent earlier; cannot include messageSent in response (QR flow). messageSent:', messageSent);
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
import express from 'express';
import fs from 'fs';
import pino from 'pino';
import crypto from 'crypto';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';
import { Session } from './mongo.js';

const router = express.Router();

// Ensure the session directory exists
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    console.log('GET /pair - requested number:', num);
    let dirs = './' + (num || `session`);

    // Remove existing session if present
    await removeFile(dirs);

    // Clean the phone number - remove any non-digit characters
    num = num.replace(/[^0-9]/g, '');

    // Validate the phone number using awesome-phonenumber
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        if (!res.headersSent) {
            return res.status(400).send({ code: 'Invalid phone number. Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK, 84987654321 for Vietnam, etc.) without + or spaces.' });
        }
        return;
    }
    // Use the international number format (E.164, without '+')
    num = phone.getNumber('e164').replace('+', '');

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version, isLatest } = await fetchLatestBaileysVersion();
            // Token reserved for this pairing session; generated when pairing code is created so frontend sees both code and token together
            let sessionToken = null;
            let KnightBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows('Chrome'),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });

            KnightBot.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, isNewLogin, isOnline } = update;

                if (connection === 'open') {
                    console.log("✅ Connected successfully!");
                    console.log("📱 Sending session file to user...");
                    
                   try {
                        // Read creds.json
                        const credsRaw = fs.readFileSync(dirs + '/creds.json', 'utf-8');
                        const base64Data = Buffer.from(credsRaw).toString('base64');

                        // Ensure token was generated earlier at pairing-code creation. DO NOT generate a new token here.
                        if (!sessionToken) {
                            // attempt to recover from token file (if it was persisted earlier)
                            try {
                                if (fs.existsSync(dirs + '/token.txt')) {
                                    sessionToken = fs.readFileSync(dirs + '/token.txt', 'utf-8').trim();
                                    console.log('Recovered sessionToken from file:', sessionToken);
                                }
                            } catch (err) { console.error('Failed to read token file:', err); }
                        }

                        if (!sessionToken) {
                            console.error('❌ Missing session token: token must be generated when pairing code was created. Aborting persist.');
                            if (!res.headersSent) {
                                res.status(500).json({ error: 'Missing session token. Please generate a new pairing code and try again.' });
                            }
                            // Cleanup
                            removeFile(dirs);
                            return;
                        }

                        const token = sessionToken;

                        // Save to MongoDB — update existing placeholder or create new (upsert) to avoid duplicate key errors
                        try {
                            const updateRes = await Session.updateOne({ key: token }, { $set: { value: base64Data } }, { upsert: true });
                            console.log('Session upsert result:', JSON.stringify(updateRes));
                        } catch (dbErr) {
                            console.error('❌ Error upserting session record:', dbErr);
                            throw dbErr; // rethrow so outer catch handles it
                        }

                        // Small wait to ensure the socket is fully ready to send messages
                        await delay(2000);

                        // Determine JID to message: prefer the newly registered session's own JID if available
                        const sessionMe = KnightBot?.authState?.creds?.me?.id;
                        const normalizedJid = jidNormalizedUser(num + '@s.whatsapp.net');
                        let userJid = sessionMe || normalizedJid;

                        console.log('pair flow: sessionMe:', sessionMe, 'normalizedJid:', normalizedJid, 'initial userJid:', userJid);
                        console.log('pair flow: KnightBot.authState.creds.me:', JSON.stringify(KnightBot.authState?.creds?.me || {}));

                        let messageSent = false;

                        // Simplified delivery: send directly to the caller's JID (number), fallback once to sessionMe if needed
                        const targetJid = jidNormalizedUser(num + '@s.whatsapp.net');

                        // Log detailed recipient info and a masked token for debugging
                        try {
                            const maskedToken = token ? (token.length > 10 ? token.slice(0, 10) + '...' : token) : 'none';
                            console.log('About to send token', maskedToken, '-> targetJid:', targetJid, 'caller num:', num, 'sessionMe:', sessionMe);
                            console.log('KnightBot.authState.creds.me:', JSON.stringify(KnightBot.authState?.creds?.me || {}));
                        } catch (logErr) { console.error('Failed to log recipient details:', logErr); }

                        try {
                            console.log('Sending token to target JID:', targetJid);
                            const sendResult = await KnightBot.sendMessage(targetJid, { text: `✅ Pairing successful!\n\n🔑 SESSION TOKEN:\n${token}\n\n⚠️ Keep this token safe` });
                            console.log('sendResult to', targetJid, ':', JSON.stringify(sendResult));
                            messageSent = true;
                        } catch (err) {
                            console.error('Failed to send token to target JID:', targetJid, err?.stack || err);
                            // fallback: try sessionMe if available
                            if (sessionMe && sessionMe !== targetJid) {
                                try {
                                    console.log('Fallback sending to sessionMe JID:', sessionMe, 'maskedToken:', token ? (token.slice(0,10) + '...') : 'none');
                                    const sr = await KnightBot.sendMessage(sessionMe, { text: `✅ Pairing successful!\n\n🔑 SESSION TOKEN:\n${token}\n\n⚠️ Keep this token safe` });
                                    console.log('fallback send result to', sessionMe, ':', JSON.stringify(sr));
                                    messageSent = true;
                                } catch (fallbackErr) {
                                    console.error('Fallback send failed to', sessionMe, ':', fallbackErr?.stack || fallbackErr);
                                }
                            }
                        }

                        // Final status log about whom we attempted to send to
                        console.log('Token delivery summary: token (masked):', token ? (token.slice(0,10) + '...') : 'none', 'targetJid:', targetJid, 'sessionMe:', sessionMe, 'delivered:', messageSent);

                        // Update session record to mark notification if message was sent to user
                        if (messageSent) {
                            try {
                                await Session.updateOne({ key: token }, { $set: { notified: true, notifiedAt: new Date() } });
                                console.log('✅ Session record updated with notification status');
                            } catch (err) {
                                console.error('❌ Failed to update session notification status:', err);
                            }
                        }

                        // Send token to API caller (frontend) — include whether message was sent if connection still open
                        if (!res.headersSent) {
                            res.json({
                                success: true,
                                token,
                                messageSent
                            });
                        } else {
                            console.log('Response already sent earlier; cannot include messageSent in response. messageSent:', messageSent);
                        }

                        console.log('✅ Session stored & token delivery attempted');

                    } catch (err) {
                        console.error('❌ Failed to store session:', err);

                        if (!res.headersSent) {
                            res.status(500).json({ error: 'Failed to save session' });
                        }
                    }

                }

                if (isNewLogin) {
                    console.log("🔐 New login via pair code");
                }

                if (isOnline) {
                    console.log("📶 Client is online");
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;

                    if (statusCode === 401) {
                        console.log("❌ Logged out from WhatsApp. Need to generate new pair code.");
                    } else {
                        console.log("🔁 Connection closed — restarting...");
                        initiateSession();
                    }
                }
            });

            if (!KnightBot.authState.creds.registered) {
                await delay(3000); // Wait 3 seconds before requesting pairing code
                num = num.replace(/[^\d+]/g, '');
                if (num.startsWith('+')) num = num.substring(1);

                try {
                    let code = await KnightBot.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;

                    // generate short token now so frontend can display it alongside the pairing code
                    sessionToken = sessionToken || `LUNA~${crypto.randomBytes(5).toString('hex')}`;

                    // Persist a placeholder session record immediately so token exists even if process restarts or we reconnect
                    try {
                        await Session.create({ key: sessionToken, value: '' });
                        console.log('Saved placeholder session record for token:', sessionToken);
                    } catch (err) {
                        if (err?.code === 11000) console.log('Placeholder session already exists for token:', sessionToken);
                        else console.error('Failed to save placeholder session record:', err);
                    }

                    // Also write token to the session folder for later recovery if needed
                    try {
                        fs.writeFileSync(dirs + '/token.txt', sessionToken, 'utf-8');
                        console.log('Wrote token to file:', dirs + '/token.txt');
                    } catch (err) { console.error('Failed to write token file:', err); }

                    if (!res.headersSent) {
                        console.log({ num, code, token: sessionToken });
                        await res.send({ code, token: sessionToken });
                    }
                } catch (error) {
                    console.error('Error requesting pairing code:', error);
                    if (!res.headersSent) {
                        res.status(503).send({ code: 'Failed to get pairing code. Please check your phone number and try again.' });
                    }
                }
            }

            KnightBot.ev.on('creds.update', saveCreds);
        } catch (err) {
            console.error('Error initializing session:', err);
            if (!res.headersSent) {
                res.status(503).send({ code: 'Service Unavailable' });
            }
        }
    }

    await initiateSession();
});

// Global uncaught exception handler
process.on('uncaughtException', (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;
    if (e.includes("Stream Errored")) return;
    if (e.includes("Stream Errored (restart required)")) return;
    if (e.includes("statusCode: 515")) return;
    if (e.includes("statusCode: 503")) return;
    console.log('Caught exception: ', err);
});

export default router;
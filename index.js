const express = require('express');
const { Client, LocalAuth, MessageMedia, Buttons } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { randomUUID } = require('crypto');
const { default: axios } = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const DEFAULT_BASE_URL = "http://10.10.100.213:8000";
const PORT = process.env.PORT || 6969;

const clients = {};           // Active WA clients
const clientStatus = {};      // Status: qr/authenticated/ready/disconnected
const qrCodes = {};           // Latest QR base64 for each client

const SESSIONS_FILE = path.join(__dirname, 'clients.json');

// ========================
// Session Persistence
// ========================
function loadClients() {
    if (!fs.existsSync(SESSIONS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(SESSIONS_FILE));
    } catch {
        return [];
    }
}

function saveClients(clientIds) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(clientIds, null, 4));
}

const clientIds = loadClients();

// ========================
// Restore existing clients
// ========================
clientIds.forEach((client_id) => {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: client_id }),
        puppeteer: {
            headless: true,
            timeout: 0,
            args: [
                '--no-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-setuid-sandbox',
                '--disable-extensions',
                '--disable-session-crashed-bubble',
                '--disable-infobars',
                '--single-process',
                '--no-first-run',
                '--start-maximized'
            ]
        }
    });

    clients[client_id] = client;
    clientStatus[client_id] = 'initializing';

    client.on('qr', async (qr) => {
        qrCodes[client_id] = await QRCode.toDataURL(qr);
        clientStatus[client_id] = 'qr';
        console.log(`QR Code refreshed for ${client_id}`);
    });

    client.on('authenticated', () => {
        clientStatus[client_id] = 'authenticated';
        console.log(`Restored client ${client_id} authenticated`);
    });

    client.on('ready', () => {
        clientStatus[client_id] = 'ready';
        console.log(`Restored client ${client_id} is ready`);
    });

    client.on('disconnected', () => {
        console.log(`Client ${client_id} disconnected`);
        clientStatus[client_id] = 'disconnected';
        delete clients[client_id];

        const index = clientIds.indexOf(client_id);
        if (index > -1) {
            clientIds.splice(index, 1);
            saveClients(clientIds);
        }
    });

    client.initialize();
});

// ========================
// Create New Client
// ========================
app.post('/connect', async (req, res) => {
    const client_id = randomUUID();
    const { callback_url } = req.body;

    console.log("connecting new client:", client_id);

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: client_id }),
        puppeteer: {
            headless: true,
            timeout: 0,
            args: [
                '--no-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-setuid-sandbox',
                '--disable-extensions',
                '--disable-session-crashed-bubble',
                '--disable-infobars',
                '--single-process',
                '--no-first-run',
                '--start-maximized'
            ]
        }
    });

    clients[client_id] = client;
    clientStatus[client_id] = 'initializing';

    clientIds.push(client_id);
    saveClients(clientIds);

    // Event handlers
    client.on('qr', async (qr) => {
        qrCodes[client_id] = await QRCode.toDataURL(qr);
        clientStatus[client_id] = 'qr';
        console.log('QR Code received:', client_id);
    });

    client.on('authenticated', () => {
        clientStatus[client_id] = 'authenticated';
        console.log(`Client ${client_id} authenticated`);
    });

    client.on('ready', async () => {
        clientStatus[client_id] = 'ready';
        console.log(`Client ${client_id} is ready`);

        try {
            const { wid, pushname } = client.info;
            const number = wid.user;
            const profilePicUrl = await client.getProfilePicUrl(wid._serialized);
            const BASE_URL = callback_url || DEFAULT_BASE_URL + "/api/callback/wa";

            await axios.post(BASE_URL, {
                client_id,
                status: 'connected',
                name: pushname,
                number,
                profile_picture: profilePicUrl
            });

            console.log(`Callback sent for ${client_id}`);
        } catch (err) {
            console.error(`Callback error for ${client_id}:`, err.message);
        }
    });

    client.on('disconnected', () => {
        clientStatus[client_id] = 'disconnected';
        delete clients[client_id];

        const index = clientIds.indexOf(client_id);
        if (index > -1) {
            clientIds.splice(index, 1);
            saveClients(clientIds);
        }
        console.log(`Client ${client_id} disconnected`);
    });

    client.initialize();

    // Send response ONCE — no matter how many QR updates later
    res.json({ client_id, status: clientStatus[client_id] });
});

// ========================
// Fetch QR / Status
// ========================
app.get('/status/:client_id', (req, res) => {
    const { client_id } = req.params;
    res.json({
        client_id,
        status: clientStatus[client_id] || "not_found"
    });
});

app.get('/qr/:client_id', (req, res) => {
    const { client_id } = req.params;
    if (!qrCodes[client_id]) return res.status(202).json({ status: clientStatus[client_id] });
    res.json({ client_id, qr: qrCodes[client_id] });
});

// ========================
// Send Message
// ========================
app.post('/send', async (req, res) => {
    const { client_id, destination, message, image, button_url, button_text } = req.body;

    if (!client_id || !destination || !message) {
        return res.status(400).json({
            status: false,
            error: 'client_id, destination, and message are required',
        });
    }

    const client = clients[client_id];
    if (!client || clientStatus[client_id] !== "ready") {
        return res.status(404).json({ status: false, error: 'Client not ready' });
    }

    const number = destination.includes('@c.us') ? destination : `${destination}@c.us`;

    try {
        await client.sendPresenceAvailable();
        const chat = await client.getChatById(number);

        if (chat.sendStateTyping) await chat.sendStateTyping();
        const delay = Math.min(message.length * 100, 5000);
        await new Promise(r => setTimeout(r, delay));

        await chat.clearState(number);

        if (image) {
            const media = await MessageMedia.fromUrl(image);
            await client.sendMessage(number, media, { caption: message });
        } else if (button_url) {
            const button = new Buttons(message, [{ type: 'url', url: button_url, body: button_text }], '', '');
            await client.sendMessage(number, button);
        } else {
            await client.sendMessage(number, message);
        }

        res.status(200).json({ status: true, message: 'Message sent' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ status: false, error: 'Failed to send message' });
    }
});

// ========================
// Disconnect Client
// ========================
app.post('/disconnect', async (req, res) => {
    const { client_id } = req.body;

    const client = clients[client_id];
    if (!client) return res.status(404).json({ status: false, error: 'Client not found' });

    try {
        await client.logout();
        await client.destroy();
        delete clients[client_id];
        delete qrCodes[client_id];
        clientStatus[client_id] = 'disconnected';

        const index = clientIds.indexOf(client_id);
        if (index > -1) {
            clientIds.splice(index, 1);
            saveClients(clientIds);
        }

        res.json({ status: true, message: 'Client disconnected' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ status: false, error: 'Failed to disconnect' });
    }
});

// ========================

app.listen(PORT, () => {
    console.log(`Server started on http://localhost:${PORT}`);
});

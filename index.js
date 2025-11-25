const express = require('express');
const { Client, LocalAuth, MessageMedia, Buttons } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { randomUUID } = require('crypto');
const { default: axios } = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors())
app.use(express.json());

const BASE_URL = "http://10.10.100.213:8000";
const PORT = process.env.PORT || 6969;
const clients = {};
const SESSIONS_FILE = path.join(__dirname, 'clients.json');

// Utility to load/save client IDs
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

// Restore sessions on server start
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

	client.on('ready', () => {
		console.log(`Restored client ${client_id} is ready`);
	});

	client.on('auth_failure', msg => {
		console.error(`Client ${client_id} auth failure:`, msg);
	});

	client.on('disconnected', () => {
		console.log(`Client ${client_id} disconnected`);
		delete clients[client_id];
		const index = clientIds.indexOf(client_id);
		if (index > -1) {
			clientIds.splice(index, 1);
			saveClients(clientIds);
		}
	});

	client.initialize();
});

// Create a new WhatsApp session
app.post('/connect', async (req, res) => {
	const client_id = randomUUID();
	console.log('connecting');

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
	clientIds.push(client_id);
	saveClients(clientIds);

	client.on('qr', async (qr) => {
		const base64 = await QRCode.toDataURL(qr);
		console.log('QR Code received...');

		return res.status(200).json({
			client_id,
			qr: base64
		});
	});

	client.on('ready', async () => {
		console.log(`Client ${client_id} is ready`);

		try {
			const { wid, pushname } = client.info;
			const number = wid.user;
			const profilePicUrl = await client.getProfilePicUrl(wid._serialized);

			await axios.post(`${BASE_URL}/api/callback/wa`, {
				client_id,
				status: 'connected',
				name: pushname,
				number,
				profile_picture: profilePicUrl
			});

			console.log(`Callback sent for ${client_id}`);
		} catch (error) {
			console.error(`Callback error for ${client_id}:`, error.message);
		}
	});

	client.on('authenticated', () => {
		console.log(`Client ${client_id} authenticated`);
	});

	client.on('auth_failure', msg => {
		console.error(`Client ${client_id} auth failure:`, msg);
	});

	client.on('change_state', (state) => {
		console.log(`Client ${client_id} state changed to ${state}`);
	});

	client.on('disconnected', (reason) => {
		console.log(`Client ${client_id} disconnected. Reason : ${reason}`);
		delete clients[client_id];
		const index = clientIds.indexOf(client_id);
		if (index > -1) {
			clientIds.splice(index, 1);
			saveClients(clientIds);
		}
	});

	client.initialize();
});

// Send message from a client
app.post('/send', async (req, res) => {
    const { client_id, destination, message, image, button_url, button_text } = req.body;

    if (!client_id || !destination || !message) {
        return res.status(400).json({
            status: false,
            error: 'client_id, destination, and message are required',
        });
    }

    const client = clients[client_id];
    if (!client) {
        return res.status(404).json({
            status: false,
            error: 'Client not found or not connected',
        });
    }

    const number = destination.includes('@c.us') ? destination : `${destination}@c.us`;

    try {
        // 🟢 Set presence to online
        await client.sendPresenceAvailable();

		const chat = await client.getChatById(number)

        // ⌨️ Start typing simulation
        if (chat.sendStateTyping) {
			await chat.sendStateTyping();
		}

        // ⏳ Simulate delay (customizable)
        // await new Promise(resolve => setTimeout(resolve, 2000));
		const delay = Math.min(message.length * 100, 5000);
		await new Promise(res => setTimeout(res, delay));

        // ✋ Stop typing
        await chat.clearState(number);

        // 📩 Now send the actual message
        if (image) {
            const media = await MessageMedia.fromUrl(image);
            await client.sendMessage(number, media, { caption: message });

        } else if (button_url && typeof button_url === 'string') {
            const button = new Buttons(
                message,
                [{ type: 'url', url: button_url, body: button_text }],
                'Visit Link',
                'Footer (opt)'
            );
            await client.sendMessage(number, button);

        } else {
            await client.sendMessage(number, message);
        }

        return res.status(200).json({
            status: true,
            message: 'Message sent with typing simulation'
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({
            status: false,
            error: 'Failed to send message',
        });
    }
});

app.post('/disconnect', async (req, res) => {
	const { client_id } = req.body;

	if (!client_id) {
		return res.status(400).json({
			status: false,
			error: 'client_id is required'
		});
	}

	const client = clients[client_id];
	if (!client) {
		return res.status(404).json({
			status: false,
			error: 'Client not found or already disconnected'
		});
	}

	try {
		await client.logout(); // Proper API call to unlink WhatsApp device
		await client.destroy(); // Cleanup Puppeteer

		// Remove from in-memory sessions
		delete clients[client_id];

		// Remove from saved sessions file
		const index = clientIds.indexOf(client_id);
		if (index > -1) {
			clientIds.splice(index, 1);
			saveClients(clientIds);
		}

		console.log(`Client ${client_id} successfully disconnected`);

		return res.status(200).json({
			status: true,
			message: 'Client successfully disconnected'
		});

	} catch (err) {
		console.error(`Disconnect failed for ${client_id}:`, err.message);

		return res.status(500).json({
			status: false,
			error: 'Failed to disconnect the session'
		});
	}
});

app.post('/sendori', async (req, res) => {
	const { client_id, destination, message, image, button_url, button_text } = req.body;

	if (!client_id || !destination || !message) {
		return res.status(400).json({
			status: false,
			error: 'client_id, destination, and message are required',
		});
	}

	const client = clients[client_id];
	if (!client) {
		return res.status(404).json({
			status: false,
			error: 'Client not found or not connected',
		});
	}

	const number = destination.includes('@c.us') ? destination : `${destination}@c.us`;

	try {
		if (image) {
			const media = await MessageMedia.fromUrl(image);
			await client.sendMessage(number, media, { caption: message });
		} else if (button_url && typeof button_url === 'string') {
			const button = new Buttons(
				message,
				[{ type: 'url', url: button_url, body: button_text }],
				'Visit Link',
				'Footer (opt)'
			);
			await client.sendMessage(number, button);
		} else {
			await client.sendMessage(number, message);
		}

		return res.status(200).json({ status: true, message: 'Message sent' });

	} catch (err) {
		console.error(err);
		return res.status(500).json({
			status: false,
			error: 'Failed to send message',
		});
	}
});

app.listen(PORT, () => {
	console.log(`Server started on http://localhost:${PORT}`);
});

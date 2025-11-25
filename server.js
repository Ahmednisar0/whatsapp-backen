import express from 'express';
import cors from 'cors';
import fileUpload from 'express-fileupload';
import csv from 'csv-parser';
import fs from 'fs';
import pkg from 'whatsapp-web.js';
import jwt from 'jsonwebtoken';
const { Client, LocalAuth } = pkg;

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(fileUpload());

const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// ---------------------------
// In-memory store for WhatsApp clients
// ---------------------------
const clients = {}; // { userId: ClientInstance }

// ---------------------------
// Middleware to get userId from JWT
// ---------------------------
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ---------------------------
// Initialize WhatsApp client per user
// ---------------------------
const initClient = (userId) => {
  if (clients[userId]) return clients[userId]; // already exists

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
      ],
    },
  });

  let qrCode = '';
  let isReady = false;

  client.on('qr', qr => {
    qrCode = qr;
    console.log(`QR generated for user ${userId}`);
  });

  client.on('ready', () => {
    isReady = true;
    console.log(`WhatsApp ready for user ${userId}`);
  });

  client.on('auth_failure', msg => console.log('Auth failure', msg));
  client.on('disconnected', reason => console.log('Client disconnected', reason));

  client.initialize();

  clients[userId] = { client, qrCode, isReady };
  return clients[userId];
};

// ---------------------------
// Routes
// ---------------------------

// Get QR code
app.get('/qr', authMiddleware, (req, res) => {
  const { userId } = req;
  const session = initClient(userId);
  res.json({ qr: session.qrCode, ready: session.isReady });
});

// Send bulk messages
app.post('/send-bulk', authMiddleware, async (req, res) => {
  const { userId } = req;
  const session = initClient(userId);
  if (!session.isReady) return res.json({ error: 'WhatsApp not ready' });

  const message = req.body.message;
  const csvFile = req.files?.file;
  if (!csvFile) return res.status(400).json({ error: 'CSV file required' });

  const tempPath = `${uploadDir}/${Date.now()}.csv`;
  fs.writeFileSync(tempPath, csvFile.data);

  const numbers = [];
  fs.createReadStream(tempPath)
    .pipe(csv())
    .on('data', row => {
      const columnNames = Object.keys(row);
      const phone = row[columnNames[0]]?.trim();
      if (phone) numbers.push(phone);
    })
    .on('end', async () => {
      console.log(`Sending messages for user ${userId}:`, numbers.length);
      for (let number of numbers) {
        try {
          await session.client.sendMessage(number + '@c.us', message);
          await new Promise(r => setTimeout(r, 15000));
        } catch (err) {
          console.log('Failed =>', number, err);
        }
      }

      fs.unlinkSync(tempPath);
      res.json({ status: 'Bulk sending completed' });
    });
});

// Logout user
app.post('/logout', authMiddleware, async (req, res) => {
  const { userId } = req;
  try {
    if (!clients[userId]) return res.status(400).json({ error: 'No session found' });

    await clients[userId].client.destroy();
    delete clients[userId];
    res.json({ status: 'Logged out, new QR will be generated next login' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to logout' });
  }
});

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Tool backend running on port ${PORT}`));

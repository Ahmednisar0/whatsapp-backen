import express from 'express';
import cors from 'cors';
import fileUpload from 'express-fileupload';
import csv from 'csv-parser';
import fs from 'fs';
import pkg from 'whatsapp-web.js';
import jwt from 'jsonwebtoken';

const { Client, LocalAuth } = pkg;

const app = express();
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(express.json());
app.use(fileUpload());

const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// In-memory storage of clients
const clients = {};

// JWT auth middleware
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
};

// Initialize WhatsApp client for a user
function initClient(userId) {
  if (clients[userId]) return clients[userId];

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

  const clientData = { client, qr: '', ready: false };
  clients[userId] = clientData;

  client.on('qr', qr => {
    clientData.qr = qr;
    console.log(`QR generated for user ${userId}`);
  });

  client.on('ready', () => {
    clientData.ready = true;
    console.log(`WhatsApp ready for user ${userId}`);
  });

  client.on('auth_failure', msg => {
    console.log(`Auth failure for user ${userId}:`, msg);
  });

  client.on('disconnected', reason => {
    console.log(`Client disconnected for user ${userId}:`, reason);
    delete clients[userId];
  });

  client.initialize();
  return clientData;
}

// ================================
// Routes
// ================================

// Get QR code for user
app.get('/qr', authMiddleware, (req, res) => {
  const userId = req.userId;
  const clientData = initClient(userId);
  res.json({ qr: clientData.qr, ready: clientData.ready });
});

// Send bulk messages
app.post('/send-bulk', authMiddleware, (req, res) => {
  const userId = req.userId;
  const clientData = clients[userId];
  if (!clientData || !clientData.ready) return res.status(400).json({ error: "WhatsApp not connected" });

  const message = req.body.message;
  const csvFile = req.files?.file;
  if (!csvFile) return res.status(400).json({ error: "CSV file required" });

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
      for (let number of numbers) {
        try {
          await clientData.client.sendMessage(number + "@c.us", message);
          await new Promise(r => setTimeout(r, 15000));
        } catch (err) {
          console.log(`Failed => ${number}`, err);
        }
      }
      fs.unlinkSync(tempPath);
      res.json({ status: "Bulk sending completed" });
    });
});

// Logout
app.post('/logout', authMiddleware, async (req, res) => {
  const userId = req.userId;
  const clientData = clients[userId];
  if (!clientData) return res.status(400).json({ error: "No session found" });

  try {
    await clientData.client.destroy();
    delete clients[userId];
    res.json({ status: "Logged out, new QR will be generated on next request" });
  } catch (err) {
    res.status(500).json({ error: "Failed to logout" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`WhatsApp backend running on port ${PORT}`));

import express from 'express';
import cors from 'cors';
import fileUpload from 'express-fileupload';
import csv from 'csv-parser';
import fs from 'fs';
import pkg from 'whatsapp-web.js';
import chromium from "chrome-aws-lambda";

const { Client, LocalAuth } = pkg;

const app = express();
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(express.json());
app.use(fileUpload());

// Store all user sessions
const clients = {};

const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// =======================
// Create WA Client Per User
// =======================
async function initializeClient(userId) {
  if (clients[userId]) return clients[userId];

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
    puppeteer: {
      headless: true,
      executablePath: await chromium.executablePath,
      args: chromium.args,
    }
  });

  clients[userId] = { client, qrCode: '', isReady: false };

  client.on('qr', qr => {
    clients[userId].qrCode = qr;
    console.log("QR Generated:", userId);
  });

  client.on('ready', () => {
    clients[userId].isReady = true;
    console.log("READY:", userId);
  });

  client.on('disconnected', () => {
    console.log("DISCONNECTED:", userId);
    delete clients[userId];
  });

  client.initialize();
  return clients[userId];
}

// =======================
// API
// =======================

// Return QR Code
app.get('/qr/:userId', async (req, res) => {
  const userId = req.params.userId;
  const session = await initializeClient(userId);

  res.json({
    qr: session.qrCode,
    ready: session.isReady
  });
});

// Bulk Message Sender
app.post('/send-bulk/:userId', (req, res) => {
  const userId = req.params.userId;
  const session = clients[userId];

  if (!session || !session.isReady)
    return res.json({ error: "WhatsApp not connected" });

  const message = req.body.message;
  const csvFile = req.files?.file;
  if (!csvFile) return res.status(400).json({ error: "CSV file required" });

  const tempPath = `${uploadDir}/${Date.now()}.csv`;
  fs.writeFileSync(tempPath, csvFile.data);

  const numbers = [];

  fs.createReadStream(tempPath)
    .pipe(csv())
    .on('data', row => {
      const col = Object.keys(row)[0];
      const phone = row[col]?.trim();
      if (phone) numbers.push(phone);
    })
    .on('end', async () => {
      for (let number of numbers) {
        try {
          await session.client.sendMessage(number + "@c.us", message);
          await new Promise(r => setTimeout(r, 5000)); // 5 sec delay
        } catch (err) {
          console.log("Failed:", number, err);
        }
      }

      fs.unlinkSync(tempPath);
      res.json({ status: "Bulk messages sent!" });
    });
});

// Logout User
app.post('/logout/:userId', async (req, res) => {
  const userId = req.params.userId;
  const session = clients[userId];

  if (!session) return res.status(400).json({ error: "No session found" });

  try {
    await session.client.destroy();
    delete clients[userId];
    res.json({ status: "Logged out" });
  } catch (err) {
    res.status(500).json({ error: "Failed to logout" });
  }
});

const PORT = 5000;
app.listen(PORT, () => console.log("Server running on port " + PORT));

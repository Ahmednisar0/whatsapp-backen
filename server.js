import express from 'express';
import cors from 'cors';
import fileUpload from 'express-fileupload';
import csv from 'csv-parser';
import fs from 'fs';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

const app = express();
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(express.json());
app.use(fileUpload());

const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// ================================
// Store clients per user
// ================================
const clients = {}; // key: userId, value: { client, qrCode, isReady }

// Function to initialize a client for a user
function initializeClient(userId) {
  if (clients[userId]) return clients[userId]; // Already exists

 const client = new Client({
  authStrategy: new LocalAuth({ clientId: userId }),
  puppeteer: {
    headless: true,
    executablePath: "/usr/bin/chromium",
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

  clients[userId] = { client, qrCode: '', isReady: false };

  client.on('qr', qr => {
    clients[userId].qrCode = qr;
    console.log(`QR generated for user ${userId}`);
  });

  client.on('ready', () => {
    clients[userId].isReady = true;
    console.log(`WhatsApp Ready for user ${userId}`);
  });

  client.on('auth_failure', msg => {
    console.log(`Auth failure for user ${userId}`, msg);
  });

  client.on('disconnected', reason => {
    console.log(`Client disconnected for user ${userId}`, reason);
    delete clients[userId]; // remove session
  });

  client.initialize();

  return clients[userId];
}

// ================================
// API Routes
// ================================

// Get QR code for login
app.get('/qr/:userId', (req, res) => {
  const userId = req.params.userId;
  const session = initializeClient(userId);
  res.json({ qr: session.qrCode, ready: session.isReady });
});

// Send bulk messages
app.post('/send-bulk/:userId', (req, res) => {
  const userId = req.params.userId;
  const session = clients[userId];
  if (!session || !session.isReady) return res.json({ error: "WhatsApp not connected" });

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
      const phone = row[columnNames[0]]?.trim(); // First column = number
      if (phone) numbers.push(phone);
    })
    .on('end', async () => {
      console.log("Numbers to send:", numbers);
      for (let number of numbers) {
        try {
          await session.client.sendMessage(number + "@c.us", message);
          await new Promise(r => setTimeout(r, 15000)); // 15s delay
        } catch (err) {
          console.log("Failed =>", number, err);
        }
      }
      fs.unlinkSync(tempPath);
      res.json({ status: "Bulk sending completed" });
    });
});

// Logout user
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

// ================================
// Start Server
// ================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

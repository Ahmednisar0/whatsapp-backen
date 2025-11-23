import express from 'express';
import cors from 'cors';
import fileUpload from 'express-fileupload';
import csv from 'csv-parser';
import fs from 'fs';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

// ================================
// Express Setup
// ================================
const app = express();
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
app.use(express.json());
app.use(fileUpload());

const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// ================================
// WhatsApp Client (Headless Puppeteer)
// ================================
const client = new Client({
  authStrategy: new LocalAuth(),
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
  console.log('QR generated');
});

client.on('ready', () => {
  isReady = true;
  console.log('WhatsApp Ready!');
});

client.on('auth_failure', msg => {
  console.log('Auth failure', msg);
});

client.on('disconnected', reason => {
  console.log('Client disconnected', reason);
});

client.initialize();

// ================================
// API Routes
// ================================

// Get QR code for login
app.get('/qr', (req, res) => {
  res.json({ qr: qrCode, ready: isReady });
});

// Send bulk messages
app.post('/send-bulk', (req, res) => {
  if (!isReady) return res.json({ error: "WhatsApp not connected" });

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
          await client.sendMessage(number + "@c.us", message);
          await new Promise(r => setTimeout(r, 15000)); // 15s delay for safety
        } catch (err) {
          console.log("Failed =>", number, err);
        }
      }

      fs.unlinkSync(tempPath);
      res.json({ status: "Bulk sending completed" });
    });
    
});
app.post('/logout', async (req, res) => {
  try {
    await client.destroy(); // destroys session
    initializeClient(); // create new client for fresh QR
    res.json({ status: "Logged out, new QR generated" });
  } catch (err) {
    res.status(500).json({ error: "Failed to logout" });
  }
});


// ================================
// Start Server
// ================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

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

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: false, args: ['--no-sandbox'] }
});

let qrCode = '';
let isReady = false;

client.on('qr', qr => { qrCode = qr; console.log('QR generated'); });
client.on('ready', () => { isReady = true; console.log('WhatsApp Ready!'); });
client.initialize();

app.get('/qr', (req, res) => res.json({ qr: qrCode, ready: isReady }));

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
    .on('data', (row) => {
      // Row ke andar jo bhi column ka naam hai... extract number automatically
      const columnNames = Object.keys(row);

      // pehli column ka value → phone number
      const phone = row[columnNames[0]]?.trim();

      if (phone) numbers.push(phone);
    })
    .on('end', async () => {
      console.log("Numbers to send:", numbers);

      for (let number of numbers) {
        try {
          await client.sendMessage(number + "@c.us", message);
          await new Promise(r => setTimeout(r, 15000));
        } catch (err) {
          console.log("Failed =>", number, err);
        }
      }

      fs.unlinkSync(tempPath);
      res.json({ status: "Bulk sending completed" });
    });
});


app.listen(5000, () => console.log('Backend running on port 5000'));

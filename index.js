const express = require('express');
const admin = require('firebase-admin');
const multer = require('multer');
const FormData = require('form-data');
const app = express();
app.use(express.json());

// ============================================================
// CONFIGURATION (all from environment variables)
// ============================================================
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHANNEL_ID; // negative for channel
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://droplet-trading-default-rtdb.firebaseio.com/';

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHANNEL_ID');
  process.exit(1);
}

// ============================================================
// FIREBASE ADMIN INIT
// ============================================================
const requiredEnv = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing ${key} environment variable`);
    process.exit(1);
  }
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  databaseURL: DATABASE_URL,
});
const db = admin.database();

// ============================================================
// MULTER – store files in memory
// ============================================================
const upload = multer({ storage: multer.memoryStorage() });

// ============================================================
// TELEGRAM API HELPER
// ============================================================
async function sendVideoToTelegram(buffer, filename, caption) {
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('video', buffer, { filename });
  if (caption) form.append('caption', caption);

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`;
  const response = await fetch(url, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram error: ${JSON.stringify(data)}`);
  }
  return data.result; // contains message_id, chat, video file_id, etc.
}

// ============================================================
// GET TELEGRAM FILE URL FROM file_id
// ============================================================
async function getTelegramFileUrl(fileId) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
  const response = await fetch(url);
  const data = await response.json();
  if (!data.ok) throw new Error(`getFile error: ${JSON.stringify(data)}`);
  const filePath = data.result.file_path;
  return `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
}

// ============================================================
// MIDDLEWARE: Verify Firebase ID Token
// ============================================================
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // contains uid, email, etc.
    next();
  } catch (error) {
    console.error('Token verification failed:', error);
    res.status(403).json({ error: 'Invalid token' });
  }
}

// ============================================================
// UPLOAD ENDPOINT
// ============================================================
app.post('/api/upload-video', verifyFirebaseToken, upload.single('video'), async (req, res) => {
  try {
    const { text } = req.body;
    const file = req.file;
    const uid = req.user.uid;

    if (!file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    // 1. Send to Telegram
    const telegramResult = await sendVideoToTelegram(file.buffer, file.originalname, text || '');

    // 2. Get the permanent Telegram file URL
    const fileId = telegramResult.video.file_id;
    const videoUrl = await getTelegramFileUrl(fileId);

    // 3. Save to Firebase under /videos/{uid}/...
    const postRef = db.ref(`videos/${uid}`).push();
    await postRef.set({
      videoUrl,
      text: text || '',
      telegram_message_id: telegramResult.message_id,
      timestamp: Date.now(),
      fileSize: file.size,
      mimeType: file.mimetype,
    });

    res.status(200).json({
      success: true,
      videoUrl,
      telegram: telegramResult,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// (Optional) Webhook endpoint – if you still want to read channel posts
// ============================================================
app.post('/webhook', async (req, res) => {
  // You can keep this empty if not needed, or add your existing logic
  res.sendStatus(200);
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

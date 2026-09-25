// ============================================================
// 📦 index.js – ConneX Backend Server (v2)
// ============================================================
// Accepts VIDEO and IMAGE uploads → Telegram channel storage.
// Writes post metadata into usersdata/{uid}/posts/{postId}.
// Refreshes Telegram file URLs every 30 minutes.
// ============================================================

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const admin = require('firebase-admin');

// ============================================================
// 1. CONFIGURATION
// ============================================================
const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

const FIREBASE_DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  'https://droplet-trading-default-rtdb.firebaseio.com/';

const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : {
      projectId: process.env.FIREBASE_PROJECT_ID || 'droplet-trading',
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    };

const REFRESH_INTERVAL_MINUTES = Number(process.env.REFRESH_INTERVAL_MINUTES) || 30;
const CRON_SECRET = process.env.CRON_SECRET || '';

// ============================================================
// 2. VALIDATE ENV VARS
// ============================================================
const missing = [];
if (!TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
if (!TELEGRAM_CHANNEL_ID) missing.push('TELEGRAM_CHANNEL_ID');
if (!FIREBASE_SERVICE_ACCOUNT.privateKey) missing.push('FIREBASE_PRIVATE_KEY');
if (!FIREBASE_SERVICE_ACCOUNT.clientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
if (missing.length) {
  console.error('❌ Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

// ============================================================
// 3. INITIALIZE FIREBASE ADMIN
// ============================================================
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(FIREBASE_SERVICE_ACCOUNT),
    databaseURL: FIREBASE_DATABASE_URL,
  });
}
const db = admin.database();

// ============================================================
// 4. EXPRESS APP SETUP
// ============================================================
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-cron-secret'],
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// *** CHANGE 1: accept both images and videos ***
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/');
    if (ok) cb(null, true);
    else cb(new Error('Only video or image files are allowed'), false);
  },
});

// ============================================================
// 5. TELEGRAM HELPERS
// ============================================================

// *** CHANGE 2: route images to sendPhoto, videos to sendVideo ***
async function uploadToTelegram(buffer, caption, isImage, originalName) {
  const form = new FormData();
  form.append('chat_id', TELEGRAM_CHANNEL_ID);

  if (isImage) {
    form.append('photo', buffer, {
      filename: originalName || `image_${Date.now()}.jpg`,
      contentType: 'image/jpeg',
    });
  } else {
    form.append('video', buffer, {
      filename: originalName || `video_${Date.now()}.mp4`,
      contentType: 'video/mp4',
    });
  }

  if (caption) form.append('caption', caption);

  const endpoint = isImage ? 'sendPhoto' : 'sendVideo';

  const response = await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`,
    form,
    { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity }
  );

  const result = response.data;
  if (!result.ok) throw new Error(`Telegram error: ${result.description}`);

  // sendPhoto → array of sizes; sendVideo → single object
  const fileObj = isImage
    ? result.result.photo[result.result.photo.length - 1]
    : result.result.video;

  const fileId = fileObj.file_id;
  const fileInfo = await axios.get(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const filePath = fileInfo.data.result.file_path;
  const publicUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

  return {
    video_url: publicUrl,
    file_id: fileId,
    file_path: filePath,
    message_id: result.result.message_id,
  };
}

async function refreshTelegramFileUrl(fileId) {
  try {
    const fileInfo = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    if (!fileInfo.data.ok) return null;
    const filePath = fileInfo.data.result.file_path;
    return {
      file_path: filePath,
      video_url: `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`,
    };
  } catch (e) {
    return null;
  }
}

// ============================================================
// 6. POST STORAGE
// ============================================================
async function storePostInFirebase(uid, postData) {
  const postsRef = db.ref(`usersdata/${uid}/posts`);
  const newPostRef = postsRef.push();
  const now = Date.now();

  await newPostRef.set({
    ...postData,
    createdAt: now,
    totalLikes: 0,
    totalViews: 0,
    totalVotes: 0,
    totalComments: 0,
  });

  return newPostRef.key;
}

// ============================================================
// 7. TELEGRAM URL REFRESH
// ============================================================
async function refreshAllTelegramUrls() {
  const started = Date.now();
  console.log('🔄 Refreshing Telegram URLs…');

  const usersSnap = await db.ref('usersdata').get();
  const users = usersSnap.val() || {};

  const updates = {};
  let scanned = 0, refreshed = 0, failed = 0;

  for (const uid of Object.keys(users)) {
    const posts = (users[uid] && users[uid].posts) || {};
    for (const postId of Object.keys(posts)) {
      const post = posts[postId] || {};
      if (!post.telegram_file_id) continue;

      scanned++;
      const fresh = await refreshTelegramFileUrl(post.telegram_file_id);
      if (!fresh) { failed++; continue; }

      updates[`usersdata/${uid}/posts/${postId}/video_url`] = fresh.video_url;
      updates[`usersdata/${uid}/posts/${postId}/telegram_file_path`] = fresh.file_path;
      updates[`usersdata/${uid}/posts/${postId}/video_url_refreshed_at`] = Date.now();
      refreshed++;
    }
  }

  if (Object.keys(updates).length) await db.ref().update(updates);

  const ms = Date.now() - started;
  console.log(`✅ Refresh done in ${ms}ms — scanned: ${scanned}, refreshed: ${refreshed}, failed: ${failed}`);
  return { scanned, refreshed, failed, ms };
}

async function refreshPostUrl(uid, postId) {
  const snap = await db.ref(`usersdata/${uid}/posts/${postId}`).get();
  const post = snap.val();
  if (!post || !post.telegram_file_id) return null;

  const fresh = await refreshTelegramFileUrl(post.telegram_file_id);
  if (!fresh) return null;

  await db.ref(`usersdata/${uid}/posts/${postId}`).update({
    video_url: fresh.video_url,
    telegram_file_path: fresh.file_path,
    video_url_refreshed_at: Date.now(),
  });

  return fresh;
}

// ============================================================
// 8. ROUTES
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'ConneX backend is running',
    version: 'v2',
    accepts: ['video', 'image'],
    refresh_interval_minutes: REFRESH_INTERVAL_MINUTES,
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now(), version: 'v2' });
});

// *** CHANGE 3: wrapper catches multer errors and returns CORS-safe JSON ***
app.post('/api/upload', (req, res, next) => {
  upload.single('video')(req, res, (err) => {
    if (err) {
      console.error('Multer error:', err.message);
      res.header('Access-Control-Allow-Origin', '*');
      return res.status(400).json({ success: false, error: err.message });
    }
    next();
  });
}, async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');

  try {
    const { caption = '', hashtags = '', uid = null } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ success: false, error: 'No file provided' });
    if (!uid) return res.status(400).json({ success: false, error: 'User ID (uid) is required' });

    const isImage = file.mimetype.startsWith('image/');

    console.log(`📤 Upload: uid=${uid}, type=${isImage ? 'image' : 'video'}, size=${(file.size / 1024 / 1024).toFixed(2)}MB`);

    const telegramResult = await uploadToTelegram(file.buffer, caption, isImage, file.originalname);

    const postData = {
      uid,
      type: isImage ? 'image' : 'video',
      caption,
      hashtags: hashtags || '',
      video_url: telegramResult.video_url,
      telegram_file_id: telegramResult.file_id,
      telegram_file_path: telegramResult.file_path,
      telegram_message_id: telegramResult.message_id,
      video_url_refreshed_at: Date.now(),
    };

    const postId = await storePostInFirebase(uid, postData);
    console.log(`✅ Post created: usersdata/${uid}/posts/${postId}`);

    res.json({
      success: true,
      post_id: postId,
      video_url: telegramResult.video_url,
      type: isImage ? 'image' : 'video',
      message: 'Upload succeeded and post created.',
    });
  } catch (error) {
    console.error('Upload error:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
});

// CRON REFRESH
app.post('/api/cron/refresh', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  if (CRON_SECRET) {
    const provided = req.headers['x-cron-secret'] || req.query.secret;
    if (provided !== CRON_SECRET) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
  }
  try {
    const result = await refreshAllTelegramUrls();
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('Cron refresh error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// SINGLE POST REFRESH
app.get('/api/refresh-post/:uid/:postId', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { uid, postId } = req.params;
    const fresh = await refreshPostUrl(uid, postId);
    if (!fresh) return res.status(404).json({ success: false, error: 'Post not found or not refreshable' });
    res.json({ success: true, video_url: fresh.video_url });
  } catch (e) {
    console.error('Single refresh error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// CORS preflight
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-cron-secret');
  res.sendStatus(204);
});

// *** CHANGE 4: global error handler with CORS headers ***
app.use((err, req, res, next) => {
  console.error('Global error handler:', err.message);
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, error: 'Upload error: ' + err.message });
  }
  res.status(500).json({ success: false, error: err.message || 'Server error' });
});

// 404
app.use((req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.status(404).json({ error: 'Route not found' });
});

// ============================================================
// 9. START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 ConneX backend v2 running on port ${PORT}`);
  console.log(`   Accepts: video + image`);
  console.log(`   Refresh interval: ${REFRESH_INTERVAL_MINUTES} min`);

  const intervalMs = REFRESH_INTERVAL_MINUTES * 60 * 1000;
  setInterval(() => {
    refreshAllTelegramUrls().catch((e) => console.error('Scheduled refresh failed:', e));
  }, intervalMs);

  setTimeout(() => {
    refreshAllTelegramUrls().catch(() => {});
  }, 5000);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down.');
  process.exit(0);
});

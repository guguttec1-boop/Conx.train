// ============================================================
// 📦 index.js – ConneX Backend Server
// ============================================================
// Handles video uploads → Telegram channel storage, and writes
// post metadata into usersdata/{uid}/posts/{postId}.
// Also refreshes Telegram file URLs every 30 minutes because
// those URLs expire after ~1 hour.
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

// How often to refresh Telegram URLs (minutes). Default 30.
const REFRESH_INTERVAL_MINUTES = Number(process.env.REFRESH_INTERVAL_MINUTES) || 30;

// Optional: shared secret protecting the /api/cron/refresh endpoint.
// Leave unset during dev; set it in production.
const CRON_SECRET = process.env.CRON_SECRET || '';

// ============================================================
// 2. VALIDATE ENV VARS (fail fast with a clear message)
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
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // Telegram bot API limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'), false);
  },
});

// ============================================================
// 5. TELEGRAM HELPERS
// ============================================================

async function uploadToTelegram(videoBuffer, caption = '') {
  const form = new FormData();
  form.append('chat_id', TELEGRAM_CHANNEL_ID);
  form.append('video', videoBuffer, {
    filename: `video_${Date.now()}.mp4`,
    contentType: 'video/mp4',
  });
  if (caption) form.append('caption', caption);

  const response = await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`,
    form,
    { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity }
  );

  const result = response.data;
  if (!result.ok) {
    throw new Error(`Telegram error: ${result.description}`);
  }

  const videoFileId = result.result.video.file_id;
  const fileInfo = await axios.get(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${videoFileId}`
  );
  const filePath = fileInfo.data.result.file_path;
  const videoUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

  return {
    video_url: videoUrl,
    file_id: videoFileId,
    file_path: filePath,
    message_id: result.result.message_id,
  };
}

/**
 * Refresh a single Telegram file ID → returns { video_url, file_path }
 * or null if the file is no longer retrievable.
 */
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
// 6. POST STORAGE — usersdata/{uid}/posts/{postId}
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
// 7. TELEGRAM URL REFRESH (the 30-minute job)
// ============================================================

async function refreshAllTelegramUrls() {
  const started = Date.now();
  console.log('🔄 Refreshing Telegram URLs for all posts…');

  const usersSnap = await db.ref('usersdata').get();
  const users = usersSnap.val() || {};

  const updates = {};
  let scanned = 0;
  let refreshed = 0;
  let failed = 0;

  for (const uid of Object.keys(users)) {
    const posts = (users[uid] && users[uid].posts) || {};
    for (const postId of Object.keys(posts)) {
      const post = posts[postId] || {};
      if (!post.telegram_file_id) continue;

      scanned++;
      const fresh = await refreshTelegramFileUrl(post.telegram_file_id);
      if (!fresh) {
        failed++;
        continue;
      }

      updates[`usersdata/${uid}/posts/${postId}/video_url`] = fresh.video_url;
      updates[`usersdata/${uid}/posts/${postId}/telegram_file_path`] = fresh.file_path;
      updates[`usersdata/${uid}/posts/${postId}/video_url_refreshed_at`] = Date.now();
      refreshed++;
    }
  }

  if (Object.keys(updates).length) {
    await db.ref().update(updates);
  }

  const ms = Date.now() - started;
  console.log(`✅ Refresh done in ${ms}ms — scanned: ${scanned}, refreshed: ${refreshed}, failed: ${failed}`);
  return { scanned, refreshed, failed, ms };
}

/**
 * Refresh a single post's URL by path.
 */
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
    refresh_interval_minutes: REFRESH_INTERVAL_MINUTES,
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

/**
 * POST /api/upload
 * Body (multipart/form-data): video (file), caption, hashtags, uid
 */
app.post('/api/upload', upload.single('video'), async (req, res) => {
  try {
    const { caption = '', hashtags = '', uid = null } = req.body;
    const videoFile = req.file;

    if (!videoFile) {
      return res.status(400).json({ success: false, error: 'No video file provided' });
    }
    if (!uid) {
      return res.status(400).json({ success: false, error: 'User ID (uid) is required' });
    }

    const telegramResult = await uploadToTelegram(videoFile.buffer, caption);

    const postData = {
      uid,
      type: 'video',
      caption,
      hashtags: hashtags || '',
      video_url: telegramResult.video_url,
      telegram_file_id: telegramResult.file_id,
      telegram_file_path: telegramResult.file_path,
      telegram_message_id: telegramResult.message_id,
      video_url_refreshed_at: Date.now(),
    };

    const postId = await storePostInFirebase(uid, postData);

    res.json({
      success: true,
      post_id: postId,
      video_url: telegramResult.video_url,
      message: 'Video uploaded and post created.',
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
});

/**
 * POST /api/cron/refresh
 * Manually trigger the Telegram URL refresh job.
 * Protect with header: x-cron-secret: <CRON_SECRET>
 * (If CRON_SECRET is unset, the endpoint is open — use only in dev.)
 */
app.post('/api/cron/refresh', async (req, res) => {
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

/**
 * GET /api/refresh-post/:uid/:postId
 * Refresh a single post's Telegram URL. Useful when a video fails to play.
 * Public — safe because it only re-signs an existing Telegram file.
 */
app.get('/api/refresh-post/:uid/:postId', async (req, res) => {
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

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ============================================================
// 9. START SERVER + SCHEDULE REFRESH
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 ConneX backend running on port ${PORT}`);

  // Internal scheduler — fires every REFRESH_INTERVAL_MINUTES.
  // NOTE: On Render's free tier the instance sleeps when idle, so
  // setInterval may not fire reliably. Use an external cron hitting
  // /api/cron/refresh for guaranteed timing (see notes below).
  const intervalMs = REFRESH_INTERVAL_MINUTES * 60 * 1000;
  setInterval(() => {
    refreshAllTelegramUrls().catch((e) =>
      console.error('Scheduled refresh failed:', e)
    );
  }, intervalMs);

  // Also run one refresh shortly after boot (5s delay)
  setTimeout(() => {
    refreshAllTelegramUrls().catch(() => {});
  }, 5000);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down.');
  process.exit(0);
});

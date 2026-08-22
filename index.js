// ============================================================
// 📦 index.js – ConneX Backend Server
// ============================================================
// This server handles video uploads, stores post metadata in
// Firebase Realtime Database, and interacts with Telegram to
// obtain a video URL. It also returns the post ID so the frontend
// can associate the post with the uploading user's uid.
// ============================================================

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

// 🔥 Firebase Admin SDK (for server-side database operations)
const admin = require('firebase-admin');

// ============================================================
// 1. CONFIGURATION – set environment variables or hardcode
// ============================================================
const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8625518587:AAEBqZfKb_liszvYXAZebRy8WT5vtn7jCIY';
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '-1004394988713';

// Firebase Database URL (from your config)
const FIREBASE_DATABASE_URL = 'https://droplet-trading-default-rtdb.firebaseio.com/';
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : {
      projectId: 'droplet-trading',
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL || 'firebase-adminsdk@droplet-trading.iam.gserviceaccount.com',
    };

// ============================================================
// 2. INITIALIZE FIREBASE ADMIN
// ============================================================
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(FIREBASE_SERVICE_ACCOUNT),
    databaseURL: FIREBASE_DATABASE_URL,
  });
}
const db = admin.database();

// ============================================================
// 3. EXPRESS APP SETUP
// ============================================================
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configure multer for in‑memory file storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'), false);
    }
  },
});

// ============================================================
// 4. TELEGRAM HELPERS
// ============================================================

/**
 * Upload a video buffer to Telegram and return the file path/URL.
 */
async function uploadToTelegram(videoBuffer, caption = '') {
  const form = new FormData();
  form.append('chat_id', TELEGRAM_CHANNEL_ID);
  form.append('video', videoBuffer, {
    filename: `video_${Date.now()}.mp4`,
    contentType: 'video/mp4',
  });
  if (caption) form.append('caption', caption);

  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`,
      form,
      { headers: form.getHeaders() }
    );

    const result = response.data;
    if (!result.ok) {
      throw new Error(`Telegram error: ${result.description}`);
    }

    const videoFileId = result.result.video.file_id;
    // Get file path
    const fileInfo = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${videoFileId}`
    );
    const filePath = fileInfo.data.result.file_path;
    const videoUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

    // Return video URL and file ID
    return {
      video_url: videoUrl,
      file_id: videoFileId,
      file_path: filePath,
      message_id: result.result.message_id,
    };
  } catch (error) {
    console.error('Telegram upload error:', error);
    throw new Error('Failed to upload video to Telegram: ' + error.message);
  }
}

/**
 * Store post metadata in Firebase Realtime Database under /posts.
 * The uid is stored so the frontend can display the correct author.
 */
async function storePostInFirebase(postData) {
  const postsRef = db.ref('posts');
  const newPostRef = postsRef.push();
  await newPostRef.set({
    ...postData,
    created_at: Date.now(),
    likes: 0,
    views: 0,
    comments: 0,
  });
  return newPostRef.key; // return the auto‑generated post ID
}

// ============================================================
// 5. ROUTES
// ============================================================

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'ConneX backend is running' });
});

/**
 * POST /api/upload – upload a video, store in Telegram,
 * save post metadata in Firebase with uid, and return the post ID.
 */
app.post('/api/upload', upload.single('video'), async (req, res) => {
  try {
    // 1. Extract fields
    const { caption = '', hashtags = '', uid = null } = req.body;
    const videoFile = req.file;

    if (!videoFile) {
      return res.status(400).json({ success: false, error: 'No video file provided' });
    }

    // 2. Validate uid – if missing, we cannot associate the post with a user
    if (!uid) {
      // You can choose to reject or allow anonymous; we'll reject for consistency
      return res.status(400).json({ success: false, error: 'User ID (uid) is required' });
    }

    // 3. Upload to Telegram
    const telegramResult = await uploadToTelegram(videoFile.buffer, caption);

    // 4. Build post object (store only uid, no authorName/authorAvatar)
    const postData = {
      uid: uid, // 👈 critical – links to the user's profile
      type: 'video',
      caption: caption,
      hashtags: hashtags || '',
      video_url: telegramResult.video_url,
      telegram_file_id: telegramResult.file_id,
      telegram_file_path: telegramResult.file_path,
      telegram_message_id: telegramResult.message_id,
      // Do NOT store authorName or authorAvatar – they are looked up via profile
    };

    // 5. Save to Firebase and get post ID
    const postId = await storePostInFirebase(postData);

    // 6. Return success with post ID
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

// Catch-all for undefined routes
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ============================================================
// 6. START THE SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 ConneX backend running on port ${PORT}`);
});

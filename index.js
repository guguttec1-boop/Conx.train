// ============================================================
// 📦 index.js – ConneX Backend Server
// ============================================================
// Supports:
//   • Text posts
//   • Single image
//   • Single video
//   • Multiple images/videos (album)
//   • Telegram channel storage
//   • Firebase Realtime Database
//   • Automatic Telegram URL regeneration
//
// Firebase structure:
//
// usersdata/{uid}/posts/{postId}
//
// {
//   postId,
//   uid,
//   type,
//   caption,
//   hashtags,
//   createdAt,
//   totalLikes,
//   totalViews,
//   totalVotes,
//   totalComments,
//   album: {
//      images: [],
//      videos: []
//   }
// }
//
// Telegram file_id + file_path are permanently stored so URLs
// can be regenerated after deployment or on every refresh.
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

// Refresh interval.
// Example:
// REFRESH_INTERVAL_MINUTES=30
//
// If not provided, default = 30 minutes.
const REFRESH_INTERVAL_MINUTES =
  Number(process.env.REFRESH_INTERVAL_MINUTES) || 30;

const CRON_SECRET = process.env.CRON_SECRET || '';


// ============================================================
// 2. VALIDATE ENVIRONMENT VARIABLES
// ============================================================

const missing = [];

if (!TELEGRAM_BOT_TOKEN) {
  missing.push('TELEGRAM_BOT_TOKEN');
}

if (!TELEGRAM_CHANNEL_ID) {
  missing.push('TELEGRAM_CHANNEL_ID');
}

if (!FIREBASE_SERVICE_ACCOUNT.privateKey) {
  missing.push('FIREBASE_PRIVATE_KEY');
}

if (!FIREBASE_SERVICE_ACCOUNT.clientEmail) {
  missing.push('FIREBASE_CLIENT_EMAIL');
}

if (missing.length) {
  console.error(
    '❌ Missing required environment variables:',
    missing.join(', ')
  );

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
// 4. EXPRESS APP
// ============================================================

const app = express();

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-cron-secret',
    ],
  })
);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));


// ============================================================
// 5. MULTER
// ============================================================
//
// Accept both:
//
//   media[]
//   video
//
// This keeps compatibility with your current frontend.
//
// Maximum:
//   10 files per post
//
// Maximum file:
//   50 MB
// ============================================================

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 10,
  },

  fileFilter: (req, file, cb) => {
    const isVideo = file.mimetype.startsWith('video/');
    const isImage = file.mimetype.startsWith('image/');

    if (isVideo || isImage) {
      cb(null, true);
    } else {
      cb(
        new Error(
          'Only image and video files are allowed'
        ),
        false
      );
    }
  },
});


// ============================================================
// 6. TELEGRAM HELPERS
// ============================================================

/**
 * Build a public Telegram file URL.
 */
function buildTelegramFileUrl(filePath) {
  return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
}


/**
 * Get fresh Telegram file information.
 */
async function getTelegramFile(fileId) {
  const response = await axios.get(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile`,
    {
      params: {
        file_id: fileId,
      },
    }
  );

  if (!response.data.ok) {
    throw new Error(
      response.data.description || 'Telegram getFile failed'
    );
  }

  return response.data.result;
}


/**
 * Refresh ONE Telegram file.
 */
async function refreshTelegramFile(fileId) {
  try {
    const fileInfo = await getTelegramFile(fileId);

    return {
      file_id: fileId,
      file_path: fileInfo.file_path,
      url: buildTelegramFileUrl(fileInfo.file_path),
    };
  } catch (error) {
    console.error(
      `❌ Failed refreshing Telegram file ${fileId}:`,
      error.message
    );

    return null;
  }
}


// ============================================================
// 7. SEND SINGLE MEDIA TO TELEGRAM
// ============================================================

async function uploadSingleMedia(file, caption = '') {
  const isImage = file.mimetype.startsWith('image/');
  const endpoint = isImage ? 'sendPhoto' : 'sendVideo';

  const form = new FormData();

  form.append('chat_id', TELEGRAM_CHANNEL_ID);

  if (isImage) {
    form.append('photo', file.buffer, {
      filename:
        file.originalname ||
        `image_${Date.now()}.jpg`,
      contentType: file.mimetype,
    });
  } else {
    form.append('video', file.buffer, {
      filename:
        file.originalname ||
        `video_${Date.now()}.mp4`,
      contentType: file.mimetype,
    });
  }

  if (caption) {
    form.append('caption', caption);
  }

  const response = await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`,
    form,
    {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );

  if (!response.data.ok) {
    throw new Error(
      response.data.description || 'Telegram upload failed'
    );
  }

  const result = response.data.result;

  let fileId;

  if (isImage) {
    const photos = result.photo || [];

    if (!photos.length) {
      throw new Error('Telegram returned no photo');
    }

    fileId = photos[photos.length - 1].file_id;
  } else {
    if (!result.video) {
      throw new Error('Telegram returned no video');
    }

    fileId = result.video.file_id;
  }

  const fileInfo = await getTelegramFile(fileId);

  return {
    type: isImage ? 'image' : 'video',

    file_id: fileId,

    file_path: fileInfo.file_path,

    url: buildTelegramFileUrl(
      fileInfo.file_path
    ),

    message_id: result.message_id,
  };
}


// ============================================================
// 8. SEND MULTIPLE MEDIA AS TELEGRAM ALBUM
// ============================================================
//
// Telegram media groups support up to 10 media items.
//
// Images and videos can be mixed.
//
// Caption is placed on the first item.
// ============================================================

async function uploadMediaAlbum(files, caption = '') {
  if (!files || !files.length) {
    return [];
  }

  // If only one file, use the simpler method.
  if (files.length === 1) {
    return [
      await uploadSingleMedia(
        files[0],
        caption
      ),
    ];
  }

  if (files.length > 10) {
    throw new Error(
      'Telegram albums support a maximum of 10 media files.'
    );
  }

  const form = new FormData();

  form.append(
    'chat_id',
    TELEGRAM_CHANNEL_ID
  );

  const media = [];

  files.forEach((file, index) => {
    const isImage =
      file.mimetype.startsWith('image/');

    const telegramType =
      isImage ? 'photo' : 'video';

    const attachName = `media${index}`;

    const mediaItem = {
      type: telegramType,
      media: `attach://${attachName}`,
    };

    // Put caption on first media item.
    if (index === 0 && caption) {
      mediaItem.caption = caption;
    }

    media.push(mediaItem);

    form.append(
      attachName,
      file.buffer,
      {
        filename:
          file.originalname ||
          `${telegramType}_${Date.now()}_${index}`,
        contentType: file.mimetype,
      }
    );
  });

  form.append(
    'media',
    JSON.stringify(media)
  );

  const response = await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
    form,
    {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );

  if (!response.data.ok) {
    throw new Error(
      response.data.description ||
      'Telegram album upload failed'
    );
  }

  const messages = response.data.result || [];

  const output = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    let fileId;
    let type;

    if (message.photo) {
      const photos = message.photo;

      fileId =
        photos[photos.length - 1].file_id;

      type = 'image';
    } else if (message.video) {
      fileId =
        message.video.file_id;

      type = 'video';
    } else {
      continue;
    }

    const fileInfo =
      await getTelegramFile(fileId);

    output.push({
      type,

      file_id: fileId,

      file_path:
        fileInfo.file_path,

      url:
        buildTelegramFileUrl(
          fileInfo.file_path
        ),

      message_id:
        message.message_id,
    });
  }

  return output;
}


// ============================================================
// 9. STORE POST
// ============================================================

async function storePostInFirebase(
  uid,
  {
    type,
    caption,
    hashtags,
    media,
  }
) {
  const postsRef =
    db.ref(`usersdata/${uid}/posts`);

  const newPostRef =
    postsRef.push();

  const postId =
    newPostRef.key;

  const now = Date.now();

  const images =
    media
      .filter(item => item.type === 'image')
      .map(item => ({
        file_id: item.file_id,
        file_path: item.file_path,
        url: item.url,
      }));

  const videos =
    media
      .filter(item => item.type === 'video')
      .map(item => ({
        file_id: item.file_id,
        file_path: item.file_path,
        url: item.url,
      }));

  const post = {
    postId,

    uid,

    type,

    caption: caption || '',

    hashtags: hashtags || '',

    createdAt: now,

    totalLikes: 0,

    totalViews: 0,

    totalVotes: 0,

    totalComments: 0,

    album: {
      images,

      videos,
    },
  };

  await newPostRef.set(post);

  return {
    postId,
    post,
  };
}


// ============================================================
// 10. REFRESH ALL TELEGRAM URLS
// ============================================================

async function refreshAllTelegramUrls() {
  const started = Date.now();

  console.log(
    '🔄 Starting Telegram URL refresh...'
  );

  const usersSnap =
    await db.ref('usersdata').get();

  const users =
    usersSnap.val() || {};

  const updates = {};

  let postsScanned = 0;
  let filesScanned = 0;
  let filesRefreshed = 0;
  let filesFailed = 0;

  for (
    const uid of Object.keys(users)
  ) {
    const posts =
      users[uid]?.posts || {};

    for (
      const postId of Object.keys(posts)
    ) {
      const post =
        posts[postId];

      if (!post) {
        continue;
      }

      postsScanned++;

      const album =
        post.album || {};

      const images =
        album.images || [];

      const videos =
        album.videos || [];


      // ======================================================
      // IMAGES
      // ======================================================

      for (
        let i = 0;
        i < images.length;
        i++
      ) {
        const item =
          images[i];

        if (!item.file_id) {
          continue;
        }

        filesScanned++;

        const fresh =
          await refreshTelegramFile(
            item.file_id
          );

        if (!fresh) {
          filesFailed++;
          continue;
        }

        updates[
          `usersdata/${uid}/posts/${postId}/album/images/${i}/file_path`
        ] = fresh.file_path;

        updates[
          `usersdata/${uid}/posts/${postId}/album/images/${i}/url`
        ] = fresh.url;

        updates[
          `usersdata/${uid}/posts/${postId}/album/images/${i}/file_id`
        ] = fresh.file_id;

        filesRefreshed++;
      }


      // ======================================================
      // VIDEOS
      // ======================================================

      for (
        let i = 0;
        i < videos.length;
        i++
      ) {
        const item =
          videos[i];

        if (!item.file_id) {
          continue;
        }

        filesScanned++;

        const fresh =
          await refreshTelegramFile(
            item.file_id
          );

        if (!fresh) {
          filesFailed++;
          continue;
        }

        updates[
          `usersdata/${uid}/posts/${postId}/album/videos/${i}/file_path`
        ] = fresh.file_path;

        updates[
          `usersdata/${uid}/posts/${postId}/album/videos/${i}/url`
        ] = fresh.url;

        updates[
          `usersdata/${uid}/posts/${postId}/album/videos/${i}/file_id`
        ] = fresh.file_id;

        filesRefreshed++;
      }


      // ======================================================
      // REFRESH TIMESTAMP
      // ======================================================

      updates[
        `usersdata/${uid}/posts/${postId}/media_url_refreshed_at`
      ] = Date.now();
    }
  }

  if (Object.keys(updates).length) {
    await db.ref().update(updates);
  }

  const ms =
    Date.now() - started;

  console.log(
    `✅ Telegram refresh complete.
     Posts scanned: ${postsScanned}
     Files scanned: ${filesScanned}
     Files refreshed: ${filesRefreshed}
     Files failed: ${filesFailed}
     Time: ${ms}ms`
  );

  return {
    postsScanned,
    filesScanned,
    filesRefreshed,
    filesFailed,
    ms,
  };
}


// ============================================================
// 11. REFRESH ONE POST
// ============================================================

async function refreshPostUrl(
  uid,
  postId
) {
  const snap =
    await db
      .ref(
        `usersdata/${uid}/posts/${postId}`
      )
      .get();

  const post =
    snap.val();

  if (!post) {
    return null;
  }

  const album =
    post.album || {};

  const updates = {};

  let refreshed = 0;
  let failed = 0;


  // Images

  const images =
    album.images || [];

  for (
    let i = 0;
    i < images.length;
    i++
  ) {
    const item =
      images[i];

    if (!item.file_id) {
      continue;
    }

    const fresh =
      await refreshTelegramFile(
        item.file_id
      );

    if (!fresh) {
      failed++;
      continue;
    }

    updates[
      `album/images/${i}/file_path`
    ] = fresh.file_path;

    updates[
      `album/images/${i}/url`
    ] = fresh.url;

    refreshed++;
  }


  // Videos

  const videos =
    album.videos || [];

  for (
    let i = 0;
    i < videos.length;
    i++
  ) {
    const item =
      videos[i];

    if (!item.file_id) {
      continue;
    }

    const fresh =
      await refreshTelegramFile(
        item.file_id
      );

    if (!fresh) {
      failed++;
      continue;
    }

    updates[
      `album/videos/${i}/file_path`
    ] = fresh.file_path;

    updates[
      `album/videos/${i}/url`
    ] = fresh.url;

    refreshed++;
  }


  updates.media_url_refreshed_at =
    Date.now();

  await db
    .ref(
      `usersdata/${uid}/posts/${postId}`
    )
    .update(updates);

  return {
    refreshed,
    failed,
  };
}


// ============================================================
// 12. HEALTH
// ============================================================

app.get('/', (req, res) => {
  res.json({
    status: 'ok',

    message:
      'ConneX backend is running',

    version: 'v3',

    accepts: [
      'text',
      'image',
      'video',
      'album',
    ],

    refresh_interval_minutes:
      REFRESH_INTERVAL_MINUTES,
  });
});


app.get('/api/health', (req, res) => {
  res.json({
    ok: true,

    time: Date.now(),

    version: 'v3',

    refresh_interval_minutes:
      REFRESH_INTERVAL_MINUTES,
  });
});


// ============================================================
// 13. CREATE POST
// ============================================================
//
// Supports:
//
// POST /api/upload
//
// Form fields:
//
// uid
// caption
// hashtags
//
// Files:
//
// media
//
// OR:
//
// video
//
// No file = text post.
// ============================================================

app.post(
  '/api/upload',

  (req, res, next) => {
    upload.fields([
      {
        name: 'media',
        maxCount: 10,
      },
      {
        name: 'video',
        maxCount: 10,
      },
    ])(
      req,
      res,
      (err) => {
        if (err) {
          console.error(
            'Multer error:',
            err.message
          );

          res.header(
            'Access-Control-Allow-Origin',
            '*'
          );

          return res.status(400).json({
            success: false,
            error: err.message,
          });
        }

        next();
      }
    );
  },

  async (req, res) => {
    res.header(
      'Access-Control-Allow-Origin',
      '*'
    );

    try {
      const {
        caption = '',
        hashtags = '',
        uid = null,
      } = req.body;


      // ======================================================
      // VALIDATE UID
      // ======================================================

      if (!uid) {
        return res.status(400).json({
          success: false,
          error:
            'User ID (uid) is required',
        });
      }


      // ======================================================
      // COLLECT FILES
      // ======================================================

      const files = [];

      if (req.files?.media) {
        files.push(
          ...req.files.media
        );
      }

      if (req.files?.video) {
        files.push(
          ...req.files.video
        );
      }


      // ======================================================
      // DETERMINE POST TYPE
      // ======================================================

      let type = 'text';

      if (files.length === 1) {
        type =
          files[0].mimetype.startsWith('image/')
            ? 'image'
            : 'video';
      }

      if (files.length > 1) {
        type = 'album';
      }


      // ======================================================
      // TEXT POST
      // ======================================================

      if (files.length === 0) {
        const stored =
          await storePostInFirebase(
            uid,
            {
              type: 'text',
              caption,
              hashtags,
              media: [],
            }
          );

        console.log(
          `✅ Text post created:
           usersdata/${uid}/posts/${stored.postId}`
        );

        return res.json({
          success: true,

          post_id:
            stored.postId,

          type: 'text',

          message:
            'Text post created successfully.',
        });
      }


      // ======================================================
      // MEDIA POST
      // ======================================================

      console.log(
        `📤 Uploading ${files.length} media file(s)
         uid=${uid}`
      );

      const telegramMedia =
        await uploadMediaAlbum(
          files,
          caption
        );


      // ======================================================
      // STORE FIREBASE
      // ======================================================

      const stored =
        await storePostInFirebase(
          uid,
          {
            type,
            caption,
            hashtags,
            media: telegramMedia,
          }
        );


      console.log(
        `✅ Post created:
         usersdata/${uid}/posts/${stored.postId}`
      );


      // ======================================================
      // RESPONSE
      // ======================================================

      return res.json({
        success: true,

        post_id:
          stored.postId,

        type,

        album:
          stored.post.album,

        message:
          'Post uploaded successfully.',
      });

    } catch (error) {
      console.error(
        '❌ Upload error:',
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error.message ||
          'Internal server error',
      });
    }
  }
);


// ============================================================
// 14. MANUAL REFRESH ALL
// ============================================================

app.post(
  '/api/cron/refresh',
  async (req, res) => {
    res.header(
      'Access-Control-Allow-Origin',
      '*'
    );

    if (CRON_SECRET) {
      const provided =
        req.headers['x-cron-secret'] ||
        req.query.secret;

      if (provided !== CRON_SECRET) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
        });
      }
    }

    try {
      const result =
        await refreshAllTelegramUrls();

      res.json({
        success: true,
        ...result,
      });

    } catch (error) {
      console.error(
        'Cron refresh error:',
        error
      );

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);


// ============================================================
// 15. REFRESH SINGLE POST
// ============================================================

app.get(
  '/api/refresh-post/:uid/:postId',
  async (req, res) => {
    res.header(
      'Access-Control-Allow-Origin',
      '*'
    );

    try {
      const {
        uid,
        postId,
      } = req.params;

      const result =
        await refreshPostUrl(
          uid,
          postId
        );

      if (!result) {
        return res.status(404).json({
          success: false,
          error:
            'Post not found',
        });
      }

      res.json({
        success: true,
        ...result,
      });

    } catch (error) {
      console.error(
        'Single refresh error:',
        error
      );

      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);


// ============================================================
// 16. CORS PREFLIGHT
// ============================================================

app.options('*', (req, res) => {
  res.header(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, x-cron-secret'
  );

  res.sendStatus(204);
});


// ============================================================
// 17. GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (err, req, res, next) => {
    console.error(
      'Global error handler:',
      err.message
    );

    res.header(
      'Access-Control-Allow-Origin',
      '*'
    );

    if (
      err instanceof multer.MulterError
    ) {
      return res.status(400).json({
        success: false,

        error:
          'Upload error: ' +
          err.message,
      });
    }

    res.status(500).json({
      success: false,

      error:
        err.message ||
        'Server error',
    });
  }
);


// ============================================================
// 18. 404
// ============================================================

app.use(
  (req, res) => {
    res.header(
      'Access-Control-Allow-Origin',
      '*'
    );

    res.status(404).json({
      error: 'Route not found',
    });
  }
);


// ============================================================
// 19. START SERVER
// ============================================================

app.listen(
  PORT,
  async () => {
    console.log(
      `🚀 ConneX backend v3 running on port ${PORT}`
    );

    console.log(
      `📦 Supports:
       text
       image
       video
       album`
    );

    console.log(
      `🔄 URL refresh interval:
       ${REFRESH_INTERVAL_MINUTES} minutes`
    );


    // ========================================================
    // IMPORTANT:
    // REFRESH IMMEDIATELY AFTER EVERY DEPLOYMENT
    // ========================================================

    setTimeout(
      async () => {
        try {
          console.log(
            '🚀 Deployment startup refresh...'
          );

          await refreshAllTelegramUrls();

        } catch (error) {
          console.error(
            '❌ Startup refresh failed:',
            error.message
          );
        }
      },

      5000
    );


    // ========================================================
    // PERIODIC REFRESH
    // ========================================================

    const intervalMs =
      REFRESH_INTERVAL_MINUTES *
      60 *
      1000;

    setInterval(
      async () => {
        try {
          await refreshAllTelegramUrls();

        } catch (error) {
          console.error(
            '❌ Scheduled refresh failed:',
            error.message
          );
        }
      },

      intervalMs
    );
  }
);


// ============================================================
// 20. GRACEFUL SHUTDOWN
// ============================================================

process.on(
  'SIGTERM',
  () => {
    console.log(
      'SIGTERM received, shutting down.'
    );

    process.exit(0);
  }
);

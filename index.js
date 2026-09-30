// ============================================================
// 📦 index.js – ConneX Backend Server
// ============================================================
// ConneX posting backend
//
// Supports:
//   • Text posts
//   • Single image
//   • Single video
//   • Multiple images
//   • Multiple videos
//   • Mixed image/video albums
//
// Flow:
//
// WEBSITE
//    ↓
// RENDER /api/upload
//    ↓
// TELEGRAM CHANNEL
//    ↓
// RENDER receives Telegram file information
//    ↓
// FIREBASE REALTIME DATABASE
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
//
//   telegram: {
//      channelId,
//      messages: [
//        {
//          message_id,
//          url
//        }
//      ]
//   },
//
//   album: {
//      images: [
//        {
//          file_id,
//          file_path,
//          url,
//          telegram_url,
//          message_id
//        }
//      ],
//
//      videos: [
//        {
//          file_id,
//          file_path,
//          url,
//          telegram_url,
//          message_id
//        }
//      ]
//   }
// }
//
// Telegram media URLs are refreshed automatically.
//
// Telegram channel post URLs do NOT need refreshing.
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

const PORT =
  process.env.PORT || 3000;


const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;


const TELEGRAM_CHANNEL_ID =
  process.env.TELEGRAM_CHANNEL_ID;


// IMPORTANT:
// If your Telegram channel is:
//
// https://t.me/ConneXOfficial
//
// then set:
//
// TELEGRAM_CHANNEL_USERNAME=ConneXOfficial
//
// Do NOT include https://t.me/
const TELEGRAM_CHANNEL_USERNAME =
  process.env.TELEGRAM_CHANNEL_USERNAME || '';


const FIREBASE_DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  'https://droplet-trading-default-rtdb.firebaseio.com/';


// Firebase service account
const FIREBASE_SERVICE_ACCOUNT =
  process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT
      )
    : {
        projectId:
          process.env.FIREBASE_PROJECT_ID ||
          'droplet-trading',

        privateKey:
          (
            process.env.FIREBASE_PRIVATE_KEY ||
            ''
          ).replace(/\\n/g, '\n'),

        clientEmail:
          process.env.FIREBASE_CLIENT_EMAIL,
      };


// ============================================================
// Refresh interval
//
// Example:
//
// REFRESH_INTERVAL_MINUTES=30
//
// Default = 30 minutes
//
// The server also performs one refresh shortly after deployment.
// ============================================================

const REFRESH_INTERVAL_MINUTES =
  Number(
    process.env.REFRESH_INTERVAL_MINUTES
  ) || 30;


const CRON_SECRET =
  process.env.CRON_SECRET || '';


// ============================================================
// 2. VALIDATE ENVIRONMENT VARIABLES
// ============================================================

const missing = [];


if (!TELEGRAM_BOT_TOKEN) {
  missing.push(
    'TELEGRAM_BOT_TOKEN'
  );
}


if (!TELEGRAM_CHANNEL_ID) {
  missing.push(
    'TELEGRAM_CHANNEL_ID'
  );
}


if (!FIREBASE_SERVICE_ACCOUNT.privateKey) {
  missing.push(
    'FIREBASE_PRIVATE_KEY'
  );
}


if (!FIREBASE_SERVICE_ACCOUNT.clientEmail) {
  missing.push(
    'FIREBASE_CLIENT_EMAIL'
  );
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

    credential:
      admin.credential.cert(
        FIREBASE_SERVICE_ACCOUNT
      ),

    databaseURL:
      FIREBASE_DATABASE_URL,
  });
}


const db =
  admin.database();


// ============================================================
// 4. EXPRESS APP
// ============================================================

const app =
  express();


app.use(
  cors({

    origin: '*',

    methods: [
      'GET',
      'POST',
      'OPTIONS',
    ],

    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-cron-secret',
    ],
  })
);


app.use(
  express.json({
    limit: '50mb',
  })
);


app.use(
  express.urlencoded({
    extended: true,
    limit: '50mb',
  })
);


// ============================================================
// 5. MULTER
// ============================================================
//
// Supports:
//
// media[]
//
// and also:
//
// video[]
//
// Maximum:
//   10 files
//
// Maximum file:
//   50 MB
// ============================================================

const upload =
  multer({

    storage:
      multer.memoryStorage(),

    limits: {

      fileSize:
        50 * 1024 * 1024,

      files: 10,
    },

    fileFilter:
      (req, file, cb) => {

        const isVideo =
          file.mimetype.startsWith(
            'video/'
          );

        const isImage =
          file.mimetype.startsWith(
            'image/'
          );

        if (
          isVideo ||
          isImage
        ) {

          cb(
            null,
            true
          );

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
// 6. TELEGRAM URL HELPERS
// ============================================================


/**
 * Build Telegram file URL.
 *
 * This URL can change/expire and therefore
 * is refreshed periodically.
 */
function buildTelegramFileUrl(
  filePath
) {

  return (
    `https://api.telegram.org/file/bot` +
    `${TELEGRAM_BOT_TOKEN}/` +
    `${filePath}`
  );
}


/**
 * Build Telegram channel message URL.
 *
 * Example:
 *
 * https://t.me/ConneXOfficial/123
 */
function buildTelegramMessageUrl(
  messageId
) {

  if (
    !TELEGRAM_CHANNEL_USERNAME ||
    !messageId
  ) {

    return null;
  }

  return (
    `https://t.me/` +
    `${TELEGRAM_CHANNEL_USERNAME}/` +
    `${messageId}`
  );
}


// ============================================================
// 7. GET TELEGRAM FILE
// ============================================================

async function getTelegramFile(
  fileId
) {

  const response =
    await axios.get(

      `https://api.telegram.org/bot` +
      `${TELEGRAM_BOT_TOKEN}/getFile`,

      {
        params: {
          file_id: fileId,
        },
      }
    );


  if (
    !response.data.ok
  ) {

    throw new Error(
      response.data.description ||
      'Telegram getFile failed'
    );
  }


  return response.data.result;
}


// ============================================================
// 8. REFRESH ONE TELEGRAM FILE
// ============================================================

async function refreshTelegramFile(
  fileId
) {

  try {

    const fileInfo =
      await getTelegramFile(
        fileId
      );


    return {

      file_id:
        fileId,

      file_path:
        fileInfo.file_path,

      url:
        buildTelegramFileUrl(
          fileInfo.file_path
        ),
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
// 9. UPLOAD SINGLE MEDIA
// ============================================================

async function uploadSingleMedia(
  file,
  caption = ''
) {

  const isImage =
    file.mimetype.startsWith(
      'image/'
    );


  const endpoint =
    isImage
      ? 'sendPhoto'
      : 'sendVideo';


  const form =
    new FormData();


  form.append(
    'chat_id',
    TELEGRAM_CHANNEL_ID
  );


  if (isImage) {

    form.append(
      'photo',
      file.buffer,
      {

        filename:
          file.originalname ||
          `image_${Date.now()}.jpg`,

        contentType:
          file.mimetype,
      }
    );

  } else {

    form.append(
      'video',
      file.buffer,
      {

        filename:
          file.originalname ||
          `video_${Date.now()}.mp4`,

        contentType:
          file.mimetype,
      }
    );
  }


  if (caption) {

    form.append(
      'caption',
      caption
    );
  }


  const response =
    await axios.post(

      `https://api.telegram.org/bot` +
      `${TELEGRAM_BOT_TOKEN}/` +
      `${endpoint}`,

      form,

      {

        headers:
          form.getHeaders(),

        maxBodyLength:
          Infinity,

        maxContentLength:
          Infinity,
      }
    );


  if (
    !response.data.ok
  ) {

    throw new Error(
      response.data.description ||
      'Telegram upload failed'
    );
  }


  const result =
    response.data.result;


  let fileId;


  if (isImage) {

    const photos =
      result.photo || [];


    if (!photos.length) {

      throw new Error(
        'Telegram returned no photo'
      );
    }


    // Highest resolution photo
    fileId =
      photos[
        photos.length - 1
      ].file_id;

  } else {

    if (!result.video) {

      throw new Error(
        'Telegram returned no video'
      );
    }


    fileId =
      result.video.file_id;
  }


  const fileInfo =
    await getTelegramFile(
      fileId
    );


  const messageId =
    result.message_id;


  return {

    type:
      isImage
        ? 'image'
        : 'video',

    file_id:
      fileId,

    file_path:
      fileInfo.file_path,

    url:
      buildTelegramFileUrl(
        fileInfo.file_path
      ),

    message_id:
      messageId,

    telegram_url:
      buildTelegramMessageUrl(
        messageId
      ),
  };
}


// ============================================================
// 10. UPLOAD MULTIPLE MEDIA AS TELEGRAM ALBUM
// ============================================================
//
// Telegram media groups support up to 10 items.
//
// Images and videos may be mixed.
//
// Caption is attached to the first item.
// ============================================================

async function uploadMediaAlbum(
  files,
  caption = ''
) {

  if (
    !files ||
    !files.length
  ) {

    return [];
  }


  // ==========================================================
  // ONE FILE
  // ==========================================================

  if (
    files.length === 1
  ) {

    return [

      await uploadSingleMedia(
        files[0],
        caption
      ),

    ];
  }


  // ==========================================================
  // MAXIMUM 10
  // ==========================================================

  if (
    files.length > 10
  ) {

    throw new Error(
      'Telegram albums support a maximum of 10 media files.'
    );
  }


  const form =
    new FormData();


  form.append(
    'chat_id',
    TELEGRAM_CHANNEL_ID
  );


  const media = [];


  files.forEach(
    (file, index) => {

      const isImage =
        file.mimetype.startsWith(
          'image/'
        );


      const telegramType =
        isImage
          ? 'photo'
          : 'video';


      const attachName =
        `media${index}`;


      const mediaItem = {

        type:
          telegramType,

        media:
          `attach://${attachName}`,
      };


      // Caption only on first item
      if (
        index === 0 &&
        caption
      ) {

        mediaItem.caption =
          caption;
      }


      media.push(
        mediaItem
      );


      form.append(
        attachName,
        file.buffer,
        {

          filename:
            file.originalname ||
            `${telegramType}_${Date.now()}_${index}`,

          contentType:
            file.mimetype,
        }
      );
    }
  );


  form.append(
    'media',
    JSON.stringify(
      media
    )
  );


  const response =
    await axios.post(

      `https://api.telegram.org/bot` +
      `${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,

      form,

      {

        headers:
          form.getHeaders(),

        maxBodyLength:
          Infinity,

        maxContentLength:
          Infinity,
      }
    );


  if (
    !response.data.ok
  ) {

    throw new Error(
      response.data.description ||
      'Telegram album upload failed'
    );
  }


  const messages =
    response.data.result || [];


  const output = [];


  for (
    let i = 0;
    i < messages.length;
    i++
  ) {

    const message =
      messages[i];


    let fileId;
    let type;


    if (
      message.photo
    ) {

      const photos =
        message.photo;


      fileId =
        photos[
          photos.length - 1
        ].file_id;


      type =
        'image';

    } else if (
      message.video
    ) {

      fileId =
        message.video.file_id;


      type =
        'video';

    } else {

      continue;
    }


    const fileInfo =
      await getTelegramFile(
        fileId
      );


    const messageId =
      message.message_id;


    output.push({

      type,

      file_id:
        fileId,

      file_path:
        fileInfo.file_path,

      url:
        buildTelegramFileUrl(
          fileInfo.file_path
        ),

      message_id:
        messageId,

      telegram_url:
        buildTelegramMessageUrl(
          messageId
        ),
    });
  }


  return output;
}


// ============================================================
// 11. STORE POST IN FIREBASE
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
    db.ref(
      `usersdata/${uid}/posts`
    );


  const newPostRef =
    postsRef.push();


  const postId =
    newPostRef.key;


  const now =
    Date.now();


  // ==========================================================
  // IMAGES
  // ==========================================================

  const images =
    media

      .filter(
        item =>
          item.type === 'image'
      )

      .map(
        item => ({

          file_id:
            item.file_id,

          file_path:
            item.file_path,

          url:
            item.url,

          telegram_url:
            item.telegram_url ||
            null,

          message_id:
            item.message_id ||
            null,
        })
      );


  // ==========================================================
  // VIDEOS
  // ==========================================================

  const videos =
    media

      .filter(
        item =>
          item.type === 'video'
      )

      .map(
        item => ({

          file_id:
            item.file_id,

          file_path:
            item.file_path,

          url:
            item.url,

          telegram_url:
            item.telegram_url ||
            null,

          message_id:
            item.message_id ||
            null,
        })
      );


  // ==========================================================
  // TELEGRAM MESSAGE LINKS
  // ==========================================================

  const telegramMessages =
    media

      .filter(
        item =>
          item.telegram_url
      )

      .map(
        item => ({

          message_id:
            item.message_id,

          url:
            item.telegram_url,
        })
      );


  // ==========================================================
  // POST OBJECT
  // ==========================================================

  const post = {

    postId,

    uid,

    type,

    caption:
      caption || '',

    hashtags:
      hashtags || '',

    createdAt:
      now,

    totalLikes:
      0,

    totalViews:
      0,

    totalVotes:
      0,

    totalComments:
      0,


    // ========================================================
    // TELEGRAM
    // ========================================================

    telegram: {

      channelId:
        TELEGRAM_CHANNEL_ID,

      messages:
        telegramMessages,
    },


    // ========================================================
    // MEDIA ALBUM
    // ========================================================

    album: {

      images,

      videos,
    },
  };


  await newPostRef.set(
    post
  );


  return {

    postId,

    post,
  };
}


// ============================================================
// 12. REFRESH ALL TELEGRAM MEDIA URLS
// ============================================================
//
// This refreshes:
//
// album.images[].url
// album.images[].file_path
//
// album.videos[].url
// album.videos[].file_path
//
// It does NOT modify:
//
// telegram.messages[].url
// album.images[].telegram_url
// album.videos[].telegram_url
//
// because Telegram message links are permanent.
// ============================================================

async function refreshAllTelegramUrls() {

  const started =
    Date.now();


  console.log(
    '🔄 Starting Telegram URL refresh...'
  );


  const usersSnap =
    await db
      .ref('usersdata')
      .get();


  const users =
    usersSnap.val() || {};


  const updates = {};


  let postsScanned =
    0;

  let filesScanned =
    0;

  let filesRefreshed =
    0;

  let filesFailed =
    0;


  // ==========================================================
  // USERS
  // ==========================================================

  for (
    const uid of Object.keys(
      users
    )
  ) {

    const posts =
      users[uid]?.posts || {};


    // ========================================================
    // POSTS
    // ========================================================

    for (
      const postId of Object.keys(
        posts
      )
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


        if (
          !item.file_id
        ) {

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
          `usersdata/${uid}/posts/${postId}/album/images/${i}/file_id`
        ] =
          fresh.file_id;


        updates[
          `usersdata/${uid}/posts/${postId}/album/images/${i}/file_path`
        ] =
          fresh.file_path;


        updates[
          `usersdata/${uid}/posts/${postId}/album/images/${i}/url`
        ] =
          fresh.url;


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


        if (
          !item.file_id
        ) {

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
          `usersdata/${uid}/posts/${postId}/album/videos/${i}/file_id`
        ] =
          fresh.file_id;


        updates[
          `usersdata/${uid}/posts/${postId}/album/videos/${i}/file_path`
        ] =
          fresh.file_path;


        updates[
          `usersdata/${uid}/posts/${postId}/album/videos/${i}/url`
        ] =
          fresh.url;


        filesRefreshed++;
      }


      // ======================================================
      // REFRESH TIMESTAMP
      // ======================================================

      updates[
        `usersdata/${uid}/posts/${postId}/media_url_refreshed_at`
      ] =
        Date.now();
    }
  }


  // ==========================================================
  // WRITE ALL UPDATES AT ONCE
  // ==========================================================

  if (
    Object.keys(updates).length
  ) {

    await db
      .ref()
      .update(
        updates
      );
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
// 13. REFRESH ONE POST
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


  let refreshed =
    0;


  let failed =
    0;


  // ==========================================================
  // IMAGES
  // ==========================================================

  const images =
    album.images || [];


  for (
    let i = 0;
    i < images.length;
    i++
  ) {

    const item =
      images[i];


    if (
      !item.file_id
    ) {

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
      `album/images/${i}/file_id`
    ] =
      fresh.file_id;


    updates[
      `album/images/${i}/file_path`
    ] =
      fresh.file_path;


    updates[
      `album/images/${i}/url`
    ] =
      fresh.url;


    refreshed++;
  }


  // ==========================================================
  // VIDEOS
  // ==========================================================

  const videos =
    album.videos || [];


  for (
    let i = 0;
    i < videos.length;
    i++
  ) {

    const item =
      videos[i];


    if (
      !item.file_id
    ) {

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
      `album/videos/${i}/file_id`
    ] =
      fresh.file_id;


    updates[
      `album/videos/${i}/file_path`
    ] =
      fresh.file_path;


    updates[
      `album/videos/${i}/url`
    ] =
      fresh.url;


    refreshed++;
  }


  updates.media_url_refreshed_at =
    Date.now();


  await db
    .ref(
      `usersdata/${uid}/posts/${postId}`
    )
    .update(
      updates
    );


  return {

    refreshed,

    failed,
  };
}


// ============================================================
// 14. HOME
// ============================================================

app.get(
  '/',
  (req, res) => {

    res.json({

      status:
        'ok',

      message:
        'ConneX backend is running',

      version:
        'v4',

      accepts: [
        'text',
        'image',
        'video',
        'album',
      ],

      refresh_interval_minutes:
        REFRESH_INTERVAL_MINUTES,

      telegram_channel_username:
        TELEGRAM_CHANNEL_USERNAME
          ? 'configured'
          : 'not configured',
    });
  }
);


// ============================================================
// 15. HEALTH
// ============================================================

app.get(
  '/api/health',
  (req, res) => {

    res.json({

      ok:
        true,

      time:
        Date.now(),

      version:
        'v4',

      refresh_interval_minutes:
        REFRESH_INTERVAL_MINUTES,
    });
  }
);


// ============================================================
// 16. CREATE POST
// ============================================================
//
// POST /api/upload
//
// Fields:
//
// uid
// caption
// hashtags
//
// Files:
//
// media
//
// Also supports:
//
// video
//
// If no files are provided:
// → text post
//
// If 1 file:
// → image or video
//
// If multiple files:
// → album
// ============================================================

app.post(

  '/api/upload',

  (req, res, next) => {

    upload.fields([

      {
        name:
          'media',

        maxCount:
          10,
      },

      {
        name:
          'video',

        maxCount:
          10,
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


          return res
            .status(400)
            .json({

              success:
                false,

              error:
                err.message,
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

      // ======================================================
      // REQUEST DATA
      // ======================================================

      const {
        caption = '',
        hashtags = '',
        uid = null,
      } =
        req.body;


      // ======================================================
      // UID
      // ======================================================

      if (!uid) {

        return res
          .status(400)
          .json({

            success:
              false,

            error:
              'User ID (uid) is required',
          });
      }


      // ======================================================
      // COLLECT FILES
      // ======================================================

      const files = [];


      if (
        req.files?.media
      ) {

        files.push(
          ...req.files.media
        );
      }


      if (
        req.files?.video
      ) {

        files.push(
          ...req.files.video
        );
      }


      // ======================================================
      // DETERMINE TYPE
      // ======================================================

      let type =
        'text';


      if (
        files.length === 1
      ) {

        type =
          files[0].mimetype
            .startsWith('image/')
            ? 'image'
            : 'video';
      }


      if (
        files.length > 1
      ) {

        type =
          'album';
      }


      // ======================================================
      // TEXT POST
      // ======================================================

      if (
        files.length === 0
      ) {

        const stored =
          await storePostInFirebase(

            uid,

            {

              type:
                'text',

              caption,

              hashtags,

              media:
                [],
            }
          );


        console.log(
          `✅ Text post created:
usersdata/${uid}/posts/${stored.postId}`
        );


        return res.json({

          success:
            true,

          post_id:
            stored.postId,

          type:
            'text',

          telegram:
            stored.post.telegram,

          message:
            'Text post created successfully.',
        });
      }


      // ======================================================
      // MEDIA UPLOAD
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
      // STORE IN FIREBASE
      // ======================================================

      const stored =
        await storePostInFirebase(

          uid,

          {

            type,

            caption,

            hashtags,

            media:
              telegramMedia,
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

        success:
          true,

        post_id:
          stored.postId,

        type,

        telegram:
          stored.post.telegram,

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


      return res
        .status(500)
        .json({

          success:
            false,

          error:
            error.message ||
            'Internal server error',
        });
    }
  }
);


// ============================================================
// 17. MANUAL REFRESH ALL
// ============================================================
//
// POST /api/cron/refresh
//
// Optional:
//
// x-cron-secret: YOUR_CRON_SECRET
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
        req.headers[
          'x-cron-secret'
        ] ||
        req.query.secret;


      if (
        provided !== CRON_SECRET
      ) {

        return res
          .status(401)
          .json({

            success:
              false,

            error:
              'Unauthorized',
          });
      }
    }


    try {

      const result =
        await refreshAllTelegramUrls();


      res.json({

        success:
          true,

        ...result,
      });


    } catch (error) {

      console.error(
        'Cron refresh error:',
        error
      );


      res
        .status(500)
        .json({

          success:
            false,

          error:
            error.message,
        });
    }
  }
);


// ============================================================
// 18. REFRESH SINGLE POST
// ============================================================
//
// GET /api/refresh-post/:uid/:postId
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
      } =
        req.params;


      const result =
        await refreshPostUrl(
          uid,
          postId
        );


      if (!result) {

        return res
          .status(404)
          .json({

            success:
              false,

            error:
              'Post not found',
          });
      }


      res.json({

        success:
          true,

        ...result,
      });


    } catch (error) {

      console.error(
        'Single refresh error:',
        error
      );


      res
        .status(500)
        .json({

          success:
            false,

          error:
            error.message,
        });
    }
  }
);


// ============================================================
// 19. CORS PREFLIGHT
// ============================================================

app.options(
  '*',
  (req, res) => {

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


    res.sendStatus(
      204
    );
  }
);


// ============================================================
// 20. GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {

    console.error(
      'Global error handler:',
      err.message
    );


    res.header(
      'Access-Control-Allow-Origin',
      '*'
    );


    if (
      err instanceof
      multer.MulterError
    ) {

      return res
        .status(400)
        .json({

          success:
            false,

          error:
            'Upload error: ' +
            err.message,
        });
    }


    res
      .status(500)
      .json({

        success:
          false,

        error:
          err.message ||
          'Server error',
      });
  }
);


// ============================================================
// 21. 404
// ============================================================

app.use(
  (req, res) => {

    res.header(
      'Access-Control-Allow-Origin',
      '*'
    );


    res
      .status(404)
      .json({

        error:
          'Route not found',
      });
  }
);


// ============================================================
// 22. START SERVER
// ============================================================

app.listen(
  PORT,
  () => {

    console.log(
      `🚀 ConneX backend v4 running on port ${PORT}`
    );


    console.log(
      '📦 Supports: text + image + video + album'
    );


    console.log(
      `🔄 Refresh interval: ${REFRESH_INTERVAL_MINUTES} minutes`
    );


    console.log(
      `🔗 Telegram username: ${
        TELEGRAM_CHANNEL_USERNAME
          ? 'configured'
          : 'NOT CONFIGURED'
      }`
    );


    // ========================================================
    // REFRESH AFTER DEPLOYMENT
    // ========================================================

    setTimeout(
      async () => {

        try {

          console.log(
            '🚀 Running deployment startup refresh...'
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
// 23. GRACEFUL SHUTDOWN
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

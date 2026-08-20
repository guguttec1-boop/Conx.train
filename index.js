const express = require("express");
const cors = require("cors");
const multer = require("multer");
const admin = require("firebase-admin");

const app = express();

const PORT = process.env.PORT || 3000;

// ======================================================
// ENVIRONMENT VARIABLES
// ======================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

const DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;


// ======================================================
// BASIC CHECK
// ======================================================

console.log("=================================");
console.log("Droplet Video Platform starting...");
console.log("=================================");

console.log(
  "Telegram token:",
  BOT_TOKEN ? "OK" : "MISSING"
);

console.log(
  "Telegram channel:",
  CHANNEL_ID ? "OK" : "MISSING"
);

console.log(
  "Firebase URL:",
  DATABASE_URL ? "OK" : "MISSING"
);

console.log(
  "Firebase project:",
  PROJECT_ID ? "OK" : "MISSING"
);

console.log(
  "Firebase email:",
  CLIENT_EMAIL ? "OK" : "MISSING"
);

console.log(
  "Firebase private key:",
  PRIVATE_KEY ? "OK" : "MISSING"
);

console.log(
  "Webhook secret:",
  WEBHOOK_SECRET ? "OK" : "MISSING"
);


// ======================================================
// FIREBASE INITIALIZATION
// ======================================================

admin.initializeApp({

  credential: admin.credential.cert({

    projectId: PROJECT_ID,

    clientEmail: CLIENT_EMAIL,

    privateKey: PRIVATE_KEY
      ? PRIVATE_KEY.replace(/\\n/g, "\n")
      : undefined

  }),

  databaseURL: DATABASE_URL

});

const db = admin.database();


// ======================================================
// EXPRESS
// ======================================================

app.use(cors());

app.use(
  express.json({
    limit: "10mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);


// ======================================================
// MULTER
// ======================================================

const upload = multer({

  storage: multer.memoryStorage(),

  limits: {

    fileSize:
      50 * 1024 * 1024

  }

});


// ======================================================
// TELEGRAM API
// ======================================================

async function telegram(method, options = {}) {

  const url =
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

  const response =
    await fetch(
      url,
      options
    );

  const data =
    await response.json();

  if (!data.ok) {

    throw new Error(
      `Telegram API error: ${JSON.stringify(data)}`
    );

  }

  return data.result;

}


// ======================================================
// SAVE TELEGRAM VIDEO
// ======================================================

async function saveTelegramVideo(msg) {

  if (!msg || !msg.video) {

    console.log(
      "Message does not contain a video."
    );

    return null;

  }


  const video =
    msg.video;

  const messageId =
    msg.message_id;

  const channelId =
    msg.chat?.id || CHANNEL_ID;

  const caption =
    msg.caption || "";


  // Unique Firebase ID
  const postId =
    `telegram_${channelId}_${messageId}`
      .replace(
        /[^a-zA-Z0-9_-]/g,
        "_"
      );


  const fileId =
    video.file_id;


  console.log(
    "Getting Telegram file information..."
  );


  const telegramFile =
    await telegram(
      `getFile?file_id=${encodeURIComponent(fileId)}`
    );


  const filePath =
    telegramFile.file_path;


  // IMPORTANT:
  // We do NOT save the bot token inside Firebase.


  const data = {

    post_id:
      postId,

    type:
      "video",

    caption:
      caption,

    telegram_file_id:
      fileId,

    telegram_file_path:
      filePath,

    telegram_message_id:
      messageId,

    telegram_channel_id:
      String(channelId),

    width:
      video.width || null,

    height:
      video.height || null,

    duration:
      video.duration || null,

    file_size:
      video.file_size || null,

    video_url:
      `/video/${encodeURIComponent(postId)}`,

    created_at:
      (msg.date ||
        Math.floor(
          Date.now() / 1000
        )) * 1000,

    source:
      "telegram"

  };


  console.log(
    "Saving video to Firebase:",
    postId
  );


  await db
    .ref(`posts/${postId}`)
    .set(data);


  console.log(
    "Video saved successfully:",
    postId
  );


  return data;

}


// ======================================================
// TELEGRAM WEBHOOK
// ======================================================

app.post(
  "/telegram/webhook",
  async (req, res) => {

    try {

      // ----------------------------------------------
      // Verify Telegram secret
      // ----------------------------------------------

      const secret =
        req.headers[
          "x-telegram-bot-api-secret-token"
        ];


      if (
        WEBHOOK_SECRET &&
        secret !== WEBHOOK_SECRET
      ) {

        console.log(
          "Webhook rejected: invalid secret"
        );

        return res.sendStatus(403);

      }


      const update =
        req.body;


      console.log(
        "================================="
      );

      console.log(
        "Telegram webhook received"
      );

      console.log(
        JSON.stringify(
          update,
          null,
          2
        )
      );


      // ----------------------------------------------
      // CHANNEL POST
      // ----------------------------------------------

      if (
        update.channel_post
      ) {

        const msg =
          update.channel_post;


        // ------------------------------------------
        // VIDEO
        // ------------------------------------------

        if (
          msg.video
        ) {

          await saveTelegramVideo(
            msg
          );

        } else {

          console.log(
            "Channel post is not a video."
          );

        }

      }


      res.sendStatus(200);


    } catch (error) {

      console.error(
        "Webhook error:",
        error
      );


      // Always acknowledge Telegram
      // so it does not repeatedly retry.

      res.sendStatus(200);

    }

  }
);


// ======================================================
// WEBSITE VIDEO UPLOAD
// ======================================================

app.post(
  "/api/upload",
  upload.single("video"),
  async (req, res) => {

    try {

      if (!req.file) {

        return res.status(400).json({

          success:
            false,

          error:
            "No video uploaded"

        });

      }


      const caption =
        req.body.caption || "";


      console.log(
        "Website video upload received."
      );


      // ----------------------------------------------
      // SEND VIDEO TO TELEGRAM
      // ----------------------------------------------

      const formData =
        new FormData();


      const blob =
        new Blob(
          [
            req.file.buffer
          ],
          {
            type:
              req.file.mimetype ||
              "video/mp4"
          }
        );


      formData.append(
        "chat_id",
        CHANNEL_ID
      );


      formData.append(
        "video",
        blob,
        req.file.originalname
      );


      if (caption) {

        formData.append(
          "caption",
          caption
        );

      }


      const response =
        await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`,
          {
            method:
              "POST",

            body:
              formData
          }
        );


      const data =
        await response.json();


      if (!data.ok) {

        throw new Error(
          `Telegram upload failed: ${JSON.stringify(data)}`
        );

      }


      console.log(
        "Video sent to Telegram."
      );


      console.log(
        "Message ID:",
        data.result.message_id
      );


      /*
        IMPORTANT:

        We DO NOT save the post to Firebase here.

        Telegram will send a channel_post webhook.

        The webhook calls saveTelegramVideo().

        This prevents duplicate Firebase posts.
      */


      res.json({

        success:
          true,

        message:
          "Video sent to Telegram successfully",

        telegram_message_id:
          data.result.message_id

      });


    } catch (error) {

      console.error(
        "Upload error:",
        error
      );


      res.status(500).json({

        success:
          false,

        error:
          error.message

      });

    }

  }
);


// ======================================================
// VIDEO STREAMING
// ======================================================

app.get(
  "/video/:postId",
  async (req, res) => {

    try {

      const postId =
        req.params.postId;


      console.log(
        "Video requested:",
        postId
      );


      // ----------------------------------------------
      // Get Firebase post
      // ----------------------------------------------

      const snapshot =
        await db
          .ref(
            `posts/${postId}`
          )
          .once("value");


      if (!snapshot.exists()) {

        return res
          .status(404)
          .send(
            "Video not found"
          );

      }


      const post =
        snapshot.val();


      if (
        !post.telegram_file_id
      ) {

        return res
          .status(404)
          .send(
            "Telegram file ID not found"
          );

      }


      // ----------------------------------------------
      // Get current Telegram file path
      // ----------------------------------------------

      const file =
        await telegram(
          `getFile?file_id=${encodeURIComponent(
            post.telegram_file_id
          )}`
        );


      const telegramUrl =
        `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;


      console.log(
        "Fetching video from Telegram..."
      );


      // ----------------------------------------------
      // Fetch video
      // ----------------------------------------------

      const response =
        await fetch(
          telegramUrl
        );


      if (!response.ok) {

        throw new Error(
          `Telegram file request failed: ${response.status}`
        );

      }


      // ----------------------------------------------
      // Headers
      // ----------------------------------------------

      res.setHeader(
        "Content-Type",
        response.headers.get(
          "content-type"
        ) || "video/mp4"
      );


      const contentLength =
        response.headers.get(
          "content-length"
        );


      if (contentLength) {

        res.setHeader(
          "Content-Length",
          contentLength
        );

      }


      res.setHeader(
        "Accept-Ranges",
        "bytes"
      );


      // ----------------------------------------------
      // Send video
      // ----------------------------------------------

      const buffer =
        await response.arrayBuffer();


      res.send(
        Buffer.from(buffer)
      );


    } catch (error) {

      console.error(
        "Video streaming error:",
        error
      );


      res
        .status(500)
        .send(
          "Unable to load video"
        );

    }

  }
);


// ======================================================
// GET ALL POSTS
// ======================================================

app.get(
  "/api/posts",
  async (req, res) => {

    try {

      const snapshot =
        await db
          .ref("posts")
          .orderByChild(
            "created_at"
          )
          .once("value");


      const posts = [];


      snapshot.forEach(
        child => {

          posts.push({

            id:
              child.key,

            ...child.val()

          });

        }
      );


      // Newest first

      posts.reverse();


      res.json(
        posts
      );


    } catch (error) {

      console.error(
        "Posts error:",
        error
      );


      res.status(500).json({

        success:
          false,

        error:
          error.message

      });

    }

  }
);


// ======================================================
// HEALTH CHECK
// ======================================================

app.get(
  "/",
  (req, res) => {

    res.send(
      "Droplet Video Platform is running."
    );

  }
);


// ======================================================
// START
// ======================================================

app.listen(
  PORT,
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

  }
);

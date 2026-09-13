// The Firestore triggers below are written against the v1 API and the media
// proxy uses the v2 HTTP API, so both are imported by explicit subpath. That
// keeps working on firebase-functions v6 and v7, where the package root only
// exposes v2.
const functions = require("firebase-functions/v1");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const {
  buildContentDisposition,
  guessContentType,
  parseTokenizedStorageUrl,
  resolveProjectId,
  resolveStorageBucket,
  sanitizeFilename
} = require("./lib/storage-url");

admin.initializeApp();

const PROJECT_ID = resolveProjectId();
const STORAGE_BUCKET = resolveStorageBucket();

// Send push notification when a new notification is created
exports.sendPushNotification = functions.firestore
  .document("users/{userId}/notifications/{notificationId}")
  .onCreate(async (snap, context) => {
    const notification = snap.data();
    const userId = context.params.userId;

    // Get user's push tokens
    const userDoc = await admin.firestore().collection("users").doc(userId).get();
    if (!userDoc.exists()) return null;
    
    const pushTokens = userDoc.data().pushTokens || [];
    if (pushTokens.length === 0) return null;

    // Build notification payload
    let title = notification.title;
    let body = notification.message || notification.title;
    let clickAction = "/dashboard.html";

    if (notification.postId) {
      clickAction = `/post-view.html?postId=${notification.postId}`;
    } else if (notification.fromUserId) {
      clickAction = `/profile.html?uid=${notification.fromUserId}`;
    }

    const payload = {
      notification: {
        title: title,
        body: body,
        icon: "https://res.cloudinary.com/dq7fpxfbc/image/upload/v1772726030/logo2_drw2fc.jpg",
        click_action: clickAction
      },
      data: {
        clickAction: clickAction,
        postId: notification.postId || "",
        fromUserId: notification.fromUserId || ""
      },
      tokens: pushTokens
    };

    // Send notification
    const response = await admin.messaging().sendEachForMulticast(payload);
    
    // Remove invalid tokens
    const invalidTokens = response.responses
      .map((resp, idx) => !resp.success ? pushTokens[idx] : null)
      .filter(token => token !== null);

    if (invalidTokens.length > 0) {
      await admin.firestore().collection("users").doc(userId).update({
        pushTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens)
      });
    }

    return null;
  });

// Send notification when a followed user posts new content
exports.sendNewPostNotification = functions.firestore
  .document("posts/{postId}")
  .onCreate(async (snap, context) => {
    const post = snap.data();
    const postId = context.params.postId;
    const creatorId = post.userId;

    // Get all followers of the creator
    const followersQuery = admin.firestore().collection("users").where("following", "array-contains", creatorId);
    const followersSnap = await followersQuery.get();

    for (const followerDoc of followersSnap.docs) {
      const followerId = followerDoc.id;
      const pushTokens = followerDoc.data().pushTokens || [];
      if (pushTokens.length === 0) continue;

      // Create notification in Firestore
      await admin.firestore().collection("users").doc(followerId).collection("notifications").add({
        type: "new_post",
        title: `${post.username} posted new content!`,
        message: post.content.substring(0, 50) + "...",
        postId: postId,
        fromUserId: creatorId,
        read: false,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      // Send push notification
      const payload = {
        notification: {
          title: `${post.username} posted new content!`,
          body: post.content.substring(0, 50) + "...",
          icon: post.userAvatar || "https://res.cloudinary.com/dq7fpxfbc/image/upload/v1772726030/logo2_drw2fc.jpg",
          click_action: `/post-view.html?postId=${postId}`
        },
        data: {
          clickAction: `/post-view.html?postId=${postId}`,
          postId: postId,
          fromUserId: creatorId
        },
        tokens: pushTokens
      };

      await admin.messaging().sendEachForMulticast(payload);
    }

    return null;
  });

// ---------------------------------------------------------------------------
// Watermarked media downloads
//
// Saving a photo or video bakes the CashClique logo into the file, which means
// the browser needs the raw bytes in-page. A cross-origin fetch of a Firebase
// Storage download URL fails when the bucket sends no CORS headers, and an
// <a download> pointing at Storage navigates to the media instead of saving
// it. This proxy streams the object back with permissive CORS headers so the
// client can watermark it and download a Blob.
//
// GET|HEAD https://us-central1-<project>.cloudfunctions.net/downloadMedia
//            ?url=<tokenized Firebase Storage download URL>
//            &filename=<optional download name>
//
// Only tokenized URLs for this project's bucket are served, and the token is
// checked against the object's downloadTokens, so this is not an open reader
// for the bucket.
// ---------------------------------------------------------------------------

function setCorsHeaders(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.set("Access-Control-Expose-Headers", "Content-Type, Content-Length, Content-Disposition");
  res.set("Access-Control-Max-Age", "3600");
  res.set("Vary", "Origin");
}

function queryString(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

exports.downloadMedia = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 20,
    invoker: "public",
    cors: false
  },
  async (req, res) => {
    setCorsHeaders(res);

    // Preflight from the browser before the cross-origin GET.
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).json({ error: "Use GET with ?url=<storage download url>" });
      return;
    }

    const rawUrl = queryString(req.query.url);
    const requestedFilename = queryString(req.query.filename);

    const parsed = parseTokenizedStorageUrl(rawUrl, {
      projectId: PROJECT_ID,
      storageBucket: STORAGE_BUCKET
    });

    if (!parsed.valid) {
      res.status(400).json({
        error: "Provide a tokenized Firebase Storage download URL for this project",
        reason: parsed.reason
      });
      return;
    }

    const file = admin.storage().bucket(parsed.bucket).file(parsed.objectPath);

    let metadata;
    try {
      const result = await file.getMetadata();
      metadata = result[0];
    } catch (error) {
      const code = Number(error && error.code);
      if (code === 404) {
        res.status(404).json({ error: "Media not found" });
      } else if (code === 401 || code === 403) {
        res.status(403).json({ error: "Media download is not allowed" });
      } else {
        logger.error("downloadMedia: metadata lookup failed", {
          bucket: parsed.bucket,
          objectPath: parsed.objectPath,
          code: code || "",
          message: (error && error.message) || ""
        });
        res.status(502).json({ error: "Could not read the media from storage" });
      }
      return;
    }

    // The token in the URL must be one of the object's live download tokens.
    const liveTokens = String(metadata.downloadTokens || "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
    if (!liveTokens.length || liveTokens.indexOf(parsed.token) === -1) {
      res.status(403).json({ error: "This download link is no longer valid" });
      return;
    }

    const contentType = metadata.contentType || guessContentType(parsed.objectPath);
    const filename = sanitizeFilename(requestedFilename, parsed.filename);

    res.set("Content-Type", contentType);
    res.set("Content-Disposition", buildContentDisposition(filename));
    if (metadata.size) res.set("Content-Length", String(metadata.size));
    res.set("Cache-Control", "private, max-age=300");
    res.set("X-Content-Type-Options", "nosniff");

    if (req.method === "HEAD") {
      res.status(200).send("");
      return;
    }

    // Stream straight through: the bytes are never buffered in memory here.
    const stream = file.createReadStream();
    stream.on("error", (error) => {
      logger.error("downloadMedia: stream failed", {
        bucket: parsed.bucket,
        message: (error && error.message) || ""
      });
      if (!res.headersSent) {
        res.status(502).json({ error: "Could not stream the media from storage" });
        return;
      }
      res.end();
    });
    res.on("close", () => {
      // Client went away (cancelled save): stop reading from Storage.
      if (!stream.destroyed) stream.destroy();
    });
    stream.pipe(res);
  }
);

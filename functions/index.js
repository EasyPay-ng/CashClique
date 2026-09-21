// The Firestore triggers below are written against the v1 API and the media
// proxy uses the v2 HTTP API, so both are imported by explicit subpath.
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
const db = admin.firestore();
const PROJECT_ID = resolveProjectId();
const STORAGE_BUCKET = resolveStorageBucket();
const DEFAULT_ICON = "https://res.cloudinary.com/dq7fpxfbc/image/upload/v1772726030/logo2_drw2fc.jpg";

function notificationData(data) {
  return {
    ...data,
    read: false,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  };
}

async function createNotification(userId, data) {
  if (!userId || userId === data.fromUserId) return null;
  return db.collection("users").doc(userId).collection("notifications").add(notificationData(data));
}

function postText(post) {
  const text = String(post.content || "").trim();
  return text ? text.slice(0, 80) + (text.length > 80 ? "..." : "") : "View the post";
}

// One trigger owns delivery for every notification document. This keeps the
// in-app notification and the phone push in sync, even when an action came
// from a page other than dashboard.html.
exports.sendPushNotification = functions.firestore
  .document("users/{userId}/notifications/{notificationId}")
  .onCreate(async (snap, context) => {
    const notification = snap.data() || {};
    const userSnap = await db.collection("users").doc(context.params.userId).get();
    if (!userSnap.exists) return null;

    const tokens = Array.isArray(userSnap.data().pushTokens)
      ? [...new Set(userSnap.data().pushTokens.filter(Boolean))]
      : [];
    if (!tokens.length) return null;

    const clickAction = notification.postId
      ? `/post-view.html?postId=${encodeURIComponent(notification.postId)}`
      : notification.fromUserId
        ? `/profile.html?uid=${encodeURIComponent(notification.fromUserId)}`
        : "/dashboard.html";
    const title = String(notification.title || "CashClique notification");
    const body = String(notification.message || title);

    const response = await admin.messaging().sendEachForMulticast({
      notification: { title, body, icon: notification.icon || DEFAULT_ICON },
      data: {
        clickAction,
        postId: String(notification.postId || ""),
        fromUserId: String(notification.fromUserId || "")
      },
      tokens
    });

    // Only permanently invalid registration tokens should be removed. A
    // temporary outage must not silently disable a user's future alerts.
    const invalidTokens = response.responses
      .map((result, index) => {
        const code = result.error && result.error.code;
        return !result.success && [
          "messaging/registration-token-not-registered",
          "messaging/invalid-registration-token"
        ].includes(code) ? tokens[index] : null;
      })
      .filter(Boolean);
    if (invalidTokens.length) {
      await db.collection("users").doc(context.params.userId).update({
        pushTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens)
      });
    }
    return null;
  });

// Notify followers when a post is created. The notification is written even
// when a follower has no phone token, so it remains available in the app and
// becomes a phone alert as soon as that follower enables push notifications.
exports.sendNewPostNotification = functions.firestore
  .document("posts/{postId}")
  .onCreate(async (snap, context) => {
    const post = snap.data() || {};
    const creatorId = post.userId;
    if (!creatorId) return null;

    const followers = await db.collection("users")
      .where("following", "array-contains", creatorId).get();
    const batch = db.batch();
    followers.docs.forEach((follower) => {
      if (follower.id === creatorId) return;
      const ref = db.collection("users").doc(follower.id).collection("notifications").doc();
      batch.set(ref, notificationData({
        type: "new_post",
        title: `${post.username || "Someone you follow"} posted new content`,
        message: postText(post),
        postId: context.params.postId,
        fromUserId: creatorId
      }));
    });
    await batch.commit();
    return null;
  });

// Notify the owner when somebody likes a post. This is server-side so likes
// made from post-view, mobile browsers, or future clients all behave the same.
exports.sendLikeNotification = functions.firestore
  .document("posts/{postId}")
  .onUpdate(async (change, context) => {
    const before = change.before.data() || {};
    const after = change.after.data() || {};
    const beforeLikes = new Set(Array.isArray(before.likedBy) ? before.likedBy : []);
    const newLikes = (Array.isArray(after.likedBy) ? after.likedBy : [])
      .filter((uid) => !beforeLikes.has(uid));
    if (!newLikes.length || !after.userId) return null;

    // One notification per newly added user in this update (normally one).
    await Promise.all(newLikes.map(async (actorId) => {
      const actor = await db.collection("users").doc(actorId).get();
      const name = actor.exists ? (actor.data().username || "Someone") : "Someone";
      return createNotification(after.userId, {
        type: "like",
        title: `${name} liked your post`,
        message: postText(after),
        fromUserId: actorId,
        postId: context.params.postId
      });
    }));
    return null;
  });

// Notify the post owner when a comment or reply is added.
exports.sendCommentNotification = functions.firestore
  .document("posts/{postId}/comments/{commentId}")
  .onCreate(async (snap, context) => {
    const comment = snap.data() || {};
    const post = await db.collection("posts").doc(context.params.postId).get();
    if (!post.exists || !comment.userId) return null;
    const actor = await db.collection("users").doc(comment.userId).get();
    const name = actor.exists ? (actor.data().username || comment.username || "Someone") : (comment.username || "Someone");
    return createNotification(post.data().userId, {
      type: "comment",
      title: `${name} commented on your post`,
      message: String(comment.text || "View the comment").slice(0, 120),
      fromUserId: comment.userId,
      postId: context.params.postId
    });
  });

// ---------------------------------------------------------------------------
// Watermarked media downloads
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
  { region: "us-central1", timeoutSeconds: 300, memory: "512MiB", maxInstances: 20, invoker: "public", cors: false },
  async (req, res) => {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).json({ error: "Use GET with ?url=<storage download url>" });
    const parsed = parseTokenizedStorageUrl(queryString(req.query.url), { projectId: PROJECT_ID, storageBucket: STORAGE_BUCKET });
    if (!parsed.valid) return res.status(400).json({ error: "Provide a tokenized Firebase Storage download URL for this project", reason: parsed.reason });
    const file = admin.storage().bucket(parsed.bucket).file(parsed.objectPath);
    let metadata;
    try { metadata = (await file.getMetadata())[0]; } catch (error) {
      const code = Number(error && error.code);
      if (code === 404) return res.status(404).json({ error: "Media not found" });
      if (code === 401 || code === 403) return res.status(403).json({ error: "Media download is not allowed" });
      logger.error("downloadMedia: metadata lookup failed", { bucket: parsed.bucket, objectPath: parsed.objectPath, code: code || "", message: (error && error.message) || "" });
      return res.status(502).json({ error: "Could not read the media from storage" });
    }
    const liveTokens = String(metadata.downloadTokens || "").split(",").map((token) => token.trim()).filter(Boolean);
    if (!liveTokens.includes(parsed.token)) return res.status(403).json({ error: "This download link is no longer valid" });
    const filename = sanitizeFilename(queryString(req.query.filename), parsed.filename);
    res.set("Content-Type", metadata.contentType || guessContentType(parsed.objectPath));
    res.set("Content-Disposition", buildContentDisposition(filename));
    if (metadata.size) res.set("Content-Length", String(metadata.size));
    res.set("Cache-Control", "private, max-age=300");
    res.set("X-Content-Type-Options", "nosniff");
    if (req.method === "HEAD") return res.status(200).send("");
    const stream = file.createReadStream();
    stream.on("error", (error) => { logger.error("downloadMedia: stream failed", { bucket: parsed.bucket, message: (error && error.message) || "" }); if (!res.headersSent) res.status(502).json({ error: "Could not stream the media from storage" }); else res.end(); });
    res.on("close", () => { if (!stream.destroyed) stream.destroy(); });
    stream.pipe(res);
  }
);

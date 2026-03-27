const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

// Send notification when a new like is added
exports.sendLikeNotification = functions.firestore
  .document("posts/{postId}/likes/{likeId}")
  .onCreate(async (snap, context) => {
    const likeData = snap.data();
    const postId = context.params.postId;

    // Get post owner
    const postDoc = await admin.firestore().collection("posts").doc(postId).get();
    if (!postDoc.exists) return null;
    const postData = postDoc.data();
    const ownerUid = postData.userId;

    // Get owner's push tokens
    const userDoc = await admin.firestore().collection("users").doc(ownerUid).get();
    if (!userDoc.exists) return null;
    const userData = userDoc.data();
    const pushTokens = userData.pushTokens || [];

    if (pushTokens.length === 0) return null;

    // Send notification
    const payload = {
      notification: {
        title: "New Like!",
        body: `${likeData.fromUsername} liked your post`,
        icon: "https://res.cloudinary.com/dq7fpxfbc/image/upload/v1772726030/logo2_drw2fc.jpg"
      },
      data: { clickAction: `/post-view.html?postId=${postId}` },
      tokens: pushTokens
    };

    const response = await admin.messaging().sendEachForMulticast(payload);
    
    // Remove invalid tokens
    const invalidTokens = response.responses
      .map((resp, idx) => !resp.success ? pushTokens[idx] : null)
      .filter(token => token !== null);

    if (invalidTokens.length > 0) {
      await admin.firestore().collection("users").doc(ownerUid).update({
        pushTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens)
      });
    }
    return null;
  });

// Send notification when a new comment is added
exports.sendCommentNotification = functions.firestore
  .document("posts/{postId}/comments/{commentId}")
  .onCreate(async (snap, context) => {
    const commentData = snap.data();
    const postId = context.params.postId;

    const postDoc = await admin.firestore().collection("posts").doc(postId).get();
    if (!postDoc.exists) return null;
    const postData = postDoc.data();
    const ownerUid = postData.userId;

    const userDoc = await admin.firestore().collection("users").doc(ownerUid).get();
    if (!userDoc.exists) return null;
    const userData = userDoc.data();
    const pushTokens = userData.pushTokens || [];

    if (pushTokens.length === 0) return null;

    const payload = {
      notification: {
        title: "New Comment!",
        body: `${commentData.fromUsername}: ${commentData.text.substring(0, 50)}...`,
        icon: "https://res.cloudinary.com/dq7fpxfbc/image/upload/v1772726030/logo2_drw2fc.jpg"
      },
      data: { clickAction: `/post-view.html?postId=${postId}` },
      tokens: pushTokens
    };

    const response = await admin.messaging().sendEachForMulticast(payload);
    // Remove invalid tokens
    const invalidTokens = response.responses
      .map((resp, idx) => !resp.success ? pushTokens[idx] : null)
      .filter(token => token !== null);

    if (invalidTokens.length > 0) {
      await admin.firestore().collection("users").doc(ownerUid).update({
        pushTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens)
      });
    }
    return null;
  });

// Send notification when a new follower is added
exports.sendFollowerNotification = functions.firestore
  .document("users/{userId}/followers/{followerId}")
  .onCreate(async (snap, context) => {
    const followerData = snap.data();
    const userId = context.params.userId;

    const userDoc = await admin.firestore().collection("users").doc(userId).get();
    if (!userDoc.exists) return null;
    const userData = userDoc.data();
    const pushTokens = userData.pushTokens || [];

    if (pushTokens.length === 0) return null;

    const payload = {
      notification: {
        title: "New Follower!",
        body: `${followerData.username} started following you`,
        icon: "https://res.cloudinary.com/dq7fpxfbc/image/upload/v1772726030/logo2_drw2fc.jpg"
      },
      data: { clickAction: `/profile.html?uid=${context.params.followerId}` },
      tokens: pushTokens
    };

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

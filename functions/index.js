const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

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

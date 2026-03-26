importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js");

// 🔥 Initialize Firebase (YOUR CONFIG)
firebase.initializeApp({
  apiKey: "AIzaSyBsgofM76EpbQTQBhipIpMNBJZYLwi2Pyg",
  authDomain: "cashclique-31718.firebaseapp.com",
  projectId: "cashclique-31718",
  messagingSenderId: "1064282591269",
  appId: "1:1064282591269:web:17fbaf9b683d5b0dfbafcc"
});

// 🔔 Initialize Messaging
const messaging = firebase.messaging();

// 📡 Handle background messages
messaging.onBackgroundMessage(function(payload) {
  console.log("🔥 Background message received:", payload);

  const title = payload.notification?.title || "Notification";
  const options = {
    body: payload.notification?.body || "",
    icon: "/icon.png", // make sure this exists or change path
    data: payload.data || {}
  };

  self.registration.showNotification(title, options);
});

// 🧠 Handle notification click
self.addEventListener("notificationclick", function(event) {
  event.notification.close();

  const url = event.notification.data?.click_action || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url === url && "focus" in client) {
            return client.focus();
          }
        }
        return clients.openWindow(url);
      })
  );
});

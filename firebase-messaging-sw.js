importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBsgofM76EpbQTQBhipIpMNBJZYLwi2Pyg",
  authDomain: "cashclique-31718.firebaseapp.com",
  projectId: "cashclique-31718",
  messagingSenderId: "1064282591269",
  appId: "1:1064282591269:web:17fbaf9b683d5b0dfbafcc"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  self.registration.showNotification(payload.notification.title, {
    body: payload.notification.body,
  });
});

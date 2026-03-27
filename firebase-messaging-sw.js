importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// Your Firebase Config
const firebaseConfig = {
  apiKey: "AIzaSyBsgofM76EpbQTQBhipIpMNBJZYLwi2Pyg",
  authDomain: "cashclique-31718.firebaseapp.com",
  projectId: "cashclique-31718",
  storageBucket: "cashclique-31718.firebasestorage.app",
  messagingSenderId: "1064282591269",
  appId: "1:1064282591269:web:17fbaf9b683d5b0dfbafcc",
  measurementId: "G-V5WHJB6LS0"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// Handle background notifications
messaging.onBackgroundMessage((payload) => {
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: "https://res.cloudinary.com/dq7fpxfbc/image/upload/v1772726030/logo2_drw2fc.jpg",
    data: { clickAction: payload.data.clickAction }
  };
  self.registration.showNotification(notificationTitle, notificationOptions);
});

// Open site when notification is clicked
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.clickAction || '/dashboard.html')
  );
});

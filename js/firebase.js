// firebase.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-storage.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyBsgofM76EpbQTQBhipIpMNBJZYLwi2Pyg",
  authDomain: "cashclique-31718.firebaseapp.com",
  projectId: "cashclique-31718",
  storageBucket: "cashclique-31718.firebasestorage.app",
  messagingSenderId: "1064282591269",
  appId: "1:1064282591269:web:17fbaf9b683d5b0dfbafcc",
  measurementId: "G-V5WHJB6LS0"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const analytics = getAnalytics(app);

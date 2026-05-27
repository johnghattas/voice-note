// TODO: Replace with your Firebase project config from Firebase Console
// Go to: Firebase Console → Project Settings → General → Your apps → Web app
const firebaseConfig = {
  apiKey: "AIzaSyBdH89wQtpA7kRLVh_Oqs2ZUOxQuKoJ6gQ",
  authDomain: "voicenotes-b6810.firebaseapp.com",
  projectId: "voicenotes-b6810",
  storageBucket: "voicenotes-b6810.firebasestorage.app",
  messagingSenderId: "538143679950",
  appId: "1:538143679950:web:23edf47b80858dab60f79f",
  measurementId: "G-K6PGHP8QGQ"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

// firebase-config.js — Monalingo Academy (monalingo-95aab)
try {
    const firebaseConfig = {
        apiKey: "AIzaSyC8rxY_88dQUoFdaEhsIKiJ8AU1E8nVZ9Q",
        authDomain: "monalingo-95aab.firebaseapp.com",
        projectId: "monalingo-95aab",
        storageBucket: "monalingo-95aab.firebasestorage.app",
        messagingSenderId: "904960827484",
        appId: "1:904960827484:web:40bf84ded24dd9e7838699",
        measurementId: "G-TR2J0Q34XW"
    };

    // تهيئة المشروع
    if (typeof firebase !== 'undefined') {
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        // تعريف متغير قاعدة البيانات لاستخدامه في الأكواد
        window.db = firebase.firestore();
        // لو الصفحة حمّلت Firebase Auth SDK كمان، جهّز window.auth للاستخدام
        if (typeof firebase.auth === 'function') {
            window.auth = firebase.auth();
        }
    }
} catch (e) {
    console.warn("Firebase could not be initialized. You might be offline.", e);
}

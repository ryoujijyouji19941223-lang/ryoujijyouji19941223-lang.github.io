// Firebase ウェブ設定と入口の所有者設定。
//
// ★このファイルのプレースホルダを、Firebase コンソールの実値に差し替えるまで
//   アプリは接続しません（差し替え手順は CONSOLE_PROCEDURE.md の手順4）。
//   実値はコンソールの「プロジェクトの設定 → 全般 → マイアプリ → ウェブアプリ」
//   に表示される firebaseConfig からそのままコピーすること。推測で埋めない。
//
// プロジェクト ID は既存システム（関所・watcher の接続先）から確定している
// 実値が sakamata-cradle。それ以外はコンソール発行の値が必要。
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBGipXO8gTEmHDyAOtcl-c5zyFOJELEF1c",
  authDomain: "sakamata-cradle.firebaseapp.com",
  projectId: "sakamata-cradle",
  storageBucket: "sakamata-cradle.firebasestorage.app",
  messagingSenderId: "275733661439",
  appId: "1:275733661439:web:254c50878eeb430a47aeca"
};

// 本人確認の対象：このメールアドレスの Google アカウント（メール確認済み）
// だけが入口を使える。クライアント側の判定は画面表示のためのもので、
// 実際の強制は Firestore セキュリティルール（firestore.rules）が担う。
// ルール側の OWNER_EMAIL_HERE と必ず同じ値にすること。
window.ENTRANCE_OWNER_EMAIL = "ryouji.jyouji.1994.1223@gmail.com";

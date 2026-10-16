// 部署前請填入以下設定
window.APP_CONFIG = {
  // Google Cloud Console → API 和服務 → 憑證 → OAuth 2.0 用戶端 ID（網頁應用程式）
  GOOGLE_CLIENT_ID: '884314576750-0ar18p2elfjn6jd287ded3112nhcnmru.apps.googleusercontent.com',

  // Apps Script 部署為「網頁應用程式」後取得的網址（結尾為 /exec）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbyM2ZmFm5JqyhkmupMjFA-z4hgXGjzmC6dJXGGs-N0rHfHIdsp4rIudUszSgnJfXF4_/exec',

  // 限定登入網域，例如 'shopee.com'；留空表示不限制（後端也會再檢查一次）
  ALLOWED_DOMAIN: '',
};

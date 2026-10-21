# Đăng nhập OTP và phiên thiết bị 30 ngày

Backend triển khai đăng nhập bằng **email đã đăng ký + CAPTCHA + OTP**, access token **20 phút**, refresh token trong cookie **30 ngày kể từ lần OTP thành công**. Mỗi lần refresh xoay token nhưng không gia hạn quá mốc hết hạn của phiên thiết bị. Mỗi trình duyệt mới/không còn cookie phải xác thực OTP. Không tự tạo tài khoản từ địa chỉ Gmail và không cần mật khẩu ở bước đăng nhập này.

Bản bảo vệ kho bổ sung hết phiên sau 30 phút không có request hợp lệ, danh sách/đăng xuất từng thiết bị, khóa tài khoản sau 5 lần xác thực sai và migration security. Xem [trình tự triển khai đầy đủ](security-hardening.md) trước khi khởi động production; cần migration security sau migration auth sessions.

## Triển khai backend

Thay đổi lần này gồm `src/auth/`, hai entity `auth-session.entity.ts`, `auth-captcha.entity.ts`, cập nhật `refresh-token.entity.ts`, `typeorm.config.ts`, `main.ts`, thu hồi phiên trong `users.service.ts`, dọn phiên trong `system.service.ts`, gắn session vào link download trong `documents.service.ts`, cùng migration và script bên dưới. Triển khai các file này cùng nhau; không chỉ chép controller.

1. Chuẩn bị frontend theo phần hợp đồng dưới đây. Bản frontend cũ lưu token trong localStorage và đọc refresh token từ JSON không tương thích với cookie mới.
2. Export/backup database trên server, dừng toàn bộ tiến trình: `pm2 stop lths-backend`.
3. Cập nhật nguồn và `package.json`, chạy `npm run build`.
4. Cấu hình `.env` thật:

```dotenv
DB_SYNCHRONIZE=false
AUTH_COOKIE_SECURE=true
AUTH_COOKIE_SAME_SITE=lax
CORS_ORIGINS=https://frontend.example
```

`CORS_ORIGINS` là danh sách origin chính xác, phân cách dấu phẩy, gồm giao thức và port nếu có, không có đường dẫn hoặc `*`. Mặc định khi không cấu hình chỉ cho `http://localhost:5000` và `http://127.0.0.1:5000`. Frontend và backend dùng chung hostname + HTTPS, có thể khác port, phù hợp `SameSite=Lax`. Nếu thật sự khác site, cần `AUTH_COOKIE_SAME_SITE=none`, HTTPS và đánh giá việc trình duyệt chặn third-party cookies; ưu tiên reverse proxy để cùng site.

SMTP phải gửi được đến email thật của tài khoản. `OTP_ENABLED=false` không còn bỏ qua OTP. Không có fallback in mã OTP ra console khi SMTP lỗi.

5. Chạy migration:

```cmd
node scripts/apply-auth-sessions-migration.cjs --apply
```

Migration tạo `auth_sessions`, `auth_captchas`, thêm `refresh_tokens.session_id`, `consumed_at`, index, FK tài khoản. Refresh token cũ không có session bị thu hồi; xác nhận email-link cũ cũng bị đánh dấu đã dùng. Các tài khoản phải đăng nhập OTP lại một lần sau cập nhật. Không xóa hồ sơ/chứng từ hoặc tài khoản.

6. Cập nhật frontend, rồi khởi động: `pm2 startOrReload ecosystem.config.js --env production --update-env`.

Cookie `Secure` không hoạt động trên địa chỉ LAN HTTP như `http://192.168.0.67:3002`. Production bắt buộc HTTPS cho frontend/API và từ chối `AUTH_COOKIE_SECURE=false`; PM2 production đã đặt Secure=true. Nếu chỉ thử nghiệm HTTP trên máy phát triển, dùng `NODE_ENV=development`, `AUTH_COOKIE_SECURE=false` và `AUTH_COOKIE_SAME_SITE=lax`. Không dùng cấu hình thử nghiệm này để vận hành hồ sơ thật. `SameSite=None` vẫn bắt buộc Secure. Quy tắc Secure và yêu cầu `credentials` khi nhận cookie qua CORS được mô tả trong [MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

## Hợp đồng API frontend

Tất cả request xác thực từ browser dùng `credentials: 'include'`. JavaScript không đọc refresh cookie.

| Request | Body / xác thực | Kết quả |
| --- | --- | --- |
| GET `/auth/captcha` | Không cần token | `captcha_id`, ảnh SVG, `expires_in` |
| POST `/auth/login` | `{email, captcha_id, captcha_code}` | `requires_otp`, `user_id`, `email_hint`, OTP TTL 5 phút |
| POST `/auth/verify-otp` | `{user_id, otp}` | JSON `{access_token, expires_in:1200, user}` và `Set-Cookie` HttpOnly |
| POST `/auth/refresh` | Cookie, không gửi refresh token trong JSON | Access token mới + xoay cookie, không gửi email OTP |
| POST `/auth/logout` | Cookie | Thu hồi phiên thiết bị hiện tại, xóa cookie, HTTP 204 |
| POST `/auth/logout-all` | Cookie + Bearer access token | Thu hồi mọi phiên của tài khoản, xóa cookie, HTTP 204 |

Cookie tên `lths_refresh`, host-only, `Path=/auth`, `HttpOnly`, mặc định `Secure; SameSite=Lax`. JSON không còn `refresh_token` hoặc `refresh_expires_at`. `expires_in` là số giây của access token, không phải thời hạn cookie. Refresh trả 401 sẽ xóa cookie và yêu cầu đăng nhập OTP lại.

`password` là trường tùy chọn để frontend cũ gửi lên không bị lỗi DTO; luồng mới không dùng nó thay OTP. Nếu chưa có mật khẩu, bỏ hẳn trường này khỏi JSON, không gửi chuỗi rỗng.

CAPTCHA dùng chung database giữa các PM2 worker, hết hạn 5 phút, tối đa 5 lần thử và chỉ dùng một lần. Login OTP hết hạn 5 phút, tối đa 5 lần nhập sai, chỉ sử dụng một lần; gửi lại cách tối thiểu 60 giây cho từng tài khoản, tối đa 10 yêu cầu/tài khoản/giờ. Sau 5 lần xác thực sai, tài khoản tạm khóa 15 phút. Refresh không gọi các bước này.

## Sửa `assets/js/app.js` và trang đăng nhập

1. Thay `Auth.getToken`, `Auth.getUser`, `Auth.save` bằng state trong bộ nhớ module. Không ghi access/refresh token vào localStorage, sessionStorage hoặc IndexedDB. Xóa khóa cũ `lths_token` cùng các khóa refresh cũ trong lần cập nhật này; không tự suy ra trạng thái đăng nhập chỉ từ dữ liệu localStorage.
2. Khi mở hoặc tải lại mỗi trang, gọi `/auth/refresh` với cookie trước khi quyết định chuyển về trang login. `Auth.require()` và các hàm init trang phải đợi bootstrap này; nếu gọi require đồng bộ khi bộ nhớ chưa có token sẽ đẩy người dùng về login sai.
3. Khi OTP đúng, lưu access token và user trong bộ nhớ, tính hạn `Date.now() + expires_in * 1000`; không cần hoặc được phép lấy refresh token từ response JSON.
4. Cập nhật wrapper `api()` và các fetch riêng (gồm destruction và preview PDF): khi access token gần hết hạn hoặc API trả 401, chỉ refresh một lần rồi thử lại request một lần. Không refresh lặp vô hạn và không coi lỗi mạng/500 là yêu cầu gửi OTP mới. Với body dạng stream phải chuẩn bị bản sao trước lần gửi đầu tiên.
5. Dùng một promise chung cho refresh trong cùng tab. Dùng Web Locks/SharedWorker để serialize refresh giữa các tab cùng origin. Nếu hai tab đồng thời dùng cùng refresh token cũ, backend sẽ coi đó là replay và thu hồi phiên, đúng chính sách. Chỉ mutex trong một tab là chưa đủ.

Ví dụ phần refresh dùng Web Locks (cần gắn với state/wrapper thực của ứng dụng):

```js
let accessToken = null;
let currentUser = null;
let accessExpiresAt = 0;
let refreshPromise = null;

async function refreshSession() {
  if (refreshPromise) return refreshPromise;
  const work = async () => {
    const response = await fetch(API + '/auth/refresh', {
      method: 'POST', credentials: 'include', cache: 'no-store'
    });
    if (response.status === 401) {
      accessToken = null; currentUser = null; accessExpiresAt = 0;
      throw new Error('LOGIN_REQUIRED');
    }
    if (!response.ok) throw new Error('AUTH_TEMPORARILY_UNAVAILABLE');
    const payload = await response.json();
    accessToken = payload.access_token;
    currentUser = payload.user;
    accessExpiresAt = Date.now() + payload.expires_in * 1000;
    return payload;
  };
  if (!navigator.locks) {
    // Implement an equivalent cross-tab queue in a SharedWorker for these browsers.
    throw new Error('CROSS_TAB_AUTH_QUEUE_REQUIRED');
  }
  refreshPromise = navigator.locks.request('lths-auth-refresh', work)
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}
```

Không lưu promise/token vào localStorage và không hard-code 8 giờ. Browser tự gửi cookie mới nhất sau khi lấy Web Lock. Các access token đã cấp trước khi refresh vẫn có hiệu lực đến hạn riêng, trừ khi phiên thiết bị bị thu hồi/hết hạn.

Đăng xuất phải POST `/auth/logout` trước khi xóa state trong bộ nhớ, không chỉ xóa token ở UI. Tab khác đang mở sẽ nhận 401 ở lần gọi tiếp theo; có thể thông báo sự kiện logout qua BroadcastChannel, không gửi refresh token qua kênh này.

Frontend hiện có `new EventSource(.../notifications/stream?token=...)` trong `app.js`. Phải thay bằng SSE qua `fetch` có `Authorization: Bearer ...` và đọc `response.body`, rồi nối lại khi access token cần refresh. Access token đăng nhập không còn được nhận qua query string. Các URL tải PDF dùng token `file-download` riêng vẫn hoạt động, nhưng chỉ cho đúng tài liệu và hai route view/download, không thể dùng làm token đăng nhập ở API khác. Không đưa access token mới vào URL để giữ cách EventSource cũ.

## Replay, thu hồi và thao tác nhạy cảm

DB chỉ lưu SHA-256 của refresh token ngẫu nhiên 40 bytes. Một phiên thiết bị có chuỗi token; mỗi lần refresh khóa session rồi token trong transaction, đánh dấu token cũ đã dùng và lưu bản băm token mới. Dùng lại token cũ thu hồi cả chuỗi của **đúng session đó**, không thu hồi các thiết bị khác. Revocation được commit trước khi trả 401; JWT bearer có `sid` và bị từ chối ngay sau khi session bị thu hồi. Cơ chế rotation/replay theo hướng dẫn tại [RFC 9700 §4.14](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14).

Không coi IP hoặc User-Agent là bằng chứng xác thực thiết bị. Trình duyệt có cookie phiên hợp lệ tiếp tục refresh khi đổi mạng; browser mới không có cookie thì cần OTP.

OTP duyệt hủy vẫn dùng challenge riêng đã có, không thay bằng refresh token và không dùng lại OTP đăng nhập. `/auth/force-change-password` nay cần bearer session của chính tài khoản và OTP đăng nhập mới trong 5 phút; `auth_time` lấy từ session, không kéo dài theo refresh. Nếu cần thao tác đó sau 5 phút, chạy lại login OTP để cấp phiên mới trước. Chưa có chức năng thanh toán/đổi số điện thoại trong repo; khi bổ sung phải gắn OTP reauthentication riêng cho các hành động đó.

## Kiểm thử

`npm run test:auth-sessions` kiểm tra CAPTCHA giữa worker, OTP một lần/thử sai/rate limit, cookie-only response, TTL, rotate, replay, refresh đồng thời, session isolation, logout, expiry, CORS Origin guard và kế hoạch migration. Có kiểm thử HTTP với NestJS controller thật cho login/verify/refresh/logout và header cookie; DB/mail vẫn mô phỏng. Cần kiểm tra thêm MySQL row locks thật và việc browser nhận/gửi cookie qua HTTPS sau triển khai. Chưa sửa trực tiếp frontend trong đợt này.

require('dotenv').config();
const http = require('http');

const PORT  = parseInt(process.env.PORT || '3002');
const EMAIL = 'bamoscoffee23@gmail.com';
const PASS  = process.argv[2] || 'admin123'; // truyền password qua argument
const OTP   = process.argv[3] || '';         // truyền OTP qua argument

function request(path, method, headers, body) {
  return new Promise((resolve) => {
    const opts = { hostname: 'localhost', port: PORT, path, method, headers };
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  // Bước 1: Login
  const loginBody = JSON.stringify({ email: EMAIL, password: PASS });
  const login = await request('/auth/login', 'POST',
    { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginBody) },
    loginBody
  );
  console.log('Login status:', login.status);
  const lr = JSON.parse(login.body);

  let token = lr.access_token;

  if (lr.requires_otp) {
    console.log('OTP required — user_id:', lr.user_id);
    console.log('Check server console for OTP code, then run:');
    console.log(`  node test-api.js "${PASS}" <OTP_CODE>`);

    if (!OTP) return;

    // Bước 2: Verify OTP
    const otpBody = JSON.stringify({ user_id: lr.user_id, otp: OTP });
    const otpRes = await request('/auth/verify-otp', 'POST',
      { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(otpBody) },
      otpBody
    );
    console.log('OTP verify status:', otpRes.status);
    const or = JSON.parse(otpRes.body);
    if (!or.access_token) { console.log('OTP failed:', otpRes.body); return; }
    token = or.access_token;
    console.log('OTP OK, user:', or.user?.email);
  }

  if (!token) { console.log('No token'); return; }
  console.log('Token OK');

  // Test /storage/my-files
  const files = await request('/storage/my-files', 'GET',
    { 'Authorization': 'Bearer ' + token }, null
  );
  console.log('\n/storage/my-files status:', files.status);
  try {
    const fr = JSON.parse(files.body);
    console.log('Total files:', fr.total);
    console.log('Data:', JSON.stringify(fr.data?.slice(0,3), null, 2));
  } catch {
    console.log('Response:', files.body.slice(0, 500));
  }
}

main().catch(console.error);

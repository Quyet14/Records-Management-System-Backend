// Offline transaction simulation. No real database, SMTP or browser is used.
require('reflect-metadata');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { DataSource } = require('typeorm');
const fs = require('node:fs');
const path = require('node:path');
const { validate } = require('class-validator');
const { LoginDto } = require('../dist/auth/dto/login.dto');
const { AuthDeviceSessions1792454400000 } = require('../dist/migrations/1792454400000-AuthDeviceSessions');
const { Module, ValidationPipe } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { AuthService } = require('../dist/auth/auth.service');
const { AuthController } = require('../dist/auth/auth.controller');
const { JwtStrategy } = require('../dist/auth/jwt.strategy');
const { AuthOriginGuard } = require('../dist/auth/auth-origin.guard');
const { JwtAuthGuard } = require('../dist/common/guards/jwt-auth.guard');
const cookies = require('../dist/auth/auth-cookie');
const { User } = require('../dist/entities/user.entity');
const { RefreshToken } = require('../dist/entities/refresh-token.entity');
const { AuthSession } = require('../dist/entities/auth-session.entity');
const { AuthCaptcha } = require('../dist/entities/auth-captcha.entity');
const { OtpCode } = require('../dist/entities/otp-code.entity');
const { LoginConfirmation } = require('../dist/entities/login-confirmation.entity');
const { PasswordResetToken } = require('../dist/entities/password-reset-token.entity');
const secret = 'auth-session-tests-only-'.repeat(3);
const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');
const unauthorized = work => assert.rejects(work, error => error.getStatus?.() === 401);

function fixture() {
  let tables = new Map(), tail = Promise.resolve();
  const mail = [], locks = [];
  const rows = entity => { if (!tables.has(entity.name)) tables.set(entity.name, []); return tables.get(entity.name); };
  const matches = (row, where) => Object.entries(where || {}).every(([key, expected]) => {
    if (expected?.type === 'isNull') return row[key] == null;
    if (expected?.type === 'moreThan') return row[key] > expected.value;
    if (expected?.type === 'lessThan') return row[key] < expected.value;
    return expected && typeof expected === 'object' && !(expected instanceof Date)
      ? !!row[key] && matches(row[key], expected) : row[key] === expected;
  });
  const manager = {
    create: (entity, data) => Object.assign(new entity(), data),
    async findOne(entity, options) {
      if (options.lock) locks.push(entity.name);
      const candidates = rows(entity).filter(row => matches(row, options.where));
      if (options.order?.createdAt === 'DESC') candidates.sort((a, b) => b.createdAt - a.createdAt);
      return structuredClone(candidates[0] || null);
    },
    async count(entity, options) { return rows(entity).filter(row => matches(row, options.where)).length; },
    async find(entity, options) { return structuredClone(rows(entity).filter(row => matches(row, options.where))); },
    async save(entity, data) {
      data.id ||= crypto.randomUUID(); data.createdAt ||= new Date();
      const index = rows(entity).findIndex(row => row.id === data.id);
      if (index < 0) rows(entity).push(structuredClone(data)); else rows(entity)[index] = structuredClone(data);
      return data;
    },
    async update(entity, where, changes) {
      if (typeof where === 'string') where = { id: where };
      for (const row of rows(entity)) if (matches(row, where)) Object.assign(row, structuredClone(changes));
    },
    transaction(work) {
      const result = tail.then(async () => {
        const before = structuredClone(tables);
        try { return await work(manager); } catch (error) { tables = before; throw error; }
      });
      tail = result.catch(() => {}); return result;
    },
  };
  const repo = entity => ({ manager,
    findOne: options => manager.findOne(entity, options), update: (where, data) => manager.update(entity, where, data),
    create: data => manager.create(entity, data), save: data => manager.save(entity, data),
  });
  const config = new ConfigService({ JWT_SECRET: secret, SMTP_HOST: '', OTP_ENABLED: 'false', NODE_ENV: 'production',
    CORS_ORIGINS: 'https://frontend.test', AUTH_COOKIE_SECURE: 'true', AUTH_COOKIE_SAME_SITE: 'lax' });
  const jwt = new JwtService();
  const service = new AuthService(repo(User), repo(RefreshToken), repo(OtpCode), repo(LoginConfirmation), repo(PasswordResetToken), jwt, config);
  service.mailer = { sendMail: async message => { mail.push(message); return { accepted: [message.to] }; } };
  const user = Object.assign(new User(), { id: crypto.randomUUID(), fullName: 'Test User', email: 'person@gmail.com',
    role: 'admin', isActive: true, permissions: [], mustChangePassword: true, department: null });
  rows(User).push(structuredClone(user));
  const strategy = new JwtStrategy(config, repo(User), repo(AuthSession));
  return { service, config, jwt, user, mail, rows, locks, manager, strategy };
}
function response() {
  return { headers: {}, cookies: [], cleared: [],
    set(name, value) { this.headers[name] = value; return this; },
    cookie(name, value, options) { this.cookies.push({ name, value, options }); return this; },
    clearCookie(name, options) { this.cleared.push({ name, options }); return this; },
  };
}
function request(raw) { return { headers: raw ? { cookie: `${cookies.REFRESH_COOKIE}=${raw}` } : {}, ip: '127.0.0.1' }; }
async function loginWithOtp(env) {
  await env.service.loginStep1(env.user);
  const otp = env.mail.at(-1).html.match(/>\s*(\d{6})\s*</)?.[1];
  assert(otp, 'The mail transport must receive the OTP');
  return env.service.verifyOtp(env.user.id, otp);
}

async function checkHttpContract() {
  const env = fixture();
  class HttpContractModule {}
  Module({ controllers: [AuthController], providers: [
    { provide: AuthService, useValue: env.service }, { provide: ConfigService, useValue: env.config }, AuthOriginGuard,
  ] })(HttpContractModule);
  const app = await NestFactory.create(HttpContractModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableCors({ origin: 'https://frontend.test', credentials: true });
  await app.listen(0, '127.0.0.1');
  try {
    const base = await app.getUrl();
    const send = (route, body, cookie, origin = 'https://frontend.test') => fetch(base + '/auth/' + route, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body || {}),
    });
    const captcha = await (await fetch(base + '/auth/captcha')).json();
    const code = [...decodeURIComponent(captcha.image.split(',')[1]).matchAll(/<text\b[^>]*>([^<])<\/text>/g)].map(match => match[1]).join('');
    const pendingResponse = await send('login', { email: env.user.email, captcha_id: captcha.captcha_id, captcha_code: code });
    assert.equal(pendingResponse.status, 200);
    assert.equal((await pendingResponse.json()).requires_otp, true);
    const otp = env.mail[0].html.match(/>\s*(\d{6})\s*</)[1];
    const verified = await send('verify-otp', { user_id: env.user.id, otp });
    assert.equal(verified.status, 200);
    assert(!('refresh_token' in await verified.json()));
    const setCookie = verified.headers.get('set-cookie');
    assert(setCookie.includes('HttpOnly') && setCookie.includes('Secure') && setCookie.includes('SameSite=Lax'));
    assert.equal(verified.headers.get('access-control-allow-credentials'), 'true');
    const oldCookie = setCookie.split(';')[0];
    const rotated = await send('refresh', {}, oldCookie);
    assert.equal(rotated.status, 200);
    assert.equal((await rotated.json()).expires_in, 1200);
    const newCookie = rotated.headers.get('set-cookie').split(';')[0];
    assert.notEqual(newCookie, oldCookie);
    const forbidden = await send('refresh', {}, newCookie, 'https://attacker.test');
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.headers.get('set-cookie'), null, 'A rejected cross-origin request must not clear the real session');
    const replayed = await send('refresh', {}, oldCookie);
    assert.equal(replayed.status, 401);
    assert(replayed.headers.get('set-cookie').includes('Expires=Thu, 01 Jan 1970'));
    assert.equal((await send('refresh', {}, newCookie)).status, 401);
    const device = await env.service.login(env.user);
    const loggedOut = await send('logout', {}, `lths_refresh=${device.refresh_token}`);
    assert.equal(loggedOut.status, 204);
    assert.equal((await send('refresh', {}, `lths_refresh=${device.refresh_token}`)).status, 401);
  } finally { await app.close(); }
}

async function main() {
  const dto = Object.assign(new LoginDto(), { email: 'person@gmail.com', captcha_id: crypto.randomUUID(), captcha_code: 'ABCDE' });
  assert.equal((await validate(dto)).length, 0, 'Passwordless login requires email and CAPTCHA, not a password');
  const env = fixture();
  const captcha = await env.service.createCaptcha();
  const code = [...decodeURIComponent(captcha.image.split(',')[1]).matchAll(/<text\b[^>]*>([^<])<\/text>/g)].map(match => match[1]).join('');
  assert.equal(code.length, 5);
  // A second service instance (PM2 worker) uses the same database-backed challenge.
  const worker = Object.assign(Object.create(AuthService.prototype), { usersRepo: { manager: env.manager } });
  await worker.verifyCaptcha(captcha.captcha_id, code);
  await unauthorized(() => env.service.verifyCaptcha(captcha.captcha_id, code));
  const lockedCaptcha = await env.service.createCaptcha();
  for (let i = 0; i < 6; i++) await unauthorized(() => worker.verifyCaptcha(lockedCaptcha.captcha_id, 'wrong'));
  assert.equal(env.rows(AuthCaptcha).find(row => row.id === lockedCaptcha.captcha_id).attempts, 5);

  const first = await loginWithOtp(env);
  assert.equal(first.expires_in, 1200);
  assert.equal(first.refresh_token.length, 80);
  const payload = env.jwt.verify(first.access_token, { secret });
  assert.equal(payload.exp - payload.iat, 1200);
  const family = env.rows(AuthSession).find(row => row.id === payload.sid);
  assert(Math.abs(family.expiresAt - family.createdAt - 30 * 86400000) < 1000);
  assert.equal(env.rows(RefreshToken)[0].tokenHash, hash(first.refresh_token));
  assert(!JSON.stringify(env.rows(RefreshToken)).includes(first.refresh_token));
  await env.strategy.validate(payload);
  const otherDevice = await env.service.login(env.user);
  const mailCount = env.mail.length;
  env.locks.length = 0;
  const rotated = await env.service.refresh(first.refresh_token);
  assert.notEqual(rotated.refresh_token, first.refresh_token);
  assert.notEqual(rotated.access_token, first.access_token);
  assert.equal(env.jwt.decode(rotated.access_token).sid, payload.sid);
  assert.equal(rotated.refresh_expires_at.toISOString(), first.refresh_expires_at.toISOString());
  assert.equal(env.mail.length, mailCount, 'Refresh must not send OTP');
  assert.deepEqual(env.locks, ['AuthSession', 'RefreshToken']);
  assert(env.rows(RefreshToken).find(row => row.tokenHash === hash(first.refresh_token)).consumedAt);
  await unauthorized(() => env.service.refresh(first.refresh_token));
  assert(env.rows(AuthSession).find(row => row.id === payload.sid).revokedAt, 'Replay must commit family revocation');
  await unauthorized(() => env.service.refresh(rotated.refresh_token));
  await unauthorized(() => env.strategy.validate(payload));
  await env.strategy.validate(env.jwt.decode(otherDevice.access_token));
  const otherRotated = await env.service.refresh(otherDevice.refresh_token);
  await env.service.logout(otherRotated.refresh_token);
  await unauthorized(() => env.service.refresh(otherRotated.refresh_token));

  const raced = await env.service.login(env.user);
  const outcomes = await Promise.allSettled([env.service.refresh(raced.refresh_token), env.service.refresh(raced.refresh_token)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
  await unauthorized(() => env.service.refresh(outcomes.find(result => result.status === 'fulfilled').value.refresh_token));
  const expired = await env.service.login(env.user);
  env.rows(AuthSession).find(row => row.id === env.jwt.decode(expired.access_token).sid).expiresAt = new Date(Date.now() - 1);
  await unauthorized(() => env.service.refresh(expired.refresh_token));
  const deviceA = await env.service.login(env.user), deviceB = await env.service.login(env.user);
  await env.service.revokeAllSessions(env.user.id);
  await unauthorized(() => env.service.refresh(deviceA.refresh_token));
  await unauthorized(() => env.service.refresh(deviceB.refresh_token));
  await unauthorized(() => env.strategy.validate({ sub: env.user.id }));
  for (const raw of [undefined, null, '', '  ', {}, Buffer.from('token')]) await unauthorized(() => env.service.refresh(raw));

  // Invalid OTP attempts commit, and the same correct OTP cannot create two sessions.
  const otpEnv = fixture();
  const pending = await otpEnv.service.loginStep1(otpEnv.user);
  assert.equal(pending.requires_otp, true, 'OTP_ENABLED=false must not bypass mailbox verification');
  const otherUser = Object.assign(new User(), { ...otpEnv.user, id: crypto.randomUUID(), email: 'other@gmail.com' });
  otpEnv.rows(User).push(structuredClone(otherUser));
  const otherPending = await otpEnv.service.loginStep1(otherUser);
  assert.equal(otherPending.requires_otp, true, 'A different account must not inherit the first account cooldown');
  await assert.rejects(() => otpEnv.service.loginStep1(otpEnv.user), error => error.getStatus?.() === 429);
  const otp = otpEnv.mail[0].html.match(/>\s*(\d{6})\s*</)[1];
  const wrong = otp === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await unauthorized(() => otpEnv.service.verifyOtp(otpEnv.user.id, wrong));
  await unauthorized(() => otpEnv.service.verifyOtp(otpEnv.user.id, otp));
  assert.equal(otpEnv.rows(OtpCode)[0].attempts, 5);
  assert.equal(otpEnv.rows(AuthSession).length, 0);
  await assert.rejects(() => otpEnv.service.loginStep1(otpEnv.user), error => error.getStatus?.() === 429);
  const firstAccountOtp = otpEnv.rows(OtpCode).find(row => row.user.id === otpEnv.user.id);
  assert(otpEnv.rows(User)[0].authLockedUntil > new Date(), 'Five invalid OTPs must temporarily lock the account');
  otpEnv.rows(User)[0].authLockedUntil = new Date(Date.now() - 1);
  firstAccountOtp.createdAt = new Date(Date.now() - 61000);
  await otpEnv.service.loginStep1(otpEnv.user);
  const nextOtp = otpEnv.mail.at(-1).html.match(/>\s*(\d{6})\s*</)[1];
  const verifications = await Promise.allSettled([otpEnv.service.verifyOtp(otpEnv.user.id, nextOtp), otpEnv.service.verifyOtp(otpEnv.user.id, nextOtp)]);
  assert.equal(verifications.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(otpEnv.rows(AuthSession).length, 1);
  const smtp = fixture(); smtp.service.mailer.sendMail = async () => { throw Error('offline'); };
  await assert.rejects(() => smtp.service.loginStep1(smtp.user), error => error.getStatus?.() === 503);
  assert.equal(smtp.rows(OtpCode)[0].isUsed, true);

  // Browser contract: cookie only, no raw refresh token or expiration internals in JSON.
  const browser = fixture(), controller = new AuthController(browser.service, browser.config);
  const browserToken = await browser.service.login(browser.user);
  const res = response();
  const json = await controller.refresh(request(browserToken.refresh_token), res);
  assert(!('refresh_token' in json)); assert(!('refresh_expires_at' in json));
  assert.equal(json.expires_in, 1200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.cookies[0].options.httpOnly, true);
  assert.equal(res.cookies[0].options.secure, true);
  assert.equal(res.cookies[0].options.sameSite, 'lax');
  assert.equal(res.cookies[0].options.path, '/auth');
  assert(res.cookies[0].options.maxAge <= 30 * 86400000);
  assert.equal(cookies.readRefreshCookie(request(res.cookies[0].value)), res.cookies[0].value);
  const noCookie = response();
  await unauthorized(() => controller.refresh({ ...request(), body: { refresh_token: res.cookies[0].value } }, noCookie));
  assert.equal(noCookie.cleared.length, 1, '401 must clear the unusable browser cookie');
  assert.equal(cookies.readRefreshCookie({ headers: { cookie: `lths_refresh=${'a'.repeat(80)}; lths_refresh=${'b'.repeat(80)}` } }), undefined);
  assert.throws(() => cookies.refreshCookieOptions(new ConfigService({ NODE_ENV: 'production', AUTH_COOKIE_SECURE: 'false' })));
  assert.throws(() => cookies.refreshCookieOptions(new ConfigService({ NODE_ENV: 'development', AUTH_COOKIE_SECURE: 'false', AUTH_COOKIE_SAME_SITE: 'none' })));
  const guard = new AuthOriginGuard(browser.config);
  const context = headers => ({ switchToHttp: () => ({ getRequest: () => ({ method: 'POST', protocol: 'https', get: name => headers[name] }) }) });
  assert.equal(guard.canActivate(context({ origin: 'https://frontend.test', host: 'api.test' })), true);
  assert.throws(() => guard.canActivate(context({ origin: 'https://attacker.test', host: 'api.test' })), error => error.getStatus() === 403);
  assert.throws(() => guard.canActivate(context({ 'sec-fetch-site': 'cross-site', host: 'api.test' })), error => error.getStatus() === 403);
  const jwtGuard = new JwtAuthGuard();
  const fileActor = { id: browser.user.id, role: 'admin', tokenType: 'file-download', fileId: 'doc-1' };
  const routeContext = (route, id = 'doc-1') => ({ switchToHttp: () => ({ getRequest: () => ({ method: 'GET', route: { path: route }, params: { id } }) }) });
  assert.equal(jwtGuard.handleRequest(null, fileActor, null, routeContext('/documents/:id/download')), fileActor);
  assert.throws(() => jwtGuard.handleRequest(null, fileActor, null, routeContext('/users')), error => error.getStatus() === 401);
  assert.throws(() => jwtGuard.handleRequest(null, fileActor, null, routeContext('/documents/:id/download', 'doc-2')), error => error.getStatus() === 401);
  // Verify the real MySQL metadata and migration plan without connecting to a server.
  const entityDir = path.join(__dirname, '../dist/entities');
  const entities = fs.readdirSync(entityDir).filter(name => name.endsWith('.entity.js'))
    .flatMap(name => Object.values(require(path.join(entityDir, name))).filter(value => typeof value === 'function'));
  const ds = new DataSource({ type: 'mysql', database: 'offline', entities }); await ds.buildMetadatas();
  const sql = [], tables = [], columns = [], foreignKeys = [];
  await new AuthDeviceSessions1792454400000().up({ connection: ds,
    createTable: async table => { tables.push(table.name); }, hasColumn: async () => false,
    addColumn: async (_table, column) => { columns.push(column.name); },
    getTable: async () => ({ indices: [], foreignKeys: [] }), createIndex: async () => {},
    createForeignKey: async (_table, key) => { foreignKeys.push(key); },
    query: async query => { sql.push(query); return query.startsWith('SHOW FULL') ? [{ Type: 'varchar(36)', Collation: 'utf8mb4_unicode_ci' }] : []; },
  });
  assert.deepEqual(tables, ['auth_sessions', 'auth_captchas']);
  assert.deepEqual(columns, ['session_id', 'consumed_at']);
  assert.equal(foreignKeys[0].onDelete, 'CASCADE');
  assert(sql.some(query => query.includes('WHERE session_id IS NULL')));
  assert(!sql.some(query => /DROP TABLE|TRUNCATE/.test(query)));
  await checkHttpContract();
  const idle = fixture();
  const idleSession = await idle.service.login(idle.user);
  const idlePayload = idle.jwt.decode(idleSession.access_token);
  idle.rows(AuthSession)[0].lastSeenAt = new Date(Date.now() - 31 * 60000);
  await unauthorized(() => idle.strategy.validate(idlePayload));
  await unauthorized(() => idle.service.refresh(idleSession.refresh_token));
  const devices = fixture(), current = await devices.service.login(devices.user), another = await devices.service.login(devices.user);
  const currentId = devices.jwt.decode(current.access_token).sid, anotherId = devices.jwt.decode(another.access_token).sid;
  const deviceList = await devices.service.listSessions(devices.user.id, currentId);
  assert.equal(deviceList.length, 2); assert.equal(deviceList.filter(row => row.current).length, 1);
  await unauthorized(() => devices.service.logoutDevice('another-user', anotherId));
  await devices.service.logoutDevice(devices.user.id, anotherId);
  await unauthorized(() => devices.strategy.validate(devices.jwt.decode(another.access_token)));
  await devices.strategy.validate(devices.jwt.decode(current.access_token));
  const reset = fixture();
  await reset.service.forgotPassword(reset.user.email);
  await assert.rejects(() => reset.service.forgotPassword(reset.user.email), error => error.getStatus?.() === 429);
  const resetCode = reset.mail[0].html.match(/>\s*(\d{6})\s*</)[1];
  const resetRace = await Promise.allSettled([reset.service.verifyResetOtp(reset.user.email, resetCode), reset.service.verifyResetOtp(reset.user.email, resetCode)]);
  assert.equal(resetRace.filter(result => result.status === 'fulfilled').length, 1);
  const resetToken = resetRace.find(result => result.status === 'fulfilled').value.reset_token;
  const passwordRace = await Promise.allSettled([reset.service.resetPassword(resetToken, 'New-password-123', 'New-password-123'),
    reset.service.resetPassword(resetToken, 'Other-password-456', 'Other-password-456')]);
  assert.equal(passwordRace.filter(result => result.status === 'fulfilled').length, 1);
  console.log('PASS: OTP/CAPTCHA across workers, 20-minute access tokens, fixed 30-day device sessions, rotation/replay/races, device isolation, logout, cookies, Origin checks and expiry.');
  console.log('LIMIT: SQL transactions and mail transport are simulated. Live MySQL contention and browser HTTPS/CORS acceptance require deployment verification.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

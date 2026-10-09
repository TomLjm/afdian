/**
 * 面翼 License 服务 · 核心业务逻辑（纯函数 + 依赖注入 store，可单测）。
 * 覆盖 T12-a 面包多 webhook、T12-b 扣额度/429、T12-c 多设备绑定/离线宽限、
 * T12-d 批量发码、T12-e 返回真实邀请码，以及与网关（new-api）的用户 token 签发。
 */
import crypto from 'node:crypto';

export class QuotaExhaustedError extends Error {
  constructor(msg = '额度已用尽') { super(msg); this.code = 'quota_exhausted'; this.status = 429; }
}
export class DeviceLimitError extends Error {
  constructor(msg = '设备数已达上限') { super(msg); this.code = 'device_limit'; this.status = 403; }
}
export class UnauthorizedError extends Error {
  constructor(msg = '未授权') { super(msg); this.code = 'unauthorized'; this.status = 401; }
}

const DEFAULT_CONFIG = {
  inviterQuota: 5, // 邀请人 +N 分钟（时长口径）
  inviteeQuota: 3, // 被邀请人 +N 分钟（时长口径）
  trialFreeQuota: 30, // 免费试用 30 分钟
  maxDevices: 2,
  offlineGraceMs: 3 * 24 * 3600 * 1000, // 3 天离线宽限
  breadSecret: '',
  /** 面包多商品ID -> { quota, days } 映射（quota 单位为分钟，days 为会员有效天数，0=不限天数） */
  breadProductMap: {},
  devMasterKey: '',
  /** 网关用户 token 签发器：async ({quota, expiresAt, licenseHint}) => gatewayToken；未配置则回退自签 token */
  gatewayTokenIssuer: undefined,
  /** 邮箱验证码发信器：async ({to, code, purpose}) => void；未配置则打日志（dev 模式） */
  emailSender: undefined,
  /** 邮箱验证码有效期（毫秒） */
  emailCodeTtlMs: 10 * 60 * 1000,
  /** 配置了 emailSender 时，注册是否可跳过邮箱验证码（默认不跳过） */
  emailVerifyOptional: false,
  /** 管理统计接口 Key（X-Admin-Key 头）；空=禁用 */
  adminStatsKey: '',
  /** 爱发电 Webhook 签名 token（后台「开发者设置」）；空=webhook 禁用 */
  afdianToken: '',
  /** 爱发电 plan_id -> 发货内容：
   *  时长档 { type:'minutes', minutes, bonusPoints }
   *  积分档 { type:'points', points } */
  afdianProductMap: {},
  /** 积分消费单价（次）：简历优化 / 模拟面试 */
  pointsCostMap: { resume: 3, mock: 15 },
  /** 充值账户网关 token 配额追加器：async (account, minutes) => boolean；
   *  未配置则仅本地加分钟（网关配额不同步） */
  gatewayTokenTopUp: undefined,
};

export function genToken() {
  return 'mw_' + crypto.randomBytes(24).toString('hex');
}
/** 邮箱会话令牌（登录态） */
export function genSessionToken() {
  return 'sess_' + crypto.randomBytes(24).toString('hex');
}
/** 邮箱验证码（6 位数字） */
export function genEmailCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
/** scrypt 密码哈希：`salt:hash`；不引入新依赖 */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
export function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return h === hash;
}
export function genInviteCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}
export function genLicenseCode() {
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `MW-${part()}-${part()}-${part()}`;
}
/** 充值票据（爱发电 remark 关联用户，一次性使用） */
export function genRechargeToken() {
  return 'rc_' + crypto.randomBytes(8).toString('hex');
}
export function md5Hex(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex');
}
export function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}
export function verifyBreadSignature(secret, body, signature) {
  if (!secret || !signature) return false;
  const expected = hmacHex(secret, body);
  // 防时序攻击
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createLicenseService(store, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  /** token（自签或网关）-> 账号 */
  const resolveAccount = (t) => store.getAccountByToken(t) || store.getAccountByGatewayToken(t);

  /** 激活核心逻辑（同步纯逻辑；gatewayToken 已由调用方 resolve；userId=邮箱账号可选绑定） */
  function commitActivate(c, d, gatewayToken, userId) {
    if (cfg.devMasterKey && c === cfg.devMasterKey) {
      const invite = genInviteCode();
      const account = store.createAccount({ token: genToken(), gateway_token: gatewayToken, device_id: d, license_hint: 'DEV', quota_remaining: -1, invite_code: invite, devices: [d], user_id: userId ?? null });
      return { token: gatewayToken || account.token, licenseHint: 'DEV', quotaRemaining: -1, inviteCode: invite };
    }

    const lic = store.getLicense(c);
    if (!lic) throw Object.assign(new Error('激活码不存在'), { status: 404 });
    if (lic.status === 'bound') throw Object.assign(new Error('激活码已被使用'), { status: 409 });

    const token = genToken();
    const invite = genInviteCode();
    const account = store.createAccount({
      token,
      gateway_token: gatewayToken,
      device_id: d,
      license_hint: c.slice(-4),
      expires_at: lic.expires_at ?? null,
      quota_remaining: lic.quota ?? 0,
      invite_code: invite,
      devices: [d],
      user_id: userId ?? null,
    });
    store.bindLicense(c, account.id);
    return {
      token: gatewayToken || account.token,
      licenseHint: c.slice(-4),
      expiresAt: lic.expires_at || undefined,
      quotaRemaining: account.quota_remaining,
      inviteCode: invite, // T12-e：真实生成的邀请码
    };
  }

  /** T12-e：同步激活（仅同步 issuer / 无网关场景，供单测与纯逻辑调用） */
  function activate({ code, deviceId, sessionToken }) {
    const c = String(code || '').trim();
    const d = String(deviceId || '').trim();
    if (!c || !d) throw Object.assign(new Error('缺少 code 或 deviceId'), { status: 400 });
    const userId = sessionToken ? store.getUserBySession(sessionToken)?.id : null;
    const gatewayToken = (() => {
      if (!cfg.gatewayTokenIssuer) return null;
      const r = cfg.gatewayTokenIssuer({ quota: -1, expiresAt: null, licenseHint: 'DEV' });
      return r && typeof r.then === 'function' ? null : r; // 异步 issuer 请用 activateAsync
    })();
    return commitActivate(c, d, gatewayToken, userId);
  }

  /** 生产激活：await 网关 token 签发（new-api）；带 sessionToken 则绑定到邮箱账号 */
  async function activateAsync({ code, deviceId, sessionToken }) {
    const c = String(code || '').trim();
    const d = String(deviceId || '').trim();
    if (!c || !d) throw Object.assign(new Error('缺少 code 或 deviceId'), { status: 400 });
    const user = sessionToken ? store.getUserBySession(sessionToken) : undefined;
    if (sessionToken && !user) throw new UnauthorizedError('登录态无效');
    // 先解析网关 token，再提交账号（避免 Promise 落库）
    let gatewayToken = null;
    if (cfg.gatewayTokenIssuer) {
      const meta = cfg.devMasterKey && c === cfg.devMasterKey
        ? { quota: -1, expiresAt: null, licenseHint: 'DEV' }
        : (() => { const lic = store.getLicense(c); return { quota: lic?.quota ?? 0, expiresAt: lic?.expires_at ?? null, licenseHint: c.slice(-4) }; })();
      gatewayToken = await cfg.gatewayTokenIssuer(meta);
    }
    return commitActivate(c, d, gatewayToken, user?.id ?? null);
  }
  /** T12-b：额度预检，不足抛 429 */
  function precheckQuota(token, n = 1) {
    const acc = resolveAccount(token);
    if (!acc) throw new UnauthorizedError();
    if (acc.quota_remaining === -1) return { ok: true, remaining: -1 };
    if (acc.quota_remaining >= n) return { ok: true, remaining: acc.quota_remaining - n };
    throw new QuotaExhaustedError();
  }

  /** T12-b：事务扣减额度；不足抛 429 */
  function consumeQuota(token, n = 1) {
    let remaining = null;
    store.transaction(() => {
      const acc = resolveAccount(token);
      if (!acc) throw new UnauthorizedError();
      if (acc.quota_remaining === -1) { remaining = -1; return; }
      if (acc.quota_remaining < n) throw new QuotaExhaustedError();
      remaining = store.updateAccountQuota(token, -n);
    });
    return { remaining };
  }

  /** T12-c：设备绑定（有设备数上限；已绑定直接通过） */
  function bindDevice(token, deviceId) {
    const acc = resolveAccount(token);
    if (!acc) throw new UnauthorizedError();
    if (acc.devices?.includes(deviceId)) return { devices: acc.devices, bound: false };
    const devices = store.bindDevice(token, deviceId) || [];
    if (devices.length > cfg.maxDevices) {
      // 回滚
      store.unbindDevice(token, deviceId);
      throw new DeviceLimitError(`最多绑定 ${cfg.maxDevices} 台设备，可在官网解绑旧设备`);
    }
    return { devices, bound: true };
  }

  function unbindDevice(token, deviceId) {
    store.unbindDevice(token, deviceId);
    return { ok: true };
  }

  function accountMe(token) {
    const acc = resolveAccount(token);
    if (!acc) throw new UnauthorizedError();
    return {
      licenseHint: acc.license_hint,
      expiresAt: acc.expires_at,
      quotaRemaining: acc.quota_remaining,
      inviteCode: acc.invite_code,
      devices: acc.devices || [],
    };
  }

  /** 邀请兑换：双方各加额度（配置常量） */
  function redeemInvite({ token, code }) {
    const acc = resolveAccount(token);
    if (!acc) throw new UnauthorizedError();
    const c = String(code || '').trim().toUpperCase();
    if (!c) throw Object.assign(new Error('邀请码不能为空'), { status: 400 });
    const inv = store.getInvite(c);
    if (!inv) throw Object.assign(new Error('邀请码不存在'), { status: 404 });
    if (inv.used) throw Object.assign(new Error('邀请码已被使用'), { status: 409 });

    store.transaction(() => {
      store.updateAccountQuota(inv.inviter_token, cfg.inviterQuota);
      store.updateAccountQuota(token, cfg.inviteeQuota);
      store.markInviteUsed(c);
    });
    return { ok: true, added: cfg.inviteeQuota, remaining: resolveAccount(token).quota_remaining };
  }

  /** T12-a：面包多 webhook 回调 → 自动生成未使用激活码 */
  function webhookBread(payload, signature) {
    if (!verifyBreadSignature(cfg.breadSecret, JSON.stringify(payload), signature)) {
      throw Object.assign(new Error('验签失败'), { status: 401 });
    }
    // 面包多常见字段：status / product_id / order_no ...
    const status = String(payload.status || payload.state || '');
    if (status && !['paid', 'success', '1', 'PAID'].includes(status)) {
      return { ok: false, reason: 'unpaid' };
    }
    const productId = String(payload.product_id || payload.productId || '');
    const mapping = cfg.breadProductMap[productId];
    if (!mapping) throw Object.assign(new Error('未配置该商品的发货映射'), { status: 400 });

    const expiresAt = mapping.days > 0 ? Date.now() + mapping.days * 24 * 3600 * 1000 : null;
    const code = genLicenseCode();
    store.createLicenses([{ code, quota: mapping.quota ?? 0, expires_at: expiresAt }]);
    return { ok: true, code, quota: mapping.quota ?? 0, expiresAt };
  }

  /** T12-d：批量生成激活码，返回码列表（quota 单位为分钟） */
  function batchCreateLicenses({ count, quota, days }) {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0 || n > 10000) throw Object.assign(new Error('count 需为 1-10000'), { status: 400 });
    const expiresAt = days > 0 ? Date.now() + days * 24 * 3600 * 1000 : null;
    const items = Array.from({ length: n }, () => ({ code: genLicenseCode(), quota: Number(quota) || 0, expires_at: expiresAt }));
    return store.createLicenses(items);
  }

  /** 免费试用：按 deviceId 限领一次，签发 trialFreeQuota 分钟网关令牌 */
  async function createTrial({ deviceId }) {
    const d = String(deviceId || '').trim();
    if (!d) throw Object.assign(new Error('缺少 deviceId'), { status: 400 });
    if (store.getTrial(d)) {
      const err = Object.assign(new Error('该设备已领取过免费试用'), { status: 409, code: 'trial_used' });
      throw err;
    }
    const quota = Number(cfg.trialFreeQuota) || 30;
    let gatewayToken = null;
    if (cfg.gatewayTokenIssuer) {
      gatewayToken = await cfg.gatewayTokenIssuer({ quota, expiresAt: null, licenseHint: 'TRIAL' });
    }
    const token = genToken();
    const invite = genInviteCode();
    store.createTrial(d);
    const account = store.createAccount({
      token,
      gateway_token: gatewayToken,
      device_id: d,
      license_hint: 'TRIAL',
      expires_at: null,
      quota_remaining: quota,
      invite_code: invite,
      devices: [d],
    });
    return {
      token: gatewayToken || account.token,
      licenseHint: 'TRIAL',
      quotaRemaining: account.quota_remaining,
      inviteCode: invite,
    };
  }

  // ================= 邮箱账号体系（方案 B） =================

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const requireUser = (sessionToken) => {
    const u = store.getUserBySession(sessionToken);
    if (!u) throw new UnauthorizedError('登录态无效或已过期');
    return u;
  };

  /** 发送邮箱验证码（purpose: register/reset/verify）；发信器未配置时打日志 */
  async function sendEmailCode({ email, purpose }) {
    const e = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(e)) throw Object.assign(new Error('邮箱格式不正确'), { status: 400 });
    if (purpose === 'register' && store.getUserByEmail(e)) throw Object.assign(new Error('该邮箱已注册'), { status: 409 });
    const code = genEmailCode();
    store.saveEmailCode(e, purpose, code, Date.now() + cfg.emailCodeTtlMs);
    if (cfg.emailSender) {
      try {
        await cfg.emailSender({ to: e, code, purpose });
      } catch (err) {
        console.error('[license] email send failed:', err.message);
        // 不因发信失败阻断流程（dev 模式仍可看日志验证码）
      }
    } else {
      console.log(`[license] [dev] email code for ${e} (${purpose}): ${code}`);
    }
    return { ok: true, devCode: cfg.emailSender ? undefined : code };
  }

  /** 注册：邮箱+密码 → 返回会话令牌 */
  function register({ email, password, code }) {
    const e = String(email || '').trim().toLowerCase();
    const pw = String(password || '');
    if (!EMAIL_RE.test(e)) throw Object.assign(new Error('邮箱格式不正确'), { status: 400 });
    if (pw.length < 8) throw Object.assign(new Error('密码至少 8 位'), { status: 400 });
    if (store.getUserByEmail(e)) throw Object.assign(new Error('该邮箱已注册，请直接登录'), { status: 409 });
    if (cfg.emailSender && !cfg.emailVerifyOptional) {
      const rec = store.getEmailCode(e, 'register');
      if (!rec || rec.code !== code || rec.expires_at < Date.now()) {
        throw Object.assign(new Error('邮箱验证码错误或已过期'), { status: 400 });
      }
      store.clearEmailCode(e, 'register');
    }
    const sessionToken = genSessionToken();
    const user = store.createUser({ email: e, password_hash: hashPassword(pw), session_token: sessionToken });
    return { sessionToken, email: user.email };
  }

  /** 登录：邮箱+密码 → 会话令牌 */
  function login({ email, password }) {
    const e = String(email || '').trim().toLowerCase();
    const u = store.getUserByEmail(e);
    if (!u || !verifyPassword(String(password || ''), u.password_hash)) {
      throw Object.assign(new Error('邮箱或密码错误'), { status: 401 });
    }
    const sessionToken = genSessionToken();
    store.setUserSession(e, sessionToken);
    return { sessionToken, email: u.email };
  }

  /** 邮箱验证码登录：验证码正确即登录；新邮箱（未注册）自动注册并登录（无密码账号） */
  function codeLogin({ email, code, purpose = 'login' }) {
    const e = String(email || '').trim().toLowerCase();
    const rec = store.getEmailCode(e, purpose);
    if (!rec || rec.code !== String(code || '') || rec.expires_at < Date.now()) {
      throw Object.assign(new Error('验证码错误或已过期'), { status: 400 });
    }
    store.clearEmailCode(e, purpose);
    let u = store.getUserByEmail(e);
    if (!u) {
      // 新邮箱：验证码正确即视为注册成功（password_hash 为 null，之后可走验证码登录或重置密码设密）
      u = store.createUser({ email: e, password_hash: null });
    }
    const sessionToken = genSessionToken();
    store.setUserSession(e, sessionToken);
    return { sessionToken, email: u.email };
  }

  /** 重置密码：邮箱验证码校验后改密 */
  function resetPassword({ email, code, newPassword }) {
    const e = String(email || '').trim().toLowerCase();
    if (!store.getUserByEmail(e)) throw Object.assign(new Error('该邮箱尚未注册'), { status: 404 });
    const rec = store.getEmailCode(e, 'reset');
    if (!rec || rec.code !== String(code || '') || rec.expires_at < Date.now()) {
      throw Object.assign(new Error('验证码错误或已过期'), { status: 400 });
    }
    if (String(newPassword || '').length < 8) throw Object.assign(new Error('新密码至少 8 位'), { status: 400 });
    store.clearEmailCode(e, 'reset');
    store.setUserPassword(e, hashPassword(newPassword));
    return { ok: true };
  }

  /** 退出登录：清会话 */
  function logout({ sessionToken }) {
    const u = store.getUserBySession(sessionToken);
    if (u) store.setUserSession(u.email, null);
    return { ok: true };
  }

  /** 账号名下额度账户列表 + 积分余额（自助查额度） */
  function listUserAccounts(sessionToken) {
    const u = requireUser(sessionToken);
    return {
      points: u.points ?? 0,
      accounts: store.listAccountsByUser(u.id).map((a) => ({
        licenseHint: a.license_hint,
        expiresAt: a.expires_at,
        quotaRemaining: a.quota_remaining,
        inviteCode: a.invite_code,
        devices: a.devices || [],
        /** 充值账户网关 token（客户端同步最新可用 token 用） */
        gatewayToken: a.license_hint === 'RECHARGE' ? (a.gateway_token || undefined) : undefined,
      })),
    };
  }

  /** 直充档位列表（客户端渲染充值页用；按价格升序） */
  function listRechargePlans() {
    return Object.entries(cfg.afdianProductMap)
      .map(([planId, p]) => ({
        planId,
        type: p.type,
        title: p.title || planId,
        minutes: p.minutes,
        bonusPoints: p.bonusPoints,
        points: p.points,
        price: p.price != null ? p.price : p.type === 'points' ? p.points : Math.max(1, Math.round((p.minutes || 0) / 60) * 29),
      }))
      .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
  }

  /**
   * 直充下单（客户端充值按钮）：
   * 为当前登录用户创建一次性充值票据 rc_xxx，返回爱发电购买链接（remark 携带票据）。
   * 用户在爱发电付款后，服务端收到 webhook，按 remark 定位用户并自动发货。
   */
  function createRechargeOrder({ sessionToken, planId }) {
    const u = requireUser(sessionToken);
    const pid = String(planId || '').trim();
    const plan = cfg.afdianProductMap[pid];
    if (!pid || !plan) throw Object.assign(new Error('未知的充值档位'), { status: 400 });
    const id = genRechargeToken();
    store.createRechargeOrder({ id, userId: u.id, planId: pid });
    return {
      orderToken: id,
      buyUrl: `https://afdian.com/order/create?plan_id=${encodeURIComponent(pid)}&remark=${id}`,
      planId: pid,
    };
  }

  /** 内部发货：按档位给用户加时长（积分档由调用方直接处理） */
  async function rechargeForUser(userId, plan) {
    const accounts = store.listAccountsByUser(userId);
    const rechargeAcc = accounts.find((a) => a.license_hint === 'RECHARGE');
    if (rechargeAcc) {
      // 已有充值账户：累加本地分钟 + 同步网关 token 配额
      if (typeof cfg.gatewayTokenTopUp === 'function') {
        try { await cfg.gatewayTokenTopUp(rechargeAcc, plan.minutes); }
        catch (e) { console.error('[license] gateway topup failed:', e.message); }
      }
      store.updateAccountQuota(rechargeAcc.token, plan.minutes);
    } else {
      // 首次充值：签发新网关 token + 创建充值账户
      let gw = null;
      if (typeof cfg.gatewayTokenIssuer === 'function') {
        try { gw = await cfg.gatewayTokenIssuer({ quota: plan.minutes, expiresAt: null, licenseHint: 'RECHARGE' }); }
        catch (e) { console.error('[license] gateway token issue failed:', e.message); }
      }
      const t = genToken();
      store.createAccount({
        token: t, gateway_token: gw, license_hint: 'RECHARGE',
        quota_remaining: plan.minutes, invite_code: null, devices: [], user_id: userId,
      });
    }
  }

  /**
   * 爱发电 Webhook 回调：
   * 验签（md5(ts + token + data JSON)）→ 按 remark 定位充值票据 → 幂等发货。
   * 回调体：{ type:'order', data:{ order:{ out_trade_no, plan_id, remark, user_id, ... } }, sign, ts }
   */
  async function webhookAfdian(payload) {
    const body = payload || {};
    const data = body.data;
    if (!data || typeof data !== 'object') throw Object.assign(new Error('回调格式错误'), { status: 400 });
    // 验签
    if (!cfg.afdianToken) throw Object.assign(new Error('服务端未配置爱发电 Token'), { status: 500 });
    const sign = String(body.sign || '');
    const ts = String(body.ts ?? '');
    if (md5Hex(ts + cfg.afdianToken + JSON.stringify(data)) !== sign) {
      // 诊断日志：输出爱发电请求体与各候选验签结果，用于校准算法
      try {
        console.error('[AFDIAN] sign-fail ts=' + ts + ' sign=' + sign +
          ' exp1=' + md5Hex(ts + cfg.afdianToken + JSON.stringify(data)) +
          ' exp2=' + md5Hex(ts + cfg.afdianToken + md5Hex(JSON.stringify(data))) +
          ' exp3=' + md5Hex(ts + cfg.afdianToken) +
          ' body=' + JSON.stringify(body).slice(0, 2000));
      } catch (e) { /* ignore */ }
      throw Object.assign(new Error('签名校验失败'), { status: 401 });
    }
    const order = data.order || {};
    const outTradeNo = String(order.out_trade_no || '');
    const planId = String(order.plan_id || '').trim();
    const remark = String(order.remark || '').trim();
    if (!remark.startsWith('rc_')) return { ok: true, ignored: true }; // 非本产品直充订单：静默忽略，避免爱发电重试
    const ro = store.getRechargeOrder(remark);
    if (!ro) throw Object.assign(new Error('充值票据不存在'), { status: 404 });
    if (ro.status === 'done') return { ok: true, already: true }; // 幂等：同一票据不重复发货
    const plan = cfg.afdianProductMap[planId];
    if (!plan) throw Object.assign(new Error('未知档位，未发货'), { status: 400 });
    if (plan.type === 'points') {
      const u = store.getUserById(ro.user_id);
      if (!u) throw Object.assign(new Error('用户不存在'), { status: 404 });
      store.addUserPoints(u.email, plan.points);
    } else {
      await rechargeForUser(ro.user_id, plan);
      if (plan.bonusPoints) {
        const u = store.getUserById(ro.user_id);
        if (u) store.addUserPoints(u.email, plan.bonusPoints);
      }
    }
    store.markRechargeDone(remark, outTradeNo);
    return { ok: true };
  }

  /** 积分消费：简历优化 3 分 / 模拟面试 15 分（按次，session 鉴权） */
  function consumePoints({ sessionToken, item }) {
    const u = requireUser(sessionToken);
    const cost = cfg.pointsCostMap[item];
    if (!cost) throw Object.assign(new Error('未知的积分项目'), { status: 400 });
    const left = store.deductUserPoints(u.email, cost);
    if (left === null) throw Object.assign(new Error('积分不足，请先充值'), { status: 402 });
    return { ok: true, item, cost, points: left };
  }

  /** 认领激活码到当前邮箱账号（未激活→激活并绑定；已激活未绑定→绑定；已绑定本人→幂等返回） */
  async function claimCode({ code, deviceId, sessionToken }) {
    const u = requireUser(sessionToken);
    const c = String(code || '').trim();
    const d = String(deviceId || '').trim();
    if (!c) throw Object.assign(new Error('缺少激活码'), { status: 400 });
    const lic = store.getLicense(c);
    if (!lic) throw Object.assign(new Error('激活码不存在'), { status: 404 });
    if (lic.status === 'unused') {
      // 未激活：走激活流程并绑定
      const r = await activateAsync({ code: c, deviceId: d || `claim-${u.id}`, sessionToken });
      return { ...r, claimed: true };
    }
    // 已激活：定位其 account
    const acc = store.listAccounts().find((a) => a.id === lic.account_id);
    if (!acc) throw Object.assign(new Error('激活码状态异常'), { status: 500 });
    if (acc.user_id && acc.user_id !== u.id) throw Object.assign(new Error('该激活码已绑定其他账号'), { status: 409 });
    if (acc.user_id === u.id) {
      return {
        claimed: true, already: true, licenseHint: acc.license_hint, expiresAt: acc.expires_at,
        quotaRemaining: acc.quota_remaining, inviteCode: acc.invite_code, devices: acc.devices || [],
      };
    }
    store.linkAccountToUser(acc.token, u.id);
    return {
      claimed: true, licenseHint: acc.license_hint, expiresAt: acc.expires_at,
      quotaRemaining: acc.quota_remaining, inviteCode: acc.invite_code, devices: acc.devices || [],
    };
  }

  /** 管理员统计：总览（需 X-Admin-Key） */
  function adminStats(adminKey) {
    if (!cfg.adminStatsKey || adminKey !== cfg.adminStatsKey) {
      throw Object.assign(new Error('管理密钥错误'), { status: 401 });
    }
    const users = store.listAccounts();
    const licenses = store.listLicenses();
    const bound = licenses.filter((l) => l.status === 'bound');
    const byTier = {};
    for (const l of bound) {
      const hint = (() => { const a = users.find((x) => x.id === l.account_id); return a?.license_hint || '?'; })();
      const tier = byTier[hint] || (byTier[hint] = { count: 0, quotaTotal: 0, quotaLeft: 0 });
      const acc = users.find((x) => x.id === l.account_id);
      tier.count += 1;
      tier.quotaTotal += (l.quota || 0);
      tier.quotaLeft += Math.max(0, acc?.quota_remaining ?? 0);
    }
    const userCount = store.countUsers();
    const deviceCount = users.reduce((n, a) => n + (a.devices?.length || 0), 0);
    return {
      userCount,
      licenseTotal: licenses.length,
      licenseUsed: bound.length,
      licenseUnused: licenses.length - bound.length,
      deviceCount,
      tiers: byTier,
    };
  }

  return {
    precheckQuota,
    consumeQuota,
    bindDevice,
    unbindDevice,
    activate,
    activateAsync,
    accountMe,
    redeemInvite,
    webhookBread,
    batchCreateLicenses,
    createTrial,
    // 邮箱账号体系（方案 B）
    sendEmailCode,
    register,
    login,
    codeLogin,
    resetPassword,
    logout,
    listUserAccounts,
    claimCode,
    adminStats,
    // 积分 / 直充（爱发电）
    createRechargeOrder,
    listRechargePlans,
    webhookAfdian,
    consumePoints,
  };
}

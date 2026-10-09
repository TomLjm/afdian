// 面翼 License · 积分 + 爱发电直充（时长+积分并存）本地逻辑测试
// 运行：node server/license/test-recharge.mjs
import crypto from 'node:crypto';
import { createMemoryStore } from './store.js';
import { createLicenseService } from './lib.js';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}`); } };
const throws = async (fn, name, status) => {
  try { await fn(); fail++; console.log(`  ❌ ${name}（未抛错）`); }
  catch (e) {
    const s = e.status;
    if (status !== undefined && s !== status) { fail++; console.log(`  ❌ ${name}（status=${s} 期望 ${status}）`); }
    else { pass++; console.log(`  ✅ ${name}（status=${s}）`); }
  }
};

// 测试专用 RSA 密钥对（生产使用爱发电平台公钥）
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
const signOrder = (order) => {
  const o = { ...order, total_amount: order.total_amount ?? '0.00' };
  const msg = String(o.out_trade_no || '') + String(o.user_id || '') + String(o.plan_id || '') + String(o.total_amount || '');
  return crypto.sign('sha256', Buffer.from(msg, 'utf8'), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64');
};

const store = createMemoryStore();
const AFDIAN_TOKEN = 'test-afdian-token';
const svc = createLicenseService(store, {
  adminStatsKey: 'admin',
  afdianToken: AFDIAN_TOKEN,
  afdianWebhookPublicKey: publicKeyPem,
  afdianProductMap: {
    'plan-60': { type: 'minutes', minutes: 60, bonusPoints: 1 },   // 29 元档：60 分钟 + 1 积分
    'plan-points6': { type: 'points', points: 6 },                  // 6 元积分包
    'plan-points30': { type: 'points', points: 35 },                // 30 元积分包
  },
  pointsCostMap: { resume: 3, mock: 15 },
});

/** 构造爱发电回调（RSA-SHA256：原文 out_trade_no+user_id+plan_id+total_amount，sign 位于 order 内） */
const afdianCallback = (order) => {
  const orderWithSign = { ...order, total_amount: order.total_amount ?? '0.00', sign: signOrder(order) };
  return { type: 'order', data: { order: orderWithSign } };
};

console.log('\n== 注册用户 ==');
const r = svc.register({ email: 'buyer@example.com', password: 'pass1234' });
const sess = r.sessionToken;
ok(sess.startsWith('sess_'), '注册成功');

console.log('\n== 直充下单（时长档） ==');
const o1 = svc.createRechargeOrder({ sessionToken: sess, planId: 'plan-60' });
ok(o1.orderToken?.startsWith('rc_'), '返回一次性票据 rc_xxx');
ok(o1.buyUrl.includes('remark=' + o1.orderToken), '购买链接 remark 携带票据');
throws(() => svc.createRechargeOrder({ sessionToken: sess, planId: 'unknown' }), '未知档位 400', 400);

console.log('\n== 爱发电回调发货（时长档） ==');
let me = svc.listUserAccounts(sess);
ok(me.points === 0 && me.accounts.length === 0, '充值前：0 积分、无账户');
const w1 = await svc.webhookAfdian(afdianCallback({ out_trade_no: 'OUT-1', plan_id: 'plan-60', remark: o1.orderToken, user_id: 'af-u1' }));
ok(w1.ok && !w1.already, '回调发货成功');
me = svc.listUserAccounts(sess);
ok(me.points === 1, '时长档赠送 1 积分到账');
ok(me.accounts.length === 1 && me.accounts[0].quotaRemaining === 60, '充值账户 60 分钟');
ok(me.accounts[0].licenseHint === 'RECHARGE', '充值账户标记 RECHARGE');

console.log('\n== 幂等：同一票据重复回调不重复发货 ==');
const w2 = await svc.webhookAfdian(afdianCallback({ out_trade_no: 'OUT-1', plan_id: 'plan-60', remark: o1.orderToken, user_id: 'af-u1' }));
ok(w2.already === true, '重复回调返回 already');
me = svc.listUserAccounts(sess);
ok(me.points === 1 && me.accounts[0].quotaRemaining === 60, '未重复加时/加积分');

console.log('\n== 二次充值：时长累加 ==');
const o2 = svc.createRechargeOrder({ sessionToken: sess, planId: 'plan-60' });
await svc.webhookAfdian(afdianCallback({ out_trade_no: 'OUT-2', plan_id: 'plan-60', remark: o2.orderToken }));
me = svc.listUserAccounts(sess);
ok(me.accounts.length === 1 && me.accounts[0].quotaRemaining === 120, '同一充值账户累加到 120 分钟');
ok(me.points === 2, '积分累计 2');

console.log('\n== 积分包直充 ==');
const o3 = svc.createRechargeOrder({ sessionToken: sess, planId: 'plan-points30' });
await svc.webhookAfdian(afdianCallback({ out_trade_no: 'OUT-3', plan_id: 'plan-points30', remark: o3.orderToken }));
me = svc.listUserAccounts(sess);
ok(me.points === 2 + 35, '30 元积分包到账 35 积分（2+35=37）');

console.log('\n== 积分消费 ==');
let cp = svc.consumePoints({ sessionToken: sess, item: 'resume' });
ok(cp.ok && cp.cost === 3 && cp.points === 34, '简历优化扣 3 积分，剩 34');
cp = svc.consumePoints({ sessionToken: sess, item: 'mock' });
ok(cp.ok && cp.cost === 15 && cp.points === 19, '模拟面试扣 15 积分，剩 19');
throws(() => svc.consumePoints({ sessionToken: sess, item: 'unknown' }), '未知项目 400', 400);
// 清空积分后扣分不足
const r2 = svc.register({ email: 'poor@example.com', password: 'pass1234' });
throws(() => svc.consumePoints({ sessionToken: r2.sessionToken, item: 'resume' }), '积分不足 402', 402);

console.log('\n== 安全校验 ==');
const noSign = afdianCallback({ out_trade_no: 'X0', plan_id: 'plan-60', remark: 'rc_whatever' });
delete noSign.data.order.sign;
await throws(() => svc.webhookAfdian(noSign), '无签名 401', 401);
const badSign = afdianCallback({ out_trade_no: 'X', plan_id: 'plan-60', remark: 'rc_whatever' });
badSign.data.order.sign = 'deadbeef';
await throws(() => svc.webhookAfdian(badSign), '错误签名 401', 401);
const fakeRo = afdianCallback({ out_trade_no: 'Y', plan_id: 'plan-60', remark: 'rc_notexist' });
await throws(() => svc.webhookAfdian(fakeRo), '票据不存在 404', 404);
// 非直充订单（无 rc_ 票据）：静默忽略
const ignored = await svc.webhookAfdian(afdianCallback({ out_trade_no: 'Z', plan_id: 'plan-60', remark: '普通留言' }));
ok(ignored.ok && ignored.ignored === true, '非直充订单静默忽略');
throws(() => svc.createRechargeOrder({ sessionToken: 'sess_invalid', planId: 'plan-60' }), '未登录下单 401', 401);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);

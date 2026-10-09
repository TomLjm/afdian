import crypto from 'node:crypto';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' });
console.log('pem len:', pem.length);
const msg = 'OUT-1af-u1plan-600.00';
const sig = crypto.sign('sha256', Buffer.from(msg, 'utf8'), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
console.log('sig b64 len:', sig.toString('base64').length);
const v = crypto.createVerify('sha256');
v.update(msg, 'utf8');
const ok1 = v.verify({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, sig);
console.log('verify ok:', ok1);
// 再验一次完整密钥对对象形式
const v2 = crypto.createVerify('sha256');
v2.update(msg, 'utf8');
console.log('verify keyobj:', v2.verify({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, sig));

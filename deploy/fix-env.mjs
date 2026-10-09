// 一次性修复脚本：把 AFDIAN_TOKEN / AFDIAN_PRODUCT_MAP 精确写入服务器 .env
import fs from 'node:fs';

const P = '/opt/meetswin/license/.env';
const TOKEN = 'RKSbJyVjkCMX5xm3FavdEQP47cn6UYeD';
const MAP = [
  '2d065772c3ce11f1b0545254001e7c00:6:p:6积分包:6',
  '1cae5aeabe6111f18d045254001e7c00:60:1:1小时包:29',
  '3b214966c3ce11f18fed5254001e7c00:35:p:35积分包:30',
  'a7d82b1ebe6111f182585254001e7c00:180:3:3小时包:69',
  'ca65ea54be6111f1935a5254001e7c00:300:5:5小时包:99',
  'e790f04cbe6111f18e7d52540025c377:600:10:周卡:169',
  '036687eabe6311f181c05254001e7c00:1200:20:月卡:279',
].join(',');

let s = fs.readFileSync(P, 'utf8');
const set = (key, val) => {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(s)) s = s.replace(re, `${key}=${val}`);
  else s += (s.endsWith('\n') ? '' : '\n') + `${key}=${val}\n`;
};
set('AFDIAN_TOKEN', TOKEN);
set('AFDIAN_PRODUCT_MAP', MAP);
fs.writeFileSync(P, s);
const seg = MAP.split(',').length;
const colons = (MAP.match(/:/g) || []).length;
console.log('OK segments=' + seg + ' colons=' + colons + ' tokenLen=' + TOKEN.length);

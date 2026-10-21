import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
await mkdir('public/vendor', { recursive: true });
await copyFile('index.html', 'public/index.html');
await copyFile(require.resolve('qrcode-generator'), 'public/vendor/qrcode.js');
await copyFile('THIRD-PARTY-NOTICES.txt', 'public/THIRD-PARTY-NOTICES.txt');
console.log('Built public/index.html and local QR code library.');

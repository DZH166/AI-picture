import { networkInterfaces, homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { buildApp } from './app';

const dataDir =
  process.env.AI_PICTURE_DATA_DIR ||
  join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'AI-picture');
const app = await buildApp({ dataDir: resolve(dataDir), serveStatic: true });
const port = Number(process.env.PORT || 3000);
await app.listen({ host: '0.0.0.0', port });
console.log(`\nAI-picture · http://127.0.0.1:${port}\n管理员请在本机打开上方地址。`);
for (const addresses of Object.values(networkInterfaces())) {
  for (const address of addresses || []) {
    if (address.family === 'IPv4' && !address.internal)
      console.log(`员工局域网地址：http://${address.address}:${port}`);
  }
}
if (process.argv.includes('--open') && process.platform === 'win32') {
  const browser = spawn('cmd.exe', ['/d', '/c', 'start', '', `http://127.0.0.1:${port}`], {
    windowsHide: true,
    stdio: 'ignore',
  });
  browser.unref();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });

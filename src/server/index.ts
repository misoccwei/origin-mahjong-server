import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startServer } from './server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.PORT ?? 3000);

// ICE_SERVERS：JSON 陣列，例如 [{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]
const iceServers = process.env.ICE_SERVERS ? JSON.parse(process.env.ICE_SERVERS) : undefined;

const server = await startServer({
  port,
  host: process.env.HOST,
  staticDir: process.env.STATIC_DIR ?? resolve(root, 'dist/client'),
  iceServers,
  aiDelayMs: process.env.AI_DELAY_MS ? Number(process.env.AI_DELAY_MS) : undefined,
});
console.log(`原點麻將伺服器已啟動：http://localhost:${server.port}  (WebSocket: /ws)`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await server.close();
    process.exit(0);
  });
}

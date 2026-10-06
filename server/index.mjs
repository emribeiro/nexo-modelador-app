import { createApp } from './app.mjs';
const port = Number(process.env.PORT || 3001); const host = process.env.HOST || '127.0.0.1';
const origin = process.env.APP_ORIGIN || `http://127.0.0.1:${port}`;
const { app, store } = createApp({ dataDir: process.env.DATA_DIR, origin, demo: process.env.DEMO_DATA !== 'false', secureCookie: origin.startsWith('https:'), uiOrigins: (process.env.UI_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173').split(',') });
const server = app.listen(port, host, () => console.log(`Nexo disponível em ${origin}. Dados: ${process.env.DATA_DIR || './data'}`));
function stop() { server.close(() => { store.close(); process.exit(0); }); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);

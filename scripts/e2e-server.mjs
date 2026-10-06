import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.mjs';
const directory = await mkdtemp(join(tmpdir(),'nexo-e2e-'));
const { app,store } = createApp({ dataDir:directory,origin:'http://127.0.0.1:3101' });
const server = createServer(app).listen(3101,'127.0.0.1');
process.on('SIGTERM',() => { server.close(async () => { store.close(); await rm(directory,{ recursive:true,force:true }); process.exit(); }); });

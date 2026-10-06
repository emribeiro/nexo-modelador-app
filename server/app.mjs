import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { openStore, hashPassword, checkPassword, digest, publicAuth, secretKeys } from './store.mjs';
import { schemas, assert, validateRelations } from './models.mjs';
import { createExecutor, boundedFetch } from './executor.mjs';
import { importContract, importGit, diffService } from './importer.mjs';
import { seedDemo, mountDemo } from './seed.mjs';

export function createApp({ dataDir = resolve('data'), origin = 'http://127.0.0.1:3001', demo = true, uiOrigins = ['http://127.0.0.1:5173','http://localhost:5173'], secureCookie = false } = {}) {
  const app = express(); const store = openStore(dataDir); const executor = createExecutor(store); const previews = new Map(); const attempts = new Map();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" }); next(); });
  app.use(express.json({ limit: '3mb' })); app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  if (demo) { seedDemo(store, origin); mountDemo(app, origin); }
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      if (req.headers.origin && ![origin, ...uiOrigins].includes(req.headers.origin)) return res.status(403).json({ error: 'Origem da requisição não autorizada.' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'Envie o corpo como application/json.' });
    }
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  function currentUser(req) {
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('nexo_session='))?.slice(13);
    if (!token) return null;
    return store.db.prepare('SELECT u.id,u.name,u.email,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id=? AND s.expires>?').get(digest(token), Date.now()) || null;
  }
  function session(res, user) {
    const token = randomBytes(32).toString('hex');
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), user.id, Date.now() + 8 * 3600000);
    res.cookie('nexo_session', token, { httpOnly: true, sameSite: 'strict', secure: secureCookie, maxAge: 8 * 3600000, path: '/' });
  }
  const userSchema = z.object({ name: z.string().trim().min(2).max(120), email: z.string().email().max(254).transform(v => v.toLowerCase()), password: z.string().min(12, 'Use uma senha de pelo menos 12 caracteres.').max(200), role: z.enum(['admin','editor','viewer']).default('editor') });
  function addUser(input) { const data = userSchema.parse(input); assert(!store.db.prepare('SELECT id FROM users WHERE email=?').get(data.email), 'Já existe um usuário com este e-mail.', 409); const user = { id: randomUUID(), name: data.name, email: data.email, role: data.role }; store.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(user.id, user.name, user.email, hashPassword(data.password), user.role); return user; }
  app.get('/api/session', (req, res) => res.json({ user: currentUser(req), needsSetup: store.db.prepare('SELECT count(*) AS n FROM users').get().n === 0 }));
  app.post('/api/setup', (req, res) => { assert(store.db.prepare('SELECT count(*) AS n FROM users').get().n === 0, 'A configuração inicial já foi concluída.', 409); const user = addUser({ ...req.body, role: 'admin' }); session(res, user); store.audit(user.email, 'Criou administrador inicial', user.name); res.status(201).json({ user }); });
  app.post('/api/login', (req, res) => {
    const input = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) }).parse(req.body);
    const key = req.ip; const now = Date.now();
    for (const [k, value] of attempts) if (now - value.since > 900000) attempts.delete(k);
    const count = attempts.get(key) || { count: 0, since: now };
    assert(count.count < 10, 'Muitas tentativas. Aguarde 15 minutos.', 429); count.count++; attempts.set(key, count);
    const row = store.db.prepare('SELECT * FROM users WHERE email=?').get(input.email.toLowerCase());
    const valid = checkPassword(input.password, row?.password || hashPassword('dummy-login-comparison'));
    assert(row && valid, 'E-mail ou senha incorretos.', 401); attempts.delete(key);
    const { password: _, ...user } = row; session(res, user); store.audit(user.email, 'Entrou na aplicação', user.name); res.json({ user });
  });
  app.use('/api', (req, _res, next) => { req.user = currentUser(req); if (!req.user) return next(Object.assign(new Error('Entre na aplicação para continuar.'), { status: 401 })); next(); });
  const editor = (req, _res, next) => { assert(req.user.role !== 'viewer', 'Seu perfil permite apenas consultas.', 403); next(); };
  const admin = (req, _res, next) => { assert(req.user.role === 'admin', 'Ação restrita a administradores.', 403); next(); };
  app.post('/api/logout', (req, res) => { const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('nexo_session='))?.slice(13); if (token) store.db.prepare('DELETE FROM sessions WHERE id=?').run(digest(token)); res.clearCookie('nexo_session', { path: '/' }); res.json({ ok: true }); });
  app.get('/api/workspace', (req, res) => {
    const data = Object.fromEntries(Object.keys(schemas).map(kind => [kind, store.list(kind).map(d => kind === 'auth' ? publicAuth(d) : d)]));
    res.json({ ...data, runs: store.list('runs').slice(0, 100), settings: store.settings(), audit: store.audits(), user: req.user });
  });
  app.get('/api/users', admin, (_req, res) => res.json(store.db.prepare('SELECT id,name,email,role FROM users ORDER BY name').all()));
  app.post('/api/users', admin, (req, res) => { const user = addUser(req.body); store.audit(req.user.email, 'Criou usuário', user.email); res.status(201).json(user); });
  app.put('/api/settings', admin, (req, res) => {
    const data = z.object({ allowedOrigins: z.array(z.string().url()).max(100), sensitiveFields: z.array(z.string().min(1).max(100)).max(100) }).parse(req.body);
    for (const value of data.allowedOrigins) { const u = new URL(value); assert(u.origin === value && ['https:','http:'].includes(u.protocol), 'Cadastre origens exatas, sem caminho, credenciais ou barra final.'); assert(u.protocol === 'https:' || ['localhost','127.0.0.1','[::1]'].includes(u.hostname), 'Use HTTPS para destinos não locais.'); }
    store.setSettings(data); store.audit(req.user.email, 'Alterou configurações', 'Rede e mascaramento'); res.json(data);
  });
  function references(kind, doc) {
    if (kind === 'services') for (const old of store.get(kind, doc.id)?.operations || []) if (!doc.operations.some(o => o.id === old.id)) {
      assert(!store.list('flows').some(f => f.nodes.some(n => n.data.serviceId === doc.id && n.data.operationId === old.id)) && !store.list('tests').some(t => t.serviceId === doc.id && t.operationId === old.id), `A operação ${old.name} está em uso por um fluxo ou teste. Atualize essas referências primeiro.`, 409);
    }
  }
  app.post('/api/entities/:kind', editor, (req, res) => {
    const kind = req.params.kind; assert(Object.hasOwn(schemas, kind), 'Recurso inválido.', 404);
    const doc = schemas[kind].parse(req.body); const old = doc.id ? store.get(kind, doc.id) : null;
    if (doc.id) assert(old, 'Registro não encontrado.', 404);
    if (old) assert(old.revision === doc.revision, 'Este registro foi alterado. Atualize a página antes de salvar.', 409);
    if (kind === 'auth' && old) for (const [env, config] of Object.entries(doc.environments)) { const previous = old.environments[env]; if (previous && old.type === doc.type) { for (const key of ['token','clientSecret']) if (!config[key]) config[key] = previous[key]; for (const key of ['headers','body']) if (!Object.keys(config[key] || {}).length) config[key] = previous[key] || {}; } }
    if (kind === 'services') for (const op of doc.operations) for (const key of Object.keys(op.headers)) assert(!secretKeys.test(key), 'Cadastre credenciais em um perfil de autenticação, não nos cabeçalhos da operação.');
    validateRelations(store, kind, doc); references(kind, doc);
    const saved = store.save(kind, doc); store.audit(req.user.email, old ? 'Atualizou ' + kind : 'Criou ' + kind, saved.name);
    res.status(old ? 200 : 201).json(kind === 'auth' ? publicAuth(saved) : saved);
  });
  app.delete('/api/entities/:kind/:id', editor, (req, res) => {
    const { kind, id } = req.params; assert(Object.hasOwn(schemas, kind), 'Recurso inválido.', 404); const doc = store.get(kind, id); assert(doc, 'Registro não encontrado.', 404);
    const used = kind === 'services' ? store.list('flows').some(f => f.nodes.some(n => n.data.serviceId === id)) || store.list('tests').some(t => t.serviceId === id)
      : kind === 'flows' ? store.list('tests').some(t => t.flowId === id)
      : kind === 'auth' ? store.list('services').some(s => s.authId === id) || store.list('flows').some(f => f.nodes.some(n => n.data.authId === id))
      : kind === 'systems' ? [...store.list('services'), ...store.list('flows')].some(s => s.systemId === id)
      : kind === 'channels' ? [...store.list('services'), ...store.list('flows')].some(s => s.channelIds.includes(id)) : false;
    assert(!used, 'Este registro está em uso. Remova suas associações antes de excluir.', 409);
    store.remove(kind, id); store.audit(req.user.email, 'Excluiu ' + kind, doc.name); res.json({ ok: true });
  });
  app.post('/api/import/preview', editor, async (req, res) => {
    const input = z.object({ mode: z.enum(['file','url','git']), content: z.string().optional(), url: z.string().max(2000).optional(), ref: z.string().max(200).optional(), subdirectory: z.string().max(1000).optional(), token: z.string().max(16000).optional(), username: z.string().max(500).optional(), targetId: z.string().optional() }).parse(req.body);
    let result;
    if (input.mode === 'git') result = await importGit(store, input);
    else { const content = input.mode === 'url' ? (await boundedFetch(store, input.url)).text : input.content; result = importContract(content, { type: input.mode, ...(input.mode === 'url' ? { url: input.url } : {}) }); }
    const existing = input.targetId ? store.get('services', input.targetId) : null; assert(!input.targetId || existing, 'Serviço de destino não encontrado.');
    const preview = { id: randomUUID(), ...result, diff: diffService(existing, result.service), targetId: input.targetId || '', targetRevision: existing?.revision, owner: req.user.id, expiresAt: Date.now() + 1800000 };
    for (const [id, value] of previews) if (value.expiresAt < Date.now()) previews.delete(id);
    assert(previews.size < 100, 'Há muitas importações em revisão. Aguarde a expiração das prévias.'); previews.set(preview.id, preview);
    store.audit(req.user.email, 'Preparou importação', result.service.name);
    res.json(preview);
  });
  app.post('/api/import/commit', editor, (req, res) => {
    const input = z.object({ previewId: z.string(), name: z.string().min(1).optional(), systemId: z.string().default(''), authId: z.string().default(''), confirmConflicts: z.boolean().default(false) }).parse(req.body);
    const preview = previews.get(input.previewId); assert(preview && preview.owner === req.user.id && preview.expiresAt > Date.now(), 'Prévia expirada. Analise o contrato novamente.');
    const existing = preview.targetId ? store.get('services', preview.targetId) : null;
    assert(!preview.targetId || existing?.revision === preview.targetRevision, 'O serviço mudou durante a revisão. Gere outra prévia.', 409);
    assert(!existing || input.confirmConflicts, 'Confirme a substituição das definições do serviço.');
    const doc = schemas.services.parse({ ...preview.service, name: input.name || preview.service.name, systemId: input.systemId || existing?.systemId || '', authId: input.authId || existing?.authId || '', ...(existing ? { id: existing.id, environments: existing.environments, channelIds: existing.channelIds } : {}) });
    validateRelations(store, 'services', doc); references('services', doc);
    const saved = store.save('services', doc); previews.delete(input.previewId); store.audit(req.user.email, 'Importou contrato', saved.name); res.status(201).json(saved);
  });
  let active = 0;
  app.post('/api/execute/:type', editor, async (req, res) => {
    assert(['operation','flow','test'].includes(req.params.type), 'Execução inválida.'); assert(active < 5, 'Limite de execuções simultâneas atingido.', 429);
    const args = z.object({ serviceId: z.string().optional(), operationId: z.string().optional(), flowId: z.string().optional(), testId: z.string().optional(), authId: z.string().optional(), environment: z.string().default('desenvolvimento'), input: z.record(z.unknown()).default({}), timeout: z.number().int().min(100).max(60000).default(10000), validateInput: z.boolean().default(true) }).parse(req.body);
    active++; try { res.json(await executor.execute(req.params.type, args, req.user.email)); } finally { active--; }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Recurso não encontrado.' }));
  const dist = resolve('dist'); if (existsSync(join(dist, 'index.html'))) { app.use(express.static(dist)); app.get('/{*path}', (_req, res) => res.sendFile(join(dist, 'index.html'))); }
  app.use((error, _req, res, _next) => { const isValidation = error instanceof z.ZodError; const status = error.status || (isValidation ? 400 : error.type === 'entity.too.large' ? 413 : 400); res.status(status).json({ error: isValidation ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n') : error.message || 'Não foi possível concluir a solicitação.' }); });
  return { app, store, executor };
}

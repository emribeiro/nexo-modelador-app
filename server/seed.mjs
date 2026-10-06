export function seedDemo(store, origin) {
  if (store.db.prepare("SELECT id FROM settings WHERE id='seeded'").get()) return;
  const system = store.save('systems', { id: 'sys-core', name: 'Core bancário · Demo', description: 'Sistema sintético para explorar integrações.', owner: 'Arquitetura de serviços' });
  store.save('systems', { id: 'sys-digital', name: 'Plataforma digital · Demo', description: 'Canais de atendimento sintéticos.', owner: 'Canais digitais' });
  store.save('channels', { id: 'channel-app', name: 'Aplicativo', type: 'digital', description: 'Canal digital de demonstração.' });
  store.save('channels', { id: 'channel-agencia', name: 'Agência', type: 'physical', description: 'Canal físico de demonstração.' });
  store.save('auth', { id: 'auth-demo', name: 'Autenticação de demonstração', type: 'oauth2', environments: { desenvolvimento: { token: '', tokenUrl: `${origin}/demo/token`, clientId: 'nexo-demo', clientSecret: 'sintetico-demo-secret', scope: 'demo:read', clientAuth: 'body', headers: {}, body: {}, tokenPath: 'access_token', expiresPath: 'expires_in' } } });
  const common = { version: '1.0.0', systemId: system.id, channelIds: ['channel-app','channel-agencia'], authId: 'auth-demo', environments: { desenvolvimento: `${origin}/demo`, homologacao: '' }, schemas: {}, securitySchemes: {}, source: { type: 'demo', format: 'Dados sintéticos' } };
  store.save('services', { ...common, id: 'svc-clientes', name: 'Cadastro de clientes', description: 'Consulta de clientes e informações cadastrais. Serviço sintético de demonstração.', operations: [
    { id: 'buscarCliente', name: 'Consultar cliente', method: 'GET', path: '/clientes/{id}', description: 'Retorna um cliente sintético.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'cli-001' }], headers: {}, responses: { '200': { description: 'Cliente encontrado' }, '404': { description: 'Cliente não encontrado' } } },
    { id: 'listarClientes', name: 'Listar clientes', method: 'GET', path: '/clientes', description: 'Lista os clientes de demonstração.', parameters: [], headers: {}, responses: { '200': { description: 'Lista de clientes' } } },
  ] });
  store.save('services', { ...common, id: 'svc-contas', name: 'Contas e saldos', description: 'Consulta de contas e saldos para validação de jornadas. Dados inteiramente sintéticos.', operations: [
    { id: 'buscarConta', name: 'Consultar conta', method: 'GET', path: '/contas/{id}', description: 'Retorna a conta sintética.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], headers: {}, responses: { '200': { description: 'Conta encontrada' } } },
    { id: 'consultarSaldo', name: 'Consultar saldo', method: 'GET', path: '/contas/{id}/saldo', description: 'Retorna um saldo sintético.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], headers: {}, responses: { '200': { description: 'Saldo disponível' } } },
  ] });
  store.save('flows', { id: 'flow-demo', name: 'Consulta de saldo do cliente', description: 'Jornada de demonstração: cliente → conta → saldo, com dados entre etapas.', systemId: system.id, channelIds: ['channel-app'], input: { clienteId: 'cli-001' }, nodes: [
    { id: 'cliente', type: 'operation', position: { x: 70, y: 150 }, data: { label: 'Consultar cliente', serviceId: 'svc-clientes', operationId: 'buscarCliente', authId: '', input: { path: { id: '{{input.clienteId}}' } }, timeout: 10000, onError: 'stop', condition: null } },
    { id: 'conta', type: 'operation', position: { x: 400, y: 150 }, data: { label: 'Consultar conta', serviceId: 'svc-contas', operationId: 'buscarConta', authId: '', input: { path: { id: '{{steps.cliente.body.contaId}}' } }, timeout: 10000, onError: 'stop', condition: null } },
    { id: 'saldo', type: 'operation', position: { x: 730, y: 150 }, data: { label: 'Consultar saldo', serviceId: 'svc-contas', operationId: 'consultarSaldo', authId: '', input: { path: { id: '{{steps.conta.body.id}}' } }, timeout: 10000, onError: 'stop', condition: null } },
  ], edges: [{ id: 'cliente-conta', source: 'cliente', target: 'conta' }, { id: 'conta-saldo', source: 'conta', target: 'saldo' }] });
  store.save('tests', { id: 'test-demo', name: 'Saldo disponível na jornada', description: 'Valida a integração entre três operações sintéticas.', targetType: 'flow', flowId: 'flow-demo', serviceId: '', operationId: '', scenario: 'positive', environment: 'desenvolvimento', input: { clienteId: 'cli-001' }, assertions: [
    { path: 'steps.cliente.status', operator: 'equals', expected: 200 }, { path: 'steps.saldo.body.disponivel', operator: 'type', expected: 'number' }, { path: 'steps.saldo.body.moeda', operator: 'equals', expected: 'BRL' },
  ] });
  store.save('tests', { id: 'test-negative-demo', name: 'Cliente inexistente', description: 'Cenário negativo: a API deve responder HTTP 404.', targetType: 'operation', serviceId: 'svc-clientes', operationId: 'buscarCliente', flowId: '', scenario: 'negative', environment: 'desenvolvimento', input: { path: { id: 'inexistente' } }, assertions: [{ path: 'status', operator: 'equals', expected: 404 }, { path: 'body.erro', operator: 'exists', expected: true }] });
  store.setSettings({ allowedOrigins: [origin], sensitiveFields: ['cpf','cnpj','email','telefone','numeroConta'] });
  store.db.prepare("INSERT INTO settings(id,data) VALUES('seeded','true')").run();
}
export function mountDemo(app, origin) {
  app.post('/demo/token', (req, res) => {
    const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':').map(decodeURIComponent) : [];
    if ((req.body.client_id || basic[0]) !== 'nexo-demo' || (req.body.client_secret || basic[1]) !== 'sintetico-demo-secret') return res.status(401).json({ error: 'invalid_client' });
    res.json({ access_token: 'sintetico-demo-access-token', token_type: 'Bearer', expires_in: 300 });
  });
  app.get('/demo/openapi.json', (_req, res) => res.json({ openapi: '3.0.3', info: { title: 'Clientes importados · Demo', version: '1.0.0', description: 'Contrato sintético para experimentar a importação.' }, servers: [{ url: `${origin}/demo` }], paths: { '/clientes/{id}': { get: { operationId: 'buscarCliente', summary: 'Consultar cliente', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Cliente sintético' }, '404': { description: 'Não encontrado' } }, security: [{ bearerAuth: [] }] } } }, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } } }));
  app.use('/demo', (req, res, next) => req.headers.authorization === 'Bearer sintetico-demo-access-token' ? next() : res.status(401).json({ erro: 'Token de demonstração necessário.' }));
  const cliente = { id: 'cli-001', nome: 'Cliente de demonstração', contaId: 'cta-001', segmento: 'Varejo', sintetico: true };
  app.get('/demo/clientes', (_req, res) => res.json([cliente]));
  app.get('/demo/clientes/:id', (req, res) => req.params.id === cliente.id ? res.json(cliente) : res.status(404).json({ erro: 'Cliente não encontrado.' }));
  app.get('/demo/contas/:id', (req, res) => req.params.id === 'cta-001' ? res.json({ id: 'cta-001', clienteId: 'cli-001', tipo: 'corrente', status: 'ativa', sintetico: true }) : res.status(404).json({ erro: 'Conta não encontrada.' }));
  app.get('/demo/contas/:id/saldo', (req, res) => req.params.id === 'cta-001' ? res.json({ contaId: 'cta-001', disponivel: 1250.75, moeda: 'BRL', sintetico: true }) : res.status(404).json({ erro: 'Conta não encontrada.' }));
}

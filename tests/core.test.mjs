import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { importContract, diffService, analyzeJava } from '../server/importer.mjs';
import { interpolate, compare, getPath } from '../server/executor.mjs';
import { orderFlow } from '../server/models.mjs';

let server, store, executor, directory, base, cookie;
async function request(path, body, { method = 'POST', session = cookie, headers = {} } = {}) {
  const response = await fetch(base + '/api' + path, { ...(body !== undefined ? { method, body: JSON.stringify(body) } : {}), headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Cookie: session } : {}), ...headers } });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nexo-test-')); let app;
  server = createServer((req,res) => app(req,res)); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  const runtime = createApp({ dataDir:directory,origin:base,demo:true }); app = runtime.app; store = runtime.store; executor = runtime.executor;
  const setup = await request('/setup',{ name:'Arquiteto Teste',email:'admin@example.test',password:'uma-senha-local-segura' },{ session:null });
  assert.equal(setup.status,201); cookie = setup.headers.get('set-cookie').split(';')[0];
});
after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); await rm(directory,{ recursive:true,force:true }); });

test('sessões: acesso anônimo bloqueado, configuração única e cookie HttpOnly',async () => {
  assert.equal((await request('/workspace',undefined,{ session:null })).status,401);
  const result = await request('/session'); assert.equal(result.body.user.role,'admin'); assert.equal(result.body.needsSetup,false);
  assert.equal((await request('/setup',{ name:'Outro',email:'outro@example.test',password:'senha-muito-longa' })).status,409);
  const login = await request('/login',{ email:'admin@example.test',password:'uma-senha-local-segura' },{ session:null });
  assert.equal(login.status,200); assert.match(login.headers.get('set-cookie'),/HttpOnly/); assert.match(login.headers.get('set-cookie'),/SameSite=Strict/);
  const second = login.headers.get('set-cookie').split(';')[0]; assert.equal((await request('/logout',{}, { session:second })).status,200);
  assert.equal((await request('/workspace',undefined,{ session:second })).status,401);
});
test('CSRF: origens externas não podem alterar o workspace',async () => {
  const response = await request('/entities/systems',{ name:'Indesejado' },{ headers:{ Origin:'https://external.example' } }); assert.equal(response.status,403);
});
test('RBAC: leitor consulta, mas não cria, executa ou altera configurações',async () => {
  assert.equal((await request('/users',{ name:'Leitor',email:'leitor@example.test',password:'senha-leitor-segura',role:'viewer' })).status,201);
  const login = await request('/login',{ email:'leitor@example.test',password:'senha-leitor-segura' },{ session:null }); const viewer = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/workspace',undefined,{ session:viewer })).status,200);
  assert.equal((await request('/entities/systems',{ name:'Bloqueado' },{ session:viewer })).status,403);
  assert.equal((await request('/execute/flow',{ flowId:'flow-demo' },{ session:viewer })).status,403);
  assert.equal((await request('/settings',{ allowedOrigins:[],sensitiveFields:[] },{ session:viewer,method:'PUT' })).status,403);
});
test('credenciais criptografadas e respostas de cadastro sem segredos',async () => {
  const response = await request('/entities/auth',{ name:'Segredo de teste',type:'bearer',environments:{ desenvolvimento:{ token:'token-super-secreto-123456' } } });
  assert.equal(response.status,201); assert.equal(response.body.environments.desenvolvimento.token,''); assert.equal(response.body.environments.desenvolvimento.configured,true);
  const raw = store.db.prepare('SELECT data FROM documents WHERE id=?').get(response.body.id).data;
  assert.ok(!raw.includes('token-super-secreto')); assert.ok(raw.includes('sealed'));
  const updated = await request('/entities/auth',{ ...response.body,name:'Perfil renomeado' }); assert.equal(updated.status,200);
  assert.equal(store.get('auth',response.body.id).environments.desenvolvimento.token,'token-super-secreto-123456');
  const workspace = await request('/workspace'); assert.ok(!JSON.stringify(workspace.body.auth).includes('sintetico-demo-secret'));
});
test('CRUD: relacionamentos e concorrência impedem sobrescritas e remoções inválidas',async () => {
  const created = await request('/entities/systems',{ name:'Sistema de teste',owner:'Equipe' }); assert.equal(created.status,201);
  const updated = await request('/entities/systems',{ ...created.body,name:'Sistema atualizado' }); assert.equal(updated.status,200);
  assert.equal((await request('/entities/systems',{ ...created.body,name:'Edição antiga' })).status,409);
  assert.equal((await request('/entities/systems/sys-core',{}, { method:'DELETE' })).status,409);
  assert.equal((await request('/entities/systems/' + created.body.id,{}, { method:'DELETE' })).status,200);
});
test('executor REST: autenticação OAuth, parâmetros de caminho e histórico real',async () => {
  const result = await request('/execute/operation',{ serviceId:'svc-clientes',operationId:'buscarCliente',input:{ path:{ id:'cli-001' } } });
  assert.equal(result.status,200); assert.equal(result.body.result.status,200); assert.equal(result.body.result.body.contaId,'cta-001'); assert.equal(result.body.result.success,true);
  assert.equal(store.get('runs',result.body.id).result.status,200); assert.ok(!JSON.stringify(result.body).includes('sintetico-demo-access-token'));
});
test('aceite: fluxo passa respostas entre três chamadas e persiste asserções',async () => {
  const run = await request('/execute/flow',{ flowId:'flow-demo',input:{ clienteId:'cli-001' },environment:'desenvolvimento' });
  assert.equal(run.body.result.success,true); assert.equal(run.body.result.steps.cliente.body.id,'cli-001'); assert.equal(run.body.result.steps.conta.body.id,'cta-001'); assert.equal(run.body.result.steps.saldo.body.disponivel,1250.75);
  const tested = await request('/execute/test',{ testId:'test-demo' }); assert.equal(tested.body.result.success,true); assert.equal(tested.body.result.assertions.length,3); assert.ok(tested.body.result.assertions.every(a => a.passed));
  assert.equal(store.get('runs',tested.body.id).type,'test');
});
test('cenário negativo: HTTP 404 é esperado e pode aprovar o teste',async () => {
  const result = await request('/execute/test',{ testId:'test-negative-demo' }); assert.equal(result.body.result.success,true); assert.equal(result.body.result.output.status,404);
});
test('fluxos: falha interrompe etapas seguintes sem repetir chamadas',async () => {
  const run = await request('/execute/flow',{ flowId:'flow-demo',input:{ clienteId:'inexistente' } }); assert.equal(run.body.result.success,false); assert.equal(run.body.result.steps.cliente.status,404); assert.equal(run.body.result.steps.conta.skipped,true); assert.equal(run.body.result.steps.saldo.skipped,true);
});
test('fluxos: condição falsa ignora a etapa e onError continue tenta a próxima',async () => {
  const source = store.get('flows','flow-demo');
  const definition = { ...source,id:undefined,name:'Condições de teste',nodes:source.nodes.map(n => ({ ...n,data:{ ...n.data,input:{ path:{ id:n.id === 'cliente' ? 'inexistente' : 'cta-001' } },onError:'continue',condition:n.id === 'conta' ? { path:'input.executarConta',operator:'equals',value:true } : null } })) };
  const saved = await request('/entities/flows',definition); assert.equal(saved.status,201);
  const run = await request('/execute/flow',{ flowId:saved.body.id,input:{ executarConta:false } }); assert.equal(run.body.result.success,false); assert.equal(run.body.result.steps.conta.skipped,true); assert.equal(run.body.result.steps.saldo.status,200);
});
test('fluxos inválidos: ciclos, desconexões e bifurcações são rejeitados',() => {
  const f = store.get('flows','flow-demo'); assert.throws(() => orderFlow({ ...f,edges:[] }),/único início/);
  assert.throws(() => orderFlow({ ...f,edges:[...f.edges,{ id:'cycle',source:'saldo',target:'cliente' }] }),/início|ciclos/);
  assert.throws(() => orderFlow({ ...f,edges:[{ id:'a',source:'cliente',target:'conta' },{ id:'b',source:'cliente',target:'saldo' }] }),/sequência/);
});
test('variáveis preservam tipos e não acessam propriedades de protótipo',() => {
  const context = { input:{ count:7,list:[1,2],name:'teste' } };
  assert.equal(interpolate('{{input.count}}',context),7); assert.deepEqual(interpolate('{{input.list}}',context),[1,2]); assert.equal(interpolate('item-{{input.name}}',context),'item-teste');
  assert.throws(() => interpolate('{{input.inexistente}}',context),/não encontrada/); assert.equal(getPath(context,'input.__proto__'),undefined);
});
test('asserções: igualdade profunda, tipos, existência, schema e cabeçalhos',() => {
  assert.equal(compare({ a:1,b:2 },'equals',{ b:2,a:1 }).valid,true); assert.equal(compare([1],'type','array').valid,true);
  assert.equal(compare(undefined,'exists',false).valid,true); assert.equal(compare({ value:2 },'schema',{ type:'object',required:['value'],properties:{ value:{ type:'integer',minimum:3 } } }).valid,false);
  assert.equal(getPath({ headers:{ 'content-type':'application/json' } },'headers.content-type'),'application/json');
});
test('rede: origem não autorizada é bloqueada antes da chamada',async () => {
  const service = store.get('services','svc-clientes'); const denied = store.save('services',{ ...service,id:undefined,name:'Destino bloqueado',environments:{ desenvolvimento:'https://forbidden.invalid' } });
  const run = await request('/execute/operation',{ serviceId:denied.id,operationId:'listarClientes' }); assert.equal(run.body.result.success,false); assert.match(run.body.result.error,/Destino não autorizado/);
  assert.equal((await request('/import/preview',{ mode:'url',url:'https://forbidden.invalid/openapi.json' })).status,403);
  assert.equal((await request('/settings',{ allowedOrigins:['https://example.org/path'],sensitiveFields:[] },{ method:'PUT' })).status,400);
});
test('validação de entrada impede envio de parâmetros obrigatórios ausentes',async () => {
  const run = await request('/execute/operation',{ serviceId:'svc-clientes',operationId:'buscarCliente',input:{} }); assert.equal(run.body.result.success,false); assert.match(run.body.result.error,/obrigatório/);
});

function contract(version = '3.0.3') { return { openapi:version,info:{ title:'API de teste',version:'1.0.0' },servers:[{ url:base + '/demo' }],paths:{ '/clientes/{id}':{ get:{ operationId:'getCliente',summary:'Buscar cliente',parameters:[{ in:'path',name:'id',required:true,schema:{ type:'string' } }],responses:{ '200':{ description:'OK',content:{ 'application/json':{ schema:{ $ref:'#/components/schemas/Cliente' } } } } } } } },components:{ schemas:{ Cliente:{ type:'object',required:['id'],properties:{ id:{ type:'string' } } } },securitySchemes:{ bearer:{ type:'http',scheme:'bearer' } } } }; }
test('OpenAPI 3.0/3.1: schemas, parâmetros, respostas e segurança são importados',() => {
  for (const version of ['3.0.3','3.1.0']) { const result = importContract(JSON.stringify(contract(version))); assert.equal(result.service.operations.length,1); assert.equal(result.service.schemas.Cliente.type,'object'); assert.equal(result.service.operations[0].responses['200'].content['application/json'].schema.properties.id.type,'string'); assert.equal(result.service.securitySchemes.bearer.scheme,'bearer'); }
});
test('Swagger 2.0 YAML: normaliza base URL, parâmetros e corpo de requisição',() => {
  const result = importContract(`swagger: '2.0'\ninfo:\n  title: Cadastro\n  version: '1.0'\nhost: localhost:9999\nbasePath: /v1\nschemes: [http]\npaths:\n  /clientes:\n    post:\n      parameters:\n        - name: cliente\n          in: body\n          required: true\n          schema:\n            type: object\n            properties:\n              nome: {type: string}\n      responses:\n        '201':\n          description: Criado\n`);
  assert.equal(result.service.environments.desenvolvimento,'http://localhost:9999/v1'); assert.equal(result.service.operations[0].requestBody.required,true); assert.equal(result.service.operations[0].parameters.length,0);
});
test('importador recusa contratos inválidos, versões não suportadas e refs externas',() => {
  assert.throws(() => importContract('openapi: [invalid'),/inválido/); assert.throws(() => importContract('openapi: 4.0.0'),/Versão/);
  const doc = contract(); doc.paths['/clientes/{id}'].get.responses['200'].content['application/json'].schema = { $ref:'https://forbidden.invalid/schema.json' };
  assert.throws(() => importContract(JSON.stringify(doc)),/Referência externa/);
});
test('importação completa por URL: revisão antes de cadastrar e execução autenticada',async () => {
  const before = store.list('services').length; const preview = await request('/import/preview',{ mode:'url',url:base + '/demo/openapi.json' });
  assert.equal(preview.status,200); assert.equal(store.list('services').length,before); assert.equal(preview.body.service.operations.length,1);
  const commit = await request('/import/commit',{ previewId:preview.body.id,authId:'auth-demo',systemId:'sys-core' }); assert.equal(commit.status,201);
  const run = await request('/execute/operation',{ serviceId:commit.body.id,operationId:'buscarCliente',input:{ path:{ id:'cli-001' } } }); assert.equal(run.body.result.status,200);
  assert.equal((await request('/import/commit',{ previewId:preview.body.id })).status,400);
});
test('reimportação mostra diferenças, exige confirmação e protege revisão concorrente',async () => {
  const initial = await request('/import/preview',{ mode:'file',content:JSON.stringify(contract()) }); const saved = await request('/import/commit',{ previewId:initial.body.id });
  const doc = contract(); doc.info.version = '2.0.0'; doc.paths['/clientes/{id}'].get.summary = 'Consulta atualizada';
  const next = await request('/import/preview',{ mode:'file',content:JSON.stringify(doc),targetId:saved.body.id }); assert.equal(next.body.diff.changed.length,1); assert.ok(next.body.diff.metadata.includes('version'));
  assert.equal((await request('/import/commit',{ previewId:next.body.id })).status,400);
  await request('/entities/services',{ ...saved.body,description:'Edição concorrente' });
  assert.equal((await request('/import/commit',{ previewId:next.body.id,confirmConflicts:true })).status,409);
  const final = await request('/import/preview',{ mode:'file',content:JSON.stringify(doc),targetId:saved.body.id }); assert.equal((await request('/import/commit',{ previewId:final.body.id,confirmConflicts:true })).status,201);
});
test('diff detecta remoções e adições por método e caminho',() => {
  const original = importContract(JSON.stringify(contract())).service; const incoming = { ...original,operations:[{ ...original.operations[0],path:'/outros' }] };
  const diff = diffService(original,incoming); assert.deepEqual(diff.added,['GET /outros']); assert.deepEqual(diff.removed,['GET /clientes/{id}']);
});
test('Quarkus: análise estática reconhece JAX-RS e DTOs e expõe limitações',() => {
  const result = analyzeJava([{ path:'src/ClienteResource.java',content:`import jakarta.ws.rs.*;\n@Path("/clientes")\npublic class ClienteResource {\n @GET\n @Path("/{id}")\n public ClienteDTO buscar(@PathParam("id") String id) { return null; }\n @POST\n public ClienteDTO criar(ClienteDTO entrada) { return entrada; }\n}` }, { path:'src/ClienteDTO.java',content:'public class ClienteDTO { @NotNull private String nome; private Integer idade; }' }]);
  assert.equal(result.service.operations.length,2); assert.equal(result.service.operations.find(o => o.method === 'GET').path,'/clientes/{id}'); assert.equal(result.service.schemas.ClienteDTO.properties.idade.type,'integer'); assert.ok(result.service.schemas.ClienteDTO.required.includes('nome')); assert.ok(result.warnings.some(w => w.includes('parcial')));
});
test('Git: protocolos não HTTPS e destinos não autorizados são rejeitados',async () => {
  const result = await request('/import/preview',{ mode:'git',url:'file:///tmp/repo' }); assert.equal(result.status,400);
  const external = await request('/import/preview',{ mode:'git',url:'https://unauthorized.invalid/repo.git' }); assert.equal(external.status,403);
});
test('histórico e auditoria sobrevivem ao acesso e registram autoria',async () => {
  const workspace = await request('/workspace'); assert.ok(workspace.body.runs.length >= 5); assert.ok(workspace.body.audit.some(a => a.action === 'Importou contrato')); assert.ok(workspace.body.runs.every(r => r.actor === 'admin@example.test'));
});

test('mascaramento protege asserções, valores numéricos sensíveis e parâmetros de URL',() => {
  const result = executor.sanitize({ body:{ email:'sintetico@example.test',cpf:123456 },assertions:[{ path:'body.email',actual:'sintetico@example.test',expected:'outra-pessoa@example.test' },{ path:'body.cpf',actual:123456,expected:987654 }],request:{ url:'https://example.test/items?cpf=123456&query=ok' },echo:'Resposta para sintetico@example.test' },[]);
  const text = JSON.stringify(result); assert.ok(!text.includes('sintetico@example')); assert.ok(!text.includes('outra-pessoa')); assert.ok(!text.includes('123456')); assert.ok(!text.includes('987654')); assert.ok(text.includes('query=ok'));
});
test('perfil incompleto não pode ser cadastrado',async () => {
  const bearer = await request('/entities/auth',{ name:'Incompleto',type:'bearer',environments:{ desenvolvimento:{ token:'' } } }); assert.equal(bearer.status,400);
  const oauth = await request('/entities/auth',{ name:'Sem segredo',type:'oauth2',environments:{ desenvolvimento:{ tokenUrl:base + '/demo/token',clientId:'x' } } }); assert.equal(oauth.status,400);
});
test('OpenAPI 3.1 usa JSON Schema 2020-12 para validar entradas',async () => {
  const definition = contract('3.1.0'); definition.paths = { '/clientes':{ post:{ summary:'Criar cliente',operationId:'create',requestBody:{ required:true,content:{ 'application/json':{ schema:{ type:'object',properties:{ name:{ type:'string' } },unevaluatedProperties:false } } } },responses:{ '201':{ description:'Criado' } } } } };
  const service = store.save('services',importContract(JSON.stringify(definition)).service);
  const result = await request('/execute/operation',{ serviceId:service.id,operationId:'create',input:{ body:{ name:'sintetico',extra:true } } }); assert.equal(result.body.result.success,false); assert.match(result.body.result.error,/unevaluated/);
});
test('OAuth/cache, endpoint customizado, timeout, redirecionamento e ausência de retry',async () => {
  const calls = { oauth:0,custom:0,fail:0,redirectTarget:0,slow:0 }; let basicSeen = '';
  const fixture = createServer(async (req,res) => {
    const chunks = []; for await (const part of req) chunks.push(part); const body = Buffer.concat(chunks).toString();
    res.setHeader('Content-Type','application/json');
    if (req.url === '/oauth') { calls.oauth++; basicSeen = req.headers.authorization || ''; res.end(JSON.stringify({ access_token:'oauth-private-fixture-token',expires_in:60 })); }
    else if (req.url === '/custom') { calls.custom++; assert.equal(JSON.parse(body).secret,'custom-fixture-secret'); res.end(JSON.stringify({ data:{ bearer:'custom-private-fixture-token',ttl:60 } })); }
    else if (req.url === '/echo') res.end(JSON.stringify({ auth:req.headers.authorization,email:'sintetico@example.test' }));
    else if (req.url === '/fail') { calls.fail++; res.statusCode = 503; res.end(JSON.stringify({ error:'Indisponível' })); }
    else if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('Location','/redirect-target'); res.end('{}'); }
    else if (req.url === '/redirect-target') { calls.redirectTarget++; res.end('{}'); }
    else if (req.url === '/slow') { calls.slow++; setTimeout(() => res.end('{}'),250); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => fixture.listen(0,'127.0.0.1',resolve)); const origin = 'http://127.0.0.1:' + fixture.address().port; const settings = store.settings(); store.setSettings({ ...settings,allowedOrigins:[...settings.allowedOrigins,origin] });
  try {
    const profile = store.save('auth',{ name:'OAuth fixture',type:'oauth2',environments:{ desenvolvimento:{ tokenUrl:origin + '/oauth',clientId:'fixture-id',clientSecret:'fixture-secret',clientAuth:'basic',tokenPath:'access_token',expiresPath:'expires_in' } } });
    const service = store.save('services',{ name:'Fixture',version:'1',description:'',systemId:'',channelIds:[],authId:profile.id,environments:{ desenvolvimento:origin },schemas:{},securitySchemes:{},operations:['echo','fail','redirect','slow'].map(id => ({ id,name:id,method:'GET',path:'/' + id,parameters:[],headers:{},responses:{} })) });
    for (let i=0;i<2;i++) { const result = await request('/execute/operation',{ serviceId:service.id,operationId:'echo' }); assert.equal(result.body.result.success,true); assert.ok(!JSON.stringify(result.body).includes('private-fixture-token')); assert.ok(!JSON.stringify(result.body).includes('sintetico@example.test')); }
    assert.equal(calls.oauth,1); assert.ok(basicSeen.startsWith('Basic '));
    const custom = store.save('auth',{ name:'Custom fixture',type:'custom',environments:{ desenvolvimento:{ tokenUrl:origin + '/custom',headers:{},body:{ secret:'custom-fixture-secret' },tokenPath:'data.bearer',expiresPath:'data.ttl' } } });
    const result = await request('/execute/operation',{ serviceId:service.id,operationId:'echo',authId:custom.id }); assert.equal(result.body.result.success,true); assert.equal(calls.custom,1); assert.ok(!JSON.stringify(result.body).includes('custom-private'));
    const failed = await request('/execute/operation',{ serviceId:service.id,operationId:'fail' }); assert.equal(failed.body.result.status,503); assert.equal(calls.fail,1);
    const redirected = await request('/execute/operation',{ serviceId:service.id,operationId:'redirect' }); assert.match(redirected.body.result.error,/Redirecionamento/); assert.equal(calls.redirectTarget,0);
    const slow = await request('/execute/operation',{ serviceId:service.id,operationId:'slow',timeout:100 }); assert.match(slow.body.result.error,/Tempo limite/); assert.equal(calls.slow,1);
  } finally { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); store.setSettings(settings); }
});

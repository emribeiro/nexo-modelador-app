# Nexo — Modelador de serviços

Aplicação implementada a partir de [`prompt.md`](./prompt.md) para catalogar contratos REST, configurar autenticação, importar OpenAPI e projetos Quarkus, modelar fluxos visuais e executar testes funcionais com histórico persistido.

## Executar localmente

Requisitos: **Node.js 24 ou superior**, npm e Git no `PATH` para importação de repositórios. O SQLite é fornecido pelo Node; não exige instalação separada. No Node 24, `node:sqlite` ainda emite um aviso de API experimental.

```sh
npm install
npm run dev
```

Abra **http://127.0.0.1:5173**. No primeiro acesso, crie sua conta de administrador. Não há senha padrão. A API roda em `127.0.0.1:3001`.

Para executar a versão compilada:

```sh
npm run build
npm start
```

Abra **http://127.0.0.1:3001**. O backend também serve a interface compilada. A aplicação não depende de CDN, fontes externas ou serviços pagos.

Configuração opcional:

```sh
cp .env.example .env
```

Os scripts `dev` e `start` carregam `.env`. Em desenvolvimento, mantenha `PORT=3001`, usada pelo proxy do Vite. `APP_ORIGIN` é a origem HTTP da API; `UI_ORIGINS` lista as origens adicionais autorizadas a enviar alterações. O servidor se vincula ao loopback por padrão. Para um workspace vazio, defina `DEMO_DATA=false` antes da primeira inicialização. Desativar a demonstração posteriormente também desativa os endpoints `/demo`, mas preserva os registros já cadastrados.

## Percurso de aceite

1. Crie a conta no primeiro acesso.
2. Em **Importar serviços**, clique em **Carregar contrato de demonstração**, depois em **Analisar e revisar**.
3. Selecione **Autenticação de demonstração** na prévia e importe o serviço.
4. Na operação importada, clique em **Executar** e informe:

   ```json
   { "path": { "id": "cli-001" }, "query": {}, "headers": {} }
   ```

5. Em **Fluxos de integração**, abra **Consulta de saldo do cliente**. O editor contém três operações conectadas, com dados da resposta anterior usados como entrada da próxima chamada.
6. Execute com `{"clienteId":"cli-001"}`. Confira as respostas de cliente, conta e saldo.
7. Em **Testes funcionais**, execute **Saldo disponível na jornada** e **Cliente inexistente**. O segundo verifica uma resposta HTTP 404 esperada.
8. Consulte os resultados em **Histórico e auditoria**. Recarregue a página ou reinicie o servidor para verificar a persistência.

**A demonstração usa endpoints HTTP reais do backend local que retornam dados sintéticos.** São mocks explicitamente identificados; não representam integrações com sistemas bancários reais. Execuções e resultados nunca são pré-fabricados. O cadastro de mocks arbitrários não integra esta versão.

## Funcionalidades

| Módulo | Comportamento implementado |
| --- | --- |
| Catálogo | Serviços, versões, operações, sistemas, canais, URLs por ambiente e pesquisa por nome, descrição ou endpoint. |
| Operações | Método, caminho, parâmetros, cabeçalhos, corpo, respostas, schemas, restrições e exemplos. Editor de metadados por formulário; contratos complexos em JSON. |
| Autenticação | Bearer informado, OAuth 2.0 client credentials com credenciais no corpo ou HTTP Basic, e obtenção por POST JSON customizado. Extração do token e validade por caminho. Cache em memória até próximo da expiração. |
| Importação | Swagger 2.0, OpenAPI 3.0 e 3.1, em JSON/YAML, por arquivo, texto ou URL. Prévia, avisos, diferenças e confirmação de reimportação. |
| Quarkus | Git HTTPS público/privado, branch/tag e subdiretório. Prioriza `openapi`/`swagger` JSON/YAML. Analisa estaticamente um subconjunto de JAX-RS e DTOs quando não há contrato. Guarda arquivos e commit de origem. |
| Fluxos | Editor visual com nós arrastáveis e conexões, variáveis, respostas entre etapas, condição por etapa, timeout e política de interrupção/continuidade. |
| Testes | Operações ou fluxos; cenários positivos/negativos; asserções sobre status, cabeçalhos, tipos, valores, existência, conteúdo e JSON Schema. |
| Histórico | Resultado esperado/obtido, falhas, status, duração, etapas ignoradas e autoria persistidos. |
| Governança | Login local, três perfis, destinos autorizados, criptografia de credenciais, mascaramento de resultados, auditoria e controle de revisão concorrente. |

## Modelar e executar

Cadastre sistemas e canais em **Sistemas e canais**. No catálogo, associe o serviço a seu sistema e canais, informe as URLs de desenvolvimento e homologação, e selecione um perfil de autenticação. As URLs são bases: `https://api.exemplo.com/v1` mais `/clientes/{id}` resulta em `https://api.exemplo.com/v1/clientes/…`.

Um administrador deve autorizar a **origem exata** em Configurações, por exemplo `https://api.exemplo.com`. Isso também se aplica a endpoints de token, URLs de contratos e repositórios Git. Não inclua caminho nem barra final. Destinos internos HTTPS podem ser autorizados e precisam estar acessíveis ao processo do backend. HTTP é permitido somente em loopback para desenvolvimento. Redirecionamentos são recusados; informe a URL final. A mesma política se aplica mesmo quando um token já está em cache.

O acesso Git usa o executável `git`, com clone raso e sem checkout. Hooks, credenciais globais, prompts interativos, protocolo `file` e redirecionamentos HTTP são desativados. O token é fornecido ao processo por `GIT_ASKPASS`, não é incluído na URL nem salvo no catálogo, e a pasta temporária é removida. Configure o usuário HTTPS exigido pelo seu provedor (por exemplo, alguns provedores usam seu nome de usuário em vez de `oauth2`).

### Entradas e referências

Operações recebem `path`, `query`, `headers` e `body`. Use dados JSON com tipos compatíveis com o contrato; inteiros são enviados como números no editor, mesmo quando depois serializados em query strings.

```json
{
  "path": { "id": "{{steps.cliente.body.contaId}}" },
  "query": { "incluirLimite": true },
  "headers": { "X-Correlation-ID": "jornada-{{input.referencia}}" }
}
```

Referências completas (`{{input.valor}}`) preservam o tipo original. Referências dentro de texto produzem strings. Caminhos como `steps.consulta.body.itens[0].id` são aceitos. Variáveis ausentes geram erro explícito. Não há execução de JavaScript nas expressões.

Cada nó tem um identificador estável, exibido ao abrir suas definições. Clique na operação da biblioteca para adicioná-la, configure sua entrada e clique em **Aplicar à etapa**. Em **Definições**, altere nome, sistema, canais e variáveis padrão. **Salvar fluxo** valida a sequência. Só é possível executar a versão salva.

Exemplo de condição de etapa:

```json
{ "path": "steps.cliente.body.ativo", "operator": "equals", "value": true }
```

Uma condição falsa ignora aquela etapa; as próximas continuam. Falha HTTP ou de rede marca o fluxo como falho. A política `continue` permite executar as etapas seguintes, mas não apaga a falha anterior. Não há retries automáticos.

### Asserções

```json
[
  { "path": "status", "operator": "equals", "expected": 200 },
  { "path": "headers.content-type", "operator": "contains", "expected": "application/json" },
  { "path": "body.id", "operator": "exists", "expected": true },
  { "path": "body.saldo", "operator": "type", "expected": "number" },
  {
    "path": "body",
    "operator": "schema",
    "expected": {
      "type": "object",
      "required": ["id"],
      "properties": { "id": { "type": "string" } }
    }
  }
]
```

Para fluxos, use `steps.identificador.status` ou `steps.identificador.body.campo`. Os comparadores são `equals`, `notEquals`, `exists`, `type`, `schema`, `contains`, `gt` e `lt`. `exists` com `expected: false` exige ausência. `type` aceita `string`, `number`, `boolean`, `object`, `array` e `null`; para exigir inteiro, use JSON Schema. A comparação de objetos é estrutural.

Testes negativos desabilitam a validação prévia de schema para permitir entradas inválidas; uma URL executável ainda exige seus parâmetros de caminho. A aprovação depende das asserções: HTTP 404 pode ser o resultado esperado. Uma falha de transporte sem resposta reprova o teste.

## Arquitetura e persistência

- **Frontend:** React 19, TypeScript, Vite, React Flow, Lucide e CSS responsivo. A UI é em português.
- **Backend:** Node.js, Express, Zod para contratos de entrada, YAML para leitura de contratos e Ajv para asserções/validações de schema.
- **Banco:** SQLite com WAL, tabelas `documents`, `users`, `sessions`, `settings` e `audit`. Os documentos possuem identificador, timestamps e revisão; relações são validadas pela aplicação.
- **Entidades:** sistemas, canais, serviços, perfis de autenticação, fluxos, testes e execuções. Operações pertencem aos serviços; etapas referenciam serviço/operação. Reimportações não removem operações ainda usadas por fluxos ou testes.
- **Executor:** chamadas no backend, limites de concorrência, timeout, tamanho de resposta e contexto temporário de variáveis. Asserções usam a resposta original em memória; somente resultados mascarados são persistidos.

Os arquivos ficam em `data/`, ignorados pelo Git:

- `nexo.sqlite` e arquivos WAL/SHM: definições, contas e histórico.
- `encryption.key`: chave AES-256-GCM gerada localmente com permissão restrita; perfis guardam a configuração sensível criptografada.

Senhas usam scrypt com salt; sessões de oito horas usam cookie HttpOnly/SameSite Strict e identificadores armazenados por hash. A flag Secure é habilitada quando `APP_ORIGIN` usa HTTPS. O backend verifica origem em mutações e exige JSON.

Faça backup do diretório completo com o servidor parado. Preserve o banco **e a chave**; perder a chave impede recuperar as credenciais. O banco armazena contratos e definições de testes como dados da aplicação: **guarde segredos somente nos perfis de autenticação**, não em exemplos, descrições, URLs ou fixtures. Não há integração com cofre externo ou rotação de chave nesta versão.

Perfis:

- **Administrador:** modelagem, execução, rede e criação de usuários.
- **Editor:** catálogo, importações, autenticação de serviços, fluxos e testes.
- **Leitor:** consulta; não pode alterar definições ou executar chamadas.

As últimas 100 execuções e os últimos 300 eventos de auditoria aparecem na interface; os registros completos permanecem no SQLite. Não há política automática de retenção.

## Limites explícitos desta versão

- A ferramenta cadastra contratos e executa integrações de validação. Não gera aplicações Quarkus, não publica APIs nem oferece orquestração de produção.
- O editor executa **uma sequência conectada**, sem ciclos, forks, paralelismo ou loops. Condições controlam a execução de cada etapa.
- Existem dois ambientes na interface: desenvolvimento e homologação. Não há gestão de produção.
- Importação OpenAPI não resolve referências externas. Referências recursivas geram aviso e não são expandidas indefinidamente. O documento original é preservado. O parser valida estrutura essencial e referências; não é um linter completo da especificação.
- Callbacks e webhooks não são executados. Apenas o primeiro servidor global é usado como URL inicial. Servidores por operação precisam ser revisados. Corpos JSON/texto e parâmetros simples são o foco; multipart, uploads binários, cookies e serializações complexas de parâmetros não possuem editor/executor dedicado.
- A análise Java é heurística e deliberadamente parcial: reconhece classes com `@Path`, métodos públicos com verbos JAX-RS, alguns parâmetros anotados, campos e records simples. Herança, recursos gerados, Kotlin, interfaces genéricas, anotações customizadas, Spring Web, rotas programáticas, validações complexas e comportamento de runtime exigem revisão. As respostas usam `default`, pois status reais não são inferidos. Não compila nem executa o repositório.
- Git HTTPS deve estar disponível sem redirecionar para outra URL. Limites: clone de até 60 segundos, até 500 arquivos Java e 8 MB de conteúdo analisado. Para monorepositórios, selecione um subdiretório. O clone ainda depende dos recursos e do suporte a filtros do servidor Git.
- Até 50 etapas por fluxo, cinco execuções simultâneas, 60 segundos por chamada e 2 MB por resposta. As requisições são síncronas; não há fila distribuída, agendamento ou cancelamento de um fluxo já iniciado.
- OAuth implementa client credentials; login federado da aplicação, authorization code, mTLS, refresh tokens e HSM não estão incluídos. O login local não tem recuperação de senha por e-mail ou MFA.
- Mascaramento reconhece nomes de campos e segredos usados na execução. Não faz classificação automática completa de dados pessoais em texto livre. Campos específicos devem ser configurados antes da execução.
- O projeto foi preparado para uso local e validação. Operação corporativa compartilhada exige definir infraestrutura, TLS, observabilidade, backup, identidade corporativa e políticas de retenção conforme o ambiente real.

## Validação automatizada

```sh
npm run build
npm test
npm run test:e2e
```

Os testes de integração usam banco temporário, portas locais e dados sintéticos. Não acessam sistemas bancários. Os testes de navegador usam Chrome instalado e iniciam um servidor temporário em `127.0.0.1:3101`. Para usar Chromium do Playwright:

```sh
npx playwright install chromium
PLAYWRIGHT_CHANNEL=chromium npm run test:e2e
```

Capturas e traces ficam em `test-results/`. Os testes de navegador cobrem criação de conta, importação, chamada autenticada, fluxo encadeado, asserções, criação de serviço/operação/fluxo, persistência e viewport móvel. Os testes de backend cobrem permissões, conflitos, rede, criptografia, importadores e semântica de execução. A integração com um repositório Git privado real deve ser validada com o endereço e credenciais da organização.

## Estrutura

```text
src/                 Interface React e editor visual
server/app.mjs       API, sessão, permissões, CRUD e importação
server/store.mjs     SQLite, criptografia e auditoria
server/models.mjs    Validação e relações
server/executor.mjs  HTTP, autenticação, fluxos e asserções
server/importer.mjs  OpenAPI/Swagger e análise Git/Java
server/seed.mjs      Definições e endpoints sintéticos
tests/               Testes de backend e navegador
scripts/             Inicialização de desenvolvimento e testes
```

Referências técnicas: [Node SQLite](https://nodejs.org/api/sqlite.html), [React Flow](https://reactflow.dev/learn/concepts/adding-interactivity), [Quarkus OpenAPI](https://quarkus.io/guides/openapi-swaggerui/), [OpenAPI](https://spec.openapis.org/), [Bearer tokens — RFC 6750](https://www.rfc-editor.org/info/rfc6750/).

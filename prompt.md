Atue como engenheiro de software responsável por desenvolver uma aplicação
web de modelagem de serviços e fluxos de integração.

Contexto
Sou arquiteto de serviços em uma instituição bancária. Preciso catalogar,
modelar e validar serviços REST e representar sua utilização em integrações
entre sistemas e canais físicos e digitais.

Objetivo
Construir uma aplicação que permita cadastrar contratos de serviços,
importar definições existentes, configurar autenticação, montar fluxos
executáveis e realizar testes funcionais.

Nesta primeira versão, “criar um serviço” significa cadastrar e editar
seu contrato na ferramenta. Gerar código, publicar novas APIs e operar
fluxos de produção ficam fora do escopo inicial.

1. Catálogo e modelagem
- Cadastrar sistemas e canais e associá-los a serviços e fluxos.
- Cadastrar serviços com nome, descrição, versão, sistema responsável
  e URL base por ambiente.
- Cadastrar operações com método HTTP, caminho, parâmetros, cabeçalhos,
  corpo da requisição e respostas previstas.
- Definir tipos, obrigatoriedade, restrições e exemplos dos campos.
- Pesquisar, editar e consultar os serviços cadastrados.

2. Autenticação dos serviços
- Configurar perfis reutilizáveis de autenticação.
- Permitir informar um bearer token ou obtê-lo de um endpoint existente.
- Suportar inicialmente OAuth 2.0 client credentials e endpoints com
  requisição e extração de access_token configuráveis.
- Controlar a expiração quando essa informação estiver disponível.
- Associar o perfil de autenticação a serviços e etapas dos fluxos.
- Tratar separadamente o acesso dos usuários à própria aplicação.

3. Importação de contratos
- Importar Swagger 2.0 e OpenAPI 3.0 e 3.1, em JSON ou YAML,
  por arquivo e URL.
- Importar operações, parâmetros, schemas, respostas e definições
  de segurança compatíveis.
- Validar o documento e apresentar uma prévia antes de salvar.
- Informar elementos incompatíveis ou não importados.
- Na reimportação, apresentar diferenças e conflitos antes de atualizar.

4. Importação de projetos Java Quarkus
- Permitir informar URL do repositório Git, branch ou tag e subdiretório.
- Prever acesso a repositórios privados por credenciais protegidas.
- Priorizar contratos OpenAPI existentes no projeto.
- Quando necessário, analisar estaticamente endpoints, anotações e DTOs
  reconhecidos pelo importador.
- Não executar código ou scripts do repositório na importação inicial.
- Apresentar a origem das informações e as limitações da análise,
  permitindo revisão antes do cadastro.
- Não presumir regras de negócio que não possam ser identificadas.

5. Modelagem e execução de fluxos
- Disponibilizar um editor visual para conectar operações cadastradas.
- Permitir variáveis de entrada e passagem de dados entre etapas.
- Permitir usar campos de uma resposta em chamadas posteriores.
- Suportar sequência, condições simples, timeout e comportamento
  configurável de interrupção ou continuidade em caso de erro.
- Executar as chamadas no backend, com acesso aos ambientes autorizados.
- Exibir status, duração e resultados de cada etapa, protegendo segredos.
- Não repetir automaticamente operações que possam causar efeitos
  duplicados sem configuração explícita.

6. Testes funcionais
- Cadastrar casos de teste para operações e fluxos.
- Definir entradas e validar status HTTP, cabeçalhos, estrutura JSON,
  presença, tipo e valor de campos.
- Suportar cenários positivos e negativos.
- Exibir resultado esperado, resultado obtido e motivo da falha.
- Persistir casos de teste e histórico das execuções.
- Nesta versão, “retorno esperado” significa uma asserção de teste;
  respostas simuladas devem ser tratadas como funcionalidade de mocks.

Requisitos transversais
- Interface em português, com validações e mensagens de erro claras.
- Persistência de serviços, contratos, fluxos e testes.
- Separação de configurações e credenciais por ambiente.
- Proteção de credenciais e mascaramento de tokens e dados sensíveis.
- Controle de acesso e registro de alterações e execuções.
- Configuração dos destinos de rede permitidos, incluindo serviços
  internos autorizados.
- Dados sintéticos para demonstrações e testes.

Forma de trabalho
- Se houver um projeto existente, inspecione sua estrutura e convenções.
- Proponha arquitetura, modelo de dados e etapas de implementação.
- Explicite suposições e esclareça ambiguidades que alterem o escopo.
- Entregue funcionalidades completas por etapa, incluindo interface,
  backend, persistência e validação.
- Documente instalação, configuração, execução e limitações.
- Não apresente funcionalidades simuladas como integrações concluídas.

Ordem sugerida
1. Catálogo, operações, importação OpenAPI, autenticação e chamada individual.
2. Editor de fluxos, execução e testes funcionais.
3. Importação de projetos Quarkus.

Critério de aceite principal
O usuário deve conseguir importar um contrato, revisar e salvar um serviço,
configurar sua autenticação, executar uma operação, montar um fluxo que
utilize dados de uma resposta na próxima chamada e executar um teste com
resultado persistido e indicação clara de sucesso ou falha.
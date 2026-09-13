# @cybervinci/flow

CLI, TUI, API local autenticada e editor React Flow do CyberVinci Flow Studio.

O executável público é apenas `flow`. Novos projetos usam `flow.graph.json`; um
`flow-studio.graph.json` existente continua sendo reconhecido automaticamente.

```powershell
flow template "Meu fluxo" meu-flow.json
flow validate meu-flow.json
flow providers --search OpenCode
flow models openrouter --search gpt
flow providers login openrouter
flow tui meu-flow.json
flow serve meu-flow.json --workspace .
flow run meu-flow.json --input '{"pedido":"analise isto"}' --simulate
```

## Catálogo e autenticação standalone

O Flow inclui um snapshot próprio do catálogo Models.dev e o atualiza diretamente
pela API oficial. CyberVinci e OpenCode não são dependências: quando presentes,
entram como fontes opcionais mescladas em paralelo para OAuth, sessões e adapters
especializados. O modo standalone oferece catálogo, cofre criptografado e execução
HTTP nativa para OpenAI/compatíveis, Anthropic e Google. Use:

```powershell
flow providers
flow providers --source flow
flow providers login openai
flow providers login openai --source cybervinci --method "ChatGPT Pro/Plus (browser)"
flow providers logout openrouter
flow models openrouter
flow models --search claude
flow models openrouter --json
```

Sem `--source`, o Flow mescla seu catálogo com CyberVinci/OpenCode quando eles
existem. `--source flow` garante operação autônoma; `--source cybervinci` ou
`--source opencode` força um host externo. `flow run --model <provider/model>` usa
o runner standalone por padrão para providers de API.

### Receitas de conexão

```powershell
# API key no cofre standalone (entrada mascarada)
flow providers login openai

# Login Codex/ChatGPT pelo navegador, quando CyberVinci estiver instalado
flow providers login openai --source cybervinci --method "ChatGPT Pro/Plus (browser)"

# OpenCode Zen e OpenCode Go
flow models opencode
flow providers login opencode-go
flow models opencode-go

# OpenRouter standalone
flow providers login openrouter
flow models openrouter --search gpt

# Automação segura por stdin ou variável de ambiente
'minha-chave' | flow providers login openrouter --source flow --api-key-stdin
flow providers login openrouter --source flow --api-key-env OPENROUTER_API_KEY

# Endpoint OpenAI-compatible alternativo para um provider do catálogo
flow providers login openai --source flow --base-url https://llm.exemplo.com/v1

# Forçar o OpenCode original
flow providers --source opencode
flow providers login openrouter --source opencode
```

Para usar o popup visual, execute `flow serve flow.graph.json --workspace .`,
abra a URL impressa pelo comando e clique em **Modelos**. O mesmo popup aparece
quando o Studio é aberto pela ferramenta `flow_open` do plugin.

## Comandos, opções e parâmetros

`flow template [nome] [arquivo]` cria um GraphSpec v2. `nome` é opcional e
`arquivo` recebe o JSON; sem arquivo, o grafo é impresso no terminal.

`flow validate <arquivo>` valida schema, rotas, permissões e semântica sem
executar o grafo.

`flow providers [list|login|logout] [provider]` lista ou autentica providers.
As opções são `--source flow|cybervinci|opencode`, `--method
<nome-do-método>`, `--api-key-stdin`, `--api-key-env <variável>`, `--base-url
<url>`, `--headers '<json>'`, `--protocol auto|openai|anthropic|google`,
`--search <texto>` e `--json`. `--method` escolhe
OAuth de um host externo; as demais opções de credencial configuram o Flow.

`flow models [provider]` lista modelos. Aceita `--source
flow|cybervinci|opencode`, `--search <texto>` e `--json`. A referência utilizável é
sempre `<provider>/<model>`, por exemplo `openrouter/openai/gpt-5.5`.

`flow author <pedido> [arquivo]` cria ou atualiza um grafo por IA. Aceita
`--profile <id>`, `--author-exec <comando>`, `--tool-exec <toolId=comando>` e
`--playbook-exec <playbookId=comando>`.

`flow run <arquivo>` executa o grafo. Opções mais usadas:

- `--input '<json>'` ou `--input @arquivo.json`: entrada inicial;
- `--provider <provider>` e `--model <provider/model>`: override do modelo;
- `--reasoning none|low|medium|high|xhigh`: esforço de raciocínio;
- `--watch`: eventos ao vivo; `--max-steps <n>`: teto adicional de passos;
- `--simulate`: adapters simulados, sem chamada real ao provider;
- `--provider-exec <provider[:model]=comando>`, `--tool-exec
  <toolId=comando>`, `--playbook-exec <playbookId=comando>` e `--memory-exec
  <comando>`: bridges personalizados;
- `--memory-approval '<json>'` ou `@arquivo.json`: receipt de aprovação;
- `--allow-graph-tools`, `--allow-graph-runners`, `--allow-command <padrão>` e
  `--allow-runner-host <host>`: teto explícito para execução declarada pelo
  grafo.

`flow serve [arquivo]` abre a API e o Studio Web. Aceita `--host <host>`,
`--port <porta>`, `--workspace <pasta>`, `--token <token>`, `--provider-host
flow|cybervinci|opencode`, `--simulate` e as mesmas opções de adapters/permissões de
`run`.

`flow tui [arquivo]` abre a interface de terminal e aceita as mesmas opções de
host de `run`/`serve`. `flow --help` imprime a referência compacta instalada.

No Studio Web, o botão **Modelos** abre um catálogo visual com busca, status de
conexão, custos, limites e capabilities. Providers de API key usam o cofre local
AES-256-GCM do Flow; OAuth continua disponível por hosts opcionais. A chave não é
salva no GraphSpec, no catálogo de perfis ou em logs. Ao escolher **Usar no Flow**,
somente uma assinatura sem segredos é persistida em
`.flow-studio.model-profiles.json`. O cache e o cofre ficam em `%APPDATA%\flow`
no Windows ou em `$XDG_CONFIG_HOME/flow` nos demais sistemas; `FLOW_CONFIG_DIR`
permite mudar esse diretório.

O comando `serve` imprime a URL com um token de sessão. Comandos declarados no GraphSpec só atravessam o boundary do host com as duas autorizações: `--allow-graph-tools` e ao menos um `--allow-command <pattern>`. O mesmo teto independente vale para runners declarados no grafo: `--allow-graph-runners`, `--allow-command` para runners por processo e `--allow-runner-host` para endpoints HTTP. As permissões do GraphSpec continuam obrigatórias, mas nunca ampliam esse teto do host. Sem `--simulate` ou adapters reais, nós de IA falham fechados.

`fileRoots`, validação de `cwd` e inspeção dos argumentos reduzem a superfície acidental, mas não formam uma sandbox do sistema operacional: um processo autorizado ainda pode acessar tudo que a conta do servidor puder acessar. Execute GraphSpecs não confiáveis em container, VM ou sandbox de SO com credenciais e filesystem mínimos.

Os blocos `Context` e `Memory Write` usam por padrão o armazenamento aprovado e atômico `.flow-studio/memory.json`. A busca desse store local é textual (não vetorial). O lock por diretório é recuperável após crash; cada registro é limitado a 512 KiB, o store a 16 MiB/10.000 entradas e a retenção mantém até 20 revisões por identidade. `--memory-exec <comando>` substitui o store local por um bridge confiável — por exemplo, CyberVinci Memory — que recebe JSON por stdin com `operation: "loadContext" | "writeCandidate"`. Um host também pode fornecer `--memory-approval '<json>'` ou `--memory-approval @arquivo.json`; cada receipt inclui `graphId`/`nodeId` e, quando usados, `scopeId`/`storeId`, além de `candidateDigest`. O servidor expõe `POST /api/memory/candidate-digest` para a UI autenticada calcular o digest sem persistir o candidato. `candidate` e `approved` são estados editoriais; nenhum deles isoladamente prova aprovação.

Playbooks inline/em arquivo usam o próprio runtime. Um playbook hospedado externamente pode ser registrado com `--playbook-exec id=comando`, recebendo JSON por stdin e devolvendo o resultado estruturado por stdout. Os ids de `--tool-exec` e `--playbook-exec` também entram no catálogo enviado à autoria por IA. Processos de provider, ferramenta, playbook e memória recebem apenas um conjunto mínimo de variáveis de ambiente, sem herdar segredos arbitrários do servidor.

O runner `flow` executa providers configurados sem outro CLI. Runners `codex`,
`cybervinci` e `opencode` permanecem disponíveis e reutilizam seus logins, modelos
e sessões quando instalados. Providers com autenticação ou protocolo especializado
(por exemplo, OAuth proprietário ou alguns serviços cloud) podem continuar usando
esses adapters opcionais. `command`, MCP por comando e HTTP/worker autorizado
continuam disponíveis para integrações próprias.

## Host-owned production and visual review

Two opt-in library modules are available to trusted hosts. They are not enabled by
putting a tool name or a `ready: true` flag in an untrusted GraphSpec:

- `@cybervinci/flow/lib/cybervinci-agent.js` exports `executeCyberVinciAgent`.
  It starts a fresh CyberVinci CLI session with a generated primary agent,
  deny-by-default tool permissions, prompt through stdin and verified file
  attachments. Readonly tool classifications and file roots are host policy.
  The result includes the strict final JSON, session ID, compact completed-tool
  traces and usage. It does not retry or fall back after an ambiguous result.
- `@cybervinci/flow/lib/production-loop.js` exports `runProductionQueue`.
  A trusted host supplies prepare/produce/freeze/verifyFrozen/review callbacks.
  Each revision runs through the actual Flow engine, with effect receipts and a
  Fork/Join-all for the two reviewers. The producer invocation is a command
  effect with write-ahead persistence. A known, completed technical failure may
  return `ProductionCorrection` for another revision without fabricated scores.
- `@cybervinci/flow-shared` exports `validateProductionReview` and its types.
  Acceptance requires two assigned reviewers with distinct sessions/invocations,
  matching scope/revision/manifest and evidence, ten criteria of ten points each,
  total 100 and no outstanding findings or missing verification. A host must
  rehash the files before review and approval; these checks do not prove semantic
  honesty of an arbitrary model response.

The queue uses an exclusive writer lock and atomic state replacement. Approval
and cursor advancement share one state update. REVISE retains the current asset;
WAIT or an ambiguous effect never silently advances or replays. Session budgets
pause work without approving it. Locks are not stolen, including stale locks.
The owner must explicitly reconcile interrupted work before resuming.

CyberVinci `read` and `edit` permission aliases are indivisible: request and
classify the full group or the bridge rejects the policy before launching. Prefer
immutable attachments and no native tools for judges. `--pure` is retained to
avoid recursive external plugins; it does not itself disable MCP. Arbitrary
native-runtime overrides are not enabled by this bridge.

These modules are not an OS sandbox or Blender rollback facility. Only the host
may issue trusted receipts or write queue/approval records. Keep evidence immutable
while the CLI reopens attachments, protect control files from producers, and
serialize all access to the shared Blender scene. A declared vision capability
or successful checkpoint test is not a substitute for a real image/MCP probe.

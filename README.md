# Flow

Flow e um CLI autonomo para criar, validar, executar e visualizar agentes graficos. Ele tambem inclui um plugin compativel com CyberVinci e OpenCode, sem exigir que nenhum dos dois esteja instalado para configurar providers e modelos.

## Destaques

- CLI `flow` com TUI e Studio Web baseado em React Flow.
- GraphSpec v2 e runtime compartilhado com 19 blocos nativos.
- Catalogo standalone de providers e modelos, atualizado a partir do Models.dev.
- Cofre local criptografado para API keys.
- Execucao nativa de APIs OpenAI-compatible, OpenAI Responses, Anthropic e Google.
- Integracao opcional com os logins, modelos e sessoes do CyberVinci/OpenCode.
- Plugin com as ferramentas `flow_open`, `flow_author`, `flow_run`, `flow_status`, `flow_resume`, `flow_replay` e `flow_cancel`.

## Instalacao para desenvolvimento

```powershell
npm install
npm run build
npm link --workspace @cybervinci/flow
npm link --workspace @cybervinci/flow-plugin
flow --version
```

## Primeiros comandos

```powershell
flow template "Meu fluxo" flow.graph.json
flow validate flow.graph.json
flow providers
flow providers login openrouter
flow models openrouter --search gpt
flow tui flow.graph.json
flow serve flow.graph.json --workspace .
flow run flow.graph.json --input '{"pedido":"analise isto"}' --simulate
```

O Flow funciona sozinho com `--source flow`. Quando CyberVinci ou OpenCode estao disponiveis, seus catalogos e metodos de login podem ser mesclados automaticamente ou selecionados com `--source cybervinci` e `--source opencode`.

Consulte a [referencia completa do CLI](flow-studio-cli/README.md) e o [guia do plugin para CyberVinci/OpenCode](flow-studio-opencode-controller/README.md).

## Pacotes

- `@cybervinci/flow`: CLI, TUI, API local e Studio Web.
- `@cybervinci/flow-plugin`: plugin e controller para CyberVinci/OpenCode.
- `@cybervinci/flow-shared`: tipos, validacao, autoria e engine compartilhada.

## Validacao

```powershell
npm test
```

O snapshot do catalogo pode ser renovado com:

```powershell
npm run catalog:update --workspace @cybervinci/flow
```

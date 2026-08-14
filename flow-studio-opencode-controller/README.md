# Flow Controller para CyberVinci e OpenCode

Plugin fino e compatível com CyberVinci/OpenCode para controlar o CyberVinci Flow CLI sem duplicar o runtime.
Quando o CyberVinci CLI está no `PATH`, ele também pode ser usado diretamente por nós com
`runnerId: "cybervinci"`; login, modelo padrão e sessões são reaproveitados pelo runtime.

Ele registra sete ferramentas: abrir o Studio, criar fluxos por IA, executar, consultar status,
retomar gates/waits, reproduzir checkpoints e cancelar runs. O CLI continua responsável por
GraphSpec v2, providers/modelos por nó, permissões, checkpoints, efeitos e persistência.

```json
{
  "plugin": ["file:///D:/Flow%20Studio/flow-studio-opencode-controller/lib/opencode-plugin.js"],
  "permission": {
    "flow_status": "allow",
    "flow_open": "ask",
    "flow_author": "ask",
    "flow_run": "ask",
    "flow_resume": "ask",
    "flow_replay": "ask",
    "flow_cancel": "ask"
  }
}
```

Essa mesma entrada funciona em `~/.config/cybervinci/cybervinci.jsonc` e em
`~/.config/opencode/opencode.json`. Depois de iniciar `cybervinci` ou `opencode`
no projeto desejado, peça por exemplo: `Use flow_author para propor um grafo em
flow.graph.json sem aplicar; depois abra-o com flow_open.`

O Studio aberto por `flow_open` usa primeiro o catálogo e o cofre standalone do
próprio Flow. CyberVinci/OpenCode são fontes opcionais mescladas em paralelo para
OAuth, sessões e providers especiais. O seletor visual permite conectar via API
key mesmo quando nenhum dos dois CLIs está instalado. A opção `providerHost:
"flow" | "cybervinci" | "opencode"` força uma origem; quando omitida, o catálogo
é unificado. Credenciais continuam fora dos argumentos das ferramentas do agente.

O servidor é sempre iniciado em loopback, com porta dinâmica e token aleatório. Comandos de
runner, tool, playbook e memória são configuração do host e nunca argumentos expostos ao agente.
As opções `playbookExec`, `memoryExec`, `allowGraphRunners`, `allowCommands` e
`allowRunnerHosts` são encaminhadas ao CLI. `allowGraphTools` ou `allowGraphRunners` nunca
dispensam a allowlist independente do host. A consulta de status aceita `detail: "effects"` sem
exigir o payload completo do run.

O arquivo padrão para novos projetos é `flow.graph.json`. Se um projeto já tiver
`flow-studio.graph.json`, o plugin o reconhece automaticamente para preservar compatibilidade.

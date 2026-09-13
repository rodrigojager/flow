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

## Runtime do CLI

O controller preserva `process.execPath` quando ele é um Node/Bun normal e passa
uma probe de JavaScript. Um host compilado, como `cybervinci.exe`, não é usado como
interpretador: nesse caso, o controller procura Node nas entradas absolutas do
`PATH` do host (`node.exe` no Windows), sem a busca implícita no diretório atual do Windows.

Para escolher explicitamente o runtime, o host pode fornecer a opção de plugin/controller
`runtimePath`, por exemplo `C:\\Program Files\\nodejs\\node.exe` em JSON, ou definir
`FLOW_STUDIO_RUNTIME_PATH` no ambiente do processo. A opção tem precedência sobre a
variável. Ambos exigem um caminho absoluto para um executável Node/Bun, sem argumentos
nem aspas adicionais; no Windows, somente `.exe`. Não são campos do grafo nem argumentos
das ferramentas do agente. A variável também vale para os comandos encaminhados pelo
`flow-controller`, como `validate` e `template`.

A validação executa apenas uma probe fixa, sem shell, com até 1,5 s e 4 KiB de saída
por candidato (no máximo dois candidatos automáticos ou um explícito). Uma configuração
explícita inválida falha sem fallback. A saída da probe não é incluída nos erros.
O `PATH` e o override devem ser confiáveis: a probe verifica execução de JavaScript,
não a procedência do binário. O processo do Flow continua recebendo o ambiente e as
permissões configurados pelo host.

Depois de recompilar/atualizar o plugin ou alterar o runtime do host, encerre e reinicie
CyberVinci/OpenCode para recarregar o plugin; sessões já abertas não são migradas.

## Inicialização e Navegador

Falhas assíncronas ao criar o processo do CLI (por exemplo, `ENOENT` para um workspace
inexistente) rejeitam `start()` sem derrubar o host. O erro expõe o código do sistema,
não os argumentos do processo que contêm o token. Um processo sem PID não entra na
espera de encerramento.

A espera de health tem prazo de 20 s após o spawn. Cada requisição HTTP recebe um
`AbortSignal` limitado ao tempo restante e combinado com o cancelamento do chamador
e os erros do processo filho. Assim, um servidor que aceita conexões mas não envia
cabeçalhos não bloqueia a inicialização indefinidamente. Em falha, o controller ainda
encerra o filho; essa limpeza pode acrescentar até 4 s ao prazo de health.

No Windows, a abertura do navegador verifica os caminhos absolutos de `rundll32.exe`
e `url.dll` em `SystemRoot\System32`. Executa apenas esse `rundll32.exe`, com esse
diretório como `cwd` para resolver `url.dll,FileProtocolHandler`, sem shell e sem
buscar o executável no `PATH` ou no workspace. O `SystemRoot` herdado deve ser confiável e conter
um caminho absoluto com unidade. Arquivos ausentes ou redirecionados por links fazem
a abertura falhar sem fallback. Uma falha assíncrona posterior do navegador é tratada
como best-effort, sem derrubar o host ou registrar a URL autenticada.

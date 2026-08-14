# @cybervinci/flow-shared

GraphSpec v2, JSON Schema, autoria por IA e runtime compartilhado do CyberVinci Flow Studio.

```ts
import { createFlowStudioTemplate, validateFlowStudioGraph, runFlowStudioGraph } from '@cybervinci/flow-shared';

const graph = createFlowStudioTemplate('Meu fluxo');
const validation = validateFlowStudioGraph(graph);
const result = await runFlowStudioGraph({ graph, simulationMode: true });
```

Execução real requer adapters explícitos de runner/provider e ferramenta. O pacote não troca silenciosamente para simulação.

O contrato possui 19 blocos nativos: Input, Context, Agent, Playbook, Action, Command, Memory Write, Router, Fork, Dynamic Parallel, Tournament, Join, Gate, Wait, Subgraph, Loop, Transform, Report e End. Context/memória e playbooks externos têm adapters tipados; approvals de memória são ligados ao digest e ao nó/store/escopo de destino. Fan-out dinâmico e torneio executam políticas e estratégias reais, com limites e deadline cumulativo obrigatórios; subgrafos consomem o mesmo orçamento global de passos.

Runs e nós produzem spans e métricas pela API OpenTelemetry. Configure um provider/exporter OpenTelemetry no processo host para enviá-los ao backend de observabilidade escolhido.

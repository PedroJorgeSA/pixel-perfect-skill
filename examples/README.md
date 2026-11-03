# Exemplos

| Exemplo | O que mostra | Roda sem projeto real? |
|---|---|---|
| [`01-landing-demo`](01-landing-demo/) | O protocolo inteiro (camadas 1–4) numa landing com 4 desvios típicos, e a versão corrigida passando | Sim: `npm run demo` |
| [`02-storefront-tailwind`](02-storefront-tailwind/) | Tokens no `@theme` do Tailwind v4, auditoria de classes arbitrárias, specs com `requires` (catálogo) e `before` (estado aberto) | A auditoria, sim |
| [`03-landing-sem-mcp`](03-landing-sem-mcp/) | Modo sem MCP: costura de capturas do protótipo, diff por seção, tipografia nó a nó e amostragem de cor, numa landing que escala com `cqw` | Sim: `bash examples/03-landing-sem-mcp/run.sh` |
| [`prompts.md`](prompts.md) | Como pedir as coisas ao Claude com a skill instalada, e o relatório que volta | — |

Todos usam `PIXEL_CONFIG=<exemplo>/config.json` para apontar os scripts para o config do
exemplo sem mexer no `config.json` da skill. Os "Figmas" aqui são fictícios: `figma/frame.html`
faz o papel do frame e é renderizado para gerar a referência (num projeto real ela vem do
`get_screenshot` do Figma MCP ou das capturas do protótipo).

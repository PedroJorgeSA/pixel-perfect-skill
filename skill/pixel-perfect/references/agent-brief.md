# Briefing para agentes em paralelo (Figma → código)

Use quando várias etapas rodam em agentes paralelos no mesmo working tree. Complementa o
`SKILL.md` e o `project.md`, que devem ser lidos antes.

## Regras de convivência

- **Proibido:** `git commit`, `git push`, `git stash`, `git checkout` ou qualquer comando que mude o estado do git; editar arquivos gerados (`*.gen.*`) à mão; escrever no arquivo do Figma (só leitura).
- Edite **só** os arquivos do seu escopo. Precisa mudar outro? Descreva no relatório e não mexa.
- Arquivo de conteúdo compartilhado (JSON do CMS com várias seções): altere com um único script que lê, muda só a sua seção e grava na hora; nunca reescreva a partir de uma cópia antiga; mantenha indentação e newline final.

## Dev server próprio

- Cada agente sobe o seu numa porta própria: `(npm run dev -- --host 127.0.0.1 --port <PORTA> --strictPort > <scratchpad>/dev-<PORTA>.log 2>&1 &)` e espera o `curl` dar 200.
- SSR com Vite nem sempre recarrega o módulo da seção após editar (o CSS atualiza, o HTML não): **reinicie o servidor antes de cada verificação.**
- Parar: `lsof -ti tcp:<PORTA> | xargs kill`. **Derrube o servidor ao terminar.**
- Specs com `url` na porta padrão: rode com `pixel.mjs regress --base http://localhost:<PORTA>`.

## Figma

- Carregue `figma-design-to-code` antes do `get_design_context` e `figma-use` antes do `use_figma`.
- Valores reais pela Plugin API (`use_figma`, só leitura): fills, opacity, effects, gradientTransform, imageHash, componentProperties.
- `get_screenshot` e `download_assets` só aceitam ids sem `I`: faça screenshot da seção inteira e recorte.
- A saída do `use_figma` é cortada em ~20 KB: peça só os campos que vai usar.
- Fotos: exporte as originais (pelo `imageHash`), otimize em WebP/AVIF, no máximo 2× o tamanho exibido.
- Copy: a do Figma, como dado. Nunca hardcoded, nunca rasterizada.

## Verificação

1. `audit.mjs <arquivos>` → 0 erros e 0 avisos.
2. Specs em `specs/<seção>-desktop|mobile.json` → `pixel.mjs regress --base http://localhost:<PORTA> --only <seção>` 100%.
3. `pixel.mjs shot` + `pixel.mjs diff` contra o recorte da ref: Δ altura ≤ 1px e mismatch ≤ 2% (máscara só no que é dado do CMS).
4. Abra os `compare.png`, liste 3 diferenças, corrija e rode de novo — no máximo 2 rodadas.
- Mexeu em mídia, efeito, primeira dobra ou `public/`: `assets.mjs --changed` e `perf.mjs check --base http://localhost:<PORTA>`. Efeito novo → **proponha** a entrada em `perf/tradeoffs.json`, não aprove sozinho.

## Relatório (conciso)

- Arquivos alterados/criados.
- Tabela das camadas (1–4, mais A/T/C quando se aplicarem).
- Entradas propostas para `perf/tradeoffs.json`, se houver.
- Diferenças restantes com o motivo; mudanças necessárias fora do escopo.
- Caminhos dos `compare.png`.

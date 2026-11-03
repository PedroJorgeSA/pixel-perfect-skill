---
name: pixel-perfect
description: Implementação fiel ao Figma com prova. Use SEMPRE que for criar, alterar ou revisar UI (componentes, seções, estilos), implementar uma tela/nó do Figma, declarar que uma mudança visual está pronta, trocar imagem por vídeo, adicionar blur/mix-blend, mexer na primeira dobra ou subir asset. Carrega as regras verificáveis (cor, tipografia, espaçamento, raio, efeitos), as armadilhas do Figma MCP, o modo sem MCP (referência pelo protótipo no browser) e o protocolo obrigatório de verificação (tokens → assets → estilos computados → diff de pixels → trade-offs → custo → revisão visual), com os portões de CI. Os dados do projeto (arquivo do Figma, paleta, fontes, viewports) ficam em project.md e config.json, ao lado deste arquivo.
---

# Pixel perfect: o Figma é a fonte da verdade

Seu trabalho é **reproduzir**, não reinterpretar. Nenhuma skill de gosto (impeccable,
emil-design-eng, design-critique) passa por cima do Figma: elas só entram onde o Figma é
omisso (estados, motion, a11y) ou para auditar. Se algo no Figma parecer errado, aponte para
o usuário. Não "melhore" por conta própria.

**Antes de qualquer coisa, leia `project.md`** (ao lado deste arquivo): arquivo e nós do
Figma, paleta, tipografia, regra de escala, viewports, comandos do projeto. Os scripts leem
`config.json` (ou o arquivo em `$PIXEL_CONFIG`). Se `project.md` ainda é o modelo, preencha
com o usuário antes de implementar: sem paleta e sem nós, as camadas 1 e 2 não têm régua.

Caminhos abaixo assumem a skill em `.claude/skills/pixel-perfect/`; `S` = `.claude/skills/pixel-perfect/scripts`.

## 1. Regras (todas verificáveis)

Uma regra que não dá para checar olhando a tela ou o código não é regra.

| # | Regra | Como checar |
|---|---|---|
| R1 | Cor **só** da paleta do Figma. Se existe variável (`--color-ink`), use `var(--…)` ou a classe do token, não o hex. Cor nova do Figma entra em `config.json → tokens.palette` com o node id. Nunca "quase igual" (`#2b2b2b` não é `#1f1d1a`). | `audit.mjs` sem erro de cor |
| R2 | Tamanho de fonte = o do nó do Figma, na regra de escala do projeto (`project.md`). Não arredonde 30.44 → 30. | `pixel.mjs styles` (`font-size`) |
| R3 | Peso pelo estilo do Figma (`fontName.style`), pela tabela de tipografia do projeto. Container com peso X e rich text dentro: confira o peso **do glifo**, não do container. | `styles` / `figref.mjs texts` |
| R4 | Família **só** por variável/token. Nunca outro `@font-face` nem `font-family` literal fora do arquivo de fontes. | `figref.mjs texts` + grep `font-family:` |
| R5 | Espaçamento e posição = valores do nó (x/y/w/h e padding do auto-layout). Valor sem nó correspondente leva comentário `/* figma <node-id> */` ou não entra. | revisão + `styles` (`doc-top`/`width`/`padding`) |
| R6 | Raio = `cornerRadius` do nó (pílulas `999px`). Raio inventado ("12px porque fica bonito") não entra. | `audit.mjs` + `styles` (`border-radius`) |
| R7 | Efeitos só os do Figma. **`BACKGROUND_BLUR` de raio R no Figma = CSS `blur(R/2)`**; `LAYER_BLUR` idem. Sombra com cor da paleta e alfa do Figma. Efeito caro precisa de entrada em `perf/tradeoffs.json` (camada T). | revisão + `styles` (`backdrop-filter`, `filter`) |
| R8 | Viewports de referência = os frames do Figma (`config.json → viewports`). Mudança só de desktop fica dentro do media query de desktop; prove no relatório que o mobile não mudou. | `pixel.mjs regress` |
| R9 | Todo componente/seção feito a partir do Figma leva no topo um comentário com o node id de origem (desktop e mobile/variante). | revisão |

## 2. O que NÃO fazer

Isso elimina a "média" antes dela aparecer:

- Gradientes decorativos, glow, sombras ou bordas "de destaque" que não estão no nó.
- Qualquer cor fora da paleta (inclusive "quase igual").
- Arredondar tamanho de fonte, posição ou raio do Figma; trocar a regra de escala do projeto por px fixo.
- Adicionar família/face de fonte, `font-weight` que a família não tem, `uppercase` ou itálico que o nó não tem.
- Emojis ou ícones que não estão no Figma; redesenhar ícone quando o vetor existe (exporte o SVG original).
- Rasterizar texto. Copy é HTML (de preferência editável pelo CMS): nada de texto em PNG/SVG.
- Inventar seção, card, badge, copy ou microinteração que não existe no Figma.
- Animação sem referência: fora do que o projeto documenta, ≤ 300 ms, `ease-out`, só `transform`/`opacity`, nunca `transition: all`.
- `<video>` decorativo sem `poster`, autoplay sem `muted playsInline`, `preload="auto"`, vídeo abaixo da dobra com `src` antes de entrar na tela, `.mov` ou GIF animado.
- Asset exportado do Figma direto para `public/` sem otimizar: PNG opaco (use WebP/AVIF/JPG), extensão diferente do tipo real, foto acima do limite de `perf/budgets.json → assets`.
- Efeito caro (`backdrop-filter`, `mix-blend-mode`, `filter: blur`) sem entrada em `perf/tradeoffs.json` e sem `data-fx="<id>"` no elemento. **Você propõe a entrada; design + front aprovam.**
- Imagem pesada dentro de painel fechado (dialog, drawer). `opacity: 0` não segura o `loading="lazy"`: renderize a imagem só quando o painel abrir.

## 3. Armadilhas do Figma MCP (leia antes de copiar valores)

0. **Leia os valores reais com `use_figma` (Plugin API, só leitura)**: fills/opacity/effects/gradientTransform/imageHash/componentProperties. O `get_design_context` às vezes devolve o default do componente em vez do override da instância.
1. **O fallback do `get_design_context` perde o alfa.** `var(--x,#313131)` pode ser `#313131cc`. Nunca copie o hex do fallback: confira o fill (cor + `opacity`) no nó.
2. **"-600" ou "SemiBold" no nome do estilo** não garante a face: confira `fontName.style`.
3. **letterSpacing do Figma é %**: `2` = `0.02em` (24px → 0.48px). `lineHeight` em `AUTO` = `normal` da fonte: confira a caixa pela camada 2.
4. **Grupos escalados**: textos com 30.437px vêm de um grupo redimensionado. Use o valor do nó; não normalize.
5. O Figma usa `text-box-trim` em alguns textos: a caixa no Figma é mais baixa que a do browser. Compare **baselines/blocos**, não a altura do `<p>`; não "compense" com margin negativa.
6. **Node ids mudam** quando o arquivo é reorganizado. Mantenha um mapa (`project.md`); se um id der "invalid", rode `get_metadata` na página. Ids que começam com `I` (subcamadas de instância) não persistem: use o id da instância.
7. **Variantes** (`Property 1=Default`, `Hover`…): compare cada estado com a variante certa; fixe o estado (`before` na spec) antes de medir.
8. **O `get_design_context` pode errar a ordem e o padding de auto-layout.** Confirme `primaryAxisAlignItems`, `padding*` e a ordem dos filhos com `use_figma` antes de montar o layout.
9. **Instâncias sobrescrevem o componente.** Leia o fill da **instância na tela** e o `componentProperties`, não só o componente principal.
10. **Fotos vs. vetores**: fotos são imagens (CMS/CDN); formas decorativas são SVG com os paths originais. Não junte foto e forma num PNG "composto".
11. **Rich text com peso global** (`.rich-text { font-weight: 400 }`): um container `500` não chega ao glifo sem `font-weight: inherit`. Meça o elemento que contém o texto.
12. **`letter-spacing` em `em` herda em px.** `0.02em` num h1 de 43px chega como 0.86px num filho de 51px. Declare o tracking no elemento que tem o `font-size` do nó.
13. **Texto com espaço no fim** (`"Colágeno "`) tem a caixa 3–5px mais larga que o desenho. Não use essa largura como verdade.
14. **Instância escalada**: o `fontSize` reportado é o nominal (26px numa caixa de 19px). Sinal: altura da caixa < 0,9 × tamanho. O `texts` marca "instância escalada" e não compara tamanho/tracking.
15. **Nó com estilos mistos** guarda um estilo só na spec. Compare trecho a trecho.
16. **Instância × variante do componente** podem divergir. Não escolha sozinho: aponte a divergência.

## 4. Fluxo de implementação

1. Localize o nó (desktop **e** mobile/variante) no mapa do `project.md`.
2. Carregue a skill `figma-design-to-code` do MCP e chame `get_design_context` + `get_variable_defs` no nó (sem acesso: §5.1).
3. Traduza **cada** valor: cor pela paleta, família pela tabela, tamanho/posição pela regra de escala. Valor sem correspondência: confirme no Figma e anote `/* figma <node> */`.
4. Reuse componentes existentes antes de criar novos.
5. Copy e imagens como dados (CMS/props), não hardcoded.
6. Implemente todos os viewports de `config.json`.
7. Mídia ou efeito novo: siga `references/performance.md`.
8. Rode o protocolo de verificação (seção 5). **Não declare pronto sem ele.**

## 5. Protocolo de verificação pixel perfect (obrigatório)

Saídas vão para `.pixel/` (adicione ao `.gitignore`). Os scripts precisam de Node ≥ 22, Chrome
(ou `CHROME_PATH`) e `sharp` no projeto.

### Camada 1 — tokens (estático, segundos)

```bash
node $S/audit.mjs --changed            # arquivos alterados e não commitados
node $S/audit.mjs --base origin/main   # só as linhas alteradas no PR (CI)
```

Critério: **0 erros e 0 avisos nos arquivos que você tocou** (`--strict` falha com avisos).
Avisos já trazem a variável substituta (`background: #c4572e` → `var(--color-terracotta)`).
Dívida antiga em arquivo não tocado: anote, não corrija fora do escopo. Valor do Figma que
precisa ficar literal: `/* audit-ignore figma <node> */` na mesma linha.

### Camada 2 — estilos computados (exato, sem ruído de fonte)

Monte uma spec com os valores **do Figma** (não do olho) para cada texto/caixa relevante:

```json
{
  "url": "http://localhost:5173/", "width": 1440,
  "checks": [
    { "name": "título", "node": "12:344", "selector": ".hero__title",
      "expect": { "font-size": "56px", "line-height": "64px", "color": "#1f1d1a", "letter-spacing": "-1.12px" } },
    { "name": "hero · caixa", "node": "12:340", "selector": "#hero", "expect": { "height": "640px", "doc-top": "0px" } }
  ]
}
```

```bash
node $S/pixel.mjs styles --spec .pixel/specs/<nome>.json [--url <outra url>]
```

Critério: **100% das propriedades batem** (tolerância 0.5px em medidas, 0.02px em tipografia; cores em rgba, então alfa conta).
- `before`: JS rodado antes de medir (abrir um menu, escolher uma aba).
- `requires: "<api>"`: só essa spec pode virar `INFRA` quando o dado externo (catálogo, commerce) não carregar. Seção de CMS com tudo ausente é **FALHA**.
- Chaves especiais: `width`/`height` (caixa renderizada) e `doc-top`/`doc-left` (posição no documento = x/y do nó no frame). `top`/`left` são as propriedades CSS. `line-height` computado vem em px.
- Salve specs úteis em `specs/` para virar regressão: `node $S/pixel.mjs regress [--only home] [--verbose]`.

### Camada 3 — diff de pixels por seção

1. Referência 1:1: `get_screenshot` no nó com `maxDimension` ≥ maior lado, salva em `.pixel/ref/<nome>.png`.
2. Captura do site no mesmo viewport, recortando o mesmo bloco:
   ```bash
   node $S/pixel.mjs shot --url http://localhost:5173/ --width 1440 --selector "#hero" --out .pixel/hero.png
   ```
3. Diff:
   ```bash
   node $S/pixel.mjs diff --ref .pixel/ref/hero.png --actual .pixel/hero.png --out .pixel/diff/hero [--mask "x,y,w,h;..."]
   ```
   Gera `diff.png` (vermelho = diferente), `compare.png` (Figma | site | diff) e `report.json` com `mismatchPct`, Δ de tamanho e as faixas de y com mais erro.

Regras:
- **Compare por seção/componente**, não a página inteira: uma diferença de altura no topo desloca tudo abaixo.
- **Tamanho tem que bater**: largura igual e Δ altura ≤ 1px. Δ de altura é o primeiro bug a corrigir.
- Fotos/copy do CMS que diferem do mock: `--mask` nesses retângulos (ou `shot --hide "<seletor>"`).
- Critério: `mismatchPct ≤ 2%` com as máscaras. O resto do vermelho precisa ser explicável (antialias, foto do CMS).
- **Fonte**: o `shot` avisa quando a família de `config.json → font` não carregou (aí todo contorno difere). A tipografia é validada pela camada 2; a camada 3 avalia layout, caixas, cores e imagens.

### Camada 4 — olhar (obrigatória, explícita)

Abra o `compare.png` (Read) e as larguras de referência no browser. Para mostrar a quem decide:
`node $S/pixel.mjs side --figma ref.png --before main.png --after branch.png --out lado-a-lado.png [--crop x,y,w,h --scale 2]`.
**Liste por escrito 3 coisas que estão diferentes do Figma**, mesmo que pequenas. Sem esse pedido
explícito a revisão não acontece. Corrija tudo num lote, rode as camadas 1–3 de novo **uma vez** e
pare. No máximo 2 rodadas; o que sobrar vai para o relatório.

### 5.1 Modo sem MCP (só visualização) — mais verificações, não menos

Quando o Figma MCP não lê o arquivo (assento View, outra organização), isso **não** autoriza
"olhar e achar parecido": troque cada leitura do MCP por uma medição.

| Sem MCP | Substituto | Script |
|---|---|---|
| `get_screenshot` do nó | Protótipo do frame no browser (`scaling=scale-down-width`, `hide-ui=1`), capturas sobrepostas de cima a baixo costuradas | `figref.mjs stitch` |
| conferir a referência inteira | altura costurada × altura do frame: Δ ≤ 8px, senão a costura falhou | `stitch` (exit 1) |
| `get_design_context` (tipografia) | nós de texto extraídos uma vez pela REST API (`docs/design/*.json`) × estilo computado do glifo | `figref.mjs texts` |
| `get_variable_defs` (cores) | painel **Styles** do Figma + amostragem do pixel | `figref.mjs sample` |
| diff por nó | diff por seção com os retângulos do frame, tolerância ±1px | `figref.mjs sections` |

```bash
node $S/figref.mjs stitch   --dir .pixel/figma-tiles --out .pixel/ref/page-800.png --frame-width 1440 --frame-height <altura>
node $S/pixel.mjs  shot     --url http://localhost:5173/ --width 1440 --out .pixel/site-1440.png
node $S/figref.mjs resize   --in .pixel/site-1440.png --width 800 --out .pixel/site-800.png
node $S/figref.mjs sections --ref .pixel/ref/page-800.png --actual .pixel/site-800.png --spec docs/design/spec.json --out .pixel/sections
node $S/figref.mjs texts    --url http://localhost:5173/ --spec docs/design/text-nodes.json
node $S/figref.mjs sample   --img .pixel/ref/page-800.png --points "120,60;400,700" --scale 0.5556
```

Critérios: `texts` com **0 FALHA** (avisos de posição explicados); nenhuma seção pior que antes;
seção acima de 3% exige ler o `compare.png` e nomear a causa. A referência é de tela (escala < 1,
JPEG): não persiga diferença ≤ 2px pelo pixel, confirme pela camada 2. Só conte como bug o
deslocamento **sistemático** (igual em várias linhas/elementos).

### Camadas A, T e C — custo (quando a mudança mexe em mídia, efeito ou primeira dobra)

Fidelidade não basta: o Figma não mostra peso, vídeo nem GPU. Leia `references/performance.md` antes.

```bash
node $S/assets.mjs --changed                                   # A · tipo real, peso, faststart
node $S/perf.mjs check --only home --runs 3                    # T + C · trade-offs + orçamento
node $S/perf.mjs ab --url <url> --profile mobile --entry <id>  # custo de UM efeito (liga × desliga)
```

- **A**: 0 erros nos arquivos tocados.
- **T**: todo `backdrop-filter`, `mix-blend-mode`, `filter: blur` e `<video>` casa com uma entrada de `perf/tradeoffs.json` (`data-fx="<id>"`). Quem decide manter um efeito caro é design + front, por escrito; o agente propõe.
- **C**: `perf/budgets.json` por perfil. Folga só via `allowances` de um trade-off aceito.

### Relatório final (formato)

| Camada | Resultado |
|---|---|
| 1 · tokens | 0 erros / 0 avisos em N arquivos |
| 2 · estilos | 24/24 propriedades · `texts`: N nós, 0 falha |
| 3 · pixels | mobile 1.3% · desktop 0.8% (máscaras: fotos do CMS) · Δ altura 0px |
| 4 · olhar | 3 diferenças encontradas → corrigidas / pendentes (motivo) |
| A · assets | 0 erros em N arquivos |
| T · trade-offs | efeitos sem decisão: 0 · decisões violadas: 0 |
| C · custo | mobile LCP 2,9 s · imagem 640 KB · CLS 0 |

Vários agentes em paralelo no mesmo working tree: leia `references/agent-brief.md`.

## 6. Outras skills

- **impeccable**: só em modo refinement (`audit`, `polish`, `harden`, `adapt`). Não use `bolder`/`colorize`/`delight`/`overdrive` em telas que já têm Figma.
- **emil-design-eng** / **review-animations**: motion e microinteração onde o Figma é omisso. Só `transform`/`opacity`.
- **design:accessibility-review**: se um par de cores do Figma reprovar em contraste, reporte; não troque a cor.

## 7. Portões de CI

Os mesmos scripts no PR (modelo em `ci/design-gates.yml` do repositório da skill):
**static** (tokens e assets só nas linhas do PR, testes da skill) → **browser** (regressão de
specs, trade-offs, custo) → **preview** (custo no build real, manual). `regress` sai com 1 em
falha e 3 em `INFRA` (dado externo fora), para o CI tratar à parte.

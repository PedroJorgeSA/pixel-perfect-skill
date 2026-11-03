# 03 · Landing sem acesso ao Figma pelo MCP

Caso real comum: o arquivo é de outra organização e a sua conta só tem assento View. O MCP
responde "you don't have edit access" e não há `get_design_context` nem `get_screenshot`.
A skill troca cada leitura do MCP por uma medição (SKILL.md §5.1).

A landing escala com a largura no desktop: cada medida do frame de 1440 vira
`calc(N / 1440 * 100cqw)` dentro de um container `container-type: inline-size`.

```bash
npm install
bash examples/03-landing-sem-mcp/run.sh
```

## O pipeline

| Passo | Script | No projeto real |
|---|---|---|
| 0 · capturas | `simular-prototipo.mjs` | screenshots do protótipo (`scaling=scale-down-width&hide-ui=1`), rolando ~2 ticks por captura |
| 1 · referência | `figref.mjs stitch` | idem: recorta a moldura escura, acha o scroll fracionário e confere a altura do frame |
| 2 · site na escala da ref | `pixel.mjs shot` + `figref.mjs resize` | idem |
| 3 · diff por seção | `figref.mjs sections` com [`docs/design/spec.json`](docs/design/spec.json) | retângulos das seções extraídos uma vez da REST API |
| 4 · tipografia | `figref.mjs texts` com [`docs/design/text-nodes.json`](docs/design/text-nodes.json) | nós de texto extraídos uma vez da REST API |
| 5 · cor | `figref.mjs sample` | color styles lidos no painel Styles do Figma (`config.json → figmaStyles`) |

## Resultado

```text
── 1 · stitch: costura + conferência da altura do frame
referência 800 × 1142 · escala 0.55556 · Δ altura do frame -4.4px (máx 8)

── 3 · sections: diff por seção (retângulos do frame)
ok    inicio       40:2       0.8%
ok    rotina       40:20      0.41%
ok    produtos     40:40      0.29%

── 4 · texts: tipografia do glifo × nó do Figma
FALHA  40:4  "Sérum noturno com niacinamida e pe"   peso 400 ≠ 500 · y 432.0 ≠ 420
FALHA  40:6  "Limpe com água morna."                tracking 0.80 ≠ 1.00px
FALHA  40:7  "Aplique 3 gotas do sérum."            tracking 0.80 ≠ 1.00px
FALHA  40:8  "Finalize com hidratante."             tracking 0.80 ≠ 1.00px

── 5 · sample: cor da referência → color style mais próximo
1100,330     #eaa27a  →  Argila #e9a27a (Δ 1.0)
300,900      #44413c  →  Pedra #4a433c (Δ 6.7)
```

**A lição do exemplo:** o diff de pixels por seção dá tudo verde (< 1%), porque a referência é
de tela, em escala 0,556 e JPEG. Os três desvios só aparecem na medição:

1. **Peso 400 ≠ 500** — o container do parágrafo é `500`, mas o rich text interno fixa `400`
   (armadilha 11). Medir o container daria 500 e enganaria. Correção: `.rich-text p { font-weight: inherit }`.
2. **Tracking 0,80 ≠ 1,00px** — `letter-spacing: 0.05em` declarado no `<ol>` (16px) chega aos itens
   como 0,8px (armadilha 12). Correção: declarar `0.05em` no elemento que tem o `font-size` do nó.
3. **Parágrafo 12px abaixo** (`y 432 ≠ 420`) — `top: calc(432 / 1440 …)` no lugar de `420`.

Por isso o critério do modo sem MCP é **`texts` com 0 FALHA**, e não "o diff ficou baixo".

## figmaFamily

`config.json → font.figmaFamily` diz como o nome da fonte no Figma vira o `font-family` do CSS.
Aqui é `"{family}"` (igual). Numa família com larguras como estilo (Figma: família `Grotesca`,
estilo `Standard Medium`; CSS: `Grotesca Standard` peso 500) use `"Grotesca {style0}"`.

# 02 · Loja com Tailwind v4

Projeto onde os tokens do Figma viram variáveis do `@theme` ([`src/styles/app.css`](src/styles/app.css)).
O `audit.mjs` lê `--color-*`, `--text-*` e `--radius-*` dali e entende classes arbitrárias
(`text-[#1a1a1a]`, `rounded-[10px]`) e sugere a classe do token.

```bash
PIXEL_CONFIG=examples/02-storefront-tailwind/config.json \
  node skill/pixel-perfect/scripts/audit.mjs examples/02-storefront-tailwind/src/components/ProductCard.tsx
```

```text
     4  ERRO  rounded-[10px]  →  raio 10px não existe no Figma (escala: 8/999px)
     6  ERRO  text-[#1a1a1a]  →  cor fora da paleta do Figma — conferir o nó (use_figma) e registrar em config.json tokens.palette
     6  ERRO  text-[15px]  →  15px não existe na escala tipográfica do Figma
    11  aviso  bg-[#d6312b]  →  bg-sale
```

Correção: `rounded-card`, `text-body text-ink`, `bg-sale`.

## Specs de loja (camada 2)

- [`specs/product-card-desktop.json`](specs/product-card-desktop.json) — `"requires": "catalog"`: se a API do
  catálogo cair e nenhum card aparecer, o `regress` marca **INFRA** (exit 3) em vez de FALHA. Só
  spec que depende de dado externo pode fazer isso; seção de CMS sem elemento é FALHA.
  `"hide"` esconde um banner dinâmico antes da captura.
- [`specs/minicart-open-mobile.json`](specs/minicart-open-mobile.json) — `"before"` abre a sacola
  antes de medir (estado que só existe depois de uma interação), `"beforeWait"` espera a animação.

## project.md deste tipo de projeto

Veja [`project.md`](project.md): mapa de nós por tela (home, PLP, PDP, minicart), escala
tipográfica fechada e a regra de que o mobile é um frame de 375 separado.

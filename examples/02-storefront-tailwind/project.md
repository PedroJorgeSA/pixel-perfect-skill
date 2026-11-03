# Projeto — Loja Atlas (exemplo)

## Figma

- Arquivo: **Loja Atlas · Public** · `fileKey = EXEMPLO` · acesso pelo MCP: sim
- Frames: desktop 1440 · mobile 375 (frames separados, prefixo `M/`)
- Mapa de nós atual: `docs/figma-map.md`

| Tela | Desktop | Mobile |
|---|---|---|
| PLP | `1204:2` | `1204:300` |
| Card de produto | `1204:88` | `1204:131` |
| Minicart aberto | — | `1310:4` |

## Paleta

| Style do Figma | Valor | Token (`@theme`) | Classe |
|---|---|---|---|
| Neutral/900 | `#111111` | `--color-ink` | `text-ink` |
| Neutral/500 | `#6b6b6b` | `--color-muted` | `text-muted` |
| Neutral/200 | `#e4e4e4` | `--color-line` | `border-line` |
| Neutral/50 | `#f5f5f3` | `--color-surface` | `bg-surface` |
| Feedback/Sale | `#d6312b` | `--color-sale` | `bg-sale` |

## Tipografia

Inter (self-hosted, variável). Escala fechada: 12 (`text-caption`), 14 (`text-body`),
16 (`text-price`), 24 (`text-title`). Peso: Regular 400, SemiBold 600, Bold 700.

## Escala e viewports

px fixos. Corte em `md` (768px). Raios: 8 (`rounded-card`) e 999 (`rounded-pill`).

## Comandos

`npm run dev` (5173) · `npm run typecheck` · conteúdo vem do catálogo (specs de PLP/PDP declaram `"requires": "catalog"`).

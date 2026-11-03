# Projeto — dados que a skill precisa

> Modelo. Preencha com o time antes de implementar (o agente pode preencher lendo o Figma e o
> CSS, mas confirme com quem desenhou). Exemplos preenchidos: `examples/*/project.md` no
> repositório da skill.

## Figma

- Arquivo: **<nome>** · `fileKey = <chave>` · acesso pelo MCP: sim / não (→ modo sem MCP, §5.1)
- Frames de referência: desktop `<node>` (<largura> × <altura>) · mobile `<node>` (<largura> × <altura>)
- Mapa de telas e seções (node ids atuais): `docs/figma-map.md`
- Protótipo (para o modo sem MCP): `<url do proto com scaling=scale-down-width&hide-ui=1>`

## Paleta (Figma → código)

| Style / variável do Figma | Valor | Token no código |
|---|---|---|
| `Ink/900` | `#1f1d1a` | `--color-ink` |

Cor que não é style (override de instância) entra em `config.json → tokens.palette` com o nó.

## Tipografia (Figma → código)

| Figma (família · estilo) | Peso CSS | Família no código |
|---|---|---|
| `Inter · Regular / Medium / Bold` | 400 / 500 / 700 | `var(--font-sans)` |

Escala (px no frame): 12, 14, 16, 20, 24, 32, 48. `letterSpacing` do Figma é %: `2` = `0.02em`.

## Regra de escala

- Desktop: px fixos / `calc(<px> / 1440 * 100cqw)` num container `container-type: inline-size` / outra (descreva)
- Mobile: px fixos / `calc(N * var(--m))` com `--m = 100vw / 430` / outra
- Corte: `@media (min-width: 768px)`

## Comandos do projeto

- Dev server: `npm run dev` → http://localhost:5173
- Typecheck / testes que também cobrem layout: `<comandos>`
- Onde fica o conteúdo (CMS) e o que nunca editar à mão (`*.gen.*`): `<…>`

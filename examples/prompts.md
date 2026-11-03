# Como usar com o Claude Code

Com a skill em `.claude/skills/pixel-perfect/`, ela entra sozinha quando o pedido é de UI
(a `description` do SKILL.md manda usar "SEMPRE que for criar, alterar ou revisar UI"). Dá para
chamar explicitamente com `/pixel-perfect`.

## 1. Primeira vez no projeto: preencher `project.md` e `config.json`

> Configure a skill pixel-perfect para este projeto. O Figma é
> https://www.figma.com/design/<fileKey>/<nome>?node-id=1-2 (desktop 1440) e o mobile é o
> frame 1-300 (390). Leia as variáveis/color styles do arquivo e o nosso `src/styles`,
> preencha `project.md` e `config.json` e me mostre as cores do Figma que ainda não têm token.

O que esperar: tabela de paleta Figma → token, escala tipográfica, lista de hex do código fora
da paleta (dívida) e as cores do Figma sem variável, propostas para `tokens.palette` com o node id.

## 2. Implementar um nó do Figma

> Implemente a seção "Rotina em 3 passos" (nó 40:20 desktop, 41:7 mobile) em
> `src/sections/Rotina.tsx`. Copy e imagens como campos do CMS.

O agente: lê o nó (`get_design_context` + `use_figma` para alfa e overrides), traduz cada valor
pela paleta/escala, comenta o node id no topo, cria `specs/rotina-desktop.json` e
`specs/rotina-mobile.json` com os valores do nó e roda as camadas. Relatório no formato:

| Camada | Resultado |
|---|---|
| 1 · tokens | 0 erros / 0 avisos em 2 arquivos |
| 2 · estilos | 31/31 propriedades (desktop 19, mobile 12) |
| 3 · pixels | desktop 0.9% · mobile 1.4% (máscara: foto do CMS) · Δ altura 0px |
| 4 · olhar | 3 diferenças: ícone 1px acima (corrigido), sombra do card sem alfa (corrigido), quebra de linha do título em 1280 (pendente: o Figma só tem 1440) |

## 3. Revisar um PR de UI contra o Figma

> Revise a branch `feat/header` contra o Figma (header 3:10 / 3:200). Não mude nada: só rode o
> protocolo e me diga o que está diferente.

O agente roda `audit.mjs --base origin/main` (só as linhas do PR), mede com specs novas ou
existentes (`regress --only header`) e monta `pixel.mjs side` Figma | main | branch.

## 4. "Está pronto?"

> O card de produto está pixel perfect?

Resposta esperada: a tabela de camadas com números, não "parece igual". Se alguma camada não
rodou (sem acesso ao Figma, sem dev server), o relatório diz qual e por quê.

## 5. Sem acesso ao Figma pelo MCP

> O MCP não abre o arquivo (assento View). O protótipo está aberto no browser do app.
> Confira a landing contra ele.

O agente segue o §5.1: capturas do protótipo → `figref.mjs stitch` (confere a altura do frame),
`sections` por seção, `texts` contra os nós extraídos, `sample` para as cores. Critério: `texts`
com 0 FALHA. Veja `examples/03-landing-sem-mcp`.

## 6. Trocar imagem por vídeo / adicionar blur

> Troque a foto do hero por este vídeo (hero.mov) e coloque o glass do Figma no header.

O agente converte o vídeo (MP4 faststart + WebM + poster), aplica `muted playsInline`,
`preload="metadata"`, marca o header com `data-fx="glass-header"` e **propõe** a entrada em
`perf/tradeoffs.json` com `why`, `maxInViewport` e `reviewBy`, medindo com `perf.mjs ab`.
A decisão de manter o efeito fica com design + front.

## 7. Vários agentes em paralelo

> Implemente as 4 seções da home em paralelo, um agente por seção.

Cada agente recebe `references/agent-brief.md`: porta própria de dev server, sem git, edita só o
seu escopo, mesmo formato de relatório.

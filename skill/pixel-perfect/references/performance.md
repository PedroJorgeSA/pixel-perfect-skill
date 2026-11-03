# Camadas de custo (A · T · C · deploy)

As camadas 1–4 respondem "está igual ao Figma?". Estas respondem "quanto isso custa para quem
abre pelo celular, e alguém aceitou esse custo?".

```
1 tokens → A assets → 2 estilos → 3 pixels → T trade-offs → C custo → 4 olhar → (CI) → preview
   estático   estático   browser     browser    browser       browser    humano
```

A camada **T fica entre a fidelidade e o custo**: ela não mede, ela confere se cada efeito caro
tem uma decisão registrada e se a decisão está sendo cumprida.

## Vídeo no lugar de imagem

| Regra | Por quê | Quem checa |
|---|---|---|
| `poster` obrigatório, no enquadramento do 1º frame | O poster é o candidato a LCP e o que aparece no 4G lento | T e A |
| `muted` + `playsInline` + `autoPlay` juntos | Sem `muted` o browser bloqueia o autoplay; sem `playsInline` o iOS abre em tela cheia | T e A |
| `preload="metadata"` na dobra e `"none"` abaixo (sem `src` até entrar na tela) | `preload="auto"` baixa o arquivo inteiro antes de qualquer interação | T (`video-offscreen-bytes`) |
| MP4 com faststart (moov antes de mdat) e/ou WebM; nunca .mov nem GIF | Sem faststart o 1º frame espera o fim do download | A |
| Variante mobile (≈ 720p, ~1 Mbps) e desktop (1080p) escolhidas no servidor | `<source media>` não é confiável; o mobile não deve pagar o arquivo desktop | T (`video-oversized`) |
| `prefers-reduced-motion` → fica no poster e não baixa | Acessibilidade e bateria | T (`video-reduced-motion`) |
| Pausar fora da tela (IntersectionObserver) | Loop fora da tela gasta CPU e bateria | revisão |
| Bytes antes da interação ≤ `maxBytesBeforeInteraction` | Mídia não tem orçamento próprio: só existe via trade-off aceito | C |

```bash
ffmpeg -i in.mov -c:v libx264 -crf 26 -preset slow -an -movflags +faststart -vf "scale=-2:720" hero-m.mp4
ffmpeg -i in.mov -c:v libvpx-vp9 -crf 34 -b:v 0 -an -vf "scale=-2:1080" hero-d.webm
ffmpeg -i in.mov -frames:v 1 -q:v 4 hero-poster.jpg
```

## Registro de trade-offs (`perf/tradeoffs.json`)

```json
{ "id": "glass-header", "kind": "backdrop-filter", "match": "[data-fx=glass-header]",
  "decision": "keep", "maxInViewport": { "mobile": 3, "desktop": 7 },
  "costBudget": { "mobile": { "taskMs": 120, "longFramesPct": 10 } },
  "allowances": { "mobile": { "bytes.media": 1200000 } },
  "why": "identidade do header no Figma", "fallback": "fundo sólido 90%",
  "owner": "design + front", "reviewBy": "2027-03-31" }
```

- `decision`: `keep`, `off` ou `remove`, opcionalmente por perfil (`{ "mobile": "off", "desktop": "keep" }`).
- `maxInViewport`: quantos elementos com o efeito são aceitos no primeiro viewport (opacidade 0 não conta).
- `costBudget`: custo máximo aceito, medido com `perf.mjs ab` (diagnóstico; só reprova com `--gate`). **Limite**: o laboratório mede o main thread; o custo de GPU do `backdrop-filter` roda no compositor e não aparece no Chrome headless. Confirme com um trace num Android médio antes de concluir que é barato.
- `allowances`: folga no orçamento enquanto o efeito existir. É o único jeito de ter `bytes.media > 0`.
- `reviewBy`: depois dessa data o trade-off **reprova** e precisa ser reavaliado.
- `match` só com `[data-fx=<id>]`: seletor por classe casa efeitos novos sem decisão (já aconteceu: 8 blurs novos num grid "passaram" porque o seletor era `.card`). Ligue `strictSelectors: true` junto com a primeira entrada.
- **Governança**: CODEOWNERS (design + front) no registro. O agente não cria o efeito e a entrada no mesmo PR sem aprovação humana.

## Orçamento (`perf/budgets.json`)

- Perfis: mobile (CPU 4×, 150 ms RTT, 1,6 Mbps) e desktop (sem limite), nos tamanhos dos frames do Figma.
- O dev server distorce JS e CSS (sem bundle nem compressão): `lcpMs`, `bytes.script`, `bytes.total`, `requests` e `tbtMs` só valem com `--env build`. No dev valem efeitos, vídeo e bytes de imagem/mídia.
- LCP de vídeo precisa ser o **poster** (`video-lcp-frame`).
- `--runs 3` (mediana) no CI; uma rodada só serve para iteração local.
- O `perf.mjs` soma os bytes **antes** de varrer o DOM: medir caixas em seção com `content-visibility: auto` força layout e baixa fonte/imagem que o usuário não baixaria.
- Não afrouxe o orçamento para passar: reduza/priorize (tamanho servido × exibido, `fetchpriority`, preload) ou leve a decisão para design com o número na mão.

## Deploy (determinístico)

| Job | Quando | O que roda | Reprova se |
|---|---|---|---|
| static | todo PR | `audit --base`, `assets --base`, testes da skill, typecheck | erro de token/asset, teste quebrado |
| browser | depois do static | dev server + `regress` + `perf check --runs 3` | regressão de estilo, trade-off ou orçamento (INFRA vira aviso) |
| preview | manual, com a URL do preview | smoke + perf no build | orçamento no build real |

A auditoria com `--base` reprova só as **linhas alteradas** (ratchet): a dívida antiga aparece no
resumo mas não trava. `--all-lines` mostra tudo.

## Lacunas conhecidas

1. **CMS que publica sem PR**: imagem/vídeo enviado pelo admin não passa pelo CI. Precisa de validação no upload e de um `perf check` agendado contra produção.
2. **Vídeo**: HLS para vídeos longos, Save-Data, Low Power Mode do iOS, legendas.
3. **Dados reais**: `web-vitals`/CrUX. O laboratório só cobre o Chrome.

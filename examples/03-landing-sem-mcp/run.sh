#!/usr/bin/env bash
# Exemplo 03 — modo sem MCP: referência costurada do protótipo, diff por seção,
# tipografia nó a nó e amostragem de cor.  bash examples/03-landing-sem-mcp/run.sh
set -u
cd "$(dirname "$0")/../.."
E=examples/03-landing-sem-mcp
S=skill/pixel-perfect/scripts
PORT=4403
U="http://127.0.0.1:$PORT"
OUT=.pixel/sem-mcp
export PIXEL_CONFIG="$E/config.json"

node examples/serve.mjs "$E" "$PORT" >/dev/null &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
for _ in $(seq 1 50); do curl -sf "$U/site/" >/dev/null && break; sleep 0.1; done
step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

step "0 · capturas do protótipo (simuladas a partir do frame)"
node "$S/pixel.mjs" shot --url "$U/figma/frame.html" --width 1440 --out "$OUT/frame-1440.png" >/dev/null
node "$E/simular-prototipo.mjs" "$OUT/frame-1440.png" "$OUT/figma-tiles"

step "1 · stitch: costura + conferência da altura do frame"
node "$S/figref.mjs" stitch --dir "$OUT/figma-tiles" --out "$OUT/ref/page-800.png" --frame-width 1440 --frame-height 2060 \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(`referência ${r.size.width} × ${r.size.height} · escala ${r.scale} · Δ altura do frame ${r.heightDeltaFramePx}px (máx 8)`)})'

step "2 · site na mesma escala"
node "$S/pixel.mjs" shot --url "$U/site/" --width 1440 --out "$OUT/site-1440.png" >/dev/null
node "$S/figref.mjs" resize --in "$OUT/site-1440.png" --width 800 --out "$OUT/site-800.png" >/dev/null

step "3 · sections: diff por seção (retângulos do frame)"
node "$S/figref.mjs" sections --ref "$OUT/ref/page-800.png" --actual "$OUT/site-800.png" --spec "$E/docs/design/spec.json" --out "$OUT/sections"

step "4 · texts: tipografia do glifo × nó do Figma"
node "$S/figref.mjs" texts --url "$U/site/" --spec "$E/docs/design/text-nodes.json"

step "5 · sample: cor da referência → color style mais próximo"
node "$S/figref.mjs" sample --img "$OUT/ref/page-800.png" --points "1100,330;300,900;300,1300" --scale 0.5556

echo
echo "Abra $OUT/sections/*/compare.png e liste 3 diferenças (camada 4)."

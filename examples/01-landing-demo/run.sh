#!/usr/bin/env bash
# Exemplo 01 — roda as camadas 1 a 4 da skill contra a landing "Café Aurora".
#   bash examples/01-landing-demo/run.sh                 # versão com desvios (deve reprovar)
#   bash examples/01-landing-demo/run.sh site-corrigido  # versão corrigida (deve passar)
set -u
cd "$(dirname "$0")/../.."
SITE="${1:-site}"
E=examples/01-landing-demo
S=skill/pixel-perfect/scripts
PORT=4400
U="http://127.0.0.1:$PORT"
OUT=".pixel/demo/$SITE"
export PIXEL_CONFIG="$E/config.json"

node examples/serve.mjs "$E" "$PORT" >/dev/null &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
for _ in $(seq 1 50); do curl -sf "$U/$SITE/" >/dev/null && break; sleep 0.1; done

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
status=0

step "Camada 1 · tokens (audit.mjs)"
node "$S/audit.mjs" "$E/$SITE/styles.css" || status=1

step "Camada 2 · estilos computados (pixel.mjs styles)"
for spec in "$E"/specs/*.json; do
  echo "· $(basename "$spec")"
  node "$S/pixel.mjs" styles --spec "$spec" --url "$U/$SITE/" | grep -v '^  ok' || status=1
done

step "Camada 3 · diff de pixels (pixel.mjs shot + diff)"
node "$S/pixel.mjs" shot --url "$U/$SITE/" --width 1440 --selector "#hero" --out "$OUT/hero-1440.png" >/dev/null
node "$S/pixel.mjs" diff --ref "$E/figma/hero-1440.png" --actual "$OUT/hero-1440.png" --out "$OUT/diff" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(`mismatch ${r.mismatchPct}% (máx ${r.maxPct}%) · ${r.pass?"passa":"reprova"}`);r.notes.forEach(n=>console.log("· "+n))})' \
  || status=1

step "Camada 4 · olhar (abra e liste 3 diferenças)"
echo "Figma | site | diff → $OUT/diff/compare.png"

echo
if [ "$status" = 0 ]; then echo "✅ $SITE: todas as camadas passaram"; else echo "❌ $SITE: há divergências do Figma (esperado na versão com desvios)"; fi
exit $status

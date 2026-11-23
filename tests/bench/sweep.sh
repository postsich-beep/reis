#!/bin/bash
# Підбір налаштувань хмари: кожен варіант — на всіх сценаріях і трьох поїздках; менша середня з гіроскопом — краще
cd "$(dirname "$0")/../.."
for o in "$@"; do
  r=$(BENCH_SEEDS=7,11,23 DR_ALGO=pf DR_OPTS="$o" node tests/bench/drbench.mjs --quiet 2>&1 | tail -2 | tr '\n' ' ')
  echo "$o → $r"
done

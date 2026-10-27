#!/bin/bash
# usage: drive.sh <model> <runs> <arms...>
cd "$(dirname "$0")"
model=$1; runs=$2; shift 2
for r in $(seq 1 $runs); do
  for arm in "$@"; do
    python3 run.py "$arm" "$model-$r" "$model" > "results/$arm-$model-$r.log" 2>&1 &
  done
  wait
done
echo DONE

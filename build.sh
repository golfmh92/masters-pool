#!/bin/bash
set -e

mkdir -p dist

sed \
  -e "s|__SUPA_URL__|${SUPA_URL}|g" \
  -e "s|__SUPA_KEY__|${SUPA_KEY}|g" \
  index.html > dist/index.html

echo "Build complete: dist/index.html"

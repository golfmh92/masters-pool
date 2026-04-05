#!/bin/bash
set -e

mkdir -p dist

sed \
  -e "s|__SUPA_URL__|${SUPA_URL}|g" \
  -e "s|__SUPA_KEY__|${SUPA_KEY}|g" \
  index.html > dist/index.html

cp sw.js dist/sw.js
sed \
  -e "s|__SUPA_URL__|${SUPA_URL}|g" \
  -e "s|__SUPA_KEY__|${SUPA_KEY}|g" \
  draft.html > dist/draft.html
cp "The Masters Pool Logo.png" dist/

echo "Build complete: dist/index.html + sw.js"

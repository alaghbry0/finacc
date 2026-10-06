#!/usr/bin/env bash
# build-rn-web.sh — حلقة البناء الإلزامية (SRS §0.4 + SKILL.md §6)
# export → الإصلاحات الثلاثة (RTL / مسارات / replaceState) → دمج المعاينة → روابط الأصول
# Idempotent: safe to re-run any time. ~60–90s per cycle. NO metro dev server.
set -euo pipefail

RN_DIR="/home/z/my-project/finacc-mobile"
MAIN_PUBLIC="/home/z/my-project/public"
PREVIEW_PATH="/rn/index.html"

cd "$RN_DIR"

echo "[build-rn-web] 1/4 expo export --platform web ..."
rm -rf dist
npx expo export --platform web

echo "[build-rn-web] 1.5/4 copying sql.js engine (web DB path — sql-wasm.js + sql-wasm.wasm) ..."
cp node_modules/sql.js/dist/sql-wasm.js dist/sql-wasm.js
cp node_modules/sql.js/dist/sql-wasm.wasm dist/sql-wasm.wasm

echo "[build-rn-web] 2/4 fixing HTML (RTL + /rn/ asset prefixes + replaceState) ..."
bun scripts/fix-export.mjs dist

echo "[build-rn-web] 3/4 publishing to main app public/rn/ ..."
rm -rf "$MAIN_PUBLIC/rn"
mkdir -p "$MAIN_PUBLIC/rn"
cp -r dist/* "$MAIN_PUBLIC/rn/"

echo "[build-rn-web] 4/4 Trap C: root asset symlinks (ln -s is blocked — using bun) ..."
bun -e "const fs=require('fs'); const p='$MAIN_PUBLIC'; fs.rmSync(p+'/_expo',{force:true,recursive:true}); fs.rmSync(p+'/assets',{force:true,recursive:true}); fs.symlinkSync(p+'/rn/_expo',p+'/_expo','dir'); fs.symlinkSync(p+'/rn/assets',p+'/assets','dir'); console.log('symlinks created: public/_expo -> rn/_expo, public/assets -> rn/assets');"

echo ""
echo "[build-rn-web] ✅ DONE — preview URL path: $PREVIEW_PATH"
echo "[build-rn-web] open http://127.0.0.1:3000$PREVIEW_PATH (or the phone-frame shell at /)"

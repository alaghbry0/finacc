#!/usr/bin/env bun
/**
 * fix-export.mjs — post-export HTML fixes for the /rn/ preview mount.
 * Implements SKILL.md §6 Traps A + B (and the RTL fix from SRS 0.4):
 *
 *  (RTL) every emitted .html gets dir="rtl" lang="ar" on <html>
 *  (Trap A) root-absolute asset URLs /_expo/... and /assets/... are rewritten
 *           to /rn/_expo/... and /rn/assets/... (src= and href=, both quotes)
 *  (Trap B) dist/index.html ONLY: <script>history.replaceState(null,"","/")</script>
 *           injected immediately BEFORE the first <script src=".../_expo/...">
 *
 * Usage: bun scripts/fix-export.mjs [distDir]
 * Idempotent: safe to re-run.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const distDir = process.argv[2] || 'dist';

function walkHtml(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkHtml(full));
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

if (!existsSync(distDir)) {
  console.error(`[fix-export] dist dir not found: ${distDir}`);
  process.exit(1);
}

const files = walkHtml(distDir);
let rtlFixed = 0;
let pathsFixed = 0;

for (const file of files) {
  const original = readFileSync(file, 'utf8');
  let html = original;
  let changed = false;

  // --- RTL document: ensure dir="rtl" lang="ar" on the <html> tag ---
  const rtlized = html.replace(/<html\b([^>]*)>/i, (_m, attrs) => {
    let a = String(attrs);
    a = a.replace(/\s+dir="[^"]*"/i, '');
    a = a.replace(/\s+lang="[^"]*"/i, '');
    return `<html${a} dir="rtl" lang="ar">`;
  });
  if (rtlized !== html) {
    html = rtlized;
    changed = true;
    rtlFixed++;
  }

  // --- Trap A: rewrite root-absolute asset URLs to the /rn/ prefix ---
  const rewritten = html
    .replace(/(src|href)=(["'])\/_expo\//g, '$1=$2/rn/_expo/')
    .replace(/(src|href)=(["'])\/assets\//g, '$1=$2/rn/assets/');
  if (rewritten !== html) {
    html = rewritten;
    changed = true;
    pathsFixed++;
  }

  if (changed) writeFileSync(file, html);
}

// --- Trap B: history.replaceState in index.html ONLY ---
const indexPath = join(distDir, 'index.html');
// NOTE: a bare `try{...}` without catch is a SYNTAX ERROR — the script never
// runs and the failure is silent (zero console errors). catch(e){} is mandatory.
const INJECT = '<script>try{history.replaceState(null,"","/")}catch(e){}</script>\n';
let trapB = 'not needed (already injected)';
if (existsSync(indexPath)) {
  let html = readFileSync(indexPath, 'utf8');
  // strip any previous (possibly malformed) replaceState injection first → idempotent
  html = html.replace(/<script>try\{history\.replaceState[^<]*<\/script>\n?/g, '');
  if (html.includes('history.replaceState')) {
    trapB = 'already present';
  } else {
    const m = html.match(/<script\b[^>]*src=(["'])[^"']*\/_expo\/[^"']*\1[^>]*>/i);
    if (m && m.index !== undefined) {
      html = html.slice(0, m.index) + INJECT + html.slice(m.index);
      writeFileSync(indexPath, html);
      trapB = 'injected before first _expo script';
    } else {
      trapB = 'ERROR: no _expo script tag found';
      console.error('[fix-export] Trap B failed: no <script src=".../_expo/..."> in index.html');
      process.exit(1);
    }
  }
} else {
  console.error('[fix-export] index.html not found in dist');
  process.exit(1);
}

console.log(
  `[fix-export] ${files.length} html file(s) processed — rtl fixed: ${rtlFixed}, asset paths fixed: ${pathsFixed}, Trap B: ${trapB}`
);

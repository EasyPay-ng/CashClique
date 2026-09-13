#!/usr/bin/env node
/*
 * Syntax check for the pieces this repo ships as source (no build step):
 *   - inline <script> blocks in the HTML pages
 *   - the ES modules under js/
 *   - the Cloud Functions CommonJS sources
 *
 * Usage: node tools/check-syntax.mjs [file ...]
 * Without arguments every HTML page and JS source in the repo is checked.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "assets"]);

const args = process.argv.slice(2);
const targets = args.length
    ? args.map((file) => resolve(ROOT, file))
    : collectTargets(ROOT);

function collectTargets(dir, found = []) {
    for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            collectTargets(full, found);
            continue;
        }
        if (/\.(html|js|mjs)$/i.test(entry)) found.push(full);
    }
    return found.sort();
}

function scriptBlocks(source) {
    const blocks = [];
    const openPattern = /<script\b([^>]*)>/gi;
    let match;
    while ((match = openPattern.exec(source)) !== null) {
        const attributes = match[1] || "";
        const bodyStart = match.index + match[0].length;
        const rest = source.slice(bodyStart);

        // Prefer a closing tag on its own line: a script body may legitimately
        // contain the text "</script>" inside a string, and a missing closing
        // tag should swallow the rest of the document rather than stop early.
        const ownLine = rest.search(/\n[ \t]*<\/script>/i);
        const inline = rest.search(/<\/script>/i);
        const cut = ownLine !== -1 ? ownLine : inline;
        if (cut === -1) {
            blocks.push({ isModule: false, body: rest, index: lineOf(source, match.index), unterminated: true });
            break;
        }
        const body = rest.slice(0, cut);
        const closing = rest.slice(cut).match(/<\/script>/i);
        openPattern.lastIndex = bodyStart + cut + (closing ? closing.index + closing[0].length : 0);

        if (/\bsrc\s*=/i.test(attributes)) continue; // external file, checked on its own
        if (!body.trim()) continue;
        blocks.push({
            isModule: /type\s*=\s*["']?module/i.test(attributes),
            body,
            index: lineOf(source, match.index)
        });
    }
    return blocks;
}

function lineOf(source, offset) {
    return source.slice(0, offset).split("\n").length;
}

const workspace = mkdtempSync(join(tmpdir(), "cashclique-syntax-"));
const failures = [];
let checked = 0;

function check(label, code, asModule) {
    const file = join(workspace, "check-" + String(checked).padStart(3, "0") + (asModule ? ".mjs" : ".cjs"));
    writeFileSync(file, code, "utf8");
    checked += 1;
    try {
        execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
        console.log("  ok    " + label);
    } catch (error) {
        const output = String((error.stderr && error.stderr.toString()) || error.message)
            .split("\n")
            .filter((line) => line.trim() && !line.includes("at "))
            .slice(0, 6)
            .join("\n        ");
        failures.push(label);
        console.log("  FAIL  " + label + "\n        " + output);
    }
}

console.log("Checking " + targets.length + " source file(s)\n");

for (const target of targets) {
    const label = relative(ROOT, target);
    const source = readFileSync(target, "utf8");

    if (extname(target).toLowerCase() === ".html") {
        const blocks = scriptBlocks(source);
        if (!blocks.length) {
            console.log("  skip  " + label + " (no inline scripts)");
            continue;
        }
        blocks.forEach((block, position) => {
            const blockLabel = label + " <script#" + (position + 1) + " line " + block.index + ">";
            if (block.unterminated) {
                failures.push(blockLabel);
                console.log("  FAIL  " + blockLabel + "\n        <script> block is never closed with </script>");
                return;
            }
            check(blockLabel, block.body, block.isModule);
        });
        continue;
    }

    // Everything under js/ and tests/ is an ES module; functions/ is CommonJS.
    const asModule = !/(^|[\\/])functions[\\/]/.test(target) && extname(target).toLowerCase() !== ".cjs";
    check(label, source, asModule);
}

rmSync(workspace, { recursive: true, force: true });

console.log("\n" + checked + " snippet(s) checked, " + failures.length + " failure(s)");
if (failures.length) {
    failures.forEach((label) => console.log("  - " + label));
    process.exit(1);
}

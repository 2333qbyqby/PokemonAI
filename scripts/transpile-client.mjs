#!/usr/bin/env node
import {createRequire} from 'node:module';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const clientRoot = resolve(root, 'apps/showdown-client');
let ts;
for (const candidate of [
	'typescript',
	'/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript',
	'/usr/local/lib/node_modules/typescript',
]) {
	try {
		ts = require(candidate);
		break;
	} catch {}
}
if (!ts) throw new Error('TypeScript is required (local dependency or global installation)');

const entries = process.argv.length > 2 ? process.argv.slice(2) : [
	'pokemonai-config.ts',
	'pokemonai.ts',
	'panel-mainmenu.tsx',
];
for (const entry of entries) {
	const sourcePath = resolve(clientRoot, 'play.pokemonshowdown.com/src', entry);
	if (!existsSync(sourcePath)) throw new Error(`Missing source: ${sourcePath}`);
	const outputName = entry.replace(/\.tsx?$/, '.js');
	const outputPath = resolve(clientRoot, 'play.pokemonshowdown.com/js', outputName);
	const result = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
		compilerOptions: {
			target: ts.ScriptTarget.ES2018,
			module: ts.ModuleKind.ESNext,
			jsx: ts.JsxEmit.React,
			jsxFactory: 'preact.h',
			jsxFragmentFactory: 'preact.Fragment',
			useDefineForClassFields: false,
			removeComments: true,
		},
		fileName: sourcePath,
		reportDiagnostics: true,
	});
	const errors = (result.diagnostics || []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
	if (errors.length) {
		const details = errors.map(diagnostic => {
			const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
			if (!diagnostic.file || diagnostic.start === undefined) return message;
			const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
			return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1}: ${message}`;
		}).join('\n');
		throw new Error(`TypeScript transpile diagnostics for ${entry}:\n${details}`);
	}
	let output = result.outputText;
	// The upstream browser build intentionally removes modules because all client files
	// are loaded in a shared global scope. Mirror that behaviour for offline/cloud checks.
	output = output.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
	output = output.replace(/^import\s+['"][^'"]+['"];?\s*$/gm, '');
	output = output.replace(/^export\s+(?=(class|function|const|let|var|interface|type)\b)/gm, '');
	output = output.replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
	mkdirSync(dirname(outputPath), {recursive: true});
	writeFileSync(outputPath, `"use strict";\n${output}`, 'utf8');
	console.log(`${entry} -> ${outputName}`);
}

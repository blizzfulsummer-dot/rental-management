import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(projectRoot, 'public', 'public');
const outputDirectory = path.join(projectRoot, 'dist');

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });
cpSync(sourceDirectory, outputDirectory, { recursive: true });

console.log(`Frontend assets copied from ${path.relative(projectRoot, sourceDirectory)} to a clean ${path.relative(projectRoot, outputDirectory)} directory.`);

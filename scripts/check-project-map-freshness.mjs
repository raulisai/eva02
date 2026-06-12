#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const projectMapPath = join(root, '.agents/skills/eva-project-seed/references/project-map.md');
const migrationsDir = join(root, 'supabase/migrations');
const coreControllersDir = join(root, 'apps/eva-core/src');

const projectMap = readFileSync(projectMapPath, 'utf8');

function fail(message) {
  console.error(`project-map freshness failed: ${message}`);
  process.exitCode = 1;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const migrations = readdirSync(migrationsDir)
  .filter((name) => /^\d{3}_.+\.sql$/.test(name))
  .sort();

const latest = migrations.at(-1);
if (!latest) {
  fail('no migration files found');
} else {
  const latestNumber = latest.slice(0, 3);
  if (!projectMap.includes(latestNumber)) {
    fail(`latest migration number ${latestNumber} is not mentioned in project-map.md`);
  }
}

for (const migration of migrations) {
  const stem = migration.replace(/\.sql$/, '');
  if (!projectMap.includes(stem)) {
    fail(`migration ${stem} is not mentioned in project-map.md`);
  }
}

const controllers = walk(coreControllersDir)
  .filter((file) => file.endsWith('.controller.ts'))
  .flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(/@Controller\(['"`]([^'"`)]*)['"`]\)/g)]
      .map((match) => ({ route: match[1] || '/', file }));
  });

for (const { route, file } of controllers) {
  if (route === '/') continue;
  if (!projectMap.includes(`/${route}`) && !projectMap.includes(`\`${route}`) && !projectMap.includes(route)) {
    fail(`controller route "${route}" from ${file.replace(root, '')} is not mentioned in project-map.md`);
  }
}

if (!process.exitCode) {
  console.log(`project-map freshness ok: ${migrations.length} migrations, ${controllers.length} controller routes`);
}

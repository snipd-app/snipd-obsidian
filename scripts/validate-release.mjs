import { existsSync, readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const version = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? manifest.version;

if (!/^\d+\.\d+\.\d+$/.test(version) || manifest.version !== version) {
  throw new Error(`Release tag ${version} must match manifest version ${manifest.version}`);
}

for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  if (!existsSync(file)) {
    throw new Error(`Missing release asset: ${file}`);
  }
}

console.log(`Release ${version}: main.js, manifest.json, and styles.css are ready`);

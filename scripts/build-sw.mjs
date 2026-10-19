import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const paths = ['index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
for (const name of await readdir('dist/assets')) paths.push(`assets/${name}`);
const hash = createHash('sha256');
for (const path of paths) hash.update(await readFile(`dist/${path}`));
const source = await readFile('public/sw.js', 'utf8');
hash.update(source);
await writeFile('dist/sw.js', source
  .replace("'tv-notifier-dev'", `'tv-notifier-${hash.digest('hex').slice(0, 12)}'`)
  .replace(/const SHELL = .*;/, `const SHELL = ${JSON.stringify(['./', ...paths.map(path => `./${path}`)])};`));

// R-REPO-01: the repository holds no symlink. A committed link (node_modules -> a path on one machine) replaces a
// developer's own folder with a broken link when the branch is checked out, and a link can point outside the tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('R-REPO-01: no symlink is committed, and node_modules is ignored as a file or a link, not only as a folder', () => {
  const listed = execFileSync('git', ['ls-files', '-s'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const links = listed.split('\n').filter((l) => l.startsWith('120000 ')).map((l) => l.split('\t')[1]);
  assert.deepEqual(links, [], 'symlinks in the index: ' + links.join(', '));
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(ignore.includes('node_modules'), '.gitignore names node_modules with no trailing slash (a slash matches only a folder)');
  assert.ok(!ignore.includes('node_modules/'));
});

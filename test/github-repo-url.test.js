import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeGitHubUrl, parseGitHubOwnerRepo } from '../js/github-repo-url.js';

test('parses a full https URL pasted into a field (the reported bug)', () => {
  assert.deepEqual(
    parseGitHubOwnerRepo('https://github.com/Pasztetus/School_Features_Rep.git'),
    { owner: 'Pasztetus', repo: 'School_Features_Rep' }
  );
});

test('parses URLs without .git, with www, http and no protocol', () => {
  assert.deepEqual(
    parseGitHubOwnerRepo('https://github.com/owner/repo'),
    { owner: 'owner', repo: 'repo' }
  );
  assert.deepEqual(
    parseGitHubOwnerRepo('http://www.github.com/owner/repo'),
    { owner: 'owner', repo: 'repo' }
  );
  assert.deepEqual(
    parseGitHubOwnerRepo('github.com/owner/repo'),
    { owner: 'owner', repo: 'repo' }
  );
});

test('cuts off extra path, query and fragment parts of the URL', () => {
  assert.deepEqual(
    parseGitHubOwnerRepo('https://github.com/owner/repo/tree/main/docs?tab=readme'),
    { owner: 'owner', repo: 'repo' }
  );
  assert.deepEqual(
    parseGitHubOwnerRepo('https://github.com/owner/repo#readme'),
    { owner: 'owner', repo: 'repo' }
  );
});

test('parses the ssh clone form git@github.com:owner/repo.git', () => {
  assert.deepEqual(
    parseGitHubOwnerRepo('git@github.com:owner/repo.git'),
    { owner: 'owner', repo: 'repo' }
  );
});

test('returns null for plain names and non-GitHub text', () => {
  assert.equal(parseGitHubOwnerRepo('Pasztetus'), null);
  assert.equal(parseGitHubOwnerRepo('School_Features_Rep'), null);
  assert.equal(parseGitHubOwnerRepo('https://gitlab.com/owner/repo'), null);
  assert.equal(parseGitHubOwnerRepo(''), null);
  assert.equal(parseGitHubOwnerRepo(null), null);
});

test('returns null when the link has no repository part', () => {
  assert.equal(parseGitHubOwnerRepo('https://github.com/owner'), null);
  assert.equal(parseGitHubOwnerRepo('https://github.com/'), null);
});

test('does not treat a different domain ending in github.com as GitHub', () => {
  assert.equal(parseGitHubOwnerRepo('https://notgithub.com/owner/repo'), null);
});

test('looksLikeGitHubUrl recognizes links only', () => {
  assert.equal(looksLikeGitHubUrl('https://github.com/a/b'), true);
  assert.equal(looksLikeGitHubUrl('git@github.com:a/b.git'), true);
  assert.equal(looksLikeGitHubUrl('just-a-repo-name'), false);
});

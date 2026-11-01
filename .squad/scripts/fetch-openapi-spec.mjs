import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_REPO = 'ExperienceQuality/xq-luthor';
const SPEC_DIR = 'openapi';
const SPEC_FILE = 'openapi.yaml';
const API_BASE = 'https://api.github.com';

const usage = `Usage: node .squad/scripts/fetch-openapi-spec.mjs <service> | --all | --list

Fetch OpenAPI contracts from the xq-luthor repository.

  <service>          service directory under openapi/ (e.g. exercise-service)
  --all              fetch every service that has an openapi.yaml
  --list             list available services and exit
  --out <dir>        output root relative to the repo root (default: openapi)
  --ref <ref>        branch, tag, or sha in the source repo (default: its default branch)
  --repo <owner/r>   source repo (default: ${DEFAULT_REPO}, or XQ_OPENAPI_REPO)

Auth: uses the gh CLI when installed, else GH_TOKEN/GITHUB_TOKEN, else an
unauthenticated request (public repos only).`;

function fail(msg) {
  console.error(`fetch-openapi-spec: ${msg}`);
  process.exit(1);
}

function isValidService(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.cwd();
  }
}

function hasGh() {
  try {
    execFileSync('gh', ['api', '--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ghApi(endpoint, { raw = false } = {}) {
  const args = ['api', endpoint];
  if (raw) args.push('-H', 'Accept: application/vnd.github.raw');
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return raw ? out : JSON.parse(out);
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    fail(`gh api ${endpoint} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

async function httpApi(endpoint, { raw = false, token } = {}) {
  const headers = {
    Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'xq-squad-fetch-openapi-spec',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/${endpoint}`, { headers });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    if (res.status === 404) fail(`not found: ${endpoint}`);
    if (res.status === 401 || res.status === 403) {
      fail(`GitHub API ${res.status} for ${endpoint} — install gh or set GH_TOKEN/GITHUB_TOKEN`);
    }
    fail(`GitHub API ${res.status} for ${endpoint}: ${body}`);
  }
  return raw ? res.text() : res.json();
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { out: 'openapi', ref: null, repo: process.env.XQ_OPENAPI_REPO || DEFAULT_REPO };
  let service = null;
  let all = false;
  let list = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') all = true;
    else if (a === '--list') list = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--ref') opts.ref = argv[++i];
    else if (a === '--repo') opts.repo = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log(usage);
      return;
    } else if (a.startsWith('--') || service) fail(`unexpected argument: ${a}`);
    else service = a;
  }
  if (!service && !all && !list) fail('no service given\n\n' + usage);
  if (all && service) fail('pass either <service> or --all, not both');
  if (opts.ref === undefined || opts.out === undefined || opts.repo === undefined) {
    fail('missing value for a flag');
  }
  if (service && !isValidService(service)) fail(`invalid service name: ${service}`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) fail(`invalid repo: ${opts.repo}`);
  if (path.isAbsolute(opts.out) || opts.out.split(/[\\/]+/).includes('..')) {
    fail(`--out must be a repo-relative path: ${opts.out}`);
  }

  const useGh = hasGh();
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
  const api = (ep, o) => (useGh ? ghApi(ep, o) : httpApi(ep, { ...o, token }));

  const ref = opts.ref || (await api(`repos/${opts.repo}`)).default_branch;
  const refPath = (p) => `repos/${opts.repo}/contents/${encodePath(p)}?ref=${encodeURIComponent(ref)}`;

  // Resolve once for provenance reporting.
  const sha = ((await api(`repos/${opts.repo}/commits/${encodeURIComponent(ref)}`)).sha || '').slice(0, 12);

  async function servicesWithSpec() {
    const entries = await api(refPath(SPEC_DIR));
    if (!Array.isArray(entries)) fail(`${SPEC_DIR}/ is not a directory at ref ${ref}`);
    const dirs = entries.filter((e) => e.type === 'dir' && isValidService(e.name));
    const found = [];
    for (const d of dirs) {
      const files = await api(refPath(`${SPEC_DIR}/${d.name}`));
      if (Array.isArray(files) && files.some((f) => f.type === 'file' && f.name === SPEC_FILE)) {
        found.push(d.name);
      }
    }
    return found;
  }

  if (list) {
    const names = await servicesWithSpec();
    for (const n of names) console.log(n);
    if (names.length === 0) console.error(`no ${SPEC_FILE} found under ${SPEC_DIR}/ at ${ref}`);
    return;
  }

  const services = all ? await servicesWithSpec() : [service];
  if (services.length === 0) fail(`no services with ${SPEC_FILE} at ref ${ref}`);

  const outRoot = path.join(repoRoot(), opts.out);
  for (const svc of services) {
    const specPath = `${SPEC_DIR}/${svc}/${SPEC_FILE}`;
    const text = await api(refPath(specPath), { raw: true });
    const dest = path.join(outRoot, svc, SPEC_FILE);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, text);
    console.log(`${svc}: ${path.relative(repoRoot(), dest)} (${opts.repo}@${sha})`);
  }
}

main().catch((err) => fail(err.message));

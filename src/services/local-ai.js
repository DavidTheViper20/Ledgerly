'use strict';

// Local AI runtime support: detects models installed under Ollama and
// LM Studio (whether or not their servers are running) and can start the
// matching server headlessly on first use so chat "just works".

const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIMES = {
  ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
};

const isEmbedding = (id) => /embed/i.test(id);

function ollamaBin() {
  for (const p of ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/usr/bin/ollama']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function lmsBin() {
  for (const p of [
    path.join(os.homedir(), '.lmstudio/bin/lms'),
    path.join(os.homedir(), '.cache/lm-studio/bin/lms'),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// GET <baseUrl>/models — null when the server isn't reachable, otherwise
// the list of model ids it serves (possibly empty).
async function listServerModels(baseUrl, timeoutMs = 1500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { signal: ctl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    return (json.data || []).map((m) => m.id);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Models on disk when the server is down. Ollama keeps manifests under
// ~/.ollama; for LM Studio `lms ls --json` gives the ids the server will
// actually use, with a filesystem scan as fallback.
function ollamaDiskModels() {
  try {
    const root = path.join(os.homedir(), '.ollama/models/manifests/registry.ollama.ai/library');
    return fs.readdirSync(root).flatMap((name) =>
      fs.readdirSync(path.join(root, name))
        .map((tag) => (tag === 'latest' ? name : `${name}:${tag}`)));
  } catch {
    return [];
  }
}

function lmstudioDiskModels() {
  const bin = lmsBin();
  if (bin) {
    try {
      const out = execFileSync(bin, ['ls', '--json'], { timeout: 8000 }).toString();
      const list = JSON.parse(out);
      return list.map((m) => m.modelKey || m.path || '').filter(Boolean);
    } catch { /* fall through to fs scan */ }
  }
  const ids = [];
  for (const root of [path.join(os.homedir(), '.lmstudio/models'), path.join(os.homedir(), '.cache/lm-studio/models')]) {
    try {
      for (const pub of fs.readdirSync(root)) {
        const pubDir = path.join(root, pub);
        if (!fs.statSync(pubDir).isDirectory()) continue;
        for (const repo of fs.readdirSync(pubDir)) {
          if (fs.statSync(path.join(pubDir, repo)).isDirectory()) ids.push(`${pub}/${repo}`);
        }
      }
    } catch { /* root missing */ }
  }
  return ids;
}

function runtimeInstalled(runtime) {
  if (runtime === 'ollama') return !!ollamaBin() || fs.existsSync(path.join(os.homedir(), '.ollama'));
  return !!lmsBin() || fs.existsSync('/Applications/LM Studio.app');
}

// Public: every chat-capable local model we can find, across both runtimes.
async function detect() {
  const models = [];
  for (const [runtime, info] of Object.entries(RUNTIMES)) {
    if (!runtimeInstalled(runtime)) continue;
    const live = await listServerModels(info.baseUrl);
    const ids = live !== null && live.length
      ? live
      : (runtime === 'ollama' ? ollamaDiskModels() : lmstudioDiskModels());
    for (const id of [...new Set(ids)]) {
      if (!isEmbedding(id)) {
        models.push({ id, runtime, runtimeLabel: info.label, baseUrl: info.baseUrl, serverRunning: live !== null });
      }
    }
  }
  return { models };
}

function startServer(runtime) {
  if (runtime === 'ollama') {
    const bin = ollamaBin();
    if (!bin) throw new Error('Ollama is not installed (could not find the ollama binary)');
    spawn(bin, ['serve'], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const bin = lmsBin();
  if (!bin) throw new Error('LM Studio CLI not found — open LM Studio once to install the "lms" command');
  spawn(bin, ['server', 'start'], { detached: true, stdio: 'ignore' }).unref();
}

// Public: make sure the server behind baseUrl is up, starting it headlessly
// if needed. The model itself is loaded on demand by the first request
// (both Ollama and LM Studio JIT-load models).
async function ensureRunning(baseUrl, onStatus) {
  if (await listServerModels(baseUrl, 1200) !== null) return true;
  const runtime = /:11434/.test(baseUrl) ? 'ollama' : 'lmstudio';
  onStatus?.(`Starting ${RUNTIMES[runtime].label}…`);
  startServer(runtime);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await listServerModels(baseUrl, 1200) !== null) return true;
  }
  throw new Error(`${RUNTIMES[runtime].label} server did not come up on ${baseUrl} — try starting it manually`);
}

// Public: pre-load the model with the configured context length where the
// runtime supports it. LM Studio: `lms load --context-length N`. Ollama
// JIT-loads on first request, so this is a no-op there.
async function ensureModelLoaded(baseUrl, model, contextLength, onStatus) {
  if (/:11434/.test(baseUrl)) return; // Ollama: loaded on first request
  try {
    const res = await fetch(baseUrl.replace(/\/v1\/?$/, '') + '/api/v0/models');
    if (!res.ok) return; // can't inspect state — let JIT loading handle it
    const entry = ((await res.json()).data || []).find((m) => m.id === model);
    if (!entry || entry.state === 'loaded') return;
  } catch {
    return;
  }
  const bin = lmsBin();
  if (!bin) return;
  onStatus?.(`Loading ${model}…`);
  await new Promise((resolve) => {
    execFile(bin, ['load', model, '--context-length', String(contextLength), '-y'],
      { timeout: 240000 }, () => resolve()); // on failure fall back to JIT load
  });
}

module.exports = { detect, ensureRunning, ensureModelLoaded, listServerModels, RUNTIMES };

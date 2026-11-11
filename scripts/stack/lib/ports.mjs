// Slot math for the Docker Compose test stack: the single place that knows the base host ports and how a
// slot shifts them. testing/teststack (bash) gets its values through `slots.mjs shell-env`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STACK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(STACK_DIR, '../..');
export const CONFIG_FILE = path.join(STACK_DIR, 'config.json');

let cached;
export function loadConfig(file = CONFIG_FILE) {
  if (file === CONFIG_FILE && cached) return cached;
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (file === CONFIG_FILE) cached = config;
  return config;
}

/** Validates a slot number (0 = the default stack, 1..maxSlot = isolated copies) and returns it as a number. */
export function parseSlot(value, config = loadConfig()) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`slot must be an integer 0..${config.maxSlot}, got '${value}'`);
  const slot = Number(text);
  if (slot > config.maxSlot) throw new Error(`slot ${slot} is out of range (0..${config.maxSlot})`);
  return slot;
}

/** Host ports of a slot, keyed by name (webapp, identity, ...): base + slotStride * slot. */
export function slotPorts(slot, config = loadConfig()) {
  const n = parseSlot(slot, config);
  return Object.fromEntries(Object.entries(config.ports).map(([name, p]) => [name, p.base + config.slotStride * n]));
}

/** Compose interpolation variables (WEBAPP_HOST_PORT=19080, ...) for a slot. */
export function slotPortEnv(slot, config = loadConfig()) {
  const ports = slotPorts(slot, config);
  return Object.fromEntries(Object.entries(config.ports).map(([name, p]) => [p.env, String(ports[name])]));
}

/** Everything that identifies a slot: compose project, state paths, image tag, ports and browser URLs. */
export function slotInfo(slot, config = loadConfig()) {
  const n = parseSlot(slot, config);
  const ports = slotPorts(n, config);
  const stateDir = n === 0 ? config.stateDir : `${config.stateDir}/slot-${n}`;
  return {
    slot: n,
    project: n === 0 ? config.project : `${config.project}-${n}`,
    stateDir,
    envFile: `${stateDir}/.env.teststack`,
    loaderConfig: n === 0 ? config.loaderConfig : `${stateDir}/teststack.json`,
    imageTag: n === 0 ? config.imageTag : `${config.imageTag}-${n}`,
    webappUrl: `http://localhost:${ports.webapp}`,
    identityUrl: `http://host.docker.internal:${ports.identity}`,
    dashboardUrl: `http://localhost:${ports.dashboard}`,
    ports,
  };
}

/** Strips // and /* *\/ comments outside strings (testing/teststack.json is JSONC, read by System.Text.Json). */
export function stripJsonComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * The loader config (testing/teststack.json) rewritten for a slot: its compose project and env file, and every
 * host port (Postgres, Redis, RabbitMQ and the readiness URLs) shifted to the slot's ports.
 */
export function slotLoaderConfig(baseConfig, slot, config = loadConfig()) {
  const info = slotInfo(slot, config);
  const offset = config.slotStride * info.slot;
  const basePorts = new Set(Object.values(config.ports).map(p => p.base));
  const shift = port => (basePorts.has(port) ? port + offset : port);
  const result = structuredClone(baseConfig);
  result.compose = { ...result.compose, project: info.project, envFile: info.envFile };
  for (const key of ['postgres', 'redis', 'rabbitMq']) {
    if (result[key]?.port) result[key].port = shift(result[key].port);
  }
  for (const service of result.services ?? []) {
    if (service.url) {
      service.url = service.url.replace(/\/\/(localhost|127\.0\.0\.1|host\.docker\.internal):(\d+)/,
        (_, host, port) => `//${host}:${shift(Number(port))}`);
    }
  }
  return result;
}

/** Writes the slot's loader config next to its env file and returns its repo-relative path. */
export function writeSlotLoaderConfig(slot, { root = REPO_ROOT, config = loadConfig() } = {}) {
  const info = slotInfo(slot, config);
  if (info.slot === 0) return info.loaderConfig;
  const base = JSON.parse(stripJsonComments(fs.readFileSync(path.join(root, config.loaderConfig), 'utf8')));
  const target = path.join(root, info.loaderConfig);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const text = `${JSON.stringify(slotLoaderConfig(base, info.slot, config), null, 2)}\n`;
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) fs.writeFileSync(target, text);
  return info.loaderConfig;
}

/** KEY=VALUE lines that testing/teststack reads (values never contain newlines). */
export function shellEnv(slot, config = loadConfig()) {
  const info = slotInfo(slot, config);
  const annotation = JSON.stringify({ slot: info.slot, project: info.project, webappUrl: info.webappUrl, identityUrl: info.identityUrl, ports: info.ports });
  const lines = {
    SLOT: info.slot,
    PROJECT: info.project,
    STATE_DIR: info.stateDir,
    ENV_FILE: info.envFile,
    LOADER_CONFIG: info.loaderConfig,
    IMAGE_TAG: info.imageTag,
    WEBAPP_URL: info.webappUrl,
    SLOT_JSON: annotation.slice(1, -1),
    ...Object.fromEntries(Object.entries(slotPortEnv(info.slot, config)).map(([k, v]) => [`PORT_${k}`, v])),
  };
  return Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n');
}

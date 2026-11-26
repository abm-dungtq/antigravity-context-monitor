import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DetailItem } from '../shared/types.js';
import { estimateTokens } from './tokenizer.js';
import { getDefaultAppDataDir } from './transcript.js';

export interface ScannerPluginInput {
  name: string;
  dir: string;
  disabled: boolean;
  skills?: Array<{ name: string }>;
  agents?: Array<{ name: string }>;
  rules?: Array<{ absolutePath: string }>;
  mcpServers?: Array<{ name: string }>;
}

export interface ScannedSkill {
  name: string;
  description: string;
  path: string;
  realPath: string;
  group: string;
  indexTokens: number;
  fullTokens: number;
  bodyTokens: number;
  chars: number;
}

export interface RawWorkspaceScan {
  memoryFiles: DetailItem[];
  skills: ScannedSkill[];
  customAgents: DetailItem[];
  mcpInstructions: DetailItem[];
  mcpTools: DetailItem[];
}

interface ScanCacheEntry {
  expiresAt: number;
  value: RawWorkspaceScan;
}

const SCAN_CACHE_TTL_MS = 5_000;
const scanCache = new Map<string, ScanCacheEntry>();

const BUILTIN_SUBAGENTS: Array<{ name: string; description: string }> = [
  {
    name: 'self',
    description:
      'Subagent that inherits the parent agent full configuration including tools, system prompt, and model.',
  },
  {
    name: 'research',
    description:
      'Research subagent with read-only tools for exploring the codebase, searching the web, and reading files.',
  },
  {
    name: 'browser',
    description:
      'Browser subagent that operates a built-in webview browser to navigate and interact with live web pages.',
  },
  {
    name: 'image-generator',
    description: 'Generates or edits images from a brief and replies with the saved file paths.',
  },
];

interface EnabledPlugin {
  name: string;
  dirPath: string;
  rules?: Array<{ absolutePath: string }>;
  mcpServers?: Array<{ name: string }>;
}

function safeRealpath(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function safeReadText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function safeReaddir(dirPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function extractYamlScalarOrBlock(block: string, fieldName: string): string | undefined {
  const lines = block.split(/\r?\n/);
  const keyRe = new RegExp(`^${fieldName}:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(keyRe);
    if (!m) continue;
    const inlineVal = m[1].trim();
    if (inlineVal === '>' || inlineVal === '>-' || inlineVal === '|' || inlineVal === '|-') {
      const collected: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === '') {
          collected.push('');
          continue;
        }
        if (/^\s+/.test(line)) {
          collected.push(line.trim());
        } else {
          break;
        }
      }
      const joined = collected.join(' ').replace(/\s+/g, ' ').trim();
      return joined || undefined;
    }
    const unquoted = inlineVal.replace(/^["']|["']$/g, '').trim();
    return unquoted || undefined;
  }
  return undefined;
}

function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
  frontmatterRaw?: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }
  const block = match[1];
  return {
    name: extractYamlScalarOrBlock(block, 'name'),
    description: extractYamlScalarOrBlock(block, 'description'),
    frontmatterRaw: block,
  };
}

function resolveEnabledPlugins(
  configDir: string,
  lsPlugins?: ScannerPluginInput[]
): EnabledPlugin[] {
  const pluginsRoot = path.join(configDir, 'plugins');

  if (Array.isArray(lsPlugins)) {
    const enabled: EnabledPlugin[] = [];
    for (const p of lsPlugins) {
      if (p.disabled) continue;
      const dirPath = path.isAbsolute(p.dir)
        ? p.dir
        : path.join(pluginsRoot, p.dir);
      enabled.push({
        name: p.name,
        dirPath,
        rules: p.rules,
        mcpServers: p.mcpServers,
      });
    }
    return enabled;
  }

  // Read-only scan of config.json: ONLY read `plugins` map, NEVER userSettings/secrets
  const configJson = safeReadJson(path.join(configDir, 'config.json'));
  const pluginsMap =
    configJson?.plugins && typeof configJson.plugins === 'object'
      ? (configJson.plugins as Record<string, Record<string, unknown>>)
      : {};

  const enabled: EnabledPlugin[] = [];
  const entries = safeReaddir(pluginsRoot);
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dirName = entry.name;
    const dirPath = path.join(pluginsRoot, dirName);
    const configEntry = pluginsMap[dirName];
    if (configEntry && configEntry.enabled === false) {
      continue;
    }
    const pluginJson = safeReadJson(path.join(dirPath, 'plugin.json'));
    if (pluginJson && pluginJson.disabled === true) {
      continue;
    }
    const pluginName =
      typeof pluginJson?.name === 'string' && pluginJson.name.trim()
        ? pluginJson.name.trim()
        : dirName;
    enabled.push({ name: pluginName, dirPath });
  }
  return enabled;
}

function addMemoryFile(
  filePath: string,
  group: string,
  seenPaths: Set<string>,
  out: DetailItem[]
): void {
  if (!fs.existsSync(filePath)) return;
  const realPath = safeRealpath(filePath);
  if (seenPaths.has(realPath)) return;
  const content = safeReadText(realPath);
  if (content === null) return;
  seenPaths.add(realPath);

  out.push({
    name: path.basename(filePath),
    sublabel: group,
    path: realPath,
    tokens: estimateTokens(content, 'prose'),
    chars: content.length,
    status: 'active',
    group,
  });
}

function scanSkillsInDir(
  skillsParentDir: string,
  group: string,
  seenPaths: Set<string>,
  out: ScannedSkill[]
): void {
  for (const entry of safeReaddir(skillsParentDir)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillMdPath = path.join(skillsParentDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    const realPath = safeRealpath(skillMdPath);
    if (seenPaths.has(realPath)) continue;

    const content = safeReadText(realPath);
    if (content === null) continue;
    seenPaths.add(realPath);

    const fm = parseFrontmatter(content);
    const name = fm.name || entry.name;
    const description = fm.description || '';
    const indexText = description
      ? `- ${name} (${skillMdPath}): ${description}`
      : `- ${name} (${skillMdPath})`;
    const indexTokens = estimateTokens(indexText, 'prose');
    const fullTokens = estimateTokens(content, 'prose');
    const bodyTokens = Math.max(0, fullTokens - indexTokens);

    out.push({
      name,
      description,
      path: realPath,
      realPath,
      group,
      indexTokens,
      fullTokens,
      bodyTokens,
      chars: content.length,
    });
  }
}

function scanCustomAgentsInDir(
  agentsDir: string,
  group: string,
  seenPaths: Set<string>,
  seenNames: Set<string>,
  out: DetailItem[]
): void {
  for (const entry of safeReaddir(agentsDir)) {
    let mdPath: string | null = null;
    let fallbackName = entry.name;

    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const candidate = path.join(agentsDir, entry.name, 'agent.md');
      if (fs.existsSync(candidate)) {
        mdPath = candidate;
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      mdPath = path.join(agentsDir, entry.name);
      fallbackName = entry.name.replace(/\.md$/i, '');
    }

    if (!mdPath) continue;
    const realPath = safeRealpath(mdPath);
    if (seenPaths.has(realPath)) continue;
    const content = safeReadText(realPath);
    if (content === null) continue;

    seenPaths.add(realPath);
    const fm = parseFrontmatter(content);
    const name = fm.name || fallbackName;
    seenNames.add(name);

    const descriptorText = fm.description
      ? `${name}: ${fm.description}`
      : fm.frontmatterRaw || content.slice(0, 320);

    out.push({
      name,
      sublabel: group,
      path: realPath,
      tokens: estimateTokens(descriptorText, 'prose'),
      chars: content.length,
      status: 'active',
      group,
    });
  }
}

function readMcpServerKeys(mcpConfigPath: string): string[] {
  const json = safeReadJson(mcpConfigPath);
  const servers = json?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  // Only return enabled server names; never read env, headers, args, or tokens
  const keys: string[] = [];
  for (const [key, val] of Object.entries(servers as Record<string, unknown>)) {
    if (val && typeof val === 'object') {
      const cfg = val as Record<string, unknown>;
      if (cfg.disabled === true || cfg.enabled === false) {
        continue;
      }
    }
    keys.push(key);
  }
  return keys;
}

/**
 * Scans Antigravity global config, enabled plugins, MCP descriptors, and optional
 * workspace rules/skills with a 5-second TTL cache.
 */
export function scanWorkspaceContext(opts?: {
  appDataDir?: string;
  configDir?: string;
  workspacePath?: string;
  lsPlugins?: ScannerPluginInput[];
}): RawWorkspaceScan {
  const appDataDir = opts?.appDataDir || getDefaultAppDataDir();
  const configDir =
    opts?.configDir ||
    process.env.ANTIGRAVITY_CONFIG_DIR ||
    path.join(os.homedir(), '.gemini', 'config');
  const workspacePath = opts?.workspacePath
    ? path.resolve(opts.workspacePath)
    : '';
  const lsSig = opts?.lsPlugins
    ? opts.lsPlugins
        .map((p) => `${p.dir}:${p.disabled ? 0 : 1}`)
        .sort()
        .join(',')
    : 'disk';

  const cacheKey = `${appDataDir}|${configDir}|${workspacePath}|${lsSig}`;
  const now = Date.now();
  const cached = scanCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const enabledPlugins = resolveEnabledPlugins(configDir, opts?.lsPlugins);

  // 1. Memory files
  const memoryFiles: DetailItem[] = [];
  const seenMemory = new Set<string>();
  const geminiRootDir = path.dirname(configDir);
  addMemoryFile(path.join(geminiRootDir, 'GEMINI.md'), 'user', seenMemory, memoryFiles);
  addMemoryFile(path.join(configDir, 'GEMINI.md'), 'config', seenMemory, memoryFiles);

  for (const plugin of enabledPlugins) {
    if (Array.isArray(plugin.rules)) {
      for (const r of plugin.rules) {
        if (r.absolutePath) {
          addMemoryFile(r.absolutePath, `plugin:${plugin.name}`, seenMemory, memoryFiles);
        }
      }
    }
    const rulesDir = path.join(plugin.dirPath, 'rules');
    for (const entry of safeReaddir(rulesDir)) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        addMemoryFile(
          path.join(rulesDir, entry.name),
          `plugin:${plugin.name}`,
          seenMemory,
          memoryFiles
        );
      }
    }
  }

  if (workspacePath) {
    addMemoryFile(path.join(workspacePath, 'GEMINI.md'), 'workspace', seenMemory, memoryFiles);
    addMemoryFile(path.join(workspacePath, 'AGENTS.md'), 'workspace', seenMemory, memoryFiles);
    const wsRulesDir = path.join(workspacePath, '.agents', 'rules');
    for (const entry of safeReaddir(wsRulesDir)) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        addMemoryFile(
          path.join(wsRulesDir, entry.name),
          'workspace',
          seenMemory,
          memoryFiles
        );
      }
    }
  }

  // 2. Skills (index vs deferred body)
  const skills: ScannedSkill[] = [];
  const seenSkills = new Set<string>();
  scanSkillsInDir(path.join(appDataDir, 'builtin', 'skills'), 'builtin', seenSkills, skills);
  scanSkillsInDir(path.join(configDir, 'skills'), 'global', seenSkills, skills);
  for (const plugin of enabledPlugins) {
    scanSkillsInDir(
      path.join(plugin.dirPath, 'skills'),
      `plugin:${plugin.name}`,
      seenSkills,
      skills
    );
  }
  if (workspacePath) {
    scanSkillsInDir(
      path.join(workspacePath, '.agents', 'skills'),
      'workspace',
      seenSkills,
      skills
    );
  }

  // 3. Custom agents
  const customAgents: DetailItem[] = [];
  const seenAgentPaths = new Set<string>();
  const seenAgentNames = new Set<string>();
  scanCustomAgentsInDir(
    path.join(configDir, 'agents'),
    'global',
    seenAgentPaths,
    seenAgentNames,
    customAgents
  );
  for (const plugin of enabledPlugins) {
    scanCustomAgentsInDir(
      path.join(plugin.dirPath, 'agents'),
      `plugin:${plugin.name}`,
      seenAgentPaths,
      seenAgentNames,
      customAgents
    );
  }
  for (const builtin of BUILTIN_SUBAGENTS) {
    if (!seenAgentNames.has(builtin.name)) {
      customAgents.push({
        name: builtin.name,
        sublabel: 'builtin',
        tokens: estimateTokens(`${builtin.name}: ${builtin.description}`, 'prose'),
        chars: builtin.description.length,
        status: 'active',
        group: 'builtin',
      });
    }
  }

  // 4. MCP servers (mcp_instructions + mcp_deferred_tools)
  const mcpServerCandidates = new Map<string, string[]>();
  const registerServer = (displayKey: string, folderCandidates: string[]) => {
    if (!mcpServerCandidates.has(displayKey)) {
      mcpServerCandidates.set(displayKey, folderCandidates);
    }
  };

  for (const key of readMcpServerKeys(path.join(configDir, 'mcp_config.json'))) {
    registerServer(key, [key]);
  }
  for (const key of readMcpServerKeys(path.join(appDataDir, 'mcp_config.json'))) {
    registerServer(key, [key]);
  }
  for (const plugin of enabledPlugins) {
    const names = Array.isArray(plugin.mcpServers)
      ? plugin.mcpServers.map((s) => s.name)
      : readMcpServerKeys(path.join(plugin.dirPath, 'mcp_config.json'));
    for (const key of names) {
      const namespaced = key.startsWith(`${plugin.name}_`)
        ? key
        : `${plugin.name}_${key}`;
      registerServer(namespaced, [namespaced, key]);
    }
  }

  const mcpRoot = path.join(appDataDir, 'mcp');
  const mcpInstructions: DetailItem[] = [];
  const mcpTools: DetailItem[] = [];
  const seenMcpFolders = new Set<string>();

  for (const [serverKey, candidates] of mcpServerCandidates.entries()) {
    let matchedFolder: string | null = null;
    for (const candidate of candidates) {
      const candidatePath = path.join(mcpRoot, candidate);
      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
        const realFolder = safeRealpath(candidatePath);
        if (!seenMcpFolders.has(realFolder)) {
          seenMcpFolders.add(realFolder);
          matchedFolder = candidatePath;
        }
        break;
      }
    }

    if (!matchedFolder) continue;

    const entries = safeReaddir(matchedFolder);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(matchedFolder, entry.name);
      if (entry.name === 'instructions.md') {
        const content = safeReadText(fullPath);
        if (content !== null) {
          mcpInstructions.push({
            name: `${serverKey}/instructions.md`,
            sublabel: serverKey,
            path: safeRealpath(fullPath),
            tokens: estimateTokens(content, 'prose'),
            chars: content.length,
            status: 'eager',
            group: serverKey,
          });
        }
      } else if (entry.name.endsWith('.json')) {
        const content = safeReadText(fullPath);
        if (content !== null) {
          mcpTools.push({
            name: entry.name.replace(/\.json$/i, ''),
            sublabel: serverKey,
            path: safeRealpath(fullPath),
            tokens: estimateTokens(content, 'json'),
            chars: content.length,
            status: 'lazy',
            group: serverKey,
          });
        }
      }
    }
  }

  const result: RawWorkspaceScan = {
    memoryFiles,
    skills,
    customAgents,
    mcpInstructions,
    mcpTools,
  };

  scanCache.set(cacheKey, {
    expiresAt: now + SCAN_CACHE_TTL_MS,
    value: result,
  });

  return result;
}

export function clearScannerCache(): void {
  scanCache.clear();
}

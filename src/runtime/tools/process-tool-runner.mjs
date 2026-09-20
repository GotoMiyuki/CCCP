import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { ToolRunner } from './tool-runner.mjs';
import { canonicalRepository } from '../workspace/workspace-manager.mjs';
import { digest } from '../../audit.mjs';
import { check } from '../../contracts.mjs';
import { pathWithin, relativePath } from '../../authority.mjs';
import { jsonCopy, nonempty, validateContext, validateToolResult } from '../contracts.mjs';
import { requireRuntime } from '../errors.mjs';
import { effectSnapshot, executionOutcome } from './effect-reconciler.mjs';
import { agentFileDelta, captureAgentFiles } from '../agent-evidence.mjs';

const exec = promisify(execFile), key = Symbol('Docker preflight');
const positive = n => Number.isSafeInteger(n) && n > 0;
const labelKey = 'org.cccp.execution';

export class ProcessToolRunner extends ToolRunner {
  #docker; #context; #image; #namespace; #bindings; #runs = new Map();
  static async create({ docker = 'docker', context, image, namespace = 'cccp', bindings = {} }) {
    nonempty(namespace, 'namespace');
    requireRuntime(typeof image === 'string' && /^[^\s]+@sha256:[a-f0-9]{64}$/.test(image), 'UNPINNED_IMAGE', 'A local image pinned by repository digest is required');
    const call = async args => (await exec(docker, args, { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 })).stdout.trim();
    context ??= await call(['context', 'show']); nonempty(context, 'Docker context');
    const endpoint = JSON.parse(await call(['context', 'inspect', context]))[0].Endpoints.docker.Host;
    requireRuntime(/^(npipe|unix):\/\//.test(endpoint), 'UNSUPPORTED_CAPABILITY', 'Only a local Docker engine is supported');
    const info = JSON.parse(await call(['--context', context, 'info', '--format', '{{json .}}']));
    requireRuntime(info.OSType === 'linux' && info.SecurityOptions?.some(s => s.startsWith('name=seccomp')), 'UNSUPPORTED_CAPABILITY', 'Linux Docker with seccomp is required');
    const installed = JSON.parse(await call(['--context', context, 'image', 'inspect', image]))[0];
    requireRuntime(installed.Os === 'linux' && !Object.keys(installed.Config.Volumes ?? {}).length, 'UNSAFE_IMAGE', 'Linux image without implicit volumes required');
    for (const binding of Object.values(bindings)) {
      requireRuntime(Array.isArray(binding.argv) && binding.argv.length > 0 && binding.argv.every(s => typeof s === 'string' && !s.includes('\0')) && binding.argv[0].startsWith('/'), 'INVALID_TOOL_BINDING', 'A fixed absolute container executable and argv are required');
      requireRuntime(typeof binding.domain === 'string' && Array.isArray(binding.paths) && binding.paths.length > 0 && typeof binding.write === 'boolean', 'INVALID_TOOL_BINDING', 'Binding needs domain, paths and explicit write mode');
      if ('accepts_agent_input' in binding) requireRuntime(binding.accepts_agent_input === true, 'INVALID_TOOL_BINDING', 'accepts_agent_input must be explicitly true');
      for (const path of binding.paths) relativePath(path);
      for (const [name, value] of Object.entries(binding.environment ?? {})) requireRuntime(/^[A-Z_][A-Z0-9_]*$/.test(name) && !/(TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE_KEY|API_KEY)/i.test(name) && typeof value === 'string' && !value.includes('\0'), 'UNSAFE_ENVIRONMENT', 'Secret-like or invalid environment entries are refused');
      for (const value of Object.values(binding.limits ?? {})) requireRuntime(positive(value), 'INVALID_TOOL_BINDING', 'Limits must be positive integers');
    }
    return new ProcessToolRunner(key, { docker, context, image, namespace, bindings: jsonCopy(bindings) });
  }
  constructor(token, options) {
    super(); requireRuntime(token === key, 'INVALID_PROVIDER', 'Use ProcessToolRunner.create for engine preflight');
    this.#docker = options.docker; this.#context = options.context; this.#image = options.image; this.#namespace = options.namespace; this.#bindings = options.bindings;
  }
  async capabilities() { return { simulation: false, backend: 'docker', sandbox: 'docker', cancellation: true, recovery: true }; }
  #command(args) { return exec(this.#docker, ['--context', this.#context, ...args], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }); }
  #identity({ task_id, attempt_id, workspace }) { return digest([this.#namespace, workspace.repository_identity, task_id, attempt_id]); }
  async describeAttempt(input) { return { backend: 'docker', context: this.#context, identity: this.#identity(input), image: this.#image }; }
  async #container(identity) {
    try {
      const value = JSON.parse((await this.#command(['container', 'inspect', `cccp-${identity}`])).stdout)[0];
      requireRuntime(value.Config.Labels?.[labelKey] === identity, 'CONTAINER_OWNERSHIP_MISMATCH', 'Container does not belong to this execution');
      return value;
    } catch (error) {
      if (/No such (container|object):/i.test(error.stderr ?? '')) return null;
      throw error;
    }
  }
  async #stop(identity) {
    let container = await this.#container(identity);
    if (!container) return { stopped: true, absent: true, simulation: false };
    if (container.State.Running) {
      try { await this.#command(['container', 'kill', container.Id]); }
      catch (error) { if ((await this.#container(identity))?.State.Running) throw error; }
    }
    container = await this.#container(identity);
    return { stopped: !container?.State.Running, container_id: container?.Id ?? null, simulation: false };
  }
  async reconcile(input) {
    const descriptor = input.execution_binding;
    if (descriptor && (descriptor.backend !== 'docker' || descriptor.context !== this.#context || !/^[a-f0-9]{64}$/.test(descriptor.identity))) return { stopped: false, simulation: false, reason: 'execution_backend_changed' };
    const identity = descriptor?.identity ?? this.#identity(input);
    try {
      const result = await this.#stop(identity);
      if (result.stopped && !result.absent) await this.#command(['container', 'rm', `cccp-${identity}`]);
      return result;
    } catch { return { stopped: false, simulation: false, reason: 'container_state_unverified' }; }
  }
  async run(input) {
    const request = jsonCopy(input); validateContext(request.context); check('Operation', request.operation); check('Delegation', request.delegation); nonempty(request.attempt_id, 'attempt_id');
    const operation = request.operation, policy = request.policy;
    const binding = Object.hasOwn(this.#bindings, operation.id) ? this.#bindings[operation.id] : null;
    requireRuntime(binding && !operation.changes_decision && operation.domain === binding.domain && (operation.permission ?? null) === (binding.permission ?? null), 'INVALID_TOOL_BINDING', 'Operation does not match its host-installed binding');
    requireRuntime(!request.agent_input || binding.accepts_agent_input === true, 'INVALID_TOOL_BINDING', 'This tool binding does not accept Agent input');
    if (request.agent_input) { nonempty(request.agent_input.source_run_id, 'source_run_id'); requireRuntime(binding.write, 'INVALID_TOOL_BINDING', 'Agent input requires a writable binding'); }
    requireRuntime(!request.delegation.forbidden.includes(operation.domain), 'AUTHORITY_BOUNDARY_EXCEEDED', 'Domain is forbidden');
    requireRuntime(policy?.network === 'deny' && policy.enforced === true && policy.tool_allowlist?.includes(operation.id), 'INVALID_TOOL_POLICY', 'Enforced deny-network policy and tool allowlist required');
    const paths = [...new Set(binding.paths.map(relativePath))];
    requireRuntime(paths.every(path => operation.paths.some(root => pathWithin(path, root)) && request.delegation.paths.some(root => pathWithin(path, root)) && policy.filesystem_allowlist.some(root => pathWithin(path, root))), 'AUTHORITY_BOUNDARY_EXCEEDED', 'Tool binding exceeds authorized paths');
    requireRuntime(Object.keys(binding.environment ?? {}).every(name => policy.environment_allowlist.includes(name)), 'UNSAFE_ENVIRONMENT', 'Environment is not allowlisted');
    const repository = canonicalRepository(request.workspace.repository_identity);
    requireRuntime(request.workspace.task_id === request.context.task_id && request.workspace.workspace_ref === request.context.workspace_ref && repository === request.workspace.repository_identity && canonicalRepository(policy.cwd) === repository && !/[\r\n,]/.test(repository), 'REPOSITORY_MISMATCH', 'Cwd must be the registered canonical workspace');
    requireRuntime(!this.#runs.has(request.attempt_id), 'ATTEMPT_ALREADY_EXISTS', 'Attempt cannot be reused');
    const limit = (name, value) => { requireRuntime(positive(value), 'INVALID_TOOL_POLICY', `Invalid ${name}`); return Math.min(value, binding.limits?.[name] ?? value); };
    const limits = { timeout_ms: limit('timeout_ms', policy.timeout_ms), output_limit_bytes: limit('output_limit_bytes', policy.output_limit_bytes),
      memory_bytes: limit('memory_bytes', policy.resources.memory_bytes), cpu_ms: limit('cpu_ms', policy.resources.cpu_ms), file_size_bytes: limit('file_size_bytes', policy.resources.file_size_bytes) };
    const identity = this.#identity({ task_id: request.context.task_id, attempt_id: request.attempt_id, workspace: request.workspace });
    const run = { status: 'RUNNING', identity, request, interrupted: null, result: null, created: false };
    this.#runs.set(request.attempt_id, run);
    const started = new Date().toISOString(); let before, after = null, beforeAgent = null, fileDelta = null;
    let exitCode = null, stopped = false, stdout = '', stderr = '', failure = null;
    try {
      before = await effectSnapshot(repository, paths);
      if (request.agent_input) beforeAgent = await captureAgentFiles(repository, request.agent_input.file_changes);
      requireRuntime(!await this.#container(identity), 'ATTEMPT_ALREADY_EXISTS', 'Container from this attempt already exists; reconcile before continuing');
      const args = ['container', 'create', '--name', `cccp-${identity}`, '--label', `${labelKey}=${identity}`, '--read-only', '--network', 'none',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', String(limits.memory_bytes), '--memory-swap', String(limits.memory_bytes),
        '--cpus', '1', '--ulimit', `cpu=${Math.ceil(limits.cpu_ms / 1000)}`, '--ulimit', `fsize=${limits.file_size_bytes}`, '--ulimit', 'nofile=256:256',
        '--init', '--no-healthcheck', '--log-driver', 'none', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16777216', '--workdir', '/workspace', '--entrypoint', binding.argv[0]];
      if (request.agent_input) args.push('--interactive');
      // Mount only delegated subtrees, never the host repository root or .git.
      for (const path of paths.filter(path => !paths.some(other => other !== path && pathWithin(path, other)))) args.push('--mount', `type=bind,bind-recursive=disabled,src=${join(repository, path)},dst=/workspace/${path}${binding.write ? '' : ',readonly'}`);
      for (const [name, value] of Object.entries(binding.environment ?? {})) args.push('--env', `${name}=${value}`);
      args.push(this.#image, ...binding.argv.slice(1));
      if (!run.interrupted) {
        await this.#command(args); run.created = true;
        if (!run.interrupted) {
          // Inventory a second time immediately before start to detect host-side replacement.
          const checked = await effectSnapshot(repository, paths);
          requireRuntime(checked.fingerprint === before.fingerprint, 'UNSAFE_MOUNT', 'Mounted files changed before dispatch');
          if (!run.interrupted) {
            const output = await this.#attach(run, limits, request.agent_input); stdout = output.stdout; stderr = output.stderr;
          }
        }
      }
      const container = await this.#container(identity);
      exitCode = container && !container.State.Running ? container.State.ExitCode : null;
      if (container?.State.OOMKilled || exitCode >= 128) run.interrupted ??= 'resource_or_signal';
      stopped = (await this.#stop(identity)).stopped;
      after = await effectSnapshot(repository, paths);
      if (request.agent_input) fileDelta = agentFileDelta({ sourceRunId: request.agent_input.source_run_id, before: beforeAgent,
        after: await captureAgentFiles(repository, request.agent_input.file_changes, { requireExpected: true }) });
    } catch (error) { failure = error.code ?? 'TOOL_FAILED'; }
    finally {
      if (run.created) {
        try { stopped = (await this.#stop(identity)).stopped; if (stopped) await this.#command(['container', 'rm', `cccp-${identity}`]); }
        catch { stopped = false; }
      }
    }
    const outcome = failure ? 'EFFECT_UNKNOWN' : executionOutcome({ exitCode, interrupted: run.interrupted, stopped, before, after });
    const result = validateToolResult({ outcome, stdout, stderr, exit_code: exitCode, started_at: started, finished_at: new Date().toISOString(),
      repository_before: before ?? null, repository_after: after, interruption_reason: run.interrupted, error_code: failure, process_tree_stopped: stopped,
      execution: { backend: 'docker', identity, image: this.#image, paths, writable: binding.write, network: 'none', limits },
      ...(fileDelta ? { file_delta: fileDelta } : {}), simulation: false }, { allowReal: true });
    run.result = result; run.status = 'COMPLETED'; return result;
  }
  #attach(run, limits, agentInput) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#docker, ['--context', this.#context, 'container', 'start', '--attach', ...(agentInput ? ['--interactive'] : []), `cccp-${run.identity}`],
        { windowsHide: true, stdio: [agentInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      let size = 0, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), stopping = false;
      const stop = reason => {
        run.interrupted ??= reason;
        if (stopping) return; stopping = true;
        this.#stop(run.identity).catch(() => {}).finally(() => child.kill());
      };
      run.stop = stop;
      const timer = setTimeout(() => stop('timeout'), limits.timeout_ms);
      const collect = (kind, chunk) => {
        const kept = chunk.subarray(0, Math.max(0, limits.output_limit_bytes - size)); size += chunk.length;
        if (kind === 'stdout') stdout = Buffer.concat([stdout, kept]); else stderr = Buffer.concat([stderr, kept]);
        if (size > limits.output_limit_bytes) stop('output_limit');
      };
      child.stdout.on('data', chunk => collect('stdout', chunk)); child.stderr.on('data', chunk => collect('stderr', chunk));
      child.on('error', error => { clearTimeout(timer); run.stop = null; reject(error); });
      child.on('close', () => { clearTimeout(timer); run.stop = null; resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') }); });
      if (agentInput) child.stdin.end(JSON.stringify(agentInput));
      if (run.interrupted) stop(run.interrupted);
    });
  }
  async cancel(id) {
    const run = this.#runs.get(id); if (!run || run.status !== 'RUNNING') return false;
    run.interrupted ??= 'cancelled'; run.stop?.(run.interrupted); return true;
  }
  async inspect(id) {
    const run = this.#runs.get(id);
    return run ? jsonCopy({ status: run.status, result: run.result, identity: run.identity, simulation: false }) : null;
  }
}

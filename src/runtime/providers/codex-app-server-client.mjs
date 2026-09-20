import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { requireRuntime, RuntimeError } from '../errors.mjs';

const terminal = new Set(['completed', 'interrupted', 'failed']);

export class CodexAppServerClient {
  #command; #args; #spawn; #active = new Map();
  constructor({ command = 'codex', args = ['app-server', '--stdio'], spawnProcess = spawn } = {}) {
    this.#command = command; this.#args = [...args]; this.#spawn = spawnProcess;
  }
  start({ runId, prompt, cwd, model, outputSchema, sandbox = 'readOnly', timeoutMs = 120000, onBinding = async () => {} }) {
    requireRuntime(!this.#active.has(runId), 'RUN_ALREADY_EXISTS', 'App Server run ID cannot be reused');
    const child = this.#spawn(this.#command, this.#args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const state = { runId, child, threadId: null, turnId: null, status: 'RUNNING', stderr: '', lastMessage: '', usage: null, bindingPending: Promise.resolve() };
    this.#active.set(runId, state);
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    const result = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); this.#active.delete(runId);
        try { child.stdin.end(); } catch {}
        if (!child.killed) child.kill();
        if (error) reject(error); else resolve(value);
      };
      const fail = error => finish(error instanceof RuntimeError ? error : new RuntimeError('AGENT_FAILED', error.message || 'Codex App Server failed', { cause: error }));
      const timer = setTimeout(() => { state.status = 'INTERRUPTED'; state.terminationReason = 'timeout';
        if (state.threadId && state.turnId) send({ method: 'turn/interrupt', id: 90, params: { threadId: state.threadId, turnId: state.turnId } });
        setTimeout(() => fail(new RuntimeError('EXECUTION_INTERRUPTED', 'Codex App Server timed out')), 1000).unref();
      }, timeoutMs);
      child.stderr.on('data', chunk => { state.stderr = (state.stderr + chunk.toString('utf8')).slice(-65536); });
      child.on('error', fail);
      child.on('close', code => { if (!settled) fail(new RuntimeError('AGENT_FAILED', `Codex App Server exited before completion (${code})`)); });
      createInterface({ input: child.stdout }).on('line', async line => {
        let message; try { message = JSON.parse(line); } catch { return; }
        if (message.id === 0) {
          if (message.error) return fail(new RuntimeError('AGENT_FAILED', message.error.message));
          send({ method: 'initialized', params: {} });
          const legacySandbox = { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' }[sandbox] ?? sandbox;
          send({ method: 'thread/start', id: 1, params: { ...(model ? { model } : {}), cwd, approvalPolicy: 'never', sandbox: legacySandbox, serviceName: 'cccp-reference-runtime' } });
        } else if (message.id === 1) {
          if (message.error) return fail(new RuntimeError('AGENT_FAILED', message.error.message));
          state.threadId = message.result?.thread?.id;
          if (!state.threadId) return fail(new RuntimeError('AGENT_FAILED', 'App Server did not return a thread id'));
          try {
            state.bindingPending = state.bindingPending.then(() => onBinding({ backend: 'codex-app-server', pid: child.pid, run_id: runId, thread_id: state.threadId }));
            await state.bindingPending;
          }
          catch (error) { return fail(error); }
          send({ method: 'turn/start', id: 2, params: { threadId: state.threadId, input: [{ type: 'text', text: prompt }], cwd,
            approvalPolicy: 'never', sandboxPolicy: { type: sandbox }, ...(model ? { model } : {}), outputSchema } });
        } else if (message.id === 2) {
          if (message.error) return fail(new RuntimeError('AGENT_FAILED', message.error.message));
          state.turnId = message.result?.turn?.id;
          if (!state.turnId) return fail(new RuntimeError('AGENT_FAILED', 'App Server did not return a turn id'));
          try {
            state.bindingPending = state.bindingPending.then(() => onBinding({ backend: 'codex-app-server', pid: child.pid, run_id: runId, thread_id: state.threadId, turn_id: state.turnId }));
            await state.bindingPending;
          }
          catch (error) { return fail(error); }
        } else if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
          state.lastMessage = message.params.item.text ?? state.lastMessage;
        } else if (message.method === 'thread/tokenUsage/updated') state.usage = message.params;
        else if (message.method === 'turn/completed' && (!state.turnId || message.params?.turn?.id === state.turnId)) {
          const status = message.params?.turn?.status;
          if (!terminal.has(status)) return;
          state.status = status === 'completed' ? 'COMPLETED' : status === 'interrupted' ? 'INTERRUPTED' : 'FAILED';
          state.terminationReason = status;
          if (state.status !== 'COMPLETED') return fail(new RuntimeError(state.status === 'INTERRUPTED' ? 'EXECUTION_INTERRUPTED' : 'AGENT_FAILED', message.params?.turn?.error?.message ?? `Agent ${status}`));
          try { await state.bindingPending; finish(null, { output: JSON.parse(state.lastMessage), thread_id: state.threadId, turn_id: state.turnId, usage: state.usage }); }
          catch (cause) { fail(new RuntimeError('INVALID_RUNTIME_CONTRACT', 'Agent final message was not schema JSON', { cause })); }
        } else if (message.id !== undefined && message.method) {
          send({ id: message.id, error: { code: -32001, message: 'CCCP Host denies unconfigured server requests' } });
        }
      });
      send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'cccp_reference_runtime', title: 'CCCP Reference Runtime', version: '0.2.0' } } });
    });
    return { binding: Object.freeze({ backend: 'codex-app-server', pid: child.pid, run_id: runId }), result };
  }
  async cancel(runId) {
    const state = this.#active.get(runId); if (!state) return false;
    state.status = 'INTERRUPTED'; state.terminationReason = 'cancelled';
    if (state.threadId && state.turnId) state.child.stdin.write(`${JSON.stringify({ method: 'turn/interrupt', id: 91, params: { threadId: state.threadId, turnId: state.turnId } })}\n`);
    else state.child.kill(); return true;
  }
  inspect(runId) {
    const state = this.#active.get(runId);
    return state ? { status: state.status, thread_id: state.threadId, turn_id: state.turnId, simulation: false } : null;
  }
}

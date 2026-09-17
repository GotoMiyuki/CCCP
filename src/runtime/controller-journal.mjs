import { randomUUID } from 'node:crypto';
import { AuditLog, canonical } from '../audit.mjs';
import { DecisionLifecycle } from '../decision.mjs';
import { ExecutionLifecycle } from '../lifecycle.mjs';
import { executionSession } from '../execution-session.mjs';
import { jsonCopy } from './contracts.mjs';
import { requireRuntime } from './errors.mjs';

const methods = ['observe', 'plan', 'begin', 'checkOperation', 'report', 'applyReview', 'route', 'accept', 'block', 'resume', 'override', 'requestReplan'];
// Optional undefined object fields are omitted exactly as for protocol JSON.
const serializable = value => JSON.parse(JSON.stringify(value));

// This is a trusted Host facility, not an API accepting approval JSON from messages.
// Recovery re-executes guards; it never assigns Controller private fields/state.
export function controllerJournal({ payload, principal, checkpoint = null }) {
  let replaying = checkpoint !== null, auditIndex = 0, idIndex = 0, activeIds = [], replayIds = [], depth = 0;
  const commands = [];
  if (checkpoint) {
    requireRuntime(checkpoint.version === 1 && AuditLog.verify(checkpoint.audit), 'CORRUPT_RECOVERY', 'Invalid journal version or audit chain');
    payload = checkpoint.payload; principal = checkpoint.principal;
  }
  const approvalTime = checkpoint?.approval_time ?? new Date().toISOString();
  const audit = new AuditLog({ clock: () => {
    if (!replaying) return new Date().toISOString();
    const entry = checkpoint.audit[auditIndex++];
    requireRuntime(entry, 'CORRUPT_RECOVERY', 'Replay produced unexpected audit entries'); return entry.timestamp;
  } });
  const decision = DecisionLifecycle.directed({ ...payload, actor: principal, audit, clock: () => approvalTime });
  const controller = new ExecutionLifecycle({ decision, audit, idFactory: () => {
    const id = replaying ? replayIds[idIndex++] : randomUUID();
    requireRuntime(typeof id === 'string' && id.length > 0, 'CORRUPT_RECOVERY', 'Missing deterministic identifier'); activeIds.push(id); return id;
  } });
  for (const method of methods) {
    const original = controller[method];
    Object.defineProperty(controller, method, { value: function (...args) {
      if (depth) return original.apply(controller, args);
      depth++; activeIds = []; const before = controller.snapshot.state_version; let errorCode = null;
      try { return original.apply(controller, args); }
      catch (error) { errorCode = error.code ?? error.name; throw error; }
      finally {
        depth--;
        commands.push(jsonCopy({ method, args: serializable(args), ids: activeIds, before_version: before,
          after_version: controller.snapshot.state_version, error_code: errorCode, audit_offset: audit.entries.length }));
      }
    } });
  }
  if (checkpoint) {
    for (const command of checkpoint.commands) {
      requireRuntime(methods.includes(command.method), 'CORRUPT_RECOVERY', 'Unknown replay command');
      replayIds = command.ids; idIndex = 0;
      try { controller[command.method](...command.args); }
      catch (error) { requireRuntime((error.code ?? error.name) === command.error_code, 'CORRUPT_RECOVERY', 'Replay guard outcome differs'); }
      requireRuntime(canonical(commands.at(-1)) === canonical(command), 'CORRUPT_RECOVERY', 'Replay state/version/command differs');
    }
    requireRuntime(canonical(audit.entries) === canonical(checkpoint.audit), 'CORRUPT_RECOVERY', 'Replay audit differs from committed history');
    replaying = false;
    const session = executionSession(controller);
    session.attempted = new Set(checkpoint.session.attempted); session.discoveryOptions = jsonCopy(checkpoint.session.discoveryOptions); session.busy = false;
  }
  return {
    controller, approval: decision.snapshot,
    export() {
      const session = executionSession(controller);
      return jsonCopy({ version: 1, payload, principal, approval_time: approvalTime, commands, audit: audit.entries,
        session: { attempted: [...session.attempted], discoveryOptions: session.discoveryOptions } });
    },
  };
}

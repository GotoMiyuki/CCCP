import { immutable } from '../contracts.mjs';
import { PORT_METHODS, RUNTIME_CONTRACT_VERSION, validatePort, validateCapabilities } from './contracts.mjs';
import { requireRuntime } from './errors.mjs';

export async function capabilityManifest(providers, requiredCapabilities = []) {
  requireRuntime(Array.isArray(requiredCapabilities) && requiredCapabilities.every(k => typeof k === 'string'), 'INVALID_RUNTIME_CONTRACT', 'requiredCapabilities must be names');
  const provider_capabilities = {};
  for (const name of Object.keys(PORT_METHODS)) {
    validatePort(name, providers[name]);
    provider_capabilities[name] = validateCapabilities(await providers[name].capabilities());
  }
  const pc = provider_capabilities;
  const durable = pc.state.durable === true;
  const capabilities = {
    durable_state: durable, crash_recovery: durable && pc.state.recovery === true && pc.identity.durable === true && pc.evidence.durable === true,
    real_agents: false, os_sandbox: pc.tool.sandbox === 'docker' && pc.tool.simulation === false,
    independent_r3: false, cross_process_leases: pc.workspace.cross_process === true,
    simulated_cancellation: pc.agent.cancellation === true && pc.tool.cancellation === true && pc.tool.simulation,
    tool_cancellation: pc.tool.cancellation === true,
  };
  if (capabilities.crash_recovery) requireRuntime(['recover', 'acquireTask', 'pending'].every(method => typeof providers.state[method] === 'function'), 'INVALID_PROVIDER', 'Recovery methods required');
  if (capabilities.os_sandbox) requireRuntime(['describeAttempt', 'reconcile'].every(method => typeof providers.tool[method] === 'function'), 'INVALID_PROVIDER', 'Real tools must persist execution identity and reconcile orphaned processes');
  requireRuntime(requiredCapabilities.every(k => Object.hasOwn(capabilities, k) && capabilities[k] === true), 'UNSUPPORTED_CAPABILITY', 'Required capability is unknown or unavailable');
  return immutable({ protocol_versions: ['1.0'], runtime_version: '0.2.0-dev', contract_version: RUNTIME_CONTRACT_VERSION,
    storage_schema_version: durable ? 'sqlite-1' : 'memory-1', simulation: pc.agent.simulation || pc.tool.simulation, capabilities, provider_capabilities });
}

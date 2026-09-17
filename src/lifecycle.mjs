import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { assert, check, immutable } from './contracts.mjs';
import { requireRole, authorize, pathWithin } from './authority.mjs';
import { AuditLog, digest } from './audit.mjs';
import { DecisionLifecycle } from './decision.mjs';
import { validateReview, assessReview, routeReview } from './review.mjs';
import { executionSession } from './execution-session.mjs';

const controllerActor = { id: 'lifecycle-controller', role: 'codex' };
const REVIEW_STATE = { R1: 'VERIFYING', R2: 'SPEC_REVIEW', R3: 'ARCHITECTURE_REVIEW' };
// `resolve()` is lexical: on macOS it treats /var and /private/var as different
// strings even though they identify the same directory. Discovery returns a
// real path, so compare repository identities after canonicalizing existing paths.
const repositoryIdentity = path => {
  const absolute = resolve(path);
  try { return realpathSync.native?.(absolute) ?? realpathSync(absolute); }
  catch (error) { if (error.code === 'ENOENT') return absolute; throw error; }
};

export class ExecutionLifecycle {
  #state = 'DISCOVERY'; #approval; #audit; #discovery; #plan; #report; #implementer;
  #reviews = {}; #revisionCount = 0; #failures = new Map(); #progress = new Set();
  #blockedFrom; #block; #proposal; #routing; #usedReports = new Set(); #appliedReviews = new Set();
  #revisionPending = false;
  #blocks = new Map(); #humanStopped = false; #version = 0;
  constructor({ decision, audit = new AuditLog() }) {
    this.#approval = this.#approved(decision); this.#audit = audit;
    audit.append('EXECUTION_CREATED', controllerActor, { decision: this.#approval });
  }
  #approved(decision) {
    assert(decision instanceof DecisionLifecycle && decision.state === 'DELEGATED', 'DECISION_NOT_READY', 'Execution requires a Human-approved Decision, Specification and Delegation');
    return decision.snapshot;
  }
  get state() { return this.#state; }
  get snapshot() { return immutable({ state: this.#state, state_version: this.#version, decision_id: this.#approval.decision.id, specification_id: this.#approval.specification.id,
    revision_count: this.#revisionCount, discovery: this.#discovery ?? null, plan: this.#plan ?? null, report: this.#report ?? null,
    reviews: this.#reviews, routing: this.#routing ?? null, blocked: this.#block ?? null, blocked_reports: [...this.#blocks.values()], human_stopped: this.#humanStopped, change_proposal: this.#proposal ?? null }); }
  get audit() { return this.#audit.entries; }
  get specification() { return this.#approval.specification; }
  get profile() { return this.#approval.profile; }
  get delegation() { return this.#approval.delegation; }
  #at(...states) { assert(states.includes(this.#state), 'INVALID_TRANSITION', `Execution is ${this.#state}; expected ${states.join(' / ')}`); }
  #idle() { assert(!executionSession(this).busy, 'OPERATION_IN_PROGRESS', 'Wait for the in-flight adapter operation to settle'); }
  #clearBlocks() { this.#block = undefined; this.#blocks.clear(); this.#humanStopped = false; }
  #move(state, actor, data = {}) { this.#audit.append('EXECUTION_TRANSITION', actor, { from: this.#state, to: state, ...data }); this.#state = state; this.#version++; }
  #blocked(actor, category, reason, evidence = []) {
    if (this.#state !== 'BLOCKED') this.#blockedFrom = this.#state;
    this.#block = immutable({ id: randomUUID(), category, reason, evidence, required_resolution: 'Resolve the reported cause within existing authority, or obtain a new Human Decision / Delegation' });
    this.#blocks.set(category, this.#block);
    this.#move('BLOCKED', actor, { report: this.#block });
  }
  #change(actor, problem, evidence = []) {
    this.#proposal = immutable({ id: randomUUID(), decision_id: this.#approval.decision.id, problem,
      suggested_change: 'Human deliberation is required before choosing or authorizing a boundary-crossing change', trade_offs: [], affected_boundaries: ['Decision / Delegation'], evidence });
    this.#audit.append('CHANGE_PROPOSAL', actor, this.#proposal);
  }
  block(actor, category, reason, evidence = []) {
    requireRole(actor, 'human', 'codex', 'chatgpt');
    check('BlockedReport', { id: 'validation', category, reason, evidence, required_resolution: 'Resolve cause' });
    if (category === 'AUTHORITY_BOUNDARY_EXCEEDED') this.#change(actor, reason, evidence);
    this.#blocked(actor, category, reason, evidence);
  }
  observe(actor, discovery) {
    requireRole(actor, 'codex'); this.#at('DISCOVERY', 'REVISION'); check('Discovery', discovery);
    assert(repositoryIdentity(discovery.repository.path) === repositoryIdentity(this.profile.repository), 'REPOSITORY_MISMATCH', 'Discovery must target Project Profile repository');
    this.#discovery = immutable(discovery); this.#version++; this.#audit.append('DISCOVERY_REPORT', actor, discovery);
  }
  checkOperation(actor, operation) {
    requireRole(actor, 'codex'); this.#at('DISCOVERY', 'IMPLEMENTATION_PLANNED', 'IMPLEMENTING', 'REVISION');
    if (this.#state === 'IMPLEMENTING') assert(actor.id === this.#implementer, 'AUTHORITY_BOUNDARY_EXCEEDED', 'Only the active implementer may execute this plan');
    let result;
    try { result = authorize(operation, this.delegation, this.profile); }
    catch (error) {
      if (error.code !== 'INVALID_PATH') throw error;
      result = { allowed: false, reason: error.message };
    }
    this.#audit.append('OPERATION_AUTHORIZATION', actor, { operation, result });
    if (!result.allowed) { this.#change(actor, result.reason, [operation.description]); this.#blocked(actor, 'AUTHORITY_BOUNDARY_EXCEEDED', result.reason); }
    return result;
  }
  plan(actor, { summary, operations }) {
    requireRole(actor, 'codex'); this.#at('DISCOVERY', 'IMPLEMENTATION_PLANNED', 'REVISION');
    this.#idle();
    assert(this.#discovery, 'DISCOVERY_REQUIRED', 'Repository discovery is required before planning');
    assert(typeof summary === 'string' && summary.trim() && Array.isArray(operations) && operations.length > 0, 'INVALID_PLAN', 'Plan requires summary and operations');
    operations.forEach(o => check('Operation', o));
    assert(new Set(operations.map(o => o.id)).size === operations.length, 'INVALID_PLAN', 'Operation IDs must be unique');
    for (const operation of operations) if (!this.checkOperation(actor, operation).allowed) return;
    this.#plan = immutable({ summary, operations });
    if (this.#state !== 'REVISION') this.#move('IMPLEMENTATION_PLANNED', actor, { plan: this.#plan });
    else { this.#version++; this.#audit.append('IMPLEMENTATION_PLAN_UPDATED', actor, { plan: this.#plan }); }
  }
  begin(actor, { fingerprint, progress } = {}) {
    requireRole(actor, 'codex'); this.#at('IMPLEMENTATION_PLANNED', 'REVISION');
    assert(this.#plan, 'INVALID_PLAN', 'Plan is required');
    if (fingerprint !== this.#discovery.fingerprint) {
      this.#blocked(actor, 'REPOSITORY_FAILURE', 'Repository changed since discovery; rediscovery is required'); return;
    }
    if (this.#revisionPending) {
      if (this.#revisionCount >= this.profile.review.max_revision_attempts) {
        this.#blocked(actor, 'LOOP_PROTECTION', 'Revision budget exhausted'); return;
      }
      if (typeof progress !== 'string' || !progress.trim() || this.#progress.has(progress.trim())) {
        this.#blocked(actor, 'LOOP_PROTECTION', 'Revision must add new information, state or explanation'); return;
      }
      this.#progress.add(progress.trim()); this.#revisionCount++;
    }
    this.#revisionPending = false;
    this.#implementer = actor.id; this.#reviews = {}; this.#routing = undefined;
    this.#move('IMPLEMENTING', actor, { progress: progress ?? null });
  }
  report(actor, report) {
    requireRole(actor, 'codex'); this.#at('IMPLEMENTING'); check('ImplementationReport', report);
    this.#idle();
    assert(actor.id === this.#implementer, 'AUTHORITY_BOUNDARY_EXCEEDED', 'Only the active implementer may submit its report');
    assert(report.specification_id === this.specification.id && report.discovery_fingerprint === this.#discovery.fingerprint, 'REFERENCE_MISMATCH', 'Report must refer to active Specification and Discovery');
    assert(!this.#usedReports.has(report.id), 'DUPLICATE_REPORT', 'Implementation report IDs cannot be reused');
    const plannedPaths = this.#plan.operations.flatMap(o => o.paths);
    let outside;
    try { outside = report.changed_files.some(p => !this.delegation.paths.some(root => pathWithin(p, root)) || !plannedPaths.some(root => pathWithin(p, root))); }
    catch (error) { if (error.code !== 'INVALID_PATH') throw error; outside = true; }
    if (outside) {
      this.#change(actor, 'Reported changes exceed delegated or planned paths', report.changed_files);
      this.#blocked(actor, 'AUTHORITY_BOUNDARY_EXCEEDED', 'Reported changes exceed delegated or planned paths'); return;
    }
    this.#report = immutable(report); this.#usedReports.add(report.id); this.#move('VERIFYING', actor, { report });
  }
  applyReview(actor, review) {
    assert(this.#report, 'REPORT_REQUIRED', 'Review requires an implementation report');
    const judgment = validateReview(actor, review, this.#report, this.specification, this.#implementer);
    this.#at(REVIEW_STATE[judgment.review_level]);
    assert(!this.#appliedReviews.has(judgment.id), 'DUPLICATE_REVIEW', 'Review ID has already been applied');
    this.#reviews[judgment.review_level] = judgment; this.#appliedReviews.add(judgment.id);
    const assessment = assessReview(judgment, this.specification);
    this.#audit.append('REVIEW_JUDGMENT', actor, { review: judgment, assessment });
    switch (assessment.outcome) {
      case 'BOUNDARY':
        this.#change(actor, assessment.reason, judgment.evidence); this.#blocked(actor, 'AUTHORITY_BOUNDARY_EXCEEDED', assessment.reason, judgment.evidence); break;
      case 'BLOCKED': this.#blocked(actor, judgment.review_level === 'R2' ? 'SPECIFICATION_FAILURE' : 'MISSING_INFORMATION', assessment.reason, judgment.evidence); break;
      case 'REPLAN_RECOMMENDED': this.#change(actor, assessment.reason, judgment.evidence); this.#move('REPLAN_PROPOSED', controllerActor, { review_id: judgment.id }); break;
      case 'REVISION_RECOMMENDED': {
        const signature = judgment.failure_signature ?? digest({ level: judgment.review_level, findings: judgment.findings, failed_requirements: judgment.failed_requirements, reason: judgment.reason });
        const count = (this.#failures.get(signature) ?? 0) + 1; this.#failures.set(signature, count);
        if (this.#revisionCount >= this.profile.review.max_revision_attempts || count >= this.profile.review.repeated_failure_limit) {
          this.#blocked(actor, 'LOOP_PROTECTION', 'Revision budget exhausted or failure repeated', [signature]);
        } else { this.#revisionPending = true; this.#move('REVISION', controllerActor, { review_id: judgment.id, failure_signature: signature }); }
        break;
      }
      case 'APPROVE':
        if (judgment.review_level === 'R1') this.#move('SPEC_REVIEW', controllerActor);
        else if (judgment.review_level === 'R2') this.#move('REVIEW_ROUTING', controllerActor);
        else this.#move(this.profile.review.human_acceptance ? 'HUMAN_ACCEPTANCE' : 'DONE', controllerActor);
        break;
    }
  }
  route(actor) {
    requireRole(actor, 'codex', 'human'); this.#at('REVIEW_ROUTING');
    this.#routing = routeReview({ profile: this.profile, report: this.#report, discovery: this.#discovery, r2: this.#reviews.R2, operations: this.#plan.operations });
    this.#move(this.#routing.required ? 'ARCHITECTURE_REVIEW' : 'DONE', controllerActor, { routing: this.#routing });
    return this.#routing;
  }
  accept(actor, reason) {
    requireRole(actor, 'human'); this.#at('HUMAN_ACCEPTANCE');
    assert(typeof reason === 'string' && reason.trim(), 'MISSING_INFORMATION', 'Human acceptance requires an explicit statement');
    this.#move('DONE', actor, { acceptance: reason });
  }
  requestReplan(actor, proposal) {
    requireRole(actor, 'codex', 'chatgpt', 'human'); check('ChangeProposal', proposal);
    if (this.#humanStopped) requireRole(actor, 'human');
    this.#at('DISCOVERY', 'IMPLEMENTATION_PLANNED', 'IMPLEMENTING', 'VERIFYING', 'SPEC_REVIEW', 'REVIEW_ROUTING', 'ARCHITECTURE_REVIEW', 'REVISION', 'BLOCKED');
    assert(proposal.decision_id === this.#approval.decision.id, 'REFERENCE_MISMATCH', 'Replan must reference current Decision');
    this.#proposal = immutable(proposal); this.#audit.append('CHANGE_PROPOSAL', actor, proposal);
    this.#move('REPLAN_PROPOSED', controllerActor);
  }
  resume(actor, { resolution, discovery } = {}) {
    requireRole(actor, 'human', 'codex'); this.#at('BLOCKED');
    this.#idle();
    if (this.#humanStopped) requireRole(actor, 'human');
    assert(typeof resolution === 'string' && resolution.trim(), 'MISSING_INFORMATION', 'Block resolution evidence is required');
    assert(!this.#blocks.has('AUTHORITY_BOUNDARY_EXCEEDED'), 'NEW_AUTHORIZATION_REQUIRED', 'Boundary blocks require a new approved Decision / Delegation');
    assert(!this.#blocks.has('LOOP_PROTECTION'), 'LOOP_PROTECTION', 'Loop protection cannot be reset by resuming');
    if (['SPECIFICATION_FAILURE', 'ARCHITECTURE_FAILURE'].some(category => this.#blocks.has(category))) requireRole(actor, 'human');
    if (this.#blocks.has('REPOSITORY_FAILURE')) {
      check('Discovery', discovery);
      assert(repositoryIdentity(discovery.repository.path) === repositoryIdentity(this.profile.repository), 'REPOSITORY_MISMATCH', 'Rediscovery must target the same repository');
      this.#discovery = immutable(discovery); this.#plan = undefined; this.#reviews = {}; this.#report = undefined;
      this.#move('DISCOVERY', actor, { resolution, discovery });
    } else this.#move(this.#blockedFrom, actor, { resolution });
    this.#clearBlocks();
  }
  adoptDecision(actor, decision) {
    requireRole(actor, 'human'); this.#at('REPLAN_PROPOSED', 'BLOCKED');
    this.#idle();
    const approved = this.#approved(decision);
    assert(approved.decision.id !== this.#approval.decision.id && approved.specification.id !== this.specification.id && approved.delegation.id !== this.delegation.id, 'NEW_AUTHORIZATION_REQUIRED', 'Replan requires new approved Decision, Specification and Delegation IDs');
    assert(repositoryIdentity(approved.profile.repository) === repositoryIdentity(this.profile.repository), 'REPOSITORY_MISMATCH', 'A task cannot silently migrate repositories');
    this.#approval = approved; this.#discovery = undefined; this.#plan = undefined; this.#report = undefined;
    this.#reviews = {}; this.#revisionCount = 0; this.#revisionPending = false; this.#failures.clear(); this.#progress.clear(); this.#clearBlocks(); this.#routing = undefined; this.#proposal = undefined;
    this.#move('DISCOVERY', actor, { new_approval: approved });
  }
  replaceDelegation(actor, decision) {
    requireRole(actor, 'human'); this.#at('BLOCKED');
    this.#idle();
    assert(this.#blocks.has('AUTHORITY_BOUNDARY_EXCEEDED'), 'INVALID_TRANSITION', 'Delegation replacement resolves authority blocks only');
    assert(!this.#blocks.has('LOOP_PROTECTION'), 'LOOP_PROTECTION', 'Delegation replacement cannot erase loop protection');
    const approved = this.#approved(decision);
    assert(digest(approved.decision) === digest(this.#approval.decision) && digest(approved.specification) === digest(this.specification), 'NEW_DECISION_REQUIRED', 'Decision or Specification changes must follow Replan');
    assert(approved.delegation.id !== this.delegation.id && repositoryIdentity(approved.profile.repository) === repositoryIdentity(this.profile.repository), 'NEW_AUTHORIZATION_REQUIRED', 'Requires fresh Human Delegation for the same repository');
    this.#approval = approved; this.#discovery = undefined; this.#plan = undefined; this.#report = undefined; this.#reviews = {}; this.#routing = undefined; this.#proposal = undefined;
    this.#blocks.delete('AUTHORITY_BOUNDARY_EXCEEDED');
    // Fresh grants resolve authority only; unrelated causes remain pending.
    this.#blockedFrom = 'DISCOVERY'; this.#block = [...this.#blocks.values()].at(-1);
    this.#move(this.#block || this.#humanStopped ? 'BLOCKED' : 'DISCOVERY', actor, { new_delegation: approved.delegation, profile: approved.profile });
  }
  override(actor, reason, { state = 'BLOCKED' } = {}) {
    requireRole(actor, 'human');
    assert(typeof reason === 'string' && reason.trim(), 'MISSING_INFORMATION', 'Override must be explicit and audited');
    assert(['DONE', 'BLOCKED'].includes(state), 'INVALID_TRANSITION', 'Human override can accept or terminate this execution');
    this.#audit.append('HUMAN_OVERRIDE', actor, { reason, target: state, reviews: this.#reviews });
    // Explicit Human acceptance does not fabricate passing R1/R2/R3 evidence.
    if (state === 'DONE') { this.#clearBlocks(); this.#move('DONE', actor, { override: reason }); }
    else { this.#humanStopped = true; this.#blocked(actor, 'MISSING_INFORMATION', `Human terminated execution: ${reason}`); }
  }
}

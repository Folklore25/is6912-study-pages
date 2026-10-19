/* Deterministic UMD build of src/design.js. Do not edit by hand.
 * Regenerate with: node tools/sync-shared.mjs  */
(function (root) {
  'use strict';
/**
 * IS6912 frozen shared design registry.
 *
 * This module is the single source of truth for experimental design identifiers and
 * the design snapshot shape. It is the only place that knows about the two-part core
 * (2×2) condition codes, the legacy three-part (2×2×2) codes, protocol versions and the
 * optional initial co-planning extension.
 *
 * It is authored once as an ESM module (`src/design.js`) and a byte-for-byte equivalent
 * UMD file (`participant/design.js`, exposing `window.StudyDesign`) is generated from it
 * by `tools/sync-shared.mjs`. Both exports describe the exact same logic; a parity test
 * (`tests/design.test.js`) enforces the byte equality and the shared behaviour, so the
 * browser and the Worker can never drift.
 *
 * Design kinds:
 *   - `core_2x2`            the default 2×2 between-subject study (four conditions).
 *   - `core_2x2_extension`  the core 2×2 plus the optional initial co-planning extension,
 *                           still expressed as a two-part condition id (the extension is a
 *                           property of the protocol/snapshot, not a third factor in the code).
 *   - `legacy_2x2x2`         the historical 2×2×2 study with model-backed preparation; kept
 *                           so existing sessions and results remain readable and are never
 *                           silently reinterpreted.
 *
 * Protocol versions (three, all runnable/readable/replayable):
 *   - `2026-10-11-online-v01`        LEGACY_PROTOCOL_VERSION, the historical 2×2×2.
 *   - `2026-10-19-core-v02`         CORE_V02_PROTOCOL_VERSION, the frozen core 2×2.
 *   - `2026-10-19-plan-dependent-v03` PROTOCOL_VERSION, the new DEFAULT protocol: the four
 *     cells only, scripted agent, the plan-dependent review-recovery event. It reuses the
 *     `core_2x2` kind deliberately: the snapshot stays a CLOSED, versioned contract, and the
 *     protocol id is what distinguishes a v03 record from a v02 one.
 *
 * IMPORTANT: a legacy `O` (review-only) cell does NOT mean the extension is disabled. It
 * means the historical third factor was "review only". `designFromRecord` reads the
 * authoritative versioned columns and never infers "extension off" from an old code.
 */

/** The new DEFAULT protocol: plan-dependent intervention event (four cells, scripted). */
const PROTOCOL_VERSION = '2026-10-19-plan-dependent-v03';
/** The frozen previous core protocol; still runnable/readable/replayable, never the default. */
const CORE_V02_PROTOCOL_VERSION = '2026-10-19-core-v02';
const LEGACY_PROTOCOL_VERSION = '2026-10-11-online-v01';

/** Every protocol version this platform can run, read and replay. */
const PROTOCOL_VERSIONS = Object.freeze([LEGACY_PROTOCOL_VERSION, CORE_V02_PROTOCOL_VERSION, PROTOCOL_VERSION]);

/**
 * Alias of the current default protocol under its descriptive research name. Protocol v2
 * is a RESEARCH revision name; the machine identifier stays `PLAN_DEPENDENT_PROTOCOL_VERSION`.
 */
const PLAN_DEPENDENT_PROTOCOL_VERSION = PROTOCOL_VERSION;

/** The four default core conditions: plan dynamics × plan-state visibility. */
const CORE_CELLS = Object.freeze(['S-H', 'S-L', 'R-H', 'R-L']);
/** The eight historical 2×2×2 conditions (kept for legacy data and the extension study). */
const LEGACY_CELLS = Object.freeze([
  'S-H-C', 'S-H-O', 'S-L-C', 'S-L-O',
  'R-H-C', 'R-H-O', 'R-L-C', 'R-L-O',
]);
/** Every condition code the platform knows: the core four plus the legacy eight. */
const ALL_CELLS = Object.freeze([...CORE_CELLS, ...LEGACY_CELLS]);

const DESIGN_KINDS = Object.freeze(['core_2x2', 'core_2x2_extension', 'legacy_2x2x2']);
const PLAN_DYNAMICS = Object.freeze(['stable', 'replanning']);
const PLAN_VISIBILITY = Object.freeze(['low', 'high']);
const AGENT_MODES = Object.freeze(['scripted', 'model_backed']);
const CO_PLANNING_MODES = Object.freeze(['co_planning', 'review_only']);

/**
 * The exact, closed set of snapshot keys. A snapshot carrying anything else (or missing
 * anything) is refused by `validateDesign`, so an ignored extra flag can never hide a
 * forged protocol claim.
 */
const SNAPSHOT_KEYS = Object.freeze([
  'agentMode', 'conditionId', 'designKind', 'extensions', 'planDynamics', 'planVisibility', 'protocolVersion',
].slice().sort());

/**
 * @typedef {Object} CellFactors
 * @property {('stable'|'replanning')} planDynamics
 * @property {('low'|'high')} planVisibility
 * @property {('co_planning'|'review_only')} [mode] present only for three-part codes
 */

// Canonical per-factor lookup, derived once from the well-known codes.
const CORE_FACTORS = /** @type {Readonly<Record<string,CellFactors>>} */ (Object.freeze({
  'S-H': { planDynamics: 'stable', planVisibility: 'high' },
  'S-L': { planDynamics: 'stable', planVisibility: 'low' },
  'R-H': { planDynamics: 'replanning', planVisibility: 'high' },
  'R-L': { planDynamics: 'replanning', planVisibility: 'low' },
}));

const LEGACY_FACTORS = /** @type {Readonly<Record<string,CellFactors>>} */ (Object.freeze({
  'S-H-C': { planDynamics: 'stable', planVisibility: 'high', mode: 'co_planning' },
  'S-H-O': { planDynamics: 'stable', planVisibility: 'high', mode: 'review_only' },
  'S-L-C': { planDynamics: 'stable', planVisibility: 'low', mode: 'co_planning' },
  'S-L-O': { planDynamics: 'stable', planVisibility: 'low', mode: 'review_only' },
  'R-H-C': { planDynamics: 'replanning', planVisibility: 'high', mode: 'co_planning' },
  'R-H-O': { planDynamics: 'replanning', planVisibility: 'high', mode: 'review_only' },
  'R-L-C': { planDynamics: 'replanning', planVisibility: 'low', mode: 'co_planning' },
  'R-L-O': { planDynamics: 'replanning', planVisibility: 'low', mode: 'review_only' },
}));

/**
 * Resolve the canonical factors for a condition code, or null when it is unknown.
 *
 * A three-part code is looked up by its FULL value, because only the three-part table
 * carries the involvement mode. Reducing a three-part code to its two-part base before
 * the lookup would resolve against CORE_FACTORS and silently DROP the C/O mode — exactly
 * the field a historical record must never lose.
 *
 * @param {string} cell two- or three-part condition code
 * @returns {CellFactors|null}
 */
function factorsOf(cell) {
  const code = String(cell);
  if (Object.hasOwn(LEGACY_FACTORS, code)) return LEGACY_FACTORS[code];
  if (Object.hasOwn(CORE_FACTORS, code)) return CORE_FACTORS[code];
  return null;
}

/** True when the code is one of the four core 2×2 conditions. */
function isCoreCell(cell) {
  return Object.hasOwn(CORE_FACTORS, String(cell));
}
/** True when the code is one of the eight legacy 2×2×2 conditions. */
function isLegacyCell(cell) {
  return Object.hasOwn(LEGACY_FACTORS, String(cell));
}

/** True when the code carries an explicit third part (a C or O involvement factor). */
function isExtensionCell(cell) {
  return String(cell).split('-').length >= 3;
}

/**
 * The condition codes valid for the current configuration.
 *
 * `enabled === false` (default) → exactly the four core conditions.
 * `enabled === true`           → the eight core+extension conditions (2×2×2 codes).
 *
 * The extension re-uses the historical three-part codes so the enabled-extension study is
 * described identically to how it always was; the disabled (core) study uses the
 * two-part codes. Both are frozen per invite/session.
 */
function getConditions(enabled = false) {
  return enabled ? [...LEGACY_CELLS] : [...CORE_CELLS];
}

/**
 * Resolve a design snapshot for a condition.
 *
 * With `protocolVersion` omitted:
 *   - a two-part cell → the current default protocol / `core_2x2`.
 *   - a three-part cell → the legacy protocol / `legacy_2x2x2` (for compatibility).
 *
 * With an explicit `protocolVersion`:
 *   - plan-dependent v03 + two-part cell → `core_2x2`. v03 is the four-cell pilot and the
 *     initial co-planning extension is NOT part of it, so v03 + three-part cell is an
 *     inconsistent combination and throws rather than silently running an extension study
 *     under the wrong protocol id.
 *   - core-v02 + two-part cell → `core_2x2`; core-v02 + three-part cell →
 *     `core_2x2_extension` (the extension study uses the historical three-part codes as a
 *     frozen identifier but is not a legacy study).
 *   - legacy protocol + three-part cell → `legacy_2x2x2`.
 *
 * Any other combination is inconsistent and throws rather than silently downgrading.
 *
 * @param {string} cell condition code
 * @param {string} [protocolVersion] explicit protocol; omit to infer from the code shape
 * @returns {DesignSnapshot} the frozen design snapshot
 */
function designForCell(cell, protocolVersion) {
  const code = String(cell);
  const factors = factorsOf(code);
  if (factors === null) throw new Error(`unknown_condition:${code}`);
  const threePart = String(code).split('-').length >= 3;
  const requested = protocolVersion === undefined || protocolVersion === null ? null : String(protocolVersion);

  /** @type {SnapshotParts['kind']} */
  let kind;
  let protocol;
  if (requested === null) {
    // Infer from the code shape: two-part → new core, three-part → legacy.
    if (threePart) { kind = 'legacy_2x2x2'; protocol = LEGACY_PROTOCOL_VERSION; }
    else { kind = 'core_2x2'; protocol = PROTOCOL_VERSION; }
  } else if (requested === PROTOCOL_VERSION) {
    if (threePart) throw new Error(`inconsistent_design:${code}:${requested}`);
    kind = 'core_2x2'; protocol = PROTOCOL_VERSION;
  } else if (requested === CORE_V02_PROTOCOL_VERSION) {
    if (threePart) { kind = 'core_2x2_extension'; protocol = CORE_V02_PROTOCOL_VERSION; }
    else { kind = 'core_2x2'; protocol = CORE_V02_PROTOCOL_VERSION; }
  } else if (requested === LEGACY_PROTOCOL_VERSION) {
    // Legacy protocol is only meaningful for a three-part (historical) code.
    if (!threePart) throw new Error(`inconsistent_design:${code}:${requested}`);
    kind = 'legacy_2x2x2'; protocol = LEGACY_PROTOCOL_VERSION;
  } else {
    throw new Error(`unknown_protocol:${requested}`);
  }

  return buildSnapshot({
    kind,
    protocol,
    conditionId: code,
    planDynamics: factors.planDynamics,
    planVisibility: factors.planVisibility,
    agentMode: kind === 'legacy_2x2x2' ? 'model_backed' : 'scripted',
    mode: factors.mode,
  });}

/**
 * @typedef {Object} InitialCoPlanning
 * @property {boolean} enabled whether the optional co-planning extension applies
 * @property {('co_planning'|'review_only')} [mode] present only when enabled is true
 */
/**
 * The frozen design snapshot. This exact shape is the platform-wide contract: it travels
 * in invites, sessions, scores, reports, exports and the shared browser registry.
 * @typedef {Object} DesignSnapshot
 * @property {string} protocolVersion PROTOCOL_VERSION or LEGACY_PROTOCOL_VERSION
 * @property {('core_2x2'|'core_2x2_extension'|'legacy_2x2x2')} designKind
 * @property {string} conditionId canonical condition code (two- or three-part)
 * @property {('stable'|'replanning')} planDynamics
 * @property {('low'|'high')} planVisibility
 * @property {('scripted'|'model_backed')} agentMode
 * @property {{initialCoPlanning:InitialCoPlanning}} extensions
 */

/**
 * A stored invites/sessions row. Both the snake_case database columns and the camelCase
 * API aliases are accepted, so the same function serves an adapter and a JSON response.
 * @typedef {Object} DesignRecord
 * @property {string} [protocol_version]
 * @property {string} [protocolVersion]
 * @property {string} [condition_id]
 * @property {string} [conditionId]
 * @property {string} [cell]
 * @property {number|boolean} [initial_co_planning_enabled]
 * @property {boolean} [initialCoPlanningEnabled]
 * @property {string} [initial_co_planning_mode]
 * @property {string} [initialCoPlanningMode]
 * @property {string} [agent_mode]
 * @property {string} [agentMode]
 */

/**
 * Resolve the authoritative design snapshot for a stored invite/session row.
 *
 * Reads the versioned columns that migration 0003 added; never infers "extension off"
 * from a historical code. A row without the versioned columns is historical and resolves
 * to `legacy_2x2x2` from its stored `cell`, which keeps every pre-migration row readable
 * exactly as it was collected.
 *
 * The record is authoritative for the PROTOCOL and the CANONICAL CONDITION; the mode and
 * the enabled flag must agree with the canonical condition's suffix, because a row that
 * contradicts its own condition code is corrupt data, not a design to be repaired.
 *
 * @param {DesignRecord} row an invites or sessions row
 * @returns {DesignSnapshot} the frozen design snapshot
 */
function designFromRecord(row) {
  if (!row || typeof row !== 'object') throw new Error('missing_record');
  const protocol = row.protocol_version ?? row.protocolVersion ?? null;
  const code = String(row.condition_id ?? row.conditionId ?? row.cell ?? '');
  if (factorsOf(code) === null) throw new Error(`unknown_condition:${code}`);

  if (protocol === null) {
    // Historical row: three-part code, extension on, model-backed. Never reinterpreted.
    return designForCell(code, LEGACY_PROTOCOL_VERSION);
  }
  if (protocol === LEGACY_PROTOCOL_VERSION) {
    // A legacy row must keep its full three-part code as the canonical condition; a
    // two-part id under the legacy protocol is not a shape this platform ever produced.
    if (String(code).split('-').length < 3) throw new Error(`inconsistent_design:${code}:${protocol}`);
    return designForCell(code, LEGACY_PROTOCOL_VERSION);
  }
  if (!PROTOCOL_VERSIONS.includes(protocol)) throw new Error(`unknown_protocol:${protocol}`);

  // New protocols: the frozen enabled flag and mode must agree with the canonical code.
  const canonical = designForCell(code, protocol);
  const flag = row.initial_co_planning_enabled ?? row.initialCoPlanningEnabled ?? null;
  const enabled = flag === null ? null : (flag === 1 || flag === true);
  const mode = row.initial_co_planning_mode ?? row.initialCoPlanningMode ?? null;
  const canonicalEnabled = canonical.extensions.initialCoPlanning.enabled;
  const canonicalMode = canonical.extensions.initialCoPlanning.mode ?? null;
  if (enabled !== null && enabled !== canonicalEnabled) throw new Error(`inconsistent_design:${code}:${protocol}`);
  if (mode !== null && mode !== canonicalMode) throw new Error(`inconsistent_design:${code}:${protocol}`);
  return canonical;
}

/**
 * @typedef {Object} SnapshotParts
 * @property {('core_2x2'|'core_2x2_extension'|'legacy_2x2x2')} kind
 * @property {string} protocol
 * @property {string} conditionId
 * @property {('stable'|'replanning')} planDynamics
 * @property {('low'|'high')} planVisibility
 * @property {('scripted'|'model_backed')} agentMode
 * @property {('co_planning'|'review_only')} [mode]
 */

/**
 * Assemble the one canonical snapshot shape from its resolved parts. This is the ONLY
 * place a snapshot is built, so every producer (core, extension, legacy) is consistent.
 * @param {SnapshotParts} parts
 * @returns {DesignSnapshot}
 */
function buildSnapshot({ kind, protocol, conditionId, planDynamics, planVisibility, agentMode, mode }) {
  /** @type {InitialCoPlanning} */
  const coPlanning = { enabled: kind !== 'core_2x2' };
  if (mode) coPlanning.mode = mode;
  const extensions = { initialCoPlanning: coPlanning };
  return {
    protocolVersion: protocol,
    designKind: kind,
    conditionId,
    planDynamics,
    planVisibility,
    agentMode,
    extensions,
  };
}

/**
 * Validate an arbitrary object as a design snapshot and return it in canonical shape.
 *
 * Validation is by CANONICALISATION, not by a list of necessary conditions: the snapshot
 * is first rebuilt from its own (protocolVersion, conditionId) pair, then every remaining
 * field must equal the rebuilt value exactly. A pair that has no canonical form at all
 * (an unknown code, a legacy protocol with a two-part code, an unknown protocol) throws
 * from `designForCell` rather than being repaired. This makes every invalid combination a
 * rejection, including a core kind under the legacy protocol, an extension kind with a
 * two-part condition, and a `C` cell that claims `review_only`.
 *
 * Unknown extra keys are refused: a snapshot is a closed contract, and a silently ignored
 * extra flag is how a forged protocol claim would slip through.
 *
 * @param {any} value candidate snapshot
 * @returns {DesignSnapshot} the canonical snapshot
 */
function validateDesign(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_design');
  const keys = Object.keys(value).sort();
  if (keys.length !== SNAPSHOT_KEYS.length || keys.some((key, index) => key !== SNAPSHOT_KEYS[index])) throw new Error('unexpected_design_fields');
  const { protocolVersion, designKind, conditionId, planDynamics, planVisibility, agentMode, extensions } = value;
  if (typeof protocolVersion !== 'string' || typeof conditionId !== 'string') throw new Error('invalid_design');
  if (!DESIGN_KINDS.includes(designKind)) throw new Error(`unknown_design_kind:${designKind}`);
  // The authoritative pair must itself be resolvable; nothing is downgraded silently.
  const canonical = designForCell(conditionId, protocolVersion);
  if (canonical.protocolVersion !== protocolVersion) throw new Error(`unknown_protocol:${protocolVersion}`);
  if (canonical.designKind !== designKind) throw new Error(`inconsistent_design:${designKind}:${protocolVersion}`);
  if (canonical.conditionId !== conditionId) throw new Error('condition_id_mismatch');
  if (canonical.planDynamics !== planDynamics || canonical.planVisibility !== planVisibility) throw new Error('factor_mismatch');
  if (canonical.agentMode !== agentMode) throw new Error('agent_mode_mismatch');
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) throw new Error('invalid_extension');
  if (Object.keys(extensions).length !== 1 || !extensions.initialCoPlanning) throw new Error('unexpected_design_fields');
  const ext = extensions.initialCoPlanning;
  const canonicalExt = canonical.extensions.initialCoPlanning;
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) throw new Error('invalid_extension');
  const extKeys = Object.keys(ext).sort();
  const expectedExtKeys = canonicalExt.mode === undefined ? ['enabled'] : ['enabled', 'mode'];
  if (extKeys.length !== expectedExtKeys.length || extKeys.some((key, index) => key !== expectedExtKeys[index])) throw new Error('unexpected_extension_fields');
  if (typeof ext.enabled !== 'boolean') throw new Error('invalid_extension');
  if (ext.enabled !== canonicalExt.enabled) throw new Error('extension_state_mismatch');
  if ((ext.mode ?? null) !== (canonicalExt.mode ?? null)) throw new Error('extension_mode_mismatch');
  return canonical;
}

/** True when a design snapshot is the plain core 2×2 (no extension). */
function isCoreDesign(design) {
  return Boolean(design) && design.designKind === 'core_2x2' && design.extensions?.initialCoPlanning?.enabled === false;
}

/** True when a protocol can run the optional initial co-planning extension at all. */
function extensionAvailable(protocolVersion = PROTOCOL_VERSION) {
  return String(protocolVersion) === CORE_V02_PROTOCOL_VERSION;
}

/**
 * Public config summary for GET /api/design and GET /api/overview.
 *
 * It deliberately carries no per-person or per-condition mode: it describes the design
 * that will be used for *future* invitations only. The `conditions` array is the exact
 * list the invitation endpoint will accept right now.
 *
 * The initial co-planning extension exists under the frozen core-v02 protocol only; the
 * plan-dependent v03 pilot is the four cells, so `enabled` is reported as false there and
 * the eight historical codes are never offered.
 *
 * @param {boolean} enabled whether the optional initial co-planning extension is requested
 * @param {string} [protocolVersion] the protocol the configuration describes
 */
function designConfig(enabled = false, protocolVersion = PROTOCOL_VERSION) {
  const protocol = String(protocolVersion);
  const effective = extensionAvailable(protocol) && Boolean(enabled);
  const conditions = effective ? [...LEGACY_CELLS] : [...CORE_CELLS];
  return {
    protocolVersion: protocol,
    designKind: effective ? 'core_2x2_extension' : 'core_2x2',
    agentMode: 'scripted',
    extensions: { initialCoPlanning: { enabled: effective } },
    conditions,
    conditionCount: conditions.length,
    extensionAvailable: extensionAvailable(protocol),
  };
}

/**
 * Ordered condition registry for the admin UI, each entry carrying its frozen snapshot.
 * Every entry is resolved with the *new* protocol, so an enabled-extension condition is
 * `core_2x2_extension` and a core condition is `core_2x2`.
 * @param {boolean} enabled whether the optional initial co-planning extension is on
 * @param {string} [protocolVersion] protocol the entries are resolved under; defaults to
 *   the current one. The enabled-extension eight exist only under `CORE_V02_PROTOCOL_VERSION`.
 */
function registry(enabled = false, protocolVersion = PROTOCOL_VERSION) {
  const protocol = String(protocolVersion);
  const conditions = protocol === PROTOCOL_VERSION && enabled
    ? [...CORE_CELLS]
    : getConditions(enabled);
  return conditions.map(cell => ({
    cell,
    design: designForCell(cell, protocol),
  }));
}

  const API={AGENT_MODES:AGENT_MODES,ALL_CELLS:ALL_CELLS,CORE_CELLS:CORE_CELLS,CORE_V02_PROTOCOL_VERSION:CORE_V02_PROTOCOL_VERSION,CO_PLANNING_MODES:CO_PLANNING_MODES,DESIGN_KINDS:DESIGN_KINDS,LEGACY_CELLS:LEGACY_CELLS,LEGACY_PROTOCOL_VERSION:LEGACY_PROTOCOL_VERSION,PLAN_DEPENDENT_PROTOCOL_VERSION:PLAN_DEPENDENT_PROTOCOL_VERSION,PLAN_DYNAMICS:PLAN_DYNAMICS,PLAN_VISIBILITY:PLAN_VISIBILITY,PROTOCOL_VERSION:PROTOCOL_VERSION,PROTOCOL_VERSIONS:PROTOCOL_VERSIONS,designConfig:designConfig,designForCell:designForCell,designFromRecord:designFromRecord,extensionAvailable:extensionAvailable,getConditions:getConditions,isCoreCell:isCoreCell,isCoreDesign:isCoreDesign,isLegacyCell:isLegacyCell,registry:registry,validateDesign:validateDesign};
  if(typeof module!=='undefined'&&module.exports)module.exports=API;else root.StudyDesign=API;
})(typeof window!=='undefined'?window:globalThis);

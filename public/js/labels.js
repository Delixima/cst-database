// Business vocabulary displayed in the UI.

export const PROCEDURES = {
  alpha:   { label: 'Alpha',   desc: 'Cuff and jail an imperial personnel member' },
  foxtrot: { label: 'Foxtrot', desc: 'Cuff and jail an immigrant' },
  tango:   { label: 'Tango',   desc: 'Terminate a personnel member or an immigrant' },
  delta:   { label: 'Delta',   desc: 'Cuff and relocate a personnel member or an immigrant' },
  lima:    { label: 'Lima',    desc: 'Search an immigrant' },
  hotel:   { label: 'Hotel',   desc: 'Detain and hold an offender' },
};
export const PROCEDURE_KEYS = Object.keys(PROCEDURES);
export const PROCEDURE_PREFIX = { alpha: 'A', foxtrot: 'F', tango: 'T', delta: 'D', lima: 'L', hotel: 'H' };

export const ACTIONS = {
  warning:     'Warning',
  arrest:      'Arrest (Jail)',
  termination: 'Termination',
  relocation:  'Relocation (cuff out)',
  search:      'Search',
  detention:   'Detention',
};
export const ACTION_KEYS = Object.keys(ACTIONS);

export const TARGETS = { personnel: 'Imperial personnel', immigrant: 'Immigrant', both: 'Both' };
export const TARGET_TYPES = { personnel: 'Imperial personnel', immigrant: 'Immigrant' };

export const ORDER_TYPES = {
  none: 'No order',
  arrest_on_sight: 'Arrest on Sight (AOS)',
  kill_on_sight: 'Kill on Sight (KOS)',
  hicom_isb_order: 'HICOM / ISB order',
};

export const STATUSES = { valid: 'Valid', voided: 'Voided' };

export const ROLES = {
  manager:   'Manager',
  officer:   'Officer',
  cs:        'Company Sergeant',
  trooper:   'Trooper',
  read_only: 'Read-only',
  pending:   'Pending',
};
export const ROLE_KEYS = Object.keys(ROLES);

const ROLE_LEVEL = { manager: 5, officer: 4, cs: 3, trooper: 2, read_only: 1, pending: 0 };
/** Hierarchy level of a role (same scale as private.role_level in SQL). */
export const level = (role) => ROLE_LEVEL[role] ?? 0;

export const APPROVAL_MARK = '⧭';

/** Human label of a server recommendation. */
export function recommendationLabel(code, warningNumber, maxWarnings) {
  switch (code) {
    case 'warning':
      return maxWarnings ? `Warning ${warningNumber}/${maxWarnings}` : `Warning ${warningNumber ?? ''}`.trim();
    case 'arrest_authorized': return 'Arrest authorized';
    case 'immediate_arrest':  return 'Immediate arrest';
    case 'arrest':            return 'Arrest';
    case 'termination':       return 'Termination';
    case 'relocation':
      return warningNumber ? `Relocation (cuff out) + Warning ${warningNumber}${maxWarnings ? '/' + maxWarnings : ''}` : 'Relocation (cuff out)';
    case 'search':            return 'Search';
    case 'detention':         return 'Detention';
    case 'order_arrest':      return 'Arrest (Arrest on Sight)';
    case 'order_kill':        return 'Termination (Kill on Sight)';
    default:                  return code ?? '—';
  }
}

/** Visual tone of a recommendation / action (CSS modifier). */
export function actionTone(action) {
  return {
    warning: 'warn', arrest: 'danger', termination: 'kill',
    relocation: 'info', search: 'teal', detention: 'gold',
  }[action] ?? 'neutral';
}

/** Labels for audit diffs. */
export const FIELD_LABELS = {
  log_number: 'Number', procedure: 'Procedure', offense_id: 'Offense', target_username: 'Target username',
  target_normalized: 'Player record', target_type: 'Target type', action_taken: 'Action taken',
  warning_number: 'Warning no.', jail_seconds: 'Jail (s)', prior_warnings: 'Prior warnings',
  recommended_action: 'Recommended action', recommendation_code: 'Recommendation',
  recommended_warning_number: 'Recommended warning', is_override: 'Override', override_reason: 'Override reason',
  agent_id: 'Agent', created_by: 'Created by', approved_by: 'Approver', approval_confirmed_by: 'Approval confirmed by',
  approval_confirmed_at: 'Approval confirmed at', ordered_by: 'Ordered by', order_type: 'Order type',
  report_filed: 'Report filed', location: 'Location', occurred_at: 'Occurred at', notes: 'Notes',
  evidence_urls: 'Evidence', status: 'Status', void_reason: 'Void reason', voided_by: 'Voided by',
  voided_at: 'Voided at', counts_for_warnings: 'Counts toward warnings', created_at: 'Created at',
  updated_at: 'Updated at', deleted_at: 'Deleted at',
  roblox_username: 'Roblox username', service_number: 'Service number', rank_id: 'Rank', squad_id: 'Squad',
  role: 'Role', active: 'Active', code: 'Code', name: 'Name', target: 'Target', max_warnings: 'Max warnings',
  default_action: 'Default action', requires_cs_approval: 'CS approval (⧭)', report_required: 'Report required',
  reason: 'Reason', reset_by: 'By', logs_affected: 'Logs affected', alias_normalized: 'Alias',
  canonical_normalized: 'Main username', note: 'Note', short_name: 'Abbreviation', sort_order: 'Order',
  kind: 'Type', profile_id: 'Member',
};

export const TABLE_LABELS = {
  sanction_logs: 'Logs', profiles: 'Members', offenses: 'Offenses', warning_resets: 'Warning resets',
  player_aliases: 'Aliases', ranks: 'Ranks', squads: 'Squads & functions', profile_squads: 'Memberships',
};

/** Unit types: squads give CS edit rights over their members' logs, functions do not. */
export const UNIT_KINDS = { squad: 'Squad', function: 'Function' };

export const AUDIT_ACTIONS = { INSERT: 'Created', UPDATE: 'Updated', DELETE: 'Deleted' };

export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

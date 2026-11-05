// Business vocabulary displayed in the UI (French labels, guide terms kept in English).

export const PROCEDURES = {
  alpha:   { label: 'Alpha',   desc: 'Menotter et emprisonner un membre du personnel impérial' },
  foxtrot: { label: 'Foxtrot', desc: 'Menotter et emprisonner un immigré' },
  tango:   { label: 'Tango',   desc: 'Éliminer (terminer) un membre du personnel ou un immigré' },
  delta:   { label: 'Delta',   desc: 'Menotter et déplacer un membre du personnel ou un immigré' },
  lima:    { label: 'Lima',    desc: 'Fouiller un immigré' },
  hotel:   { label: 'Hotel',   desc: 'Détenir et retenir un contrevenant' },
};
export const PROCEDURE_KEYS = Object.keys(PROCEDURES);
export const PROCEDURE_PREFIX = { alpha: 'A', foxtrot: 'F', tango: 'T', delta: 'D', lima: 'L', hotel: 'H' };

export const ACTIONS = {
  warning:     'Warning',
  arrest:      'Arrestation (Jail)',
  termination: 'Terminaison',
  relocation:  'Déplacement (cuff out)',
  search:      'Fouille',
  detention:   'Détention',
};
export const ACTION_KEYS = Object.keys(ACTIONS);

export const TARGETS = { personnel: 'Personnel impérial', immigrant: 'Immigré', both: 'Les deux' };
export const TARGET_TYPES = { personnel: 'Personnel impérial', immigrant: 'Immigré' };

export const ORDER_TYPES = {
  none: 'Aucun ordre',
  arrest_on_sight: 'Arrest on Sight (AOS)',
  kill_on_sight: 'Kill on Sight (KOS)',
  hicom_isb_order: 'Ordre HICOM / ISB',
};

export const STATUSES = { valid: 'Valide', voided: 'Annulé' };

export const ROLES = {
  manager:   'Gérant',
  officer:   'Officier',
  cs:        'Company Sergeant',
  trooper:   'Trooper',
  read_only: 'Lecture seule',
  pending:   'En attente',
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
    case 'arrest_authorized': return 'Arrestation autorisée';
    case 'immediate_arrest':  return 'Arrestation immédiate';
    case 'arrest':            return 'Arrestation';
    case 'termination':       return 'Terminaison';
    case 'relocation':
      return warningNumber ? `Déplacement (cuff out) + Warning ${warningNumber}${maxWarnings ? '/' + maxWarnings : ''}` : 'Déplacement (cuff out)';
    case 'search':            return 'Fouille';
    case 'detention':         return 'Détention';
    case 'order_arrest':      return 'Arrestation (Arrest on Sight)';
    case 'order_kill':        return 'Terminaison (Kill on Sight)';
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
  log_number: 'Numéro', procedure: 'Procédure', offense_id: 'Infraction', target_username: 'Pseudo cible',
  target_normalized: 'Dossier joueur', target_type: 'Type de cible', action_taken: 'Action prise',
  warning_number: 'N° de Warning', jail_seconds: 'Jail (s)', prior_warnings: 'Warnings précédents',
  recommended_action: 'Action recommandée', recommendation_code: 'Recommandation',
  recommended_warning_number: 'Warning recommandé', is_override: 'Écart', override_reason: 'Justification de l’écart',
  agent_id: 'Agent', created_by: 'Créé par', approved_by: 'Approbateur', approval_confirmed_by: 'Approbation confirmée par',
  approval_confirmed_at: 'Approbation confirmée le', ordered_by: 'Ordre donné par', order_type: 'Type d’ordre',
  report_filed: 'Rapport fait', location: 'Lieu', occurred_at: 'Date des faits', notes: 'Notes',
  evidence_urls: 'Preuves', status: 'Statut', void_reason: 'Motif d’annulation', voided_by: 'Annulé par',
  voided_at: 'Annulé le', counts_for_warnings: 'Compte pour les Warnings', created_at: 'Créé le',
  updated_at: 'Modifié le', deleted_at: 'Supprimé le',
  roblox_username: 'Pseudo Roblox', service_number: 'Matricule', rank_id: 'Grade', squad_id: 'Équipe',
  role: 'Rôle', active: 'Actif', code: 'Code', name: 'Libellé', target: 'Cible', max_warnings: 'Warnings max',
  default_action: 'Action par défaut', requires_cs_approval: 'Approbation CS (⧭)', report_required: 'Rapport obligatoire',
  reason: 'Motif', reset_by: 'Par', logs_affected: 'Logs concernés', alias_normalized: 'Alias',
  canonical_normalized: 'Pseudo principal', note: 'Note', short_name: 'Abréviation', sort_order: 'Ordre',
};

export const TABLE_LABELS = {
  sanction_logs: 'Logs', profiles: 'Membres', offenses: 'Infractions', warning_resets: 'Remises à zéro',
  player_aliases: 'Alias', ranks: 'Grades', squads: 'Équipes',
};

export const AUDIT_ACTIONS = { INSERT: 'Création', UPDATE: 'Modification', DELETE: 'Suppression' };

export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

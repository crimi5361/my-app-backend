// ============================================================================
//  Assiduité des étudiants pour l'Application B (bloc B15, décision du 08/11/2026)
//
//  Les appels sont faits par les Délégués dans l'application d'assiduité de Clovis
//  (« EduCheck »), qui partage la base de MyIIPEA : ses tables Django `Appels_appel`,
//  `Appels_presence` et `Appels_justificatifabsence` vivent dans le premier schéma de son
//  search_path (appels, academique, public). A les lit ici EN LECTURE SEULE et expose un
//  résumé par étudiant ; B ne lit jamais une base directement.
//
//  Règles (provisoires, à confirmer par la Direction) :
//   - seuls les appels « soumis » comptent (un brouillon n'est pas un appel fait) ;
//   - cours appelés = présences enregistrées de l'étudiant sur la période ;
//   - absence justifiée = absence dont le dernier justificatif est validé (`justifie`) ;
//   - taux de présence = présences ÷ cours appelés × 100 (les absences justifiées sont
//     comptées à part, sans être retirées du taux) ;
//   - retards : non suivis par l'application d'assiduité (null, jamais 0).
// ============================================================================

const pool = require('../../config/db.config');

const SCHEMAS = ['appels', 'academique', 'public'];
let schemaEnCache;

/** Schéma qui contient les tables d'EduCheck, ou null si elles n'existent pas (encore). */
async function schemaAssiduite() {
  if (schemaEnCache !== undefined) return schemaEnCache;
  const { rows } = await pool.query(
    `SELECT table_schema FROM information_schema.tables
      WHERE table_name = 'Appels_appel' AND table_schema = ANY($1)`,
    [SCHEMAS]
  );
  const trouves = rows.map((r) => r.table_schema);
  schemaEnCache = SCHEMAS.find((s) => trouves.includes(s)) || null;
  // Une source absente n'est pas mise en cache : elle peut être déployée entre-temps.
  if (!schemaEnCache) schemaEnCache = undefined;
  return schemaEnCache || null;
}

/** Pour les tests : oublie le schéma détecté. */
function oublierSchema() {
  schemaEnCache = undefined;
}

class ErreurAssiduite extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function lireJour(valeur, nom) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(valeur || ''))) {
    throw new ErreurAssiduite('PARAMETRE_INVALIDE', `${nom} doit être une date AAAA-MM-JJ.`);
  }
  return valeur;
}

/**
 * Résumé de présence par étudiant (et par groupe) sur [du, au].
 * Paramètres : du, au (obligatoires), groupe_id et/ou etudiant_id (identifiants publics).
 */
async function presences(parametres) {
  const du = lireJour(parametres.du, 'du');
  const au = lireJour(parametres.au, 'au');
  if (du > au) throw new ErreurAssiduite('PARAMETRE_INVALIDE', '« du » doit précéder « au ».');
  if (!parametres.groupe_id && !parametres.etudiant_id) {
    throw new ErreurAssiduite('PARAMETRE_INVALIDE', 'Indiquer groupe_id ou etudiant_id.');
  }
  const calculeLe = new Date().toISOString();
  const schema = await schemaAssiduite();
  if (!schema) {
    return { source_disponible: false, elements: [], genere_le: calculeLe };
  }
  const t = (nom) => `"${schema}"."${nom}"`;
  const valeurs = [du, au];
  const conditions = [];
  if (parametres.groupe_id) {
    valeurs.push(String(parametres.groupe_id));
    conditions.push(`g.uuid_public::text = $${valeurs.length}`);
  }
  if (parametres.etudiant_id) {
    valeurs.push(String(parametres.etudiant_id));
    conditions.push(`e.uuid_public::text = $${valeurs.length}`);
  }
  const { rows } = await pool.query(
    `WITH lignes AS (
       SELECT e.uuid_public AS etudiant_id, e.matricule_iipea, g.uuid_public AS groupe_id,
              p.statut,
              (SELECT j.justifie FROM ${t('Appels_justificatifabsence')} j
                WHERE j.presence_id = p.id ORDER BY j.cree_le DESC, j.id DESC LIMIT 1) AS justifie
         FROM ${t('Appels_presence')} p
         JOIN ${t('Appels_appel')} a ON a.id = p.appel_id
         JOIN etudiant e ON e.id = p.etudiant_id
         JOIN groupe g ON g.id = a.groupe_id
        WHERE a.statut = 'soumis' AND a.date BETWEEN $1::date AND $2::date
          AND COALESCE(e.matricule_iipea, '') <> ''
          ${conditions.length ? `AND ${conditions.join(' AND ')}` : ''}
     )
     SELECT etudiant_id, matricule_iipea, groupe_id,
            count(*)::int AS cours_appeles,
            count(*) FILTER (WHERE statut = 'present')::int AS presences,
            count(*) FILTER (WHERE statut = 'absent' AND justifie IS TRUE)::int AS absences_justifiees,
            count(*) FILTER (WHERE statut = 'absent' AND justifie IS NOT TRUE)::int AS absences_injustifiees
       FROM lignes
      GROUP BY etudiant_id, matricule_iipea, groupe_id
      ORDER BY matricule_iipea`,
    valeurs
  );
  return {
    source_disponible: true,
    elements: rows.map((r) => ({
      etudiant_id: r.etudiant_id,
      matricule_iipea: r.matricule_iipea,
      groupe_id: r.groupe_id,
      du,
      au,
      cours_appeles: r.cours_appeles,
      presences: r.presences,
      absences_justifiees: r.absences_justifiees,
      absences_injustifiees: r.absences_injustifiees,
      retards: null,
      taux_presence: r.cours_appeles ? Math.round((1000 * r.presences) / r.cours_appeles) / 10 : null,
      calcule_le: calculeLe,
    })),
    regle: 'Appels soumis ; taux = présences ÷ cours appelés ; retards non suivis par la source',
    genere_le: calculeLe,
  };
}

module.exports = { presences, oublierSchema, ErreurAssiduite };

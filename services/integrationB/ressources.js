// ============================================================================
//  Ressources exposées à l'Application B (contrat d'intégration v0.2, §7 du guide)
//
//  Chaque ressource est une requête qui produit, par ligne : `tri_date` (date de dernière
//  modification), `tri_id` (identifiant public) et `element` (l'objet JSON du contrat).
//  Règles : seuls les identifiants publics (`uuid_public`) sortent, jamais les SERIAL ;
//  minimisation des données personnelles (aucun contact, aucun mot de passe, aucune donnée
//  financière) ; les taux horaires des matières ne sortent jamais (rémunération, Q-07).
// ============================================================================

/** Date et heure ISO 8601 en UTC, au format du contrat (« 2026-10-27T08:00:00.000000Z »). */
const iso = (colonne) =>
  `to_char((${colonne}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Horodatage sans fuseau de A (heure d'Abidjan = UTC) exprimé en ISO UTC. */
const isoLocal = (colonne) => `to_char(${colonne}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/** Code de semestre « S1 » / « S2 » à partir du libellé libre de A (« Semestre 1 », « S1 »…). */
const codeSemestre = (colonne) =>
  `COALESCE('S' || substring(${colonne} from '[0-9]+'), ${colonne})`;

const RESSOURCES = {
  campus: {
    sql: `
      SELECT s.modifie_le AS tri_date, s.uuid_public::text AS tri_id,
        jsonb_build_object(
          'id', s.uuid_public, 'code', NULL, 'libelle', s.nom, 'ville', s.adresse,
          'campus_parent_id', NULL, 'actif', true, 'modifie_le', ${iso('s.modifie_le')}
        ) AS element
      FROM site s`,
  },

  annee_academique: {
    sql: `
      SELECT GREATEST(a.modifie_le, COALESCE(MAX(x.modifie_le), a.modifie_le)) AS tri_date,
        a.uuid_public::text AS tri_id,
        jsonb_build_object(
          'id', a.uuid_public, 'code', a.annee, 'libelle', 'Année académique ' || a.annee,
          'actif', true,
          'etats_par_campus', COALESCE(jsonb_agg(jsonb_build_object(
              'campus_id', s.uuid_public,
              'etat', CASE x.etat WHEN 'en cour' THEN 'en_cours' ELSE 'terminee' END,
              'ouverte_le', ${isoLocal('x.date_ouverture')},
              'fermee_le', ${isoLocal('x.date_fermeture')}
            ) ORDER BY s.nom) FILTER (WHERE x.id IS NOT NULL), '[]'::jsonb),
          'modifie_le', ${iso('GREATEST(a.modifie_le, COALESCE(MAX(x.modifie_le), a.modifie_le))')}
        ) AS element
      FROM anneeacademique a
      LEFT JOIN anneeacademique_site x ON x.anneeacademique_id = a.id
      LEFT JOIN site s ON s.id = x.site_id
      GROUP BY a.id`,
  },

  semestre: {
    // A ne connaît pas les dates des semestres (Q-12) : `periodes` reste vide.
    sql: `
      SELECT se.modifie_le AS tri_date, se.uuid_public::text AS tri_id,
        jsonb_build_object(
          'id', se.uuid_public, 'code', ${codeSemestre('se.nom')}, 'libelle', se.nom,
          'code_semestre', ${codeSemestre('se.nom')}, 'periodes', '[]'::jsonb, 'actif', true,
          'modifie_le', ${iso('se.modifie_le')}
        ) AS element
      FROM semestre se`,
  },

  ecole: {
    sql: `
      SELECT ec.modifie_le AS tri_date, ec.uuid_public::text AS tri_id,
        jsonb_build_object(
          'id', ec.uuid_public, 'code', ec.code, 'libelle', ec.nom,
          'actif', ec.statut = 'actif', 'modifie_le', ${iso('ec.modifie_le')}
        ) AS element
      FROM ecole ec`,
  },

  departement: {
    sql: `
      SELECT d.modifie_le AS tri_date, d.uuid_public::text AS tri_id,
        jsonb_build_object(
          'id', d.uuid_public, 'code', d.sigle, 'libelle', d.nom, 'ecole_id', ec.uuid_public,
          'actif', true, 'modifie_le', ${iso('d.modifie_le')}
        ) AS element
      FROM departement d LEFT JOIN ecole ec ON ec.id = d.ecole_id`,
  },

  filiere: {
    // Univers (Université / Grande École) et type de formation (initiale / continue) : lus dans
    // le type de filière de A quand son libellé les nomme, sinon inconnus (Q-02).
    sql: `
      SELECT f.modifie_le AS tri_date, f.uuid_public::text AS tri_id,
        jsonb_build_object(
          'id', f.uuid_public, 'code', f.sigle, 'libelle', f.nom,
          'departement_id', d.uuid_public, 'filiere_mere_id', fm.uuid_public,
          'univers', CASE
            WHEN t.libelle ILIKE '%universit%' THEN 'universite'
            WHEN t.libelle ILIKE '%grande%' THEN 'grande_ecole' END,
          'type_formation', CASE
            WHEN t.libelle ILIKE '%continu%' THEN 'continue'
            WHEN t.libelle ILIKE '%initial%' THEN 'initiale' END,
          'actif', true, 'modifie_le', ${iso('f.modifie_le')}
        ) AS element
      FROM filiere f
      LEFT JOIN departement d ON d.id = f.departement_id
      LEFT JOIN filiere fm ON fm.id = f.filiere_mere_id
      LEFT JOIN typefiliere t ON t.id = f.type_filiere_id`,
  },

  niveau: {
    sql: `
      SELECT n.modifie_le AS tri_date, n.uuid_public::text AS tri_id,
        jsonb_build_object(
          'id', n.uuid_public, 'code', NULL, 'libelle', n.libelle,
          'filiere_id', f.uuid_public, 'annee_id', a.uuid_public, 'campus_id', s.uuid_public,
          'ordre', n.ordre, 'niveau_suivant_id', ns.uuid_public,
          'actif', true, 'modifie_le', ${iso('n.modifie_le')}
        ) AS element
      FROM niveau n
      LEFT JOIN filiere f ON f.id = n.filiere_id
      LEFT JOIN anneeacademique a ON a.id = n.anneeacademique_id
      LEFT JOIN site s ON s.id = n.site_id
      LEFT JOIN niveau ns ON ns.id = n.niveau_suivant_id`,
    // Code normalisé (Q-09) calculé à partir du libellé : voir codeNiveau().
    completer: (element) => ({ ...element, code_niveau: codeNiveau(element.libelle) }),
  },

  classe: {
    sql: `
      SELECT c.modifie_le AS tri_date, c.uuid_public::text AS tri_id,
        jsonb_build_object(
          'id', c.uuid_public, 'code', NULL, 'libelle', c.nom,
          'niveau_id', n.uuid_public, 'filiere_id', f.uuid_public, 'annee_id', a.uuid_public,
          'actif', true, 'modifie_le', ${iso('c.modifie_le')}
        ) AS element
      FROM classe c
      LEFT JOIN niveau n ON n.id = c.niveau_id
      LEFT JOIN filiere f ON f.id = c.filiere_id
      LEFT JOIN anneeacademique a ON a.id = c.annee_academique_id`,
  },

  groupe: {
    sql: `
      SELECT g.modifie_le AS tri_date, g.uuid_public::text AS tri_id,
        jsonb_build_object(
          'id', g.uuid_public, 'code', NULL, 'libelle', g.nom,
          'classe_id', c.uuid_public, 'niveau_id', n.uuid_public,
          'capacite_max', g.capacite_max, 'principal', g.est_primaire,
          'actif', true, 'modifie_le', ${iso('g.modifie_le')}
        ) AS element
      FROM groupe g
      LEFT JOIN classe c ON c.id = g.classe_id
      LEFT JOIN niveau n ON n.id = c.niveau_id`,
  },

  etudiant: {
    // Minimisation : identifiant, matricule IIPEA, nom, prénoms, statut d'inscription. La clé
    // de rapprochement est `matricule_iipea` (l'ancien `matricule` a des doublons) : un
    // étudiant sans matricule IIPEA n'est pas exposé.
    sql: `
      SELECT e.modifie_le AS tri_date, e.uuid_public::text AS tri_id,
        jsonb_build_object(
          'id', e.uuid_public, 'matricule_iipea', e.matricule_iipea, 'nom', e.nom,
          'prenoms', e.prenoms,
          'statut_inscription', CASE
            WHEN lower(e.standing) = 'inscrit' THEN 'inscrit'
            WHEN lower(e.standing) = 'en attente' THEN 'en_attente'
            ELSE regexp_replace(lower(COALESCE(e.standing, 'inconnu')), '\\s+', '_', 'g') END,
          'actif', true, 'modifie_le', ${iso('e.modifie_le')}
        ) AS element
      FROM etudiant e
      WHERE COALESCE(e.matricule_iipea, '') <> ''`,
  },

  appartenance: {
    sql: `
      SELECT ag.modifie_le AS tri_date, ag.uuid_public::text AS tri_id,
        jsonb_build_object(
          'id', ag.uuid_public, 'etudiant_id', e.uuid_public, 'groupe_id', g.uuid_public,
          'date_debut', to_char(ag.date_debut, 'YYYY-MM-DD'),
          'date_fin', to_char(ag.date_fin, 'YYYY-MM-DD'),
          'actif', true, 'modifie_le', ${iso('ag.modifie_le')}
        ) AS element
      FROM appartenance_groupe ag
      JOIN etudiant e ON e.id = ag.etudiant_id AND COALESCE(e.matricule_iipea, '') <> ''
      JOIN groupe g ON g.id = ag.groupe_id`,
  },

  maquette: {
    // Jamais `taux_horaire_cm` ni `taux_horaire_td` (rémunération, Q-07).
    sql: `
      WITH modules AS (
        SELECT ma.ue_id, MAX(ma.modifie_le) AS modifie_le,
          jsonb_agg(jsonb_build_object(
            'id', ma.uuid_public, 'code', ma.code_ecue, 'libelle', ma.nom,
            'coefficient', ma.coefficient, 'credits', ma.credits,
            'volume_cm_heures', COALESCE(ma.volume_horaire_cm, 0),
            'volume_td_heures', COALESCE(ma.volume_horaire_td, 0),
            'volume_tp_heures', 0,
            'mode_evaluation', ma.type_evaluation::text
          ) ORDER BY ma.code_ecue, ma.id) AS liste
        FROM matiere ma GROUP BY ma.ue_id
      ), ues AS (
        SELECT u.maquette_id,
          MAX(GREATEST(u.modifie_le, COALESCE(mo.modifie_le, u.modifie_le))) AS modifie_le,
          jsonb_agg(jsonb_build_object(
            'id', u.uuid_public, 'code', u.code_ue, 'libelle', u.libelle,
            'semestre', ${codeSemestre('se.nom')},
            'modules', COALESCE(mo.liste, '[]'::jsonb)
          ) ORDER BY u.code_ue, u.id) AS liste
        FROM ue u
        LEFT JOIN semestre se ON se.id = u.semestre_id
        LEFT JOIN modules mo ON mo.ue_id = u.id
        GROUP BY u.maquette_id
      )
      SELECT GREATEST(m.modifie_le, COALESCE(ues.modifie_le, m.modifie_le)) AS tri_date,
        m.uuid_public::text AS tri_id,
        jsonb_build_object(
          'id', m.uuid_public, 'code', NULL,
          'libelle', concat_ws(' ', 'Maquette', f.sigle, n.libelle, a.annee),
          'version', m.version,
          'filiere_id', f.uuid_public, 'niveau_id', n.uuid_public, 'annee_id', a.uuid_public,
          'parcours', NULLIF(m.parcour, ''),
          'ues', COALESCE(ues.liste, '[]'::jsonb),
          'actif', true,
          'modifie_le', ${iso('GREATEST(m.modifie_le, COALESCE(ues.modifie_le, m.modifie_le))')}
        ) AS element
      FROM maquette m
      LEFT JOIN filiere f ON f.id = m.filiere_id
      LEFT JOIN niveau n ON n.id = m.niveau_id
      LEFT JOIN anneeacademique a ON a.id = m.anneeacademique_id
      LEFT JOIN ues ON ues.maquette_id = m.id`,
  },

  suppression: {
    sql: `
      SELECT su.supprime_le AS tri_date, su.id::text AS tri_id,
        jsonb_build_object(
          'ressource', su.ressource, 'id', su.uuid_public,
          'supprime_le', ${iso('su.supprime_le')}
        ) AS element
      FROM integration_b_suppression su`,
    horodatage: 'supprime_le',
  },
};

/**
 * Code de niveau normalisé (Q-09) à partir du libellé libre de A :
 * « LICENCE 1 » → L1, « LICENCE 2 PRO » → L2_PRO, « MASTER 1 » → M1, « BTS 2 » → BTS2.
 * Libellé non reconnu : null (le niveau reste lisible, sans code ; à corriger dans A).
 */
function codeNiveau(libelle) {
  const texte = String(libelle || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
  const pro = /\bPRO(FESSIONNEL(LE)?)?\b/.test(texte) ? '_PRO' : '';
  let trouve = texte.match(/\b(?:LICENCE|LIC|L)\s*([1-3])\b/);
  if (trouve) return `L${trouve[1]}${pro}`;
  trouve = texte.match(/\b(?:MASTER|M)\s*([12])\b/);
  if (trouve) return `M${trouve[1]}${pro}`;
  trouve = texte.match(/\bBTS\s*([12])\b/);
  if (trouve) return `BTS${trouve[1]}`;
  return null;
}

module.exports = { RESSOURCES, codeNiveau, iso };

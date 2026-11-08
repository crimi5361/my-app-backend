// ============================================================================
//  Lecture paginée des ressources pour l'Application B (contrat v0.2, §7 du guide)
//
//  - Pagination par curseur : ?limite=200&curseur=… (curseur opaque, stable même si des lignes
//    sont ajoutées pendant la lecture : tri sur (date de modification, identifiant public)) ;
//  - Différentiel : ?modifie_depuis=2026-10-27T08:00:00Z (lignes créées, modifiées ou
//    désactivées depuis cette date ; B rejoue avec un chevauchement) ;
//  - Filtres : annee_id, campus_id, filiere_id, classe_id, groupe_id, etudiant_id,
//    matricule_iipea, ressource (identifiants publics) ;
//  - ETag / If-None-Match : 304 si la page n'a pas changé.
// ============================================================================

const crypto = require('crypto');
const pool = require('../../config/db.config');
const { RESSOURCES } = require('./ressources');

const LIMITE_DEFAUT = 200;
const LIMITE_MAX = 500;

/** Filtres simples : valeur cherchée dans un champ de l'élément JSON. */
const FILTRES = ['annee_id', 'campus_id', 'filiere_id', 'classe_id', 'etudiant_id', 'ressource',
  'matricule_iipea'];

class ErreurRequete extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function lireCurseur(curseur) {
  if (!curseur) return null;
  try {
    const { d, i } = JSON.parse(Buffer.from(curseur, 'base64url').toString('utf8'));
    if (typeof d !== 'string' || typeof i !== 'string') throw new Error();
    return { date: d, id: i };
  } catch (e) {
    throw new ErreurRequete('CURSEUR_INVALIDE', 'Curseur invalide.');
  }
}

function ecrireCurseur(date, id) {
  return Buffer.from(JSON.stringify({ d: date, i: id }), 'utf8').toString('base64url');
}

function lireDate(valeur, nom) {
  const date = new Date(valeur);
  if (Number.isNaN(date.getTime())) {
    throw new ErreurRequete('PARAMETRE_INVALIDE', `${nom} doit être une date ISO 8601.`);
  }
  return date.toISOString();
}

/** Empreinte stable d'un objet JSON (clés triées) : ETag et idempotence. */
function empreinte(valeur) {
  const trier = (v) =>
    Array.isArray(v)
      ? v.map(trier)
      : v && typeof v === 'object'
        ? Object.keys(v).sort().reduce((o, k) => ({ ...o, [k]: trier(v[k]) }), {})
        : v;
  return crypto.createHash('sha256').update(JSON.stringify(trier(valeur))).digest('hex');
}

/**
 * Une page de la ressource. Retourne { elements, curseur_suivant } ; l'appelant ajoute
 * `genere_le` et l'ETag.
 */
async function page(nomRessource, parametres) {
  const ressource = RESSOURCES[nomRessource];
  if (!ressource) throw new ErreurRequete('INTROUVABLE', 'Ressource inconnue.');

  const limite = Math.max(1, Math.min(parseInt(parametres.limite, 10) || LIMITE_DEFAUT, LIMITE_MAX));
  const valeurs = [];
  const conditions = [];
  const ajouter = (valeur) => {
    valeurs.push(valeur);
    return `$${valeurs.length}`;
  };

  if (parametres.modifie_depuis) {
    conditions.push(`r.tri_date >= ${ajouter(lireDate(parametres.modifie_depuis, 'modifie_depuis'))}::timestamptz`);
  }
  for (const nom of FILTRES) {
    if (parametres[nom]) conditions.push(`r.element->>'${nom}' = ${ajouter(String(parametres[nom]))}`);
  }
  if (parametres.groupe_id) {
    if (nomRessource === 'etudiant') {
      // Étudiants appartenant aujourd'hui au groupe (historique daté).
      conditions.push(`EXISTS (
        SELECT 1 FROM appartenance_groupe ag
        JOIN etudiant e ON e.id = ag.etudiant_id
        JOIN groupe g ON g.id = ag.groupe_id
        WHERE e.uuid_public::text = r.tri_id AND g.uuid_public::text = ${ajouter(String(parametres.groupe_id))}
          AND ag.date_debut <= current_date AND (ag.date_fin IS NULL OR ag.date_fin >= current_date))`);
    } else {
      conditions.push(`r.element->>'groupe_id' = ${ajouter(String(parametres.groupe_id))}`);
    }
  }
  const curseur = lireCurseur(parametres.curseur);
  if (curseur) {
    conditions.push(`(r.tri_date, r.tri_id) > (${ajouter(curseur.date)}::timestamptz, ${ajouter(curseur.id)})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT r.element, to_char(r.tri_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS tri_date, r.tri_id
    FROM (${ressource.sql}) r
    ${where}
    ORDER BY r.tri_date, r.tri_id
    LIMIT ${limite + 1}`;
  const { rows } = await pool.query(sql, valeurs);

  const suite = rows.length > limite;
  const lignes = suite ? rows.slice(0, limite) : rows;
  const completer = ressource.completer || ((e) => e);
  const dernier = lignes[lignes.length - 1];
  return {
    elements: lignes.map((l) => completer(l.element)),
    curseur_suivant: suite ? ecrireCurseur(dernier.tri_date, dernier.tri_id) : null,
  };
}

/** Effectif officiel d'un groupe (Q-10) : la règle de A, étudiants « Inscrit » du groupe. */
async function effectif(groupeId) {
  const { rows } = await pool.query(
    `SELECT g.uuid_public,
       (SELECT count(*) FROM etudiant e WHERE e.groupe_id = g.id AND e.standing = 'Inscrit')::int AS effectif
     FROM groupe g WHERE g.uuid_public::text = $1`,
    [String(groupeId)]
  );
  if (!rows.length) return null;
  return {
    groupe_id: rows[0].uuid_public,
    effectif: rows[0].effectif,
    calcule_le: new Date().toISOString(),
    regle: 'Étudiants au statut « Inscrit » rattachés au groupe à la date de calcul',
  };
}

module.exports = { page, effectif, empreinte, ErreurRequete, LIMITE_MAX };

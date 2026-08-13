// Module Gestion des Enseignants (2026-08-11) — moteur de planification.
//
// Deux niveaux, conformément au §3.1 du cahier des charges :
//   • la trame (trame_edt) = maquette théorique récurrente, sans salle ;
//   • les séances (seance_edt) = occurrences datées, auxquelles le Chargé Pédagogique
//     alloue une salle « au fur et à mesure ».
//
// Les séances sont matérialisées en base plutôt que calculées à la volée : sans ligne
// physique, ni la contrainte d'exclusion sur les salles ni une annulation ponctuelle
// (« ce lundi-là, pas de cours ») ne seraient possibles.
const db = require('../config/db.config');

const JOURS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

/** Numéro de semaine ISO — sert à distinguer les semaines paires des impaires. */
function numeroSemaineISO(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Jeudi de la semaine courante : la norme ISO rattache la semaine à l'année de son jeudi.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const debutAnnee = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - debutAnnee) / 86400000 + 1) / 7);
}

const versISO = (date) => date.toISOString().slice(0, 10);

/**
 * Normalise en 'YYYY-MM-DD' une date qui peut arriver sous deux formes : une chaîne
 * (payload HTTP) ou un objet Date (le pilote `pg` désérialise les colonnes DATE en Date
 * à minuit *locale*). Passer par toISOString sur un objet Date décalerait la journée
 * d'un cran pour tout fuseau à l'ouest de UTC — d'où la reconstruction champ par champ.
 */
function versDateISO(valeur) {
  if (valeur instanceof Date) {
    const mois = String(valeur.getMonth() + 1).padStart(2, '0');
    const jour = String(valeur.getDate()).padStart(2, '0');
    return `${valeur.getFullYear()}-${mois}-${jour}`;
  }
  return String(valeur).slice(0, 10);
}

/**
 * Dates concrètes couvertes par une trame.
 * @returns {string[]} dates au format YYYY-MM-DD
 */
function datesDeLaTrame({ jour_semaine, date_debut, date_fin, frequence }) {
  const dates = [];
  const debut = new Date(`${versDateISO(date_debut)}T00:00:00Z`);
  const fin = new Date(`${versDateISO(date_fin)}T00:00:00Z`);

  // getUTCDay() : 0 = dimanche. jour_semaine suit la convention ISO (1 = lundi … 7 = dimanche).
  const curseur = new Date(debut);
  const jourCourant = curseur.getUTCDay() === 0 ? 7 : curseur.getUTCDay();
  curseur.setUTCDate(curseur.getUTCDate() + ((jour_semaine - jourCourant + 7) % 7));

  while (curseur <= fin) {
    const semainePaire = numeroSemaineISO(curseur) % 2 === 0;
    const retenue =
      frequence === 'hebdomadaire' ||
      (frequence === 'quinzaine_paire' && semainePaire) ||
      (frequence === 'quinzaine_impaire' && !semainePaire);

    if (retenue) dates.push(versISO(curseur));
    curseur.setUTCDate(curseur.getUTCDate() + 7);
  }
  return dates;
}

/**
 * Conflits d'agenda pour un créneau donné, hors salle (celle-ci est garantie par la
 * contrainte d'exclusion en base). On vérifie ici ce qu'aucune contrainte ne couvre :
 * un enseignant ou une classe ne peuvent pas être à deux endroits à la fois.
 *
 * @returns {Promise<string[]>} messages de conflit, vide si le créneau est libre
 */
async function detecterConflits(client, { classe_id, enseignant_id, date_seance, heure_debut, heure_fin, exclure_seance_id = null, exclure_trame_id = null }) {
  const conflits = [];

  // Deux créneaux se chevauchent si chacun commence avant que l'autre ne finisse.
  const chevauchement = `s.date_seance = $1 AND s.heure_debut < $3 AND s.heure_fin > $2
    AND s.statut <> 'annulee'
    AND ($4::int IS NULL OR s.id <> $4)
    AND ($5::int IS NULL OR s.trame_id IS DISTINCT FROM $5)`;
  const base = [date_seance, heure_debut, heure_fin, exclure_seance_id, exclure_trame_id];

  if (classe_id) {
    const r = await client.query(
      `SELECT s.id, m.nom AS matiere, s.heure_debut, s.heure_fin
       FROM seance_edt s LEFT JOIN matiere m ON m.id = s.matiere_id
       WHERE ${chevauchement} AND s.classe_id = $6 LIMIT 1`,
      [...base, classe_id]
    );
    if (r.rows.length > 0) {
      const c = r.rows[0];
      conflits.push(`La classe a déjà un cours sur ce créneau (${c.matiere || 'séance'} ${c.heure_debut.slice(0, 5)}–${c.heure_fin.slice(0, 5)}).`);
    }
  }

  if (enseignant_id) {
    const r = await client.query(
      `SELECT s.id, c.nom AS classe, s.heure_debut, s.heure_fin
       FROM seance_edt s LEFT JOIN classe c ON c.id = s.classe_id
       WHERE ${chevauchement} AND s.enseignant_id = $6 LIMIT 1`,
      [...base, enseignant_id]
    );
    if (r.rows.length > 0) {
      const c = r.rows[0];
      conflits.push(`L'enseignant intervient déjà sur ce créneau (${c.classe || 'autre classe'} ${c.heure_debut.slice(0, 5)}–${c.heure_fin.slice(0, 5)}).`);
    }
  }

  return conflits;
}

/**
 * Salles du site avec leur disponibilité sur un créneau.
 * Le cahier des charges demande de « griser » les salles occupées plutôt que de les
 * masquer : l'utilisateur doit voir que la salle existe et pourquoi elle est prise.
 */
async function sallesAvecDisponibilite({ site_id, date_seance, heure_debut, heure_fin, exclure_seance_id = null }) {
  const result = await db.query(
    `SELECT sa.id, sa.code, sa.nom, sa.capacite, sa.type_salle, sa.batiment,
            occ.seance_id IS NOT NULL AS occupee,
            occ.classe AS occupee_par_classe,
            occ.matiere AS occupee_par_matiere,
            occ.heure_debut AS occupee_de,
            occ.heure_fin AS occupee_a
     FROM salle sa
     LEFT JOIN LATERAL (
       SELECT s.id AS seance_id, c.nom AS classe, m.nom AS matiere, s.heure_debut, s.heure_fin
       FROM seance_edt s
       LEFT JOIN classe c ON c.id = s.classe_id
       LEFT JOIN matiere m ON m.id = s.matiere_id
       WHERE s.salle_id = sa.id
         AND s.date_seance = $1
         AND s.heure_debut < $3 AND s.heure_fin > $2
         AND s.statut <> 'annulee'
         AND ($4::int IS NULL OR s.id <> $4)
       LIMIT 1
     ) occ ON true
     WHERE sa.statut = 'actif'
       AND ($5::int IS NULL OR sa.site_id = $5)
     ORDER BY sa.batiment NULLS LAST, sa.code`,
    [date_seance, heure_debut, heure_fin, exclure_seance_id, site_id || null]
  );
  return result.rows;
}

/**
 * Règle §4 « Contractualisation » : un enseignant n'est planifiable que si les RH ont
 * validé son profil ET défini ses conditions pour l'année, et que la classe visée fait
 * partie de ses classes d'intervention.
 *
 * @returns {Promise<string|null>} message d'erreur, ou null si la planification est permise
 */
async function verifierContractualisation(client, enseignantId, classeId, anneeAcademiqueId) {
  if (!enseignantId) return null;

  const contrat = await client.query(
    `SELECT ct.id, e.nom, e.prenoms
     FROM contrat_enseignant ct
     JOIN enseignant e ON e.id = ct.enseignant_id
     WHERE ct.enseignant_id = $1 AND ct.annee_academique_id = $2 AND ct.statut = 'actif'
       AND e.statut = 'actif'`,
    [enseignantId, anneeAcademiqueId]
  );

  if (contrat.rows.length === 0) {
    return "Cet enseignant n'a pas de contrat actif pour cette année académique : les RH doivent d'abord définir ses conditions (classes, taux horaire, volume).";
  }

  const autorisee = await client.query(
    `SELECT 1 FROM contrat_classe WHERE contrat_id = $1 AND classe_id = $2`,
    [contrat.rows[0].id, classeId]
  );
  if (autorisee.rows.length === 0) {
    return "Cette classe ne fait pas partie des classes d'intervention prévues au contrat de l'enseignant.";
  }
  return null;
}

module.exports = {
  JOURS,
  versDateISO,
  datesDeLaTrame,
  detecterConflits,
  sallesAvecDisponibilite,
  verifierContractualisation,
  numeroSemaineISO,
};

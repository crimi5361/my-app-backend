// Chantier PEC — correction du rattachement par année académique (2026-08-21). Source UNIQUE de
// résolution de "la PEC active" d'un étudiant — une prise en charge appartient exclusivement à une
// année académique (prise_en_charge.annee_academique_id, déjà présent en base, déjà correctement
// renseigné sur 100% des lignes existantes — voir audit). Aucune logique parallèle : tous les
// endroits qui ont besoin de la PEC active d'un étudiant appellent cette fonction, jamais une
// requête WHERE etudiant_id = ? réécrite localement.
async function getPecActive(executor, { etudiantId, anneeAcademiqueId }) {
  if (!etudiantId) throw new Error('etudiantId requis.');
  if (!anneeAcademiqueId) throw new Error('anneeAcademiqueId requis.');

  const result = await executor.query(
    `SELECT * FROM prise_en_charge
     WHERE etudiant_id = $1 AND annee_academique_id = $2 AND statut = 'valide'`,
    [etudiantId, anneeAcademiqueId]
  );
  return result.rows[0] || null;
}

// Variante utilisée par les garde-fous anti-doublon (création d'une nouvelle demande) — les
// statuts "non terminaux" (en_attente/initiee/valide) comptent comme "déjà occupée" pour CETTE
// année, mais n'ont jamais d'effet sur une autre année (cf. audit §3c).
async function getPecNonTerminalePourAnnee(executor, { etudiantId, anneeAcademiqueId }) {
  if (!etudiantId) throw new Error('etudiantId requis.');
  if (!anneeAcademiqueId) throw new Error('anneeAcademiqueId requis.');

  const result = await executor.query(
    `SELECT * FROM prise_en_charge
     WHERE etudiant_id = $1 AND annee_academique_id = $2 AND statut IN ('en_attente', 'initiee', 'valide')`,
    [etudiantId, anneeAcademiqueId]
  );
  return result.rows[0] || null;
}

module.exports = { getPecActive, getPecNonTerminalePourAnnee };

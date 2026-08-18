// Rapport Word complet d'une personne (2026-08-18).
//
// La fiche affichée à l'écran tient l'essentiel ; ce module produit le reste —
// absolument tout ce que la base sait de quelqu'un. Séparé de la fiche parce
// que les deux ont des publics différents : l'un se regarde en conversation,
// l'autre se lit, s'imprime et se classe.
//
// CHAQUE SECTION PORTE DU SQL, JAMAIS DES VALEURS. C'est le générateur de
// documents qui exécute et met en tableau. Ni ce module ni le modèle ne
// manipulent les chiffres : ils ne peuvent donc pas en inventer.
const { genererRapportWord } = require('./assistantFichiers.service');

/**
 * Bascule une ligne en tableau « Champ / Valeur ».
 *
 * Le générateur rend un tableau par requête, colonnes en en-tête. Pour une
 * personne, une seule ligne de cinquante colonnes serait illisible et sortirait
 * de la page. On la met à la verticale : ça se lit, et ça s'imprime.
 */
function tableVerticale(vue, id, paires) {
  return paires
    .map(([libelle, colonne]) => `SELECT '${libelle}' AS champ, ${colonne}::text AS valeur FROM ${vue} WHERE id = ${id}`)
    .join(' UNION ALL ');
}

const SECTIONS_ETUDIANT = (id) => [
  {
    niveau: 1,
    titre: 'Identité',
    texte: "État civil et coordonnées, tels qu'enregistrés au dossier d'inscription.",
    sql: tableVerticale('assistant.t_etudiant', id, [
      ['Nom', 'nom'], ['Prénoms', 'prenoms'],
      ['Matricule IIPEA', 'matricule_iipea'], ['Matricule', 'matricule'],
      ['Matricule ministère', 'ip_ministere'],
      ['Sexe', 'sexe'], ['Date de naissance', 'date_naissance'],
      ['Lieu de naissance', 'lieu_naissance'], ['Pays de naissance', 'pays_naissance'],
      ['Nationalité', 'nationalite'], ['Résidence', 'lieu_residence'],
      ['Téléphone', 'telephone'], ['Contact étudiant', 'contact_etudiant'],
      ['E-mail', 'email'], ['E-mail personnel', 'email_personnel'],
      ["Numéro d'acte de naissance", 'numero_acte_naissance'],
      ["Numéro de pièce d'identité", 'numero_piece_identite'],
      ['Numéro de table', 'numero_table'],
    ]),
  },
  {
    niveau: 1,
    titre: 'Origine scolaire',
    sql: tableVerticale('assistant.t_etudiant', id, [
      ['Série du baccalauréat', 'serie_bac'], ['Année du baccalauréat', 'annee_bac'],
      ['Mention', 'mention_bac'], ['Session', 'session_bac'],
      ["Établissement d'origine", 'etablissement_origine'],
    ]),
  },
  {
    niveau: 1,
    titre: 'Famille',
    sql: tableVerticale('assistant.t_etudiant', id, [
      ['Parent 1', 'nom_parent_1'], ['Contact 1', 'contact_parent'], ['Adresse 1', 'adresse_parent_1'],
      ['Parent 2', 'nom_parent_2'], ['Contact 2', 'contact_parent_2'], ['Adresse 2', 'adresse_parent_2'],
    ]),
  },
  {
    niveau: 1,
    titre: 'Inscription',
    sql: tableVerticale('assistant.t_etudiant', id, [
      ["Date d'inscription", 'date_inscription'], ['Source', 'source_inscription'],
      ['Standing', 'standing'], ['Statut scolaire', 'statut_scolaire'],
      ['Engagement accepté', 'engagement_accepte'], ['Validé scolarité', 'valide_scolarite'],
      ['Code de paiement', 'code_paiement'], ['Versements prévus', 'nombre_versements_prevu'],
      ['Date de vérification', 'date_verification'], ['Observation', 'observation_verification'],
    ]),
  },
  {
    niveau: 1,
    titre: 'Parcours académique',
    texte: 'Une ligne par année académique suivie.',
    sql: 'SELECT annee_academique_id AS annee, statut_scolaire, standing, moyenne_s1, moyenne_s2, '
      + 'moyenne_annuelle, decision_annuelle, montant_scolarite '
      + `FROM assistant.t_inscription_annuelle WHERE etudiant_id = ${id} ORDER BY annee_academique_id DESC`,
  },
  {
    niveau: 1,
    titre: 'Situation financière',
    sql: 'SELECT s.montant_scolarite, s.scolarite_verse, s.scolarite_restante, s.statut_etudiant '
      + 'FROM assistant.t_scolarite s JOIN assistant.t_etudiant e ON e.scolarite_id = s.id '
      + `WHERE e.id = ${id}`,
  },
  {
    niveau: 2,
    titre: 'Historique des encaissements',
    sql: 'SELECT date_paiement, montant, methode, statut, reference_transaction '
      + `FROM assistant.t_paiement WHERE etudiant_id = ${id} ORDER BY date_paiement DESC`,
  },
  {
    niveau: 2,
    titre: 'Prises en charge',
    sql: 'SELECT reference, type_pec, pourcentage_reduction, montant_reduction, statut, date_validation '
      + `FROM assistant.t_prise_en_charge WHERE etudiant_id = ${id} ORDER BY date_demande DESC`,
  },
  {
    niveau: 1,
    titre: 'Résultats académiques',
    texte: 'Synthèse des évaluations enregistrées. Les colonnes note1, note2 et partiel ne sont pas '
      + 'toutes pertinentes selon la matière : la moyenne fait foi.',
    sql: 'SELECT COUNT(*)::int AS evaluations, ROUND(AVG(moyenne), 2) AS moyenne_generale, '
      + 'ROUND(MIN(moyenne), 2) AS plus_basse, ROUND(MAX(moyenne), 2) AS plus_haute '
      + `FROM assistant.t_note WHERE etudiant_id = ${id}`,
  },
  {
    niveau: 2,
    titre: 'Kit et distributions',
    sql: 'SELECT date_remise, numero_recu, ecole_nom, filiere_nom, niveau_nom '
      + `FROM assistant.t_distribution WHERE etudiant_id = ${id} ORDER BY date_remise DESC`,
  },
  {
    niveau: 2,
    titre: 'Pièces du dossier',
    sql: 'SELECT type_document_id, fourni, date_upload, declare_par_etudiant '
      + `FROM assistant.t_document_etudiant WHERE etudiant_id = ${id} ORDER BY date_upload DESC`,
  },
];

const SECTIONS_AGENT = (id) => [
  {
    niveau: 1,
    titre: 'Identité et fonction',
    sql: tableVerticale('assistant.t_utilisateur', id, [
      ['Nom', 'nom'], ['Matricule', 'code'], ['E-mail', 'email'], ['Statut', 'statut'],
    ]),
  },
  {
    niveau: 1,
    titre: "Volume d'activité par domaine",
    texte: "Activité RECONSTRUITE depuis les colonnes auteur des tables métier. Elle ne couvre que "
      + "les CRÉATIONS : aucune connexion, consultation, modification ni suppression n'est "
      + 'enregistrée dans cette base.',
    sql: 'SELECT domaine, acte, COUNT(*)::int AS actes, MIN(horodatage)::date AS premier, '
      + 'MAX(horodatage)::date AS dernier FROM assistant.v_activite_agents '
      + `WHERE agent_id = ${id} GROUP BY domaine, acte ORDER BY COUNT(*) DESC`,
  },
  {
    niveau: 2,
    titre: 'Cinquante derniers actes',
    sql: 'SELECT horodatage::date AS jour, domaine, acte, volume, reference '
      + `FROM assistant.v_activite_agents WHERE agent_id = ${id} ORDER BY horodatage DESC LIMIT 50`,
  },
];

/**
 * Produit le rapport Word complet d'une personne.
 *
 * @param {'etudiant'|'agent'} categorie
 * @param {number} id
 * @param {{siteId:number, ecoleId:number|null, utilisateurId:number|null}} contexte
 * @param {{nom_complet:string, libelle_categorie:string, reference:string}} entete
 */
async function rapportPersonne(categorie, id, contexte, entete) {
  const n = Number(id);
  if (!Number.isInteger(n)) return { ok: false, motif: 'Identifiant invalide.' };

  const fichier = await genererRapportWord({
    titre: entete.nom_complet,
    objet: `Dossier complet — ${entete.libelle_categorie}`,
    secteur: [entete.libelle_categorie, entete.reference].filter(Boolean).join(' · '),
    sections: categorie === 'agent' ? SECTIONS_AGENT(n) : SECTIONS_ETUDIANT(n),
    siteId: contexte.siteId,
    ecoleId: contexte.ecoleId,
    utilisateurId: contexte.utilisateurId,
  });

  return { ok: true, fichier };
}

module.exports = { rapportPersonne, SECTIONS_ETUDIANT, SECTIONS_AGENT };

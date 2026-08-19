// Composition des fiches — quels champs, dans quel ordre, sous quel thème
// (2026-08-19).
//
// DIRECTIVE : une fiche montre TOUT ce que la base contient sur la personne.
// Pas de sélection éditoriale, pas de résumé. Un champ vide s'affiche quand
// même, avec la mention « non renseigné » — faire disparaître une rubrique
// laisserait croire qu'elle n'existe pas, alors qu'elle est seulement à
// remplir. C'est une information de gestion en soi.
//
// Ce fichier ne contient QUE la composition. La lecture en base est ailleurs :
// on peut donc réorganiser une fiche sans toucher à une requête.

/** Ce qui s'affiche à la place d'une valeur absente. Jamais un tiret seul : on
 *  ne doit pas pouvoir confondre « vide » avec « zéro ». */
const NON_RENSEIGNE = 'non renseigné';

const estVide = (v) => v === null || v === undefined
  || (typeof v === 'string' && v.trim() === '');

/** Formatte une valeur pour l'affichage, sans jamais la masquer. */
function afficher(v, format) {
  if (estVide(v)) return NON_RENSEIGNE;
  if (format === 'montant') {
    return `${Math.round(Number(v)).toLocaleString('fr-FR')} FCFA`;
  }
  if (format === 'date') {
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  }
  if (format === 'oui_non') return v === true ? 'Oui' : v === false ? 'Non' : String(v);
  return String(v);
}

/**
 * Composition d'un bloc à partir d'une source et d'une liste de champs.
 *
 * Chaque champ est `[libellé, clé, format?]`. Tous sont rendus, y compris les
 * vides — c'est la règle.
 */
const bloc = (titre, source, champs) => ({
  titre,
  champs: champs.map(([libelle, cle, format]) => ({
    libelle,
    valeur: afficher(source?.[cle], format),
    vide: estVide(source?.[cle]),
  })),
});

// ───────────────────────────────────────────────────────────────────────────
//  Étudiant — les 53 colonnes de la table, plus la scolarité et le parcours
// ───────────────────────────────────────────────────────────────────────────
const BLOCS_ETUDIANT = (e, a, s) => [
  bloc("Identité et état civil", e, [
    ['Nom', 'nom'], ['Prénoms', 'prenoms'],
    ['Sexe', 'sexe'],
    ['Date de naissance', 'date_naissance', 'date'],
    ['Lieu de naissance', 'lieu_naissance'],
    ['Pays de naissance', 'pays_naissance'],
    ['Nationalité', 'nationalite'],
    ["Numéro d'acte de naissance", 'numero_acte_naissance'],
    ["Numéro de pièce d'identité", 'numero_piece_identite'],
  ]),

  bloc('Identifiants', e, [
    ['Matricule IIPEA', 'matricule_iipea'],
    ['Matricule', 'matricule'],
    ['Matricule ministère', 'ip_ministere'],
    ['Code unique', 'code_unique'],
    ['Code de paiement', 'code_paiement'],
    ['Numéro de table', 'numero_table'],
  ]),

  bloc('Coordonnées', e, [
    ['Téléphone', 'telephone'],
    ['Contact étudiant', 'contact_etudiant'],
    ['E-mail', 'email'],
    ['E-mail personnel', 'email_personnel'],
    ['Résidence', 'lieu_residence'],
  ]),

  bloc('Famille', e, [
    ['Parent 1', 'nom_parent_1'],
    ['Contact 1', 'contact_parent'],
    ['Adresse 1', 'adresse_parent_1'],
    ['Parent 2', 'nom_parent_2'],
    ['Contact 2', 'contact_parent_2'],
    ['Adresse 2', 'adresse_parent_2'],
  ]),

  bloc('Origine scolaire', e, [
    ['Série du baccalauréat', 'serie_bac'],
    ['Année du baccalauréat', 'annee_bac'],
    ['Mention', 'mention_bac'],
    ['Session', 'session_bac'],
    ["Établissement d'origine", 'etablissement_origine'],
  ]),

  bloc('Scolarité', a, [
    ['Année académique', 'annee_academique'],
    ['École', 'ecole'],
    ['Filière', 'filiere'],
    ['Sigle', 'filiere_sigle'],
    ['Niveau', 'niveau'],
    ['Cursus', 'cursus'],
  ]),

  bloc('Dossier', e, [
    ['Standing', 'standing'],
    ['Statut scolaire', 'statut_scolaire'],
    ["Date d'inscription", 'date_inscription', 'date'],
    ["Source de l'inscription", 'source_inscription'],
    ['Engagement accepté', 'engagement_accepte', 'oui_non'],
    ['Validé par la scolarité', 'valide_scolarite', 'oui_non'],
    ['Versements prévus', 'nombre_versements_prevu'],
  ]),

  bloc('Situation financière', s, [
    ['Montant de la scolarité', 'montant_scolarite', 'montant'],
    ['Versé', 'scolarite_verse', 'montant'],
    ['Reste à payer', 'scolarite_restante', 'montant'],
    ['Statut', 'statut_etudiant'],
  ]),

  bloc('Vérification du dossier', e, [
    ['Vérifié par', 'verifie_par'],
    ['Date de vérification', 'date_verification', 'date'],
    ['Observation', 'observation_verification'],
  ]),

  // Utile quand le fondateur veut faire remonter une anomalie : ces
  // identifiants sont ce qu'un développeur demandera en premier.
  bloc('Références techniques', e, [
    ['Identifiant', 'id'],
    ['Site', 'site_id'],
    ['Année académique', 'annee_academique_id'],
    ['Filière', 'id_filiere'],
    ['Niveau', 'niveau_id'],
    ['Groupe', 'groupe_id'],
    ['Cursus', 'curcus_id'],
    ['Scolarité', 'scolarite_id'],
    ['Dossier de pièces', 'document_id'],
  ]),
];

// ───────────────────────────────────────────────────────────────────────────
//  Agent
// ───────────────────────────────────────────────────────────────────────────
const BLOCS_AGENT = (a, act) => [
  bloc('Identité', a, [
    ['Nom', 'agent'],
    ['Matricule', 'matricule'],
  ]),

  bloc('Fonction', a, [
    ['Rôle applicatif', 'role'],
    ['Description du rôle', 'role_description'],
    ['Statut du compte', 'statut'],
    ['Site', 'site'],
    ['École', 'ecole'],
  ]),

  bloc('Coordonnées', a, [
    ['E-mail', 'email'],
  ]),

  bloc('Activité tracée', act, [
    ['Actes enregistrés', 'actes'],
    ['Premier acte', 'premier', 'date'],
    ['Dernier acte', 'dernier', 'date'],
    ['Domaines', 'domaines'],
  ]),

  bloc('Références techniques', a, [
    ['Identifiant', 'agent_id'],
  ]),
];

/**
 * Ce que la base ne contient pas pour un agent, dit explicitement.
 *
 * La directive demande fonction, service, date de prise de service, matières
 * enseignées, charge horaire et évaluations. Quatre de ces six informations
 * n'existent nulle part : la table `enseignant` est vide, et `utilisateur` ne
 * porte ni date d'entrée ni évaluation. Le taire donnerait l'impression d'une
 * fiche incomplète par négligence.
 */
const LACUNES_AGENT = [
  "Date de prise de service : la table `utilisateur` ne porte aucune date d'entrée.",
  "Matières enseignées et charge horaire : réservées aux enseignants, et la table "
  + "`enseignant` est vide à ce jour.",
  "Évaluations et appréciations : aucune table ne les enregistre.",
  "Photo : la table `utilisateur` ne porte aucune colonne d'image. Aucun membre "
  + "du personnel ne peut en avoir.",
];

/** Pour un étudiant, ce qui manque relève de l'assiduité — voir le module
 *  d'analyse, qui porte le détail. */
const LACUNES_ETUDIANT = [
  "Assiduité, absences, retards et sanctions : aucune table ne les enregistre.",
];

module.exports = {
  BLOCS_ETUDIANT, BLOCS_AGENT, LACUNES_AGENT, LACUNES_ETUDIANT,
  NON_RENSEIGNE, afficher, estVide,
};

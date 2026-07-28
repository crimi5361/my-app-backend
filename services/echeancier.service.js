// Moteur d'échéancier de paiement — partagé entre inscription et réinscription.
//
// Règle métier (confirmée avec l'utilisateur) : le premier versement d'un plan jamais entamé
// suit une règle fixe (150 000 F, ou le montant total s'il est inférieur), le reste du solde se
// répartissant également sur les versements suivants. Dès qu'un paiement réel a été enregistré,
// ce plan n'est plus figé : les versements restants se recalculent en répartissant équitablement
// le solde réel restant sur le nombre de versements restants — jamais une contrainte bloquante,
// uniquement un repère prévisionnel affiché à l'étudiant et à l'agent.
//
// Cadence : chaque versement restant est espacé de 2 mois du précédent (et non 1), pour laisser
// davantage de temps aux parents. Toute échéance tombant un jour non ouvrable (week-end ou jour
// férié en Côte d'Ivoire) est automatiquement reportée au prochain jour ouvrable.
const moment = require('moment');
const { prochainJourOuvrable } = require('./joursFeries.service');

const ESPACEMENT_MOIS_ENTRE_VERSEMENTS = 2;

const PREMIER_VERSEMENT_FIXE = 150000;

const formatDate = (d) => moment(d).format('DD/MM/YYYY');

// paiementsEffectues : [{ montant, date }], du plus ancien au plus récent.
// dateDepart : date de référence pour la cadence mensuelle des versements restants (date de
// validation du dossier — pas la date du dernier paiement, pour rester prévisible).
exports.calculerEcheancier = ({ montantTotal, nombreVersementsPrevu, paiementsEffectues = [], dateDepart }) => {
  const total = parseFloat(montantTotal) || 0;
  const n = nombreVersementsPrevu && nombreVersementsPrevu > 0 ? parseInt(nombreVersementsPrevu, 10) : 1;
  const k = paiementsEffectues.length;
  const montantVerse = paiementsEffectues.reduce((s, p) => s + (parseFloat(p.montant) || 0), 0);
  const resteAPayer = Math.max(Math.round((total - montantVerse) * 100) / 100, 0);
  const base = moment(dateDepart);
  const aujourdhui = moment();

  const versements = paiementsEffectues.map((p, i) => ({
    numero: i + 1,
    montant: parseFloat(p.montant) || 0,
    date: formatDate(p.date),
    statut: 'paye',
    reel: true,
  }));

  if (resteAPayer > 0.5) {
    const versementsRestants = Math.max(n - k, 1);
    // La règle du premier versement fixe ne s'applique qu'au tout premier plan, jamais entamé.
    const appliquerReglePremierVersement = k === 0 && versementsRestants > 1;
    const premierMontant = appliquerReglePremierVersement ? Math.min(PREMIER_VERSEMENT_FIXE, resteAPayer) : null;
    const resteApresPremier = resteAPayer - (premierMontant || 0);
    const nbVersementsEgaux = premierMontant !== null ? versementsRestants - 1 : versementsRestants;
    const montantParVersementEgal = nbVersementsEgaux > 0 ? Math.round(resteApresPremier / nbVersementsEgaux) : 0;

    let cumul = 0;
    for (let j = 0; j < versementsRestants; j++) {
      const isDernier = j === versementsRestants - 1;
      let montant;
      if (j === 0 && premierMontant !== null) {
        montant = premierMontant;
      } else if (isDernier) {
        montant = resteAPayer - cumul;
      } else {
        montant = montantParVersementEgal;
      }
      cumul += montant;

      const datePrevueBrute = base.clone().add((k + j) * ESPACEMENT_MOIS_ENTRE_VERSEMENTS, 'month');
      const datePrevue = prochainJourOuvrable(datePrevueBrute);
      versements.push({
        numero: k + j + 1,
        montant,
        date: formatDate(datePrevue),
        statut: datePrevue.isBefore(aujourdhui, 'day') ? 'en_retard' : 'a_venir',
        reel: false,
      });
    }
  }

  const prochainVersement = versements.find(v => !v.reel) || null;
  let statutGlobal;
  if (resteAPayer <= 0.5) statutGlobal = 'solde';
  else if (versements.some(v => !v.reel && v.statut === 'en_retard')) statutGlobal = 'en_retard';
  else statutGlobal = 'respecte';

  return {
    versements,
    montant_total: total,
    montant_verse: montantVerse,
    reste_a_payer: resteAPayer,
    nombre_versements_prevu: n,
    nombre_versements_effectues: k,
    prochain_versement: prochainVersement,
    statut_global: statutGlobal,
  };
};

exports.PREMIER_VERSEMENT_FIXE = PREMIER_VERSEMENT_FIXE;

// Règle métier (reprise de l'admission) : au-delà d'un certain montant de scolarité, le nombre de
// versements reste libre (jusqu'à 4) ; entre 150 000 et 210 000 F, il est plafonné à 2 pour garder
// des versements d'un montant raisonnable. Centralisé ici pour que le frontend n'ait jamais à
// recalculer cette règle — il ne fait qu'afficher les options renvoyées par le serveur.
exports.determinerOptionsVersements = (montant) => {
  const m = parseFloat(montant);
  const maxVersements = Number.isFinite(m) && m >= 150000 && m <= 210000 ? 2 : 4;
  return [1, 2, 3, 4].filter(n => n <= maxVersements);
};

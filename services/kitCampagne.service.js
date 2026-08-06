// Suspension du module Kit par campagne — le kit reste un mécanisme actif dans le code (table
// `kit`, colonnes, logique de dépôt), mais peut être désactivé pour une ou plusieurs années
// académiques données (ex. 2026-2027) sans toucher aux données ni au comportement des années
// non concernées. Configurable via KIT_ANNEES_SUSPENDUES (libellés anneeacademique.annee séparés
// par des virgules, ex. "2026-2027") plutôt qu'un flag global, pour ne jamais masquer
// rétroactivement le kit sur les reçus d'une campagne où il était actif.
const anneesSuspendues = (process.env.KIT_ANNEES_SUSPENDUES || '')
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);

// `executor` est soit le pool `db`, soit un client de transaction déjà ouvert (même interface
// `.query()`) — permet d'appeler cette fonction depuis une transaction en cours sans ouvrir une
// connexion supplémentaire.
async function isKitSuspenduPourAnnee(executor, anneeAcademiqueId) {
  if (!anneeAcademiqueId || anneesSuspendues.length === 0) return false;
  const result = await executor.query(
    'SELECT annee FROM anneeacademique WHERE id = $1',
    [anneeAcademiqueId]
  );
  const annee = result.rows[0]?.annee;
  return anneesSuspendues.includes(annee);
}

module.exports = { isKitSuspenduPourAnnee };

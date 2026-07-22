// Génération de code de paiement unique, partagée entre inscription et réinscription — le
// caissier retrouve un dossier (admission ou réinscription) avec le même geste, quel que soit
// le préfixe. Chaque appelant reste responsable de sa propre requête d'upsert/insert ; ce
// service ne fait que fournir un candidat et gérer le retry en cas de collision UNIQUE (23505),
// plus fiable qu'un simple comptage pour un code qui, s'il se trompe de destinataire, égarerait
// un vrai paiement.
const genererCodeCandidat = (prefixe) => {
  const annee = new Date().getFullYear();
  const alea = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `${prefixe}-${annee}-${alea}`;
};

const avecRetryCodeUnique = async (prefixe, tenterInsertion, maxTentatives = 8) => {
  for (let tentative = 0; tentative < maxTentatives; tentative++) {
    const candidat = genererCodeCandidat(prefixe);
    try {
      return await tenterInsertion(candidat);
    } catch (err) {
      if (err.code === '23505') continue;
      throw err;
    }
  }
  throw new Error("Impossible de générer un code de paiement unique après plusieurs tentatives.");
};

module.exports = { genererCodeCandidat, avecRetryCodeUnique };

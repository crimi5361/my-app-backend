// Génération et validation de l'e-mail institutionnel étudiant (etudiant.email — colonne de
// CONNEXION, distincte de email_personnel, jamais vérifiée pour l'unicité avant ce chantier) —
// point central unique, réutilisé par les 3 sites de création (admission agent, admission web,
// équivalence) et par la mise à jour manuelle (réinscription agent/self-service/vérification, via
// traiterDemandeReinscription).
//
// Corrige deux bugs de production confirmés (audit du 2026-09-11) :
// 1. Un prénom commençant par un espace produisait un préfixe vide (".draman@iipea.com") — cause :
//    `prenoms.split(' ')[0]` renvoie "" si `prenoms` commence par un espace.
// 2. Aucune vérification d'unicité nulle part : deux étudiants pouvaient recevoir le même e-mail
//    de connexion (génération dupliquée pour deux homonymes, ou saisie manuelle non contrôlée à la
//    réinscription), permettant à l'un de se connecter au compte de l'autre.
//
// Convention d'e-mail institutionnel (prenom.nom@iipea.com) inchangée — seule la normalisation qui
// permettait les malformations est corrigée ici.
const DOMAINE_INSTITUTIONNEL = '@iipea.com';

// Comparaison insensible à la casse ET aux espaces (y compris tabulations/retours à la ligne,
// contrairement à TRIM() en SQL qui ne retire que l'espace simple — cause d'un doublon ayant
// failli échapper à la requête de diagnostic lors de l'audit).
const normaliserEmail = (email) => (email || '').trim().toLowerCase();

// Nettoyage d'un composant de nom : accents retirés, espaces internes -> point, jamais de point
// parasite en tête/fin (cause exacte du bug ".draman@iipea.com").
const nettoyerComposant = (valeur) =>
  (valeur || '')
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .toLowerCase();

// Premier prénom réellement présent après nettoyage — jamais un simple `split(' ')[0]`, qui
// renvoie une chaîne vide si `prenoms` commence par un espace (cause exacte du bug de production).
const premierPrenomNettoye = (prenoms) => {
  const premierToken = (prenoms || '').trim().split(/\s+/).find(Boolean) || '';
  return nettoyerComposant(premierToken);
};

// Génère l'e-mail institutionnel `prenom.nom@iipea.com` et garantit son unicité par tentatives
// successives numérotées — même patron que services/codePaiement.service.js::avecRetryCodeUnique,
// adapté à une numérotation déterministe plutôt qu'aléatoire (un homonyme est prévisible, pas un
// évènement rare à retirer au hasard). `client` est le client pg (transaction en cours) ou le pool
// — n'importe quel objet exposant `.query()`.
async function genererEmailInstitutionnelUnique(client, { nom, prenoms }) {
  const prenomPart = premierPrenomNettoye(prenoms);
  const nomPart = nettoyerComposant(nom);
  if (!prenomPart || !nomPart) {
    throw new Error("Impossible de générer l'e-mail institutionnel : nom ou prénom insuffisant après nettoyage.");
  }
  const base = `${prenomPart}.${nomPart}`;

  for (let tentative = 0; tentative < 50; tentative++) {
    const candidat = `${base}${tentative === 0 ? '' : tentative + 1}${DOMAINE_INSTITUTIONNEL}`;
    const existe = await client.query('SELECT 1 FROM etudiant WHERE LOWER(TRIM(email)) = $1', [normaliserEmail(candidat)]);
    if (existe.rows.length === 0) return candidat;
  }
  throw new Error("Impossible de générer un e-mail institutionnel unique après plusieurs tentatives.");
}

// Vérifie qu'un e-mail (déjà fourni par l'utilisateur, pas généré) n'appartient pas à un AUTRE
// étudiant. `etudiantIdAExclure` permet à un étudiant de conserver/resoumettre son propre e-mail
// sans être refusé comme s'il était son propre doublon.
async function emailDejaUtiliseParAutreEtudiant(client, { email, etudiantIdAExclure = null }) {
  const emailNormalise = normaliserEmail(email);
  if (!emailNormalise) return false;
  const params = [emailNormalise];
  let condition = 'LOWER(TRIM(email)) = $1';
  if (etudiantIdAExclure != null) {
    params.push(etudiantIdAExclure);
    condition += ' AND id != $2';
  }
  const result = await client.query(`SELECT 1 FROM etudiant WHERE ${condition}`, params);
  return result.rows.length > 0;
}

module.exports = {
  normaliserEmail,
  genererEmailInstitutionnelUnique,
  emailDejaUtiliseParAutreEtudiant,
};

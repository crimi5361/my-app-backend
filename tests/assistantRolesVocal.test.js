// Ce que ce fichier protège : la liste des rôles autorisés à parler à
// l'assistante existe en DEUX exemplaires, un par côté, et ils doivent rester
// identiques.
//
//   serveur   assistantVocal.service.js   ROLES_AUTORISES   -> refuse le WebSocket
//   client    lib/ContexteVocal.tsx       ROLES_ASSISTANT   -> affiche ou non la mascotte
//
// POURQUOI DEUX LISTES. Le serveur ne peut pas décider ce que le navigateur
// affiche, et le navigateur ne peut pas décider qui a le droit de se connecter.
// Le contrôle d'accès réel est celui du serveur ; celui du client évite
// seulement de montrer une porte fermée.
//
// LE RISQUE EST ASYMÉTRIQUE. Ajouter un rôle côté client sans l'ajouter côté
// serveur affiche une mascotte qui, une fois cliquée, se heurte à un 403 : le
// fondateur d'une autre école verrait une fonction qui ne marche pas. L'oubli
// inverse est bénin — la fonction existe mais reste invisible.
//
// Ce test lit les deux fichiers et compare. C'est grossier, et c'est voulu :
// il n'exige aucun outillage de test côté frontend, qui n'en a aucun.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const lire = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

/**
 * Extrait les chaînes d'un `new Set([...])` affecté à une constante donnée.
 *
 * Découpage par index plutôt que par expression régulière construite : une
 * regex assemblée dans un gabarit demande deux niveaux d'échappement, et se
 * casse silencieusement au moindre outil qui en consomme un. Ici, aucun
 * échappement n'est nécessaire.
 */
function rolesDe(source, nomConstante) {
  const debut = source.indexOf(`${nomConstante} = new Set([`);
  assert.ok(debut >= 0,
    `constante ${nomConstante} introuvable — si elle a été renommée, mettre ce test à jour`);

  const crochet = source.indexOf('[', debut);
  const fin = source.indexOf(']', crochet);
  assert.ok(fin > crochet, `déclaration de ${nomConstante} illisible`);

  const contenu = source.slice(crochet + 1, fin);
  return [...contenu.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).sort();
}

test('les rôles autorisés sont les mêmes des deux côtés', () => {
  const serveur = rolesDe(lire('services/assistantVocal.service.js'), 'ROLES_AUTORISES');
  const client = rolesDe(
    lire('../my-app-frontend/src/lib/ContexteVocal.tsx'), 'ROLES_ASSISTANT',
  );

  assert.deepStrictEqual(client, serveur,
    `Le navigateur afficherait la mascotte à des rôles que le serveur refuse, `
    + `ou l'inverse.\n  serveur : ${serveur.join(', ')}\n  client  : ${client.join(', ')}`);
});

test('la liste n\'est pas vide et ne contient pas de rôle inattendu', () => {
  const serveur = rolesDe(lire('services/assistantVocal.service.js'), 'ROLES_AUTORISES');
  assert.ok(serveur.length > 0, 'plus personne ne pourrait parler à l\'assistante');
  // Garde-fou de bon sens : ces rôles-là n'ont rien à faire dans la liste.
  for (const interdit of ['etudiant', 'enseignant', 'caissier']) {
    assert.ok(!serveur.includes(interdit),
      `${interdit} ne doit pas avoir accès à l'assistante du fondateur`);
  }
});

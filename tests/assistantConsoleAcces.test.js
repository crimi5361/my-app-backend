// Ce que ce fichier protège : la console d'administration ne doit JAMAIS
// s'ouvrir au fondateur.
//
// POURQUOI C'EST PLUS QU'UNE QUESTION DE DROITS. Le fondateur a accès à tout le
// reste de l'assistante — c'est son outil. Mais ces écrans-là parlent de
// modèles, de crédits, de facturation et de repli : précisément ce qu'il ne doit
// jamais apprendre, et que l'instruction système s'applique à taire jusque sous
// la question directe. Une seule route ouverte par distraction — `authorizeRoles`
// recopié depuis la ligne du dessus, où « fondateur » figure légitimement —
// annulerait tout cet effort en un coup d'œil sur un écran.
//
// Le contrôle se fait sur le TEXTE des routes et non sur le routeur monté : les
// intergiciels d'Express sont des fermetures, et les rôles qu'ils portent ne
// sont plus lisibles une fois la fabrique appelée. Lire la source est ici le
// moyen le plus direct de vérifier ce qui est réellement écrit.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'assistant.routes.js'),
  'utf8',
);

/**
 * Découpe le fichier en appels de route : chemin déclaré, puis tout ce qui suit
 * jusqu'à la parenthèse fermante de l'appel.
 */
function routes() {
  const trouvees = [];
  const motif = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'([\s\S]*?)\n\);/g;
  let m = motif.exec(SOURCE);
  while (m) {
    trouvees.push({ methode: m[1], chemin: m[2], corps: m[3] });
    m = motif.exec(SOURCE);
  }
  return trouvees;
}

test('le fichier de routes est bien lu et contient des routes de console', () => {
  const toutes = routes();
  assert.ok(toutes.length >= 8, `seulement ${toutes.length} routes reconnues — le motif d'analyse a dû se désaccorder`);
  assert.ok(
    toutes.some((r) => r.chemin.startsWith('/console/')),
    'aucune route de console trouvée : ce test ne protège plus rien',
  );
});

test('aucune route de console n\'est ouverte au fondateur', () => {
  for (const r of routes().filter((x) => x.chemin.startsWith('/console/'))) {
    assert.ok(
      /authorizeRoles\(\s*'admin'\s*\)/.test(r.corps),
      `${r.methode.toUpperCase()} ${r.chemin} : attendu authorizeRoles('admin') seul`,
    );
    assert.ok(
      !/fondateur/.test(r.corps),
      `${r.methode.toUpperCase()} ${r.chemin} : le fondateur ne doit jamais entrer dans la console`,
    );
  }
});

test('toute route de console exige une authentification', () => {
  for (const r of routes().filter((x) => x.chemin.startsWith('/console/'))) {
    assert.ok(
      /authenticateToken/.test(r.corps),
      `${r.methode.toUpperCase()} ${r.chemin} : route non authentifiée`,
    );
  }
});

// Le pendant du test précédent : l'assistante elle-même doit RESTER ouverte au
// fondateur. Verrouiller la console en fermant le chat par la même occasion
// serait une régression silencieuse, et personne ne s'en apercevrait avant lui.
test('le chat de l\'assistante reste ouvert au fondateur', () => {
  const chat = routes().find((r) => r.chemin === '/chat');
  assert.ok(chat, 'route /chat introuvable');
  assert.match(chat.corps, /authorizeRoles\([^)]*'fondateur'[^)]*\)/);
});

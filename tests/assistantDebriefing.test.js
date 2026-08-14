// Assemblage du débriefing de la veille (2026-08-14).
//
// Les requêtes SQL sont vérifiées contre la base réelle ; ce qui se teste ici,
// c'est ce que le fondateur VOIT — la forme des graphiques envoyés à l'écran, et
// la façon dont les montants se prononcent.
//
// Point vérifié en priorité : PostgreSQL renvoie `numeric` et `bigint` sous
// forme de CHAÎNES. Un graphique alimenté sans conversion trace des barres vides
// sans rien signaler, ce qui est le pire des cas — un écran qui a l'air de
// marcher et qui ment.
const test = require('node:test');
const assert = require('node:assert/strict');
const { construireGraphiques, montantLisible } = require('../services/assistantDebriefing.service');

const jeuComplet = {
  parJour: [
    { jour: '2026-08-10', actes: '4' },
    { jour: '2026-08-11', actes: '12' },
    { jour: '2026-08-12', actes: 7 },
  ],
  parActe: [
    { acte: 'Encaissement', domaine: 'Caisse', actes: '9', montant: '450000.00' },
    { acte: "Inscription d'un étudiant", domaine: 'Scolarité', actes: 3, montant: null },
  ],
  parAgent: [
    { agent: 'ABDALLA SALIM', role: 'caissier', actes: '9' },
    { agent: 'KOUAME AKISSI', role: 'scolarite', actes: 3 },
  ],
  veille: 12,
  moyenne: 7.5,
};

test('les quatre graphiques attendus sont produits', () => {
  const g = construireGraphiques(jeuComplet);
  const titres = g.map((x) => x.visualisation.titre);
  assert.equal(g.length, 4);
  assert.ok(titres.some((t) => /derniers jours/.test(t)), 'la tendance sur 14 jours');
  assert.ok(titres.some((t) => /type d'acte/.test(t)), 'la répartition par acte');
  assert.ok(titres.some((t) => /plus actifs/.test(t)), 'les agents les plus actifs');
  assert.ok(titres.some((t) => /comparée à la semaine/.test(t)), 'la comparaison hebdomadaire');
});

test('les valeurs sont des NOMBRES, pas les chaînes rendues par PostgreSQL', () => {
  // Sans cette conversion, Recharts trace des barres vides en silence.
  for (const graphique of construireGraphiques(jeuComplet)) {
    for (const ligne of graphique.donnees) {
      for (const serie of graphique.visualisation.series) {
        assert.equal(
          typeof ligne[serie.colonne], 'number',
          `${graphique.visualisation.titre} : ${serie.colonne} doit être un nombre`,
        );
      }
    }
  }
});

test('chaque graphique cite des colonnes qui existent dans ses données', () => {
  // Une spécification qui cite une colonne absente produit un graphique vide.
  for (const graphique of construireGraphiques(jeuComplet)) {
    const colonnes = new Set(Object.keys(graphique.donnees[0]));
    assert.ok(colonnes.has(graphique.visualisation.axe_x), `axe_x manquant : ${graphique.visualisation.axe_x}`);
    for (const serie of graphique.visualisation.series) {
      assert.ok(colonnes.has(serie.colonne), `série manquante : ${serie.colonne}`);
    }
  }
});

test('la comparaison à la semaine est toujours présente, même sans autre donnée', () => {
  // C'est elle qui dit si la journée sort de l'ordinaire : elle ne dépend
  // d'aucune ventilation.
  const g = construireGraphiques({ parJour: [], parActe: [], parAgent: [], veille: 3, moyenne: 1 });
  assert.equal(g.length, 1);
  assert.equal(g[0].donnees.length, 2);
  assert.deepEqual(g[0].donnees.map((l) => l.periode), ['Hier', 'Moyenne 7 jours']);
});

test('une tendance d\'un seul point n\'est pas tracée', () => {
  // Une courbe à un point ne dit rien et se lit comme un bug d'affichage.
  const g = construireGraphiques({ ...jeuComplet, parJour: [{ jour: '2026-08-12', actes: 7 }] });
  assert.ok(!g.some((x) => /derniers jours/.test(x.visualisation.titre)));
});

test('les dates de l\'axe sont abrégées pour tenir sur quatorze points', () => {
  const g = construireGraphiques(jeuComplet);
  const tendance = g.find((x) => /derniers jours/.test(x.visualisation.titre));
  assert.match(tendance.donnees[0].jour, /^\d{2}\/\d{2}$/);
});

// ── Montants prononcés ─────────────────────────────────────────────────────

test('les montants se prononcent, ils ne se lisent pas chiffre à chiffre', () => {
  assert.equal(montantLisible(1931320000), '1,93 milliard de francs');
  assert.equal(montantLisible(2500000000), '2,50 milliards de francs');
  assert.equal(montantLisible(4500000), '4,5 millions de francs');
  assert.equal(montantLisible(1200000), '1,2 million de francs');
  assert.equal(montantLisible(0), '0 francs');
});

test('un montant reçu en chaîne est traité comme un nombre', () => {
  assert.equal(montantLisible('450000.00'), montantLisible(450000));
});

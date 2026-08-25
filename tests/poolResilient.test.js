// Ce que ce fichier protège : le serveur ne doit JAMAIS s'arrêter parce qu'une
// connexion PostgreSQL a été coupée.
//
// Le défaut d'origine ne venait pas du code applicatif mais de `pg` : dès qu'un
// client est emprunté au pool, `pg` lui retire son écouteur d'erreur. Une coupure
// pendant l'emprunt devenait alors un événement 'error' sans écouteur — et Node
// tue le processus dans ce cas. Le 2026-08-21, le backend est tombé ainsi
// (« server conn crashed? », code 08P01).
//
// Les tests ci-dessous n'ouvrent aucune connexion : ils simulent le pool, ce qui
// leur permet de reproduire exactement la coupure, sans réseau ni base.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { protegerPool } = require('../config/poolResilient');

/** Imite ce que fait `pg` : un client sans écouteur d'erreur une fois emprunté. */
function faussePool() {
  const client = new EventEmitter();
  client.relache = 0;
  client.release = function release() { this.relache += 1; };

  const pool = new EventEmitter();
  pool.connect = function connect(rappel) {
    if (typeof rappel === 'function') { rappel(null, client, () => {}); return undefined; }
    return Promise.resolve(client);
  };
  return { pool, client };
}

test('un client emprunté porte un écouteur : la coupure ne tue pas le processus', async () => {
  const { pool, client } = faussePool();
  protegerPool(pool, 'test');

  const emprunte = await pool.connect();
  assert.strictEqual(emprunte.listenerCount('error'), 1,
    "sans écouteur, l'événement 'error' arrêterait le processus");

  // Sans la protection, la ligne suivante ferait tomber le serveur.
  assert.doesNotThrow(() => emprunte.emit('error', new Error('server conn crashed?')));
  assert.strictEqual(client.relache, 0, 'la coupure ne relâche pas le client toute seule');
});

test("l'écouteur est retiré au retour du client : pas de fuite sur 50 emprunts", async () => {
  const { pool, client } = faussePool();
  protegerPool(pool, 'test');

  for (let i = 0; i < 50; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const c = await pool.connect();
    c.release();
  }
  assert.strictEqual(client.listenerCount('error'), 0,
    'un écouteur par emprunt finirait par déclencher un avertissement de fuite');
  assert.strictEqual(client.relache, 50, 'chaque release atteint bien la fonction d\'origine');
});

test('le pool lui-même écoute ses connexions au repos', async () => {
  const { pool } = faussePool();
  protegerPool(pool, 'test');
  assert.strictEqual(pool.listenerCount('error'), 1);
  assert.doesNotThrow(() => pool.emit('error', new Error('connexion au repos coupée')));
});

test('la forme à rappel reste utilisable (elle sert au démarrage)', (t, fini) => {
  const { pool } = faussePool();
  protegerPool(pool, 'test');
  pool.connect((err, client, release) => {
    assert.strictEqual(err, null);
    assert.ok(client);
    assert.strictEqual(typeof release, 'function');
    fini();
  });
});

test('release reste protégé contre un double appel', async () => {
  const { pool, client } = faussePool();
  protegerPool(pool, 'test');
  const c = await pool.connect();
  c.release();
  assert.doesNotThrow(() => c.release());
  assert.strictEqual(client.listenerCount('error'), 0);
});

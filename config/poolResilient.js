// Protection des connexions empruntées au pool (2026-08-21).
//
// LE DÉFAUT QU'ON CORRIGE. Dans `pg`, un client au repos dans le pool porte un
// écouteur d'erreur ; dès qu'on l'emprunte avec `pool.connect()`, `pg` le RETIRE
// (pg-pool/index.js, `_acquireClient` : `client.removeListener('error', idleListener)`).
// Pendant toute la durée de l'emprunt, le client n'a donc plus aucun écouteur.
// Si la connexion tombe à ce moment-là — Neon coupe une connexion, le compute
// redémarre, le réseau lâche — Node voit un événement 'error' non géré et TUE le
// processus. Le backend entier s'arrête, sans rapport avec la requête en cours.
//
// Constaté le 2026-08-21 : `error: server conn crashed?` (code 08P01, severity
// FATAL), processus terminé. Le code applicatif n'y est pour rien et ne peut rien
// y faire : son `try/catch` n'attrape pas un événement, seulement une exception.
//
// POURQUOI ICI ET PAS DANS CHAQUE CONTRÔLEUR. Le projet compte plus de soixante-dix
// `db.connect()`. Les corriger un par un, c'est soixante-dix occasions d'en oublier
// un — et un seul oubli suffit à faire tomber le serveur. On pose donc la garantie
// à l'endroit unique par lequel tous passent.
//
// L'erreur n'est pas avalée : elle est journalisée, et la requête en cours échoue
// normalement par sa propre voie (l'appel `query` rejette). `pg` retire de lui-même
// le client cassé quand on le relâche.
function protegerPool(pool, etiquette) {
  // Connexion au repos coupée par le serveur : sans cet écouteur, même issue.
  pool.on('error', (err) => {
    console.warn(`⚠️ [${etiquette}] connexion au repos perdue : ${err.message}`);
  });

  const connecterOrigine = pool.connect.bind(pool);

  pool.connect = function connecterProtege(...args) {
    // Forme à rappel (`pool.connect((err, client, release) => ...)`) : on la
    // laisse telle quelle, elle n'est utilisée qu'au démarrage.
    if (typeof args[0] === 'function') return connecterOrigine(...args);

    return connecterOrigine(...args).then((client) => {
      const garde = (err) => {
        console.warn(`⚠️ [${etiquette}] connexion perdue en cours d'usage : ${err.message}`);
      };
      client.on('error', garde);

      // L'écouteur doit partir au retour du client : `pg` réattache le sien, et
      // sans ce retrait on empilerait un écouteur par emprunt jusqu'à
      // l'avertissement de fuite de mémoire.
      const relacherOrigine = client.release;
      client.release = function relacherProtege(...a) {
        client.removeListener('error', garde);
        client.release = relacherOrigine;
        return relacherOrigine.apply(client, a);
      };

      return client;
    });
  };

  return pool;
}

module.exports = { protegerPool };

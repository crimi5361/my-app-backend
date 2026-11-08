// ============================================================================
//  Réception des événements de l'Application B (contrat v0.2, §6 du guide)
//
//  Chaque POST porte un en-tête Idempotency-Key. Même clé + même contenu = rejeu : A renvoie
//  l'accusé initial, sans nouvel effet. Même clé + contenu différent = 409. Un événement reçu
//  est enregistré (statut « recu », réponse 202) ; son intégration dans les tables de A est
//  faite par le traitement de son type (`traitements`), qui fixe le statut final de l'accusé
//  (« integre », « rejete », « rejete_partiellement ») ; B le relit par GET /evenements/{id}.
// ============================================================================

const pool = require('../../config/db.config');
const { empreinte } = require('./lecture');

/** Route → type d'événement attendu dans le corps et scope exigé du jeton. */
const RECEPTIONS = {
  'affectations-publiees': { type: 'affectation_publiee', scope: 'affectations:write' },
  'edt-publie': { type: 'edt_publie', scope: 'edt:write' },
  'notes-validees': { type: 'notes_validees', scope: 'notes:write' },
  'supports-publies': { type: 'support_publie', scope: 'supports:write' },
  'fiches-enseignants': { type: 'fiche_enseignant', scope: 'enseignants:write' },
  'campagnes-evaluation': { type: 'campagne_evaluation', scope: 'evaluations:write' },
  'service-fait-valide': { type: 'service_fait_valide', scope: 'servicefait:write' },
};

/** Traitements par type, branchés au fur et à mesure (blocs suivants). */
const traitements = {};

const isoOuNull = (date) => (date ? new Date(date).toISOString() : null);

function accuse(ligne) {
  return {
    id_reception: ligne.id_reception,
    cle_idempotence: ligne.cle_idempotence,
    statut: ligne.statut,
    recu_le: isoOuNull(ligne.recu_le),
    traite_le: isoOuNull(ligne.traite_le),
    rejets: ligne.rejets || [],
  };
}

class ErreurEvenement extends Error {
  constructor(statut, code, message) {
    super(message);
    this.statut = statut;
    this.code = code;
  }
}

/** Enregistre (ou rejoue) un événement ; retourne { statutHttp, accuse }. */
async function recevoir(cleRoute, cle, corps) {
  const reception = RECEPTIONS[cleRoute];
  if (!reception) throw new ErreurEvenement(404, 'INTROUVABLE', 'Route inconnue.');
  if (!cle || cle.length < 10 || cle.length > 200) {
    throw new ErreurEvenement(400, 'CLE_IDEMPOTENCE_ABSENTE', 'En-tête Idempotency-Key obligatoire.');
  }
  if (!corps || typeof corps !== 'object' || Array.isArray(corps)) {
    throw new ErreurEvenement(400, 'CORPS_INVALIDE', 'Corps JSON invalide.');
  }
  if (corps.type !== reception.type) {
    throw new ErreurEvenement(400, 'TYPE_INVALIDE', "Type d'événement incohérent avec la route.");
  }
  const signature = empreinte(corps);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insere = await client.query(
      `INSERT INTO integration_b_evenement (cle_idempotence, type, empreinte, corps)
       VALUES ($1, $2, $3, $4) ON CONFLICT (cle_idempotence) DO NOTHING RETURNING *`,
      [cle, reception.type, signature, corps]
    );
    if (!insere.rowCount) {
      const { rows } = await client.query(
        'SELECT * FROM integration_b_evenement WHERE cle_idempotence = $1', [cle]
      );
      await client.query('COMMIT');
      if (rows[0].empreinte !== signature) {
        throw new ErreurEvenement(409, 'CLE_DEJA_UTILISEE', "Clé d'idempotence déjà utilisée.");
      }
      return { statutHttp: rows[0].statut === 'recu' ? 202 : 200, accuse: accuse(rows[0]) };
    }
    let ligne = insere.rows[0];
    const traiter = traitements[reception.type];
    if (traiter) {
      // Intégration dans la même transaction : tout ou rien.
      const { statut, rejets } = await traiter(client, corps);
      const maj = await client.query(
        `UPDATE integration_b_evenement SET statut = $2, rejets = $3, traite_le = now()
         WHERE id = $1 RETURNING *`,
        [ligne.id, statut, JSON.stringify(rejets || [])]
      );
      ligne = maj.rows[0];
    }
    await client.query('COMMIT');
    return { statutHttp: ligne.statut === 'recu' ? 202 : 200, accuse: accuse(ligne) };
  } catch (erreur) {
    await client.query('ROLLBACK').catch(() => {});
    throw erreur;
  } finally {
    client.release();
  }
}

async function lireAccuse(idReception) {
  const { rows } = await pool.query(
    'SELECT * FROM integration_b_evenement WHERE id_reception::text = $1', [String(idReception)]
  );
  return rows.length ? accuse(rows[0]) : null;
}

module.exports = { RECEPTIONS, traitements, recevoir, lireAccuse, ErreurEvenement };

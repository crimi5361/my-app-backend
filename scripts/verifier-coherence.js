#!/usr/bin/env node
/**
 * Harnais de vérification de la cohérence de l'assistant.
 *
 * POURQUOI IL EXISTE. Le fondateur signalait des chiffres faux sans pouvoir dire
 * lesquels. Une impression ne se corrige pas : elle se mesure. Ce script pose à
 * l'assistante des questions dont on connaît la réponse, et met les deux côte à
 * côte.
 *
 * CE N'EST PAS DU CODE APPLICATIF. Rien dans le serveur ne l'appelle ; il n'est
 * pas chargé au démarrage. Il vit ici pour être rejouable après chaque
 * modification du prompt ou des vues.
 *
 * DEUX CANAUX. Le canal texte (`--canal=texte`, par défaut) passe par
 * POST /api/assistant/chat. Le canal vocal (`--canal=vocal`) passe par le
 * WebSocket et injecte la question en texte : c'est le même modèle Live, les
 * mêmes outils et le même prompt que la voix, sans avoir à parler.
 *
 * Le distinguo compte, et pas seulement par commodité : les deux canaux
 * s'appuient sur des MODÈLES DIFFÉRENTS, donc sur des quotas Google distincts.
 * Le 25 août 2026, le canal texte était bloqué (20 requêtes par jour sur le
 * palier gratuit) pendant que le vocal répondait normalement.
 *
 *   node scripts/verifier-coherence.js
 *   node scripts/verifier-coherence.js --canal=vocal
 *   node scripts/verifier-coherence.js --seulement=1,2,5
 *   node scripts/verifier-coherence.js --pause=8000
 *
 * Le script n'écrit rien, ne modifie rien, et n'interroge la base qu'en lecture
 * par le rôle `assistant_ro` — exactement comme l'assistante.
 */
const path = require('path');

const envFile = `.env.${process.env.NODE_ENV === 'production' ? 'production' : 'local'}`;
require('dotenv').config({ path: path.resolve(__dirname, '..', envFile) });

const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { executerRequete } = require('../services/assistantSql.service');

// ---------------------------------------------------------------------------
//  Les cas de vérification
// ---------------------------------------------------------------------------
//
// `attendu` est une requête SQL de RÉFÉRENCE, écrite à la main sur les vues du
// schéma assistant, avec les mêmes filtres que l'assistante doit appliquer.
// `extraire` isole, dans la réponse en français, le ou les nombres à comparer.
//
// TOLÉRANCE. L'assistante répond à l'oral : « environ 1,67 milliard » est une
// réponse JUSTE pour 1 668 089 662,50. On compare donc à une tolérance relative,
// pas à l'identique — sinon le harnais signalerait comme faux ce qui est
// correctement arrondi.
const CAS = [
  {
    id: 1,
    question: "Combien d'étudiants inscrits avons-nous ?",
    attendu: "SELECT count(*)::int AS v FROM assistant.v_etudiants WHERE standing = 'Inscrit'",
    tolerance: 0,
  },
  {
    id: 2,
    question: 'Quel est le taux de recouvrement de la scolarité ?',
    attendu: 'SELECT ROUND(100.0 * SUM(scolarite_verse) / NULLIF(SUM(montant_scolarite), 0), 2) AS v '
      + 'FROM assistant.v_etudiants',
    tolerance: 0.02,
    unite: '%',
  },
  {
    id: 3,
    question: 'Quel est le montant total encaissé ?',
    attendu: 'SELECT SUM(scolarite_verse)::numeric AS v FROM assistant.v_etudiants',
    tolerance: 0.01,
    unite: 'FCFA',
  },
  {
    id: 4,
    question: 'Combien y a-t-il de femmes parmi les étudiants inscrits ?',
    attendu: "SELECT count(*)::int AS v FROM assistant.v_etudiants "
      + "WHERE standing = 'Inscrit' AND sexe = 'Féminin'",
    tolerance: 0,
  },
  {
    id: 5,
    question: "Combien d'étudiants inscrits compte la plus grande école ?",
    attendu: "SELECT count(*)::int AS v FROM assistant.v_etudiants WHERE standing = 'Inscrit' "
      + 'GROUP BY ecole ORDER BY 1 DESC LIMIT 1',
    tolerance: 0,
  },
  {
    id: 6,
    question: "Combien d'agents travaillent sur le site ?",
    attendu: 'SELECT count(*)::int AS v FROM assistant.v_agents',
    tolerance: 0,
  },
  {
    id: 7,
    question: "Combien d'enseignants avons-nous ?",
    attendu: 'SELECT count(*)::int AS v FROM assistant.t_professeur',
    tolerance: 0,
    note: 'Piège : v_enseignants rend 0. La bonne source est t_professeur.',
  },
  {
    id: 8,
    question: 'Combien de notes sont enregistrées dans la base ?',
    attendu: 'SELECT count(*)::int AS v FROM assistant.t_note',
    tolerance: 0,
  },
  {
    id: 9,
    question: "Combien d'étudiants ont une photo ?",
    attendu: 'SELECT count(*)::int AS v FROM assistant.v_etudiants WHERE a_photo',
    tolerance: 0,
  },
  {
    id: 10,
    question: 'Quel est le montant restant à recouvrer ?',
    // `scolarite_restante` et NON `montant_scolarite - scolarite_verse`.
    // Les deux diffèrent de 31 660 104,50 FCFA, soit EXACTEMENT le total des
    // 222 prises en charge validées : une PEC creuse l'écart entre ce qui est dû
    // et ce qui est versé, mais elle n'est pas recouvrable. « Restant à
    // recouvrer » désigne ce qu'on peut encore encaisser.
    // La première version de ce cas utilisait la soustraction et signalait
    // l'assistante comme fausse. C'est le harnais qui avait tort.
    attendu: 'SELECT SUM(scolarite_restante)::numeric AS v FROM assistant.v_etudiants',
    tolerance: 0.01,
    unite: 'FCFA',
    note: 'Les prises en charge validées ne sont pas recouvrables : elles sortent du reste à percevoir.',
  },
];

// ---------------------------------------------------------------------------
//  Lecture des nombres dans une phrase française
// ---------------------------------------------------------------------------
//
// L'assistante parle : « environ 1,67 milliard de francs CFA », « 7 208 étudiants ».
// Il faut donc lire les séparateurs de milliers (espace fine ou insécable), la
// virgule décimale, et les multiplicateurs écrits en toutes lettres.
const MULTIPLICATEURS = [
  [/milliards?/i, 1e9],
  [/millions?/i, 1e6],
  [/mille/i, 1e3],
];

// Nombres ÉCRITS EN TOUTES LETTRES. L'instruction demande à l'assistante de
// prononcer naturellement : elle répond « trente-trois agents » ou « mille huit
// cent quatorze étudiants ». Une première version du harnais ne lisait que les
// chiffres et signalait donc ces réponses — justes — comme fausses.
const UNITES = {
  zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7,
  huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14,
  quinze: 15, seize: 16, vingt: 20, vingts: 20, trente: 30, quarante: 40, cinquante: 50,
  soixante: 60, cent: 100, cents: 100,
};
const ECHELLES = { mille: 1e3, milles: 1e3, million: 1e6, millions: 1e6, milliard: 1e9, milliards: 1e9 };

/** Somme les nombres en toutes lettres présents dans une phrase. */
function nombresEnLettres(texte) {
  const mots = texte.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z]+/).filter(Boolean);

  const trouves = [];
  let total = 0;      // ce qui est déjà multiplié par une échelle
  let courant = 0;    // le groupe en cours
  let vu = false;

  const cloturer = () => {
    if (vu && (total + courant) > 0) trouves.push(total + courant);
    total = 0; courant = 0; vu = false;
  };

  for (const mot of mots) {
    if (mot === 'et') continue;                       // « vingt et un »
    if (Object.prototype.hasOwnProperty.call(UNITES, mot)) {
      const v = UNITES[mot];
      if (v === 100) {
        // « deux cents » : cent multiplie le groupe en cours plutôt que s'y ajouter.
        courant = (courant || 1) * 100;
      } else if ((mot === 'vingt' || mot === 'vingts') && courant % 100 === 4) {
        // « quatre-vingt » vaut 80, pas 4 + 20. Sans cette règle,
        // « quatre-vingt-treize » se lisait 37 : c'est ainsi que le harnais
        // signalait comme fausse la réponse « cent cinq mille quatre cent
        // quatre-vingt-treize », qui valait bien 105 493.
        courant = courant - 4 + 80;
      } else {
        courant += v;
      }
      vu = true;
    } else if (Object.prototype.hasOwnProperty.call(ECHELLES, mot)) {
      // « mille » s'emploie seul (« mille huit cents ») ; « million » et
      // « milliard » exigent un nombre devant. Sans cette distinction, la phrase
      // « 1 milliard 668 millions » — dont les nombres sont en CHIFFRES — était
      // relue ici comme « milliard + million » et donnait 1 001 000 000.
      const echelle = ECHELLES[mot];
      if (courant === 0 && echelle > 1e3) { cloturer(); continue; }
      total += (courant || 1) * echelle;
      courant = 0;
      vu = true;
    } else {
      cloturer();
    }
  }
  cloturer();
  return trouves;
}

function nombresDe(texte) {
  const trouves = [];
  // Chaque occurrence garde son ECHELLE : l assistante ecrit aussi des formes
  // composees, « 1 milliard 668 millions ». Lues separement elles donnent deux
  // nombres faux la ou la phrase en enonce un seul, juste.
  const parts = [];
  const motif = /(\d[\d    .]*(?:,\d+)?)\s*(milliards?|millions?|mille)?/gi;
  let m = motif.exec(texte);
  while (m !== null) {
    const brut = m[1].replace(/[    .]/g, '').replace(',', '.');
    const base = Number(brut);
    if (Number.isFinite(base)) {
      const mult = m[2] ? MULTIPLICATEURS.find(([re]) => re.test(m[2])) : null;
      const echelle = mult ? mult[1] : 1;
      parts.push({ valeur: base * echelle, echelle });
      trouves.push(base * echelle);
    }
    m = motif.exec(texte);
  }

  // Recomposition : des echelles STRICTEMENT decroissantes qui se suivent
  // decrivent un seul nombre. 1 x 1e9 puis 668 x 1e6 -> 1 668 000 000.
  for (let i = 0; i < parts.length; i += 1) {
    let somme = parts[i].valeur;
    let derniere = parts[i].echelle;
    for (let j = i + 1; j < parts.length && parts[j].echelle < derniere; j += 1) {
      somme += parts[j].valeur;
      derniere = parts[j].echelle;
      trouves.push(somme);
    }
  }
  return trouves;
}


/** Le bon nombre figure-t-il dans la réponse, à la tolérance près ? */
function comparer(texte, attendu, tolerance) {
  const candidats = [...nombresDe(texte), ...nombresEnLettres(texte)];
  if (!candidats.length) return { ok: false, trouve: null, ecart: null };

  let meilleur = null;
  for (const c of candidats) {
    const ecart = attendu === 0 ? Math.abs(c) : Math.abs(c - attendu) / Math.abs(attendu);
    if (meilleur === null || ecart < meilleur.ecart) meilleur = { valeur: c, ecart };
  }
  return { ok: meilleur.ecart <= tolerance, trouve: meilleur.valeur, ecart: meilleur.ecart };
}

// ---------------------------------------------------------------------------
//  Les deux canaux
// ---------------------------------------------------------------------------
function jetonFondateur() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET absente.');
  return jwt.sign(
    { id: 12, role: 'fondateur', departement_id: 1, ecole_id: null, code: 'COHERENCE' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const BASE = process.env.URL_API || 'http://localhost:5000';

async function poserAuChat(question, jeton) {
  const debut = Date.now();
  const r = await fetch(`${BASE}/api/assistant/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jeton}` },
    body: JSON.stringify({ message: question, history: [] }),
  });
  const j = await r.json().catch(() => ({}));
  return {
    message: j.message || `(HTTP ${r.status})`,
    requetes: (j.requetes || []).length,
    ms: Date.now() - debut,
    refus: !r.ok,
  };
}

/**
 * Une session Live par question. C'est volontairement coûteux en temps : garder
 * la session ouverte ferait porter à chaque question le contexte des
 * précédentes, et on ne mesurerait plus une réponse mais un enchaînement.
 */
function poserAuVocal(question, jeton) {
  return new Promise((resoudre) => {
    const debut = Date.now();
    const url = BASE.replace(/^http/, 'ws');
    const ws = new WebSocket(`${url}/ws/assistant-vocal`, ['jwt', jeton]);
    let message = '';
    let requetes = 0;
    let fini = false;

    const terminer = (texte, refus = false) => {
      if (fini) return;
      fini = true;
      try { ws.close(); } catch { /* déjà fermée */ }
      resoudre({ message: texte, requetes, ms: Date.now() - debut, refus });
    };

    ws.on('message', (donnees) => {
      let m;
      try { m = JSON.parse(donnees.toString()); } catch { return; }
      if (m.type === 'pret') {
        setTimeout(() => ws.send(JSON.stringify({ type: 'texte', texte: question })), 400);
      } else if (m.type === 'requete') {
        requetes += 1;
      } else if (m.type === 'transcription_assistant' && m.partiel === false) {
        message += (message ? ' ' : '') + m.texte;
      } else if (m.type === 'tour_termine') {
        setTimeout(() => terminer(message || '(aucune réponse)'), 900);
      } else if (m.type === 'erreur' || m.type === 'budget_depasse') {
        terminer(m.message || '(erreur)', true);
      }
    });
    ws.on('error', (e) => terminer(`(WebSocket : ${e.message})`, true));
    ws.on('close', () => terminer(message || '(session fermée sans réponse)', !message));
    setTimeout(() => terminer(message || '(délai dépassé)', !message), 120000);
  });
}

// ---------------------------------------------------------------------------
//  Rendu
// ---------------------------------------------------------------------------
const fr = (n) => (n === null || n === undefined ? '—'
  : Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 2 }));

function tableau(lignes) {
  const cols = [
    ['#', 3], ['Question', 44], ['Assistant', 17], ['SQL', 17], ['Écart', 10], ['', 4],
  ];
  const sep = cols.map(([, l]) => '─'.repeat(l + 2)).join('┼');
  const tete = cols.map(([t, l]) => ` ${t.padEnd(l)} `).join('│');
  console.log(tete);
  console.log(sep);
  for (const l of lignes) {
    const cells = [
      String(l.id).padEnd(3),
      (l.question.length > 44 ? `${l.question.slice(0, 41)}...` : l.question).padEnd(44),
      fr(l.trouve).padStart(17),
      fr(l.attendu).padStart(17),
      l.libelleEcart.padStart(10),
      (l.ok ? ' OK ' : l.refus ? 'REFU' : 'FAUX'),
    ];
    console.log(cells.map((c) => ` ${c} `).join('│'));
  }
}

// ---------------------------------------------------------------------------
(async () => {
  const args = process.argv.slice(2);
  const lire = (nom, defaut) => {
    const a = args.find((x) => x.startsWith(`--${nom}=`));
    return a ? a.split('=')[1] : defaut;
  };
  const canal = lire('canal', 'texte');
  const pause = Number(lire('pause', canal === 'texte' ? 4000 : 1500));
  const seulement = lire('seulement', null);
  const cas = seulement
    ? CAS.filter((c) => seulement.split(',').map(Number).includes(c.id))
    : CAS;

  console.log(`Vérification de cohérence — canal ${canal}, ${cas.length} cas, `
    + `pause ${pause} ms\n`);

  const jeton = jetonFondateur();
  const lignes = [];

  for (const c of cas) {
    // 1. La vérité, lue en base par le même rôle que l'assistante.
    // eslint-disable-next-line no-await-in-loop
    const ref = await executerRequete(c.attendu, { siteId: 1, ecoleId: null });
    if (!ref.ok) {
      console.log(`#${c.id} — requête de référence en échec : ${ref.motif}`);
      continue;
    }
    const attendu = Number(ref.lignes[0].v);

    // 2. La réponse de l'assistante.
    // eslint-disable-next-line no-await-in-loop
    const rep = canal === 'vocal'
      ? await poserAuVocal(c.question, jeton)
      : await poserAuChat(c.question, jeton);

    const cmp = rep.refus
      ? { ok: false, trouve: null, ecart: null }
      : comparer(rep.message, attendu, c.tolerance);

    lignes.push({
      id: c.id,
      question: c.question,
      attendu,
      trouve: cmp.trouve,
      ok: cmp.ok,
      refus: rep.refus,
      libelleEcart: cmp.ecart === null ? '—'
        : cmp.ecart === 0 ? 'exact'
          : `${(cmp.ecart * 100).toFixed(2)} %`,
      message: rep.message,
      requetes: rep.requetes,
      ms: rep.ms,
      note: c.note,
    });

    const etat = rep.refus ? 'REFUS' : cmp.ok ? 'OK' : 'ÉCART';
    console.log(`#${c.id} ${etat.padEnd(6)} ${(rep.ms / 1000).toFixed(1)} s, `
      + `${rep.requetes} requête(s) — ${rep.message.slice(0, 96)}`);

    // eslint-disable-next-line no-await-in-loop
    if (pause) await new Promise((r) => { setTimeout(r, pause); });
  }

  console.log('\n');
  tableau(lignes);

  const ko = lignes.filter((l) => !l.ok);
  console.log(`\n${lignes.length - ko.length} / ${lignes.length} conformes.`);
  if (ko.length) {
    console.log('\nÀ examiner :');
    ko.forEach((l) => {
      console.log(`  #${l.id} ${l.question}`);
      console.log(`     attendu ${fr(l.attendu)} — réponse : ${l.message.slice(0, 150)}`);
      if (l.note) console.log(`     ${l.note}`);
    });
  }
  process.exit(ko.length ? 1 : 0);
})().catch((e) => { console.error('ÉCHEC :', e.message); process.exit(2); });

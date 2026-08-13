// Assistant Fondateur — graphiques rasterisés pour les rapports Word (2026-08-13).
//
// Word n'a pas de format vectoriel exploitable simplement depuis docx : on rend
// donc les graphiques en PNG. Le tracé se fait à FACTEUR 2 puis l'image est
// insérée à sa taille nominale — sans ça, le graphique est net à l'écran mais
// crénelé à l'impression, qui est la destination réelle d'un rapport d'audit.
//
// Comme partout ailleurs dans l'assistant, aucune valeur ne vient du modèle :
// les séries sont les lignes renvoyées par SQL. Le modèle choisit quoi tracer.
const { createCanvas } = require('@napi-rs/canvas');

const FACTEUR = 2;

// Palette IIPEA — bleu marine du blason en tête, puis des teintes de luminosité
// proche pour rester distinguables côte à côte et en camembert.
const PALETTE = [
  '#1e4d82', '#a97723', '#2f9166', '#a4515f',
  '#6d4bb8', '#2f7d8f', '#b7791f', '#4a6fa5',
];
const ENCRE = '#101a33';
const ENCRE_DOUCE = '#5f6a80';
const GRILLE = 'rgba(16, 26, 51, 0.10)';

// Police nommee explicitement : `sans-serif` laisse le moteur choisir parmi les
// 193 familles installees, et il tombe sur une fonte condensee peu lisible.
// Segoe UI est celle de Word sous Windows, Arial le repli universel.
const POLICE = '"Segoe UI", Arial, sans-serif';

/** Formatage court : un axe encombré de « 690158472 » est illisible. */
function abreger(v, format) {
  const n = Number(v) || 0;
  if (format === 'pourcentage') return `${n.toFixed(1)} %`;
  const a = Math.abs(n);

  // Un effectif s'ecrit en entier : « 1 k » pour 1 160 etudiants fait perdre
  // l'information au lecteur d'un rapport. On n'abrege qu'au-dela de 10 000,
  // ou le chiffre exact cesse d'etre lisible sur un axe.
  if (format !== 'montant' && a < 10000) return Math.round(n).toLocaleString('fr-FR');

  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)} Md`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)} M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)} k`;
  return Math.round(n).toLocaleString('fr-FR');
}

/** Un libellé de filière fait parfois 60 caractères : on le tronque proprement. */
function tronquer(ctx, texte, largeurMax) {
  const t = String(texte ?? '');
  if (ctx.measureText(t).width <= largeurMax) return t;
  let court = t;
  while (court.length > 1 && ctx.measureText(`${court}…`).width > largeurMax) {
    court = court.slice(0, -1);
  }
  return `${court}…`;
}

function nouveauContexte(largeur, hauteur) {
  const canvas = createCanvas(largeur * FACTEUR, hauteur * FACTEUR);
  const ctx = canvas.getContext('2d');
  ctx.scale(FACTEUR, FACTEUR);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, largeur, hauteur);
  ctx.textBaseline = 'middle';
  return { canvas, ctx };
}

function titrer(ctx, titre, largeur) {
  if (!titre) return 0;
  ctx.font = `600 13px ${POLICE}`;
  ctx.fillStyle = ENCRE;
  ctx.textAlign = 'left';
  ctx.fillText(tronquer(ctx, titre, largeur - 16), 8, 14);
  return 26;
}

/** Légende horizontale, seulement quand il y a plusieurs séries. */
function legender(ctx, series, largeur, y) {
  if (series.length < 2) return 0;
  ctx.font = `11px ${POLICE}`;
  ctx.textAlign = 'left';
  let x = 8;
  series.forEach((s, i) => {
    const l = ctx.measureText(s.libelle).width;
    if (x + l + 22 > largeur) return;
    ctx.fillStyle = PALETTE[i % PALETTE.length];
    ctx.fillRect(x, y - 4, 9, 9);
    ctx.fillStyle = ENCRE_DOUCE;
    ctx.fillText(s.libelle, x + 14, y + 1);
    x += l + 26;
  });
  return 20;
}

/** Axe des ordonnées et grille horizontale, communs aux graphiques cartésiens. */
function tracerAxes(ctx, { x0, y0, largeurTrace, hauteurTrace, max, min, format }) {
  const PAS = 4;
  ctx.font = `10px ${POLICE}`;
  ctx.textAlign = 'right';
  for (let i = 0; i <= PAS; i++) {
    const valeur = min + ((max - min) * i) / PAS;
    const y = y0 + hauteurTrace - (hauteurTrace * i) / PAS;
    ctx.strokeStyle = GRILLE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y + 0.5);
    ctx.lineTo(x0 + largeurTrace, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = ENCRE_DOUCE;
    ctx.fillText(abreger(valeur, format), x0 - 6, y);
  }
}

// ---------------------------------------------------------------------------
//  Barres horizontales — le format d'un classement
//
//  Choisi par défaut pour les palmarès : les libellés métier (filières, agents)
//  sont longs, et à la verticale ils se chevauchent ou s'inclinent à 45°, ce qui
//  est illisible sur un document imprimé.
// ---------------------------------------------------------------------------
function barresHorizontales(ctx, { lignes, axeX, serie, format, largeur, hauteur, hautDepart }) {
  const valeurs = lignes.map((l) => Number(l[serie.colonne]) || 0);
  const max = Math.max(...valeurs, 1);
  const largeurLibelle = Math.min(largeur * 0.38, 190);
  const x0 = largeurLibelle + 10;
  const largeurTrace = largeur - x0 - 58;
  const hauteurDispo = hauteur - hautDepart - 12;
  const pas = hauteurDispo / lignes.length;
  const epaisseur = Math.max(Math.min(pas - 6, 22), 6);

  lignes.forEach((ligne, i) => {
    const y = hautDepart + i * pas + (pas - epaisseur) / 2;
    const valeur = Number(ligne[serie.colonne]) || 0;
    const l = Math.max((valeur / max) * largeurTrace, valeur > 0 ? 2 : 0);

    ctx.font = `10.5px ${POLICE}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = ENCRE;
    ctx.fillText(tronquer(ctx, ligne[axeX], largeurLibelle), largeurLibelle, y + epaisseur / 2);

    ctx.fillStyle = PALETTE[0];
    ctx.beginPath();
    ctx.roundRect(x0, y, l, epaisseur, [0, 3, 3, 0]);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = ENCRE_DOUCE;
    ctx.font = `10px ${POLICE}`;
    ctx.fillText(abreger(valeur, format), x0 + l + 6, y + epaisseur / 2);
  });
}

// ---------------------------------------------------------------------------
//  Barres verticales, éventuellement groupées ou empilées
// ---------------------------------------------------------------------------
function barresVerticales(ctx, { lignes, axeX, series, format, largeur, hauteur, hautDepart, empilees }) {
  const totaux = lignes.map((l) => (empilees
    ? series.reduce((s, se) => s + (Number(l[se.colonne]) || 0), 0)
    : Math.max(...series.map((se) => Number(l[se.colonne]) || 0))));
  const max = Math.max(...totaux, 1);

  const x0 = 54;
  const basAxe = hauteur - 34;
  const largeurTrace = largeur - x0 - 12;
  const hauteurTrace = basAxe - hautDepart;

  tracerAxes(ctx, { x0, y0: hautDepart, largeurTrace, hauteurTrace, max, min: 0, format });

  const pas = largeurTrace / lignes.length;
  const largeurGroupe = Math.min(pas * 0.68, 46);
  const largeurBarre = empilees ? largeurGroupe : largeurGroupe / series.length;

  lignes.forEach((ligne, i) => {
    const centre = x0 + pas * i + pas / 2;
    let cumul = 0;

    series.forEach((s, j) => {
      const valeur = Number(ligne[s.colonne]) || 0;
      const h = (valeur / max) * hauteurTrace;
      const x = empilees
        ? centre - largeurGroupe / 2
        : centre - largeurGroupe / 2 + j * largeurBarre;
      const y = empilees ? basAxe - cumul - h : basAxe - h;
      ctx.fillStyle = PALETTE[j % PALETTE.length];
      ctx.beginPath();
      ctx.roundRect(x, y, Math.max(largeurBarre - 2, 2), Math.max(h, valeur > 0 ? 2 : 0), [3, 3, 0, 0]);
      ctx.fill();
      if (empilees) cumul += h;
    });

    ctx.font = `10px ${POLICE}`;
    ctx.fillStyle = ENCRE_DOUCE;
    ctx.textAlign = 'center';
    ctx.fillText(tronquer(ctx, ligne[axeX], pas - 4), centre, basAxe + 14);
  });
}

// ---------------------------------------------------------------------------
//  Courbes et aires — une évolution dans le temps
// ---------------------------------------------------------------------------
function courbes(ctx, { lignes, axeX, series, format, largeur, hauteur, hautDepart, aire }) {
  const toutes = series.flatMap((s) => lignes.map((l) => Number(l[s.colonne]) || 0));
  const max = Math.max(...toutes, 1);
  const min = Math.min(...toutes, 0);

  const x0 = 54;
  const basAxe = hauteur - 34;
  const largeurTrace = largeur - x0 - 12;
  const hauteurTrace = basAxe - hautDepart;

  tracerAxes(ctx, { x0, y0: hautDepart, largeurTrace, hauteurTrace, max, min, format });

  const pointX = (i) => x0 + (lignes.length === 1 ? largeurTrace / 2 : (largeurTrace * i) / (lignes.length - 1));
  const pointY = (v) => basAxe - ((v - min) / (max - min || 1)) * hauteurTrace;

  series.forEach((s, j) => {
    const couleur = PALETTE[j % PALETTE.length];
    const points = lignes.map((l, i) => [pointX(i), pointY(Number(l[s.colonne]) || 0)]);

    if (aire) {
      ctx.beginPath();
      ctx.moveTo(points[0][0], basAxe);
      points.forEach(([x, y]) => ctx.lineTo(x, y));
      ctx.lineTo(points[points.length - 1][0], basAxe);
      ctx.closePath();
      ctx.fillStyle = `${couleur}26`;   // 15 % d'opacité
      ctx.fill();
    }

    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = couleur;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Les points ne sont marqués que sur des séries courtes : au-delà, ils
    // forment une ligne pointillée qui masque la courbe.
    if (lignes.length <= 24) {
      points.forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = couleur;
        ctx.lineWidth = 1.8;
        ctx.stroke();
      });
    }
  });

  ctx.font = `10px ${POLICE}`;
  ctx.fillStyle = ENCRE_DOUCE;
  ctx.textAlign = 'center';
  const saut = Math.ceil(lignes.length / Math.max(Math.floor(largeurTrace / 60), 1));
  lignes.forEach((l, i) => {
    if (i % saut) return;
    ctx.fillText(tronquer(ctx, l[axeX], 70), pointX(i), basAxe + 14);
  });
}

// ---------------------------------------------------------------------------
//  Camembert — une répartition
// ---------------------------------------------------------------------------
function camembert(ctx, { lignes, axeX, serie, largeur, hauteur, hautDepart }) {
  const valeurs = lignes.map((l) => Math.max(Number(l[serie.colonne]) || 0, 0));
  const total = valeurs.reduce((a, b) => a + b, 0) || 1;

  const rayon = Math.min((hauteur - hautDepart - 16) / 2, largeur / 4.2);
  const cx = rayon + 24;
  const cy = hautDepart + rayon + 4;

  let angle = -Math.PI / 2;
  valeurs.forEach((v, i) => {
    const part = (v / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, rayon, angle, angle + part);
    ctx.closePath();
    ctx.fillStyle = PALETTE[i % PALETTE.length];
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    angle += part;
  });

  // Légende à droite plutôt que des étiquettes sur les parts : sur huit
  // catégories, les étiquettes se chevauchent systématiquement.
  const xl = cx + rayon + 26;
  const pas = Math.min((hauteur - hautDepart - 8) / lignes.length, 19);
  ctx.textAlign = 'left';
  lignes.forEach((l, i) => {
    const y = hautDepart + 8 + i * pas;
    ctx.fillStyle = PALETTE[i % PALETTE.length];
    ctx.fillRect(xl, y - 4, 9, 9);
    ctx.font = `10.5px ${POLICE}`;
    ctx.fillStyle = ENCRE;
    const pct = ((valeurs[i] / total) * 100).toFixed(1);
    ctx.fillText(tronquer(ctx, `${l[axeX]} — ${pct} %`, largeur - xl - 22), xl + 14, y + 1);
  });
}

/**
 * Produit le PNG d'un graphique.
 *
 * @param {object} p
 * @param {'barres'|'barres_horizontales'|'barres_empilees'|'lignes'|'aire'|'camembert'} p.type
 * @param {Array}  p.lignes    lignes SQL, telles quelles
 * @param {string} p.axeX      colonne portant les catégories
 * @param {Array}  p.series    [{ colonne, libelle }]
 * @returns {{buffer: Buffer, largeur: number, hauteur: number}|null}
 */
function rendre({ type, titre, lignes, axeX, series, format = 'nombre', largeur = 560, hauteur = 300 }) {
  if (!Array.isArray(lignes) || !lignes.length || !series?.length) return null;

  // Un graphique de 200 barres n'est pas un graphique : on garde les premières,
  // le tableau qui l'accompagne porte le détail complet.
  const MAX = type === 'camembert' ? 8 : type === 'barres_horizontales' ? 15 : 30;
  const donnees = lignes.slice(0, MAX);
  const h = type === 'barres_horizontales'
    ? Math.max(hauteur, 42 + donnees.length * 24)
    : hauteur;

  const { canvas, ctx } = nouveauContexte(largeur, h);
  let haut = titrer(ctx, titre, largeur);
  haut += legender(ctx, series, largeur, haut + 6);
  haut += 10;

  const commun = { lignes: donnees, axeX, series, format, largeur, hauteur: h, hautDepart: haut };

  switch (type) {
    case 'barres_horizontales':
      barresHorizontales(ctx, { ...commun, serie: series[0] });
      break;
    case 'camembert':
      camembert(ctx, { ...commun, serie: series[0] });
      break;
    case 'lignes':
      courbes(ctx, { ...commun, aire: false });
      break;
    case 'aire':
      courbes(ctx, { ...commun, aire: true });
      break;
    case 'barres_empilees':
      barresVerticales(ctx, { ...commun, empilees: true });
      break;
    default:
      barresVerticales(ctx, { ...commun, empilees: false });
  }

  return { buffer: canvas.toBuffer('image/png'), largeur, hauteur: h };
}

module.exports = { rendre, PALETTE, TYPES: [
  'barres', 'barres_horizontales', 'barres_empilees', 'lignes', 'aire', 'camembert',
] };

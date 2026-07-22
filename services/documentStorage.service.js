const fs = require('fs');
const path = require('path');

// Abstraction de stockage des pièces justificatives.
// - Si les credentials Google Drive sont configurées (GOOGLE_DRIVE_CREDENTIALS_PATH +
//   GOOGLE_DRIVE_ROOT_FOLDER_ID) et qu'une hiérarchie est fournie, le fichier est archivé
//   sur Drive dans École/Département/Filière/Niveau/NOM PRENOM - MATRICULE_IIPEA.
// - Sinon (actuellement le cas par défaut — un compte de service Google ne peut pas écrire
//   dans un Drive personnel classique sans quota propre, cf. Drive partagé/OAuth à trancher
//   plus tard), repli sur le disque local avec LA MÊME arborescence
//   uploads/documents/École/Département/Filière/Niveau/NOM PRENOM - MATRICULE_IIPEA/,
//   pour qu'une future bascule vers Drive n'ait qu'à synchroniser l'arbre déjà organisé.
// Le champ `provider` retourné (`drive` ou `local`) est stocké sur document_etudiant pour
// savoir, fichier par fichier, où il se trouve réellement.

const CREDENTIALS_PATH = process.env.GOOGLE_DRIVE_CREDENTIALS_PATH
  ? path.join(__dirname, '..', process.env.GOOGLE_DRIVE_CREDENTIALS_PATH)
  : null;
const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || null;

// Interrupteur explicite, distinct de la simple présence des credentials : le compte de
// service actuel est bloqué par Google (pas de quota propre sur un Drive personnel classique,
// cf. "Service Accounts do not have storage quota"). Ne pas basculer sur Drive tant que ce
// n'est pas résolu (Drive partagé Workspace, ou délégation OAuth) même si les credentials
// sont déjà en place — mettre GOOGLE_DRIVE_ENABLED=true dans .env une fois la solution choisie.
const isDriveConfigured = () =>
  !!(process.env.GOOGLE_DRIVE_ENABLED === 'true' && CREDENTIALS_PATH && ROOT_FOLDER_ID && fs.existsSync(CREDENTIALS_PATH));

let driveClientPromise = null;
const getDriveClient = () => {
  if (!driveClientPromise) {
    driveClientPromise = (async () => {
      const { google } = require('googleapis');
      const auth = new google.auth.GoogleAuth({
        keyFile: CREDENTIALS_PATH,
        scopes: ['https://www.googleapis.com/auth/drive'],
      });
      return google.drive({ version: 'v3', auth });
    })();
  }
  return driveClientPromise;
};

// Cache mémoire des dossiers déjà résolus (clé = parentId + nom) pour éviter un aller-retour
// Drive à chaque téléversement — un même dossier étudiant reçoit plusieurs pièces d'affilée.
const folderIdCache = new Map();

const sanitizeFolderName = (name) => String(name).trim().replace(/[\\/]/g, '-');

// Plus strict que sanitizeFolderName : retire aussi les caractères invalides sur un nom de
// fichier/dossier Windows (< > : " / \ | ? *).
const sanitizePathSegment = (name) => String(name).trim().replace(/[<>:"/\\|?*]/g, '-');

const UPLOADS_DOCUMENTS_DIR = path.join(__dirname, '..', 'uploads', 'documents');

const buildLocalHierarchyDir = (hierarchy) => {
  const segments = [
    hierarchy.ecole,
    hierarchy.departement,
    hierarchy.filiere,
    hierarchy.niveau,
    hierarchy.nomDossierEtudiant,
  ].filter(Boolean).map(sanitizePathSegment);
  return path.join(UPLOADS_DOCUMENTS_DIR, ...segments);
};

const findOrCreateFolder = async (drive, name, parentId) => {
  const safeName = sanitizeFolderName(name);
  const cacheKey = `${parentId}::${safeName}`;
  if (folderIdCache.has(cacheKey)) return folderIdCache.get(cacheKey);

  const escaped = safeName.replace(/'/g, "\\'");
  const existing = await drive.files.list({
    q: `name='${escaped}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  let folderId;
  if (existing.data.files.length > 0) {
    folderId = existing.data.files[0].id;
  } else {
    const created = await drive.files.create({
      resource: { name: safeName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
      fields: 'id',
    });
    folderId = created.data.id;
  }

  folderIdCache.set(cacheKey, folderId);
  return folderId;
};

// Construit (ou retrouve) École/Département/Filière/Niveau/NOM PRENOM - MATRICULE_IIPEA
const ensureFolderPath = async (drive, hierarchy) => {
  const segments = [
    hierarchy.ecole,
    hierarchy.departement,
    hierarchy.filiere,
    hierarchy.niveau,
    hierarchy.nomDossierEtudiant,
  ].filter(Boolean);

  let parentId = ROOT_FOLDER_ID;
  for (const segment of segments) {
    parentId = await findOrCreateFolder(drive, segment, parentId);
  }
  return parentId;
};

// hierarchy attendu : { ecole, departement, filiere, niveau, nomDossierEtudiant, typeDocumentCode }
exports.saveDocument = async ({ file, hierarchy }) => {
  if (!file) throw new Error('Aucun fichier fourni.');

  if (!hierarchy || !isDriveConfigured()) {
    if (!hierarchy) {
      // Pas de hiérarchie fournie (ex. photo d'identité) : comportement historique, fichier à plat.
      return { url: `/uploads/documents/${file.filename}`, provider: 'local' };
    }

    const dir = buildLocalHierarchyDir(hierarchy);
    fs.mkdirSync(dir, { recursive: true });

    const ext = path.extname(file.originalname || file.filename) || '';
    const baseName = hierarchy.typeDocumentCode
      ? sanitizePathSegment(hierarchy.typeDocumentCode)
      : path.basename(file.filename, path.extname(file.filename));
    const filename = `${baseName}_${Date.now()}${ext}`;
    const destPath = path.join(dir, filename);

    fs.renameSync(file.path, destPath);

    const relativeUrl = path.relative(UPLOADS_DOCUMENTS_DIR, destPath).split(path.sep).join('/');
    return { url: `/uploads/documents/${relativeUrl}`, provider: 'local' };
  }

  const drive = await getDriveClient();
  const folderId = await ensureFolderPath(drive, hierarchy);

  const uploaded = await drive.files.create({
    resource: { name: file.originalname, parents: [folderId] },
    media: { mimeType: file.mimetype, body: fs.createReadStream(file.path) },
    fields: 'id, webViewLink',
  });

  // Le fichier local écrit par multer n'est qu'un passage intermédiaire une fois sur Drive.
  await fs.promises.unlink(file.path).catch(() => {});

  return {
    url: uploaded.data.webViewLink,
    provider: 'drive',
    driveFileId: uploaded.data.id,
    driveFolderId: folderId,
  };
};

// Utilisé lors du remplacement d'un document (archiviste qui re-téléverse une pièce) :
// supprime l'ancien fichier (local ou Drive) s'il existait, no-op silencieux si non trouvé.
exports.deleteDocument = async ({ fichierPath, provider, driveFileId }) => {
  if (provider === 'drive' && driveFileId) {
    try {
      const drive = await getDriveClient();
      await drive.files.delete({ fileId: driveFileId });
    } catch (err) {
      console.warn('Suppression Drive impossible (fichier déjà absent ?):', err.message);
    }
    return;
  }
  if (!fichierPath || !fichierPath.startsWith('/uploads/documents/')) return;
  const filePath = path.join(__dirname, '..', fichierPath);
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Suppression fichier local impossible:', err.message);
  }
};

// Conservé pour compatibilité : ancien nom, ne gère que le disque local.
exports.deleteLocalDocument = (fichierPath) => exports.deleteDocument({ fichierPath, provider: 'local' });

exports.isDriveConfigured = isDriveConfigured;

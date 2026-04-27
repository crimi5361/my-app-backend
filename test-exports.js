// test-exports.js
const notesController = require('./controllers/chargementNote');

console.log('🔍 DEBUG - Contenu de notesController:');
console.log('=====================================');
console.log('Type de notesController:', typeof notesController);
console.log('Keys disponibles:', Object.keys(notesController));

console.log('\n📋 Liste détaillée des exports:');
console.log('==============================');
Object.keys(notesController).forEach(key => {
  const value = notesController[key];
  console.log(`\n► ${key}:`);
  console.log(`  Type: ${typeof value}`);
  
  if (typeof value === 'function') {
    console.log(`  Nombre d'arguments: ${value.length}`);
  } else if (value && typeof value === 'object') {
    console.log(`  Type d'objet: ${Array.isArray(value) ? 'Array' : 'Object'}`);
    if (Object.keys(value).length <= 5) {
      console.log(`  Sous-keys: ${Object.keys(value).join(', ')}`);
    }
  }
});

console.log('\n🔎 Recherche spécifique:');
console.log('======================');
const importantFunctions = [
  'handleUpload',
  'uploadMiddleware', 
  'upload',
  'uploadNotes',
  'testAPI',
  'downloadTemplate',
  'getNotesByGroupe',
  'getUploadStatus',
  'getGroupeDetails'
];

importantFunctions.forEach(funcName => {
  if (funcName in notesController) {
    console.log(`✅ ${funcName}: ${typeof notesController[funcName]} (existe)`);
  } else {
    console.log(`❌ ${funcName}: non trouvé`);
  }
});

// Chercher toutes les fonctions
console.log('\n🎯 Toutes les fonctions disponibles:');
console.log('==================================');
Object.keys(notesController).forEach(key => {
  if (typeof notesController[key] === 'function') {
    console.log(`  - ${key}`);
  }
});

// Si c'est un objet, chercher à l'intérieur
console.log('\n🔍 Examen en profondeur (si objet):');
console.log('==================================');
if (notesController && typeof notesController === 'object' && !Array.isArray(notesController)) {
  // Regarder les premières couches
  Object.keys(notesController).forEach(key => {
    const val = notesController[key];
    if (val && typeof val === 'object' && 'handleUpload' in val) {
      console.log(`⚠️ handleUpload trouvé dans ${key}:`, typeof val.handleUpload);
    }
  });
}
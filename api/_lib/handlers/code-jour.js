// api/code-jour.js
//
// Réservé au président : renvoie le code d'accès du jour (celui à donner à un
// trésorier pour qu'il puisse faire créer un compte à un nouveau membre).
//
// Variables d'environnement nécessaires (déjà présentes sur ce projet, sauf la dernière) :
//   FIREBASE_SERVICE_ACCOUNT_JSON
//   CODE_ACCES_SECRET   → NOUVELLE variable à créer sur Vercel : une longue chaîne
//                          aléatoire (ex: openssl rand -hex 32), à ne JAMAIS mettre
//                          ailleurs que dans les variables d'environnement Vercel.

const admin = require('firebase-admin');
const { codesValides } = require('../_lib/code-acces');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Méthode non autorisée' });
  }

  // ─── Authentifier l'appelant et vérifier que c'est bien le président ───
  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    return res.status(401).json({ ok: false, error: 'Token manquant' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const userDoc = await db.collection('utilisateurs').doc(decoded.uid).get();
    const role = userDoc.exists ? userDoc.data().role : null;
    if (role !== 'president') {
      return res.status(403).json({ ok: false, error: 'Réservé au président' });
    }

    const codes = codesValides(process.env.CODE_ACCES_SECRET);
    return res.status(200).json({
      ok: true,
      codeAujourdhui: codes[0],
      codeHierEncoreValide: codes.length > 1 ? codes[1] : null,
    });
  } catch (e) {
    console.error('Erreur code-jour :', e);
    return res.status(401).json({ ok: false, error: 'Token invalide' });
  }
};

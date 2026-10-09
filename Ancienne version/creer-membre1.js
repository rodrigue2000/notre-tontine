const admin = require('firebase-admin');
const { verifierCode } = require('./_lib/code-acces');

function initFirebaseAdmin() {
  if (admin.apps.length) return;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const ALLOWED_ORIGIN = process.env.APP_URL || '*';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    initFirebaseAdmin();
    const db = admin.firestore();

    // 1. Vérifie que c'est bien un utilisateur Firebase authentifié (n'importe
    //    quel membre peut appeler ceci pour SON propre compte, seulement).
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Authentification requise' });

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Session invalide, reconnecte-toi' });
    }

    const email = decoded.email;
    if (!email) return res.status(400).json({ error: 'Email manquant sur le compte Google' });
    const nom = decoded.name || req.body?.nom || email;

    // 2. Le profil utilisateur (collection "utilisateurs") n'est plus créé côté
    //    client — c'est ce endpoint qui en a désormais la responsabilité exclusive
    //    (les règles Firestore interdisent maintenant toute création directe).
    const userRef = db.collection('utilisateurs').doc(decoded.uid);
    const userDoc = await userRef.get();
    const estNouveauMembre = !userDoc.exists;

    if (estNouveauMembre) {
      // ─── Première inscription : le code d'accès du jour est obligatoire ───
      const codeAcces = req.body?.codeAcces;
      if (!verifierCode(codeAcces, process.env.CODE_ACCES_SECRET)) {
        return res.status(403).json({ error: 'Code d\'accès invalide ou expiré. Demande le code du jour au président.' });
      }

      await userRef.set({
        nom,
        email,
        role: 'membre',
        dateCreation: new Date().toISOString(),
        actif: true,
        uid: decoded.uid,
      });
    }

    // 3. Initialise l'entrée du membre dans tontine/membres SEULEMENT si elle
    //    n'existe pas déjà (idempotent — sûr d'appeler à chaque connexion,
    //    ne réinitialise jamais un solde existant).
    const membresRef = db.collection('tontine').doc('membres');
    const dejaCree = await db.runTransaction(async (t) => {
      const snap = await t.get(membresRef);
      const existe = snap.exists && snap.data()[email];
      if (existe) return true;

      t.set(membresRef, {
        [email]: {
          nom,
          role: 'membre',
          dateAdhesion: new Date().toISOString(),
          solde: 0,
          actif: true,
          uid: decoded.uid,
        }
      }, { merge: true });
      return false;
    });

    return res.status(200).json({ success: true, nouveauMembre: estNouveauMembre, dejaExistant: dejaCree });
  } catch (err) {
    console.error('Erreur création membre:', err);
    return res.status(400).json({ error: err.message || 'Erreur lors de la création du membre' });
  }
};

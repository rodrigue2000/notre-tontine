const admin = require('firebase-admin');

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

    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'Authentification requise' });

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Session invalide, reconnecte-toi' });
    }

    // Seul le président peut définir des plafonds.
    const callerDoc = await db.collection('utilisateurs').doc(decoded.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'president') {
      return res.status(403).json({ error: 'Accès réservé au président' });
    }

    const { tresorierEmail, plafond, resetCumul } = req.body || {};
    if (!tresorierEmail) return res.status(400).json({ error: 'tresorierEmail requis' });
    if (plafond !== null && plafond !== undefined && Number(plafond) < 0) {
      return res.status(400).json({ error: 'Plafond invalide' });
    }

    const usersSnap = await db.collection('utilisateurs').where('email', '==', tresorierEmail).limit(1).get();
    if (usersSnap.empty) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const tresorierDoc = usersSnap.docs[0];
    const tresorierData = tresorierDoc.data();
    if (tresorierData.role !== 'tresorier') {
      return res.status(400).json({ error: 'Cet utilisateur n\'a pas le rôle trésorier' });
    }

    const plafondRef = db.collection('plafonds').doc(tresorierDoc.id);
    const existing = await plafondRef.get();

    const donnees = {
      tresorierEmail,
      tresorierNom: tresorierData.nom || tresorierEmail,
      definePar: decoded.uid,
      definePar_email: decoded.email,
      dateMaj: new Date().toISOString(),
    };

    if (plafond !== undefined) {
      donnees.plafond = plafond === null ? null : Number(plafond);
    }
    if (resetCumul || !existing.exists) {
      donnees.cumul = 0;
    }

    await plafondRef.set(donnees, { merge: true });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur définition plafond:', err);
    return res.status(400).json({ error: err.message || 'Erreur lors de la mise à jour du plafond' });
  }
};

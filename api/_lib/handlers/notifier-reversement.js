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

    // Seul le président peut notifier un reversement.
    const callerDoc = await db.collection('utilisateurs').doc(decoded.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'president') {
      return res.status(403).json({ error: 'Accès réservé au président' });
    }

    const { tresorierEmail, montantReverse, note } = req.body || {};
    if (!tresorierEmail) return res.status(400).json({ error: 'tresorierEmail requis' });

    const usersSnap = await db.collection('utilisateurs').where('email', '==', tresorierEmail).limit(1).get();
    if (usersSnap.empty) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const tresorierUid = usersSnap.docs[0].id;

    const plafondRef = db.collection('plafonds').doc(tresorierUid);
    const plafondSnap = await plafondRef.get();
    if (!plafondSnap.exists) {
      return res.status(404).json({ error: 'Aucun plafond défini pour ce trésorier' });
    }
    const { plafond = null, cumul = 0 } = plafondSnap.data();

    // Trace d'audit : ce qui a été reversé, quand, par qui, et l'état du compteur avant reset.
    await db.collection('reversements').add({
      tresorierUid,
      tresorierEmail,
      cumulAvantReset: cumul,
      plafond,
      montantReverse: montantReverse !== undefined && montantReverse !== null ? Number(montantReverse) : null,
      note: note || '',
      notifiePar: decoded.uid,
      notifieParEmail: decoded.email,
      date: new Date().toISOString(),
    });

    await plafondRef.update({
      cumul: 0,
      derniereReouverture: new Date().toISOString(),
    });

    return res.status(200).json({ success: true, cumulAvantReset: cumul });
  } catch (err) {
    console.error('Erreur notification reversement:', err);
    return res.status(400).json({ error: err.message || 'Erreur lors de la notification' });
  }
};

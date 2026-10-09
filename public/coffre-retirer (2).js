// api/coffre-retirer.js
//
// Retrait (total ou partiel) d'un coffre d'épargne ciblée. Le comportement dépend de
// la progression actuelle vers l'objectif (montantActuel / objectif) au moment de la
// demande — la stratégie "élastique" :
//   0% – 30%   : retrait immédiat, aucune pénalité (phase de rodage)
//   30% – 70%  : retrait accepté mais différé 48h (phase d'engagement — pas de
//                pénalité financière, juste un temps de réflexion)
//   70% – 99%  : retrait immédiat, avec une pénalité progressive de 0% à 10%
//                (dernière ligne droite — plus on est proche du but, plus ça freine)
//   100%+      : ne devrait jamais arriver ici — le coffre se "casse" automatiquement
//                dans coffre-alimenter.js dès que l'objectif est atteint.
//
// Variables d'environnement nécessaires (déjà présentes sur ce projet) :
//   FIREBASE_SERVICE_ACCOUNT_JSON

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();

function calculerPenalite(ratioAvant) {
  if (ratioAvant < 0.70) return 0;
  const plafond = Math.min(ratioAvant, 0.99);
  const progression = (plafond - 0.70) / (0.99 - 0.70); // 0 à 1
  return Math.round(progression * 10 * 100) / 100; // pourcentage, arrondi à 2 décimales
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Méthode non autorisée' });
  }

  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ ok: false, error: 'Token manquant' });

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Token invalide' });
  }
  const callerEmail = decoded.email;

  const { coffreId, montant } = req.body || {};
  const montantNum = Number(montant);
  if (!coffreId || !montantNum || montantNum <= 0) {
    return res.status(400).json({ ok: false, error: 'coffreId et montant (positif) requis' });
  }

  try {
    const result = await db.runTransaction(async (tx) => {
      const coffreRef = db.collection('coffres').doc(coffreId);
      const membresRef = db.collection('tontine').doc('membres');

      // ─── Toutes les lectures d'abord ───
      const coffreDoc = await tx.get(coffreRef);
      if (!coffreDoc.exists) throw new Error('Coffre introuvable');
      const coffre = coffreDoc.data();

      if (coffre.membreEmail !== callerEmail) throw new Error('Ce coffre ne vous appartient pas');
      if (coffre.statut !== 'actif') throw new Error('Ce coffre n\'est plus actif');
      if (montantNum > (coffre.montantActuel || 0)) {
        throw new Error(`Le coffre ne contient que ${coffre.montantActuel} FCFA`);
      }

      const ratioAvant = (coffre.montantActuel || 0) / coffre.objectif;
      const now = new Date().toISOString();

      // La phase "engagement" (48h) ne touche ni le coffre ni le solde tout de suite,
      // donc pas besoin de lire le solde du membre pour ce cas-là.
      const aBesoinDuSolde = ratioAvant < 0.30 || ratioAvant >= 0.70;
      let membreActuel = null;
      if (aBesoinDuSolde) {
        const membresDoc = await tx.get(membresRef);
        const membresData = membresDoc.exists ? membresDoc.data() : {};
        membreActuel = membresData[callerEmail];
        if (!membreActuel) throw new Error('Membre introuvable');
      }

      // ─── Puis toutes les écritures ───

      // ─── Phase 1 : rodage (0-30%) — retrait immédiat, sans pénalité ───
      if (ratioAvant < 0.30) {
        const nouveauMontantCoffre = coffre.montantActuel - montantNum;
        tx.update(coffreRef, { montantActuel: nouveauMontantCoffre });
        tx.set(membresRef, { [callerEmail]: { ...membreActuel, solde: (membreActuel.solde || 0) + montantNum } }, { merge: true });
        tx.set(db.collection('transactions').doc(), {
          membreEmail: callerEmail, type: 'coffre_retrait', montant: montantNum,
          responsable: callerEmail, notes: `Retrait immédiat du coffre "${coffre.nom}" (phase rodage)`, date: now
        });
        return { statut: 'execute', montantRecu: montantNum, penalite: 0, phase: 'rodage' };
      }

      // ─── Phase 2 : engagement (30-70%) — retrait différé 48h ───
      if (ratioAvant < 0.70) {
        const dateDisponible = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
        const demandeRef = db.collection('demandesRetraitCoffre').doc();
        tx.set(demandeRef, {
          membreEmail: callerEmail, coffreId, montant: montantNum,
          dateCreation: now, dateDisponible, statut: 'en_attente'
        });
        return { statut: 'differe', dateDisponible, phase: 'engagement' };
      }

      // ─── Phase 3 : dernière ligne droite (70-99%) — pénalité progressive ───
      const penalitePct = calculerPenalite(ratioAvant);
      const penaliteMontant = Math.round(montantNum * penalitePct / 100);
      const montantNet = montantNum - penaliteMontant;
      const nouveauMontantCoffre = coffre.montantActuel - montantNum;
      tx.update(coffreRef, { montantActuel: nouveauMontantCoffre });
      tx.set(membresRef, { [callerEmail]: { ...membreActuel, solde: (membreActuel.solde || 0) + montantNet } }, { merge: true });
      tx.set(db.collection('transactions').doc(), {
        membreEmail: callerEmail, type: 'coffre_retrait', montant: montantNet,
        responsable: callerEmail,
        notes: `Retrait du coffre "${coffre.nom}" (phase dernière ligne droite, pénalité ${penalitePct}% = ${penaliteMontant} FCFA)`,
        date: now
      });
      return { statut: 'execute', montantRecu: montantNet, penalite: penalitePct, penaliteMontant, phase: 'derniere_ligne_droite' };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('Erreur retrait coffre :', e);
    return res.status(400).json({ ok: false, error: e.message });
  }
};

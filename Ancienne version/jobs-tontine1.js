// api/cron/jobs-tontine.js
//
// Job quotidien OKR TONTINE : calcule les intérêts composés des verrouillages actifs,
// débloque automatiquement ceux arrivés à échéance, envoie les rappels, exécute les
// retraits de coffre différés (délai 48h écoulé), et confirme par défaut les retraits
// décentralisés non confirmés/contestés par le membre dans les 48h (silence = confirmé).
// Remplace le setInterval() côté navigateur — s'exécute même si personne n'a l'app ouverte.
//
// Déclenché par Vercel Cron (voir vercel.json), protégé par CRON_SECRET.
//
// Variables d'environnement à définir sur Vercel (Project Settings → Environment Variables) :
//   FIREBASE_SERVICE_ACCOUNT_JSON  → tu l'as déjà (utilisée pour FedaPay) — rien à créer, on réutilise
//   CRON_SECRET                    → chaîne aléatoire longue, à créer (ex: openssl rand -hex 32)

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

function fmt(n) {
  return Math.round(n).toLocaleString('fr-FR') + ' FCFA';
}

async function calculerInteretsMensuels() {
  const snap = await db.collection('verrouillages').where('statut', '==', 'actif').get();
  let compteur = 0;
  const batch = db.batch();

  for (const doc of snap.docs) {
    const v = doc.data();
    const dateCreation = new Date(v.dateCreation);
    const now = new Date();
    const moisEcoules = (now.getFullYear() - dateCreation.getFullYear()) * 12 + (now.getMonth() - dateCreation.getMonth());
    const mensuels = v.interetsMensuels || [];
    const dejaCalcules = mensuels.length;
    if (moisEcoules <= dejaCalcules) continue;

    let interetsCumules = v.interetsCumules || 0;
    for (let mois = dejaCalcules + 1; mois <= moisEcoules; mois++) {
      // Intérêt COMPOSÉ : calculé sur (capital + intérêts déjà cumulés), pas juste le capital.
      const baseCalcul = (v.montant || 0) + interetsCumules;
      const interetMensuel = baseCalcul * (v.taux || 0) / 100 / 12;
      interetsCumules += interetMensuel;
      mensuels.push({ date: now.toISOString(), mois, montant: interetMensuel });
    }
    batch.update(doc.ref, { interetsCumules, interetsMensuels: mensuels });
    compteur++;
  }
  if (compteur > 0) await batch.commit();
  return compteur;
}

async function verifierEcheances() {
  const now = new Date();
  const snap = await db.collection('verrouillages').where('statut', '==', 'actif').get();
  let compteur = 0;

  for (const doc of snap.docs) {
    const v = doc.data();
    const dateFin = new Date(v.dateFin);
    if (dateFin > now) continue;

    const montantInitial = v.montant || 0;
    const interets = v.interetsCumules || 0;
    const montantTotal = montantInitial + interets;

    // Transaction Firestore : débloquer le verrouillage ET créditer le solde de façon atomique
    await db.runTransaction(async (tx) => {
      const membresRef = db.collection('tontine').doc('membres');
      const membresDoc = await tx.get(membresRef);
      const membresData = membresDoc.exists ? membresDoc.data() : {};
      const membre = membresData[v.membreEmail];
      if (!membre) return; // membre introuvable, on laisse le verrouillage tel quel pour investigation manuelle

      const nouveauSolde = (membre.solde || 0) + montantTotal;
      tx.update(doc.ref, { statut: 'termine', dateFinReelle: now.toISOString() });
      tx.set(membresRef, { [v.membreEmail]: { ...membre, solde: nouveauSolde } }, { merge: true });
      tx.set(db.collection('transactions').doc(), {
        membreEmail: v.membreEmail,
        type: 'deblocage',
        montant: montantTotal,
        responsable: 'Système (cron)',
        notes: 'Déblocage automatique du verrouillage (capital + intérêts)',
        date: now.toISOString(),
      });
      tx.set(db.collection('notifications').doc(), {
        destinataire: v.membreEmail,
        type: 'echeance_atteinte',
        titre: '✅ Verrouillage débloqué',
        message: `Votre verrouillage de ${fmt(montantInitial)} est arrivé à échéance. ${fmt(montantTotal)} a été reversé sur votre solde.`,
        lu: false,
        date: now.toISOString(),
      });
    });
    compteur++;
  }
  return compteur;
}

async function traiterDemandesRetraitCoffre() {
  const now = new Date();
  const snap = await db.collection('demandesRetraitCoffre').where('statut', '==', 'en_attente').get();
  let compteur = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    if (new Date(d.dateDisponible) > now) continue; // délai de 48h pas encore écoulé

    await db.runTransaction(async (tx) => {
      const coffreRef = db.collection('coffres').doc(d.coffreId);
      const coffreDoc = await tx.get(coffreRef);
      if (!coffreDoc.exists) {
        tx.update(doc.ref, { statut: 'annule', motif: 'Coffre introuvable' });
        return;
      }
      const coffre = coffreDoc.data();
      if (coffre.statut !== 'actif' || (coffre.montantActuel || 0) < d.montant) {
        // Le coffre a changé entretemps (objectif atteint, ou fonds insuffisants
        // suite à un autre retrait) — on annule proprement plutôt que de planter.
        tx.update(doc.ref, { statut: 'annule', motif: 'Fonds insuffisants ou coffre non actif au moment du traitement' });
        return;
      }

      const membresRef = db.collection('tontine').doc('membres');
      const membresDoc = await tx.get(membresRef);
      const membresData = membresDoc.exists ? membresDoc.data() : {};
      const membre = membresData[d.membreEmail];
      if (!membre) {
        tx.update(doc.ref, { statut: 'annule', motif: 'Membre introuvable' });
        return;
      }

      tx.update(coffreRef, { montantActuel: coffre.montantActuel - d.montant });
      tx.set(membresRef, { [d.membreEmail]: { ...membre, solde: (membre.solde || 0) + d.montant } }, { merge: true });
      tx.update(doc.ref, { statut: 'execute', dateExecution: now.toISOString() });
      tx.set(db.collection('transactions').doc(), {
        membreEmail: d.membreEmail, type: 'coffre_retrait', montant: d.montant,
        responsable: 'Système (cron, délai 48h écoulé)',
        notes: `Retrait différé du coffre "${coffre.nom}" (phase engagement)`, date: now.toISOString()
      });
      tx.set(db.collection('notifications').doc(), {
        destinataire: d.membreEmail, type: 'coffre_retrait_execute',
        titre: '✅ Retrait de coffre disponible',
        message: `Ton retrait de ${d.montant} FCFA du coffre "${coffre.nom}" (délai de 48h écoulé) a été crédité sur ton solde.`,
        lu: false, date: now.toISOString()
      });
    });
    compteur++;
  }
  return compteur;
}

async function rappelEcheances() {
  // Rappel J-7 avant échéance, une seule fois (basé sur un flag rappelEnvoye)
  const now = new Date();
  const dansSeptJours = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const snap = await db.collection('verrouillages').where('statut', '==', 'actif').get();
  let compteur = 0;

  for (const doc of snap.docs) {
    const v = doc.data();
    if (v.rappelEnvoye) continue;
    const dateFin = new Date(v.dateFin);
    if (dateFin > now && dateFin <= dansSeptJours) {
      await doc.ref.update({ rappelEnvoye: true });
      await db.collection('notifications').add({
        destinataire: v.membreEmail,
        type: 'rappel_echeance',
        titre: '⏰ Échéance dans 7 jours',
        message: `Votre verrouillage de ${fmt(v.montant)} arrive à échéance le ${dateFin.toLocaleDateString('fr-FR')}.`,
        lu: false,
        date: now.toISOString(),
      });
      compteur++;
    }
  }
  return compteur;
}

// Retraits décentralisés : si le membre ne confirme ni ne conteste la réception dans les
// 48h suivant le traitement par un admin, le silence vaut confirmation par défaut — la
// demande ne doit jamais rester bloquée en "en_attente de confirmation" indéfiniment.
async function confirmerRetraitsParDefaut() {
  const now = new Date();
  const snap = await db.collection('demandesRetrait')
    .where('statut', '==', 'traite')
    .where('confirmationStatut', '==', 'en_attente')
    .get();
  let compteur = 0;
  const batch = db.batch();

  for (const doc of snap.docs) {
    const d = doc.data();
    if (!d.dateLimiteConfirmation || new Date(d.dateLimiteConfirmation) > now) continue;
    batch.update(doc.ref, { confirmationStatut: 'confirme_defaut', dateConfirmation: now.toISOString() });
    compteur++;
  }
  if (compteur > 0) await batch.commit();
  return compteur;
}

module.exports = async (req, res) => {
  // Protection : seul Vercel Cron (avec le bon secret) peut déclencher ce endpoint
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const interets = await calculerInteretsMensuels();
    const echeances = await verifierEcheances();
    const rappels = await rappelEcheances();
    const retraitsCoffres = await traiterDemandesRetraitCoffre();
    const retraitsConfirmesParDefaut = await confirmerRetraitsParDefaut();
    return res.status(200).json({
      ok: true,
      date: new Date().toISOString(),
      interetsCalcules: interets,
      echeancesDebloquees: echeances,
      rappelsEnvoyes: rappels,
      retraitsCoffresExecutes: retraitsCoffres,
      retraitsConfirmesParDefaut,
    });
  } catch (e) {
    console.error('Erreur job tontine :', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

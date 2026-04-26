// Smoke test: verify Firestore Admin SDK + ADC works
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { env } from './env.ts';

initializeApp({
  credential: applicationDefault(),
  projectId: env.firebaseProjectId,
});

const db = getFirestore();
const snap = await db.collection('wardPatients').limit(3).get();
console.log(`Read ${snap.size} document(s) from wardPatients`);
for (const doc of snap.docs) {
  const d = doc.data();
  console.log(`  - ${doc.id}: ${d.patientName} (${d.ward} ${d.room})`);
}
console.log('OK: Firestore + ADC works');
